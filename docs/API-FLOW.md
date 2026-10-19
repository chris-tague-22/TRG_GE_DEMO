# TRG tote flow — API reference (pack → ship)

Reference for developers and AI coding tools (Cursor, etc.) integrating RFID tote tracking with the
BarTender Track & Trace API. The interactive app in this repo runs every call below live.
All requests and responses here were verified against the live API on 2026-10-19.

## Basics

| | |
|---|---|
| Base URL | `https://api.bartender-tt.com` |
| Auth | header `apiKey: <your key>` (without it: `401 {"message":"apikey or basic auth is required"}`) |
| Tenant | header `x-tenant: TRGDEMO` |
| Body | `Content-Type: application/json` — plain JSON, no comments |

## Demo data

| What | Value |
|---|---|
| DC (source) — DC00001 | `urn:mjx:site:loc:TRGDEMO.00006.0` |
| Store A — ST00199 | `urn:mjx:site:loc:TRGDEMO.00007.0` |
| Store B | _TBD_ |
| Tote SKU (`pid`, GTIN-14) | `00030034990015` |
| Tote EPCs | SGTIN-96 hex, company prefix `0030034` (7 digits), e.g. `301401D54860AE40000EFEED` (serial 982765) |
| Reader | `collectorId: DC_Collector` |
| Zone / antenna | `channelId: SHIP` |

## Concepts

- **One endpoint for both order types.** Packing and shipping orders are both ship orders at `/logistics/shiporder`.
  - `contentFormat: "quantity"` → SKU level ("pack 20 of pid X") — the **packing order**.
  - `contentFormat: "tag"` → EPC level ("these exact 20 tags") — the **shipping order**.
- **Create = `PUT /logistics/shiporder`** (no id in URL). **Update/close = `PUT /logistics/shiporder/{id}`**.
  Use the id returned by the create call — it can differ from the `soId` you sent.
- **Tag reads go to the data collector**, `POST /datacollector/reads`, not to the order.
  The read's `transactionId` must equal the order's `transactionId`; that is what attaches the tags to the order.
  `collectorId` + `channelId` identify the reader and antenna/zone the read came from.
- **Closing** = update with `status: "done"`. **The PUT replaces the whole order** — always resend `containers`
  with the contents, or the order is saved with empty contents.

## The flow

```
DC packing zone                             DC shipping dock                    Store
1 create packing order (quantity) ──┐
2 POST reads (txn = PACK-…)         │
3 GET order (check)                 │
4 PUT {packId} status done ─────────┴──► 5 create shipping order (tag = the 20 EPCs)
                                         6 POST reads (txn = SHIP-…)
                                         7 GET compare/{shipId}  → expected vs read
                                         8 PUT {shipId} status done ──────────►  9 receive (next phase)
```

### 1. Create packing order (SKU level)

```bash
curl --request PUT \
  --url https://api.bartender-tt.com/logistics/shiporder \
  --header 'Accept: application/json' \
  --header "apiKey: $API_KEY" \
  --header 'x-tenant: TRGDEMO' \
  --header 'Content-Type: application/json' \
  --data '{
  "soId": 8133384547531199,
  "contentFormat": "quantity",
  "transactionId": "PACK-TEST1",
  "creationTime": "2026-10-19T05:20:54.735Z",
  "expirationTime": null,
  "lastStatusChange": "2026-10-19T05:20:54.735Z",
  "source": "urn:mjx:site:loc:TRGDEMO.00006.0",
  "destination": "urn:mjx:site:loc:TRGDEMO.00007.0",
  "containers": [
    { "content": [ { "format": "quantity", "quantity": 20, "pid": "00030034990015" } ] }
  ]
}'
```

**Response `201`** — the body is just the new order id (a bare number, not JSON):

```
8457559162121116
```

Keep it → `packId`. It is **not** the `soId` you sent. Treat it as a string: it is close to JavaScript's
safe-integer limit.

### 2. Read totes into the packing order

```bash
curl --request POST \
  --url https://api.bartender-tt.com/datacollector/reads \
  --header 'Accept: application/json, text/plain' \
  --header "apiKey: $API_KEY" \
  --header 'x-tenant: TRGDEMO' \
  --header 'Content-Type: application/json' \
  --data '{
  "collectorId": "DC_Collector",
  "channelId": "SHIP",
  "readTime": "2026-10-19T09:09:44.200Z",
  "transactionId": "PACK-TEST1",
  "tags": [
    { "hexa": "301401D54860AE40000EFEED", "attributes": {} }
  ]
}'
```

One entry in `tags` per EPC (20 for a full packing order). Tags can also be sent as `"epc": "urn:epc:id:sgtin:…"` instead of `hexa`.

**Response `200`:**

```json
{ "collectorId": "DC_Collector", "channelId": "SHIP", "tagsReceived": 20, "epcisEventId": "PLACEHOLDER-0001-02", "status": "COMMITTED" }
```

### 3. Get an order

```bash
curl --request GET \
  --url https://api.bartender-tt.com/logistics/shiporder/{packId} \
  --header 'Accept: application/json' \
  --header "apiKey: $API_KEY" \
  --header 'x-tenant: TRGDEMO'
```

**Response `200`:**

```json
{
  "soId": 8457559162121116,
  "transactionId": "PACK-261019201154",
  "contentFormat": "quantity",
  "status": "available",
  "source": "urn:mjx:site:loc:TRGDEMO.00006.0",
  "destination": "urn:mjx:site:loc:TRGDEMO.00007.0",
  "containers": [ { "content": [ { "format": "quantity", "quantity": 20, "pid": "00030034990015" } ] } ],
  "creationTime": "2026-10-19T20:11:56.097Z",
  "updateTime": "2026-10-19T20:11:56.512Z",
  "lastStatusChange": "2026-10-19T20:11:56.097Z",
  "expirationTime": null
}
```

### 4. Close the packing order

Switch to `contentFormat: "tag"` and list the EPCs that were packed — the order then records exactly which totes went in.

```bash
curl --request PUT \
  --url https://api.bartender-tt.com/logistics/shiporder/{packId} \
  --header "apiKey: $API_KEY" \
  --header 'x-tenant: TRGDEMO' \
  --header 'Content-Type: application/json' \
  --data '{
  "contentFormat": "tag",
  "transactionId": "PACK-TEST1",
  "status": "done",
  "source": "urn:mjx:site:loc:TRGDEMO.00006.0",
  "destination": "urn:mjx:site:loc:TRGDEMO.00007.0",
  "containers": [
    { "content": [
      { "format": "tag", "hexa": "301401D54860AE40000EFEED" }
    ] }
  ]
}'
```

**Response `204`** (empty body).

### 5. Create shipping order (EPC level)

Same as step 1 but `contentFormat: "tag"` and one content entry per packed EPC:

```bash
curl --request PUT \
  --url https://api.bartender-tt.com/logistics/shiporder \
  --header 'Accept: application/json' \
  --header "apiKey: $API_KEY" \
  --header 'x-tenant: TRGDEMO' \
  --header 'Content-Type: application/json' \
  --data '{
  "soId": 8133384547531299,
  "contentFormat": "tag",
  "transactionId": "SHIP-TEST5",
  "creationTime": "2026-10-19T05:20:54.735Z",
  "expirationTime": null,
  "lastStatusChange": "2026-10-19T05:20:54.735Z",
  "source": "urn:mjx:site:loc:TRGDEMO.00006.0",
  "destination": "urn:mjx:site:loc:TRGDEMO.00007.0",
  "containers": [
    { "content": [
      { "format": "tag", "hexa": "301401D54860AE40000EFEED" }
    ] }
  ]
}'
```

Keep the returned id → `shipId`.

### 6. Read totes at the shipping dock

Same as step 2 with `"transactionId": "SHIP-TEST5"` (and the shipping zone's `channelId`).

### 7. Compare expected vs. read

```bash
curl --request GET \
  --url https://api.bartender-tt.com/logistics/shiporder/compare/{shipId} \
  --header 'Accept: application/json' \
  --header "apiKey: $API_KEY" \
  --header 'x-tenant: TRGDEMO'
```

**Response `200`** (one tote not read, one stray tote read; lists trimmed):

```json
{
  "soId": "8457559187481117",
  "transactionId": "SHIP-261019201154",
  "matchCount": 19,
  "discrepanciesCount": 2,
  "containers": [
    {
      "matching":    [ { "pid": "00030034990015", "epc": "urn:epc:id:sgtin:0030034.099001.109590675", "hexa": "301401D54860AE4006883893", "format": "tag" } ],
      "missing":     [ { "pid": "00030034990015", "epc": "urn:epc:id:sgtin:0030034.099001.109590694", "hexa": "301401D54860AE40068838A6", "format": "tag" } ],
      "notExpected": [ { "pid": "00030034990015", "epc": "urn:epc:id:sgtin:0030034.099001.35807971",  "hexa": "301401D54860AE40022262E3", "format": "tag" } ]
    }
  ]
}
```

- **Green** = `discrepanciesCount == 0`. `missing` = expected but not read; `notExpected` = read but not on the order.
- Empty lists come back as `{}` instead of `[]` — handle both.
- Right after posting reads this can return `404 {"code":"404","message":"No global results for listId … found"}`
  for a few seconds while reads are processed. Retry every ~3 s.
- Comparing quantity alone is not enough — a missing tote plus a stray tote still counts 20.

### 8. Close the shipping order

Same as step 4 with `{shipId}`, `"transactionId": "SHIP-TEST5"` and the shipped EPCs in `containers`. Response `204`.

### 9. Receive at store — next phase

## Generating tote EPCs (SGTIN-96)

```js
// gtin14 = "00030034990015", prefixLen = 7, serial = 982765  ->  "301401D54860AE40000EFEED"
const PARTITIONS = { 12: [0, 40, 4], 11: [1, 37, 7], 10: [2, 34, 10], 9: [3, 30, 14], 8: [4, 27, 17], 7: [5, 24, 20], 6: [6, 20, 24] };
function sgtin96(gtin14, prefixLen, serial, filter = 0) {
  const [partition, prefixBits, itemBits] = PARTITIONS[prefixLen];
  let v = 0x30n;
  v = (v << 3n) | BigInt(filter);
  v = (v << 3n) | BigInt(partition);
  v = (v << BigInt(prefixBits)) | BigInt(gtin14.slice(1, 1 + prefixLen));
  v = (v << BigInt(itemBits)) | BigInt(gtin14[0] + gtin14.slice(1 + prefixLen, 13));
  v = (v << 38n) | BigInt(serial);
  return v.toString(16).toUpperCase().padStart(24, '0');
}
```

## Gotchas

- Create returns the order id as a bare number; update/close/get/compare use that id, **not** the `soId` you sent.
- Update is a full replace: `containers: [{}]` (as in the original Postman collection) **wipes the order contents**. Resend them.
- Reads are cumulative per `transactionId` — once a tag is read against an order it stays read.
- Compare can 404 for a few seconds after reads; empty lists are `{}`.
- Postman examples contain `// comments` inside the JSON — strip them; the API needs valid JSON.
- `transactionId` must be unique per order and identical between the order and its reads.
