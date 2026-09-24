# Validation of the `rosepetal` decoder on aisvision2 (runbook)

Gate of Phase 2 of [`rosepetal-barcode-sdk`](https://github.com/rosepetal-ai/rosepetal-barcode-sdk)
(`docs/plans/fase2/00-overview.md` §6, decision D8): barcode-reader **1.4.0** with the Rosepetal SDK engine as a 1D
decoder, run through the print-inspection flows of the real machine, against the decoders the flows use today.

This runbook is written for an agent (or a person) working **on the machine** with a shell, the Node-RED editor or
the Node-RED MCP server of `rosepetal-dep-aisvision2`. Nothing here publishes a package, tags a release or changes
the controller image: the node, the client and the engine are installed into the running `node-red` container from
tarballs, and that install is lost at the next image update (see step 6).

**Acceptance rule** (overview §6): on the same run, the `rosepetal` block with `effort: robust` produces
**0 wrong reads** against the `matchString` of the active template, and **at least as many correct reads as the best
of the ZBar and ZXing blocks**. `rp-projection` and `rosepetal` with `effort: normal` are measured for information.

## 0. Machine facts

| | |
|---|---|
| Controller | `rosepetal-dep-aisvision2` (the local V275 print line; the MCP server called `aisvision2` is this box) |
| Node-RED | 5.0.7 in the Docker container `node-red` (`container_name: node-red`, host network), user dir `/root/.node-red`, editor `http://<host>:1880/nodered` on the LAN or `https://1880-<controller>.rpctrl.net` from outside |
| Access | SSH over Tailscale (`tailscale status \| grep -i aisvision2` gives the name; `ssh root@<name>`), the editor, or the Node-RED MCP tools (`get-flows`, `create-flow`, `inject`, `get-debug-messages`, `capture-flow`) |
| Storage | `/opt/storage/print-profiler/<templateId>/golden.png` (golden of a template), `/opt/storage/images/print-demo/ais/` (50 real captures of the AIS label, 2455×2453, from PR #23 of print-profiler); both visible inside the container |
| Active template | `global.printProfiler.template` (`{id, name, image: {golden: 'golden.png', width, height}, regions: [{id, name, kind, rect: {x, y, w, h} normalised 0-1, orientation 0/90/180/270, params, matching: {mode, matchString, …}}]}`), set by the print-profiler flow when a template is activated; `global.printProfiler.golden` holds the loaded golden bitmap |
| Installed today | `@rosepetal/node-red-contrib-barcode-reader` **1.1.3** (baked into the image, pin `1.1.x`), no engine |

## 1. Prerequisites

- [ ] Access to the machine (shell and editor or MCP). The container can reach `registry.npmjs.org` (the palette
      install works); if it cannot, also bring the tarballs of `@rosepetal/node-red-contrib-barcode-reader-linux-x64@1.3.0`
      and `@ericblade/quagga2@1.12.1` (`npm pack <name>@<version>` on a host with access) and add them to the
      `npm install` of step 2.
- [ ] The **AIS** template is the active one in print-profiler (regions of kind `barcode1d` with a `matchString`), its
      golden exists and the 50 captures are under `/opt/storage/images/print-demo/ais/`. With another template active,
      use its regions and captures: the protocol does not depend on the label. Check from the shell:

```bash
ssh root@<aisvision2> 'docker exec node-red node -p "require(\"/root/.node-red/node_modules/@rosepetal/node-red-contrib-barcode-reader/package.json\").version"'   # 1.1.3 expected
ssh root@<aisvision2> 'ls /opt/storage/print-profiler/ && ls /opt/storage/images/print-demo/ais | head -3 && ls /opt/storage/images/print-demo/ais | wc -l'
```

- [ ] **Three tarballs**, built on a development host (Node >= 22.9, Go 1.27) from the commits under test, or fetched
      from the registries once they are published. Copy them to `/tmp/` on the machine.

| Tarball | From a checkout (before publication) | From the registries (after publication) |
|---|---|---|
| `rosepetal-node-red-contrib-barcode-reader-1.4.0.tgz` | `cd node-red-contrib-barcode-reader && npm pack` (27 files with the `.npmignore` of 1.4.0) | `npm pack @rosepetal/node-red-contrib-barcode-reader@1.4.0` |
| `rosepetal-barcode-engine-client-0.2.0.tgz` | `npm pack /path/to/rosepetal-barcode-sdk/clients/node` | `npm pack @rosepetal/barcode-engine-client@0.2.0` |
| `rosepetal-barcode-engine-linux-x64-0.2.0.tgz` | `cd rosepetal-barcode-sdk && make cross ARCHS=amd64 && scripts/engine-package.sh --version 0.2.0 amd64 && (cd dist/npm/linux-x64 && npm pack)` | `REG=europe-southwest1-npm.pkg.dev/rosepetal-artifact/private-node-packages; npm pack @rosepetal/barcode-engine-linux-x64@0.2.0 --registry=https://$REG/ "--//$REG/:_authToken=$(gcloud auth print-access-token)"` (token from `gcloud auth login`, valid 1 h) |

  Record the commit of each repository the tarballs come from (`git rev-parse --short HEAD`) for the report. The engine
  tarball is the platform package the client looks for (`node_modules/@rosepetal/barcode-engine-linux-x64/bin/rp-barcode`);
  if you only have the bare `rp-barcode` binary, see the alternative in step 2.

```bash
scp rosepetal-node-red-contrib-barcode-reader-1.4.0.tgz rosepetal-barcode-engine-client-0.2.0.tgz rosepetal-barcode-engine-linux-x64-0.2.0.tgz root@<aisvision2>:/tmp/
```

## 2. Install into the running container (no image rebuild)

The three packages go in as **local tarballs in one `npm install`**, on purpose: the node's dependency on the client
(`^0.2.0`) and the client's optional dependency on the engine (`0.2.0`) are satisfied by the tarballs, so npm queries
no registry for them. Never run `npm install --registry=<private> …` inside `/root/.node-red`: it reconciles the whole
user dir against that registry and prunes what it cannot find there.

- [ ] Copy the tarballs into the container and install:

```bash
ssh root@<aisvision2> 'for f in rosepetal-node-red-contrib-barcode-reader-1.4.0.tgz rosepetal-barcode-engine-client-0.2.0.tgz rosepetal-barcode-engine-linux-x64-0.2.0.tgz; do docker cp /tmp/$f node-red:/root/.node-red/$f; done'
ssh root@<aisvision2> "docker exec node-red sh -ec '
  cd /root/.node-red
  npm install --no-audit --no-fund ./rosepetal-node-red-contrib-barcode-reader-1.4.0.tgz ./rosepetal-barcode-engine-client-0.2.0.tgz ./rosepetal-barcode-engine-linux-x64-0.2.0.tgz
  rm -f ./rosepetal-node-red-contrib-barcode-reader-1.4.0.tgz ./rosepetal-barcode-engine-client-0.2.0.tgz ./rosepetal-barcode-engine-linux-x64-0.2.0.tgz
  node -p \"require(\\\"./node_modules/@rosepetal/node-red-contrib-barcode-reader/package.json\\\").version\"
  node -p \"require(\\\"./node_modules/@rosepetal/barcode-engine-client/package.json\\\").version\"
  node_modules/@rosepetal/barcode-engine-linux-x64/bin/rp-barcode version
  node -e \"require(\\\"./node_modules/@rosepetal/node-red-contrib-barcode-reader/node-red-contrib-barcode-reader/lib/cpp-bridge.js\\\"); console.log(\\\"addon ok\\\")\"
  node -e \"console.log(require(\\\"./node_modules/@rosepetal/barcode-engine-client\\\").resolveBinary())\"'"
```

  Expected: `1.4.0`, `0.2.0`, `rp-barcode 0.2.0 (schema 1.0, GS1 Syntax Dictionary …, build <rev>)`, `addon ok` and
  `{ path: '/root/.node-red/node_modules/@rosepetal/barcode-engine-linux-x64/bin/rp-barcode', source: '@rosepetal/barcode-engine-linux-x64' }`.

- [ ] *Alternative with a bare binary* (no engine tarball): give it the layout the client looks for. A later
      `npm install` in the user dir may prune this directory as extraneous; re-create it then.

```bash
ssh root@<aisvision2> 'docker cp /tmp/rp-barcode node-red:/tmp/rp-barcode && docker exec node-red sh -ec "
  d=/root/.node-red/node_modules/@rosepetal/barcode-engine-linux-x64; mkdir -p \$d/bin && mv /tmp/rp-barcode \$d/bin/rp-barcode && chmod 755 \$d/bin/rp-barcode
  printf %s\\\\n \"{\\\"name\\\":\\\"@rosepetal/barcode-engine-linux-x64\\\",\\\"version\\\":\\\"0.2.0\\\"}\" > \$d/package.json
  \$d/bin/rp-barcode version"'
```

  (`RP_BARCODE_ENGINE` would also work, but the container's environment is set by the compose file of the controller:
  do not edit it for a validation.)

- [ ] Restart Node-RED and check the log and the palette:

```bash
ssh root@<aisvision2> 'docker restart node-red && sleep 20 && docker logs --since 2m node-red 2>&1 | grep -iE "barcode|rosepetal|rp-barcode|error" | head -20'
```

  In the editor (or `get-node-schema barcode-reader` through the MCP), a `barcode-reader` node's **Decoder** select now
  offers *Rosepetal SDK*. Existing flows and their `barcode-reader` nodes are untouched: a `zbar`/`zxing`/`quagga2` block
  produces exactly what 1.3.0 did, and 1.1.3 flows load as before (per-block `formats` are `[]` = all).

- [ ] **Editor check** (deferred from the 2B review): open one `barcode-reader` node, add a block, choose *Rosepetal SDK*:
      the rows Effort / Directions / Add-ons / Quiet zone / Min lines / Timeout and the four flags appear, the
      Preprocessing select stays, and switching back to ZBar hides them. Type `1e3` in Timeout, Deploy, and check in the
      exported flow JSON that `options.timeoutMs` is `1000` (a number). Note anything visually off in the report.

## 3. The validation flow (new tab "Barcode SDK validation")

Five `barcode-reader` nodes **with one block each**, chained (not in parallel: `msg.performance[<name>]` then measures
each engine without contention), all with `inputValue: input`, `executionMode: parallel`, preprocessing `original`,
Formats = all (empty list):

| Node `name` | Block | `outputValue` |
|---|---|---|
| `val zbar` | `zbar` | `reads.zbar` |
| `val zxing` | `zxing` | `reads.zxing` |
| `val rp-projection` | `rp-projection`, `minVotes` 3 | `reads.rpproj` |
| `val rosepetal robust` | `rosepetal`, `effort: robust`, everything else default | `reads.rosepetalRobust` |
| `val rosepetal normal` | `rosepetal`, `effort: normal` | `reads.rosepetalNormal` |

If the template stores 13-digit UPC-A values (templates saved with 1.1.3 do), turn **UPC-A as EAN-13** on in both
`rosepetal` blocks and say so in the report. Values are normalised before comparison anyway (step 3, `val score`).

Two lanes, like the print-inspection flows: the **whole golden image** (what the `as codes` auto-setup lane sees) and
**20 real label captures cropped with the template's `rect`** (what the `in read barcode` lane sees; no alignment step,
so a misplaced crop affects every block alike).

```
inject "golden"  (msg.set = "whole") ──────────────────────────────────┐
inject "labels" → exec `ls -1 /opt/storage/images/print-demo/ais` ─────┤→ val truth → rp-image-in (File Path msg.path → Output msg.image) → val prepare
   val prepare out 1 (whole) ─────────────────────────────────────────────────────────────────────┐
   val prepare out 2 (crops) → rp-cropBB (Image msg.image, Bounding boxes msg.rawBoxes, Raw) → function `msg.input = <crops>` ─┤
   → val zbar → val zxing → val rp-projection → val rosepetal robust → val rosepetal normal → val score → file (append, filename from msg.filename)
inject "report" → function `msg.filename = '/opt/storage/print-profiler/validation/reader-<YYYY-MM-DD>.jsonl'` → file in → val report → file (overwrite, msg.filename) → debug
```

Notes on the image-tools nodes (check each node's help for the property names in the installed version):
`rp-image-in` reads the path from *File Path* (`msg.path`) and writes the raw bitmap to *Output* (`msg.image`); it always
returns RGB. `rp-cropBB` takes the image (`msg.image`) and the boxes (`msg.rawBoxes`, `[{raw_boxes: [[x,y]×4], tag,
confidence}]`, normalised 0-1) and returns the array of crops (each a raw bitmap with `tag`, `confidence`, `bbox`); set
its Min confidence to 0 and Output format to Raw. Regions with `orientation` 90/270 need no `rp-rotate` for reading
(every block reads both directions; only the geometry would change), so the crops go in as they are. `rp-cropBB` rejects
4-channel images: the golden from `rp-image-in` is RGB, fine.

- [ ] Create the tab, the nodes and the wiring (editor import or MCP `create-flow`/`create-node`; `get-node-schema`
      gives the exact property names of `barcode-reader` and the image-tools nodes; `capture-flow` to check the layout).
- [ ] `mkdir -p /opt/storage/print-profiler/validation` (`docker exec node-red mkdir -p …`).
- [ ] The four function nodes:

```javascript
// val truth: whole-image set (inject "golden", msg.set = "whole") = the `as codes` lane; labels set (exec stdout)
// = the `in read barcode` lane. Truth = the barcode1d regions of the active template.
const pp = global.get('printProfiler');
const t = pp && pp.template;
if (!t) { node.error('no active template (activate the AIS template first)'); return null; }
const truth = (t.regions || []).filter(r => r.kind === 'barcode1d').map(r => ({
    id: r.id, name: r.name, rect: r.rect, orientation: r.orientation || 0,
    mode: (r.matching && r.matching.mode) || 'standard',
    matchString: (r.matching && r.matching.matchString) || null
}));
if (!truth.length) { node.error('the active template has no barcode1d region'); return null; }
const storeDir = '/opt/storage/print-profiler';
if (msg.set === 'whole') {
    return { topic: 'golden', set: 'whole', templateId: t.id, path: `${storeDir}/${t.id}/${(t.image && t.image.golden) || 'golden.png'}`, truth };
}
const dir = '/opt/storage/images/print-demo/ais';
const files = String(msg.payload).split('\n').filter(f => /\.(png|jpe?g|bmp)$/i.test(f)).sort().slice(0, 20);
return [files.map((f, i) => ({ topic: 'label', set: 'labels', templateId: t.id, index: i, path: `${dir}/${f}`, truth }))];
```

```javascript
// val prepare (after rp-image-in): output 1 = whole image; output 2 = rawBoxes for rp-cropBB (rect → TL, TR, BR, BL)
if (msg.set === 'whole') { msg.input = msg.image; return [msg, null]; }
const clamp = v => Math.min(1, Math.max(0, v));
msg.rawBoxes = msg.truth.map(r => {
    const x = clamp(r.rect.x), y = clamp(r.rect.y), x2 = clamp(r.rect.x + r.rect.w), y2 = clamp(r.rect.y + r.rect.h);
    return { tag: r.id, confidence: 1, raw_boxes: [[x, y], [x2, y], [x2, y2], [x, y2]] };
});
return [null, msg];
```

```javascript
// val score: one JSONL row per (image, block[, region]); truth = matchString of the standard regions.
// canon() removes representation differences that are NOT wrong reads (1.4.0 readme, "Rosepetal SDK"): GS1 HRI
// parentheses vs the GS byte, the 13-digit UPC-A of 1.1.3 templates, and UPC-E printed as its 8 digits (ZXing, SDK)
// vs ZBar's 12-digit UPC-A expansion.
const blocks = { zbar: 'val zbar', zxing: 'val zxing', rpproj: 'val rp-projection', rosepetalRobust: 'val rosepetal robust', rosepetalNormal: 'val rosepetal normal' };
function upceToUpca(v) {                       // 8-digit UPC-E (number system + 6 + check) → 12-digit UPC-A
    const [n, d1, d2, d3, d4, d5, d6, c] = v.split('');
    let body;
    if ('012'.includes(d6)) body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
    else if (d6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`;
    else if (d6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`;
    else body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
    return `${n}${body}${c}`;
}
function canon(v) {
    let s = String(v == null ? '' : v).replace(/[()\u001d]/g, '');
    if (/^0\d{12}$/.test(s)) s = s.slice(1);                    // 13-digit UPC-A (1.1.3) → 12
    if (/^[01]\d{7}$/.test(s)) s = upceToUpca(s);               // UPC-E → its UPC-A expansion
    return s;
}
function checkDigitOk(v) {                                       // EAN-8/13, UPC-A, ITF-14: mod 10
    if (!/^(\d{8}|\d{12,14})$/.test(v)) return true;
    const d = v.split('').map(Number); const c = d.pop();
    const s = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
    return (10 - s % 10) % 10 === c;
}
const rows = [];
for (const [b, name] of Object.entries(blocks)) {
    const perf = msg.performance && msg.performance[name];
    const ms = perf ? perf.milliseconds : null;
    const reads = (msg.reads && msg.reads[b]) || [];
    if (msg.set === 'whole') {
        const values = reads.map(r => canon(r.value));
        const std = msg.truth.filter(r => r.mode === 'standard' && r.matchString);
        const expected = std.map(r => canon(r.matchString));
        const correct = expected.filter(e => values.includes(e)).length;
        // a box overlapping a standard region's rect with a value that is not its matchString is a misread even without a
        // check digit (Code 128 / 39 / 93 / Codabar have none); anything else is `extra`, listed by value to check by hand
        const overlaps = (x, r) => !!(x.box && x.box.center && x.box.size)
            && Math.abs(x.box.center.x - (r.rect.x + r.rect.w / 2)) < (x.box.size.width + r.rect.w) / 2
            && Math.abs(x.box.center.y - (r.rect.y + r.rect.h / 2)) < (x.box.size.height + r.rect.h) / 2;
        const unexpected = reads.filter(x => !expected.includes(canon(x.value)));
        const wrong = unexpected.filter(x => std.some(r => overlaps(x, r))).length;
        const extras = unexpected.filter(x => !std.some(r => overlaps(x, r))).map(x => `${x.format}:${canon(x.value)}`);
        rows.push({ set: 'whole', image: msg.path, block: b, expected: expected.length, reads: values.length, correct, wrong, extra: extras.length, extras, ms,
                    formats: reads.map(r => r.format) });
    } else {
        reads.forEach((list, i) => {
            const r = msg.truth[i]; const values = (list || []).map(x => canon(x.value));
            let correct = 0, wrong = 0, expected = 0;
            if (r.mode === 'standard' && r.matchString) {
                expected = 1; const e = canon(r.matchString);
                correct = values.includes(e) ? 1 : 0; wrong = values.filter(v => v !== e).length;
            } else {
                wrong = values.filter(v => !checkDigitOk(v)).length;   // dynamic value: check digit only
            }
            rows.push({ set: 'labels', image: msg.path, region: r.id, block: b, expected, reads: values.length, correct, wrong, extra: 0, ms,
                        values: (list || []).map(x => `${x.format}:${x.value}`) });
        });
    }
}
msg.filename = `/opt/storage/print-profiler/validation/reader-${new Date().toISOString().slice(0, 10)}.jsonl`;
msg.payload = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
return msg;                                                       // → file node: append, filename from msg, no extra newline
```

```javascript
// val report (file in → function): Markdown tables per set and block, plus region × block for the labels.
// ms = per image (the rows of one label share the node time of the whole array of crops)
const rows = String(msg.payload).trim().split('\n').filter(Boolean).map(JSON.parse);
const q = (a, p) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const blocks = ['zbar', 'zxing', 'rpproj', 'rosepetalRobust', 'rosepetalNormal'];
let out = `# reader validation ${new Date().toISOString().slice(0, 10)} (${rows.length} rows)\n`;
for (const set of ['whole', 'labels']) {
    out += `\n## ${set}\n\n| block | rows | expected | reads | correct | wrong | extra | no-read | p50 ms | p95 ms | max ms |\n|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const b of blocks) {
        const rs = rows.filter(r => r.set === set && r.block === b);
        const sum = k => rs.reduce((a, r) => a + (r[k] || 0), 0);
        const times = [...new Set(rs.map(r => r.image))].map(img => (rs.find(r => r.image === img) || {}).ms).filter(x => x != null);
        out += `| ${b} | ${rs.length} | ${sum('expected')} | ${sum('reads')} | ${sum('correct')} | ${sum('wrong')} | ${sum('extra')} | ${sum('expected') - sum('correct')} | ${q(times, 0.5)} | ${q(times, 0.95)} | ${times.length ? Math.max(...times) : '-'} |\n`;
    }
    const extras = rows.filter(r => r.set === set && (r.extras || []).length).map(r => `${r.block}: ${r.extras.join(', ')} (${r.image})`);
    if (extras.length) out += `\n_Extra reads outside every standard region, to check by hand:_ ${extras.join('; ')}\n`;
}
const regions = [...new Set(rows.filter(r => r.set === 'labels').map(r => r.region))];
if (regions.length) {
    out += `\n## labels, per region (correct / wrong / no-read)\n\n| region | ${blocks.join(' | ')} |\n|---|${blocks.map(() => '---').join('|')}|\n`;
    for (const reg of regions) {
        const cells = blocks.map(b => {
            const rs = rows.filter(r => r.set === 'labels' && r.region === reg && r.block === b);
            const sum = k => rs.reduce((a, r) => a + (r[k] || 0), 0);
            return `${sum('correct')} / ${sum('wrong')} / ${sum('expected') - sum('correct')}`;
        });
        out += `| ${reg} | ${cells.join(' | ')} |\n`;
    }
}
const wrongRows = rows.filter(r => r.wrong);
if (wrongRows.length) out += `\n## wrong reads\n\n${wrongRows.map(r => `- ${r.block} ${r.set} ${r.region || ''} ${r.image}: ${(r.values || r.extras || []).join(', ')}`).join('\n')}\n`;
msg.payload = out; msg.filename = msg.filename.replace(/\.jsonl$/, '.md'); return msg;
```

## 4. Run

- [ ] Deploy. Inject **golden** once; in a `debug` node after `val rosepetal normal` check that `reads.zbar`,
      `reads.zxing`, `reads.rpproj`, `reads.rosepetalRobust`, `reads.rosepetalNormal` exist and that `msg.performance`
      has the five keys. Check `docker logs node-red 2>&1 | grep -i "Rosepetal engine"` shows the version line
      (`Rosepetal engine 0.2.0+<rev> (protocol 1, pid N)`) and no `Rosepetal engine not available` warning.
- [ ] Inject **labels** (20 messages; each `ms` covers the whole array of crops of one label).
- [ ] Repeat **golden** and **labels** two more times (three runs in the JSONL; the first `rosepetal` decode of the
      session pays the engine start and shows up as an isolated p95/max: say so in the report).
- [ ] Inject **report**; read the `.md` in the debug pane.
- [ ] Collect:

```bash
scp "root@<aisvision2>:/opt/storage/print-profiler/validation/reader-$(date +%F).{jsonl,md}" .
ssh root@<aisvision2> 'docker logs node-red 2>&1 | grep -iE "Rosepetal engine|rp-barcode|Block [0-9]+ \(rosepetal\)" | tail -20; nproc; grep "model name" /proc/cpuinfo | head -1; docker exec node-red node --version; docker inspect --format "{{.Config.Image}}" node-red'
sha256sum reader-*.jsonl
```

  plus the flow of the tab, exported from the editor (menu → Export → current flow → JSON) or with the MCP `get-flow`.

## 5. Verdict and report

Apply the acceptance rule to the tables of `val report` (the `rosepetalRobust` row of each set):

- wrong reads of `rosepetalRobust` = **0** in both sets;
- correct reads of `rosepetalRobust` >= max(correct of `zbar`, correct of `zxing`) in both sets;
- for information: `rpproj`, `rosepetalNormal`, the p50 per label (array of N crops) against the inspection-lane target
  `inspectMs < 500 ms` (R-NR-15 of the SDK's consumer requirements), the engine start on the first decode.

Before counting a read as wrong, open the row's `values` / `extras`: a difference of representation only (GS1 HRI vs
`\u001d`, UPC-E 8 vs 12 digits, Code 39 full-ASCII pairs, add-ons read as separate `EAN-2`/`EAN-5` symbols) is a
documented difference, not a misread; `canon()` already folds the first two. A `rosepetal` read that is a real
different value at a region's place is a wrong read.

- [ ] Write the report in the SDK repository as `docs/benchmarks/<YYYY-MM-DD>-reader-aisvision2.md` and add its row
      to `docs/benchmarks/README.md` (that directory is written in Spanish). Template:

````markdown
# Validación en aisvision2 — bloque `rosepetal` de barcode-reader 1.4.0 frente a ZBar / ZXing / rp-projection

Puerta de la Fase 2 (`docs/plans/fase2/00-overview.md` §6, D8): flows de print-profiler en la máquina real con el SDK
como motor 1D. Regla: **0 lecturas erróneas** del bloque `rosepetal` (robusto) frente a los `matchString` de la
plantilla y **≥ lecturas correctas que el mejor bloque ZBar/ZXing** en la misma tirada.

| | |
|---|---|
| Máquina | `rosepetal-dep-aisvision2`, CPU <modelo>, <n> núcleos, Node <v> en el contenedor `node-red` (imagen `<image:tag>`) |
| Paquetes | `@rosepetal/node-red-contrib-barcode-reader` 1.4.0 (<commit>, instalado en el user dir desde tarball, no horneado), `@rosepetal/barcode-engine-client` 0.2.0 (<commit>), `@rosepetal/barcode-engine-linux-x64` 0.2.0 (`engineVersion` <0.2.0+rev> del `node.log`) |
| Plantilla | `<nombre>` (`<id>`), <n> regiones `barcode1d` (<n> estándar con `matchString`, <n> dinámicas), golden `<ruta>` <W×H> |
| Etiquetas reales | 20 primeras de `/opt/storage/images/print-demo/ais/` (V275, 2455×2453), sin alineado (`rect` de la plantilla directamente) |
| Bloques | `zbar_original`, `zxing_original`, `rp-projection` (minVotes 3), `rosepetal_original` robust, `rosepetal_original` normal; un nodo por bloque, en cadena |
| Normalización | paréntesis y `0x1D` quitados (GS1 HRI vs separadores), `0` inicial quitado a los numéricos de 13 dígitos (UPC-A de 1.1.3), UPC-E expandido a UPC-A; `upcaAsEan13` <on/off> |
| Datos | `reader-<fecha>.jsonl` sha256 `<…>` (3 tiradas), flow JSON al final |

## Resultados

<tablas de `val report`: una por conjunto y la tabla región × bloque>

## Veredicto

- Erróneas de `rosepetal` robust: <0 | n> → <cumple | no cumple>.
- Correctas: `rosepetal` robust <n> frente a max(ZBar <n>, ZXing <n>) = <n> → <cumple | no cumple>; `rp-projection` <n> (informativo).
- Tiempo: p50 por etiqueta (array de <n> recortes) robust <ms>, normal <ms>, ZBar <ms>, ZXing <ms>; objetivo del carril de
  inspección `inspectMs < 500 ms` (R-NR-15) <se mantiene | no>. Primer arranque del motor: <ms> (excluido de p50).
- Editor: <sin observaciones | …>.
- Puerta de la Fase 2: <CUMPLIDA | NO CUMPLIDA → seguimiento `<issue>`>.

## Observaciones

<lecturas erróneas con imagen/región/valor leído/esperado; no-reads por bloque; diferencias de `format`; efecto de
`upcaAsEan13`; recortes desplazados por falta de alineado (afectan igual a todos los bloques)>

## Flow

<details><summary>Barcode SDK validation (export del editor)</summary>

```json
<flow JSON>
```
</details>
````

## 6. If the rule is not met

```bash
gh issue create --repo rosepetal-ai/rosepetal-barcode-sdk \
  --title "Phase 2.x: reader validation on aisvision2 — <wrong reads | fewer correct reads than ZXing>" \
  --body "docs/benchmarks/<YYYY-MM-DD>-reader-aisvision2.md: <summary>. Candidates: adaptive threshold (camera photos), <…>."
```

The block **stays published as optional** (nothing to withdraw: 1.4.0 changes none of the other blocks); the SDK card
and `00-overview.md` §6 note "gate not met → follow-up #n", and the `1.1.x` pin of `rosepetal-dep-node-red` is **not**
raised until it is closed. If the rule is met, the recommendation to raise the pin to `1.4.x` goes into the card of
`rosepetal-dep-node-red` with a link to the report (raising it is a human decision).

## 7. Leave the machine as agreed

- The tarball install of 1.4.0, the client and the engine lives in `/root/.node-red/node_modules` and **is lost at the
  next update of the `node-red` image** (a palette-installed package that the image also bakes is replaced by the
  baked version). Say in the report whether 1.4.0 was left installed. To go back to the baked version now:

```bash
ssh root@<aisvision2> 'docker exec node-red sh -ec "cd /root/.node-red && npm install --no-audit --no-fund @rosepetal/node-red-contrib-barcode-reader@1.1.3 && rm -rf node_modules/@rosepetal/barcode-engine-linux-x64 node_modules/@rosepetal/barcode-engine-client" && docker restart node-red'
```

- Disable or delete the "Barcode SDK validation" tab (its five nodes hold a reference to the engine while deployed;
  the engine process stops when the last node with a `rosepetal` block closes). The files under
  `/opt/storage/print-profiler/validation/` can stay.
- Update the context cards (`contrib/cards/node-red-contrib-barcode-reader.md`, `contrib/cards/rosepetal-barcode-sdk.md`,
  `controller/cards/rosepetal-dep-node-red.md`) with the verdict, the report path and the pin recommendation.

## Checklist

- [ ] Prerequisites: access, active template with `barcode1d` regions, captures present, three tarballs on the machine
- [ ] Install from tarballs, versions and `resolveBinary()` checked, Node-RED restarted, palette shows *Rosepetal SDK*
- [ ] Editor check of the Rosepetal SDK rows (Timeout `1e3` → 1000)
- [ ] Validation tab built (5 reader nodes, 2 lanes, 4 function nodes), `validation/` directory created
- [ ] golden ×3, labels ×3, report; JSONL + MD + logs + machine facts + flow JSON collected
- [ ] Verdict against the acceptance rule; report filed in the SDK's `docs/benchmarks/` with the README row
- [ ] Issue opened if not met; cards updated; machine left as agreed (1.4.0 kept or 1.1.3 restored, tab disabled)
