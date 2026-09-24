'use strict';
// Static contract of barcode.html (2B-T5). The editor runs in the browser, so this checks the strings and classes
// the runtime, optionsFromBlock and the help depend on, and runs the two fragments that can run outside the
// editor: the block template (rendered with stub blocks) and the rosepetal branch of oneditsave (run against a stub
// blockElement, its result fed to the strict optionsFromBlock). The visual check is a manual step with Node-RED.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rp = require('../node-red-contrib-barcode-reader/lib/rp-mapping');

const html = fs.readFileSync(path.join(__dirname, '..', 'node-red-contrib-barcode-reader', 'barcode.html'), 'utf8');
const section = (open, close) => {
    const start = html.indexOf(open);
    assert.notEqual(start, -1, open);
    return html.slice(start + open.length, html.indexOf(close, start));
};
const editor = section('<script type="text/javascript">', '</script>');
const help = section('<script type="text/html" data-help-name="barcode-reader">', '</script>');

const NINE = "'UPCA', 'UPCE', 'EAN13', 'EAN8',\n                    'Code128', 'Code39', 'Code93', 'Codabar', 'ITF'";
const CONTROLS = {   // option key -> [control class, kind]
    effort: ['block-rp-effort', 'enum'], directions: ['block-rp-directions', 'enum'], addOn: ['block-rp-addon', 'enum'],
    quietZone: ['block-rp-quietzone', 'enum'], minLines: ['block-rp-minlines', 'int'], timeoutMs: ['block-rp-timeout', 'int'],
    tryInvert: ['block-rp-tryinvert', 'bool'], upcaAsEan13: ['block-rp-upca', 'bool'],
    code39FullAscii: ['block-rp-code39', 'bool'], checksum: ['block-rp-checksum', 'bool']
};
const ROSEPETAL = { decoder: 'rosepetal', preprocessing: 'original', options: {} };

// Body of the balanced `{ … }` block that follows `marker` (the fragments hold no braces inside strings)
function braceBody(src, marker) {
    const start = src.indexOf(marker);
    assert.notEqual(start, -1, marker);
    let depth = 1;
    for (let i = start + marker.length; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}' && (depth -= 1) === 0) return src.slice(start + marker.length, i);
    }
    assert.fail(`unbalanced block after ${marker}`);
}

// The blockHTML template of addBlockUI rendered for one block, with the editor's own rpOption/rpSelected/rpChecked
function renderBlock(block) {
    const marker = 'const blockHTML = `';
    const start = editor.indexOf(marker);
    assert.notEqual(start, -1, marker);
    const template = editor.slice(start + marker.length, editor.indexOf('`;', start));
    const helpers = editor.slice(editor.indexOf('function rpOption('), editor.indexOf('function addBlockUI('));
    const ctx = { block, index: 0, blockId: 'b0', formatsAll: true };
    vm.runInNewContext(helpers, ctx);
    return vm.runInNewContext('`' + template + '`', ctx);
}
const selectOf = (rendered, cls) => {
    const m = rendered.match(new RegExp(`<select class="${cls}">([\\s\\S]*?)</select>`));
    assert.ok(m, `select .${cls}`);
    return m[1];
};
const selectedOption = (rendered, cls) => (selectOf(rendered, cls).match(/<option value="([^"]+)"\s+selected>/) || [])[1];
const optionValues = (rendered, cls) => [...selectOf(rendered, cls).matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
const isChecked = (rendered, cls) => new RegExp(`class="${cls}"\\s+checked>`).test(rendered);
const numberValue = (rendered, cls) => (rendered.match(new RegExp(`class="${cls}"[^>]*value="([^"]*)"`)) || [])[1];

// The rosepetal branch of oneditsave run against a stub blockElement: values keyed by control class
function saveRosepetal(values) {
    const body = braceBody(editor, "if (decoder === 'rosepetal') {");
    const blockElement = {
        find: (selector) => ({
            val: () => values[selector.slice(1)],
            is: (query) => query === ':checked' && values[selector.slice(1)] === true
        })
    };
    // Copied onto an object of this realm: deepEqual compares prototypes, and the vm context has its own Object
    return Object.assign({}, vm.runInNewContext(`const options = {};\n${body}\noptions`, { blockElement, decoder: 'rosepetal' }));
}

test('editor script compiles and declares the rosepetal decoder with the nine 1D formats', () => {
    assert.doesNotThrow(() => new vm.Script(editor));
    assert.match(editor, /<option value="rosepetal"[^>]*>Rosepetal SDK<\/option>/);
    assert.ok(editor.includes(`rosepetal: [\n                    ${NINE}\n                ]`), 'FORMATS_BY_DECODER.rosepetal');
    assert.match(editor, /blockElement\.find\('\.rosepetal-row'\)\.toggle\(isRosepetal\)/);
    assert.match(editor, /blockElement\.find\('\.preprocessing-row'\)\.toggle\(!isProjection\)/);   // rosepetal keeps preprocessing
    assert.match(editor, /blockElement\.find\('\.projection-row'\)\.toggle\(isProjection\)/);
    assert.equal((editor.match(/function toggleDecoderRows\(/g) || []).length, 1, 'one toggleDecoderRows helper');
});

test('every option of the block table has a control in a .rosepetal-row and oneditsave reads it with its type', () => {
    for (const [key, [cls, kind]] of Object.entries(CONTROLS)) {
        assert.match(editor, new RegExp(`class="${cls}"`), cls);
        assert.match(editor, new RegExp(`\\.find\\('\\.${cls}'\\)`), `oneditsave reads .${cls}`);
        assert.match(editor, new RegExp(`options\\.${key} = `), `options.${key}`);
        if (kind === 'enum') assert.match(editor, new RegExp(`options\\.${key} = blockElement\\.find\\('\\.${cls}'\\)\\.val\\(\\);`), `${key} as chosen`);
        if (kind === 'int') assert.match(editor, new RegExp(`parseInt\\(blockElement\\.find\\('\\.${cls}'\\)\\.val\\(\\), 10\\)`), `${key} parseInt`);
        if (kind === 'bool') assert.match(editor, new RegExp(`options\\.${key} = blockElement\\.find\\('\\.${cls}'\\)\\.is\\(':checked'\\);`), `${key} checkbox`);
    }
    assert.match(editor, /if \(decoder === 'rosepetal'\)/);
    assert.match(editor, /<option value="robust"[^>]*>Robust/);
    assert.match(editor, /rosepetal-row/);
    assert.equal((editor.match(/class="block-form-row rosepetal-row"/g) || []).length, 7, 'seven rosepetal rows');
    assert.match(editor, /<input type="number" class="block-rp-minlines" min="0"/);
    assert.match(editor, /<input type="number" class="block-rp-timeout" min="1"/);
    for (const cls of ['block-rp-tryinvert', 'block-rp-upca', 'block-rp-code39', 'block-rp-checksum']) {
        assert.match(editor, new RegExp(`<input type="checkbox" class="${cls}"`), `${cls} is a checkbox`);
    }
});

test('block template: defaults, a saved block and a legacy block render the right selection', () => {
    const fresh = renderBlock(ROSEPETAL);
    assert.match(fresh, /<option value="rosepetal"\s+selected>Rosepetal SDK<\/option>/);
    assert.equal((fresh.match(/class="block-form-row rosepetal-row"/g) || []).length, 7);
    // The four selects offer exactly the vocabulary optionsFromBlock enforces, in its order (OPTION_VALUES)
    const enums = Object.entries(CONTROLS).filter(([, [, kind]]) => kind === 'enum').map(([key, [cls]]) => [key, cls]);
    assert.deepEqual(enums.map(([key]) => key), Object.keys(rp.OPTION_VALUES), 'one select per enumerated option');
    for (const [key, cls] of enums) assert.deepEqual(optionValues(fresh, cls), rp.OPTION_VALUES[key], cls);
    assert.equal(selectedOption(fresh, 'block-rp-effort'), 'robust');
    assert.equal(selectedOption(fresh, 'block-rp-directions'), 'both');
    assert.equal(selectedOption(fresh, 'block-rp-addon'), 'ignore');
    assert.equal(selectedOption(fresh, 'block-rp-quietzone'), 'tolerant');
    assert.equal(numberValue(fresh, 'block-rp-minlines'), '0');
    assert.equal(numberValue(fresh, 'block-rp-timeout'), '5000');
    assert.equal(isChecked(fresh, 'block-rp-tryinvert'), true);
    for (const cls of ['block-rp-upca', 'block-rp-code39', 'block-rp-checksum']) assert.equal(isChecked(fresh, cls), false, cls);
    // The hints: directions and the inverted pass only act with effort normal (robust forces both)
    const hints = [...fresh.matchAll(/class="rp-hint[^"]*">([^<]*)</g)].map((m) => m[1]);
    assert.equal(hints.length, 2, 'a hint next to Directions and next to Try inverted image');
    for (const hint of hints) assert.match(hint, /Normal/);

    const saved = renderBlock({ decoder: 'rosepetal', preprocessing: 'otsu', options: {
        formats: ['EAN13'], effort: 'normal', directions: 'vertical', addOn: 'require', quietZone: 'spec', minLines: 2,
        timeoutMs: 800, tryInvert: false, upcaAsEan13: true, code39FullAscii: true, checksum: true } });
    assert.equal(selectedOption(saved, 'block-rp-effort'), 'normal');
    assert.equal(selectedOption(saved, 'block-rp-directions'), 'vertical');
    assert.equal(selectedOption(saved, 'block-rp-addon'), 'require');
    assert.equal(selectedOption(saved, 'block-rp-quietzone'), 'spec');
    assert.equal(numberValue(saved, 'block-rp-minlines'), '2');
    assert.equal(numberValue(saved, 'block-rp-timeout'), '800');
    assert.equal(isChecked(saved, 'block-rp-tryinvert'), false);
    for (const cls of ['block-rp-upca', 'block-rp-code39', 'block-rp-checksum']) assert.equal(isChecked(saved, cls), true, cls);
    assert.match(saved, /<option value="otsu"\s+selected>/);

    // Legacy shapes: no options at all, or the 1.3.0 keys only (tryHarder is ignored); null counts as unset
    for (const legacy of [{ decoder: 'rosepetal' }, { decoder: 'rosepetal', options: { formats: [], tryHarder: true } },
        { decoder: 'rosepetal', options: { effort: null, tryInvert: null, minLines: null } }]) {
        const rendered = renderBlock(legacy);
        assert.equal(selectedOption(rendered, 'block-rp-effort'), 'robust', JSON.stringify(legacy));
        assert.equal(isChecked(rendered, 'block-rp-tryinvert'), true, JSON.stringify(legacy));
        assert.equal(numberValue(rendered, 'block-rp-minlines'), '0', JSON.stringify(legacy));
    }
    const zbar = renderBlock({ decoder: 'zbar', preprocessing: 'original', options: {} });
    assert.match(zbar, /<option value="zbar"\s+selected>/);
    assert.doesNotMatch(zbar, /<option value="rosepetal"\s+selected>/);
});

test('oneditsave: enums as chosen, integers as numbers (empty or invalid -> default), booleans; accepted by optionsFromBlock', () => {
    const full = saveRosepetal({
        'block-rp-effort': 'normal', 'block-rp-directions': 'vertical', 'block-rp-addon': 'require', 'block-rp-quietzone': 'spec',
        'block-rp-minlines': '2', 'block-rp-timeout': '800', 'block-rp-tryinvert': false, 'block-rp-upca': true,
        'block-rp-code39': true, 'block-rp-checksum': true
    });
    assert.deepEqual(full, { effort: 'normal', directions: 'vertical', addOn: 'require', quietZone: 'spec', minLines: 2, timeoutMs: 800,
        tryInvert: false, upcaAsEan13: true, code39FullAscii: true, checksum: true });
    assert.deepEqual(rp.optionsFromBlock({ decoder: 'rosepetal', options: full }).decodeOptions, {
        symbologies: [], effort: 'normal', horizontal: false, vertical: true, tryInvert: false, addOn: 'require',
        upcaAsEan13: true, code39FullAscii: true, optionalChecksum: true, quietZone: 'spec', minLines: 2 });
    assert.equal(rp.optionsFromBlock({ decoder: 'rosepetal', options: full }).timeoutMs, 800);

    const defaults = saveRosepetal({
        'block-rp-effort': 'robust', 'block-rp-directions': 'both', 'block-rp-addon': 'ignore', 'block-rp-quietzone': 'tolerant',
        'block-rp-minlines': '', 'block-rp-timeout': '', 'block-rp-tryinvert': true, 'block-rp-upca': false,
        'block-rp-code39': false, 'block-rp-checksum': false
    });
    assert.deepEqual(defaults, { effort: 'robust', directions: 'both', addOn: 'ignore', quietZone: 'tolerant', minLines: 0, timeoutMs: 5000,
        tryInvert: true, upcaAsEan13: false, code39FullAscii: false, checksum: false });
    assert.equal(rp.optionsFromBlock({ decoder: 'rosepetal', options: defaults }).timeoutMs, rp.DEFAULT_TIMEOUT_MS);

    // Hand-typed values the number inputs' min does not stop: never a NaN, a negative or a zero timeout in the flow
    for (const [minlines, timeout, expected] of [['-3', '-5', [0, 5000]], ['abc', '0', [0, 5000]], ['2.7', '250.9', [2, 250]], ['0', '1', [0, 1]]]) {
        const saved = saveRosepetal({ ...defaultsInputs(), 'block-rp-minlines': minlines, 'block-rp-timeout': timeout });
        assert.deepEqual([saved.minLines, saved.timeoutMs], expected, `${minlines} / ${timeout}`);
        assert.doesNotThrow(() => rp.optionsFromBlock({ decoder: 'rosepetal', options: saved }), `${minlines} / ${timeout}`);
    }
    function defaultsInputs() {
        return { 'block-rp-effort': 'robust', 'block-rp-directions': 'both', 'block-rp-addon': 'ignore', 'block-rp-quietzone': 'tolerant',
            'block-rp-tryinvert': true, 'block-rp-upca': false, 'block-rp-code39': false, 'block-rp-checksum': false };
    }
});

test('help: Rosepetal SDK section, what changes, detectedBy documented as an array', () => {
    for (const phrase of ['Rosepetal SDK', 'RP_BARCODE_ENGINE', '@rosepetal/barcode-engine-linux-x64', '@rosepetal/barcode-engine-linux-arm64',
        '@rosepetal/barcode-engine-client', 'angle', 'orientation', 'lines', 'confidence', '\\u001d', 'UPC-A as EAN-13', 'Code 39 full ASCII',
        'Timeout', '[rp-barcode]', 'Rosepetal engine not available', 'logged once per node', 'TL, TR, BR, BL', '12 digits']) {
        assert.ok(help.includes(phrase), `help mentions ${phrase}`);
    }
    for (const heading of ['<h3>Rosepetal SDK</h3>', '<dt>Rosepetal engine not available</dt>', '<li><strong>Rosepetal SDK</strong>',
        '<li><strong>Effort</strong> (Rosepetal SDK)', '<li><strong>Flags</strong> (Rosepetal SDK)']) {
        assert.ok(help.includes(heading), heading);
    }
    assert.match(help, /detectedBy: \["zbar_original", "rosepetal_original"\]/);
    assert.equal(help.includes('blocks: [0, 1]'), false);                // the old object form is gone
    assert.equal(help.includes('decoders: ['), false);
    assert.match(help, /Effort <code>normal<\/code>/);                 // directions and the inverted pass need it
    assert.match(help, /<dt>Rosepetal SDK block times out/);
});
