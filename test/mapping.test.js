'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rp = require('../node-red-contrib-barcode-reader/lib/rp-engine');
const { INDEX, fixture } = require('./support');

// convertToFinalFormat (barcode.js) reorders the raw points [p2, p3, p4, p1] and getRotation takes
// angle = -atan((x2 - x1) / (y2 - y1)) in degrees: replicated here, the contract the mapping targets
const cornersOf = (p) => [[p.x2, p.y2], [p.x3, p.y3], [p.x4, p.y4], [p.x1, p.y1]];
const angleOf = (p) => -Math.atan((p.x2 - p.x1) / (p.y2 - p.y1)) * 180 / Math.PI;

test('symbolToRaw: format spelling per fixture (ZXing names, ZBar names for the add-ons, identifier before symbology)', () => {
    assert.equal(INDEX.fixtures.length, 14);
    for (const f of INDEX.fixtures) {
        assert.equal(f.symbols.length, f.formats.length, f.file);
        f.symbols.forEach((symbol, i) => {
            assert.equal(rp.symbolToRaw(symbol).type, f.formats[i], `${f.file} symbol ${i}`);
        });
    }
    assert.deepEqual(rp.FORMAT_NAMES, { EAN13: 'EAN-13', EAN8: 'EAN-8', UPCA: 'UPC-A', UPCE: 'UPC-E', Code128: 'Code128', Code39: 'Code39', Code93: 'Code93', Codabar: 'Codabar', ITF: 'ITF' });
    assert.deepEqual(rp.ADDON_NAMES, { ']E1': 'EAN-2', ']E2': 'EAN-5' });
    assert.equal(rp.formatName({ symbology: 'EAN13', identifier: ']E1' }), 'EAN-2');
    assert.equal(rp.formatName({ symbology: 'UPCA', identifier: ']E2' }), 'EAN-5');
    assert.equal(rp.formatName({ symbology: 'Code128', identifier: ']C1' }), 'Code128');
    assert.equal(rp.formatName({ symbology: 'Future', identifier: ']X0' }), 'Future');   // unknown: the SDK name as is
});

test('symbolToRaw: points come out TL, TR, BR, BL after the [p2, p3, p4, p1] reorder; angle 0 horizontal, -90 at 90°', () => {
    const flat = fixture('ean13.png').symbols[0];
    const raw = rp.symbolToRaw(flat);
    assert.deepEqual(cornersOf(raw.points), flat.corners.map((c) => [c.x, c.y]));
    assert.deepEqual(cornersOf(raw.points), [[37, 4], [322, 4], [322, 64], [37, 64]]);
    assert.ok(Object.is(angleOf(raw.points), 0));                       // not -0: JSON prints 0
    const rot = fixture('ean13-rot90.png').symbols[0];
    assert.equal(rot.orientation, 90);
    const rawRot = rp.symbolToRaw(rot);
    assert.deepEqual(cornersOf(rawRot.points), [[64, 37], [64, 322], [4, 322], [4, 37]]);
    assert.equal(angleOf(rawRot.points), -90);                          // compat/barcode-reader.md §4
    for (const f of INDEX.fixtures) {
        for (const s of f.symbols) assert.deepEqual(cornersOf(rp.symbolToRaw(s).points), s.corners.map((c) => [c.x, c.y]), f.file);
    }
});

test('symbolToRaw: data, quality = lines, the six new fields copied; GS1 separator intact; add-on EAN-5', () => {
    const gs1 = fixture('gs1-128.png').symbols[0];
    const raw = rp.symbolToRaw(gs1);
    assert.equal(raw.data, '10ABC\u001d21XYZ');
    assert.equal(raw.data.charCodeAt(5), 0x1d);
    assert.equal(raw.type, 'Code128');
    assert.equal(raw.identifier, ']C1');
    assert.equal(raw.quality, gs1.lines);
    assert.ok(gs1.lines > 0);
    assert.deepEqual(
        { symbology: raw.symbology, identifier: raw.identifier, orientation: raw.orientation, lines: raw.lines, confidence: raw.confidence, checksum: raw.checksum },
        { symbology: 'Code128', identifier: ']C1', orientation: 0, lines: gs1.lines, confidence: gs1.confidence, checksum: 'valid' });
    assert.deepEqual(Object.keys(raw).sort(), ['checksum', 'confidence', 'data', 'identifier', 'lines', 'orientation', 'points', 'quality', 'symbology', 'type']);
    const [main, addon] = fixture('upca-addon5.png').symbols.map(rp.symbolToRaw);
    assert.equal(main.type, 'UPC-A');
    assert.equal(main.data, '012345678905');
    assert.equal(addon.type, 'EAN-5');
    assert.equal(addon.data, '12345');
    assert.equal(addon.symbology, 'UPCA');                              // the add-on carries its main's symbology
    assert.equal(addon.identifier, ']E2');
    assert.ok(addon.points.x2 > main.points.x3);                        // it sits to the right of the main symbol
});

test('optionsFromBlock: defaults of §4.1 (robust, both directions, invert, ignore add-ons, tolerant quiet zone, 5000 ms)', () => {
    assert.deepEqual(rp.optionsFromBlock({ decoder: 'rosepetal', preprocessing: 'original', options: {} }), {
        skip: false, timeoutMs: 5000,
        decodeOptions: { symbologies: [], effort: 'robust', horizontal: true, vertical: true, tryInvert: true, addOn: 'ignore',
            upcaAsEan13: false, code39FullAscii: false, optionalChecksum: false, quietZone: 'tolerant', minLines: 0 }
    });
    assert.equal(rp.optionsFromBlock({ decoder: 'rosepetal' }).skip, false);             // no options at all
    assert.equal(rp.optionsFromBlock({ options: { tryHarder: true } }).skip, false);    // legacy key ignored
    assert.equal(rp.optionsFromBlock({ options: { formats: [] } }).skip, false);        // [] = every symbology
    assert.equal(rp.DEFAULT_TIMEOUT_MS, 5000);
});

test('optionsFromBlock: every option of the table, and skip when Formats holds nothing the SDK reads', () => {
    const { decodeOptions, skip, timeoutMs } = rp.optionsFromBlock({ options: {
        formats: ['EAN13', 'QRCode', 'Code128'], effort: 'normal', directions: 'vertical', tryInvert: false, addOn: 'read',
        upcaAsEan13: true, code39FullAscii: true, checksum: true, quietZone: 'spec', minLines: 3, timeoutMs: 800 } });
    assert.equal(skip, false);
    assert.equal(timeoutMs, 800);
    assert.deepEqual(decodeOptions, { symbologies: ['EAN13', 'Code128'], effort: 'normal', horizontal: false, vertical: true, tryInvert: false,
        addOn: 'read', upcaAsEan13: true, code39FullAscii: true, optionalChecksum: true, quietZone: 'spec', minLines: 3 });
    assert.deepEqual(rp.optionsFromBlock({ options: { directions: 'horizontal' } }).decodeOptions.vertical, false);
    assert.deepEqual(rp.optionsFromBlock({ options: { directions: 'horizontal' } }).decodeOptions.horizontal, true);
    assert.deepEqual(rp.optionsFromBlock({ options: { formats: ['QRCode', 'DataMatrix'] } }), { decodeOptions: null, skip: true, timeoutMs: 5000 });
    assert.deepEqual(rp.optionsFromBlock({ options: { formats: ['QRCode'], timeoutMs: 250 } }), { decodeOptions: null, skip: true, timeoutMs: 250 });
    assert.deepEqual(rp.SDK_SYMBOLOGIES, ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'Code93', 'Codabar', 'ITF']);
    // The whole canonical list of the node, 1D and 2D: only what the SDK reads travels, in the node's order
    const all = ['QRCode', 'DataMatrix', 'UPCA', 'UPCE', 'EAN13', 'EAN8', 'Code128', 'Code39', 'Code93', 'Codabar', 'ITF', 'PDF417', 'Aztec', 'DataBar'];
    assert.deepEqual(rp.optionsFromBlock({ options: { formats: all } }).decodeOptions.symbologies,
        ['UPCA', 'UPCE', 'EAN13', 'EAN8', 'Code128', 'Code39', 'Code93', 'Codabar', 'ITF']);
});

test('optionsFromBlock: a value outside the vocabulary throws a plain Error naming the option (the block fails, others run)', () => {
    const bad = [
        [{ effort: 'fast' }, /rosepetal option effort: "fast" is not robust\|normal/],
        [{ directions: 'diagonal' }, /option directions/],
        [{ addOn: 'yes' }, /option addOn/],
        [{ quietZone: 'strict' }, /option quietZone/],
        [{ tryInvert: 'true' }, /option tryInvert: "true" is not true\|false/],
        [{ upcaAsEan13: 1 }, /option upcaAsEan13/],
        [{ code39FullAscii: 'yes' }, /option code39FullAscii/],
        [{ checksum: 'on' }, /option checksum/],
        [{ minLines: -1 }, /option minLines: -1 is not an integer >= 0/],
        [{ minLines: 1.5 }, /option minLines/],
        [{ minLines: '3' }, /option minLines/],
        [{ timeoutMs: 0 }, /option timeoutMs: 0 is not an integer >= 1/],
        [{ timeoutMs: '5000' }, /option timeoutMs/]
    ];
    for (const [options, pattern] of bad) {
        assert.throws(() => rp.optionsFromBlock({ options }), (err) => !(err instanceof rp.EngineError) && pattern.test(err.message), JSON.stringify(options));
    }
    // A bad timeout fails the block even when the formats would have skipped the engine
    assert.throws(() => rp.optionsFromBlock({ options: { formats: ['QRCode'], timeoutMs: -5 } }), /option timeoutMs/);
});
