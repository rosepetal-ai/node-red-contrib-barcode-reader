# @rosepetal/node-red-contrib-barcode-reader

Multi-decoder barcode scanner for Node-RED with ZBar, ZXing, Quagga2, Rosepetal Projection and the Rosepetal SDK engine.

**Version**: 1.4.0 (see [CHANGELOG.md](CHANGELOG.md))
**License**: Apache-2.0
**Platform**: Linux (Ubuntu/Debian)

## Overview

A sophisticated barcode detection system featuring:

- **Five decoder backends**: ZBar (C++), ZXing (C++), Quagga2 (JavaScript), Rosepetal Projection (C++), Rosepetal SDK (Go engine, optional package)
- **Three preprocessing methods**: Original, Histogram Equalization, Otsu Threshold
- **Block-based architecture**: Flexible combinations of decoders and preprocessing
- **Two execution modes**: Parallel (maximum detection) and Sequential (fast with fallback)
- **Automatic deduplication**: Intelligent merging of redundant detections
- **Normalized coordinates**: All results in 0-1 relative range

## Features

| Feature | Description |
|---------|-------------|
| Multi-decoder | Combine ZBar, ZXing, Quagga2, Rosepetal Projection and the Rosepetal SDK in configurable blocks |
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

- **Node.js**: >= 18 (`engines.node`; the test suite needs >= 22.9, see [Development](#development))
- **Node-RED**: >= 1.0.0
- **OS**: Linux (Ubuntu/Debian recommended)
- **Rosepetal SDK decoder** (optional): the engine package from Rosepetal's private registry, or `RP_BARCODE_ENGINE` (see Installation)

## Installation

### Palette / npm install (recommended)

Install from the Node-RED palette or via npm:

```bash
npm install @rosepetal/node-red-contrib-barcode-reader
```

> npm will attempt to fetch a prebuilt native addon for supported platforms. Prebuilt binaries bundle OpenCV/ZBar/ZXing; system libraries are only required for source builds or unsupported platforms.

> The optional `rosepetal` decoder needs the Rosepetal SDK engine. The node depends on
> [`@rosepetal/barcode-engine-client`](https://github.com/rosepetal-ai/rosepetal-barcode-sdk/tree/dev/clients/node)
> (npmjs, published by the SDK repository), and that client declares the engine binary as its **optional** dependencies
> `@rosepetal/barcode-engine-linux-x64` and `@rosepetal/barcode-engine-linux-arm64` (0.2.x, one static binary at
> `bin/rp-barcode`, the same package serves glibc and musl) on Rosepetal's private Artifact Registry
> (`europe-southwest1-npm.pkg.dev/rosepetal-artifact/private-node-packages`). On a machine without access to that
> registry npm skips them with a warning, every other decoder works as before, and a `rosepetal` block warns
> `Rosepetal engine not available` once per node and returns `[]`. Manual install of the engine next to the node
> (`~/.node-red`): `gcloud auth login && npx google-artifactregistry-auth`, then
> `npm install @rosepetal/barcode-engine-linux-x64 --registry=https://europe-southwest1-npm.pkg.dev/rosepetal-artifact/private-node-packages/`
> (never run `npm install --registry=…` for other packages in the user dir: it reconciles the whole tree against that registry).
> `RP_BARCODE_ENGINE=/path/to/rp-barcode` points the node at any other build of the engine (SDK >= 0.2.0; when set it
> must be executable: the package and `PATH` are then not searched); without both, `rp-barcode` is looked up in `PATH`.

### Build from source (Debian/Ubuntu)

```bash
cd node-red-contrib-barcode-reader
bash INSTALL.sh
```

The script will:
1. Install ZBar, ZXing, and OpenCV libraries
2. Build ZXing from source if package not available
3. Build the C++ addon and install the Node-RED package dependencies

> Since 1.4.0 the inner package (`node-red-contrib-barcode-reader/package.json`, what `INSTALL.sh` installs) depends on
> `@rosepetal/barcode-engine-client` from npmjs, so its `npm install` needs that package published; the engine itself
> comes from the private registry (configure the `@rosepetal` scope first) or from `RP_BARCODE_ENGINE`, as above.

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
cd /path/to/node-red-contrib-barcode-reader/barcode-engine
npm install

# Install the Node-RED package dependencies
cd ../node-red-contrib-barcode-reader
npm install

# Optional: install into Node-RED
cd ~/.node-red
npm install /path/to/node-red-contrib-barcode-reader/node-red-contrib-barcode-reader
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
- **Decoder**: `zbar`, `zxing`, `quagga2`, `rp-projection` or `rosepetal`
- **Preprocessing**: `original`, `histogram`, or `otsu` (not used by `rp-projection`; for `rosepetal` it runs in the addon and the engine receives the 8-bit gray result)
- **Options**: Decoder-specific settings (e.g. `formats` allowlist; `minVotes` and `stripWidth` for `rp-projection`; `effort`, `directions`, `tryInvert`, `addOn`, `upcaAsEan13`, `code39FullAscii`, `checksum`, `quietZone`, `minLines`, `timeoutMs` for `rosepetal`)

## Decoders

| Decoder | Type | Formats | Speed | Options |
|---------|------|---------|-------|---------|
| **ZBar** | C++ Native | QR, Code-128, EAN, UPC, Code-39 | Fast | None |
| **ZXing** | C++ Native | All major 1D/2D formats | Medium | `formats` |
| **Quagga2** | JavaScript | 1D barcodes (Code-128, EAN, UPC, Code-39, Codabar) | Slower | Reader selection |
| **Rosepetal Projection** | C++ Native | 1D barcodes | Slow (50-300 ms) | `formats`, `minVotes`, `stripWidth` |
| **Rosepetal SDK** | Go engine (child process) | 1D: UPC-A/E, EAN-13/8, Code 128 (GS1-128), Code 39, Code 93, Codabar, ITF | Fast (`normal`) / Medium (`robust`, default) | see below |

### ZBar
- Fastest decoder for common formats
- Excellent QR code detection
- No configuration options

### ZXing
- Most comprehensive format support
- Thorough scan and rotation handling always on (matches zxing.org defaults)

### Quagga2
- Pure JavaScript implementation
- No native compilation required
- Best for 1D linear barcodes

### Rosepetal Projection (`rp-projection`)
- For noisy or low-resolution 1D codes the other decoders miss (down to ~1.5 px per module)
- Expects a crop of a single barcode (e.g. a detector output); orientation is estimated automatically
- Straightens the crop, averages bands of pixels into clean 1D profiles, reads each profile with ZBar and ZXing and accepts a value only when at least `minVotes` profiles agree (default 3). Stops early once a value has 3× `minVotes` and leads every other value by 3×; the vote count at that point is returned as the result quality
- Band height is automatic (12% of the bar height, 8-48 px). Advanced: `options.stripWidth` in the flow JSON overrides it in px (not exposed in the editor)
- Gray plus each color channel are tried, so chromatic aberration on one channel is harmless
- No preprocessing step and 1D formats only; slower, so use it as a fallback block

### Rosepetal SDK (`rosepetal`)
- Rosepetal's own barcode engine ([`rosepetal-barcode-sdk`](https://github.com/rosepetal-ai/rosepetal-barcode-sdk) 0.2.0, Go):
  one `rp-barcode serve` process per Node-RED runtime, started by the first decode and shared by every barcode-reader
  node through [`@rosepetal/barcode-engine-client`](https://github.com/rosepetal-ai/rosepetal-barcode-sdk/tree/dev/clients/node);
  pixels travel as raw frames over stdio (no JSON/Base64) and decoding runs off the event loop
- Reads the nine 1D symbologies above; QR, DataMatrix, PDF417, Aztec and DataBar are **not** read: keep a ZBar/ZXing
  block for them (a block whose Formats hold only 2D codes returns `[]` without calling the engine)
- Requires the engine package or `RP_BARCODE_ENGINE` (see Installation); otherwise the block warns once per node and
  outage and returns `[]`, every other block keeps working
- Preprocessing (`original`/`histogram`/`otsu`) runs in the addon as for the other decoders; the engine receives the
  8-bit gray result

| Option | Values | Default | Effect |
|---|---|---|---|
| `formats` | canonical list of the node | all | `symbologies` of the engine; unknown or 2D names are ignored, a list with nothing the SDK reads skips the engine and returns `[]` |
| `effort` | `robust` \| `normal` | `robust` | `robust` = denser scans, rows and columns, inverted image (parity with the always-on `tryHarder` of the ZXing blocks); `normal` for the fast lane |
| `directions` | `both` \| `horizontal` \| `vertical` | `both` | scan rows and/or columns; takes effect only with `effort: normal` (`robust` always scans both) |
| `tryInvert` | boolean | `true` | retry on the inverted image when nothing is found; takes effect only with `effort: normal` (`robust` always tries it) |
| `addOn` | `ignore` \| `read` \| `require` | `ignore` | EAN-2/EAN-5 add-ons; `read` returns them as separate `EAN-2`/`EAN-5` symbols after their main symbol; `require` drops EAN/UPC symbols without one |
| `upcaAsEan13` | boolean | `false` | UPC-A as a 13-digit `EAN-13` with a leading 0 (what templates saved with barcode-reader 1.1.3 contain) |
| `code39FullAscii` | boolean | `false` | expand Code 39 full-ASCII shift pairs (what a ZXing block does by default) |
| `checksum` | boolean | `false` | require and verify the optional check character (Code 39, ITF, Codabar) |
| `quietZone` | `tolerant` \| `spec` | `tolerant` | quiet-zone policy |
| `minLines` | integer >= 0 | `0` | scan lines that must agree (0 = per-symbology default) |
| `timeoutMs` | integer in [1, 2147483647] | `5000` | per-image deadline of the request; on timeout the block warns `engine timeout after N ms` and returns `[]`, the engine keeps running. It does not cover the engine's cold start (up to 5 s more on the first decode) |
| `tryHarder` | (legacy) | — | ignored (`robust` covers it) |

A value outside the vocabulary (e.g. `effort: "fast"`, `timeoutMs: 0`) fails that block with a warning naming the option
and returns `[]`; the other blocks run. Numbers must be numbers in the flow JSON (the editor converts what you type).

What changes against a ZBar/ZXing block (the `msg` contract is the same, fields are only added; details in the SDK's
[`docs/compat/barcode-reader.md`](https://github.com/rosepetal-ai/rosepetal-barcode-sdk/blob/dev/docs/compat/barcode-reader.md) §5):

| Topic | ZBar / ZXing blocks | `rosepetal` block |
|---|---|---|
| `format` spelling | ZBar `CODE-128`, `I2/5`; ZXing `Code128`, `ITF` | ZXing's spelling (`EAN-13`, `UPC-A`, `Code128`, `Code39`, `Code93`, `Codabar`, `ITF`); add-ons `EAN-2`/`EAN-5` |
| UPC-A | 1.1.3: 13-digit EAN-13; 1.2.x+: 12 digits | 12 digits; `upcaAsEan13` for old templates |
| UPC-E | ZXing: the 8 digits; ZBar: the 12-digit UPC-A expansion | the 8 digits (number system 0 only in SDK 0.2.0) |
| Code 39 | ZXing expands full-ASCII pairs and reports a valid check digit | pairs verbatim; `code39FullAscii` / `checksum` opt in |
| GS1-128 | ZXing gives the HRI `(01)…(10)…`; ZBar fails on the GS byte | `value` with the FNC1 separators as `\u001d` and no leading FNC1, no HRI |
| Add-ons | dropped (ZXing) or separate symbols (ZBar) | dropped unless `addOn: read` |
| Geometry (1D) | the scan line (degenerate quad, `angle` ±90 for a horizontal code) | the bar extent, corners TL, TR, BR, BL; `angle` 0 for a horizontal code, ±90 for a vertical one; `orientation` 0/90/180/270 tells 0 from 180 |
| `detectedBy` | one `"<decoder>_<preprocessing>"` entry per block that read the value | the same (`rosepetal_original`), so a Rosepetal-only flow gives length 1: confidence lives in `lines` / `confidence`, not in the number of blocks |
| 2D codes | read | not read (keep a ZBar/ZXing block) |

Behaviour worth knowing before switching a flow:

- **Mixed flows change two values** (never a flow without a `rosepetal` block). Two different values at the same place
  are one symbol for the spatial deduplication: the value more blocks agree on wins, else the lowest block's. With a
  `rosepetal` block next to ZBar + ZXing, a UPC-E comes out as its 8 digits (`UPC-E "01234565"`: ZXing and the SDK
  agree and outvote ZBar's `UPC-A "012345000065"`, so a template matching the 12 digits stops matching), and a GS1-128
  keeps the form of the lowest block that read it (ZXing's `(10)…` or the SDK's `\u001d` form; the other read is dropped,
  there are never two entries). Check the `matchString` of print-inspection templates for those two symbologies.
- **Which block provides the base result.** When several blocks read the same value, the geometry and the extra fields
  (`symbology`, `identifier`, `orientation`, `lines`, `confidence`, `checksum`) come from the lowest block: put the
  `rosepetal` block first to get `orientation`, `lines` and the exact corners in the output.
- **One engine per runtime.** The engine process is the client module's singleton, so it is shared as long as npm
  installs one copy of `@rosepetal/barcode-engine-client` (it does when every package that needs it declares a
  compatible range, `^0.2.0`); two nested copies would mean two processes. The process starts on the first decode,
  stops when the last node with a `rosepetal` block closes (a redeploy included) and the engine version is logged once
  per node at its first use (`Rosepetal engine 0.2.0+<commit> (protocol 1, pid N)`).
- **After a crash.** A running engine that dies is restarted 1 s later by the next request (a binary that fails to
  start is retried with a growing wait, up to 30 s). The crop in flight fails with `engine exited`, and every crop of
  the same message (an array input) that falls inside that 1 s wait gets `[]` with one warning per node; the first
  message after the wait is read by the new process. Whatever the engine writes to stderr appears in the Node-RED
  log as `[rp-barcode] …` warnings.
- **Timing.** Through the node a 600×300 crop costs about 11-12 ms with `robust` on the development host (20 crops of
  one message, decoded one at a time: 220-245 ms); the first decode after a (re)deploy also pays the engine start. A
  crop with no code pays the full scan, so use `normal` in an inspection lane when the crops are clean, and put a fast
  `rosepetal` block before the slow ones in Sequential mode.

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
    detectedBy: [                          // All successful detections: one "<decoder>_<preprocessing>" string per block
      "zbar_original",
      "zxing_histogram"
    ]
    // Only when the base result came from a rosepetal block (absent otherwise):
    // symbology: "EAN13", identifier: "]E0", orientation: 0, lines: 37, confidence: 1, checksum: "valid"
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
  4. ZXing + Histogram
  5. ZXing + Otsu
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
  4. ZXing + Otsu           (last resort)
```

Stops at first successful detection for faster processing.

### QR Code Focus

```
Blocks:
  1. ZBar + Original
  2. ZXing + Histogram
```

### 1D Barcode Focus

```
Blocks:
  1. ZBar + Original
  2. Quagga2 + Histogram
  3. ZXing + Otsu
```

### Noisy / Low-resolution 1D Crops

```
Execution Mode: sequential
Blocks:
  1. ZBar + Original            (fast path)
  2. Rosepetal Projection       (only runs when block 1 finds nothing)
```

Feed the node a crop containing one barcode. Restrict Formats to the symbology you expect to keep the vote clean.

### Rosepetal SDK First (1D print inspection)

```
Execution Mode: parallel
Blocks:
  1. Rosepetal SDK + Original     (effort robust; base result: bar extent, orientation, lines)
  2. ZXing + Original             (2D codes, cross-check of 1D values)
```

Put the `rosepetal` block first so its geometry and extra fields are the ones printed. For a fast lane on clean crops,
`effort: normal` with the expected Formats only; keep ZBar/ZXing blocks for QR, DataMatrix, PDF417, Aztec and DataBar.

## Programmatic API

For use outside Node-RED (the C++ addon only; the Rosepetal SDK engine is driven through
[`@rosepetal/barcode-engine-client`](https://github.com/rosepetal-ai/rosepetal-barcode-sdk/tree/dev/clients/node), see its README):

```javascript
const barcode = require('@rosepetal/node-red-contrib-barcode-reader');

// Preprocessing (returns grayscale cv::Mat as Rosepetal bitmap)
const gray = barcode.preprocess_original(inputMat);
const enhanced = barcode.preprocess_histogram(inputMat);
const binary = barcode.preprocess_otsu(inputMat);

// Decoders (require grayscale input, return JSON string)
const zbarResult = barcode.decode_zbar(gray);
const zxingResult = barcode.decode_zxing(gray);

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
- If no prebuilt binary is available for your platform, install system deps and run `cd barcode-engine && npm run rebuild`

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
cd /path/to/node-red-contrib-barcode-reader/barcode-engine
npm run rebuild
```

**No barcodes detected**
- Try different preprocessing methods
- Add a ZXing block alongside ZBar (different decoders catch different cases)
- For noisy or low-resolution 1D crops, add a Rosepetal Projection block as a fallback
- Check image quality and barcode size
- Ensure barcode is not too small (< 50px) or too large

**`rosepetal` block returns `[]` with "Rosepetal engine not available"**
- The engine package is missing (no access to the private registry at install time), `RP_BARCODE_ENGINE` points at
  something that is not executable, or the binary speaks another protocol (too old or too new for this node version).
  Check `~/.node-red/node_modules/@rosepetal/barcode-engine-linux-x64/bin/rp-barcode version` (prints
  `rp-barcode 0.2.0 (schema 1.0, GS1 Syntax Dictionary …, build <rev>)`), reinstall as described under Installation
  and redeploy. The warning is printed once per node and outage; every other block keeps working.

**`rosepetal` block times out or reports "engine exited"**
- Raise **Timeout** (`timeoutMs`) for very large images or switch **Effort** to `normal`. After a crash the block
  returns `[]` for 1 s (the crops of the same message inside that wait included) and the next message is read by the
  new process; the engine's own messages appear as `[rp-barcode] …` warnings in the Node-RED log.

**Values changed after adding a `rosepetal` block**
- UPC-E (8 digits instead of ZBar's 12-digit expansion) and GS1-128 (`\u001d` separators instead of ZXing's HRI, or the
  other way round, depending on block order) are expected: see *Rosepetal SDK*, "Mixed flows change two values".
  A downstream filter on `detectedBy.length >= 2` drops every read of a Rosepetal-only flow: use `lines` /
  `confidence` instead.

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

(all nine are read by every decoder; `rosepetal` reads 1D only)

### 2D Barcodes
- QR Code
- Data Matrix
- PDF417
- Aztec

## Development

- `npm install` needs **Node >= 22.9** (the `node-red` 5.0.7 dev dependency requires it; the runtime floor of the
  package stays >= 18), then `npm test` (`node --test test/*.test.js`): mapping, editor, node and regression tests on
  the client's fake engine and the prebuilt addon; `test/e2e.test.js` runs only with `RP_BARCODE_ENGINE=/path/to/rp-barcode`
  (a real `rp-barcode serve`, SDK >= 0.2.0) and skips otherwise. Until `@rosepetal/barcode-engine-client` is on npmjs,
  install it from a checkout of the SDK on top of the lockfile:
  `TGZ=$(npm pack --silent --pack-destination /tmp /path/to/rosepetal-barcode-sdk/clients/node) && npm install --no-save "/tmp/$TGZ"`.
- Regression contract: `test/golden/reader-1.3.0.json` is what 1.3.0 printed for every fixture with a
  `zbar + zxing + rp-projection` flow; a difference is a contract change (fix the code, never the golden). Fixtures in
  `test/fixtures/` are rendered by `scripts/make-fixtures.js` with the SDK's `rp-barcode synth`.
- CI: `.github/workflows/test.yml` (push to `main` and pull requests: the tests, the real binary when the `GCP_SA_KEY`
  secret exists, and a `workflow_dispatch` clean-container install check of a published version) and
  `.github/workflows/build-prebuild.yml` (tag `v*`: addon packages and this package on npmjs).
- Releases: `CHANGELOG.md` (the 1.4.0 entry states the release order: client on npmjs, lock regenerated, then the tag);
  `docs/validation-aisvision2.md` is the runbook of the on-machine validation of the `rosepetal` decoder.

## License

Apache-2.0

Copyright (c) Rosepetal SL - https://www.rosepetal.ai

## Third-Party License Compliance

This project uses ZBar (LGPL-2.1), ZXing-cpp (Apache-2.0), OpenCV (Apache-2.0), and Quagga2 (MIT) via npm. The
Rosepetal SDK engine (`rosepetal-barcode-sdk`, Apache-2.0) ships in its own packages with their `LICENSE` and `NOTICE`
(GS1 Barcode Syntax Dictionary attribution).
Prebuilt binaries statically link OpenCV/ZBar/ZXing for portability. Source builds link against system libraries; if you need to replace ZBar to exercise LGPL rights, build from source.
Third-party license texts are included in `THIRD_PARTY_NOTICES`.

## Credits

This project uses the following open-source libraries:

- [ZBar](http://zbar.sourceforge.net) - Barcode scanning library
- [ZXing-cpp](https://github.com/zxing-cpp/zxing-cpp) - C++ port of ZXing
- [OpenCV](https://opencv.org) - Computer vision library
- [Quagga2](https://github.com/ericblade/quagga2) - JavaScript barcode scanner
- [Node-API](https://nodejs.org/api/n-api.html) - Node.js native addon API
- [rosepetal-barcode-sdk](https://github.com/rosepetal-ai/rosepetal-barcode-sdk) - Rosepetal's barcode engine (`rosepetal` decoder)

## Author

**Rosepetal SL**
https://www.rosepetal.ai
