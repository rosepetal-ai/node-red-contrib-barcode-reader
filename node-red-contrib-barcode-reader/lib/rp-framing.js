'use strict';
/**
 * Frame codec of the `rp-barcode serve` protocol, version 1
 * (rosepetal-barcode-sdk docs/plans/fase2/00-overview.md §3.1, docs/service.md):
 *
 *   u32 big-endian headerLen | u32 big-endian payloadLen | header (headerLen bytes, UTF-8 JSON object) | payload
 *
 * headerLen is >= 2 and <= maxHeader (1 MiB by default), payloadLen <= maxPayload (256 MiB by default) and the
 * header must be a JSON object. Anything else is a protocol violation: the parser emits one FramingError and
 * ignores every later chunk, because the byte stream can no longer be delimited (the caller restarts the process).
 *
 * The parser copies every byte exactly once, into a buffer sized from the prefix, so a payload never lives twice
 * in memory and the emitted Buffer is independent of the chunks pushed in.
 */
const { EventEmitter } = require('node:events');

const PREFIX_BYTES = 8;
const MIN_HEADER = 2;                    // "{}"
const MAX_U32 = 0xffffffff;
const DEFAULT_MAX_HEADER = 1 << 20;      // 1 MiB
const DEFAULT_MAX_PAYLOAD = 256 << 20;   // 256 MiB
const EMPTY = Buffer.alloc(0);

class FramingError extends Error {
    /**
     * @param {'bad_frame'|'bad_header'|'bad_payload'} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'FramingError';
        this.code = code;
    }
}

function isJsonObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Encodes one frame as [head, payload]: head is the 8-byte prefix followed by the UTF-8 JSON header and payload
 * is the caller's buffer untouched, so the two go out in two writes and the pixels are never copied.
 *
 * @param {object} header a JSON object (control characters such as GS 0x1D survive as \u001d escapes)
 * @param {Buffer|Uint8Array} [payload] optional (payloadLen 0)
 * @returns {[Buffer, Buffer|Uint8Array]}
 */
function encodeFrame(header, payload = EMPTY) {
    if (!isJsonObject(header)) {
        throw new FramingError('bad_header', 'header must be a JSON object');
    }
    if (!(payload instanceof Uint8Array)) {          // a Buffer is a Uint8Array
        throw new FramingError('bad_payload', 'payload must be a Buffer or Uint8Array');
    }
    if (payload.length > MAX_U32) {
        throw new FramingError('bad_payload', `payload length ${payload.length} does not fit in u32`);
    }
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    if (json.length > MAX_U32) {
        throw new FramingError('bad_header', `header length ${json.length} does not fit in u32`);
    }
    const head = Buffer.allocUnsafe(PREFIX_BYTES + json.length);
    head.writeUInt32BE(json.length, 0);
    head.writeUInt32BE(payload.length, 4);
    json.copy(head, PREFIX_BYTES);
    return [head, payload];
}

/**
 * Incremental parser over arbitrary chunks (any split, one byte at a time or several frames at once).
 *
 * Events:
 *   'frame' (header: object, payload: Buffer)   payload is an empty Buffer when payloadLen is 0
 *   'error' (FramingError)                       emitted once; afterwards push() is a no-op and `failed` holds the error
 */
class FrameParser extends EventEmitter {
    constructor({ maxHeader = DEFAULT_MAX_HEADER, maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
        super();
        this.maxHeader = maxHeader;
        this.maxPayload = maxPayload;
        this.failed = null;
        this.headerLen = 0;
        this.payloadLen = 0;
        this.header = null;
        this.prefix = Buffer.alloc(PREFIX_BYTES);
        this._expect('prefix', this.prefix);
    }

    /** @param {Buffer|Uint8Array} chunk */
    push(chunk) {
        if (this.failed) return;
        if (!(chunk instanceof Uint8Array)) {
            throw new TypeError('FrameParser.push expects a Buffer or Uint8Array');
        }
        let offset = 0;
        while (offset < chunk.length) {
            const n = Math.min(this.target.length - this.filled, chunk.length - offset);
            this.target.set(chunk.subarray(offset, offset + n), this.filled);
            this.filled += n;
            offset += n;
            if (this.filled === this.target.length && !this._complete()) return;
        }
    }

    _expect(state, target) {
        this.state = state;
        this.target = target;
        this.filled = 0;
    }

    /** The current target is full: validate it and move to the next state. Returns false once the parser is dead. */
    _complete() {
        switch (this.state) {
            case 'prefix': {
                this.headerLen = this.prefix.readUInt32BE(0);
                this.payloadLen = this.prefix.readUInt32BE(4);
                if (this.headerLen < MIN_HEADER || this.headerLen > this.maxHeader) {
                    return this._fail('bad_frame', `header length ${this.headerLen} outside ${MIN_HEADER}..${this.maxHeader}`);
                }
                if (this.payloadLen > this.maxPayload) {
                    return this._fail('bad_frame', `payload length ${this.payloadLen} exceeds ${this.maxPayload}`);
                }
                this._expect('header', Buffer.allocUnsafe(this.headerLen));
                return true;
            }
            case 'header': {
                let header;
                try {
                    header = JSON.parse(this.target.toString('utf8'));
                } catch (err) {
                    return this._fail('bad_header', `header is not JSON: ${err.message}`);
                }
                if (!isJsonObject(header)) {
                    return this._fail('bad_header', 'header is not a JSON object');
                }
                this.header = header;
                if (this.payloadLen === 0) return this._emitFrame(EMPTY);
                this._expect('payload', Buffer.allocUnsafe(this.payloadLen));
                return true;
            }
            case 'payload':
                return this._emitFrame(this.target);
            default:
                return this._fail('bad_frame', `unexpected parser state ${this.state}`);
        }
    }

    _emitFrame(payload) {
        const header = this.header;
        this.header = null;
        this._expect('prefix', this.prefix);     // consistent state before listeners run
        this.emit('frame', header, payload);
        return !this.failed;
    }

    _fail(code, message) {
        this.failed = new FramingError(code, message);
        this.header = null;
        this._expect('dead', EMPTY);
        this.emit('error', this.failed);
        return false;
    }
}

module.exports = {
    encodeFrame,
    FrameParser,
    FramingError,
    PREFIX_BYTES,
    MIN_HEADER,
    DEFAULT_MAX_HEADER,
    DEFAULT_MAX_PAYLOAD
};
