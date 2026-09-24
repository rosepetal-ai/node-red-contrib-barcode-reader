'use strict';
/**
 * The barcode-reader node with a `rosepetal` block on the fake engine (node-red-node-test-helper): tasks 2B-T4 (the
 * engine's life with the node, close, crash) and 2B-T6 (dedup with zbar, engine absent, bad raw, bad option, 2D-only
 * Formats, crash inside an array, sequential) of rosepetal-barcode-sdk docs/plans/fase2/02-subfase-2B.md (contract:
 * 00-overview.md §4; the 1.3.0 blocks are held byte for byte by regression.test.js). Skipped when the prebuilt addon
 * does not load (applyPreprocessing needs it). Every test leaves no child behind (the `after` hook proves it).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('node-red-node-test-helper');
const rp = require('../node-red-contrib-barcode-reader/lib/rp-mapping');
const { loadRaw, fixture, addonAvailable, procGone, liveChildren, readerFlow, runFlow } = require('./support');

process.env.RP_BARCODE_ENGINE = rp.FAKE_ENGINE;            // every start of the shared engine in this file spawns the client's fake
rp.setEngineOptions({ helloTimeoutMs: 3000, backoff: { initialMs: 50, maxMs: 200 }, drainMs: 500, exitMs: 300 });
helper.init(require.resolve('node-red'));
const barcodeNode = require('../node-red-contrib-barcode-reader/barcode.js');

const ROSEPETAL = { decoder: 'rosepetal', preprocessing: 'original', options: {} };
const ZBAR = { decoder: 'zbar', preprocessing: 'original', options: { formats: [] } };
const EAN13 = fixture('ean13.png');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

async function withFlow(t, blocks, props, fn) {
    if (!addonAvailable()) {
        t.skip('native addon not available (no prebuilt for this platform): node-level tests need applyPreprocessing');
        return;
    }
    await helper.load(barcodeNode, readerFlow(blocks, props));
    try {
        await fn(helper.getNode('n1'));
    } finally {
        await helper.unload();
    }
}

// The WARN lines the runtime log received during the current helper.load (RED.log.warn goes through log.log)
function runtimeWarnings() {
    const spy = helper.log();
    return spy.getCalls().map((c) => c.args[0]).filter((e) => e && e.level === spy.WARN).map((e) => e.msg);
}

test('a rosepetal block reads a fixture through the engine: msg contract + six new fields, detectedBy rosepetal_<preprocessing>', { timeout: 20000 }, async (t) => {
    await withFlow(t, [ROSEPETAL], {}, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.equal(msg.payload.length, 1);
        const s = msg.payload[0];
        assert.deepEqual(Object.keys(s), ['format', 'value', 'box', 'corners', 'detectedBy', 'symbology', 'identifier', 'orientation', 'lines', 'confidence', 'checksum']);
        assert.equal(s.format, 'EAN-13');
        assert.equal(s.value, '4006381333931');
        assert.deepEqual(s.detectedBy, ['rosepetal_original']);
        assert.equal(s.symbology, 'EAN13');
        assert.equal(s.identifier, ']E0');
        assert.equal(s.orientation, 0);
        assert.equal(s.lines, 40);                                     // the fake's canned symbol (index.json says 60)
        assert.equal(s.confidence, 1);
        assert.equal(s.checksum, 'valid');
        const W = EAN13.width, H = EAN13.height;                       // 347 × 68: the fake answers the ean13 geometry
        assert.deepEqual(s.corners, [{ x: 37 / W, y: 4 / H }, { x: 322 / W, y: 4 / H }, { x: 322 / W, y: 64 / H }, { x: 37 / W, y: 64 / H }]);
        assert.ok(Object.is(s.box.angle, 0));
        assert.deepEqual(s.box.center, { x: (37 + 322) / 2 / W, y: (4 + 64) / 2 / H });
        assert.deepEqual(s.box.size, { width: 285 / W, height: 60 / H });
        assert.equal(typeof msg.performance.reader.milliseconds, 'number');
        assert.equal(n1.warn.callCount, 0);
        assert.equal(n1.log.callCount, 1);
        assert.match(n1.log.firstCall.args[0], /^Rosepetal engine 0\.2\.0\+fake \(protocol 1, pid \d+\)$/);
        await runFlow(helper, loadRaw('ean13.png'));
        assert.equal(n1.log.callCount, 1);                             // the engine is logged once per node
        // M12: the child's stderr ("fake-engine: hello sent (pid N)") reaches RED.log.warn with the prefix
        for (const t0 = Date.now(); !runtimeWarnings().some((m) => /^\[rp-barcode\] /.test(m)) && Date.now() - t0 < 1000;) await sleep(10);
        const forwarded = runtimeWarnings().filter((m) => /^\[rp-barcode\] /.test(m));
        assert.deepEqual(forwarded, [`[rp-barcode] fake-engine: hello sent (pid ${rp.getEngine().pid})`]);
    });
});

test('acquire/release: the engine lives while a rosepetal node exists, stops on close, a reloaded node gets a new pid', { timeout: 20000 }, async (t) => {
    if (!addonAvailable()) return t.skip('native addon not available');
    const engine = rp.getEngine();
    await helper.load(barcodeNode, readerFlow([ROSEPETAL]));
    let pid1;
    try {
        assert.equal(engine.refs, 1);
        assert.equal(engine.child, null);                              // lazy: nothing started before the first decode
        await runFlow(helper, loadRaw('ean13.png'));
        assert.ok(engine.running);
        pid1 = engine.pid;
    } finally {
        await helper.unload();                                         // close → release() → stop()
    }
    assert.equal(engine.refs, 0);
    assert.equal(engine.child, null);
    assert.ok(procGone(pid1));
    await helper.load(barcodeNode, readerFlow([ROSEPETAL]));
    try {
        await runFlow(helper, loadRaw('ean13.png'));
        assert.ok(engine.running);
        assert.notEqual(engine.pid, pid1);
    } finally {
        await helper.unload();
    }
    assert.equal(engine.refs, 0);
    assert.equal(engine.child, null);
});

test('a node without rosepetal blocks never touches the engine, and its zbar output has exactly the 1.3.0 keys', { timeout: 20000 }, async (t) => {
    await withFlow(t, [ZBAR], {}, async () => {
        const engine = rp.getEngine();
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.equal(engine.refs, 0);
        assert.equal(engine.child, null);
        assert.equal(msg.payload.length, 1);
        assert.deepEqual(Object.keys(msg.payload[0]), ['format', 'value', 'box', 'corners', 'detectedBy']);
        assert.deepEqual(msg.payload[0].detectedBy, ['zbar_original']);
    });
});

test('engine stderr: one RED.log.warn per line with the [rp-barcode] prefix, chunks re-joined, hooked once per process (M12)', { timeout: 20000 }, async (t) => {
    await withFlow(t, [ROSEPETAL], {}, async () => {
        const engine = rp.getEngine();
        assert.equal(engine.listenerCount('stderr'), 1);
        assert.equal(engine.child, null);                                // no child: the events below are synthetic
        engine.emit('stderr', 'first line\nsec');
        engine.emit('stderr', 'ond line\n\n  \n');
        engine.emit('stderr', 'tail without newline');
        assert.deepEqual(runtimeWarnings().filter((m) => /^\[rp-barcode\]/.test(m)), ['[rp-barcode] first line', '[rp-barcode] second line']);
        engine.emit('exit', { code: 0, signal: null });                  // the process went away: the partial line is flushed
        assert.deepEqual(runtimeWarnings().filter((m) => /^\[rp-barcode\]/.test(m)),
            ['[rp-barcode] first line', '[rp-barcode] second line', '[rp-barcode] tail without newline']);
    });
    // Two reader nodes with rosepetal blocks in one flow, another load: two refs, still one hook
    if (!addonAvailable()) return;
    await helper.load(barcodeNode, [...readerFlow([ROSEPETAL, ROSEPETAL]),
        { id: 'n2', type: 'barcode-reader', name: 'reader2', inputValue: 'payload', outputValue: 'payload', executionMode: 'parallel', blocks: [ROSEPETAL], wires: [] }]);
    try {
        assert.equal(rp.getEngine().refs, 2);
        assert.equal(rp.getEngine().listenerCount('stderr'), 1);
    } finally {
        await helper.unload();
    }
    assert.equal(rp.getEngine().refs, 0);
});

test('close while a decode is in flight: the node closes, no unhandled rejection, no child left', { timeout: 20000 }, async (t) => {
    if (!addonAvailable()) return t.skip('native addon not available');
    process.env.FAKE_DELAY_MS = '400';
    const before = unhandled.length;
    try {
        await helper.load(barcodeNode, readerFlow([{ ...ROSEPETAL, options: { timeoutMs: 300 } }]));
        const engine = rp.getEngine();
        helper.getNode('n1').receive({ payload: loadRaw('ean13.png') });
        for (const t0 = Date.now(); engine.pending.size === 0 && Date.now() - t0 < 3000;) await sleep(10);   // child start + hello + preprocessing: not bounded by 50 ms on a 2-vCPU runner
        assert.equal(engine.pending.size, 1);
        const pid = engine.pid;
        await helper.unload();                                         // drain waits ≤ drainMs (500): the 300 ms client timeout settles the request first
        await sleep(100);
        assert.equal(engine.child, null);
        assert.equal(engine.pending.size, 0);
        assert.ok(procGone(pid));
        assert.equal(unhandled.length, before, unhandled.map((e) => e && e.stack).join('\n'));
    } finally {
        delete process.env.FAKE_DELAY_MS;
    }
});

test('close with an array of crops in flight: the closed node never restarts the engine (refs 0, no child, no orphan); its skipped crops give [] with a debug line, never a warn', { timeout: 20000 }, async (t) => {
    if (!addonAvailable()) return t.skip('native addon not available');
    process.env.FAKE_DELAY_MS = '150';
    const before = unhandled.length;
    try {
        await helper.load(barcodeNode, readerFlow([ROSEPETAL]));
        const engine = rp.getEngine();
        const n1 = helper.getNode('n1');
        const warns = [], debugs = [];
        n1.warn = (msg) => warns.push(msg);                            // own properties: survive the helper's spy restore on unload
        n1.debug = (msg) => debugs.push(msg);
        n1.receive({ payload: Array.from({ length: 5 }, () => loadRaw('ean13.png')) });
        for (const t0 = Date.now(); engine.pending.size === 0 && Date.now() - t0 < 3000;) await sleep(10);
        assert.equal(engine.pending.size, 1);
        const pid = engine.pid;
        await helper.unload();                                         // the first crop lands within the drain; four crops are still to come
        // Node-RED does not cancel the input handler: the old node runs the four remaining crops, each skipped with a debug line
        for (const t0 = Date.now(); debugs.length < 4 && Date.now() - t0 < 3000;) await sleep(10);
        assert.deepEqual(debugs, Array(4).fill('Block 0 (rosepetal) skipped: the node closed while this message was in flight'));
        assert.deepEqual(warns, []);                                   // the crop in flight landed inside the drain; the skipped ones never warn
        assert.equal(engine.refs, 0);
        assert.equal(engine.child, null);                              // nobody restarted the engine
        assert.ok(procGone(pid));
        assert.deepEqual(liveChildren(), []);
        assert.equal(unhandled.length, before, unhandled.map((e) => e && e.stack).join('\n'));
    } finally {
        delete process.env.FAKE_DELAY_MS;
    }
});

test('close while a decode outlives the drain: stop() rejects it, the block fails inside the old node, no unhandled rejection', { timeout: 20000 }, async (t) => {
    if (!addonAvailable()) return t.skip('native addon not available');
    process.env.FAKE_DELAY_MS = '2000';
    const before = unhandled.length;
    try {
        await helper.load(barcodeNode, readerFlow([{ ...ROSEPETAL, options: { timeoutMs: 5000 } }]));
        const engine = rp.getEngine();
        const n1 = helper.getNode('n1');
        const warns = [];
        n1.warn = (msg) => warns.push(msg);                            // own property: survives the helper's spy restore on unload
        n1.receive({ payload: loadRaw('ean13.png') });
        for (const t0 = Date.now(); engine.pending.size === 0 && Date.now() - t0 < 3000;) await sleep(10);
        assert.equal(engine.pending.size, 1);
        const pid = engine.pid;
        const t0 = Date.now();
        await helper.unload();                                         // drain expires (500 ms), shutdown: the fake exits without answering
        const took = Date.now() - t0;
        assert.ok(took >= 450 && took < 2000, `unload took ${took} ms`);
        await sleep(100);
        assert.equal(engine.child, null);
        assert.equal(engine.pending.size, 0);
        assert.ok(procGone(pid));
        assert.equal(warns.length, 1, warns.join('\n'));
        assert.match(warns[0], /^Block 0 \(rosepetal\) failed: engine (exited \(code 0\)|stopped)$/);
        assert.equal(unhandled.length, before, unhandled.map((e) => e && e.stack).join('\n'));
    } finally {
        delete process.env.FAKE_DELAY_MS;
    }
});

test('engine crash: the in-flight block fails with exited; inside the wait one warn per node says it restarts, without the install hint', { timeout: 20000 }, async (t) => {
    process.env.FAKE_CRASH_AFTER = '0';                                 // exits with status 7 on the first decode, no answer
    rp.setEngineOptions({ backoff: { initialMs: 5000, maxMs: 5000 } });   // the wait outlasts the test: deterministic
    try {
        await withFlow(t, [ROSEPETAL], {}, async (n1) => {
            const first = await runFlow(helper, loadRaw('ean13.png'));
            assert.deepEqual(first.payload, []);
            assert.equal(n1.warn.callCount, 1);
            assert.equal(n1.warn.firstCall.args[0], 'Block 0 (rosepetal) failed: engine exited (code 7)');
            const second = await runFlow(helper, loadRaw('ean13.png'));
            assert.deepEqual(second.payload, []);
            assert.equal(n1.warn.callCount, 2);
            assert.match(n1.warn.secondCall.args[0], /^Rosepetal engine not available: engine unavailable, retry in \d+ ms \(engine exited \(code 7\)\)\. It is restarted by a later request$/);
            assert.doesNotMatch(n1.warn.secondCall.args[0], /Install/);
            await runFlow(helper, loadRaw('ean13.png'));
            assert.equal(n1.warn.callCount, 2);                          // once per outage
            assert.equal(rp.getEngine().child, null);
        });
    } finally {
        delete process.env.FAKE_CRASH_AFTER;
        rp.setEngineOptions({ backoff: { initialMs: 50, maxMs: 200 } });   // configure() also resets the wait
    }
});

// ---- 2B-T6: dedup with zbar, engine absent, bad raw, bad option, 2D-only Formats, crash inside an array, sequential ----

test('rosepetal + zbar on the same value: one symbol, detectedBy of both, geometry and extra fields of the lowest block', { timeout: 20000 }, async (t) => {
    let zbarOnly;
    await withFlow(t, [ZBAR], {}, async () => {
        zbarOnly = (await runFlow(helper, loadRaw('ean13.png'))).payload[0];
    });
    await withFlow(t, [ZBAR, ROSEPETAL], {}, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.equal(msg.payload.length, 1);
        const s = msg.payload[0];
        assert.equal(s.value, '4006381333931');
        assert.equal(s.format, 'EAN-13');
        assert.deepEqual(s.detectedBy, ['zbar_original', 'rosepetal_original']);
        assert.deepEqual(Object.keys(s), ['format', 'value', 'box', 'corners', 'detectedBy']);   // zbar (block 0) is the base: no SDK fields
        assert.deepEqual({ box: s.box, corners: s.corners }, { box: zbarOnly.box, corners: zbarOnly.corners });   // and its geometry
        assert.equal(n1.warn.callCount, 0);
    });
    await withFlow(t, [ROSEPETAL, ZBAR], {}, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.equal(msg.payload.length, 1);
        const s = msg.payload[0];
        assert.deepEqual(s.detectedBy, ['rosepetal_original', 'zbar_original']);
        assert.equal(s.symbology, 'EAN13');                              // rosepetal (block 0) is the base: SDK fields and geometry
        assert.equal(s.lines, 40);
        assert.equal(s.checksum, 'valid');
        assert.equal(s.corners[0].x, 37 / EAN13.width);
        assert.ok(Object.is(s.box.angle, 0));
        assert.equal(n1.warn.callCount, 0);
    });
});

test('engine absent: one warn per node with the install hint, rosepetal gives [], the zbar block is intact', { timeout: 20000 }, async (t) => {
    if (!addonAvailable()) return t.skip('native addon not available');
    process.env.RP_BARCODE_ENGINE = '/nonexistent/rp-barcode';
    const hint = /^Rosepetal engine not available: RP_BARCODE_ENGINE \/nonexistent\/rp-barcode: not found\. Install @rosepetal\/barcode-engine-linux-x64 or -linux-arm64 /;
    // The wait after a failed start is per process, the warn per node: a node that asks inside it names the same failure
    // through the wait ("engine unavailable, retry in N ms (...)"), still with the install hint (the engine never ran)
    const hintInWait = /^Rosepetal engine not available: (engine unavailable, retry in \d+ ms \()?RP_BARCODE_ENGINE \/nonexistent\/rp-barcode: not found\)?\. Install @rosepetal\/barcode-engine-linux-x64 or -linux-arm64 /;
    try {
        // n1 (zbar + rosepetal) drives the assertions; n2 (rosepetal only, wired to h2) proves the warn is per node, not
        // per process. The helper spies Node.prototype once per load, shared by every node: own-property collectors count per node
        await helper.load(barcodeNode, [...readerFlow([ZBAR, ROSEPETAL]),
            { id: 'n2', type: 'barcode-reader', name: 'reader2', inputValue: 'payload', outputValue: 'payload', executionMode: 'parallel', blocks: [ROSEPETAL], wires: [['h2']] },
            { id: 'h2', type: 'helper' }]);
        const engine = rp.getEngine();
        const n1 = helper.getNode('n1');
        const n2 = helper.getNode('n2');
        const h2 = helper.getNode('h2');
        const warns1 = [], warns2 = [];
        n1.warn = (msg) => warns1.push(msg);
        n2.warn = (msg) => warns2.push(msg);
        try {
            const first = await runFlow(helper, loadRaw('ean13.png'));
            assert.equal(first.payload.length, 1);
            assert.deepEqual(first.payload[0].detectedBy, ['zbar_original']);
            assert.equal(warns1.length, 1, warns1.join('\n'));
            assert.match(warns1[0], hint);
            const second = await runFlow(helper, loadRaw('ean13.png'));
            assert.deepEqual(second.payload[0].detectedBy, ['zbar_original']);
            assert.equal(warns1.length, 1);                              // once per node, not per message
            assert.equal(n1.error.callCount, 0);
            assert.equal(n1.log.callCount, 0);                           // no engine: no version line (the spy is per load: n2 neither)
            assert.equal(engine.child, null);
            assert.equal(engine.lastError.code, 'unavailable');
            const out2 = await new Promise((resolve, reject) => {       // n2's message completes before the unload: nothing left in flight
                const timer = setTimeout(() => reject(new Error('n2: no output after 3000 ms')), 3000);
                h2.once('input', (msg) => { clearTimeout(timer); resolve(msg); });
                n2.receive({ payload: loadRaw('ean13.png') });
            });
            assert.deepEqual(out2.payload, []);
            assert.equal(warns2.length, 1, warns2.join('\n'));
            assert.match(warns2[0], hintInWait);
            assert.equal(warns1.length, 1);
        } finally {
            await helper.unload();
        }
        assert.equal(engine.refs, 0);
        assert.equal(engine.child, null);
    } finally {
        process.env.RP_BARCODE_ENGINE = rp.FAKE_ENGINE;
        rp.getEngine().resetBackoff();
    }
});

test('raw bitmap whose data does not match width×height: the block warns and gives [], the message still flows, the engine is not touched', { timeout: 20000 }, async (t) => {
    await withFlow(t, [ROSEPETAL], {}, async (n1) => {
        const msg = await runFlow(helper, { data: Buffer.alloc(10), width: 347, height: 68, colorSpace: 'GRAY', dtype: 'uint8' });
        assert.deepEqual(msg.payload, []);
        assert.equal(typeof msg.performance.reader.milliseconds, 'number');
        assert.equal(n1.warn.callCount, 1, n1.warn.getCalls().map((c) => c.args[0]).join('\n'));
        assert.match(n1.warn.firstCall.args[0], /^Block 0 \(rosepetal\) failed: Data length mismatch/);   // applyPreprocessing, before the engine (R-NR-13 a)
        assert.equal(n1.error.callCount, 0);
        assert.equal(rp.getEngine().child, null);
    });
});

test('an option outside the vocabulary fails that block only; formats with 2D only skip the engine; legacy tryHarder is accepted', { timeout: 20000 }, async (t) => {
    await withFlow(t, [ZBAR, { ...ROSEPETAL, options: { effort: 'fast' } }], {}, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.equal(msg.payload.length, 1);
        assert.deepEqual(msg.payload[0].detectedBy, ['zbar_original']);
        assert.equal(n1.warn.callCount, 1);
        assert.equal(n1.warn.firstCall.args[0], 'Block 1 (rosepetal) failed: rosepetal option effort: "fast" is not robust|normal');
        assert.equal(n1.error.callCount, 0);
        assert.equal(rp.getEngine().child, null);                        // the option is checked before any call
    });
    await withFlow(t, [{ ...ROSEPETAL, options: { minLines: -1 } }, ZBAR], {}, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.deepEqual(msg.payload[0].detectedBy, ['zbar_original']);
        assert.equal(n1.warn.callCount, 1);
        assert.equal(n1.warn.firstCall.args[0], 'Block 0 (rosepetal) failed: rosepetal option minLines: -1 is not an integer >= 0');
    });
    await withFlow(t, [{ ...ROSEPETAL, options: { formats: ['QRCode', 'DataMatrix'] } }], {}, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.deepEqual(msg.payload, []);
        assert.equal(n1.warn.callCount, 0);
        assert.equal(rp.getEngine().refs, 1);                            // the node holds the engine...
        assert.equal(rp.getEngine().child, null);                        // ...and never started it
    });
    await withFlow(t, [{ ...ROSEPETAL, options: { tryHarder: true, formats: [] } }], {}, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.equal(msg.payload.length, 1);
        assert.equal(msg.payload[0].symbology, 'EAN13');
        assert.equal(n1.warn.callCount, 0);
    });
});

test('engine crash in the middle of an array of 20 crops: length and order kept, the crop in flight warns, the rest wait, the next message uses a new engine', { timeout: 30000 }, async (t) => {
    process.env.FAKE_CRASH_AFTER = '5';                                 // the fake answers five decodes and exits with status 7 on the sixth
    rp.setEngineOptions({ backoff: { initialMs: 5000, maxMs: 5000 } });   // the wait outlasts the array: no respawn (and no second crash) inside one msg
    try {
        await withFlow(t, [ROSEPETAL], {}, async (n1) => {
            const engine = rp.getEngine();
            let pid1 = null;
            engine.once('started', ({ pid }) => { pid1 = pid; });      // read before the crash: afterwards engine.pid is null
            const msg = await runFlow(helper, Array.from({ length: 20 }, () => loadRaw('ean13.png')));
            assert.ok(pid1 !== null, 'the engine started for the array');
            assert.equal(msg.payload.length, 20);
            assert.ok(msg.payload.every((r) => Array.isArray(r)));
            assert.deepEqual(msg.payload.map((r) => r.length), [...Array(5).fill(1), ...Array(15).fill(0)]);   // 0-4 read, 5 in flight, 6-19 inside the wait
            for (let i = 0; i < 5; i++) assert.equal(msg.payload[i][0].value, '4006381333931', `crop ${i}`);
            const warns = n1.warn.getCalls().map((c) => c.args[0]);
            assert.equal(warns.length, 2, warns.join('\n'));
            assert.equal(warns[0], 'Block 0 (rosepetal) failed: engine exited (code 7)');
            assert.match(warns[1], /^Rosepetal engine not available: engine unavailable, retry in \d+ ms \(engine exited \(code 7\)\)\. It is restarted by a later request$/);
            assert.equal(n1.error.callCount, 0);
            assert.equal(engine.child, null);
            assert.ok(procGone(pid1));
            // The wait elapses: the next message relaunches the engine (another pid) and reads
            engine.resetBackoff();
            const next = await runFlow(helper, loadRaw('ean13.png'));
            assert.equal(next.payload.length, 1);
            assert.equal(next.payload[0].value, '4006381333931');
            assert.ok(engine.running);
            assert.notEqual(engine.pid, pid1);
            assert.equal(n1.warn.callCount, 2);                          // nothing new to say
        });
    } finally {
        delete process.env.FAKE_CRASH_AFTER;
        rp.setEngineOptions({ backoff: { initialMs: 50, maxMs: 200 } });   // configure() also resets the wait
    }
});

test('sequential mode stops at the first block that reads: rosepetal first leaves zbar out, zbar first never starts the engine, an absent engine falls through to zbar', { timeout: 20000 }, async (t) => {
    await withFlow(t, [ROSEPETAL, ZBAR], { executionMode: 'sequential' }, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.equal(msg.payload.length, 1);
        assert.deepEqual(msg.payload[0].detectedBy, ['rosepetal_original']);
        assert.equal(msg.payload[0].symbology, 'EAN13');
        assert.equal(n1.warn.callCount, 0);
    });
    await withFlow(t, [ZBAR, ROSEPETAL], { executionMode: 'sequential' }, async (n1) => {
        const msg = await runFlow(helper, loadRaw('ean13.png'));
        assert.deepEqual(msg.payload[0].detectedBy, ['zbar_original']);
        assert.equal(n1.warn.callCount, 0);
        assert.equal(rp.getEngine().child, null);                        // zbar read first: the rosepetal block never ran
    });
    process.env.RP_BARCODE_ENGINE = '/nonexistent/rp-barcode';
    try {
        await withFlow(t, [ROSEPETAL, ZBAR], { executionMode: 'sequential' }, async (n1) => {
            const msg = await runFlow(helper, loadRaw('ean13.png'));
            assert.deepEqual(msg.payload[0].detectedBy, ['zbar_original']);
            assert.equal(n1.warn.callCount, 1);                          // the install hint, once; zbar reads
            assert.match(n1.warn.firstCall.args[0], /^Rosepetal engine not available: /);
        });
    } finally {
        process.env.RP_BARCODE_ENGINE = rp.FAKE_ENGINE;
        rp.getEngine().resetBackoff();
    }
});

after(async () => {
    await sleep(50);                                                    // let the last 'close' events land
    const engine = rp.getEngine();
    // Record the evidence first, then clean up whatever a failed test left behind, and only then assert on it
    const leakedChild = engine.child !== null ? engine.pid : null;
    const refs = engine.refs;
    const pending = engine.pending.size;
    const children = liveChildren();
    await engine.stop().catch(() => {});
    for (const pid of liveChildren()) {
        try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone meanwhile */ }
    }
    assert.equal(leakedChild, null, 'the shared engine still had a child after the tests');
    assert.equal(refs, 0, 'nodes still holding the shared engine after the tests');
    assert.equal(pending, 0, 'requests still pending after the tests');
    assert.deepEqual(children, [], 'child processes still alive after the tests');
    assert.deepEqual(unhandled, [], 'unhandled rejections during the tests');
});
