# Changelog

All notable changes to `@rosepetal/node-red-contrib-barcode-reader`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the npm versions (git tags `vX.Y.Z`).
Entries before 1.4.0 were reconstructed from `git log` and the docs when this file was created.

## [1.4.0] - unreleased

### Added
- Decoder `rosepetal`: the Rosepetal barcode SDK ([`rosepetal-barcode-sdk`](https://github.com/rosepetal-ai/rosepetal-barcode-sdk)
  0.2.0, Go) as a fifth decoder next to `zbar`, `zxing`, `quagga2` and `rp-projection`. The node talks to one
  `rp-barcode serve` child process per Node-RED runtime (protocol 1 over stdio, binary frames: no JSON or Base64 for the
  pixels), shared by every barcode-reader node and started by the first decode. 1D only: UPC-A, UPC-E, EAN-13, EAN-8,
  Code 128 (GS1-128), Code 39, Code 93, Codabar, ITF.
- Runtime dependency `@rosepetal/barcode-engine-client` (`^0.2.0`, the shared engine client of the SDK, published on
  npmjs by the SDK repository). The engine binary comes from that client's optional dependencies
  `@rosepetal/barcode-engine-linux-x64` / `-linux-arm64` (0.2.x, Rosepetal's private Artifact Registry): without access
  to that registry npm skips them with a warning, every other decoder works as before and a `rosepetal` block warns
  `Rosepetal engine not available` once per node and returns `[]`. `RP_BARCODE_ENGINE=/path/to/rp-barcode` overrides the
  lookup (package, then `rp-barcode` in `PATH`).
- Block options for `rosepetal` (editor rows and flow JSON `options`): `effort` (`robust` default, `normal`),
  `directions`, `tryInvert`, `addOn`, `upcaAsEan13`, `code39FullAscii`, `checksum`, `quietZone`, `minLines`,
  `timeoutMs` (5000, capped at 2^31 − 1). `directions` and `tryInvert` only take effect with `effort: normal`.
- New output fields, only on symbols whose base result came from a `rosepetal` block: `symbology`, `identifier`
  (ISO/IEC 15424), `orientation` (0/90/180/270), `lines`, `confidence`, `checksum`. Existing fields are unchanged;
  `corners` of those symbols are the real bar extent (TL, TR, BR, BL) and `box.angle` is 0 for a horizontal code.
- Tests (`npm test` = `node --test test/*.test.js`, Node ≥ 22.9 because of the `node-red` 5.0.7 dev dependency):
  symbol/option mapping, editor contract, node tests with `node-red-node-test-helper` on the client's fake engine
  (dedup, engine absent, bad raw, bad option, crash and timeout mid-array, sequential mode), byte-for-byte regression
  of a `zbar` + `zxing` + `rp-projection` flow against the 1.3.0 golden (`test/golden/reader-1.3.0.json`), and the
  end-to-end contract with the real binary when `RP_BARCODE_ENGINE` is set (`test/e2e.test.js`, skipped otherwise).
- CI workflow `.github/workflows/test.yml` (push to `main`, pull requests): fake-engine tests always, the real binary
  from the private registry when the `GCP_SA_KEY` secret exists, plus a `workflow_dispatch` clean-container install
  check of a published version (addon present, engine package absent, `resolveBinary()` reports it).
- `.npmignore`: tests, fixtures, golden, `artifacts/`, `.github/` and `scripts/make-fixtures.js` stay out of the
  package (`barcode-engine/` stays in: `lib/cpp-bridge.js` builds from it when no prebuilt addon loads).
- This changelog; `docs/validation-aisvision2.md`, the runbook of the on-machine validation of the new decoder.

### Changed
- `convertToFinalFormat` copies the six new fields only when the raw result carries them: the output of a `zbar`,
  `zxing`, `quagga2` or `rp-projection` block is byte for byte the 1.3.0 one (regression test).
- Adding a `rosepetal` block to a flow changes two values in **mixed** flows (never in a flow without one): a UPC-E is
  printed as its 8 digits (`UPC-E "01234565"`, as ZXing prints it; ZBar prints the 12-digit UPC-A expansion) when the
  ZXing and SDK votes win the spatial dedup, and a GS1-128 keeps the form of the lowest block that read it (ZXing's
  `(10)…` HRI or the SDK's `\u001d` separators). Details in the readme, *Rosepetal SDK*.
- `engines.node` is `>=18` in the root and inner manifests (was `>=14.0`); the runtime code uses no newer API.
- The inner manifest `node-red-contrib-barcode-reader/package.json` (the `INSTALL.sh` / build-from-source install path)
  declares the client dependency too.
- `package.json` `description` and `keywords` name the five decoders.

### Release order
The `v1.4.0` tag must wait for: (1) `@rosepetal/barcode-engine-client@0.2.x` on npmjs and the engine packages on the
private registry, both published by the SDK repository's release; (2) `package-lock.json` regenerated against the
published client (`npm install --package-lock-only --no-audit --no-fund`) and committed, so that `npm ci` works. A tag
before (1) would publish a 1.4.0 that nobody can install (E404 on the client, palette included).

## [1.3.0] - 2026-09-24

### Added
- Decoder `rp-projection` (C++ addon): for noisy or low-resolution 1D crops the other decoders miss (down to
  ~1.5 px per module). Straightens the crop, averages bands of pixels into 1D profiles, reads each with ZBar and
  ZXing and accepts a value when `minVotes` profiles agree (default 3); early exit at 3× the votes; automatic band
  height (`options.stripWidth` in the flow JSON overrides it). No preprocessing step; the `detectedBy` entry is
  `rp-projection` (commits `eb6ef2b`, `fc2270c`, `7dbbef2`; PR #1).
- Includes the unpublished 1.2.4 (`19389b3`, 2026-05-20): ghost-read tie-break fix in the spatial deduplication.
- CI: the publish job fails on real npm errors instead of swallowing them (`12f50a5`).

## [1.2.1] – [1.2.3] - 2026-04 / 2026-05

- 1.2.3 (2026-05-19): ZXing `tryHarder` always on (matches zxing.org defaults); portable statically linked addon
  (`9c48d2a`).
- 1.2.2 (2026-05-13): maintenance release, decoder and dedup fixes (`c5c7501`).
- 1.2.1 (2026-04-27): per-block **Formats** allowlist (filtered to what the selected decoder supports); UPC-A preferred
  over EAN-13 when both apply; addon calls on async workers (`8714703`).

Earlier tags: 1.1.2 (2025-12-30), 1.1.3 (2026-02-16, the version baked into the `rosepetal-dep-node-red` image at the
time of writing, pin `1.1.x`).

[1.4.0]: https://github.com/rosepetal-ai/node-red-contrib-barcode-reader/compare/v1.3.0...main
[1.3.0]: https://github.com/rosepetal-ai/node-red-contrib-barcode-reader/compare/v1.2.3...v1.3.0
