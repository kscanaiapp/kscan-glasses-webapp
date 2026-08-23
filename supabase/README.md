# K Scan Wearable Backend Contract — `kscan.wearable.v1`

Authority: this directory (`supabase/`) is the **source of truth** for the shared
K Scan wearable backend contract (pairing, sessions, scan authorization, action
correlation, Save / Open-on-Phone semantics). It is designed to deploy into the
authoritative K Scan Supabase project alongside `scan-identify` (the canonical
scanner) and the real `saved_scans` table (`20260617215307_create_saved_scans.sql`).

```
K SCAN BACKEND (this contract)
      |
      ├── wearable pairing   (wearable-pairing: challenge → phone approval → revoke)
      ├── wearable sessions  (wearable-session: short TTL, hash-stored tokens)
      ├── scan authorization (wearable-scan → canonical scan-identify, image mode)
      ├── action correlation (requestId / resultId / local_id idempotency)
      └── Save / Open semantics (wearable-save → saved_scans, wearable-open-on-phone)
      |
  -------------
  |           |
META      GOOGLE XR (future adopter — see drift comparison below)
```

## Trust model

- The **phone is the auth authority.** Pairing lifecycle actions
  (`create_challenge`, `approve_challenge`, `reject_challenge`, `revoke_pairing`)
  require the caller's Supabase user JWT. The verified `auth.users.id` is the
  only trusted identity — body-supplied `userId`/`phoneUserId` is ignored
  (takeover-audit repair: the initial implementation trusted body fields).
- The **HUD holds only a short-lived wearable session token** (30 min TTL).
  Tokens are stored server-side as SHA-256 hashes only. No long-lived token,
  refresh token, or raw image ever persists on the wearable.
- `wearable-scan` / `wearable-save` / `wearable-open-on-phone` authenticate via
  the wearable session token (bearer) plus capability checks on the pairing.

## Contract fields

| Field | Rule |
|---|---|
| protocol_version | `kscan.meta.companion.v1` stamped on every session row |
| challenge TTL | 2 minutes, single-use, replay-rejected (`CHALLENGE_USED`/`CHALLENGE_EXPIRED`) |
| session TTL | 30 minutes, `expire_wearable_sessions()` evaluated before every validation |
| resultId | server-minted `wearable_<uuid>`; stored as `saved_scans.local_id` on Save |
| Save idempotency | partial unique index `(user_id, local_id)` + pre-check + 23505 race handling; ACK only after persistence |
| source stamping | `saved_scans.source = 'meta_wearable'`; scanner call uses `source: 'meta_wearable'` |
| error semantics | `{ ok: false, code, message }` with stable codes (`AUTH_REQUIRED`, `INVALID_SESSION`, `RATE_LIMITED`, …) |

## Known Phase-1 limits (intentional, documented)

- Pairing challenges live in per-instance Edge Function memory. Cold starts drop
  outstanding challenges (2-minute TTL makes this harmless); scale-out should
  move them to a table or Redis.
- Rate limiting is per-function-instance. Move to a shared store before public launch.
- Retention: expired/revoked sessions are marked, not purged. A scheduled purge
  job is a Backend Sprint follow-up.

## Google XR comparison (2026-08-19 takeover audit)

The Google XR repo (`kscan-google-glasses`) currently has **no wearable
pairing/session backend at all** — its bridge is a provider abstraction with
mock/dev providers and a phone-bridge TypeScript scaffold. Therefore:

- No accidental contract drift exists today: Meta is the first real adopter.
- The Google `/api/analyze` JSON contract (`{ "image": "data:image/jpeg;base64,..." }`)
  is transport-compatible with this contract's sanitized-JPEG-data-URL input.
- When Google XR adopts the shared backend, it should reuse these tables with
  `device_type = 'google_xr'` and its own `protocol_version`. No parallel
  session system should be created.
- INTENTIONAL PLATFORM DIVERGENCE preserved: transport (DAT bridge vs Android XR
  bridge), UI, and capture mechanics remain platform-specific.
