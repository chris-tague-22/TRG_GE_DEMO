// Minimal local server: serves the web UI and forwards /api/* calls to the
// BarTender Track & Trace API. Running calls through here (instead of straight
// from the browser) avoids CORS problems and keeps the API key off the page.
// No dependencies — needs Node 18+ for built-in fetch.

const http = require('http');
const fs = require('fs');
const path = require('path');

loadDotEnv();
const API_BASE = (process.env.API_BASE || 'https://api.bartender-tt.com').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOCS_DIR = path.join(__dirname, 'docs');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.md': 'text/markdown', '.json': 'application/json' };

http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) return await proxy(req, res);
    if (req.url === '/config') return send(res, 200, { apiBase: API_BASE, tenant: process.env.TENANT || '', hasServerKey: !!process.env.API_KEY });
    return serveStatic(req, res);
  } catch (err) {
    send(res, 502, { proxyError: err.message, cause: err.cause?.message });
  }
}).listen(PORT, () => console.log(`TRG API demo running at http://localhost:${PORT}  (forwarding to ${API_BASE})`));

async function proxy(req, res) {
  const target = API_BASE + req.url.slice('/api'.length);
  const body = await readBody(req);

  // Key/tenant come from the UI (X-Demo-* headers) or fall back to .env.
  const headers = {
    Accept: 'application/json, text/plain',
    apiKey: req.headers['x-demo-key'] || process.env.API_KEY || '',
    'x-tenant': req.headers['x-demo-tenant'] || process.env.TENANT || '',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const started = Date.now();
  const upstream = await fetch(target, { method: req.method, headers, body: body || undefined });
  const text = await upstream.text();
  console.log(`${req.method} ${target} -> ${upstream.status} (${Date.now() - started}ms)`);

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'text/plain',
    'X-Upstream-Ms': String(Date.now() - started),
  });
  res.end(text);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = urlPath.startsWith('/docs/') ? [DOCS_DIR, urlPath.slice(6)] : [PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath];
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
