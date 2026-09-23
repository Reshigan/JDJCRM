# LIS integration

Baton works without a LIS: the laboratory records its stages on the **Sample desk**. With a LIS connected, the lab stages are recorded automatically at the moment they happen in the LIS, and requisition numbers are checked as they are typed.

## Inbound events (LIS → Baton)

`POST https://<baton>/api/integrations/lis/events`, with `Content-Type: application/json`.

```json
{ "event_id": "LIS-8f2c1", "event": "results_released", "requisition_no": "RQ-414357", "at": "2026-09-23T12:35:00+02:00" }
```

| Field | Required | Meaning |
|---|---|---|
| `event_id` | yes | Unique per event. Re-sending the same id returns the stored result and is not applied twice, so retries are safe. |
| `event` | yes | `sample_received` (Pre-Analytical accepts), `lab_accepted` (lab accepts) or `results_released` (all results released). |
| `requisition_no` or `bleed_number` | one of them | Identifies the active bleed. Requisition matching ignores case. |
| `at` | no | When it happened. It is used if it falls between the previous checkpoint and now; otherwise the time of receipt is used. |
| `breach_reason` | no | Needed only if the stage is late. If a late event has no reason, the stage is still recorded (the fact matters), marked **"Pending"**, and the owning department's manager is asked to add the reason on the bleed page. |

**Signature.** Every request must carry two headers:

- `X-Baton-Timestamp`: Unix time in seconds. It must be within 5 minutes of the server clock.
- `X-Baton-Signature`: `sha256=` followed by the hex HMAC-SHA256 of `"<timestamp>.<raw body>"`, keyed with `LIS_WEBHOOK_SECRET`.

```sh
ts=$(date +%s); body='{"event_id":"t1","event":"sample_received","requisition_no":"RQ-1"}'
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$LIS_WEBHOOK_SECRET" -hex | cut -d' ' -f2)
curl -sk https://baton.local/api/integrations/lis/events -H 'content-type: application/json' \
  -H "x-baton-timestamp: $ts" -H "x-baton-signature: sha256=$sig" -d "$body"
```

**Responses.**

- `200 {"ok":true,"bleed":"BLD-…"}`: the event was applied.
- `200 {"ok":false,"error":"…"}`: the event was valid but not applied, for example "No active bleed matches" or "The previous stage is not complete".
- `401`: bad signature or timestamp.
- `404`: the integration is disabled (no secret configured).

Every event is recorded in the audit trail as `integration.lis_event`. Stages recorded this way show the LIS as their source.

## Requisition check (Baton → LIS)

Set `LIS_VALIDATE_URL`, e.g. `https://lis.jdj.local/api/requisitions/{requisition}`. `{requisition}` is replaced with the number being checked. Optionally set `LIS_TOKEN`, which is sent as a Bearer token.

| LIS answer | Baton shows |
|---|---|
| `200` (optionally `{"patient_name": "…"}`) | "Found in the LIS", plus whether the patient name matches |
| `404` | "Not found in the LIS — check the number" |
| anything else, or no answer within 3 s | nothing |

Only found / not found and match / no match are passed back to the browser. The LIS's patient details are never shown. The check runs on the query intake form and on the nurse's bleed capture.

If your LIS speaks HL7 v2 over MLLP rather than HTTP, put a small interface engine (e.g. Mirth / NextGen Connect) in front. It maps ORU/OML messages to the events above.
