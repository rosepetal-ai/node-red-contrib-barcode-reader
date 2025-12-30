module.exports = function(RED) {
    function BarcodeReaderNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const barcode = require('./index.js');
        let Quagga = null;

        // Try to load Quagga2 if available
        try {
            Quagga = require('@ericblade/quagga2');
        } catch (err) {
            node.warn('Quagga2 not available. Install @ericblade/quagga2 to use Quagga decoder.');
        }

        node.on('input', async (msg, send, done) => {
            try {
                // Initialize performance tracking
                msg.performance = msg.performance || {};
                msg.performance[node.name || "barcode-reader"] = { startTime: new Date() };

                const inputValue = config.inputValue || "payload";
                const outputValue = config.outputValue || "payload";
                let input = RED.util.getMessageProperty(msg, inputValue);

                if (!input) {
                    throw new Error(`Input path "${inputValue}" not found in msg.`);
                }

                // Handle array input
                const isArrayInput = Array.isArray(input);
                const inputArray = isArrayInput ? input : [input];
                const results = [];

                // Process each image
                for (const singleInput of inputArray) {
                    const imageResults = await processSingleImage(singleInput, config, node);
                    results.push(imageResults);
                }

                // Set output based on input type
                if (isArrayInput) {
                    // Array input → nested results [[img1_results], [img2_results]]
                    RED.util.setMessageProperty(msg, outputValue, results);
                } else {
                    // Single input → flat results [results]
                    RED.util.setMessageProperty(msg, outputValue, results[0]);
                }

                // Compute elapsed time
                const performanceKey = node.name || "barcode-reader";
                const elapsed = new Date().getTime() - msg.performance[performanceKey].startTime.getTime();
                msg.performance[performanceKey].milliseconds = elapsed;

                // Show ms under the node in the Editor
                node.status({
                    shape: "dot",
                    text: `${elapsed} ms`
                });

                send(msg);
                if (done) done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "Error" });

                if (done) {
                    done(err);
                } else {
                    node.error(err, msg);
                }
            }
        });

        /**
         * Process a single image through all blocks
         */
        async function processSingleImage(input, config, node) {
            // Get image dimensions for relative coordinate conversion
            const imageDimensions = getImageDimensions(input);

            // Get blocks configuration
            const blocks = config.blocks || [];
            const executionMode = config.executionMode || 'parallel';

            if (blocks.length === 0) {
                node.warn('No decoder blocks configured');
                return [];
            }

            let allResults = [];

            if (executionMode === 'sequential') {
                // Sequential: process blocks in order, stop at first success
                allResults = await processSequential(input, blocks, node, Quagga);
            } else {
                // Parallel: process all blocks and merge results
                allResults = await processParallel(input, blocks, node, Quagga);
            }

            // Deduplicate results
            const dedupResults = deduplicateResults(allResults);

            // Convert to relative coordinates and final format
            const finalResults = dedupResults.map(result =>
                convertToFinalFormat(result, imageDimensions)
            );

            return finalResults;
        }

        /**
         * Process blocks sequentially (early exit on first success)
         */
        async function processSequential(input, blocks, node, Quagga) {
            for (let i = 0; i < blocks.length; i++) {
                const block = blocks[i];

                try {
                    const results = await processBlock(input, block, i, node, Quagga);

                    if (results.length > 0) {
                        // Found results, early exit
                        return results;
                    }
                } catch (err) {
                    node.warn(`Block ${i} (${block.decoder}) failed: ${err.message}`);
                }
            }

            return [];
        }

        /**
         * Process blocks in parallel (merge all results)
         */
        async function processParallel(input, blocks, node, Quagga) {
            const promises = blocks.map((block, index) => {
                return processBlock(input, block, index, node, Quagga).catch(err => {
                    node.warn(`Block ${index} (${block.decoder}) failed: ${err.message}`);
                    return [];
                });
            });

            const resultsArrays = await Promise.all(promises);
            return resultsArrays.flat();
        }

        /**
         * Process a single block (preprocessing + decoding)
         */
        async function processBlock(input, block, blockIndex, node, Quagga) {
            // Apply preprocessing
            const preprocessed = applyPreprocessing(input, block.preprocessing);

            // Decode based on decoder type
            let rawResults;

            switch (block.decoder) {
                case 'zbar':
                    rawResults = decodeWithZBar(preprocessed, block);
                    break;
                case 'zxing':
                    rawResults = decodeWithZXing(preprocessed, block);
                    break;
                case 'quagga2':
                    rawResults = await decodeWithQuagga(preprocessed, block, node, Quagga);
                    break;
                default:
                    throw new Error(`Unknown decoder: ${block.decoder}`);
            }

            // Add block metadata to results
            return rawResults.map(result => ({
                ...result,
                blockIndex: blockIndex,
                decoder: block.decoder,
                preprocessing: block.preprocessing
            }));
        }

        /**
         * Apply preprocessing to image
         */
        function applyPreprocessing(input, method) {
            switch (method) {
                case 'original':
                    return barcode.preprocess_original(input);
                case 'histogram':
                    return barcode.preprocess_histogram(input);
                case 'otsu':
                    return barcode.preprocess_otsu(input);
                default:
                    throw new Error(`Unknown preprocessing method: ${method}`);
            }
        }

        /**
         * Decode with ZBar
         */
        function decodeWithZBar(preprocessed, block) {
            const resultJson = barcode.decode_zbar(preprocessed);
            const parsed = JSON.parse(resultJson);

            if (parsed.error) {
                throw new Error(parsed.error);
            }

            return parsed.results || [];
        }

        /**
         * Decode with ZXing
         */
        function decodeWithZXing(preprocessed, block) {
            const tryHarder = block.options?.tryHarder || false;
            const resultJson = barcode.decode_zxing(preprocessed, tryHarder);
            const parsed = JSON.parse(resultJson);

            if (parsed.error) {
                throw new Error(parsed.error);
            }

            return parsed.results || [];
        }

        /**
         * Decode with Quagga2
         */
        async function decodeWithQuagga(preprocessed, block, node, Quagga) {
            if (!Quagga) {
                throw new Error('Quagga2 is not installed');
            }

            return new Promise(async (resolve, reject) => {
                try {
                    const jpeg = require('jpeg-js');

                    // Convert grayscale Buffer to RGBA for jpeg-js
                    // Preprocessed data is grayscale (1 channel), jpeg-js needs RGBA (4 channels)
                    const rgbaData = Buffer.alloc(preprocessed.width * preprocessed.height * 4);
                    for (let i = 0; i < preprocessed.data.length; i++) {
                        const gray = preprocessed.data[i];
                        rgbaData[i * 4] = gray;     // R
                        rgbaData[i * 4 + 1] = gray; // G
                        rgbaData[i * 4 + 2] = gray; // B
                        rgbaData[i * 4 + 3] = 255;  // A (fully opaque)
                    }

                    // Encode to JPEG (quality 85 is good balance for barcodes)
                    const jpegData = jpeg.encode({
                        data: rgbaData,
                        width: preprocessed.width,
                        height: preprocessed.height
                    }, 85);

                    // Convert to base64 data URI
                    const base64 = jpegData.data.toString('base64');
                    const dataUri = `data:image/jpeg;base64,${base64}`;

                    Quagga.decodeSingle({
                        src: dataUri,  // Now using proper data URI format
                        numOfWorkers: 0,
                        decoder: {
                            readers: [
                                "code_128_reader",   // CODE 128 (logistics, shipping)
                                "ean_reader",        // EAN-13 (retail products)
                                "ean_8_reader",      // EAN-8 (small items)
                                "upc_reader",        // UPC-A (North America retail)
                                "upc_e_reader",      // UPC-E (small packages)
                                "code_39_reader",    // CODE 39 (automotive, DoD)
                                "codabar_reader"     // CODABAR (libraries, blood banks)
                            ]
                        }
                    }, (result) => {
                        if (result && result.codeResult) {
                            const boxes = result.boxes || [];
                            let points = { x1: 0, y1: 0, x2: 0, y2: 0, x3: 0, y3: 0, x4: 0, y4: 0 };

                            // Extract corner points if available
                            if (boxes.length > 0 && boxes[0].length >= 4) {
                                const box = boxes[0];
                                points = {
                                    x1: box[0][0], y1: box[0][1],
                                    x2: box[1][0], y2: box[1][1],
                                    x3: box[2][0], y3: box[2][1],
                                    x4: box[3][0], y4: box[3][1]
                                };
                            }

                            resolve([{
                                type: result.codeResult.format,
                                data: result.codeResult.code,
                                points: points
                            }]);
                        } else {
                            resolve([]);
                        }
                    });
                } catch (err) {
                    reject(err);
                }
            });
        }

        /**
         * Deduplicate results by barcode value only
         * When duplicates exist, keep detection from lowest blockIndex
         */
        function deduplicateResults(results) {
            const map = new Map();

            for (const result of results) {
                const key = result.data;  // Use only barcode value for deduplication
                const detectionString = `${result.decoder}_${result.preprocessing}`;

                if (map.has(key)) {
                    const existing = map.get(key);

                    // Add detection string if not already present
                    if (!existing.detectedBy.includes(detectionString)) {
                        existing.detectedBy.push(detectionString);
                    }

                    // If new result has lower blockIndex, replace base detection
                    if (result.blockIndex < existing.blockIndex) {
                        map.set(key, {
                            ...result,
                            blockIndex: result.blockIndex,
                            detectedBy: existing.detectedBy
                        });
                    }
                } else {
                    map.set(key, {
                        ...result,
                        detectedBy: [detectionString]
                    });
                }
            }

            return Array.from(map.values());
        }

        /**
         * Convert result to final format with relative coordinates
         */
        function convertToFinalFormat(result, imageDimensions) {
            const { width, height } = imageDimensions;
            const points = result.points;

            // Convert absolute pixel coordinates to relative (0-1)
            const corners = [
                { x: points.x2 / width, y: points.y2 / height },
                { x: points.x3 / width, y: points.y3 / height },
                { x: points.x4 / width, y: points.y4 / height },
                { x: points.x1 / width, y: points.y1 / height }
            ];

            // Calculate center, size, and angle
            const absoluteCorners = [
                points.x2, points.y2,
                points.x3, points.y3,
                points.x4, points.y4,
                points.x1, points.y1
            ];
            const [center, size, angle] = getRotation(absoluteCorners);

            return {
                format: result.type,
                value: result.data,
                box: {
                    angle: angle,
                    center: {
                        x: center[0] / width,
                        y: center[1] / height
                    },
                    size: {
                        width: size[0] / width,
                        height: size[1] / height
                    }
                },
                corners: corners,
                detectedBy: result.detectedBy
            };
        }

        /**
         * Get image dimensions from input
         */
        function getImageDimensions(input) {
            if (input.width && input.height) {
                return { width: input.width, height: input.height };
            }

            // Fallback for buffer inputs (try to decode)
            try {
                const converted = barcode.convertToMat(input);
                return { width: converted.width, height: converted.height };
            } catch (err) {
                throw new Error('Could not determine image dimensions');
            }
        }

        /**
         * Calculate rotation, center, and size from corner points
         */
        function getRotation(l) {
            const center = [(l[0] + l[4]) / 2, (l[1] + l[5]) / 2];
            const diffs = [l[0] - l[6], l[1] - l[7]];
            const rotation = -Math.atan(diffs[0] / diffs[1]) * 180 / Math.PI;

            const sizeY = Math.sqrt((l[6] - l[0])**2 + (l[7] - l[1])**2);
            const sizeX = Math.sqrt((l[2] - l[0])**2 + (l[3] - l[1])**2);
            const size = [sizeX, sizeY];

            return [center, size, rotation];
        }
    }

    RED.nodes.registerType("barcode-reader", BarcodeReaderNode);
};
