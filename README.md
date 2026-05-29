# gimd — GitHub Markdown

A fully online Markdown editor that uses **GitHub** for everything:

- **Authentication** — you sign in with your GitHub account (OAuth).
- **Storage** — your notes live in a private repository on *your* GitHub, not on the server.
- **Sync & versioning** — every save is a Git commit pushed to GitHub. History is free.

There is **no local storage on the server**. The Node app is a thin, authenticated proxy in
front of the GitHub REST API. Because your notes are just files in a Git repo, any tool — including
AI agents — can read or edit them with plain repo access, no extra configuration.

> Plain text only for now: Markdown is shown and edited as raw text (no rendered preview).

## How it works

1. You click **Connect GitHub** → standard OAuth flow.
2. The server exchanges the code for an access token (the OAuth client secret never leaves the server)
   and stores it in an **encrypted, `httpOnly` cookie** — never exposed to JavaScript, no server-side session store.
3. On first use, a private repository (default name `gimd-notes`) is **created automatically** if it doesn't exist.
4. Listing the tree, opening, saving (commit), and deleting all go through the GitHub Contents API.
5. Each open file tracks its blob `sha`. If the file changed on GitHub meanwhile (another device, an
   AI agent…), saving returns a conflict instead of silently overwriting — reload to get the latest.

This is a **single-user** instance: only the GitHub login configured in `ALLOWED_GITHUB_LOGIN` is allowed in.

## Setup (self-host / fork)

Requirements: **Node.js ≥ 18** (uses the native `fetch`).

1. **Create a GitHub OAuth App** — <https://github.com/settings/developers> → *OAuth Apps* → *New*:
   - Homepage URL: `https://your-domain`
   - Authorization callback URL: `https://your-domain/auth/callback`

2. **Configure** — copy `.env.sample` to `.env` and fill it in:

   ```
   PORT=3004
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   OAUTH_CALLBACK_URL=https://your-domain/auth/callback
   COOKIE_SECRET=<openssl rand -hex 32, or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   ALLOWED_GITHUB_LOGIN=your-github-login
   NOTES_REPO=gimd-notes
   NODE_ENV=production
   ```

3. **Run**

   ```
   npm install
   npm start
   ```

   Put it behind a reverse proxy that terminates TLS (HTTPS is required: the session cookie is `Secure`
   in production, and GitHub OAuth callbacks must use your public HTTPS URL).

## Project layout

```
src/
  server.js        HTTP server: routing, OAuth, cookie encryption, static files
  github.js        GitHub REST helpers (auth'd with the user token)
  public/          frontend (vanilla JS) + PWA assets + icons
```

## Scope / non-goals (v1)

- No Markdown rendering (raw text only).
- Rename is implemented as create-new + delete-old (two commits).
- Single user, no offline editing, no full-text search.

## License

MIT
