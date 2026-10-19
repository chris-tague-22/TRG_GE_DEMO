// TRG tote flow demo — all the API logic lives in STEPS below.
// Each step = one API call: method, path, body, plus what to remember from the response.
//
// The full loop for a set of returnable totes (RPCs):
//   DC packing → DC shipping → store receiving (ASN) → empty pool → return shipping → DC receiving (ASN)
// Ship orders and ASNs use the same four-call pattern: create (PUT), read tags (POST /datacollector/reads
// with the order's transactionId), compare expected vs. read (GET), close (PUT with status "done").

const API_BASE_DEFAULT = 'https://api.bartender-tt.com';

const DEFAULT_SETTINGS = {
  apiKey: '',
  tenant: 'TRGDEMO',
  dc: 'urn:mjx:site:loc:TRGDEMO.00006.0',      // DC00001
  store: 'urn:mjx:site:loc:TRGDEMO.00007.0',   // ST00199
  gtin: '00030034990015',                      // RPC tote SKU
  prefixLen: 7,
  qty: 20,
  // Readers (data collectors) and their channels. Each channel is mapped to a workflow in Track & Trace.
  dcCollectorId: 'DC_Collector',
  packChannel: 'SHIP',
  dcShipChannel: 'SHIP',                       // Shipping / In Transit
  dcRecvChannel: 'RECV',                       // Receiving
  storeCollectorId: 'ST00199_Collector',
  storeRecvChannel: 'RECV',                    // Receiving / On Sales Floor
  storePoolChannel: 'MOVE_EmptyPool',          // Storing / Stored (the tunnel into the empty pool)
  storeShipChannel: 'SHIP',                    // Shipping / In Transit
  autoAsn: true,                               // create the receiving ASN as soon as a shipment is closed
};

let apiBase = API_BASE_DEFAULT;
let settings = { ...DEFAULT_SETTINGS, ...load('settings') };
let run = null; // set in init()

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

const STEPS = [
  // --- DC packing: SKU-level order, totes read in, closed with the actual EPCs ---
  createStep('pack', {
    phase: 'DC packing',
    title: 'Create packing order (SKU level)',
    explain:
      'A packing order is a ship order with contentFormat "quantity": "pack N of this SKU", not which tags. ' +
      'transactionId is the handle tag reads use to attach to this order. The response is the new order id.',
    endpoint: 'shiporder',
    from: () => settings.dc,
    to: () => settings.store,
    contentFormat: 'quantity',
    containers: () => [{ content: [{ format: 'quantity', quantity: Number(settings.qty), pid: settings.gtin }] }],
  }),
  readStep('pack', {
    title: 'Read totes into the packing order',
    explain:
      'Simulates the RFID reader at the packing station. Reads go to the data collector, not the order: ' +
      'the transactionId ties them to the order, collectorId + channelId identify reader and zone (both are validated). ' +
      'The EPCs below are real SGTIN-96 encodings of the tote SKU.',
    collector: () => settings.dcCollectorId,
    channel: () => settings.packChannel,
    extra: 'epcs',
  }),
  {
    id: 'pack-get',
    title: 'Check the packing order',
    explain: 'Fetch the order back to see its state.',
    method: 'GET',
    path: () => `/logistics/shiporder/${run.legs.pack.id || '{packId}'}`,
  },
  closeStep('pack', {
    title: 'Close the packing order',
    explain:
      'PUT on the order URL with status "done". contentFormat switches to "tag" and the packed EPCs are listed, ' +
      'so the order records exactly which totes were packed. The PUT replaces the whole order — always resend the contents.',
    endpoint: 'shiporder',
    from: () => settings.dc,
    to: () => settings.store,
  }),

  // --- DC → store shipment ---
  ...orderLeg('ship', {
    phase: 'DC shipping to the store',
    endpoint: 'shiporder',
    what: 'shipping order',
    from: () => settings.dc,
    to: () => settings.store,
    createExplain:
      'Same endpoint as packing, but contentFormat "tag": one entry per packed EPC. This is the exact list the dock should see.',
    readTitle: 'Read totes at the DC shipping dock',
    collector: () => settings.dcCollectorId,
    channel: () => settings.dcShipChannel,
    simFrom: 'packed',
    label: 'Shipment',
    thenAuto: 'asn-create',
  }),

  // --- Store receives: ASN with the shipped EPCs, read on the floor ---
  ...orderLeg('asn', {
    phase: 'Store receiving',
    endpoint: 'asn',
    what: 'ASN',
    from: () => settings.dc,
    to: () => settings.store,
    createExplain:
      'An Advanced Shipping Notice tells the store what is on its way: the same EPCs that were shipped. ' +
      'destination is the receiving site (the ASN appears in its Receiving workflow), source the site it ships from. ' +
      'The response is the new asnId.',
    auto: true,
    readTitle: 'Receive totes onto the sales floor',
    readExplain:
      'The store reader\'s RECV channel is mapped to Receiving / On Sales Floor. Only reads on a RECEIVING or SHIPPING ' +
      'channel with the ASN\'s transactionId count towards the ASN.',
    collector: () => settings.storeCollectorId,
    channel: () => settings.storeRecvChannel,
    simFrom: 'shipped',
    label: 'Receipt',
  }),

  // --- Empties pushed through the tunnel into the empty pool (no order) ---
  readStep('pool', {
    phase: 'Store empty pool',
    title: 'Push totes through the tunnel into the empty pool',
    explain:
      'A plain read on the MOVE_EmptyPool channel (mapped to Storing / Stored). No order is involved, so no transactionId — ' +
      'the read alone moves the totes into the empty pool.',
    collector: () => settings.storeCollectorId,
    channel: () => settings.storePoolChannel,
    noTransaction: true,
  }),

  // --- Store → DC return of the empties ---
  ...orderLeg('ret', {
    phase: 'Return shipping to the DC',
    endpoint: 'shiporder',
    what: 'return shipping order',
    from: () => settings.store,
    to: () => settings.dc,
    createExplain: 'The empties go back: an EPC-level shipping order from the store to the DC.',
    readTitle: 'Read totes at the store shipping door',
    collector: () => settings.storeCollectorId,
    channel: () => settings.storeShipChannel,
    simFrom: 'pooled',
    label: 'Return shipment',
    thenAuto: 'dcAsn-create',
  }),

  // --- DC receives the empties ---
  ...orderLeg('dcAsn', {
    phase: 'DC receiving the empties',
    endpoint: 'asn',
    what: 'DC ASN',
    from: () => settings.store,
    to: () => settings.dc,
    createExplain: 'ASN at the DC for the returning totes, so the DC receiving dock knows what to expect.',
    auto: true,
    readTitle: 'Receive totes at the DC',
    collector: () => settings.dcCollectorId,
    channel: () => settings.dcRecvChannel,
    simFrom: 'returned',
    label: 'DC receipt',
  }),
];

// ---------------------------------------------------------------------------
// Step builders — one per kind of call
// ---------------------------------------------------------------------------

const ID_FIELD = { shiporder: 'soId', asn: 'asnId' };

// The four calls every ship order / ASN goes through.
function orderLeg(leg, o) {
  return [
    createStep(leg, { ...o, title: `Create ${o.what} (EPC level)`, explain: o.createExplain, contentFormat: 'tag', containers: () => tagContainers(run.epcs) }),
    readStep(leg, { title: o.readTitle, explain: o.readExplain || `Tag reads with this ${o.what}'s transactionId. Use the buttons to simulate a short or wrong load: they only change the local list, and the next step previews the result. Once you click Run the reads are permanent — tags cannot be removed from an order — so settle the count before sending.`, collector: o.collector, channel: o.channel, extra: 'sim', simFrom: o.simFrom }),
    compareStep(leg, o),
    closeStep(leg, { ...o, title: `Close the ${o.what}`, explain: `Status "done", resending the contents (the PUT replaces the record).${o.thenAuto ? ' With auto-create on, this also creates the receiving ASN.' : ''}` }),
  ];
}

function createStep(leg, o) {
  return {
    id: `${leg}-create`,
    phase: o.phase,
    title: o.title,
    explain: o.explain,
    method: 'PUT',
    path: () => `/logistics/${o.endpoint}`,
    extra: o.auto ? 'auto' : undefined,
    body: () => ({
      [ID_FIELD[o.endpoint]]: run.legs[leg].soId,
      contentFormat: o.contentFormat,
      transactionId: run.legs[leg].txn,
      creationTime: new Date().toISOString(),
      expirationTime: null,
      lastStatusChange: new Date().toISOString(),
      source: o.from(),
      destination: o.to(),
      containers: o.containers(),
    }),
    // The create response is the new id as a bare number — NOT the soId/asnId we sent.
    after: (json, text) => { run.legs[leg].id = findOrderId(json, text) || String(run.legs[leg].soId); },
  };
}

function readStep(leg, o) {
  return {
    id: `${leg}-read`,
    leg,
    phase: o.phase,
    title: o.title,
    explain: o.explain,
    method: 'POST',
    path: () => '/datacollector/reads',
    extra: o.extra,
    simFrom: o.simFrom,
    body: () => ({
      collectorId: o.collector(),
      channelId: o.channel(),
      readTime: new Date().toISOString(),
      ...(o.noTransaction ? {} : { transactionId: run.legs[leg].txn }),
      tags: (run.reads[leg] || run.epcs).map((hexa) => ({ hexa, attributes: {} })),
    }),
  };
}

function compareStep(leg, o) {
  const idOf = () => run.legs[leg].id || `{${leg}Id}`;
  return {
    id: `${leg}-compare`,
    leg,
    title: `Check: expected vs. read (${o.label.toLowerCase()})`,
    explain:
      'The API compares expected EPCs with everything read under the transactionId: matching / missing / notExpected. ' +
      'Reads are processed asynchronously, so right after reading this can 404 ("No global results…") for a few seconds — the app retries.',
    method: 'GET',
    path: () => `/logistics/${o.endpoint}/compare/${idOf()}`,
    extra: 'lights',
    label: o.label,
    getPath: () => `/logistics/${o.endpoint}/${idOf()}`,
    retryOn404: true,
    after: (json) => { run.compare[leg] = json; },
  };
}

function closeStep(leg, o) {
  return {
    id: `${leg}-close`,
    title: o.title,
    explain: o.explain,
    method: 'PUT',
    path: () => `/logistics/${o.endpoint}/${run.legs[leg].id || `{${leg}Id}`}`,
    body: () => ({
      contentFormat: 'tag',
      transactionId: run.legs[leg].txn,
      status: 'done',
      source: o.from(),
      destination: o.to(),
      containers: tagContainers(run.epcs),
    }),
    after: () => { if (o.thenAuto && settings.autoAsn) setTimeout(() => runStep(o.thenAuto)); },
  };
}

function runStep(id) {
  const step = STEPS.find((s) => s.id === id);
  execute(step, document.getElementById(`step-${id}`));
}

function tagContainers(epcs) {
  return [{ content: epcs.map((hexa) => ({ format: 'tag', hexa })) }];
}

// Create returns the id the API assigned (a bare number like 8457557468661109).
// Read it from the text: these ids are near the JS number precision limit.
function findOrderId(json, text) {
  if (/^\s*"?\d+"?\s*$/.test(text || '')) return text.trim().replace(/"/g, '');
  if (!json || typeof json !== 'object') return null;
  for (const obj of [json, json.data, json.result]) {
    if (!obj || typeof obj !== 'object') continue;
    for (const k of ['soId', 'asnId', 'id']) if (obj[k] != null) return String(obj[k]);
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

const LEGS = { pack: 'PACK', ship: 'SHIP', asn: 'RECV', ret: 'RTN', dcAsn: 'DCRECV' };
const SIM_LEGS = ['ship', 'asn', 'ret', 'dcAsn'];

function newRun() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14); // YYMMDDhhmmss
  run = {
    version: 2,
    serialBase: 100000000 + Math.floor(Math.random() * 800000000),
    epcs: [],
    legs: Object.fromEntries(Object.entries(LEGS).map(([leg, prefix]) => [leg, { txn: `${prefix}-${stamp}`, soId: soId(), id: null }])),
    reads: {},   // per leg: the EPCs the simulated reader will send
    compare: {}, // per leg: last compare response
    results: {},
  };
  run.epcs = generateEpcs();
  resetReads();
  return run;
}

function resetReads() {
  for (const leg of SIM_LEGS) { run.reads[leg] = [...run.epcs]; run.compare[leg] = null; }
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
  document.getElementById('run-ids').innerHTML = 'This run: ' + Object.entries(run.legs)
    .map(([, l]) => `<code>${l.txn}</code> ${l.id ? `→ <code>${l.id}</code>` : '(not created)'}`).join(' · ');
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
        resetReads();
        refresh();
      });
      el.querySelector('.regen').addEventListener('click', () => {
        run.serialBase = 100000000 + Math.floor(Math.random() * 800000000);
        run.epcs = generateEpcs();
        resetReads();
        refresh();
      });
    }
    const ta = el.querySelector('.epcs');
    if (document.activeElement !== ta) ta.value = run.epcs.join('\n');
  }

  if (step.extra === 'sim') {
    const leg = step.leg;
    if (!el.dataset.built) {
      el.dataset.built = 1;
      el.innerHTML = `
        <div class="row">
          <button class="ghost sim-all">Read all ${step.simFrom} totes</button>
          <button class="ghost sim-drop">Drop one tote</button>
          <button class="ghost sim-stray">Add a stray tote</button>
          <span class="hint sim-count"></span>
        </div>`;
      const changed = (fn) => () => { fn(); run.compare[leg] = null; refresh(); };
      el.querySelector('.sim-all').addEventListener('click', changed(() => { run.reads[leg] = [...run.epcs]; }));
      el.querySelector('.sim-drop').addEventListener('click', changed(() => { run.reads[leg].pop(); }));
      el.querySelector('.sim-stray').addEventListener('click', changed(() => {
        run.reads[leg].push(sgtin96(settings.gtin, Number(settings.prefixLen), Math.floor(Math.random() * 99999999)));
      }));
    }
    el.querySelector('.sim-count').textContent = `${run.reads[leg].length} tags will be sent`;
  }

  if (step.extra === 'auto') {
    if (!el.dataset.built) {
      el.dataset.built = 1;
      el.innerHTML = `<label class="check"><input type="checkbox" class="auto"> Create receiving ASNs automatically when the shipping order is closed</label>`;
      el.querySelector('.auto').addEventListener('change', (e) => { settings.autoAsn = e.target.checked; save('settings', settings); });
    }
    el.querySelector('.auto').checked = !!settings.autoAsn;
  }

  if (step.extra === 'lights') {
    // Prefer the API's compare answer; before that, preview from the EPCs sent in the previous two steps.
    // Note: the API returns an empty list as {} rather than [].
    const leg = step.leg;
    const list = (v) => (Array.isArray(v) ? v : []).map((t) => t.hexa || t.epc);
    const c = run.compare[leg] && run.compare[leg].containers ? run.compare[leg] : null;
    const sum = (key) => (c ? c.containers.flatMap((k) => list(k[key])) : null);
    const expected = new Set(run.epcs);
    const read = new Set(run.reads[leg]);
    const missing = c ? sum('missing') : [...expected].filter((e) => !read.has(e));
    const unexpected = c ? sum('notExpected') : [...read].filter((e) => !expected.has(e));
    const matched = c ? c.matchCount : [...read].filter((e) => expected.has(e)).length;
    const readCount = matched + unexpected.length;
    const expCount = matched + missing.length;
    const light = (ok, label, value) => `<div class="light ${ok ? 'ok' : 'bad'}">${label}<b>${value}</b></div>`;
    el.innerHTML = `
      <p class="hint">${c ? 'Result from the API compare call.' : 'Preview from the EPCs in the read step above — run this step for the API\'s answer.'}</p>
      <div class="lights">
        ${light(readCount === expCount, 'Quantity (read / expected)', `${readCount} / ${expCount}`)}
        ${light(missing.length === 0, 'Missing totes', missing.length)}
        ${light(unexpected.length === 0, 'Unexpected totes', unexpected.length)}
        ${light(missing.length === 0 && unexpected.length === 0, step.label, missing.length || unexpected.length ? 'MISMATCH' : 'OK')}
      </div>
      ${missing.length ? `<details><summary>Missing EPCs</summary><pre>${missing.join('\n')}</pre></details>` : ''}
      ${unexpected.length ? `<details><summary>Unexpected EPCs</summary><pre>${unexpected.join('\n')}</pre></details>` : ''}
      <div class="row"><button class="ghost get-order">Also GET ${step.getPath()}</button></div>`;
    el.querySelector('.get-order').addEventListener('click', () =>
      execute({ ...step, path: step.getPath }, document.getElementById(`step-${step.id}`)));
  }
}

function renderResult(step, card) {
  const r = run.results[step.id];
  const slot = card.querySelector('.status-slot');
  const wrap = card.querySelector('.resp-wrap');
  if (!r) { slot.innerHTML = ''; wrap.hidden = true; return; }
  const ok = r.status >= 200 && r.status < 300;
  slot.innerHTML = `<span class="status ${ok ? 'ok' : 'bad'}">${r.status || 'ERR'} · ${r.ms} ms</span> <span class="hint">${r.method} ${r.path}${r.retries ? ` · gateway "not_owned" retried ${r.retries}×` : ''}</span>`;
  if (r.status === 401 && r.text.includes('not_owned')) {
    slot.innerHTML += ' <span class="hint">The API gateway intermittently rejects valid keys with "not_owned" (already retried 3×) — run again.</span>';
  }
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
    result = { status: res.status, ms: Math.round(performance.now() - started), retries: Number(res.headers.get('X-NotOwned-Retries') || 0), text: json ? JSON.stringify(json, null, 2) : text || '(empty body)' };
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
    '# TRG tote flow: replay of every call (pack -> ship -> receive -> empty pool -> return -> DC receive),',
    '# with the values from this demo run.',
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
    '# TRG tote flow — pack → ship → receive → empty pool → return (BarTender Track & Trace API)',
    '',
    `Base URL: \`${apiBase}\`  `,
    'Headers on every call: `apiKey: <key>`, `x-tenant: ' + settings.tenant + '`, `Content-Type: application/json`',
    '',
    `Locations: DC \`${settings.dc}\`, store \`${settings.store}\`. Tote SKU (pid/GTIN-14) \`${settings.gtin}\`, ${settings.qty} totes.`,
    '',
    'Key ideas:',
    '- Ship orders (`/logistics/shiporder`) and ASNs (`/logistics/asn`) follow the same pattern: create (PUT), reads, compare, close (PUT status done).',
    '- `contentFormat: "quantity"` = SKU-level (packing); `"tag"` = EPC-level.',
    '- RFID reads go to `/datacollector/reads`. The `transactionId` ties a read to an order; `collectorId` + `channelId` identify reader and zone.',
    '- Create returns the new id; update/close/compare use it. The update PUT replaces the record — resend the contents.',
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
    el.value = settings[key] ?? '';
    el.addEventListener('change', () => {
      settings[key] = el.value.trim();
      save('settings', settings);
      if (key === 'gtin' || key === 'prefixLen' || key === 'qty') {
        run.epcs = generateEpcs();
        resetReads();
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
  try { return JSON.parse(localStorage.getItem('trg-demo-v2-' + key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem('trg-demo-v2-' + key, JSON.stringify(value)); } catch {}
}

(async function init() {
  try {
    const cfg = await (await fetch('/config')).json();
    apiBase = cfg.apiBase || apiBase;
    if (!settings.tenant && cfg.tenant) settings.tenant = cfg.tenant;
  } catch {}
  run = load('run');
  if (!run || run.version !== 2) newRun();
  bindSetup();
  render();
})();
