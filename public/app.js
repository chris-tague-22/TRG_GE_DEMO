// TRG tote flow demo — all the API logic lives in STEPS below.
// Each step = one API call: method, path, body, plus what to remember from the response.

const API_BASE_DEFAULT = 'https://api.bartender-tt.com';

const DEFAULT_SETTINGS = {
  apiKey: '',
  tenant: 'TRGDEMO',
  dc: 'urn:mjx:site:loc:TRGDEMO.00006.0',      // DC00001
  storeA: 'urn:mjx:site:loc:TRGDEMO.00007.0',  // ST00199
  storeB: '',
  destination: 'storeA',
  gtin: '00030034990015',                      // RPC tote SKU
  prefixLen: 7,
  qty: 20,
  collectorId: 'DC_Collector',
  packChannel: 'SHIP',
  shipChannel: 'SHIP',
};

let apiBase = API_BASE_DEFAULT;
let settings = { ...DEFAULT_SETTINGS, ...load('settings') };
let run = null; // set in init()

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

const STEPS = [
  {
    id: 'createPack',
    phase: 'Packing at the DC',
    title: 'Create packing order (SKU level)',
    explain:
      'A packing order is a ship order with contentFormat "quantity": it says "pack N of this SKU", not which tags. ' +
      'transactionId is the handle that tag reads use to attach to this order. Uses PUT on the collection URL.',
    method: 'PUT',
    path: () => '/logistics/shiporder',
    body: () => ({
      soId: run.packSoId,
      contentFormat: 'quantity',
      transactionId: run.packTxn,
      creationTime: run.startedAt,
      expirationTime: null,
      lastStatusChange: run.startedAt,
      source: settings.dc,
      destination: destination(),
      containers: [{ content: [{ format: 'quantity', quantity: Number(settings.qty), pid: settings.gtin }] }],
    }),
    after: (json, text) => { run.packId = findOrderId(json, text) || String(run.packSoId); },
  },
  {
    id: 'readPack',
    title: 'Read totes into the packing order',
    explain:
      'Simulates the RFID reader at the packing zone. Tag reads go to the data collector, not the order endpoint — ' +
      'the transactionId ties them to the packing order, and collectorId + channelId identify the reader/zone. ' +
      'EPCs below are real SGTIN-96 encodings of the tote SKU.',
    method: 'POST',
    path: () => '/datacollector/reads',
    extra: 'epcs',
    body: () => reads(run.packTxn, settings.packChannel, run.epcs),
  },
  {
    id: 'getPack',
    title: 'Check the packing order',
    explain: 'Fetch the order back to see its state and what has been read against it.',
    method: 'GET',
    path: () => `/logistics/shiporder/${run.packId || '{packId}'}`,
  },
  {
    id: 'closePack',
    title: 'Close the packing order',
    explain:
      'PUT on the order URL (the ID returned in step 1) with status "done". contentFormat switches to "tag" and the ' +
      'packed EPCs are listed, so the order records exactly which totes were packed. ' +
      'The PUT replaces the whole order — send the contents again or they are wiped.',
    method: 'PUT',
    path: () => `/logistics/shiporder/${run.packId || '{packId}'}`,
    body: () => ({
      contentFormat: 'tag',
      transactionId: run.packTxn,
      status: 'done',
      source: settings.dc,
      destination: destination(),
      containers: tagContainers(run.epcs),
    }),
  },
  {
    id: 'createShip',
    phase: 'Shipping from the DC',
    title: 'Create shipping order (EPC level)',
    explain:
      'Same endpoint as step 1, but contentFormat "tag": one content entry per EPC that was packed. ' +
      'This is the exact list the shipping dock is expected to see.',
    method: 'PUT',
    path: () => '/logistics/shiporder',
    body: () => ({
      soId: run.shipSoId,
      contentFormat: 'tag',
      transactionId: run.shipTxn,
      creationTime: new Date().toISOString(),
      expirationTime: null,
      lastStatusChange: new Date().toISOString(),
      source: settings.dc,
      destination: destination(),
      containers: tagContainers(run.epcs),
    }),
    after: (json, text) => { run.shipId = findOrderId(json, text) || String(run.shipSoId); },
  },
  {
    id: 'readShip',
    title: 'Read totes at the shipping dock',
    explain:
      'Same data-collector call as step 2, now with the shipping transactionId and the ship zone channel. ' +
      'Use the buttons to simulate a short or wrong shipment and watch the check in step 7 go red. ' +
      'Reads add up — anything already sent stays read, so start a new run to go back to a clean shipment.',
    method: 'POST',
    path: () => '/datacollector/reads',
    extra: 'shipSim',
    body: () => reads(run.shipTxn, settings.shipChannel, run.shipReads),
  },
  {
    id: 'compareShip',
    title: 'Check: expected vs. read',
    explain:
      'The API compares the order\'s expected EPCs with everything read under its transactionId and returns ' +
      'matching / missing / notExpected. Reads are processed asynchronously, so right after step 6 this can 404 ' +
      'for a few seconds ("No global results…") — the app retries automatically.',
    method: 'GET',
    path: () => `/logistics/shiporder/compare/${run.shipId || '{shipId}'}`,
    extra: 'lights',
    retryOn404: true,
    after: (json) => { run.compare = json; },
  },
  {
    id: 'closeShip',
    title: 'Close the shipping order',
    explain: 'Mark the shipment done once the dock read matches. As in step 4, resend the contents with the status change.',
    method: 'PUT',
    path: () => `/logistics/shiporder/${run.shipId || '{shipId}'}`,
    body: () => ({
      contentFormat: 'tag',
      transactionId: run.shipTxn,
      status: 'done',
      source: settings.dc,
      destination: destination(),
      containers: tagContainers(run.epcs),
    }),
  },
];

function tagContainers(epcs) {
  return [{ content: epcs.map((hexa) => ({ format: 'tag', hexa })) }];
}

function reads(transactionId, channelId, epcs) {
  return {
    collectorId: settings.collectorId,
    channelId,
    readTime: new Date().toISOString(),
    transactionId,
    tags: epcs.map((hexa) => ({ hexa, attributes: {} })),
  };
}

function destination() {
  return settings[settings.destination] || settings.storeA;
}

// The create call returns the order id the API assigned (a bare number like 8457557468661109),
// which is NOT the soId we sent. Update/close/get must use the returned id.
function findOrderId(json, text) {
  if (/^\s*"?\d+"?\s*$/.test(text || '')) return text.trim().replace(/"/g, ''); // read from text: ids are near the JS number precision limit
  if (!json || typeof json !== 'object') return null;
  for (const obj of [json, json.data, json.shipOrder, json.result]) {
    if (!obj || typeof obj !== 'object') continue;
    for (const k of ['soId', 'id', '_id', 'shipOrderId']) if (obj[k] != null) return String(obj[k]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// EPC generation: SGTIN-96 (header 0x30) from a GTIN-14 + serial
// ---------------------------------------------------------------------------

const PARTITIONS = { 12: [0, 40, 4], 11: [1, 37, 7], 10: [2, 34, 10], 9: [3, 30, 14], 8: [4, 27, 17], 7: [5, 24, 20], 6: [6, 20, 24] };

function sgtin96(gtin14, prefixLen, serial, filter = 0) {
  const [partition, prefixBits, itemBits] = PARTITIONS[prefixLen];
  const companyPrefix = BigInt(gtin14.slice(1, 1 + prefixLen));
  const itemRef = BigInt(gtin14[0] + gtin14.slice(1 + prefixLen, 13)); // indicator digit + item reference
  let v = 0x30n;
  v = (v << 3n) | BigInt(filter);
  v = (v << 3n) | BigInt(partition);
  v = (v << BigInt(prefixBits)) | companyPrefix;
  v = (v << BigInt(itemBits)) | itemRef;
  v = (v << 38n) | BigInt(serial);
  return v.toString(16).toUpperCase().padStart(24, '0');
}

function generateEpcs() {
  const n = Number(settings.qty);
  return Array.from({ length: n }, (_, i) => sgtin96(settings.gtin, Number(settings.prefixLen), run.serialBase + i));
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

function newRun() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14); // YYMMDDhhmmss
  const r = {
    startedAt: new Date().toISOString(),
    packTxn: `PACK-${stamp}`,
    shipTxn: `SHIP-${stamp}`,
    packSoId: soId(),
    shipSoId: soId(),
    serialBase: 100000000 + Math.floor(Math.random() * 800000000),
    packId: null,
    shipId: null,
    epcs: [],
    shipReads: [],
    compare: null,
    results: {},
  };
  run = r;
  r.epcs = generateEpcs();
  r.shipReads = [...r.epcs];
  return r;
}

function soId() {
  // 16-digit numeric id like the Postman examples (stays within JS safe-integer range)
  return Number('8' + String(Date.now()).slice(-13) + String(Math.floor(Math.random() * 100)).padStart(2, '0'));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const dirty = {}; // step id -> user has hand-edited the body

function render() {
  const wrap = document.getElementById('steps');
  wrap.innerHTML = '';
  STEPS.forEach((step, i) => {
    if (step.phase) wrap.insertAdjacentHTML('beforeend', `<div class="phase">${step.phase}</div>`);
    const card = document.createElement('section');
    card.className = 'card';
    card.id = `step-${step.id}`;
    card.innerHTML = `
      <h2><span class="num">${i + 1}</span>${step.title}</h2>
      <div class="endpoint"><span class="method">${step.method}</span><span class="path"></span></div>
      <p class="explain">${step.explain}</p>
      <div class="extra"></div>
      ${step.body ? `<label>Request body <textarea class="body" rows="10" spellcheck="false"></textarea></label>` : ''}
      <div class="row">
        <button class="run">Run</button>
        <button class="ghost copy">Copy curl</button>
        ${step.body ? '<button class="ghost reset" hidden>Reset body</button>' : ''}
        <span class="status-slot"></span>
      </div>
      <details><summary>curl</summary><pre class="curl"></pre></details>
      <details class="resp-wrap" open hidden><summary>Response</summary><pre class="resp"></pre></details>
    `;
    wrap.appendChild(card);

    const ta = card.querySelector('.body');
    if (ta) ta.addEventListener('input', () => { dirty[step.id] = true; card.querySelector('.reset').hidden = false; refresh(); });
    card.querySelector('.reset')?.addEventListener('click', () => { dirty[step.id] = false; card.querySelector('.reset').hidden = true; refresh(); });
    card.querySelector('.run').addEventListener('click', () => execute(step, card));
    card.querySelector('.copy').addEventListener('click', (e) => copy(curlFor(step), e.target));
  });
  refresh();
}

// Recompute paths, bodies, curls and extras from current state.
function refresh() {
  for (const step of STEPS) {
    const card = document.getElementById(`step-${step.id}`);
    if (!card) continue;
    card.querySelector('.path').textContent = apiBase + step.path();
    const ta = card.querySelector('.body');
    if (ta && !dirty[step.id]) ta.value = JSON.stringify(step.body(), null, 2);
    card.querySelector('.curl').textContent = curlFor(step);
    renderExtra(step, card.querySelector('.extra'));
    renderResult(step, card);
  }
  const ids = document.getElementById('run-ids');
  ids.innerHTML = `This run: packing <code>${run.packTxn}</code> (order ${run.packId ? `<code>${run.packId}</code>` : 'not created'}) · ` +
    `shipping <code>${run.shipTxn}</code> (order ${run.shipId ? `<code>${run.shipId}</code>` : 'not created'})`;
  save('run', run);
}

function renderExtra(step, el) {
  if (step.extra === 'epcs') {
    if (!el.dataset.built) {
      el.dataset.built = 1;
      el.innerHTML = `
        <label>EPCs to read (one per line — paste real reads here if you have them)
          <textarea class="epcs" rows="5" spellcheck="false"></textarea></label>
        <div class="row"><button class="ghost regen">Generate ${settings.qty} new tote EPCs</button></div>`;
      el.querySelector('.epcs').addEventListener('change', (e) => {
        run.epcs = e.target.value.split(/\s+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
        run.shipReads = [...run.epcs];
        refresh();
      });
      el.querySelector('.regen').addEventListener('click', () => {
        run.serialBase = 100000000 + Math.floor(Math.random() * 800000000);
        run.epcs = generateEpcs();
        run.shipReads = [...run.epcs];
        refresh();
      });
    }
    const ta = el.querySelector('.epcs');
    if (document.activeElement !== ta) ta.value = run.epcs.join('\n');
  }

  if (step.extra === 'shipSim') {
    if (!el.dataset.built) {
      el.dataset.built = 1;
      el.innerHTML = `
        <div class="row">
          <button class="ghost sim-all">Read all packed totes</button>
          <button class="ghost sim-drop">Drop one tote</button>
          <button class="ghost sim-stray">Add a stray tote</button>
          <span class="hint sim-count"></span>
        </div>`;
      el.querySelector('.sim-all').addEventListener('click', () => { run.shipReads = [...run.epcs]; run.compare = null; refresh(); });
      el.querySelector('.sim-drop').addEventListener('click', () => { run.shipReads.pop(); run.compare = null; refresh(); });
      el.querySelector('.sim-stray').addEventListener('click', () => {
        run.shipReads.push(sgtin96(settings.gtin, Number(settings.prefixLen), Math.floor(Math.random() * 99999999)));
        run.compare = null;
        refresh();
      });
    }
    el.querySelector('.sim-count').textContent = `${run.shipReads.length} tags will be sent`;
  }

  if (step.extra === 'lights') {
    // Prefer the API's answer (step 7); before that, preview from what was sent in steps 5 and 6.
    // Note: the API returns an empty list as {} rather than [].
    const list = (v) => (Array.isArray(v) ? v : []).map((t) => t.hexa || t.epc);
    const c = run.compare && run.compare.containers ? run.compare : null;
    const sum = (key) => (c ? c.containers.flatMap((k) => list(k[key])) : null);
    const expected = new Set(run.epcs);
    const read = new Set(run.shipReads);
    const missing = c ? sum('missing') : [...expected].filter((e) => !read.has(e));
    const unexpected = c ? sum('notExpected') : [...read].filter((e) => !expected.has(e));
    const matched = c ? c.matchCount : [...read].filter((e) => expected.has(e)).length;
    const readCount = matched + unexpected.length;
    const expCount = matched + missing.length;
    const light = (ok, label, value) => `<div class="light ${ok ? 'ok' : 'bad'}">${label}<b>${value}</b></div>`;
    el.innerHTML = `
      <p class="hint">${c ? 'Result from the API compare call.' : 'Preview from the EPCs sent in steps 5–6 — run this step for the API\'s answer.'}</p>
      <div class="lights">
        ${light(readCount === expCount, 'Quantity (read / expected)', `${readCount} / ${expCount}`)}
        ${light(missing.length === 0, 'Missing totes', missing.length)}
        ${light(unexpected.length === 0, 'Unexpected totes', unexpected.length)}
        ${light(missing.length === 0 && unexpected.length === 0, 'Shipment', missing.length || unexpected.length ? 'MISMATCH' : 'OK')}
      </div>
      ${missing.length ? `<details><summary>Missing EPCs</summary><pre>${missing.join('\n')}</pre></details>` : ''}
      ${unexpected.length ? `<details><summary>Unexpected EPCs</summary><pre>${unexpected.join('\n')}</pre></details>` : ''}
      <div class="row"><button class="ghost get-order">Also GET /logistics/shiporder/${run.shipId || '{shipId}'}</button></div>`;
    el.querySelector('.get-order').addEventListener('click', () =>
      execute({ ...step, path: () => `/logistics/shiporder/${run.shipId}` }, document.getElementById(`step-${step.id}`)));
  }
}

function renderResult(step, card) {
  const r = run.results[step.id];
  const slot = card.querySelector('.status-slot');
  const wrap = card.querySelector('.resp-wrap');
  if (!r) { slot.innerHTML = ''; wrap.hidden = true; return; }
  const ok = r.status >= 200 && r.status < 300;
  slot.innerHTML = `<span class="status ${ok ? 'ok' : 'bad'}">${r.status || 'ERR'} · ${r.ms} ms</span> <span class="hint">${r.method} ${r.path}</span>`;
  wrap.hidden = false;
  card.querySelector('.resp').textContent = r.text;
}

// ---------------------------------------------------------------------------
// Calling the API (through the local server at /api/*)
// ---------------------------------------------------------------------------

async function execute(step, card) {
  if (step.path().includes('{')) return alert('This step needs an order ID — run the matching "Create" step first.');
  const btn = card.querySelector('.run');
  btn.disabled = true;
  let bodyText = null;
  if (step.body) {
    bodyText = card.querySelector('.body').value;
    try { JSON.parse(bodyText); } catch (e) { alert('Request body is not valid JSON: ' + e.message); btn.disabled = false; return; }
  }
  const started = performance.now();
  let result;
  try {
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await fetch('/api' + step.path(), {
        method: step.method,
        headers: { 'X-Demo-Key': settings.apiKey, 'X-Demo-Tenant': settings.tenant, ...(bodyText ? { 'Content-Type': 'application/json' } : {}) },
        body: bodyText,
      });
      if (!(step.retryOn404 && res.status === 404 && attempt < 6)) break;
      btn.textContent = `Waiting for reads… (${attempt})`;
      await new Promise((r) => setTimeout(r, 3000));
    }
    btn.textContent = 'Run';
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    result = { status: res.status, ms: Math.round(performance.now() - started), text: json ? JSON.stringify(json, null, 2) : text || '(empty body)' };
    if (res.ok && step.after) step.after(json, text);
  } catch (err) {
    result = { status: 0, ms: Math.round(performance.now() - started), text: 'Could not reach the local server: ' + err.message };
  }
  run.results[step.id] = { ...result, method: step.method, path: step.path(), body: bodyText, title: step.title };
  btn.disabled = false;
  refresh();
}

// ---------------------------------------------------------------------------
// curl + exports
// ---------------------------------------------------------------------------

function curlFor(step, bodyOverride) {
  const card = document.getElementById(`step-${step.id}`);
  const body = bodyOverride ?? (step.body ? card?.querySelector('.body')?.value ?? JSON.stringify(step.body(), null, 2) : null);
  const lines = [
    `curl --request ${step.method} \\`,
    `  --url '${apiBase}${step.path()}' \\`,
    `  --header 'Accept: application/json' \\`,
    `  --header "apiKey: $API_KEY" \\`,
    `  --header 'x-tenant: ${settings.tenant}'`,
  ];
  if (body) {
    lines[lines.length - 1] += ' \\';
    lines.push(`  --header 'Content-Type: application/json' \\`, `  --data '${body.replace(/'/g, "'\\''")}'`);
  }
  return lines.join('\n');
}

function exportShell() {
  const parts = [
    '#!/usr/bin/env bash',
    '# TRG tote flow: replay of the pack -> ship calls, with the values from this demo run.',
    '# Usage: API_KEY=xxxx ./demo.sh',
    'set -euo pipefail',
    ': "${API_KEY:?set API_KEY first}"',
    '',
  ];
  STEPS.forEach((step, i) => {
    parts.push(`echo; echo "== ${i + 1}. ${step.title}"`, curlFor(step), '');
  });
  download('demo.sh', parts.join('\n'));
}

function exportMarkdown() {
  const out = [
    '# TRG tote flow — pack → ship (BarTender Track & Trace API)',
    '',
    `Base URL: \`${apiBase}\`  `,
    'Headers on every call: `apiKey: <key>`, `x-tenant: ' + settings.tenant + '`, `Content-Type: application/json`',
    '',
    `Locations: DC \`${settings.dc}\` → store \`${destination()}\`. Tote SKU (pid/GTIN-14) \`${settings.gtin}\`, ${settings.qty} totes.`,
    '',
    'Key ideas:',
    '- Packing and shipping orders both use `/logistics/shiporder`. `contentFormat: "quantity"` = SKU-level (packing); `"tag"` = EPC-level (shipping).',
    '- RFID reads go to `/datacollector/reads`. The `transactionId` in the read ties it to an order; `collectorId` + `channelId` identify reader/zone.',
    '- Create with `PUT /logistics/shiporder`; update/close with `PUT /logistics/shiporder/{id}` using the id returned by create.',
    '',
  ];
  STEPS.forEach((step, i) => {
    const r = run.results[step.id];
    out.push(`## ${i + 1}. ${step.title}`, '', step.explain, '', '```bash', curlFor(step, r?.body ?? undefined), '```', '');
    if (r) out.push(`Response (${r.status}):`, '', '```json', r.text, '```', '');
    else out.push('_Not run in this session._', '');
  });
  download('flow.md', out.join('\n'));
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = old), 1200);
}

// ---------------------------------------------------------------------------
// Setup form + persistence
// ---------------------------------------------------------------------------

function bindSetup() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    el.value = settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.value.trim();
      save('settings', settings);
      if (key === 'gtin' || key === 'prefixLen' || key === 'qty') {
        run.epcs = generateEpcs();
        run.shipReads = [...run.epcs];
      }
      refresh();
    });
  });
  document.getElementById('btn-new-run').addEventListener('click', () => {
    if (!confirm('Start a new run? New transaction IDs and EPCs; results on screen are cleared.')) return;
    newRun();
    Object.keys(dirty).forEach((k) => delete dirty[k]);
    render();
  });
  document.getElementById('btn-export-sh').addEventListener('click', exportShell);
  document.getElementById('btn-export-md').addEventListener('click', exportMarkdown);
}

function load(key) {
  try { return JSON.parse(localStorage.getItem('trg-demo-' + key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem('trg-demo-' + key, JSON.stringify(value)); } catch {}
}

(async function init() {
  try {
    const cfg = await (await fetch('/config')).json();
    apiBase = cfg.apiBase || apiBase;
    if (!settings.tenant && cfg.tenant) settings.tenant = cfg.tenant;
  } catch {}
  run = load('run') || newRun();
  bindSetup();
  render();
})();
