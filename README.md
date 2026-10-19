# TRG tote flow demo

Interactive walkthrough of the BarTender Track & Trace API for RFID tote (RPC) tracking:
create a packing order → read totes into it → close it → create an EPC-level shipping order →
read at the dock → compare expected vs. read → close. Each step shows the request, a copyable curl and the live response.

## Run it

Requires Node 18+. No `npm install` needed.

```bash
cp .env.example .env      # optional: put API_KEY / TENANT here, or type them in the UI
npm start                 # http://localhost:3000
```

The page talks to a tiny local server (`server.js`), which forwards `/api/*` to `https://api.bartender-tt.com`
and adds the `apiKey` / `x-tenant` headers. That avoids CORS and keeps the key out of the browser's network calls to the API.

## Files

| File | What |
|---|---|
| `docs/API-FLOW.md` | The flow as plain docs + curls — hand this to Cursor / your AI |
| `public/app.js` | All API logic: the `STEPS` array is one entry per call |
| `server.js` | Static files + `/api` forwarder |

Buttons in the UI: **Download flow.md** (the run you just did, with real requests and responses) and
**Download demo.sh** (replay the calls with curl: `API_KEY=xxx ./demo.sh`).
