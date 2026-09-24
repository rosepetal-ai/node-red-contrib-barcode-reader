'use strict';
/**
 * What is specific to this node about the Rosepetal SDK engine (rp-barcode serve): a schema-1.0 symbol → the raw
 * result barcode.js already consumes (symbolToRaw, rosepetal-barcode-sdk docs/plans/fase2/00-overview.md §4.2) and
 * a `rosepetal` block's options → decodeOptions (optionsFromBlock, §4.1). The engine itself (framing, the Engine
 * class, the shared singleton, resolveBinary, the fake engine of the tests) is @rosepetal/barcode-engine-client,
 * shared with node-red-contrib-barcode-verifier so one Node-RED runtime runs one rp-barcode process (D9); this
 * module re-exports the part of it the node uses, so barcode.js requires one thing. The tests use it too, except
 * that e2e.test.js takes Engine from the client for a private engine (the node has no use for the class).
 */
const {
    EngineError, INSTALL_HINT, DEFAULT_TIMEOUT_MS, FORMAT_NAMES, ADDON_NAMES, formatName,
    getEngine, setEngineOptions, acquire, release, FAKE_ENGINE
} = require('@rosepetal/barcode-engine-client');

// The names of the node's Formats list (barcode.html) that the SDK reads: the same identifiers as `symbologies`
const SDK_SYMBOLOGIES = Object.keys(FORMAT_NAMES);

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
function pickInt(options, name, fallback, min, max = Infinity) {
    const value = options[name];
    if (unset(value)) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
        throw optionError(name, value, Number.isFinite(max) ? `an integer in [${min}, ${max}]` : `an integer >= ${min}`);
    }
    return value;
}
// The largest delay a Node timer takes (2^31 - 1 ms, ~24.8 days): above it setTimeout fires at once
// (TimeoutOverflowWarning) and every decode would time out immediately. The editor caps its input the same way.
const MAX_TIMEOUT_MS = 2147483647;

/**
 * A `rosepetal` block (overview §4.1) → { decodeOptions, skip, timeoutMs }: decodeOptions holds the schema-1.0
 * §12.1 keys the block controls (the server rejects unknown keys); skip is true when Formats is restricted and
 * holds nothing the SDK reads (2D only), and the block answers [] without starting the engine, like Quagga2 with
 * formats it does not read; timeoutMs is the client's timer and travels as deadlineMs. `tryHarder` (legacy) is
 * ignored. A value outside the vocabulary (or a timeoutMs outside [1, MAX_TIMEOUT_MS]) throws a plain Error naming
 * the option: that block fails with a warn and [], the other blocks run.
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
    const timeoutMs = pickInt(options, 'timeoutMs', DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
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
    // This node's mapping
    SDK_SYMBOLOGIES, OPTION_VALUES, MAX_TIMEOUT_MS, symbolToRaw, optionsFromBlock,
    // Re-exported from @rosepetal/barcode-engine-client (the shared engine): barcode.js requires only this module;
    // the tests use it too (e2e.test.js takes Engine from the client for a private engine)
    EngineError, INSTALL_HINT, DEFAULT_TIMEOUT_MS, FORMAT_NAMES, ADDON_NAMES, formatName,
    getEngine, setEngineOptions, acquire, release, FAKE_ENGINE
};
