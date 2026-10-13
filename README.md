# probcapital-saas

ProbCapital SaaS sales landing (white-label prop firm platform) + lead intake.

- `server.js` — zero-dependency Node server: serves `public/`, accepts `POST /api/lead`.
- Leads are appended to `data/leads.jsonl` (mount a persistent volume at `/app/data` in Coolify)
  and forwarded to Telegram when `TELEGRAM_BOT_TOKEN` + `LEADS_CHAT_ID` env vars are set.
- `GET /health` → `{ok:true}`.

Run locally: `PORT=3000 node server.js`.
