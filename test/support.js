'use strict';
/** Shared helpers of the node-level tests: fixtures as raw bitmaps, flows, one message through a loaded flow. */
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const INDEX = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'index.json'), 'utf8'));

function fixture(name) {
    const f = INDEX.fixtures.find((x) => x.file === name);
    if (!f) throw new Error(`fixture ${name} is not in index.json`);
    return f;
}

// A fixture PNG as the raw RGBA bitmap the node accepts (pngjs always expands to RGBA)
function loadRaw(name) {
    const png = PNG.sync.read(fs.readFileSync(path.join(FIXTURES_DIR, name)));
    return { data: png.data, width: png.width, height: png.height, colorSpace: 'RGBA', dtype: 'uint8' };
}

// The same PNG as 1-channel gray (red channel: synthetic renders are neutral)
function loadGray(name) {
    const raw = loadRaw(name);
    const data = Buffer.alloc(raw.width * raw.height);
    for (let i = 0; i < data.length; i++) data[i] = raw.data[i * 4];
    return { data, width: raw.width, height: raw.height, colorSpace: 'GRAY', dtype: 'uint8' };
}

// A W×H white gray bitmap with `gray` pasted at (x, y): the inspection crop of the budget test
function pasteOnWhite(gray, W, H, x, y) {
    if (x < 0 || y < 0 || x + gray.width > W || y + gray.height > H) {
        throw new Error(`pasteOnWhite: ${gray.width}×${gray.height} at (${x}, ${y}) does not fit ${W}×${H}`);
    }
    const data = Buffer.alloc(W * H, 255);
    for (let row = 0; row < gray.height; row++) {
        gray.data.copy(data, (y + row) * W + x, row * gray.width, (row + 1) * gray.width);
    }
    return { data, width: W, height: H, colorSpace: 'GRAY', dtype: 'uint8' };
}

// True when the prebuilt addon of the node loads on this platform
function addonAvailable() {
    try {
        require('../node-red-contrib-barcode-reader/index.js');
        return true;
    } catch (_) {
        return false;
    }
}

// A barcode-reader node `n1` named `reader` wired to a helper node `h1`
function readerFlow(blocks, props = {}) {
    return [
        { id: 'n1', type: 'barcode-reader', name: 'reader', inputValue: 'payload', outputValue: 'payload',
          executionMode: 'parallel', blocks, wires: [['h1']], ...props },
        { id: 'h1', type: 'helper' }
    ];
}

// Sends { payload } into n1 and resolves with the message h1 receives
function runFlow(helper, payload, { timeoutMs = 15000 } = {}) {
    const n1 = helper.getNode('n1');
    const h1 = helper.getNode('h1');
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no output after ${timeoutMs} ms`)), timeoutMs);
        h1.once('input', (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        n1.receive({ payload });
    });
}

module.exports = { FIXTURES_DIR, INDEX, fixture, loadRaw, loadGray, pasteOnWhite, addonAvailable, readerFlow, runFlow };
