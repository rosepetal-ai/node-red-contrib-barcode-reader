---
title: "Barcode Reader Node - Multi-Decoder Scanner"
description: "Advanced barcode and QR code scanner for Node-RED using ZBar, ZXing, and Quagga2 decoders. Features flexible preprocessing, fully async processing, and batch processing capabilities."
head:
  - - meta
    - name: "keywords"
      content: "node-red, barcode scanner, QR code, ZBar, ZXing, Quagga2, image processing, code detection, multi-decoder, batch processing, rosepetal"
  - - meta
    - property: "og:title"
      content: "Barcode Reader Node - @rosepetal/node-red-contrib-barcode-reader"
  - - meta
    - property: "og:description"
      content: "Advanced barcode and QR code scanner using ZBar, ZXing, and Quagga2 decoders. Features flexible preprocessing, fully async processing, and batch processing."
---

# Barcode Reader Node

## Overview

The Barcode Reader is a multi-decoder node that scans barcodes and QR codes from images using three powerful libraries: ZBar, ZXing, and Quagga2. It features a flexible block-based architecture that allows you to optimize detection for either maximum accuracy or performance.

Part of the `@rosepetal/node-red-contrib-barcode-reader` package. The node appears under the **RP Utils** category in the Node-RED palette.

## Architecture

The package is split into two components:

- **`barcode-engine/`** -- Native C++ addon (Node-API) that wraps ZBar, ZXing, and OpenCV. As of v1.2.1, all decoding and preprocessing operations run on **async workers**, so the Node-RED event loop is never blocked.
- **`node-red-contrib-barcode-reader/`** -- Node-RED wrapper that provides the editor UI, block configuration, execution modes, and result merging/deduplication.

Prebuilt binaries for `barcode-engine` are available for **linux-x64**, **linux-arm64**, and **linuxmusl-x64**. On other platforms the addon is compiled from source during `npm install`.

## Key Features

- **Multi-decoder support**: ZBar, ZXing, and Quagga2
- **Fully async processing**: Native addon uses C++ async workers -- the Node-RED event loop is never blocked (v1.2.1+)
- **Flexible preprocessing**: Original, Histogram Equalization, Otsu Threshold
- **Per-block format filter**: restrict each block to specific symbologies (e.g. UPC-A only) for speed and to eliminate false positives
- **Block-based configuration**: Combine decoders and preprocessing methods
- **Execution modes**: Parallel (maximum detection) or Sequential (optimized performance)
- **Batch processing**: Process single images or arrays of images
- **Smart deduplication**: Automatically merges duplicate detections
- **Performance tracking**: Built-in execution time monitoring
- **Rich output format**: Includes barcode corners, rotation, and detection metadata

## Installation

### npm (recommended)

```bash
npm install @rosepetal/node-red-contrib-barcode-reader
```

npm will attempt to fetch a prebuilt native addon for your platform. Prebuilt binaries bundle OpenCV, ZBar, and ZXing; system libraries are only required for source builds or unsupported platforms.

### Build from source (Debian/Ubuntu)

```bash
cd node-red-contrib-barcode-reader
bash INSTALL.sh
```

The script will:
1. Install ZBar, ZXing, and OpenCV libraries
2. Build ZXing from source if the package is not available
3. Build the C++ addon and install the Node-RED package dependencies

### Build dependencies (source builds only)

| Package | Purpose |
|---------|---------|
| `libzbar-dev` | ZBar barcode library |
| `libzxing-dev` | ZXing barcode library (or build from source) |
| `libopencv-dev` | OpenCV image processing |
| `build-essential` | C++ compiler toolchain |
| `node-gyp` | Native addon build tool |

### Runtime requirements

- **Node.js**: >= 14.x
- **Node-RED**: >= 1.0.0
- **OS**: Linux (Ubuntu/Debian recommended)

## Configuration

### Properties

#### Name
- **Type**: String
- **Optional**: Yes
- **Description**: Custom name for the node instance

#### Input
- **Type**: Message property path
- **Default**: `payload`
- **Description**: Message property containing the input image(s)

#### Output
- **Type**: Message property path
- **Default**: `payload`
- **Description**: Message property where results will be stored

#### Execution Mode
- **Type**: Select
- **Options**:
  - **Parallel**: Runs all blocks simultaneously and merges results (maximum detection)
  - **Sequential**: Processes blocks in order, stops at first successful detection (optimized performance)

### Decoder Blocks

Each block represents a detection attempt with specific configuration. Blocks can be:
- Added with the "Add Block" button
- Reordered by dragging (relevant for Sequential mode)
- Removed individually
- Configured independently

#### Decoder Options

**ZBar**
- Fast and reliable
- Good for standard barcodes and QR codes
- Native C++ implementation via async worker
- Best overall performance

**ZXing**
- Comprehensive format support
- "Try Harder" option for difficult codes
- Good for damaged or low-quality barcodes
- Slower but more thorough

**Quagga2**
- JavaScript-based decoder
- Good for 1D barcodes
- Runs in Node.js without native dependencies
- Moderate performance

#### Preprocessing Options

**Original**
- Simple grayscale conversion
- Fastest option
- Use for high-quality images with good contrast

**Histogram Equalization**
- Enhances contrast across the image
- Good for poor lighting conditions
- Helps with uneven illumination

**Otsu Threshold**
- Converts to binary (black/white) image
- Best for low-contrast barcodes
- Effective for faded or worn codes

#### Format Filter (per block)

Each block has a **Formats** allowlist. The list shown in the editor is filtered to formats the selected decoder actually supports — so you'll see different options when the block uses ZBar vs. ZXing vs. Quagga2.

- **All formats** (default): the decoder is unrestricted; current behavior is preserved.
- **Specific formats**: only the checked symbologies are decoded. Useful for reducing false positives in production lines that scan a single known format, and to avoid ZBar's UPC-A → EAN-13 leading-zero ambiguity (force `UPCA` to get 12-digit output).

Selections persist across decoder changes when the new decoder still supports them — for example switching a block from ZBar to ZXing with `UPCA` checked keeps `UPCA` checked; switching to Quagga2 from ZXing with `Aztec` checked drops `Aztec` (Quagga2 is 1D-only).

#### Decoder-Specific Options

**ZXing Options:**
- **Try Harder**: Enables more thorough scanning (slower but more accurate)

## Input Format

The node accepts images in multiple formats:

### Rosepetal Bitmap Format
```javascript
{
  data: Buffer,            // Raw pixel data
  width: 1920,
  height: 1080,
  colorSpace: "RGB",       // "GRAY", "RGB", "BGR", "RGBA", "BGRA"
  dtype: "uint8"
}
```

### Raw Bitmap
```javascript
{
  width: 1920,
  height: 1080,
  data: Buffer,
  channels: 3              // 1 (grayscale), 3 (RGB/BGR), 4 (RGBA/BGRA)
}
```

### Image Buffers
- JPEG buffer
- PNG buffer

### Array Input
Process multiple images at once:
```javascript
msg.payload = [image1, image2, image3];
```

## Output Format

### Single Image Input

Returns an array of detected barcodes:

```javascript
[
  {
    format: "QR-Code",
    value: "decoded_content_here",
    box: {
      center: { x: 0.5, y: 0.5 },        // Relative coordinates (0-1)
      size: { width: 0.2, height: 0.2 },  // Relative to image size
      angle: 15                            // Rotation in degrees
    },
    corners: [                             // Four corners in relative coordinates
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.6, y: 0.6 },
      { x: 0.4, y: 0.6 }
    ],
    detectedBy: ["zbar_original", "zxing_original"] // Which decoder/preprocessing found it
  }
]
```

### Array Input

Returns nested array structure:

```javascript
[
  [image1_result1, image1_result2], // Results from first image
  [image2_result1],                  // Results from second image
  []                                 // No results from third image
]
```

### Coordinate System

All coordinates are **normalized to 0-1 range**:
- `x: 0` = left edge, `x: 1` = right edge
- `y: 0` = top edge, `y: 1` = bottom edge

To convert to pixels: `pixelX = x * imageWidth`

### Performance Tracking

The node automatically adds execution time to `msg.performance`:

```javascript
msg.performance = {
  "barcode-reader": {
    startTime: Date,
    milliseconds: 245
  }
}
```

The execution time is also displayed under the node in the editor.

## Usage Examples

### Example 1: Maximum Detection Rate (Parallel Mode)

**Use case**: Scanning worn, damaged, or low-quality barcodes

**Configuration:**
- **Mode**: Parallel
- **Block 1**: ZBar + Original
- **Block 2**: ZBar + Histogram Equalization
- **Block 3**: ZBar + Otsu Threshold
- **Block 4**: ZXing + Original + Try Harder
- **Block 5**: ZXing + Histogram + Try Harder

**Behavior**: All blocks run simultaneously via async workers, results are merged and deduplicated. The Node-RED event loop remains free to handle other messages.

**Trade-off**: Higher total CPU time, maximum detection rate

### Example 2: Fast with Fallback (Sequential Mode)

**Use case**: High-throughput production with mostly good quality codes

**Configuration:**
- **Mode**: Sequential
- **Block 1**: ZBar + Original (fastest)
- **Block 2**: ZXing + Original (if Block 1 fails)
- **Block 3**: ZXing + Histogram + Try Harder (last resort)

**Behavior**: Stops at first successful detection

**Trade-off**: Fast for most images, reliable fallback for difficult ones

### Example 3: Balanced Approach

**Use case**: Mixed quality images, moderate performance requirements

**Configuration:**
- **Mode**: Parallel
- **Block 1**: ZBar + Original
- **Block 2**: ZXing + Histogram
- **Block 3**: Quagga2 + Otsu

**Behavior**: Three different approaches run in parallel

**Trade-off**: Good balance of speed and detection rate

### Example 4: Processing Multiple Images

```javascript
// Input node
msg.payload = [
  imageBuffer1,
  imageBuffer2,
  imageBuffer3
];

// After barcode reader
msg.payload = [
  [{ format: "QR-Code", value: "ABC123", ... }],  // Results from image 1
  [{ format: "CODE-128", value: "XYZ789", ... }], // Results from image 2
  []                                               // No barcodes in image 3
];
```

### Example 5: Custom Input/Output Paths

```javascript
// Configuration:
// - Input: "image.data"
// - Output: "barcodes"

msg.image = {
  data: imageBuffer,
  width: 1920,
  height: 1080
};

// After processing:
msg.barcodes = [
  { format: "QR-Code", value: "scanned_data", ... }
];
```

## Supported Barcode Formats

### 1D Barcodes
- CODE-128 (logistics, shipping)
- CODE-39 (automotive, DoD)
- CODE-93 (Canada Post)
- EAN-13 (retail products worldwide)
- EAN-8 (small retail items)
- UPC-A (North America retail)
- UPC-E (small packages)
- CODABAR (libraries, blood banks, FedEx)
- ITF (Interleaved 2 of 5)

### 2D Barcodes
- QR Code
- Data Matrix
- PDF417
- Aztec Code

### Decoder Format Support

The canonical names match the values used in each block's **Formats** filter.

| Canonical name | ZBar | ZXing | Quagga2 |
|----------------|:----:|:-----:|:-------:|
| `UPCA`         | Y    | Y     | Y       |
| `UPCE`         | Y    | Y     | Y       |
| `EAN13`        | Y    | Y     | Y       |
| `EAN8`         | Y    | Y     | Y       |
| `Code128`      | Y    | Y     | Y       |
| `Code39`       | Y    | Y     | Y       |
| `Code93`       | Y    | Y     | Y       |
| `Codabar`      | Y    | Y     | Y       |
| `ITF`          | Y    | Y     | Y       |
| `QRCode`       | Y    | Y     | -       |
| `PDF417`       | Y    | Y     | -       |
| `DataMatrix`   | -    | Y     | -       |
| `Aztec`        | -    | Y     | -       |
| `DataBar`      | Y    | Y     | -       |

Formats not supported by a decoder are omitted from the editor's checklist when that decoder is selected; if a Format is set programmatically that the decoder doesn't support, it is silently ignored.

## Performance Considerations

### Async Processing (v1.2.1+)

All native decoding and preprocessing runs on C++ async workers. This means:
- The Node-RED event loop is **never blocked** during barcode processing
- Multiple barcode operations can be in-flight concurrently
- Other nodes in the flow continue to process messages while decoding runs

### Execution Time Factors

1. **Number of blocks**: More blocks = longer execution (in Parallel mode)
2. **Preprocessing method**: Original < Histogram < Otsu
3. **Decoder choice**: Quagga2 < ZBar < ZXing (approximate)
4. **Image size**: Larger images take longer
5. **Try Harder option**: Significantly increases ZXing processing time

### Optimization Strategies

#### For Speed
- Use Sequential mode
- Start with Original preprocessing
- Place fastest blocks first (ZBar + Original)
- Reduce image resolution before processing
- Use single decoder only

#### For Accuracy
- Use Parallel mode
- Include multiple preprocessing options
- Enable "Try Harder" on ZXing blocks
- Use multiple decoders
- Ensure good image quality (1500px max on long side recommended)

### Typical Performance

**Sequential mode (fast path):**
- High-quality barcode: 20-50ms (Block 1 success)
- Medium quality: 100-200ms (falls to Block 2-3)
- Low quality: 300-500ms (exhausts all blocks)

**Parallel mode (maximum detection):**
- 3 blocks: 150-300ms
- 5 blocks: 300-600ms
- 8 blocks: 500-1000ms

*Times vary based on image size, hardware, and complexity*

## Deduplication Logic

When multiple blocks detect the same barcode:

1. Barcodes are considered duplicates if they have the same **value** (data)
2. The detection from the **lowest block index** is kept as the primary result
3. All detection methods are tracked in the `detectedBy` array
4. Position data (corners, box) comes from the primary detection

**Example:**
```javascript
// Block 0: ZBar + Original detects "ABC123"
// Block 2: ZXing + Histogram also detects "ABC123"

// Result:
{
  format: "CODE-128",
  value: "ABC123",
  box: { /* from Block 0 */ },
  corners: [ /* from Block 0 */ ],
  detectedBy: ["zbar_original", "zxing_histogram"]
}
```

## Programmatic API

The `barcode-engine` addon can be used outside Node-RED. All native functions are async (callback-based) and are promisified by the package:

```javascript
const barcode = require('@rosepetal/node-red-contrib-barcode-reader');

// Preprocessing (returns grayscale image as Rosepetal bitmap)
const gray     = await barcode.preprocess_original(inputMat);
const enhanced = await barcode.preprocess_histogram(inputMat);
const binary   = await barcode.preprocess_otsu(inputMat);

// Decoders (require grayscale input, return JSON string)
// Signature: decode_zbar(image, formats)
const zbarAll  = await barcode.decode_zbar(gray, []);                 // all symbologies
const zbarUpc  = await barcode.decode_zbar(gray, ['UPCA']);           // UPC-A only

// Signature: decode_zxing(image, tryHarder, formats)
const zxAll    = await barcode.decode_zxing(gray, false, []);          // all formats
const zxQrOnly = await barcode.decode_zxing(gray, true,  ['QRCode']);  // QR + tryHarder

// Parse results
const { results } = JSON.parse(zbarUpc);

// Utilities
const resized   = await barcode.resizeImage(inputMat, 50);   // 50% size
const converted = await barcode.convertToMat(anyInput);      // normalize input
```

**`formats` argument**: an array of canonical format names (see the [Decoder Format Support](#decoder-format-support) table). Pass `[]` to leave the decoder unrestricted. Unsupported names for a given decoder are silently ignored.

### Decoder Result Format

```javascript
{
  "results": [
    {
      "type": "QR-Code",
      "data": "decoded content",
      "points": {
        "x1": 100, "y1": 100,
        "x2": 200, "y2": 100,
        "x3": 200, "y3": 200,
        "x4": 100, "y4": 200
      }
    }
  ]
}
```

## Troubleshooting

### No Barcodes Detected

**Possible causes:**
- Barcode too small or large in image
- Poor image quality or low contrast
- Barcode damaged or partially obscured
- Unsupported barcode format

**Solutions:**
1. Add blocks with stronger preprocessing (Histogram, Otsu)
2. Enable "Try Harder" on ZXing blocks
3. Switch to Parallel mode for comprehensive scanning
4. Verify barcode format is supported
5. Check image quality and resolution
6. Ensure proper lighting in source images

### Build Errors

These errors only apply to source builds (when no prebuilt binary is available for your platform).

**"Could not load the barcode native addon"**
- If no prebuilt binary is available, install system deps and run `cd barcode-engine && npm run rebuild`

**"Cannot find -lzbar"**
```bash
sudo apt-get install libzbar-dev
```

**"Cannot find -lZXing"**
```bash
# Build ZXing from source
git clone https://github.com/zxing-cpp/zxing-cpp.git
cd zxing-cpp && git checkout v2.3.0
mkdir build && cd build
cmake -DCMAKE_INSTALL_PREFIX=/usr -DBUILD_SHARED_LIBS=ON ..
make -j$(nproc) && sudo make install
sudo ldconfig
```

**"Cannot find opencv2/opencv.hpp"**
```bash
sudo apt-get install libopencv-dev
```

**node-gyp errors**
```bash
sudo apt-get install build-essential python3
npm install -g node-gyp
```

### Slow Performance

**Possible causes:**
- Too many blocks in Parallel mode
- Large image resolution
- Multiple "Try Harder" blocks
- Processing arrays of many images

**Solutions:**
1. Switch to Sequential mode
2. Reduce number of blocks
3. Disable "Try Harder" or use selectively
4. Resize images before processing
5. Remove blocks with slow preprocessing (Otsu)

### Wrong Barcode Values

**Possible causes:**
- Multiple barcodes in image
- Barcode partially damaged
- Similar patterns confusing decoder

**Solutions:**
1. Crop image to single barcode region
2. Use stronger preprocessing
3. Enable "Try Harder" on ZXing
4. Verify expected barcode format

### UPC-A read as EAN-13 with leading 0

ZBar treats UPC-A as a subset of EAN-13. When unrestricted, it may emit a 12-digit UPC-A code as a 13-digit EAN-13 with a leading `0`.

**Solution:** add `UPCA` to the block's **Formats** list. ZBar will then label and output the code as `UPC-A` (12 digits). If you need both, enable both `UPCA` and `EAN13`.

### Missing Quagga2 Warning

**Message**: `Quagga2 not available. Install @ericblade/quagga2 to use Quagga decoder.`

**Solution:**
```bash
npm install @ericblade/quagga2
```

Or remove Quagga2 blocks from configuration.

## Best Practices

### Image Preparation

1. **Resolution**: Keep images around 1500px on the long side for optimal balance
2. **Format**: Use JPEG for photos, PNG for generated codes
3. **Lighting**: Ensure even lighting across barcode
4. **Focus**: Barcodes must be sharp and in focus
5. **Orientation**: Any orientation works, rotation is detected

### Block Configuration

1. **Start simple**: Begin with 1-2 blocks and add more if needed
2. **Order matters**: In Sequential mode, put fastest/most likely blocks first
3. **Test thoroughly**: Verify with representative sample images
4. **Monitor performance**: Watch execution times in production
5. **Document choices**: Note why specific blocks were chosen

### Production Deployment

1. **Test all formats**: Verify all expected barcode types are detected
2. **Benchmark performance**: Measure actual execution times
3. **Handle failures**: Implement proper error handling for no-detection cases
4. **Log statistics**: Track detection rates and performance
5. **Version control**: Document block configuration changes

## Advanced Usage

### Dynamic Block Configuration

You can modify block configuration programmatically before the node:

```javascript
// In a function node before the barcode reader
msg.barcodeConfig = {
  blocks: [
    { decoder: "zbar",  preprocessing: "original",  options: { formats: ["UPCA"] } },
    { decoder: "zxing", preprocessing: "histogram", options: { formats: ["QRCode"], tryHarder: true } }
  ],
  executionMode: "sequential"
};
```

`options.formats` is an array of canonical format names (see [Decoder Format Support](#decoder-format-support)). Use `[]` or omit the key for "all formats".

### Region of Interest Processing

Crop image to barcode region before processing:

```javascript
// In a function node before the barcode reader
const sharp = require('sharp');

msg.payload = await sharp(msg.payload)
  .extract({ left: 100, top: 100, width: 500, height: 200 })
  .toBuffer();
```

### Quality Validation

Filter results by confidence or validation:

```javascript
// In a function node after the barcode reader
msg.payload = msg.payload.filter(result => {
  // Only keep results detected by multiple methods
  return result.detectedBy.length >= 2;
});
```

### Performance Monitoring

Track detailed performance metrics:

```javascript
// In a function node after the barcode reader
const perf = msg.performance["barcode-reader"];
const detectionCount = Array.isArray(msg.payload) ? msg.payload.length : 0;

msg.metrics = {
  executionTime: perf.milliseconds,
  detectionsFound: detectionCount,
  detectionsPerSecond: (detectionCount / perf.milliseconds * 1000).toFixed(2)
};
```

## Migration Guide

### From node-zbardecoder

If migrating from the basic `node-zbardecoder` package:

**Old approach:**
```javascript
const bardecoder = require('node-zbardecoder');
const result = JSON.parse(bardecoder.decode('image.jpg'));
```

**New approach:**
- Use the Barcode Reader node in your flow
- Configure with ZBar decoder + Original preprocessing
- Results are automatically parsed and formatted
- Additional decoders and preprocessing available

**Key differences:**
- Block-based configuration vs. single decoder
- Relative coordinates instead of absolute pixels
- Rich metadata (corners, rotation, detection tracking)
- Built-in performance monitoring
- Fully async processing -- no event loop blocking

## See Also

- [ZBar Library](http://zbar.sourceforge.net/) - Open source barcode scanner
- [ZXing Library](https://github.com/zxing-cpp/zxing-cpp) - Multi-format 1D/2D barcode library
- [Quagga2](https://github.com/ericblade/quagga2) - JavaScript barcode decoder
- [OpenCV](https://opencv.org/) - Computer vision library used for preprocessing
