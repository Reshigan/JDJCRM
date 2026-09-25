# LIS integration

Pelo CRM works without a LIS: the laboratory records its stages on the **Sample desk**. With a LIS connected, the lab stages are recorded automatically at the moment they happen in the LIS, and requisition numbers are checked as they are typed.

## Inbound events (LIS → Pelo CRM)

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
curl -sk https://crm.local/api/integrations/lis/events -H 'content-type: application/json' \
  -H "x-baton-timestamp: $ts" -H "x-baton-signature: sha256=$sig" -d "$body"
```

**Responses.**

- `200 {"ok":true,"bleed":"BLD-…"}`: the event was applied.
- `200 {"ok":false,"error":"…"}`: the event was valid but not applied, for example "No active bleed matches" or "The previous stage is not complete".
- `401`: bad signature or timestamp.
- `404`: the integration is disabled (no secret configured).

Every event is recorded in the audit trail as `integration.lis_event`. Stages recorded this way show the LIS as their source.

## Requisition check (Pelo CRM → LIS)

Set `LIS_VALIDATE_URL`, e.g. `https://lis.jdj.local/api/requisitions/{requisition}`. `{requisition}` is replaced with the number being checked. Optionally set `LIS_TOKEN`, which is sent as a Bearer token.

| LIS answer | Pelo CRM shows |
|---|---|
| `200` (optionally `{"patient_name": "…"}`) | "Found in the LIS", plus whether the patient name matches |
| `404` | "Not found in the LIS — check the number" |
| anything else, or no answer within 3 s | nothing |

Only found / not found and match / no match are passed back to the browser. The LIS's patient details are never shown. The check runs on the query intake form and on the nurse's bleed capture.

## SkyLIMS (Mukon Informatics): HL7 v2 over MLLP

JDJ's LIS is SkyLIMS. Pelo CRM has a built-in HL7 v2 listener for it, so no interface engine is needed. Mukon's interface specification was not available when this was built. The message mapping below is therefore a **starting point to confirm with Mukon**, and it can be changed in Administration with no release.

**Enable it.**

1. In `.env`, set `COMPOSE_PROFILES=skylims` and `SKYLIMS_ALLOW=<SkyLIMS interface server IP>`.
2. Run `docker compose up -d`.
3. The `lis` container listens on TCP **2575**. For TLS, mount a certificate and set `SKYLIMS_TLS_CERT` and `SKYLIMS_TLS_KEY`.
4. Ask Mukon to send order-status and result messages for JDJ's orders to `<baton-host>:2575`, using standard MLLP framing.
5. Test the link with `node scripts/hl7-ping.mjs <baton-host>`, which should print `MSA|AA`.

**What Pelo CRM does with each message.**

- Every message gets an ACK:
  - `AA`: accepted. This includes messages that aren't hospital bleeds, so SkyLIMS never resends them in a loop.
  - `AE`: the message maps to a lab stage but has no requisition number.
  - `AR`: the message could not be parsed.
- The message control ID (MSH-10) is the event ID. A resent message is recorded only once.
- The requisition number finds the active bleed. The stage is then recorded exactly as for the webhook above: order checks, "Pending" breach reasons, and the audit trail with source **SkyLIMS**.
- **POPIA.** The message itself is discarded. Result messages carry results and patient details, and Pelo CRM keeps neither. It keeps only the event, the time, the requisition number and the outcome.
- **Administration → System status** shows the last message received, its outcome, and the error count.

**Mapping** (Admin → Settings → `skylims_mapping`). A path is `SEGMENT-field[.component]`; the component defaults to 1. A rule applies when **every** listed field matches its regular expression in **every** occurrence of its segment. So "results released" needs all OBR segments to be final, and partial results are ignored.

```json
{
  "requisition": ["ORC-2", "OBR-2", "ORC-3", "OBR-3"],
  "events": [
    { "event": "sample_received",  "match": { "MSH-9": "^(ORM|OML|OUL|SSU)$", "ORC-5": "^SC$" }, "time": ["OBR-14", "MSH-7"] },
    { "event": "lab_accepted",     "match": { "MSH-9": "^(ORM|OML|OUL|SSU)$", "ORC-5": "^IP$" }, "time": ["MSH-7"] },
    { "event": "results_released", "match": { "MSH-9": "^ORU$", "OBR-25": "^F$" },                "time": ["OBR-22", "MSH-7"] }
  ]
}
```

- `requisition`: the fields to try, in order. The first non-empty one is the requisition number. The default tries the placer number first, then the filler number.
- `time`: when the stage happened. HL7 times without a time zone are read as SAST.

**To confirm with Mukon.**

1. Which message and status code mark each of the three stages?
2. Which field carries JDJ's requisition number?
3. Is **SkyLog** in use? If it is, "sample received" should come from SkyLIMS/SkyLog. The Pre-Analytical sample desk then only confirms it, so two systems don't record the same moment.
4. Is there a requisition lookup that Pelo CRM can call at intake? If so, set `LIS_VALIDATE_URL` above.

An HL7 interface engine (e.g. Mirth / NextGen Connect) can still sit in front and post to the webhook instead, if JDJ prefers one.
