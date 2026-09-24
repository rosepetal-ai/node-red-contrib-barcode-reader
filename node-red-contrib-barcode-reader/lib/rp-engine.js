'use strict';
/**
 * Client of `rp-barcode serve` (rosepetal-barcode-sdk, protocol 1): one persistent child process per Node-RED
 * process, framed requests over stdio (./rp-framing), a timeout per request, a bounded queue, restart with a
 * growing wait, and a clean stop. Spec: rosepetal-barcode-sdk/docs/plans/fase2/00-overview.md §3, §4.3, §5.2.
 * The second half translates for the node: a schema-1.0 symbol → the raw result barcode.js already consumes
 * (symbolToRaw, overview §4.2) and a `rosepetal` block's options → decodeOptions (optionsFromBlock, §4.1).
 *
 * Errors are EngineError with a `code`: `unavailable` (no binary, no hello, cannot run, or inside the wait after a
 * failure), `protocol` (hello with another protocol, a bad frame, a reply with a payload), `exited` (the process
 * went away with the request in flight), `timeout` (the client's timer), `overloaded` (the client queue is full,
 * or the engine has not taken the bytes already written to its stdin: `maxBufferedBytes`), plus the server's own
 * codes verbatim (`invalid_input`, `unsupported`, `overloaded`, `deadline`, `internal`).
 *
 * Events: 'started' ({pid, hello, source}), 'exit' ({code, signal}), 'stderr' (text). Never 'error'.
 */
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { encodeFrame, FrameParser } = require('./rp-framing');

const PROTOCOL = 1;
const EMPTY = Buffer.alloc(0);

// Platform packages that carry the static binary at bin/rp-barcode (musl uses the same one: no linuxmusl variant)
const ENGINE_PACKAGES = {
    'linux-x64': '@rosepetal/barcode-engine-linux-x64',
    'linux-arm64': '@rosepetal/barcode-engine-linux-arm64'
};
const INSTALL_HINT = 'Install @rosepetal/barcode-engine-linux-x64 or -linux-arm64 (0.2.x, Rosepetal private npm ' +
    'registry) next to this node, or set RP_BARCODE_ENGINE to the path of an rp-barcode binary (SDK >= 0.2.0)';
const DEFAULT_TIMEOUT_MS = 5000;

class EngineError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'EngineError';
        this.code = code;
    }
}

function platformId() {
    return `${process.platform}-${process.arch}`;
}

// null when `file` is an executable regular file, otherwise the reason
function executableProblem(file) {
    let st;
    try {
        st = fs.statSync(file);
    } catch (err) {
        return `${file}: ${err.code === 'ENOENT' ? 'not found' : err.message}`;
    }
    if (!st.isFile()) return `${file}: not a file`;
    try {
        fs.accessSync(file, fs.constants.X_OK);
    } catch (_) {
        return `${file}: not executable`;
    }
    return null;
}

// The binary of the platform package, looked up along `paths` (this module's node_modules chain by default, the order
// require uses) without require.resolve: the file is not JavaScript, the package may restrict its `exports`, and
// require caches its lookups for the life of the process.
function packageBinary(pkg, paths) {
    for (const dir of paths) {
        if (fs.existsSync(path.join(dir, pkg, 'package.json'))) return path.join(dir, pkg, 'bin', 'rp-barcode');
    }
    return null;
}

/**
 * Where the engine binary is: RP_BARCODE_ENGINE (explicit: when set and unusable this fails, it never falls
 * back), then the platform package's bin/rp-barcode, then rp-barcode in PATH. The binary runs as `<path> serve`.
 *
 * @param {{paths?: string[]}} [options] node_modules directories searched for the platform package (default: this
 *   module's chain, as require would); the tests point it at a temporary directory
 * @returns {{path: string, source: string}} source: 'RP_BARCODE_ENGINE' | the package name | 'PATH'
 * @throws {EngineError} code 'unavailable', the message lists every place that was tried
 */
function resolveBinary({ paths = module.paths } = {}) {
    const fromEnv = process.env.RP_BARCODE_ENGINE;
    if (fromEnv) {
        const file = path.resolve(fromEnv);          // checked and spawned as the same file, never through PATH
        const problem = executableProblem(file);
        if (problem) throw new EngineError('unavailable', `RP_BARCODE_ENGINE ${problem}`);
        return { path: file, source: 'RP_BARCODE_ENGINE' };
    }
    const problems = [];
    const pkg = ENGINE_PACKAGES[platformId()];
    if (pkg) {
        const file = packageBinary(pkg, paths);
        if (file) {
            const problem = executableProblem(file);
            if (!problem) return { path: file, source: pkg };
            problems.push(problem);
        } else {
            problems.push(`${pkg} is not installed`);
        }
    } else {
        problems.push(`no engine package for ${platformId()}`);
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const file = path.join(dir, 'rp-barcode');
        if (executableProblem(file) === null) return { path: file, source: 'PATH' };
    }
    problems.push('rp-barcode is not in PATH');
    throw new EngineError('unavailable', `no rp-barcode engine (${problems.join('; ')})`);
}

const DEFAULTS = {
    command: null,              // null: resolveBinary() at every start (RP_BARCODE_ENGINE may change between starts)
    args: ['serve'],
    env: null,                  // null: process.env
    maxQueue: 128,              // requests in flight before `overloaded` (overview §4.3)
    maxBufferedBytes: 256 << 20, // bytes still unwritten to the engine's stdin before `overloaded`: 256 MiB, the
                                //   protocol's default maxPayload. An idle pipe (nothing unwritten) always takes one
                                //   frame, whatever its size; the budget applies once bytes pile up, which means the
                                //   engine is not reading (a timed-out request leaves `pending`, but its bytes stay in
                                //   the pipe buffer until the engine takes them)
    helloTimeoutMs: 5000,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    backoff: { initialMs: 1000, maxMs: 30000 },
    drainMs: 2000,              // stop(): wait for the requests in flight
    exitMs: 1000                // stop(): wait after shutdown, then after SIGTERM, before escalating
};

function exitDescription(code, signal) {
    return signal ? `signal ${signal}` : `code ${code}`;
}

class Engine extends EventEmitter {
    /**
     * @param {object} [options] see DEFAULTS; `command` null resolves the binary at every start. Two gates make
     *   `overloaded`: `maxQueue` requests in flight and `maxBufferedBytes` not yet taken by the engine's stdin.
     */
    constructor(options = {}) {
        super();
        this.opts = { ...DEFAULTS, args: [...DEFAULTS.args], backoff: { ...DEFAULTS.backoff } };
        this.child = null;
        this.pid = null;
        this.hello = null;
        this.starting = null;          // Promise<hello> while a start is in progress
        this.stopping = null;          // Promise<void> while a stop is in progress
        this.pending = new Map();      // id → { resolve, reject, timer }
        this.nextId = 1;               // 0 belongs to the server (hello, bad_frame)
        this.refs = 0;                 // nodes holding the shared engine (acquire/release)
        this.lastError = null;         // why the last start failed or the last process went away
        this.backoffMs = DEFAULTS.backoff.initialMs;
        this.retryAt = 0;
        this._exited = Promise.resolve();   // resolves when the current child is gone ('close')
        this._idleWaiters = new Set();
        this._killOnExit = () => {
            if (this.child) {
                try { this.child.kill('SIGKILL'); } catch (_) { /* already gone */ }
            }
        };
        this.configure(options);
    }

    /** Merges options (backoff merged key by key) and resets the wait; returns this. */
    configure(options) {
        const { backoff, ...rest } = options || {};
        for (const [key, value] of Object.entries(rest)) {
            if (value !== undefined) this.opts[key] = value;
        }
        for (const [key, value] of Object.entries(backoff || {})) {
            if (value !== undefined) this.opts.backoff[key] = value;
        }
        this.resetBackoff();
        return this;
    }

    resetBackoff() {
        this.backoffMs = this.opts.backoff.initialMs;
        this.retryAt = 0;
    }

    get running() {
        return this.child !== null && this.hello !== null;
    }

    /**
     * Resolves with the hello header. Idempotent: a start in progress is shared, a running engine answers at once.
     * Never two processes: a child on its way out is awaited first. Inside the wait after a failure it throws
     * EngineError 'unavailable' without spawning; a failed spawn throws 'unavailable' or 'protocol' and doubles
     * the wait (1 s → 30 s by default); a successful hello resets it.
     */
    async start() {
        for (;;) {
            if (this.running) return this.hello;
            if (this.starting) return this.starting;
            if (this.stopping) { await this.stopping; continue; }
            if (this.child) { await this._exited; continue; }      // a broken child is being killed
            break;
        }
        const now = Date.now();
        if (now < this.retryAt) {
            const why = this.lastError ? this.lastError.message : 'the last start failed';
            throw new EngineError('unavailable', `engine unavailable, retry in ${this.retryAt - now} ms (${why})`);
        }
        this.starting = this._spawn().then(
            (hello) => {
                this.starting = null;
                this.resetBackoff();
                return hello;
            },
            (err) => {
                this.starting = null;
                this._scheduleRetry(err);
                throw err;
            });
        return this.starting;
    }

    _scheduleRetry(err) {
        this.lastError = err;
        this.retryAt = Date.now() + this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, this.opts.backoff.maxMs);
    }

    _spawn() {
        return new Promise((resolve, reject) => {
            let command = this.opts.command;
            let source = 'command';
            if (!command) {
                try {
                    ({ path: command, source } = resolveBinary());
                } catch (err) {
                    return reject(err);
                }
            }
            let child;
            try {
                child = spawn(command, this.opts.args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.opts.env || process.env });
            } catch (err) {
                return reject(new EngineError('unavailable', `cannot run ${command}: ${err.message}`));
            }
            let resolveExited;
            this._exited = new Promise((r) => { resolveExited = r; });
            this.child = child;
            this.pid = child.pid || null;
            this.hello = null;
            process.on('exit', this._killOnExit);

            let settled = false;           // the start() promise has been resolved or rejected
            let alive = true;              // frames from this child still mean something
            let saidHello = false;
            let brokenErr = null;          // why this child was declared broken (kept over the exit it provokes)
            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(helloTimer);
                fn(value);
            };
            // A broken engine (no hello, wrong protocol, bad frame): the start fails if still starting, the
            // engine stops being `running` at once (no new request reaches it) and the child is killed.
            const broken = (err) => {
                if (!alive) return;
                alive = false;
                brokenErr = err;
                if (this.child === child) this.hello = null;
                settle(reject, err);
                try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
            };
            const helloTimer = setTimeout(
                () => broken(new EngineError('unavailable', `no hello from ${command} within ${this.opts.helloTimeoutMs} ms`)),
                this.opts.helloTimeoutMs);

            const onFrame = (header) => {
                if (!saidHello) {
                    if (header.op !== 'hello' || header.id !== 0) {
                        return broken(new EngineError('protocol', `expected hello, got ${JSON.stringify(header).slice(0, 200)}`));
                    }
                    if (header.protocol !== PROTOCOL) {
                        return broken(new EngineError('protocol', `engine speaks protocol ${header.protocol}, this node needs ${PROTOCOL}`));
                    }
                    saidHello = true;
                    this.hello = header;
                    settle(resolve, header);
                    this.emit('started', { pid: child.pid, hello: header, source });
                    return;
                }
                if (header.id === 0) {
                    // Unprompted after the hello: only `bad_frame` before the server exits with status 3 (§3.1)
                    const e = (header.ok === false && header.error) || {};
                    return broken(new EngineError('protocol', `engine reported ${e.code || 'an error'}: ${e.message || JSON.stringify(header).slice(0, 200)}`));
                }
                this._onResponse(header);
            };
            // Replies carry no payload (§3.2): a frame with one, or anything that is not a frame, is a protocol violation
            const parser = new FrameParser({ maxPayload: 0 });
            parser.on('error', (err) => broken(new EngineError('protocol', `engine wrote a bad frame: ${err.message}`)));
            parser.on('frame', (header) => {
                if (!alive) return;
                try {
                    onFrame(header);
                } catch (err) {
                    // Never let a listener throw: FrameParser would drop the rest of the chunk. Route it to the request.
                    const entry = this._settle(header.id);
                    if (entry) entry.reject(err);
                    else process.emitWarning(err);
                }
            });
            child.stdin.on('error', () => { /* EPIPE after the child died: the close handler rejects the requests */ });
            child.stdout.on('data', (chunk) => parser.push(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (text) => this.emit('stderr', text));
            child.on('error', (err) => broken(new EngineError('unavailable', `cannot run ${command}: ${err.message}`)));
            // 'close', not 'exit': it fires once stdout is drained too, so replies written before an orderly exit
            // still reach their requests, and it is the one event a failed spawn (ENOENT) also emits.
            child.on('close', (code, signal) => {
                process.off('exit', this._killOnExit);
                alive = false;
                clearTimeout(helloTimer);
                const mine = this.child === child;
                if (mine) {
                    this.child = null;
                    this.hello = null;
                    this.pid = null;
                }
                const err = new EngineError('exited', `engine exited (${exitDescription(code, signal)})`);
                if (!settled) {
                    settle(reject, new EngineError('unavailable', err.message));
                } else if (saidHello && !this.stopping) {
                    this._scheduleRetry(brokenErr || err);   // a running engine went away on its own: wait before restarting
                }
                if (mine) this._rejectAll(brokenErr || err);
                resolveExited();
                this.emit('exit', { code, signal });
            });
        });
    }

    /** Removes one pending request and returns its entry (undefined when unknown: a late reply, a timed-out id). */
    _settle(id) {
        const entry = this.pending.get(id);
        if (!entry) return undefined;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        this._notifyIdle();
        return entry;
    }

    _rejectAll(err) {
        const entries = [...this.pending.values()];
        this.pending.clear();
        for (const entry of entries) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
        this._notifyIdle();
    }

    _notifyIdle() {
        if (this.pending.size > 0 || this._idleWaiters.size === 0) return;
        const waiters = [...this._idleWaiters];
        this._idleWaiters.clear();
        for (const done of waiters) done();
    }

    /** Resolves true when no request is pending, false after ms. */
    _whenIdle(ms) {
        if (this.pending.size === 0) return Promise.resolve(true);
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                this._idleWaiters.delete(done);
                resolve(false);
            }, ms);
            this._idleWaiters.add(done);
        });
    }

    _onResponse(header) {
        const entry = this._settle(header.id);
        if (!entry) return;                  // a late reply of a timed-out request, or an id we never sent: discarded
        if (header.ok === true) {
            entry.resolve({
                symbols: Array.isArray(header.symbols) ? header.symbols : [],
                image: header.image || null,
                timing: header.timing || null
            });
        } else {
            const e = header.error || {};
            entry.reject(new EngineError(typeof e.code === 'string' && e.code ? e.code : 'internal', e.message || 'engine error'));
        }
    }

    _request(header, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (!this.running) return reject(new EngineError('exited', 'engine not running'));
            if (this.pending.size >= this.opts.maxQueue) {
                return reject(new EngineError('overloaded', `engine overloaded (${this.pending.size} requests in flight)`));
            }
            const id = this.nextId++;
            let frame;
            try {
                frame = encodeFrame({ id, ...header }, payload);
            } catch (err) {
                return reject(new EngineError('invalid_input', err.message));
            }
            const bytes = frame[0].length + frame[1].length;
            const buffered = this.child.stdin.writableLength;
            if (buffered > 0 && buffered + bytes > this.opts.maxBufferedBytes) {
                return reject(new EngineError('overloaded',
                    `engine overloaded (${buffered} bytes still unwritten, ${bytes} more would exceed ${this.opts.maxBufferedBytes})`));
            }
            const timer = setTimeout(() => {
                if (this._settle(id)) reject(new EngineError('timeout', `engine timeout after ${timeoutMs} ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.child.stdin.write(frame[0]);
                if (frame[1].length > 0) this.child.stdin.write(frame[1]);
            } catch (err) {
                if (this._settle(id)) reject(new EngineError('exited', `engine write failed: ${err.message}`));
            }
        });
    }

    /**
     * image: {width, height, channels, colorSpace, encoding?} (encoding defaults to "raw"); payload: the packed
     * rows (or the encoded file); options: decodeOptions (schema 1.0 §12.1, known keys only); timeoutMs (default
     * defaultTimeoutMs) is the client's timer and also travels as deadlineMs. A payload over the engine's
     * advertised limits.maxPayload is refused here with `invalid_input`, without being sent.
     *
     * @returns {Promise<{symbols: object[], image: {width: number, height: number}|null, timing: object|null}>}
     */
    async decode(image, payload, options = {}, { timeoutMs } = {}) {
        const timeout = timeoutMs > 0 ? timeoutMs : this.opts.defaultTimeoutMs;
        if (!image || typeof image !== 'object') throw new EngineError('invalid_input', 'image must be an object');
        if (!(payload instanceof Uint8Array)) throw new EngineError('invalid_input', 'payload must be a Buffer or Uint8Array');
        if (this.pending.size >= this.opts.maxQueue) {
            throw new EngineError('overloaded', `engine overloaded (${this.pending.size} requests in flight)`);
        }
        await this.start();
        const limit = this.hello && this.hello.limits ? this.hello.limits.maxPayload : undefined;
        if (typeof limit === 'number' && payload.length > limit) {
            throw new EngineError('invalid_input', `payload of ${payload.length} bytes exceeds the engine limit of ${limit} bytes`);
        }
        const header = {
            op: 'decode',
            image: {
                width: image.width, height: image.height, channels: image.channels,
                colorSpace: image.colorSpace, encoding: image.encoding || 'raw'
            },
            options: options || {},
            deadlineMs: timeout
        };
        return this._request(header, payload, timeout);
    }

    /** A liveness probe the server answers without queueing; resolves like an empty decode. */
    async ping({ timeoutMs } = {}) {
        await this.start();
        return this._request({ op: 'ping' }, EMPTY, timeoutMs > 0 ? timeoutMs : this.opts.defaultTimeoutMs);
    }

    /**
     * Drain (≤ drainMs) → shutdown → SIGTERM → SIGKILL, exitMs between the steps (≤ 4 s with the defaults; one more
     * exitMs only when something else keeps the child's pipes open after the SIGKILL).
     * Resolves when the child is gone; whatever was still pending rejects with `exited`. Idempotent; a no-op
     * when nothing runs.
     */
    async stop() {
        if (this.stopping) return this.stopping;
        if (this.starting) {
            try { await this.starting; } catch (_) { /* the start failed: the child, if any, is being killed */ }
            if (this.stopping) return this.stopping;             // another stop() got here first during that wait
        }
        const child = this.child;
        if (!child) return;
        this.stopping = this._stop(child).finally(() => { this.stopping = null; });
        return this.stopping;
    }

    async _stop(child) {
        const exited = this._exited;
        // Let the decodes that awaited the same start() send their frames before counting what is in flight
        await new Promise((resolve) => setImmediate(resolve));
        await this._whenIdle(this.opts.drainMs);
        const gone = (ms) => new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), ms);
            exited.then(() => {
                clearTimeout(timer);
                resolve(true);
            });
        });
        if (this.child === child && this.hello !== null) {
            try { child.stdin.write(encodeFrame({ id: this.nextId++, op: 'shutdown' })[0]); } catch (_) { /* dead pipe */ }
        }
        if (!(await gone(this.opts.exitMs))) {
            try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
            if (!(await gone(this.opts.exitMs))) {
                try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
                if (!(await gone(this.opts.exitMs))) {
                    // 'close' also waits for every holder of the pipes (a wrapper that forked the binary): let ours go
                    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
                    await exited;
                }
            }
        }
        this._rejectAll(new EngineError('exited', 'engine stopped'));
    }
}

// One engine per Node-RED process (D5), started lazily by the first decode, stopped by the last release()
let shared = null;
function getEngine() {
    if (!shared) shared = new Engine();
    return shared;
}
function setEngineOptions(options) {
    return getEngine().configure(options);
}
function acquire() {
    const engine = getEngine();
    engine.refs += 1;
    return engine;
}
async function release() {
    const engine = getEngine();
    engine.refs = Math.max(0, engine.refs - 1);
    if (engine.refs === 0) await engine.stop();
}

// ---- Mapping for the node (overview §4.1, §4.2; compat/barcode-reader.md §2-§4) ----

// compat/barcode-reader.md §3: `format` with ZXing's spelling; the add-ons, which ZXing does not report on their own,
// take ZBar's (EAN-2 / EAN-5). The identifier is read before the symbology: an add-on carries its main's symbology.
const FORMAT_NAMES = {
    EAN13: 'EAN-13', EAN8: 'EAN-8', UPCA: 'UPC-A', UPCE: 'UPC-E',
    Code128: 'Code128', Code39: 'Code39', Code93: 'Code93', Codabar: 'Codabar', ITF: 'ITF'
};
const ADDON_NAMES = { ']E1': 'EAN-2', ']E2': 'EAN-5' };
// The names of the node's Formats list (barcode.html) that the SDK reads: the same identifiers as `symbologies`
const SDK_SYMBOLOGIES = Object.keys(FORMAT_NAMES);

/** The `format` the node prints for a schema-1.0 symbol; an unknown symbology keeps the SDK's name. */
function formatName(symbol) {
    return ADDON_NAMES[symbol.identifier] || FORMAT_NAMES[symbol.symbology] || String(symbol.symbology);
}

/**
 * A schema-1.0 symbol → the raw result deduplicateResults / deduplicateSpatial / convertToFinalFormat consume
 * without change (overview §4.2). Points: x2,y2 = corners[0] (TL), x3,y3 = corners[1] (TR), x4,y4 = corners[2] (BR),
 * x1,y1 = corners[3] (BL), in px, because convertToFinalFormat reorders [p2, p3, p4, p1]: `corners` comes out
 * TL, TR, BR, BL and getRotation gives angle 0 for a horizontal symbol (-90 at orientation 90, compat §4).
 * `quality` is `lines` (the spatial tie-break); the six new fields travel with the result and convertToFinalFormat
 * copies them only when present.
 *
 * @param {object} symbol {symbology, identifier, value, corners: [{x, y}×4], orientation, lines, confidence, checksum}
 * @returns {{type: string, data: string, points: object, quality: number, symbology: string, identifier: string,
 *   orientation: number, lines: number, confidence: number, checksum: string}}
 */
function symbolToRaw(symbol) {
    const c = symbol.corners;
    return {
        type: formatName(symbol),
        data: symbol.value,
        points: { x1: c[3].x, y1: c[3].y, x2: c[0].x, y2: c[0].y, x3: c[1].x, y3: c[1].y, x4: c[2].x, y4: c[2].y },
        quality: symbol.lines,
        symbology: symbol.symbology,
        identifier: symbol.identifier,
        orientation: symbol.orientation,
        lines: symbol.lines,
        confidence: symbol.confidence,
        checksum: symbol.checksum
    };
}

// The vocabulary of the enumerated block options (overview §4.1)
const OPTION_VALUES = {
    effort: ['robust', 'normal'],
    directions: ['both', 'horizontal', 'vertical'],
    addOn: ['ignore', 'read', 'require'],
    quietZone: ['tolerant', 'spec']
};
// An option the editor left out, or emptied, takes its default
const unset = (value) => value === undefined || value === null || value === '';
function optionError(name, value, expected) {
    return new Error(`rosepetal option ${name}: ${JSON.stringify(value)} is not ${expected}`);
}
function pickEnum(options, name, fallback) {
    const value = options[name];
    if (unset(value)) return fallback;
    if (!OPTION_VALUES[name].includes(value)) throw optionError(name, value, OPTION_VALUES[name].join('|'));
    return value;
}
function pickBool(options, name, fallback) {
    const value = options[name];
    if (unset(value)) return fallback;
    if (typeof value !== 'boolean') throw optionError(name, value, 'true|false');
    return value;
}
function pickInt(options, name, fallback, min) {
    const value = options[name];
    if (unset(value)) return fallback;
    if (!Number.isInteger(value) || value < min) throw optionError(name, value, `an integer >= ${min}`);
    return value;
}

/**
 * A `rosepetal` block (overview §4.1) → { decodeOptions, skip, timeoutMs }: decodeOptions holds the schema-1.0
 * §12.1 keys the block controls (the server rejects unknown keys); skip is true when Formats is restricted and
 * holds nothing the SDK reads (2D only), and the block answers [] without starting the engine, like Quagga2 with
 * formats it does not read; timeoutMs is the client's timer and travels as deadlineMs. `tryHarder` (legacy) is
 * ignored. A value outside the vocabulary throws a plain Error naming the option: that block fails with a warn
 * and [], the other blocks run.
 *
 * `directions` and `tryInvert` only take effect with effort "normal": robust always scans rows and columns and
 * tries the inverted image (pkg/barcode/decode.go). They are sent either way; the help and the readme say so.
 *
 * @param {{options?: object}} block
 * @returns {{decodeOptions: object|null, skip: boolean, timeoutMs: number}}
 */
function optionsFromBlock(block) {
    const options = (block && block.options) || {};
    const formats = Array.isArray(options.formats) ? options.formats : [];
    const symbologies = formats.filter((f) => SDK_SYMBOLOGIES.includes(f));
    const timeoutMs = pickInt(options, 'timeoutMs', DEFAULT_TIMEOUT_MS, 1);
    if (formats.length > 0 && symbologies.length === 0) {
        return { decodeOptions: null, skip: true, timeoutMs };
    }
    const directions = pickEnum(options, 'directions', 'both');
    const decodeOptions = {
        symbologies,
        effort: pickEnum(options, 'effort', 'robust'),
        horizontal: directions !== 'vertical',
        vertical: directions !== 'horizontal',
        tryInvert: pickBool(options, 'tryInvert', true),
        addOn: pickEnum(options, 'addOn', 'ignore'),
        upcaAsEan13: pickBool(options, 'upcaAsEan13', false),
        code39FullAscii: pickBool(options, 'code39FullAscii', false),
        optionalChecksum: pickBool(options, 'checksum', false),
        quietZone: pickEnum(options, 'quietZone', 'tolerant'),
        minLines: pickInt(options, 'minLines', 0, 0)
    };
    return { decodeOptions, skip: false, timeoutMs };
}

module.exports = {
    PROTOCOL, INSTALL_HINT, DEFAULT_TIMEOUT_MS, ENGINE_PACKAGES, FORMAT_NAMES, ADDON_NAMES, SDK_SYMBOLOGIES,
    EngineError, Engine, resolveBinary, getEngine, setEngineOptions, acquire, release,
    formatName, symbolToRaw, optionsFromBlock
};
