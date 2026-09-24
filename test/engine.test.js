'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const {
    Engine, EngineError, resolveBinary, getEngine, acquire, release, ENGINE_PACKAGES, PROTOCOL
} = require('../node-red-contrib-barcode-reader/lib/rp-engine');

const FAKE = path.join(__dirname, 'fake-engine.js');
const GRAY = { width: 347, height: 68, channels: 1, colorSpace: 'GRAY' };
const PIXELS = Buffer.alloc(347 * 68, 255);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every engine of this file, so the last hook can prove none left a child behind
const ENGINES = [];
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

// A fake engine with its knobs and short waits (production: hello 5 s, backoff 1 s → 30 s, drain 2 s, exit 1 s)
function fake(knobs = {}, options = {}) {
    const engine = new Engine({
        command: process.execPath, args: [FAKE, 'serve'],
        env: { ...process.env, ...knobs },
        helloTimeoutMs: 500, defaultTimeoutMs: 2000,
        backoff: { initialMs: 50, maxMs: 200 },
        drainMs: 500, exitMs: 300,
        ...options
    });
    ENGINES.push(engine);
    return engine;
}
async function rejects(promise, code, pattern) {
    try {
        await promise;
    } catch (err) {
        assert.ok(err instanceof EngineError, `not an EngineError: ${err && err.stack}`);
        assert.equal(err.code, code, err.message);
        if (pattern) assert.match(err.message, pattern);
        return err;
    }
    assert.fail(`expected EngineError ${code}`);
}
const procGone = (pid) => process.platform !== 'linux' || !fs.existsSync(`/proc/${pid}`);
// The engine's 'exit' event, or a failure after 3 s (the timer is cleared so it never outlives the test)
function exited(engine) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no exit event')), 3000);
        once(engine, 'exit').then((args) => { clearTimeout(timer); resolve(args[0]); });
    });
}
// Live (non-zombie) children of this process, from /proc (Linux); [] elsewhere
function liveChildren() {
    if (process.platform !== 'linux') return [];
    const out = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let stat;
        try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch (_) { continue; }
        const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(ppid) === process.pid && state !== 'Z') out.push(Number(name));
    }
    return out;
}
function withEnv(changes, fn) {
    const saved = {};
    for (const key of Object.keys(changes)) saved[key] = process.env[key];
    for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const restore = () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    };
    let result;
    try {
        result = fn();
    } catch (err) {
        restore();
        throw err;
    }
    return Promise.resolve(result).finally(restore);
}

test('hello, ping, stop: protocol 1, exit status 0, no child and no process exit listener left', async () => {
    const engine = fake();
    const started = [];
    const stderr = [];
    engine.on('started', (info) => started.push(info));
    engine.on('stderr', (text) => stderr.push(text));
    const hello = await engine.start();
    assert.equal(hello.op, 'hello');
    assert.equal(hello.protocol, PROTOCOL);
    assert.equal(engine.hello, hello);
    assert.ok(engine.running);
    assert.ok(engine.pid > 0);
    assert.equal(started.length, 1);
    assert.deepEqual(started[0], { pid: engine.pid, hello, source: 'command' });
    assert.deepEqual(await engine.ping(), { symbols: [], image: null, timing: null });
    const child = engine.child;
    const pid = engine.pid;
    await engine.stop();
    assert.equal(engine.child, null);
    assert.equal(engine.pid, null);
    assert.equal(engine.running, false);
    assert.equal(child.exitCode, 0);
    assert.ok(procGone(pid));
    assert.equal(process.listeners('exit').includes(engine._killOnExit), false);
    assert.match(stderr.join(''), /fake-engine: hello sent/);
    await engine.stop();                                         // idempotent: nothing to do
    assert.equal(engine.child, null);
});

test('start() while starting reuses the same process: never two children', async () => {
    const engine = fake();
    const started = [];
    engine.on('started', (info) => started.push(info.pid));
    const [h1, h2] = await Promise.all([engine.start(), engine.start()]);
    assert.equal(h1, h2);
    assert.equal(process.listeners('exit').filter((l) => l === engine._killOnExit).length, 1);
    await engine.stop();
    // Three decodes from cold share one start too
    const results = await Promise.all([1, 2, 3].map(() => engine.decode(GRAY, PIXELS, {})));
    assert.deepEqual(results.map((r) => r.symbols.length), [1, 1, 1]);
    assert.equal(started.length, 2);
    assert.notEqual(started[0], started[1]);
    await engine.stop();
});

test('decode round trip: raw gray header + payload, schema-1.0 symbols, image and timing back', async () => {
    const engine = fake();
    const res = await engine.decode(GRAY, PIXELS, { effort: 'robust', symbologies: [] }, { timeoutMs: 1000 });
    assert.equal(res.symbols.length, 1);
    assert.equal(res.symbols[0].value, '4006381333931');
    assert.equal(res.symbols[0].symbology, 'EAN13');
    assert.deepEqual(res.symbols[0].corners[0], { x: 37, y: 4 });
    assert.deepEqual(res.image, { width: 347, height: 68 });
    assert.equal(typeof res.timing.totalMs, 'number');
    assert.equal(engine.pending.size, 0);
    await engine.stop();
});

test('invalid_input from the server is an EngineError with its message; the engine keeps running', async () => {
    const engine = fake();
    await rejects(engine.decode(GRAY, Buffer.alloc(10), {}), 'invalid_input', /data length 10 does not match 347×68×1/);
    await rejects(engine.decode(GRAY, PIXELS, { bogus: true }), 'invalid_input', /unknown key "bogus"/);
    assert.ok(engine.running);
    await engine.ping();
    await engine.stop();
});

test('decode(): a payload over hello.limits.maxPayload is refused with invalid_input before it is sent', async () => {
    const engine = fake({ FAKE_MAX_PAYLOAD: '1000' });
    await engine.start();
    assert.equal(engine.hello.limits.maxPayload, 1000);
    // The fake would answer this one fine (347·68·1 bytes match): the rejection can only be the client's
    await rejects(engine.decode(GRAY, PIXELS, {}), 'invalid_input', /23596 bytes exceeds the engine limit of 1000 bytes/);
    assert.equal(engine.pending.size, 0);
    assert.ok(engine.running);
    await rejects(engine.decode(GRAY, 'not a buffer', {}), 'invalid_input', /Buffer or Uint8Array/);
    await engine.ping();
    await engine.stop();
});

test('timeout: the promise rejects after timeoutMs and the late reply is discarded by id', async () => {
    const engine = fake({ FAKE_DELAY_MS: '300' });
    await rejects(engine.decode(GRAY, PIXELS, {}, { timeoutMs: 50 }), 'timeout', /engine timeout after 50 ms/);
    assert.equal(engine.pending.size, 0);
    await sleep(400);                                            // the reply for the timed-out id lands now: nothing matches
    assert.ok(engine.running);
    assert.deepEqual((await engine.ping()).symbols, []);
    await engine.stop();
});

test('crash mid-flight: the request in flight fails, no restart inside the wait, restart with a new pid after it, backoff resets', async () => {
    const engine = fake({ FAKE_CRASH_AFTER: '1' });
    await engine.decode(GRAY, PIXELS, {});
    const pid1 = engine.pid;
    await rejects(engine.decode(GRAY, PIXELS, {}), 'exited', /engine exited \(code 7\)/);
    assert.equal(engine.child, null);
    assert.equal(engine.lastError.code, 'exited');
    await rejects(engine.decode(GRAY, PIXELS, {}), 'unavailable', /retry in \d+ ms/);
    assert.equal(engine.backoffMs, 100);                         // 50 used, next wait doubled
    await sleep(60);
    const res = await engine.decode(GRAY, PIXELS, {});
    assert.equal(res.symbols.length, 1);
    assert.notEqual(engine.pid, pid1);
    assert.equal(engine.backoffMs, 50);                          // a successful start resets the wait
    await engine.stop();
});

test('no hello: start fails with unavailable, the child is killed, the wait doubles up to maxMs and no second process starts inside it', async () => {
    const engine = fake({ FAKE_NO_HELLO: '1' }, { helloTimeoutMs: 100 });
    await rejects(engine.start(), 'unavailable', /no hello .* within 100 ms/);
    await exited(engine);
    assert.equal(engine.child, null);
    assert.equal(engine.backoffMs, 100);
    await rejects(engine.start(), 'unavailable', /retry in/);
    await sleep(60);
    await rejects(engine.start(), 'unavailable', /no hello/);
    await exited(engine);
    assert.equal(engine.backoffMs, 200);
    await sleep(110);
    await rejects(engine.start(), 'unavailable', /no hello/);
    await exited(engine);
    assert.equal(engine.backoffMs, 200);                         // capped at maxMs
    await engine.stop();                                         // nothing running: a no-op
    assert.equal(engine.child, null);
});

test('command that cannot run: unavailable at once, no child, no exit listener left, stop() is a no-op', async () => {
    const engine = fake({}, { command: '/nonexistent/rp-barcode', args: ['serve'] });
    await rejects(engine.start(), 'unavailable', /cannot run \/nonexistent\/rp-barcode: .*ENOENT/);
    for (let i = 0; i < 100 && engine.child !== null; i++) await sleep(5);
    assert.equal(engine.child, null);
    assert.equal(process.listeners('exit').includes(engine._killOnExit), false);
    await rejects(engine.decode(GRAY, PIXELS, {}), 'unavailable', /retry in/);
    await engine.stop();
});

test('client queue: requests beyond maxQueue are refused at once with overloaded', async () => {
    const engine = fake({ FAKE_DELAY_MS: '200' }, { maxQueue: 4 });
    await engine.start();
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => engine.decode(GRAY, PIXELS, {})));
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const refused = settled.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 4);
    assert.equal(refused.length, 2);
    for (const r of refused) assert.equal(r.reason.code, 'overloaded');
    await engine.stop();
});

test('server overloaded passes through as EngineError overloaded', async () => {
    const engine = fake({ FAKE_OVERLOAD: '1' });
    await rejects(engine.decode(GRAY, PIXELS, {}), 'overloaded', /queue full/);
    await engine.stop();
});

test('protocol mismatch: start fails with code protocol, the child is killed, the next call waits', async () => {
    const engine = fake({ FAKE_PROTOCOL: '2' });
    await rejects(engine.start(), 'protocol', /protocol 2, this node needs 1/);
    await exited(engine);
    assert.equal(engine.child, null);
    await rejects(engine.decode(GRAY, PIXELS, {}), 'unavailable', /retry in/);
});

test('garbage on stdout after hello is a crash: the engine stops, remembers a protocol error and waits before restarting', async () => {
    const engine = fake({ FAKE_GARBAGE: '1' });
    await engine.start();
    await exited(engine);
    assert.equal(engine.running, false);
    assert.equal(engine.lastError.code, 'protocol');
    assert.match(engine.lastError.message, /bad frame/);
    await rejects(engine.decode(GRAY, PIXELS, {}), 'unavailable', /retry in/);
});

test('a reply that carries a payload is a protocol violation: the request fails, the engine restarts after the wait', async () => {
    const engine = fake({ FAKE_REPLY_PAYLOAD: '1' });
    const pids = [];
    engine.on('started', (info) => pids.push(info.pid));
    // The request is rejected from the child's 'close' handler, so the child is already gone when the rejection lands
    await rejects(engine.decode(GRAY, PIXELS, {}), 'protocol', /bad frame: payload length 4 exceeds 0/);
    assert.equal(engine.child, null);
    assert.equal(engine.running, false);
    assert.equal(engine.lastError.code, 'protocol');
    await rejects(engine.decode(GRAY, PIXELS, {}), 'unavailable', /retry in/);
    await sleep(60);
    await rejects(engine.decode(GRAY, PIXELS, {}), 'protocol');   // a fresh process, the same violation
    assert.equal(engine.child, null);
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
});

test('stop(): waits for the request in flight (drain), then shutdown → exit 0', async () => {
    const engine = fake({ FAKE_DELAY_MS: '150' });
    const inflight = engine.decode(GRAY, PIXELS, {});
    await sleep(20);
    const child = engine.child;
    await engine.stop();
    assert.equal((await inflight).symbols.length, 1);
    assert.equal(child.exitCode, 0);
    assert.equal(engine.pending.size, 0);
});

test('stop(): the drain gives up after drainMs, the request in flight rejects with exited, nothing is left pending', async () => {
    const engine = fake({ FAKE_DELAY_MS: '5000' }, { drainMs: 200 });
    const outcome = engine.decode(GRAY, PIXELS, {}).then(() => null, (err) => err);
    await sleep(50);
    assert.equal(engine.pending.size, 1);
    const t0 = Date.now();
    await engine.stop();
    const err = await outcome;
    assert.ok(err instanceof EngineError, 'the in-flight request must reject');
    assert.equal(err.code, 'exited');
    assert.equal(engine.pending.size, 0);
    assert.equal(engine.child, null);
    assert.ok(Date.now() - t0 < 1000, `stop took ${Date.now() - t0} ms`);   // 200 ms drain + the fake's exit
});

test('stop(): an engine that ignores shutdown and SIGTERM ends with SIGKILL within 2·exitMs', async () => {
    const engine = fake({ FAKE_IGNORE_STOP: '1' }, { exitMs: 200 });
    await engine.start();
    const child = engine.child;
    const pid = engine.pid;
    const t0 = Date.now();
    await engine.stop();
    assert.equal(child.signalCode, 'SIGKILL');
    // Production defaults: drain 2 s + shutdown 1 s + SIGTERM 1 s = 4 s worst case; here 0 + 2·200 ms
    assert.ok(Date.now() - t0 < 1500, `stop took ${Date.now() - t0} ms`);
    assert.ok(procGone(pid));
    assert.equal(engine.running, false);
});

test('resolveBinary: RP_BARCODE_ENGINE is explicit (missing, not executable, ok) and the fake runs through it', async () => {
    const saved = process.env.RP_BARCODE_ENGINE;
    try {
        process.env.RP_BARCODE_ENGINE = '/nonexistent/rp-barcode';
        assert.throws(() => resolveBinary(), (err) => err instanceof EngineError && err.code === 'unavailable'
            && /RP_BARCODE_ENGINE \/nonexistent\/rp-barcode: not found/.test(err.message));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-engine-'));
        const plain = path.join(dir, 'rp-barcode');
        fs.writeFileSync(plain, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
        process.env.RP_BARCODE_ENGINE = plain;
        assert.throws(() => resolveBinary(), /not executable/);
        process.env.RP_BARCODE_ENGINE = dir;
        assert.throws(() => resolveBinary(), /not a file/);
        process.env.RP_BARCODE_ENGINE = FAKE;                    // #!/usr/bin/env node, mode 100755 in git
        assert.deepEqual(resolveBinary(), { path: FAKE, source: 'RP_BARCODE_ENGINE' });
        const engine = new Engine({ helloTimeoutMs: 3000, backoff: { initialMs: 50, maxMs: 100 } });   // resolves itself, spawns `<path> serve`
        ENGINES.push(engine);
        const started = [];
        engine.on('started', (info) => started.push(info));
        assert.equal((await engine.start()).protocol, 1);
        assert.equal(started[0].source, 'RP_BARCODE_ENGINE');
        await engine.stop();
    } finally {
        if (saved === undefined) delete process.env.RP_BARCODE_ENGINE; else process.env.RP_BARCODE_ENGINE = saved;
    }
});

test('resolveBinary: without RP_BARCODE_ENGINE, the platform package, then PATH, else unavailable listing what was tried', async () => {
    const pkg = ENGINE_PACKAGES[`${process.platform}-${process.arch}`];
    if (!pkg) return;                                            // no engine package for this platform: nothing to try
    const rootModules = path.join(__dirname, '..', 'node_modules');
    const pkgDir = path.join(rootModules, pkg);
    assert.ok(!fs.existsSync(pkgDir), `${pkg} is installed: this test needs it absent`);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-path-'));
    try {
        await withEnv({ RP_BARCODE_ENGINE: undefined, PATH: bin }, () => {
            assert.throws(() => resolveBinary(), (err) => err instanceof EngineError && err.code === 'unavailable'
                && err.message.includes(`${pkg} is not installed`) && err.message.includes('rp-barcode is not in PATH'));
            const onPath = path.join(bin, 'rp-barcode');
            fs.writeFileSync(onPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            assert.deepEqual(resolveBinary(), { path: onPath, source: 'PATH' });
            // The platform package wins over PATH once installed next to the node; a broken install says why
            fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: pkg, version: '0.2.0' }));
            assert.deepEqual(resolveBinary(), { path: onPath, source: 'PATH' });   // bin/rp-barcode missing → PATH
            const pkgBin = path.join(pkgDir, 'bin', 'rp-barcode');
            fs.writeFileSync(pkgBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            assert.deepEqual(resolveBinary(), { path: pkgBin, source: pkg });
            fs.rmSync(onPath);
            fs.chmodSync(pkgBin, 0o644);
            assert.throws(() => resolveBinary(), (err) => err.code === 'unavailable' && /not executable/.test(err.message));
        });
    } finally {
        fs.rmSync(pkgDir, { recursive: true, force: true });
        fs.rmSync(path.join(rootModules, '@rosepetal'), { recursive: true, force: true });
        fs.rmSync(bin, { recursive: true, force: true });
    }
});

test('singleton: acquire/release count nodes and stop the shared engine with the last one', async () => {
    const saved = process.env.RP_BARCODE_ENGINE;
    process.env.RP_BARCODE_ENGINE = FAKE;
    try {
        const shared = getEngine();
        ENGINES.push(shared);
        assert.equal(getEngine(), shared);
        assert.equal(acquire(), shared);
        acquire();
        assert.equal(shared.refs, 2);
        await shared.decode(GRAY, PIXELS, {});
        await release();
        assert.ok(shared.running);                               // one node still holds it
        await release();
        assert.equal(shared.refs, 0);
        assert.equal(shared.child, null);
        await release();                                         // never below zero
        assert.equal(shared.refs, 0);
        assert.equal(shared.child, null);
    } finally {
        if (saved === undefined) delete process.env.RP_BARCODE_ENGINE; else process.env.RP_BARCODE_ENGINE = saved;
    }
});

after(async () => {
    await sleep(50);                                             // let the last 'close' events land
    for (const engine of ENGINES) {
        assert.equal(engine.child, null, `engine left a child (pid ${engine.pid})`);
        assert.equal(engine.running, false);
        assert.equal(engine.pending.size, 0);
    }
    assert.equal(process.listeners('exit').filter((l) => ENGINES.some((e) => e._killOnExit === l)).length, 0);
    assert.deepEqual(liveChildren(), [], 'child processes still alive after the tests');
    assert.deepEqual(unhandled, [], 'unhandled rejections during the tests');
});
