#!/usr/bin/env node
'use strict';
/**
 * Captures test/golden/reader-1.3.0.json: what a zbar + zxing + rp-projection flow (the 1.3.0 behaviour) prints for
 * every fixture. Run it ONLY while barcode.js is identical to main (4eaf856); regression.test.js then holds the new
 * code to these bytes. Needs the prebuilt addon.  Usage: node test/tools/capture-golden.js [--force]
 * Never matched by `npm test` (`test/*.test.js`).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const helper = require('node-red-node-test-helper');
const { INDEX, loadRaw, readerFlow, runFlow } = require('../support');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'golden', 'reader-1.3.0.json');
const BLOCKS = [
    { decoder: 'zbar', preprocessing: 'original', options: { formats: [] } },
    { decoder: 'zxing', preprocessing: 'original', options: { formats: [] } },
    { decoder: 'rp-projection', preprocessing: 'original', options: { formats: [], minVotes: 3 } }
];

async function main() {
    const diff = execSync('git diff --stat main -- node-red-contrib-barcode-reader/barcode.js', { cwd: ROOT, encoding: 'utf8' }).trim();
    if (diff && !process.argv.includes('--force')) {
        throw new Error(`barcode.js differs from main; capture the golden on the unmodified code:\n${diff}`);
    }
    helper.init(require.resolve('node-red'));
    const barcodeNode = require('../../node-red-contrib-barcode-reader/barcode.js');
    await helper.load(barcodeNode, readerFlow(BLOCKS));
    const results = {};
    try {
        for (const f of INDEX.fixtures) {
            results[f.file] = (await runFlow(helper, loadRaw(f.file))).payload;
        }
    } finally {
        await helper.unload();
    }
    const golden = {
        behaviour: '1.3.0 (main 4eaf856)',
        capturedAt: new Date().toISOString(),
        addon: fs.readdirSync(path.join(ROOT, 'node_modules', '@rosepetal')).join(', '),
        flow: { executionMode: 'parallel', blocks: BLOCKS },
        results
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(golden, null, 2) + '\n');
    console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(results).length} fixtures`);
}

main().then(() => process.exit(0), (err) => {
    console.error(err.stack || err.message);
    process.exit(1);
});
