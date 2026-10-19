# TRG tote flow demo

Interactive walkthrough of the BarTender Track & Trace API for RFID tote (RPC) tracking, covering the full loop:

1. **DC packing:** SKU-level packing order, totes read in, closed with the actual EPCs
2. **DC → store shipment:** EPC-level shipping order, dock read, expected-vs-read check, close
3. **Store receiving:** ASN created automatically when the shipment closes, totes received onto the sales floor
4. **Empty pool:** totes pushed through the tunnel (a plain read, no order)
5. **Store → DC return:** EPC-level shipping order back to the DC
6. **DC receiving:** ASN at the DC, receive, check, close

Each step shows the request, a copyable curl and the live response. "Drop one tote" / "Add a stray tote"
buttons simulate a bad load so the red/green check can be demonstrated.

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
