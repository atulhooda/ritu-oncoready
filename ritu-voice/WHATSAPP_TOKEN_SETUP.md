# WhatsApp Token Setup — System-User Never-Expire Token

**Why:** a regular user token expires in ~60 days. When it dies, every WhatsApp
send fails with Meta error **190** and confirmations silently stop (the
mid-demo incident). A Business **System User** token minted with the "Never"
expiry option removes the entire expiry class. This is the single
highest-value config change in the S7 reliability plan.

## Mint the token (one time, ~5 minutes)

1. Open **[business.facebook.com/settings](https://business.facebook.com/settings)**
   for the business that owns the WhatsApp Business Account (WABA).
2. Left sidebar → **Users → System users** → **Add**.
   - Name: e.g. `ritu-server`. Role: **Admin** (or Employee — Admin is simpler
     and this is a single-purpose business).
3. Select the new system user → **Add Assets**:
   - **Apps** → select the Meta app the WhatsApp number is registered under →
     enable **Manage app (full control)**.
   - (If listed) **WhatsApp accounts** → select the WABA → full control.
4. Still on the system user → **Generate New Token**:
   - App: the same Meta app.
   - **Token expiration: Never** ← the entire point. Do not pick 60 days.
   - Permissions — check exactly these three:
     - `whatsapp_business_messaging`
     - `whatsapp_business_management`
     - `business_management`
   - **Generate Token** → copy it NOW (it is shown once).

## Install the token

Set it as **`META_ACCESS_TOKEN`** in the server's environment (same variable
the code already reads — `config.whatsapp.accessToken`). Restart the server.

Notes:
- `META_PHONE_NUMBER_ID`, `META_WEBHOOK_VERIFY_TOKEN`, `META_BUSINESS_ACCOUNT_ID`
  are unchanged — only the token is replaced.
- Clinics connected via the admin app's "Connect WhatsApp" flow use their own
  encrypted token (`clinic_whatsapp_secrets`) and are unaffected.

## Verify

```
curl "https://graph.facebook.com/v18.0/debug_token?input_token=<TOKEN>&access_token=<TOKEN>"
```

Healthy = `"is_valid": true` and `"expires_at": 0` (0 means never expires).

Then enable the daily health check (off by default):

```
TOKEN_HEALTH_CHECK=on
```

The server probes `debug_token` daily at 08:30 IST, logs days-to-expiry, and
alerts (n8n webhook `whatsapp_token_alert` + `[WA-TOKEN-ALERT]` in logs) if
the token is invalid or expiring within 14 days. Any live send failing with
error 190 also fires the same alert immediately.

## Redrive runbook (after failed sends)

Failed sends are dead-lettered in `whatsapp_dlq` (migration
`db/migrations/006_whatsapp_dlq.sql`) with the full payload. After fixing the
cause (e.g. this token swap):

1. `node tools/redriveWhatsApp.js --dry-run` — review what would be re-sent.
2. `node tools/redriveWhatsApp.js` — replays definitive failures (≤48h old).
3. Timeout rows are skipped (marked `indeterminate` — Meta may have already
   delivered them; no idempotency key exists, a re-send would double-message).
   Only after confirming nothing arrived: add `--include-indeterminate`.
