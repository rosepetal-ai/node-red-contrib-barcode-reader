# @rosepetal/node-red-contrib-barcode-reader

Multi-decoder barcode scanner for Node-RED with ZBar, ZXing, and Quagga2 support.

**Version**: 1.0.0
**License**: Apache-2.0
**Platform**: Linux (Ubuntu/Debian)

## Overview

A sophisticated barcode detection system featuring:

- **Three decoder backends**: ZBar (C++), ZXing (C++), Quagga2 (JavaScript)
- **Three preprocessing methods**: Original, Histogram Equalization, Otsu Threshold
- **Block-based architecture**: Flexible combinations of decoders and preprocessing
- **Two execution modes**: Parallel (maximum detection) and Sequential (fast with fallback)
- **Automatic deduplication**: Intelligent merging of redundant detections
- **Normalized coordinates**: All results in 0-1 relative range

## Features

| Feature | Description |
|---------|-------------|
| Multi-decoder | Combine ZBar, ZXing, and Quagga2 in configurable blocks |
| Preprocessing | Enhance images before decoding for better results |
| Parallel Mode | Run all blocks concurrently, merge and deduplicate results |
| Sequential Mode | Run blocks in order, stop at first successful detection |
| Array Support | Process single images or arrays of images |
| Performance Tracking | Execution time displayed in Node-RED editor |
| Relative Coordinates | Output normalized to 0-1 range for any image size |

## Requirements

### Build Dependencies (source builds only)

| Package | Purpose |
|---------|---------|
| `libzbar-dev` | ZBar barcode library |
| `libzxing-dev` | ZXing barcode library (or build from source) |
| `libopencv-dev` | OpenCV image processing |
| `build-essential` | C++ compiler toolchain |
| `node-gyp` | Native addon build tool |

Prebuilt binaries bundle OpenCV, ZBar, and ZXing on supported platforms. Install these packages only if you are building from source or using an unsupported platform.

### Runtime

- **Node.js**: >= 14.x
- **Node-RED**: >= 1.0.0
- **OS**: Linux (Ubuntu/Debian recommended)

## Installation

### Palette / npm install (recommended)

Install from the Node-RED palette or via npm:

```bash
npm install @rosepetal/node-red-contrib-barcode-reader
```

> npm will attempt to fetch a prebuilt native addon for supported platforms. Prebuilt binaries bundle OpenCV/ZBar/ZXing; system libraries are only required for source builds or unsupported platforms.

### Build from source (Debian/Ubuntu)

```bash
cd node-red-contrib-barcode-reader
bash INSTALL.sh
```

The script will:
1. Install ZBar, ZXing, and OpenCV libraries
2. Build ZXing from source if package not available
3. Compile the C++ native addon

### Manual Installation (source build)

```bash
# Install dependencies (Debian/Ubuntu)
sudo apt-get update
sudo apt-get install -y libzbar-dev libopencv-dev build-essential

# Install ZXing (if available in repos)
sudo apt-get install -y libzxing-dev

# Or build ZXing from source
git clone https://github.com/zxing-cpp/zxing-cpp.git
cd zxing-cpp && git checkout v2.3.0
mkdir build && cd build
cmake -DCMAKE_INSTALL_PREFIX=/usr -DBUILD_SHARED_LIBS=ON ..
make -j$(nproc) && sudo make install

# Build the addon
cd node-red-contrib-barcode-reader
npm install
```

## Node-RED Configuration

### Adding to Palette

The node registers automatically as `barcode-reader` in the Node-RED palette under the input category.

### Node Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| Name | Node instance name | - |
| Input | Message property for input image | `msg.payload` |
| Output | Message property for results | `msg.payload` |
| Execution Mode | `parallel` or `sequential` | `parallel` |
| Blocks | Array of decoder+preprocessing combinations | 1 block |

### Block Configuration

Each block specifies:
- **Decoder**: `zbar`, `zxing`, or `quagga2`
- **Preprocessing**: `original`, `histogram`, or `otsu`
- **Options**: Decoder-specific settings (e.g., `tryHarder` for ZXing)

## Decoders

| Decoder | Type | Formats | Speed | Options |
|---------|------|---------|-------|---------|
| **ZBar** | C++ Native | QR, Code-128, EAN, UPC, Code-39 | Fast | None |
| **ZXing** | C++ Native | All major 1D/2D formats | Medium | `tryHarder` |
| **Quagga2** | JavaScript | 1D barcodes (Code-128, EAN, UPC, Code-39, Codabar) | Slower | Reader selection |

### ZBar
- Fastest decoder for common formats
- Excellent QR code detection
- No configuration options

### ZXing
- Most comprehensive format support
- `tryHarder` option for difficult barcodes (slower but more accurate)
- `tryRotate` enabled by default

### Quagga2
- Pure JavaScript implementation
- No native compilation required
- Best for 1D linear barcodes

## Preprocessing Methods

| Method | Description | Best For |
|--------|-------------|----------|
| **Original** | Grayscale conversion only | High-quality images, fast processing |
| **Histogram** | Contrast enhancement via histogram equalization | Poor lighting, low contrast |
| **Otsu** | Binary threshold after histogram equalization | Very low contrast, faded barcodes |

## Input Format

The node accepts multiple image formats:

### Rosepetal Bitmap (Recommended)

```javascript
{
  data: Buffer,           // Raw pixel data
  width: 640,
  height: 480,
  colorSpace: "RGB",      // "GRAY", "RGB", "BGR", "RGBA", "BGRA"
  dtype: "uint8"
}
```

### Raw Bitmap

```javascript
{
  data: Buffer,
  width: 640,
  height: 480,
  channels: 3             // 1 (grayscale), 3 (RGB/BGR), 4 (RGBA/BGRA)
}
```

### Encoded Image

```javascript
Buffer  // JPEG or PNG encoded data (auto-detected)
```

### Array Input

```javascript
[image1, image2, image3]  // Array of any format above
```

## Output Format

### Single Image Result

```javascript
[
  {
    format: "QR-Code",
    value: "https://example.com",
    box: {
      angle: 15.2,                        // Rotation in degrees
      center: { x: 0.5, y: 0.5 },         // Relative center (0-1)
      size: { width: 0.2, height: 0.2 }   // Relative size (0-1)
    },
    corners: [                             // 4 corner points (0-1)
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.4 },
      { x: 0.6, y: 0.6 },
      { x: 0.4, y: 0.6 }
    ],
    detectedBy: [                          // All successful detections
      "zbar_original",
      "zxing_histogram"
    ]
  }
]
```

### Array Input Result

```javascript
[
  [/* image1 results */],
  [/* image2 results */],
  [/* image3 results */]
]
```

### Coordinate System

All coordinates are **normalized to 0-1 range**:
- `x: 0` = left edge, `x: 1` = right edge
- `y: 0` = top edge, `y: 1` = bottom edge

To convert to pixels: `pixelX = x * imageWidth`

## Usage Strategies

### Maximum Detection (Parallel)

Use multiple blocks with different decoder/preprocessing combinations:

```
Execution Mode: parallel
Blocks:
  1. ZBar + Original
  2. ZXing + Original
  3. ZBar + Histogram
  4. ZXing + Histogram (tryHarder)
  5. ZXing + Otsu (tryHarder)
```

All blocks run concurrently. Results are merged and deduplicated by barcode value.

### Optimized Performance (Sequential)

Order blocks from fastest to most thorough:

```
Execution Mode: sequential
Blocks:
  1. ZBar + Original        (fastest)
  2. ZXing + Original       (if ZBar fails)
  3. ZXing + Histogram      (if poor contrast)
  4. ZXing + Otsu + tryHarder (last resort)
```

Stops at first successful detection for faster processing.

### QR Code Focus

```
Blocks:
  1. ZBar + Original
  2. ZXing + Histogram (tryHarder)
```

### 1D Barcode Focus

```
Blocks:
  1. ZBar + Original
  2. Quagga2 + Histogram
  3. ZXing + Otsu (tryHarder)
```

## Programmatic API

For use outside Node-RED:

```javascript
const barcode = require('@rosepetal/node-red-contrib-barcode-reader');

// Preprocessing (returns grayscale cv::Mat as Rosepetal bitmap)
const gray = barcode.preprocess_original(inputMat);
const enhanced = barcode.preprocess_histogram(inputMat);
const binary = barcode.preprocess_otsu(inputMat);

// Decoders (require grayscale input, return JSON string)
const zbarResult = barcode.decode_zbar(gray);
const zxingResult = barcode.decode_zxing(gray, false);      // normal
const zxingHard = barcode.decode_zxing(enhanced, true);     // tryHarder

// Parse results
const barcodes = JSON.parse(zbarResult);
console.log(barcodes.results);

// Utilities
const resized = barcode.resizeImage(inputMat, 50);  // 50% size
const converted = barcode.convertToMat(anyInput);   // normalize input
```

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

### Build Errors

These errors only apply to source builds (when no prebuilt binary is available).

**"Could not load the barcode native addon"**
- If no prebuilt binary is available for your platform, install system deps and run `npm run rebuild`

**"Cannot find -lzbar"**
```bash
sudo apt-get install libzbar-dev
```

**"Cannot find -lZXing"**
```bash
# ZXing not in repos, build from source
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

### Runtime Errors

**"Module not found"**
```bash
cd node-red-contrib-barcode-reader
npm run build
```

**No barcodes detected**
- Try different preprocessing methods
- Enable `tryHarder` for ZXing
- Check image quality and barcode size
- Ensure barcode is not too small (< 50px) or too large

### Performance Issues

- Use Sequential mode for faster response
- Reduce number of blocks
- Resize large images before processing
- Use ZBar for simple cases (fastest)

## Supported Barcode Formats

### 1D Barcodes
- Code-128
- Code-39
- EAN-13, EAN-8
- UPC-A, UPC-E
- Codabar
- ITF (Interleaved 2 of 5)

### 2D Barcodes
- QR Code
- Data Matrix
- PDF417
- Aztec

## License

Apache-2.0

Copyright (c) Rosepetal SL - https://www.rosepetal.ai

## Third-Party License Compliance

This project uses ZBar (LGPL-2.1), ZXing-cpp (Apache-2.0), OpenCV (Apache-2.0), and Quagga2 (MIT) via npm.
Prebuilt binaries statically link OpenCV/ZBar/ZXing for portability. Source builds link against system libraries; if you need to replace ZBar to exercise LGPL rights, build from source.
Third-party license texts are included in `THIRD_PARTY_NOTICES`.

## Credits

This project uses the following open-source libraries:

- [ZBar](http://zbar.sourceforge.net) - Barcode scanning library
- [ZXing-cpp](https://github.com/zxing-cpp/zxing-cpp) - C++ port of ZXing
- [OpenCV](https://opencv.org) - Computer vision library
- [Quagga2](https://github.com/ericblade/quagga2) - JavaScript barcode scanner
- [Node-API](https://nodejs.org/api/n-api.html) - Node.js native addon API

## Author

**Rosepetal SL**
https://www.rosepetal.ai
