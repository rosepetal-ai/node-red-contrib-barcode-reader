#!/usr/bin/env node
'use strict';
/**
 * Fake `rp-barcode serve` for the tests: protocol 1 over stdio (rosepetal-barcode-sdk docs/plans/fase2/00-overview.md
 * §3), one fixed EAN-13 per decode, knobs through environment variables (02-subfase-2B.md, task 2B-T2). Executable
 * with a shebang so it also works as RP_BARCODE_ENGINE (the client spawns `<path> serve`). Never matched by
 * `npm test` (`test/*.test.js`).
 *
 * Knobs (environment of the child):
 *   FAKE_DELAY_MS=n         every decode answers after n ms
 *   FAKE_CRASH_AFTER=n      exits with status 7 on receiving decode n+1, without answering it
 *   FAKE_PROTOCOL=n         the `protocol` number of the hello (default 1)
 *   FAKE_GARBAGE=1          writes text outside any frame right after the hello
 *   FAKE_OVERLOAD=1         answers `overloaded` to every decode
 *   FAKE_NO_HELLO=1         never greets, never answers, ignores SIGTERM (the client has to SIGKILL)
 *   FAKE_IGNORE_STOP=1      works but ignores `shutdown` and SIGTERM
 *   FAKE_MAX_PAYLOAD=n      the `limits.maxPayload` advertised in the hello (default 256 MiB, like `--max-payload`)
 *   FAKE_REPLY_PAYLOAD=1    attaches a payload to every decode reply (a protocol violation seen from the client)
 *
 * Like the real server it validates `payload.length === width·height·channels` for `encoding: "raw"` and rejects
 * unknown keys inside `options` (schema 1.0 §12.1) with `invalid_input`. Logs go to stderr, one line per event.
 */
const { FrameParser, encodeFrame } = require('../node-red-contrib-barcode-reader/lib/rp-framing');

const env = process.env;
const delayMs = Number(env.FAKE_DELAY_MS || 0);
const crashAfter = env.FAKE_CRASH_AFTER === undefined ? -1 : Number(env.FAKE_CRASH_AFTER);
const protocol = env.FAKE_PROTOCOL === undefined ? 1 : Number(env.FAKE_PROTOCOL);
const garbage = env.FAKE_GARBAGE === '1';
const overload = env.FAKE_OVERLOAD === '1';
const noHello = env.FAKE_NO_HELLO === '1';
const ignoreStop = env.FAKE_IGNORE_STOP === '1';
const maxPayload = env.FAKE_MAX_PAYLOAD === undefined ? 268435456 : Number(env.FAKE_MAX_PAYLOAD);
const replyPayload = env.FAKE_REPLY_PAYLOAD === '1';

// decodeOptions of docs/schema/result-1.0.md §12.1: anything else is invalid_input, as with DisallowUnknownFields
const KNOWN_OPTIONS = new Set(['symbologies', 'region', 'scanStep', 'horizontal', 'vertical', 'quietZone', 'optionalChecksum',
    'minLines', 'tryInvert', 'maxSymbols', 'addOn', 'effort', 'upcaAsEan13', 'code39FullAscii']);
const KNOWN_IMAGE = new Set(['width', 'height', 'channels', 'colorSpace', 'encoding']);

// The symbol rp-barcode decode reads from test/fixtures/ean13.png (347×68, X = 3 px, bars 60 px high)
const SYMBOL = {
    symbology: 'EAN13', identifier: ']E0', value: '4006381333931', bytes: 'NDAwNjM4MTMzMzkzMQ==', gs1: true,
    corners: [{ x: 37, y: 4 }, { x: 322, y: 4 }, { x: 322, y: 64 }, { x: 37, y: 64 }],
    orientation: 0, confidence: 1, lines: 40, checksum: 'valid', region: null
};

function log(line) {
    process.stderr.write(`fake-engine: ${line}\n`);
}
function write(header, payload, onDone) {
    const [head, body] = encodeFrame(header, payload);
    if (body.length === 0) return process.stdout.write(head, onDone);
    process.stdout.write(head);
    process.stdout.write(body, onDone);
}
function fail(id, code, message) {
    write({ id, ok: false, error: { code, message } });
}

process.stdout.on('error', () => process.exit(1));            // broken pipe: the parent is gone (§3.1: status 1)

if (noHello) {
    process.on('SIGTERM', () => { /* ignored: the client has to SIGKILL */ });
    process.stdin.resume();                                    // reads and never answers
} else {
    if (ignoreStop) process.on('SIGTERM', () => { /* ignored */ });
    write({
        id: 0, op: 'hello', protocol, sdk: '0.2.0-fake', engineVersion: '0.2.0+fake', schema: '1.0',
        ops: ['decode', 'ping', 'shutdown'], workers: 1, queue: 64,
        limits: { maxHeader: 1048576, maxPayload, maxSide: 32768, maxPixels: 268435456 }
    });
    log(`hello sent (pid ${process.pid})`);
    if (garbage) process.stdout.write('this is not a frame\n');

    let decodes = 0;
    const parser = new FrameParser({ maxPayload });
    parser.on('error', (err) => {
        fail(0, 'bad_frame', err.message);
        log(`bad frame: ${err.message}`);
        process.exit(3);
    });
    parser.on('frame', (req, payload) => {
        switch (req.op) {
            case 'ping':
                write({ id: req.id, ok: true });
                break;
            case 'shutdown':
                if (ignoreStop) break;
                write({ id: req.id, ok: true }, undefined, () => process.exit(0));
                break;
            case 'decode': {
                if (crashAfter >= 0 && decodes >= crashAfter) process.exit(7);   // dies mid-flight, no answer
                decodes += 1;
                if (overload) return fail(req.id, 'overloaded', 'queue full');
                const img = req.image || {};
                const unknownImage = Object.keys(img).filter((k) => !KNOWN_IMAGE.has(k));
                if (unknownImage.length > 0) return fail(req.id, 'invalid_input', `image: unknown key ${JSON.stringify(unknownImage[0])}`);
                const expected = (img.width | 0) * (img.height | 0) * (img.channels | 0);
                if (img.encoding !== 'raw' || payload.length !== expected) {
                    return fail(req.id, 'invalid_input', `imgio: data length ${payload.length} does not match ${img.width}×${img.height}×${img.channels}`);
                }
                const unknown = Object.keys(req.options || {}).filter((k) => !KNOWN_OPTIONS.has(k));
                if (unknown.length > 0) return fail(req.id, 'invalid_input', `options: unknown key ${JSON.stringify(unknown[0])}`);
                setTimeout(() => write({
                    id: req.id, ok: true, image: { width: img.width, height: img.height }, symbols: [SYMBOL],
                    timing: { totalMs: delayMs, decodeMs: delayMs, queuedMs: 0 }
                }, replyPayload ? Buffer.from([1, 2, 3, 4]) : undefined), delayMs);
                break;
            }
            default:
                fail(req.id, 'unsupported', `op ${JSON.stringify(req.op)}`);
        }
    });
    process.stdin.on('data', (chunk) => parser.push(chunk));
    process.stdin.on('end', () => process.exit(0));            // EOF: the parent closed the pipe (§3.1: status 0)
}
