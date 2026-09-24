'use strict';
/**
 * The regression gate of 2B (task 2B-T6 of rosepetal-barcode-sdk docs/plans/fase2/02-subfase-2B.md): a zbar + zxing +
 * rp-projection flow, the 1.3.0 behaviour, prints on every fixture byte for byte what test/golden/reader-1.3.0.json
 * holds (captured by test/tools/capture-golden.js on the unmodified 1.3.0 barcode.js, main 4eaf856). A difference is
 * a contract change (overview §1, R-NR-23): fix barcode.js, never the golden. Runs only when the prebuilt addon loads;
 * the flow has no rosepetal block, so the shared engine is never touched and no child is spawned.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helper = require('node-red-node-test-helper');
const rp = require('../node-red-contrib-barcode-reader/lib/rp-mapping');
const { INDEX, loadRaw, addonAvailable, readerFlow, runFlow } = require('./support');

const GOLDEN = path.join(__dirname, 'golden', 'reader-1.3.0.json');

test('a zbar + zxing + rp-projection flow prints byte for byte what 1.3.0 printed on every fixture', { timeout: 120000 }, async (t) => {
    if (!addonAvailable()) return t.skip('native addon not available (no prebuilt for this platform)');
    if (!fs.existsSync(GOLDEN)) return t.skip('no golden: node test/tools/capture-golden.js on the unmodified 1.3.0 code');
    const text = fs.readFileSync(GOLDEN, 'utf8');
    const golden = JSON.parse(text);
    assert.equal(golden.behaviour, '1.3.0 (main 4eaf856)');
    assert.deepEqual(Object.keys(golden.results).sort(), INDEX.fixtures.map((f) => f.file).sort());
    helper.init(require.resolve('node-red'));
    const barcodeNode = require('../node-red-contrib-barcode-reader/barcode.js');
    await helper.load(barcodeNode, readerFlow(golden.flow.blocks, { executionMode: golden.flow.executionMode }));
    const results = {};
    try {
        for (const f of INDEX.fixtures) {
            const msg = await runFlow(helper, loadRaw(f.file), { timeoutMs: 30000 });
            results[f.file] = msg.payload;
            assert.equal(JSON.stringify(msg.payload), JSON.stringify(golden.results[f.file]), f.file);
        }
        assert.equal(helper.getNode('n1').error.callCount, 0);
    } finally {
        await helper.unload();
    }
    // The whole document, serialized as capture-golden.js writes it, with the file's own provenance (capturedAt,
    // addon) carried over: the results differ in nothing, not a key order, not a number's spelling
    assert.equal(JSON.stringify({ ...golden, results }, null, 2) + '\n', text);
    assert.equal(rp.getEngine().refs, 0);
    assert.equal(rp.getEngine().child, null);
});
