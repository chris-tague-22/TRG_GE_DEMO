# TRG tote loop — API reference

Reference for developers and AI coding tools (Cursor, etc.) integrating RFID tote (RPC) tracking with the
BarTender Track & Trace API. The interactive app in this repo runs every call below live.
Every request and response here was verified against the live API on 2026-10-19.

```
DC00001                                   ST00199                                   DC00001
pack order → ship order ──── totes ────►  ASN → receive onto floor
                                          tunnel → empty pool (no order)
                                          return ship order ──── empties ────►      ASN → receive
```

## Basics

| | |
|---|---|
| Base URL | `https://api.bartender-tt.com` |
| Auth | header `apiKey: <your key>` |
| Tenant | header `x-tenant: TRGDEMO` |
| Body | `Content-Type: application/json` — plain JSON, no comments |

## Demo data

| What | Value |
|---|---|
| DC — DC00001 | `urn:mjx:site:loc:TRGDEMO.00006.0` |
| Store — ST00199 | `urn:mjx:site:loc:TRGDEMO.00007.0` |
| Tote SKU (`pid`, GTIN-14) | `00030034990015` |
| Tote EPCs | SGTIN-96 hex, company prefix `0030034` (7 digits), e.g. `301401D54860AE40000EFEED` |

### Readers and channels

`collectorId` and `channelId` are validated (`COLLECTOR_NOT_FOUND` / `CHANNEL_NOT_FOUND`). Each channel is mapped
to a workflow in Track & Trace, so **which channel you post to decides what the read means**.

| Reader (`collectorId`) | Channel (`channelId`) | Workflow | Used for |
|---|---|---|---|
| `DC_Collector` | `SHIP` | Shipping / In Transit | packing + shipping at the DC |
| `DC_Collector` | `RECV` | Receiving | DC receiving the empties |
| `ST00199_Collector` | `RECV` | Receiving / On Sales Floor | store receiving (totes go straight to the floor) |
| `ST00199_Collector` | `MOVE_EmptyPool` | Storing / Stored | tunnel into the empty pool |
| `ST00199_Collector` | `SHIP` | Shipping / In Transit | shipping empties back to the DC |

(In the T&T UI the store reader is shown as "ST00199 Collector-NAME"; its id is `ST00199_Collector`.)

## The operator's view

For the people on the floor each leg is just: **scan → check → confirm.**

| Operator action | API calls behind it |
|---|---|
| Confirm packing | reads (once, confirmed set) → close pack order |
| Confirm shipment | reads (once) → close ship order → **create receiving ASN automatically** |
| Confirm receipt | reads (once) → compare → close ASN |
| Push through tunnel | one read on `MOVE_EmptyPool` |

## Core concepts

- **Ship orders and ASNs follow the same four calls:**
  1. create — `PUT /logistics/shiporder` or `PUT /logistics/asn` → returns the new id
  2. tag reads — `POST /datacollector/reads` with the order's `transactionId`
  3. compare — `GET /logistics/{shiporder|asn}/compare/{id}`
  4. close — `PUT /logistics/{shiporder|asn}/{id}` with `status: "done"`
- `contentFormat: "quantity"` = SKU level (packing); `"tag"` = EPC level (everything else).
- **The `transactionId` is the link** between an order and its tag reads. Only reads on a RECEIVING or SHIPPING
  channel count towards an order/ASN.
- **Create returns the id as a bare number** (`8457575317691122`), not JSON — and it is **not** the `soId`/`asnId`
  you sent. Use it for every later call. Keep it as a string (it is near JavaScript's safe-integer limit).
- **Update is a full replace.** Always resend `containers`; `containers: [{}]` wipes the order's contents.
- An ASN's `destination` is the receiving site (the ASN appears in that site's Receiving workflow).
  Ship orders and ASNs share one id space: `GET /logistics/asn/{shipOrderId}` returns the ship order seen as an ASN —
  that is not a real ASN. Create the ASN explicitly.

## Design rule: settle the count locally, then send once

**Tag reads cannot be taken back.** Once a read is posted to `/datacollector/reads` against a `transactionId`,
it counts towards that order or ASN for good. There is no call to remove a tag or reset an order's reads,
and deleting the order does not delete the read events. So the client app must have the final, confirmed set
of EPCs **before** it sends anything.

Recommended pattern for every ship order and ASN:

1. **Create** the ship order / ASN (or receive it from the WMS).
2. **Pull the expected EPCs down**: `GET /logistics/{shiporder|asn}/{id}` → `containers[].content[].hexa`.
3. **Read locally.** Buffer the reader's tags in the app, de-duplicate them, and diff them live against the
   expected list: matching / missing / unexpected, with a red/green light. Nothing goes to the API yet.
4. **Let the operator fix it.** Put a tote in, take one out, re-scan. The local diff updates each time.
   This is where a tote added and then removed must disappear from the set. That can only happen locally.
5. **Confirm.** Overs and unders can be legitimate (a short shipment, an extra tote). The operator accepts
   the final set explicitly, ideally with a reason when it is not a clean match.
6. **Send once**: one `POST /datacollector/reads` with the confirmed set and the order's `transactionId`.
7. **Verify** with `GET …/compare/{id}`. It should show exactly what the app showed locally. Then **close** the order.

Do not stream raw reader events straight to the API. A tote that passes the antenna by mistake becomes a
permanent "notExpected" on the order.

The empty-pool move is the one exception: it has no order to reconcile against, so the read is sent as soon as
the totes go through the tunnel. Still de-duplicate first.

If a send fails ambiguously (timeout, 5xx), run compare before resending, to see what actually landed.
The gateway's `401 not_owned` is the exception: it is rejected before processing, so it is safe to resend.

The demo app follows this: the read-step buttons ("Drop one tote", "Add a stray tote") change a local list,
and the next step's lights preview the result **before** anything is sent. Once you click Run, the reads are permanent.

## 1. DC packing

### 1a. Create the packing order (SKU level)

```bash
curl --request PUT --url https://api.bartender-tt.com/logistics/shiporder \
  --header "apiKey: $API_KEY" --header 'x-tenant: TRGDEMO' --header 'Content-Type: application/json' \
  --data '{
  "soId": 8133384547531199,
  "contentFormat": "quantity",
  "transactionId": "PACK-261019203846",
  "creationTime": "2026-10-19T20:38:46.000Z",
  "expirationTime": null,
  "lastStatusChange": "2026-10-19T20:38:46.000Z",
  "source": "urn:mjx:site:loc:TRGDEMO.00006.0",
  "destination": "urn:mjx:site:loc:TRGDEMO.00007.0",
  "containers": [ { "content": [ { "format": "quantity", "quantity": 20, "pid": "00030034990015" } ] } ]
}'
```

Response `201`: `8457575317691122` → `packId`.

### 1b. Read the totes into it

```bash
curl --request POST --url https://api.bartender-tt.com/datacollector/reads \
  --header "apiKey: $API_KEY" --header 'x-tenant: TRGDEMO' --header 'Content-Type: application/json' \
  --data '{
  "collectorId": "DC_Collector",
  "channelId": "SHIP",
  "readTime": "2026-10-19T20:38:50.000Z",
  "transactionId": "PACK-261019203846",
  "tags": [ { "hexa": "301401D54860AE40000EFEED", "attributes": {} } ]
}'
```

One entry in `tags` per EPC. Response `200`:

```json
{ "collectorId": "DC_Collector", "channelId": "SHIP", "tagsReceived": 20, "epcisEventId": "PLACEHOLDER-0001-02", "status": "COMMITTED" }
```

### 1c. Get it — `GET /logistics/shiporder/{packId}`

```json
{
  "soId": 8457575317691122, "transactionId": "PACK-261019203846", "contentFormat": "quantity", "status": "available",
  "source": "urn:mjx:site:loc:TRGDEMO.00006.0", "destination": "urn:mjx:site:loc:TRGDEMO.00007.0",
  "containers": [ { "content": [ { "format": "quantity", "quantity": 20, "pid": "00030034990015" } ] } ],
  "creationTime": "…", "updateTime": "…", "lastStatusChange": "…", "expirationTime": null
}
```

### 1d. Close it with the packed EPCs

```bash
curl --request PUT --url https://api.bartender-tt.com/logistics/shiporder/{packId} \
  --header "apiKey: $API_KEY" --header 'x-tenant: TRGDEMO' --header 'Content-Type: application/json' \
  --data '{
  "contentFormat": "tag",
  "transactionId": "PACK-261019203846",
  "status": "done",
  "source": "urn:mjx:site:loc:TRGDEMO.00006.0",
  "destination": "urn:mjx:site:loc:TRGDEMO.00007.0",
  "containers": [ { "content": [ { "format": "tag", "hexa": "301401D54860AE40000EFEED" } ] } ]
}'
```

Response `204`.

## 2. DC → store shipment

| Call | |
|---|---|
| Create | `PUT /logistics/shiporder` — as 1a with `contentFormat: "tag"`, `transactionId: "SHIP-…"`, one `{ "format": "tag", "hexa": "…" }` per packed EPC |
| Read | `POST /datacollector/reads` — `DC_Collector` / `SHIP`, `transactionId: "SHIP-…"` |
| Compare | `GET /logistics/shiporder/compare/{shipId}` |
| Close | `PUT /logistics/shiporder/{shipId}` — as 1d |

### Compare response

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

(One tote not read, one stray tote read; lists trimmed.)

- **Green** = `discrepanciesCount == 0`. `missing` = expected but not read; `notExpected` = read but not on the order.
- Empty lists come back as `{}` instead of `[]` — handle both.
- Right after posting reads, compare can return `404 {"message":"No global results for listId … found"}` for a few
  seconds while reads are processed. Retry every ~3 s.
- Quantity alone is not enough: a missing tote plus a stray tote still counts 20.

## 3. Store receiving (ASN)

**Confirming a shipment and creating the receiving ASN are one step.** Once the shipment is confirmed
(the ship order is closed), the ASN for the destination is created automatically with the same EPCs. The operator
never creates it by hand; the next thing they do is receive. The demo shows it as its own card so you can see
the call, but it fires by itself when the shipment is confirmed. The same applies to the return leg (section 5 → 6).

The call that creates it:

```bash
curl --request PUT --url https://api.bartender-tt.com/logistics/asn \
  --header "apiKey: $API_KEY" --header 'x-tenant: TRGDEMO' --header 'Content-Type: application/json' \
  --data '{
  "asnId": 8133384547531811,
  "contentFormat": "tag",
  "transactionId": "RECV-261019203846",
  "creationTime": "2026-10-19T20:39:10.000Z",
  "expirationTime": null,
  "lastStatusChange": "2026-10-19T20:39:10.000Z",
  "source": "urn:mjx:site:loc:TRGDEMO.00006.0",
  "destination": "urn:mjx:site:loc:TRGDEMO.00007.0",
  "containers": [ { "content": [ { "format": "tag", "hexa": "301401D54860AE40000EFEED" } ] } ]
}'
```

Response `201`: `8457575565891124` → `asnId`. Then:

| Call | |
|---|---|
| Read | `POST /datacollector/reads` — `ST00199_Collector` / `RECV`, `transactionId: "RECV-…"` |
| Compare | `GET /logistics/asn/compare/{asnId}` — same shape as above |
| Get | `GET /logistics/asn/{asnId}` |
| Close | `PUT /logistics/asn/{asnId}` — `status: "done"`, same body as the create minus ids/times, resend `containers` |

## 4. Empty pool (no order)

Pushing the empties through the tunnel is a plain read on the `MOVE_EmptyPool` channel. **No `transactionId`**:
the channel's workflow (Storing / Stored) moves the totes.

```bash
curl --request POST --url https://api.bartender-tt.com/datacollector/reads \
  --header "apiKey: $API_KEY" --header 'x-tenant: TRGDEMO' --header 'Content-Type: application/json' \
  --data '{
  "collectorId": "ST00199_Collector",
  "channelId": "MOVE_EmptyPool",
  "readTime": "2026-10-19T20:39:40.000Z",
  "tags": [ { "hexa": "301401D54860AE40000EFEED", "attributes": {} } ]
}'
```

Response `200` `{"tagsReceived": 20, "status": "COMMITTED", …}`.

## 5. Store → DC return of the empties

Same as section 2 with source and destination swapped:

| Call | |
|---|---|
| Create | `PUT /logistics/shiporder` — `source` = store, `destination` = DC, `contentFormat: "tag"`, `transactionId: "RTN-…"` |
| Read | `POST /datacollector/reads` — `ST00199_Collector` / `SHIP`, `transactionId: "RTN-…"` |
| Compare | `GET /logistics/shiporder/compare/{returnId}` |
| Close | `PUT /logistics/shiporder/{returnId}` |

## 6. DC receiving the empties (ASN)

Same as section 3 with `source` = store, `destination` = DC:

| Call | |
|---|---|
| Create | `PUT /logistics/asn` — `transactionId: "DCRECV-…"` |
| Read | `POST /datacollector/reads` — `DC_Collector` / `RECV`, `transactionId: "DCRECV-…"` |
| Compare | `GET /logistics/asn/compare/{dcAsnId}` |
| Close | `PUT /logistics/asn/{dcAsnId}` |

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

- Create returns a bare-number id; use it (not the `soId`/`asnId` you sent) for everything after.
- Update is a full replace — resend `containers` or the contents are wiped.
- **Reads are permanent.** Tags posted against a `transactionId` cannot be removed, and the order cannot be reset.
  Settle overs/unders locally and send the confirmed set once (see "Design rule" above).
- Compare can 404 for a few seconds after reads; empty lists come back as `{}`.
- **Intermittent `401 {"error":"not_owned","message":"unauthorized"}` with a valid key** — about 1 in 3 calls at times.
  It is rejected in ~2 ms before reaching the service, so the call was not processed and is safe to retry
  (the demo server retries up to 3×). Reported to the platform team.
- Postman examples contain `// comments` inside the JSON — strip them; the API needs valid JSON.
- Use a unique `transactionId` per order, identical between the order and its reads.
