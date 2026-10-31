# probcapital-saas

ProbCapital SaaS sales landing (white-label prop firm platform) + lead intake.

- `server.js` — zero-dependency Node server: serves `public/`, accepts `POST /api/lead`.
- Leads are appended to `data/leads.jsonl` (mount a persistent volume at `/app/data` in Coolify)
  and forwarded to Telegram when `TELEGRAM_BOT_TOKEN` + `LEADS_CHAT_ID` env vars are set.
- Lead auto-reply email (optional): when `RESEND_API_KEY` is set, every lead with a
  reachable email address gets a confirmation email via Resend (fire-and-forget —
  a mail failure never affects intake). `LEAD_AUTOREPLY_FROM` overrides the sender
  (default `ProbCapital <noreply@probcapital.com>`, the main app's sender);
  `LEAD_AUTOREPLY_REPLY_TO` optionally sets where lead replies land.
- `GET /health` → `{ok:true}`.
- `GET /status` — public status page: checks the SaaS site, trader platform
  (app.probcapital.com), public site (probcapital.com) and quote feed
  (quotes.probcapital.com/health) at request time (30s cache), reporting
  up / degraded (>2s) / down with the check timestamp; `GET /status.json`
  returns the same checks as JSON. No uptime percentage is shown — public
  status reporting starts with this page, so there is no measured history
  behind a figure yet.

Run locally: `PORT=3000 node server.js`.
