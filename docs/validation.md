# Validating the `rosepetal` decoder on a Node-RED

How to check, on any Node-RED, that the `rosepetal` block of barcode-reader 1.4.0 (the Rosepetal SDK engine) reads
your labels at least as well as the blocks you use today, before you change a production flow. It installs the
packages from tarballs into a Node-RED user dir, runs five single-block reader nodes over the same images and scores
the reads against known values. Site specifics (hosts, access, where images and templates live, who restarts what)
belong to **your deployment's runbook**; this page has none.

**Acceptance rule.** On the same run, the `rosepetal` block with `effort: robust` produces **0 wrong reads** against
the reference values **and 0 unexplained disagreements** with values ZBar and ZXing agree on, and **at least as many
correct reads as the best of the ZBar and ZXing blocks**. With no region carrying a reference value the result is
**not evaluable**, never "met". `rp-projection` and `rosepetal` with `effort: normal` are measured for information.

## 1. What you need

- A Node-RED (>= 3; the node's runtime floor is Node >= 18) with `@rosepetal/node-red-contrib-image-tools` for
  `rp-image-in` / `rp-cropBB`, or any other way to load a raw bitmap and to crop it (the reader accepts the raw bitmap
  `{data, width, height, channels, colorSpace}` or an encoded JPEG/PNG Buffer, single or array).
- Four tarballs, always installed together (step 2):

| Tarball | Where from |
|---|---|
| `rosepetal-node-red-contrib-barcode-reader-1.4.0.tgz` | `npm pack @rosepetal/node-red-contrib-barcode-reader@1.4.0`, or `npm pack` in a checkout of this repository |
| `rosepetal-barcode-engine-client-0.2.0.tgz` | `npm pack @rosepetal/barcode-engine-client@0.2.0` |
| `rosepetal-node-red-contrib-barcode-reader-linux-x64-<v>.tgz` (or `-linux-arm64-`, `-linuxmusl-x64-`) | the prebuilt addon: `npm pack @rosepetal/node-red-contrib-barcode-reader-linux-x64@1.4.0` once it is published, **`@1.3.0` before the `v1.4.0` tag** (the same C++). Without it the install of the node tarball drops the addon already in the user dir (the node pins `1.4.0` as an optional dependency: npm removes the other version and skips the missing one) and every `barcode-reader` node of the runtime fails to load after the restart |
| `rosepetal-barcode-engine-linux-x64-0.2.0.tgz` (or `-linux-arm64-`) | the platform package of the engine from Rosepetal's private registry, fetched **outside** the user dir with a token: `REG=europe-southwest1-npm.pkg.dev/rosepetal-artifact/private-node-packages; npm pack @rosepetal/barcode-engine-linux-x64@0.2.0 --registry=https://$REG/ "--//$REG/:_authToken=$(gcloud auth print-access-token)"`. Without it, a bare `rp-barcode` binary (SDK >= 0.2.0) and `RP_BARCODE_ENGINE=/path/to/rp-barcode` in the Node-RED environment do the same |

- Images with **known values**: a full image with several codes (the "whole" lane) and N captures with the regions of
  the codes as normalised rectangles `{x, y, w, h}` (0-1) and, for each region, the expected value (the "labels" lane).
  Regions without an expected value are scored on the check digit only and carry no truth.
- Record the versions and commits of everything you install (`npm pack` prints the version; `git rev-parse --short HEAD`
  in a checkout).

## 2. Install into the user dir

The four packages go in as **local tarballs in one `npm install`**: the node's dependency on the client (`^0.2.0`),
the client's optional dependency on the engine (`0.2.0`) and the prebuilt addon (the 1.4.0 package, or 1.3.0 installed
explicitly while 1.4.0 is not published) are satisfied by the tarballs, so npm queries no registry for them and keeps
the addon. Never run `npm install --registry=<private> …` inside the user dir (it reconciles the whole tree against that
registry), and keep the tarballs where you installed them from: `package.json` records them as `file:` specs.

- [ ] Back up `package.json` and `package-lock.json` of the user dir (the rollback in step 6 restores them).
- [ ] Install and check:

```bash
cd ~/.node-red
cp package.json package.json.pre-1.4.0 && cp package-lock.json package-lock.json.pre-1.4.0
npm install --no-audit --no-fund ./rosepetal-node-red-contrib-barcode-reader-1.4.0.tgz ./rosepetal-node-red-contrib-barcode-reader-linux-x64-<v>.tgz ./rosepetal-barcode-engine-client-0.2.0.tgz ./rosepetal-barcode-engine-linux-x64-0.2.0.tgz   # <v> = 1.3.0 before the v1.4.0 tag, 1.4.0 after
node -p "require('./node_modules/@rosepetal/node-red-contrib-barcode-reader/package.json').version"     # 1.4.0
node -p "require('./node_modules/@rosepetal/barcode-engine-client/package.json').version"               # 0.2.0
node_modules/@rosepetal/barcode-engine-linux-x64/bin/rp-barcode version                                 # rp-barcode 0.2.0 (schema 1.0, …, build <rev>)
node -e "require('./node_modules/@rosepetal/node-red-contrib-barcode-reader/node-red-contrib-barcode-reader/lib/cpp-bridge.js'); console.log('addon ok')"
node -e "console.log(require('./node_modules/@rosepetal/barcode-engine-client').resolveBinary())"        # { path: '…/bin/rp-barcode', source: '@rosepetal/barcode-engine-linux-x64' }
```

  With a bare binary instead of the engine tarball: install the node, addon and client tarballs, then either set
  `RP_BARCODE_ENGINE` in the Node-RED environment or give the binary the layout the client looks for
  (`node_modules/@rosepetal/barcode-engine-linux-x64/bin/rp-barcode`, executable, next to a `package.json` with that
  `name` and `"version": "0.2.0"`; a later `npm install` in the user dir may prune that directory).

- [ ] Restart Node-RED. The log shows no `Rosepetal engine not available` warning at start (the engine starts on the
      first decode). A `barcode-reader` node's **Decoder** select offers *Rosepetal SDK*. Existing `barcode-reader`
      nodes are untouched: a `zbar`/`zxing`/`quagga2`/`rp-projection` block produces exactly what 1.3.0 did.
- [ ] Editor check: add a block, choose *Rosepetal SDK*: the rows Effort / Directions / Add-ons / Quiet zone / Min
      lines / Timeout and the four flags appear and disappear with the decoder; type `1e3` in Timeout, deploy, and the
      exported flow has `options.timeoutMs: 1000`.

## 3. The flow

Five `barcode-reader` nodes **with one block each**, chained (not in parallel, so `msg.performance[<name>]` measures
each engine without contention), all with `inputValue: input`, `executionMode: parallel`, preprocessing `original`,
Formats = all:

| Node `name` | Block | `outputValue` |
|---|---|---|
| `val zbar` | `zbar` | `reads.zbar` |
| `val zxing` | `zxing` | `reads.zxing` |
| `val rp-projection` | `rp-projection`, `minVotes` 3 | `reads.rpproj` |
| `val rosepetal robust` | `rosepetal`, `effort: robust`, everything else default | `reads.rosepetalRobust` |
| `val rosepetal normal` | `rosepetal`, `effort: normal` | `reads.rosepetalNormal` |

If your reference values are 13-digit UPC-A (saved with barcode-reader 1.1.3) turn **UPC-A as EAN-13** on in both
`rosepetal` blocks; if Code 39 values were saved from a ZXing block (full-ASCII pairs expanded) turn **Code 39 full
ASCII** on. Say so in the report. Values are normalised before comparison anyway (`canon()` in `val score`).

```
inject "golden" (msg.set = "whole", msg.path, msg.truth, msg.outDir) ─────────────────────┐
inject "labels" (msg.set = "labels", msg.payload = msg.dir = <captures dir>, msg.truth, msg.outDir)
   → exec `ls -1` (Append msg.payload ON) ────────────────────────────────────────────────┤→ val truth
   → rp-image-in (File Path msg.path → Output msg.image) → val prepare
   val prepare out 1 (whole) ────────────────────────────────────────────────────────────────────┐
   val prepare out 2 (crops) → rp-cropBB (Image msg.image, Bounding boxes msg.rawBoxes, Raw, Min confidence 0) → crops → input ─┤
   → val zbar → val zxing → val rp-projection → val rosepetal robust → val rosepetal normal → val score → file (append, filename from msg.filename, no added newline)
inject "report" → function `msg.filename = '<outDir>/reader-<YYYY-MM-DD, UTC>.jsonl'` → file in → val report → file (overwrite, msg.filename) → debug
```

`msg.truth` is an array `[{id, rect: {x, y, w, h}, mode: "standard", matchString: "<expected value>"}]` (one entry per
region; leave `matchString` out for a region without a known value). `rp-image-in` reads the path from *File Path*
(`msg.path`) and writes the raw bitmap to *Output* (`msg.image`). `rp-cropBB` takes the image and the boxes
(`msg.rawBoxes`, `[{raw_boxes: [[x,y]×4], tag, confidence}]`) and returns the crops (each with its `tag`); check the
name of its **Output** property (the `crops → input` function reads `msg.crops`). Vertical codes need no rotation for
reading (every block reads both directions; only the geometry would change).

- [ ] Build the tab, create the output directory of `msg.outDir`, and paste the five function nodes:

```javascript
// val truth (generic): the reference comes from the inject message: msg.set ("whole" | "labels"), msg.path (whole) or
// msg.dir (labels), msg.truth = [{id, rect: {x, y, w, h} normalised 0-1, mode: "standard", matchString}] and msg.outDir.
// Regions without a matchString have no truth (check digit only). Without any truth the gate is not evaluable.
if (!Array.isArray(msg.truth) || !msg.truth.length) { node.error('msg.truth: no regions'); return null; }
if (!msg.truth.some(r => r.matchString)) { node.error('no region with a matchString: the gate is not evaluable'); return null; }
if (!msg.outDir) { node.error('msg.outDir: where to write the JSONL and the report'); return null; }
const run = msg._msgid;
if (msg.set === 'whole') return { topic: 'golden', set: 'whole', run, path: msg.path, truth: msg.truth, outDir: msg.outDir };
const files = String(msg.payload).split('\n').filter(f => /\.(png|jpe?g|bmp)$/i.test(f)).sort().slice(0, msg.limit || 20);
return [files.map((f, i) => ({ topic: 'label', set: 'labels', run, index: i, file: f, path: `${msg.dir}/${f}`, truth: msg.truth, outDir: msg.outDir }))];
```

```javascript
// val prepare (the image is in msg.image): output 1 = whole image; output 2 = rawBoxes for rp-cropBB (rect → TL, TR, BR, BL)
if (msg.set === 'whole') { msg.input = msg.image; return [msg, null]; }
const clamp = v => Math.min(1, Math.max(0, v));
msg.rawBoxes = msg.truth.map(r => {
    const x = clamp(r.rect.x), y = clamp(r.rect.y), x2 = clamp(r.rect.x + r.rect.w), y2 = clamp(r.rect.y + r.rect.h);
    return { tag: r.id, confidence: 1, raw_boxes: [[x, y], [x2, y], [x2, y2], [x, y2]] };
});
return [null, msg];
```

```javascript
// crops → input (after rp-cropBB): the array of crops is the reader input; keep the region ids to score by tag, not by
// index (a crop rp-cropBB dropped would shift every later one)
const crops = msg.crops || [];               // the Output property of rp-cropBB in the installed version
msg.input = crops;
msg.cropTags = crops.map(c => c.tag);
return msg;
```

```javascript
// val score: one JSONL row per (run, image, block[, region]). Truth = the matchString of the regions that have one;
// the other regions have no truth: expected 0, only a check digit on EAN/UPC/ITF values. `disagree` (rosepetal rows
// only): a value the SDK read where ZBar and ZXing agree on another one. ZBar/ZXing boxes in 1D are a degenerate
// scan line, so `wrong` on the whole image is indicative for those two blocks; the SDK box is the bar extent.
const blocks = { zbar: 'val zbar', zxing: 'val zxing', rpproj: 'val rp-projection', rosepetalRobust: 'val rosepetal robust', rosepetalNormal: 'val rosepetal normal' };
// format → numeric family, in the spellings of ZBar, ZXing and the SDK; anything else (Code 128/39/93, Codabar) is text
const NUMERIC = { 'UPC-A': 'upca', 'EAN-13': 'ean13', 'UPC-E': 'upce', 'EAN-8': 'ean8', 'ITF': 'itf', 'I2/5': 'itf' };
function upceToUpca(v) {                                        // 8-digit UPC-E (number system + 6 + check) → 12-digit UPC-A
    const [n, d1, d2, d3, d4, d5, d6, c] = v.split('');
    let body;
    if ('012'.includes(d6)) body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
    else if (d6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`;
    else if (d6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`;
    else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
    return `${n}${body}${c}`;
}
// canon(value, format) folds representation differences that are NOT wrong reads (readme, "Rosepetal SDK"): the GS1 HRI
// parentheses vs the GS byte (text formats only), the 13-digit UPC-A of 1.1.3 templates (EAN-13/UPC-A with a leading 0)
// and UPC-E printed as its 8 digits (ZXing, SDK) vs ZBar's 12-digit UPC-A expansion. A numeric Code 128 is never touched.
function canon(value, format) {
    let s = String(value == null ? '' : value);
    const fam = NUMERIC[format];
    if (!fam) return s.replace(/[()\u001d]/g, '');
    if ((fam === 'ean13' || fam === 'upca') && /^0\d{12}$/.test(s)) s = s.slice(1);
    if (fam === 'upce' && /^\d{8}$/.test(s)) s = upceToUpca(s);
    return s;
}
// The forms a region's truth may take after canon(): the matchString without HRI parentheses / GS, without the leading 0
// of a 13-digit UPC-A, and its UPC-A expansion when it is an 8-digit UPC-E (number system 0/1). The template's
// ignoreSpaces / caseSensitive / fieldMask are not applied.
function truthForms(r) {
    const m = String(r.matchString).replace(/[()\u001d]/g, '');
    const forms = new Set([m]);
    if (/^0\d{12}$/.test(m)) forms.add(m.slice(1));
    if (/^[01]\d{7}$/.test(m)) forms.add(upceToUpca(m));
    return [...forms];
}
function checkDigitOk(value, format) {                          // EAN-8/13, UPC-A/E (expanded), ITF-14: mod 10; text formats: n/a
    if (!NUMERIC[format]) return true;
    const v = canon(value, format);
    if (!/^(\d{8}|\d{12,14})$/.test(v)) return true;
    const d = v.split('').map(Number); const c = d.pop();
    const s = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
    return (10 - s % 10) % 10 === c;
}
const boxesOverlap = (a, b) => !!(a && a.center && a.size && b && b.center && b.size)
    && Math.abs(a.center.x - b.center.x) < (a.size.width + b.size.width) / 2
    && Math.abs(a.center.y - b.center.y) < (a.size.height + b.size.height) / 2;
const rectBox = r => ({ center: { x: r.rect.x + r.rect.w / 2, y: r.rect.y + r.rect.h / 2 }, size: { width: r.rect.w, height: r.rect.h } });
const cv = x => canon(x.value, x.format);
const rows = [];
const out = (row) => rows.push({ run: msg.run, image: msg.path, ...row });
const readsOf = b => (msg.reads && msg.reads[b]) || [];
const msOf = name => { const perf = msg.performance && msg.performance[name]; return perf ? perf.milliseconds : null; };
if (msg.set === 'whole') {
    const std = msg.truth.filter(r => r.matchString);
    const expected = std.map(truthForms);
    const zb = readsOf('zbar'), zx = readsOf('zxing');
    const agreed = zb.filter(a => zx.some(b => cv(b) === cv(a)));       // values ZBar and ZXing both read
    for (const [b, name] of Object.entries(blocks)) {
        const reads = readsOf(b);
        const values = reads.map(cv);
        const correct = expected.filter(forms => forms.some(f => values.includes(f))).length;
        // a read overlapping a region with truth, with another value, is a misread (even without a check digit);
        // anything else is `extra`, listed to check by hand
        const unexpected = reads.filter(x => !expected.some(forms => forms.includes(cv(x))));
        const wrong = unexpected.filter(x => std.some(r => boxesOverlap(x.box, rectBox(r)))).length;
        const extras = unexpected.filter(x => !std.some(r => boxesOverlap(x.box, rectBox(r)))).map(x => `${x.format}:${cv(x)}`);
        const disagree = b.startsWith('rosepetal') ? reads.filter(x => agreed.some(a => boxesOverlap(x.box, a.box) && cv(a) !== cv(x))).length : 0;
        out({ set: 'whole', block: b, expected: expected.length, reads: values.length, correct, wrong, extra: extras.length, disagree, extras, ms: msOf(name), values: reads.map(x => `${x.format}:${x.value}`) });
    }
} else {
    const tags = msg.cropTags || msg.truth.map(r => r.id);
    for (const [b, name] of Object.entries(blocks)) {
        readsOf(b).forEach((list, i) => {
            const r = msg.truth.find(t => t.id === tags[i]);
            if (!r) return;
            const reads = list || [];
            const values = reads.map(cv);
            let expected = 0, correct = 0, wrong = 0;
            if (r.matchString) {
                expected = 1; const forms = truthForms(r);
                correct = forms.some(f => values.includes(f)) ? 1 : 0;
                wrong = values.filter(v => !forms.includes(v)).length;
            } else {
                wrong = reads.filter(x => !checkDigitOk(x.value, x.format)).length;   // no truth: check digit only
            }
            let disagree = 0;
            if (b.startsWith('rosepetal')) {
                const zb = (readsOf('zbar')[i] || []).map(cv), zx = (readsOf('zxing')[i] || []).map(cv);
                const agreed = zb.filter(v => zx.includes(v));
                disagree = values.filter(v => agreed.length && !agreed.includes(v)).length;
            }
            out({ set: 'labels', region: r.id, mode: r.mode, block: b, expected, reads: values.length, correct, wrong, extra: 0, disagree, ms: msOf(name), values: reads.map(x => `${x.format}:${x.value}`) });
        });
    }
}
msg.filename = `${msg.outDir}/reader-${new Date().toISOString().slice(0, 10)}.jsonl`;
msg.payload = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
return msg;                                                       // → file node: append, filename from msg, no added newline
```

```javascript
// val report (file in → function): Markdown tables per set and block, region × block for the labels, the flagged rows
// and the gate. ms = one sample per (run, image): the rows of one label share the node time of the whole array of
// crops; the first sample of each rosepetal block (engine start) is shown apart and excluded from p50/p95/max.
const rows = String(msg.payload).trim().split('\n').filter(Boolean).map(JSON.parse);
const q = (a, p) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const blocks = ['zbar', 'zxing', 'rpproj', 'rosepetalRobust', 'rosepetalNormal'];
const key = r => `${r.image}|${r.run}`;
const runs = new Set(rows.map(r => r.run)).size;
const sumOf = (rs, k) => rs.reduce((a, r) => a + (r[k] || 0), 0);
let out = `# reader validation ${new Date().toISOString().slice(0, 10)} (${rows.length} rows, ${runs} runs)\n`;
const allRegions = [...new Set(rows.filter(r => r.set === 'labels').map(r => r.region))];
const truthRegions = allRegions.filter(reg => rows.some(r => r.region === reg && r.expected));
const wholeExpected = (rows.find(r => r.set === 'whole') || {}).expected || 0;
out += `\nRegions with a reference value: ${truthRegions.length} of ${allRegions.length} (${truthRegions.join(', ') || 'none'}); whole-image expected values per run: ${wholeExpected}\n`;
for (const set of ['whole', 'labels']) {
    out += `\n## ${set}\n\n| block | rows | expected | reads | correct | wrong | extra | disagree | no-read | first ms | p50 ms | p95 ms | max ms |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const b of blocks) {
        const rs = rows.filter(r => r.set === set && r.block === b);
        const samples = [...new Set(rs.map(key))].map(k => rs.find(r => key(r) === k).ms).filter(x => x != null);
        const first = b.startsWith('rosepetal') && samples.length ? samples.shift() : null;
        out += `| ${b} | ${rs.length} | ${sumOf(rs, 'expected')} | ${sumOf(rs, 'reads')} | ${sumOf(rs, 'correct')} | ${sumOf(rs, 'wrong')} | ${sumOf(rs, 'extra')} | ${sumOf(rs, 'disagree')} | ${sumOf(rs, 'expected') - sumOf(rs, 'correct')} | ${first == null ? '-' : first} | ${q(samples, 0.5)} | ${q(samples, 0.95)} | ${samples.length ? Math.max(...samples) : '-'} |\n`;
    }
    const extras = rows.filter(r => r.set === set && (r.extras || []).length).map(r => `${r.block}: ${r.extras.join(', ')} (${r.image})`);
    if (extras.length) out += `\n_Extra reads outside every region with truth, to check by hand:_ ${extras.join('; ')}\n`;
}
if (allRegions.length) {
    out += `\n## labels, per region (correct / wrong / disagree / no-read)\n\n| region | mode | ${blocks.join(' | ')} |\n|---|---|${blocks.map(() => '---').join('|')}|\n`;
    for (const reg of allRegions) {
        const mode = (rows.find(r => r.region === reg) || {}).mode || '';
        const cells = blocks.map(b => {
            const rs = rows.filter(r => r.set === 'labels' && r.region === reg && r.block === b);
            return `${sumOf(rs, 'correct')} / ${sumOf(rs, 'wrong')} / ${sumOf(rs, 'disagree')} / ${sumOf(rs, 'expected') - sumOf(rs, 'correct')}`;
        });
        out += `| ${reg} | ${mode} | ${cells.join(' | ')} |\n`;
    }
}
const flagged = rows.filter(r => r.wrong || r.disagree);
if (flagged.length) out += `\n## wrong reads and disagreements\n\n${flagged.map(r => `- ${r.block} ${r.set} ${r.region || ''} run ${r.run} ${r.image}: ${(r.values || []).join(', ')}${r.disagree ? ' (disagree)' : ''}`).join('\n')}\n`;
const sumB = (b, k) => sumOf(rows.filter(r => r.block === b), k);
const evaluable = truthRegions.length > 0 || wholeExpected > 0;
const wrong = sumB('rosepetalRobust', 'wrong'), disagree = sumB('rosepetalRobust', 'disagree');
const best = Math.max(sumB('zbar', 'correct'), sumB('zxing', 'correct')), mine = sumB('rosepetalRobust', 'correct');
const verdict = !evaluable ? 'NOT EVALUABLE: no region with a reference value'
    : wrong > 0 || mine < best ? `NOT MET (wrong ${wrong}, correct ${mine} vs best of ZBar/ZXing ${best})`
    : disagree > 0 ? `MET only if each of the ${disagree} disagreements is explained in the report (wrong 0, correct ${mine} vs ${best})`
    : `MET (wrong 0, disagree 0, correct ${mine} vs best of ZBar/ZXing ${best})`;
out += `\n## gate (rosepetalRobust)\n\n${verdict}\n`;
msg.payload = out; msg.filename = msg.filename.replace(/\.jsonl$/, '.md'); return msg;
```

## 4. Run

- [ ] Deploy. Inject **golden** once; a `debug` node after `val rosepetal normal` shows the five `reads.*` arrays and
      the five `msg.performance` keys; the Node-RED log shows `Rosepetal engine 0.2.0+<rev> (protocol 1, pid N)` and no
      `Rosepetal engine not available` warning.
- [ ] Inject **labels** (N messages; each `ms` covers the whole array of crops of one label).
- [ ] Repeat **golden** and **labels** two more times (three runs, told apart by `run`; the first `rosepetal` decode of
      the session pays the engine start: the `first ms` column).
- [ ] Inject **report**; read the `.md` (the `gate` section applies the rule) and keep the `.jsonl`, the report, the
      Node-RED log lines of the engine, the machine facts (CPU, cores, Node version) and the exported flow.

## 5. Verdict

Read the `gate` section and the tables: regions with a reference value (0 → not evaluable), wrong reads of
`rosepetalRobust` (must be 0), disagreements (0, or each explained: a representation difference such as GS1 HRI vs
`\u001d`, UPC-E 8 vs 12 digits, Code 39 full-ASCII pairs or add-ons read as separate `EAN-2`/`EAN-5` symbols is not a
wrong read; a different value at the same place is), correct reads against the best of ZBar/ZXing, and for information
`rpproj`, `rosepetalNormal`, the p50 per label against your inspection budget and the `first ms` engine start.
`wrong` of the ZBar/ZXing rows on the whole image is indicative only (their 1D boxes are a scan line).

## 6. Roll back

```bash
cd ~/.node-red
cp package.json.pre-1.4.0 package.json && cp package-lock.json.pre-1.4.0 package-lock.json
npm install --no-audit --no-fund
rm -f rosepetal-node-red-contrib-barcode-reader-1.4.0.tgz rosepetal-node-red-contrib-barcode-reader-linux-x64-<v>.tgz rosepetal-barcode-engine-client-0.2.0.tgz rosepetal-barcode-engine-linux-x64-0.2.0.tgz
```

Then restart Node-RED. If your Node-RED image keeps its own record of user-installed packages, check it after the
rollback (your deployment's runbook says where): it must no longer list the client, the engine or the addon tarball. Disable or delete the validation tab: its two `rosepetal` nodes hold
the engine while deployed (the process stops when the last node with a `rosepetal` block closes).
