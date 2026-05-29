# CLAUDE.md — gimd

> All code, comments, UI strings, docs and commit messages in this project are in **English**.

## What it is

`gimd` (GitHub Markdown) is an online Markdown editor. GitHub provides auth, storage and sync.
The server keeps **no local state**: it is a thin authenticated proxy in front of the GitHub REST API.
See `README.md` for the user-facing overview.

## Architecture

- **Stack**: native Node `http` (no framework), single dependency `dotenv`. Node ≥ 18 (native `fetch`, `crypto`).
- **`src/server.js`** — entrypoint. Routing, OAuth (login/callback/logout), AES-256-GCM encryption of the
  session cookie, static file serving from `src/public/`.
- **`src/github.js`** — GitHub REST helpers (`getUser`, `ensureRepo`, `getTree`, `getFile`, `putFile`,
  `deleteFile`). Throws `GitHubError` carrying the HTTP status.
- **`src/public/`** — vanilla-JS frontend (`index.html`, `app.js`, `style.css`), PWA (`manifest.json`,
  `service-worker.js`), icons (`icon.svg` + PNG exports). Regenerate PNGs with
  `rsvg-convert -w <size> -h <size> icon.svg -o icon-<size>.png`.

## Auth model (single user)

- OAuth App, scope `repo`. The OAuth `code→token` exchange is server-side (client secret stays in `.env`).
- The token + login are encrypted into an `httpOnly` + `Secure` + `SameSite=Lax` cookie (`gimd_session`).
  No server-side session store.
- **Allowlist**: after the callback, the authenticated `login` must equal `ALLOWED_GITHUB_LOGIN`,
  otherwise access is denied. Anyone may start the OAuth flow, but only the allowed login gets a cookie.
- A short-lived `gimd_oauth_state` cookie protects the callback against CSRF.

## Data model

- Notes live in a private repo (`NOTES_REPO`, default `gimd-notes`), auto-created with `auto_init` on first use.
- Listing = recursive Git tree (one call). Open = Contents API (returns content + blob `sha`).
  Save = `PUT` (one commit); needs the `sha` to update. Delete = `DELETE` (needs `sha`).
- A stale `sha` → GitHub 409/422 → surfaced to the client as **409** ("This file changed on GitHub, reload.")
  to avoid clobbering changes made elsewhere (other device, AI agent).
- Rename = create-new + delete-old (two commits); no atomic rename in v1.

## Config

`.env` (see `.env.sample`): `PORT`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `OAUTH_CALLBACK_URL`,
`COOKIE_SECRET`, `ALLOWED_GITHUB_LOGIN`, `NOTES_REPO`, `NODE_ENV`. `.env` is gitignored — the repo is public.

## Deployment (this server)

- Lives in `/var/www/gimd` (owner `www-data`), reverse-proxied by Apache at `https://gimd.pbat.ovh`.
- systemd service `gimd` on **port 3004**, `ExecStart=/usr/bin/node src/server.js`.
- **Single branch `main`, manual deploy** (no deploy.sh, no webhook):

  ```bash
  cd /var/www/gimd && sudo -u www-data git pull origin main
  npm install            # only if dependencies changed
  systemctl restart gimd
  ```
- Backup: only `/var/www/gimd/.env` matters (everything else is on GitHub).
