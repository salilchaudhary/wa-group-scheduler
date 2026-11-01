# WhatsApp Group Scheduler

Schedule WhatsApp messages — text, images, videos or documents — to the groups you own, from a password-protected web dashboard. It links to your WhatsApp the same way WhatsApp Web does (scan a QR code once), and runs on an always-on server so messages go out even when your laptop is off.

> **Important:** this uses [whatsapp-web.js](https://wwebjs.dev), an unofficial library. It is not allowed by WhatsApp's Terms of Service, and accounts can be banned. Keep volume low and human-like (it already adds random gaps between sends), only message groups whose members expect it, and consider using a secondary number.

## Features

- Only groups **you created** are listed and can be messaged (configurable — see `GROUP_FILTER`). Every send re-checks this.
- One-time scheduled messages, to one or several groups at once
- Attachments: images/videos go as media with your message as the caption; other files go as documents
- Dashboard: QR login, upcoming / sent / failed lists, cancel, "send now"
- Survives restarts: login session, schedules and files live in `./data`
- If the server was down at the scheduled time, it still sends if it's less than `MAX_LATE_MINUTES` late, otherwise marks the message **missed** (you can then hit "Send now")

## Deploy on a server (recommended)

Any small Linux VPS works — 1 vCPU / 2 GB RAM is comfortable (Chromium needs ~400–700 MB). A region close to you (e.g. Mumbai) is nice but not required.

1. **Install Docker** on the server (Ubuntu):
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
2. **Copy this folder** to the server (e.g. `scp -r wa-group-scheduler user@SERVER_IP:~`) and go into it:
   ```bash
   cd ~/wa-group-scheduler
   cp .env.example .env
   nano .env          # set a long DASHBOARD_PASSWORD
   ```
3. **Start it:**
   ```bash
   docker compose up -d --build
   docker compose logs -f     # watch it start; Ctrl+C to stop watching
   ```
4. Open `http://SERVER_IP:3000`, log in with your dashboard user/password, and scan the QR code from your phone: **WhatsApp → Settings → Linked devices → Link a device**.

That's it. Your groups appear in the left panel; pick groups, write a message, attach a file if you like, choose a time, and **Schedule**. Times are entered in your browser's local time.

### Use HTTPS (strongly recommended)

The dashboard can send messages as you, so don't leave it on plain HTTP. Easiest option is [Caddy](https://caddyserver.com) with a domain pointing at the server:

```bash
sudo apt install -y caddy
echo 'scheduler.yourdomain.com {
  reverse_proxy localhost:3000
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Then change the port line in `docker-compose.yml` to `"127.0.0.1:3000:3000"` so the app is only reachable through Caddy, and run `docker compose up -d` again.

## Run locally (for testing)

Needs Node 18+.

```bash
npm install
cp .env.example .env     # set DASHBOARD_PASSWORD
export $(grep -v '^#' .env | xargs)
npm start
```

Open http://localhost:3000.

## Everyday operations

| Task | Command |
|---|---|
| View logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Update after changing code | `docker compose up -d --build` |
| Back up everything | copy the `data/` folder |
| Switch WhatsApp account | "Unlink WhatsApp" in the dashboard, then scan with the other phone |

Keep your phone connected to the internet at least every couple of weeks — WhatsApp unlinks devices whose main phone has been offline for ~14 days.

## Troubleshooting

**No groups show up.** WhatsApp sometimes doesn't report group ownership reliably (especially for very old groups or after WhatsApp's switch to private "LID" member ids). Try **Refresh** first. If they're still missing, set `GROUP_FILTER=admin` in `.env` (your groups where you're admin), or `GROUP_FILTER=all` as a last resort, then `docker compose up -d`.

**Stuck on "Starting…" or the QR never appears.** Check `docker compose logs`. Out-of-memory is the usual cause — use a server with 2 GB RAM. If whatsapp-web.js reports a WhatsApp Web version problem, update it: `npm install whatsapp-web.js@latest`, then rebuild.

**A message shows "failed".** The error is shown next to it. Typical causes: you left the group, lost admin/owner rights, or the attachment was too big for WhatsApp. Fix it and press **Send now**.

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_USER` / `DASHBOARD_PASSWORD` | `admin` / — | Dashboard login. Password is required (8+ chars). |
| `GROUP_FILTER` | `owner` | `owner`, `admin` or `all` |
| `MAX_LATE_MINUTES` | `60` | How late a message may still be sent after downtime |
| `MIN_GAP_SECONDS` / `MAX_GAP_SECONDS` | `4` / `10` | Random pause between consecutive sends |
| `MAX_UPLOAD_MB` | `64` | Attachment size limit |
| `TZ` | `Asia/Kolkata` | Server timezone for logs |

## How it's built

- `src/whatsapp.js` — WhatsApp connection, QR login, owned-group detection, sending
- `src/scheduler.js` — checks every 15 s for due messages and sends them one by one
- `src/store.js` — schedules saved to `data/schedules.json`
- `src/server.js` — Express API + basic auth
- `public/index.html` — the dashboard
