'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeFrame, FrameParser, FramingError } = require('../node-red-contrib-barcode-reader/lib/rp-framing');

// Three frames of the protocol: hello (no payload), a decode with 6 raw pixels, a reply with a 300-byte payload
const THREE = [
    [{ id: 0, op: 'hello', protocol: 1 }, Buffer.alloc(0)],
    [{ id: 1, op: 'decode', image: { width: 3, height: 2, channels: 1, colorSpace: 'GRAY', encoding: 'raw' } }, Buffer.from([1, 2, 3, 4, 5, 6])],
    [{ id: 2, ok: true, symbols: [], value: 'GS\u001dsep' }, Buffer.alloc(300, 0xab)]
];

function bytesOf(frames) {
    return Buffer.concat(frames.flatMap(([header, payload]) => encodeFrame(header, payload)));
}
function collect(parser) {
    const frames = [];
    parser.on('frame', (header, payload) => frames.push([header, payload]));
    return frames;
}
function prefix(headerLen, payloadLen) {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(headerLen, 0);
    b.writeUInt32BE(payloadLen, 4);
    return b;
}

test('encodeFrame: 8-byte big-endian prefix, UTF-8 JSON header, payload returned as is (two writes, no copy)', () => {
    const payload = Buffer.from([9, 8, 7]);
    const [head, body] = encodeFrame({ id: 7, op: 'ping' }, payload);
    const json = Buffer.from(JSON.stringify({ id: 7, op: 'ping' }), 'utf8');
    assert.equal(head.length, 8 + json.length);
    assert.equal(head.readUInt32BE(0), json.length);
    assert.equal(head.readUInt32BE(4), 3);
    assert.deepEqual(head.subarray(8), json);
    assert.equal(body, payload);
    assert.equal(encodeFrame({ id: 1 })[1].length, 0);            // payload optional (payloadLen 0)
    assert.equal(encodeFrame({ id: 1 })[0].readUInt32BE(4), 0);
    assert.throws(() => encodeFrame([1, 2]), FramingError);        // header must be a JSON object
    assert.throws(() => encodeFrame({ id: 1 }, 'text'), FramingError);
});

test('FrameParser: the 3-frame stream split at every byte boundary yields the same 3 frames', () => {
    const stream = bytesOf(THREE);
    for (let cut = 0; cut <= stream.length; cut++) {
        const parser = new FrameParser();
        parser.on('error', (err) => assert.fail(`cut ${cut}: ${err.message}`));
        const frames = collect(parser);
        parser.push(stream.subarray(0, cut));
        parser.push(stream.subarray(cut));
        assert.equal(frames.length, 3, `cut at ${cut}`);
        frames.forEach(([header, payload], i) => {
            assert.deepEqual(header, THREE[i][0], `cut ${cut} frame ${i} header`);
            assert.deepEqual(payload, THREE[i][1], `cut ${cut} frame ${i} payload`);
        });
    }
});

test('FrameParser: one byte at a time, and everything in one chunk; zero payload is an empty Buffer; 0x1D survives', () => {
    const stream = bytesOf(THREE);
    const byByte = new FrameParser();
    const f1 = collect(byByte);
    for (const b of stream) byByte.push(Buffer.from([b]));
    assert.equal(f1.length, 3);
    const whole = new FrameParser();
    const f2 = collect(whole);
    whole.push(stream);
    assert.equal(f2.length, 3);
    assert.ok(Buffer.isBuffer(f2[0][1]));
    assert.equal(f2[0][1].length, 0);
    assert.equal(f2[2][0].value, 'GS\u001dsep');
    assert.equal(f2[2][1].length, 300);
});

test('FrameParser: limits and bad headers are FramingErrors with a code, and the parser goes dead', () => {
    const cases = [
        ['headerLen 1 (< 2)', Buffer.concat([prefix(1, 0), Buffer.from('{')]), 'bad_frame'],
        ['headerLen over maxHeader', prefix(65, 0), 'bad_frame'],
        ['payloadLen over maxPayload', prefix(2, 1001), 'bad_frame'],
        ['header not JSON', Buffer.concat([prefix(5, 0), Buffer.from('hello')]), 'bad_header'],
        ['header a JSON array', Buffer.concat([prefix(3, 0), Buffer.from('[1]')]), 'bad_header'],
        ['garbage text', Buffer.from('this is not a frame\n'), 'bad_frame']
    ];
    for (const [name, bytes, code] of cases) {
        const parser = new FrameParser({ maxHeader: 64, maxPayload: 1000 });
        const errors = [];
        parser.on('error', (err) => errors.push(err));
        const frames = collect(parser);
        parser.push(bytes);
        assert.equal(errors.length, 1, name);
        assert.ok(errors[0] instanceof FramingError, name);
        assert.equal(errors[0].code, code, name);
        parser.push(bytesOf([THREE[0]]));          // after an error nothing is parsed any more
        assert.equal(frames.length, 0, name);
        assert.equal(errors.length, 1, name);
    }
});

test('FrameParser: exactly maxHeader and exactly maxPayload are accepted', () => {
    const header = JSON.parse('{"k":"' + 'x'.repeat(56) + '"}');   // 64 bytes of JSON
    assert.equal(Buffer.byteLength(JSON.stringify(header)), 64);
    const parser = new FrameParser({ maxHeader: 64, maxPayload: 1000 });
    parser.on('error', (err) => assert.fail(err.message));
    const frames = collect(parser);
    parser.push(bytesOf([[header, Buffer.alloc(1000, 1)]]));
    assert.equal(frames.length, 1);
    assert.equal(frames[0][1].length, 1000);
});

// --- Beyond the brief: behaviour rp-engine.js (2B-T2) and the fake engine rely on ---

test('FrameParser: default limits are 1 MiB / 256 MiB (§3.1) and one byte over each is bad_frame', () => {
    const parser = new FrameParser();
    assert.equal(parser.maxHeader, 1048576);
    assert.equal(parser.maxPayload, 268435456);
    for (const [name, bytes] of [['header', prefix(1048577, 0)], ['payload', prefix(2, 268435457)]]) {
        const p = new FrameParser();
        const errors = [];
        p.on('error', (err) => errors.push(err));
        p.push(bytes);
        assert.equal(errors.length, 1, name);
        assert.equal(errors[0].code, 'bad_frame', name);
        assert.equal(p.failed, errors[0], name);
    }
});

test('FrameParser: a multi-chunk payload arrives as one Buffer that does not alias the pushed chunks', () => {
    const size = 3 * 1024 * 1024 + 13;
    const payload = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) payload[i] = i & 0xff;
    const stream = Buffer.concat(encodeFrame({ id: 3, op: 'decode' }, payload));
    const parser = new FrameParser();
    parser.on('error', (err) => assert.fail(err.message));
    const frames = collect(parser);
    const chunks = [];
    for (let off = 0; off < stream.length; off += 65536) chunks.push(Buffer.from(stream.subarray(off, off + 65536)));
    for (const c of chunks) parser.push(c);
    assert.equal(frames.length, 1);
    assert.equal(frames[0][1].length, size);
    assert.ok(frames[0][1].equals(payload));
    chunks.forEach((c) => c.fill(0));                  // the caller may reuse its chunks after push()
    assert.ok(frames[0][1].equals(payload));
});

test('FrameParser: Uint8Array chunks and payloads are accepted; anything else is a TypeError', () => {
    const [head, body] = encodeFrame({ id: 4 }, new Uint8Array([1, 2]));
    assert.ok(body instanceof Uint8Array);
    assert.equal(head.readUInt32BE(4), 2);
    const parser = new FrameParser();
    const frames = collect(parser);
    parser.push(new Uint8Array(Buffer.concat([head, Buffer.from(body)])));
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0][0], { id: 4 });
    assert.deepEqual(frames[0][1], Buffer.from([1, 2]));
    assert.throws(() => parser.push('text'), TypeError);
});

test('FrameParser: a bad header fails as soon as the header bytes are in, before its payload', () => {
    const parser = new FrameParser();
    const errors = [];
    parser.on('error', (err) => errors.push(err));
    parser.push(Buffer.concat([prefix(5, 1000), Buffer.from('hello')]));   // the 1000 payload bytes never come
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'bad_header');
});

test('FrameParser: several frames in one chunk keep their order, then the stream continues', () => {
    const parser = new FrameParser();
    parser.on('error', (err) => assert.fail(err.message));
    const frames = collect(parser);
    parser.push(Buffer.concat([bytesOf(THREE), bytesOf(THREE)]));
    parser.push(bytesOf([THREE[1]]));
    assert.equal(frames.length, 7);
    assert.deepEqual(frames.map(([h]) => h.id), [0, 1, 2, 0, 1, 2, 1]);
    assert.deepEqual(frames[6][1], Buffer.from([1, 2, 3, 4, 5, 6]));
});
