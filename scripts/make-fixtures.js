#!/usr/bin/env node
'use strict';
/**
 * Renders test/fixtures/*.png with `rp-barcode synth` and writes test/fixtures/index.json with what
 * `rp-barcode decode --json --robust` reads back (schema 1.0 symbols, image pixels). Reproducible:
 *   RP_BARCODE=/path/to/rp-barcode node scripts/make-fixtures.js
 * Every render goes through `synth --spec` (YAML: symbology, payload, xPx, heightPx, rotation, encode{…}), the
 * one form that reaches the rotation, add-on, full-ASCII and GS1 knobs. Never matched by `npm test`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PNG } = require('pngjs');

const BIN = process.env.RP_BARCODE || 'rp-barcode';
const OUT = path.join(__dirname, '..', 'test', 'fixtures');
const X_PX = 3;
const HEIGHT_PX = 60;
const MAX_TOTAL_BYTES = 300 * 1024;

// file: the PNG; spec: what synth renders; flags: extra `decode` flags; decodeOptions: the rosepetal block options a
// node test needs to read it; formats: the `format` the node must print, one per symbol in order
const FIXTURES = [
    { file: 'ean13.png',   spec: { symbology: 'EAN13',   payload: '4006381333931' },  formats: ['EAN-13'] },
    { file: 'ean8.png',    spec: { symbology: 'EAN8',    payload: '96385074' },       formats: ['EAN-8'] },
    { file: 'upca.png',    spec: { symbology: 'UPCA',    payload: '012345678905' },   formats: ['UPC-A'] },
    { file: 'upce.png',    spec: { symbology: 'UPCE',    payload: '01234565' },       formats: ['UPC-E'] },
    { file: 'code128.png', spec: { symbology: 'Code128', payload: 'RO216221291TH' },  formats: ['Code128'] },
    { file: 'code39.png',  spec: { symbology: 'Code39',  payload: 'ABC-123' },        formats: ['Code39'] },
    { file: 'code93.png',  spec: { symbology: 'Code93',  payload: 'ABC-123' },        formats: ['Code93'] },
    { file: 'codabar.png', spec: { symbology: 'Codabar', payload: 'A12345B' },        formats: ['Codabar'] },
    { file: 'itf.png',     spec: { symbology: 'ITF',     payload: '04006381333931' }, formats: ['ITF'] },
    { file: 'ean13-rot90.png', spec: { symbology: 'EAN13', payload: '4006381333931', rotation: 90 }, formats: ['EAN-13'] },
    { file: 'upca-addon5.png', spec: { symbology: 'UPCA', payload: '012345678905', encode: { addOn: '12345' } },
      flags: ['--addon', 'read'], decodeOptions: { addOn: 'read' }, formats: ['UPC-A', 'EAN-5'] },
    { file: 'code39-fullascii.png', spec: { symbology: 'Code39', payload: 'ab/c', encode: { fullASCII: true } },
      flags: ['--code39-full-ascii'], decodeOptions: { code39FullAscii: true }, formats: ['Code39'] },
    { file: 'gs1-128.png', spec: { symbology: 'Code128', payload: '10ABC\u001d21XYZ', encode: { gs1: true } }, formats: ['Code128'] },
    { file: 'blank.png', blank: { width: 200, height: 100 }, formats: [] }
];

// The YAML of one spec; JSON.stringify gives a valid double-quoted YAML scalar (GS 0x1D travels as \u001d)
function toYaml(spec) {
    const lines = [`symbology: ${spec.symbology}`, `payload: ${JSON.stringify(spec.payload)}`, `xPx: ${X_PX}`, `heightPx: ${HEIGHT_PX}`];
    if (spec.rotation) lines.push(`rotation: ${spec.rotation}`);
    if (spec.encode) {
        lines.push('encode:');
        for (const [key, value] of Object.entries(spec.encode)) lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
    return lines.join('\n') + '\n';
}

function blankPng(width, height) {
    const png = new PNG({ width, height });
    png.data.fill(255);                               // white, opaque
    return PNG.sync.write(png, { colorType: 0 });     // 8-bit gray
}

function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-fixtures-'));
    const engine = execFileSync(BIN, ['version'], { encoding: 'utf8' }).trim();
    const fixtures = [];
    let total = 0;
    try {
        for (const f of FIXTURES) {
            const target = path.join(OUT, f.file);
            if (f.blank) {
                fs.writeFileSync(target, blankPng(f.blank.width, f.blank.height));
            } else {
                const dir = path.join(tmp, path.basename(f.file, '.png'));
                const specFile = `${dir}.yaml`;
                fs.writeFileSync(specFile, toYaml(f.spec));
                execFileSync(BIN, ['synth', '--out', dir, '--spec', specFile], { stdio: 'pipe' });
                fs.copyFileSync(path.join(dir, 'img', '000000.png'), target);
            }
            const png = PNG.sync.read(fs.readFileSync(target));
            const symbols = JSON.parse(execFileSync(BIN, ['decode', target, '--json', '--robust', ...(f.flags || [])], { encoding: 'utf8' }));
            if (symbols.length !== f.formats.length) throw new Error(`${f.file}: ${symbols.length} symbols, expected ${f.formats.length}`);
            total += fs.statSync(target).size;
            fixtures.push({
                file: f.file, width: png.width, height: png.height,
                payload: f.blank ? null : f.spec.payload, symbology: f.blank ? null : f.spec.symbology,
                decodeOptions: f.decodeOptions || {}, formats: f.formats, symbols
            });
            console.log(`${f.file}: ${png.width}×${png.height}, ${symbols.length} symbol(s)`);
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (total > MAX_TOTAL_BYTES) throw new Error(`fixtures weigh ${total} bytes, over ${MAX_TOTAL_BYTES}`);
    const index = {
        generatedWith: { engine, command: 'RP_BARCODE=<rp-barcode> node scripts/make-fixtures.js', effort: 'robust', xPx: X_PX, heightPx: HEIGHT_PX },
        fixtures
    };
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
    console.log(`index.json: ${fixtures.length} fixtures, ${total} bytes of PNG`);
}

main();
