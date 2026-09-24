'use strict';
/**
 * The barcode-reader node with a `rosepetal` block on the fake engine (node-red-node-test-helper): first part, task
 * 2B-T4 of rosepetal-barcode-sdk docs/plans/fase2/02-subfase-2B.md (contract: 00-overview.md §4). T6 adds the rest.
 * Skipped when the prebuilt addon does not load (applyPreprocessing needs it). Every test leaves no child behind.
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

test('close with an array of crops in flight: the closed node never restarts the engine (refs 0, no child, no orphan)', { timeout: 20000 }, async (t) => {
    if (!addonAvailable()) return t.skip('native addon not available');
    process.env.FAKE_DELAY_MS = '150';
    const before = unhandled.length;
    try {
        await helper.load(barcodeNode, readerFlow([ROSEPETAL]));
        const engine = rp.getEngine();
        helper.getNode('n1').receive({ payload: Array.from({ length: 5 }, () => loadRaw('ean13.png')) });
        for (const t0 = Date.now(); engine.pending.size === 0 && Date.now() - t0 < 3000;) await sleep(10);
        assert.equal(engine.pending.size, 1);
        const pid = engine.pid;
        await helper.unload();                                         // the first crop lands within the drain; four crops are still to come
        await sleep(500);                                              // Node-RED does not cancel the input handler: the old node runs them
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
