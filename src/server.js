'use strict';

// gimd — GitHub Markdown editor.
// A thin authenticated proxy in front of the GitHub REST API:
//   - OAuth login (single-user allowlist)
//   - encrypted, httpOnly session cookie (no server-side storage)
//   - read/write Markdown files in a private notes repo (every save = a commit)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

try {
  require('dotenv').config();
} catch (_) {
  // dotenv is optional; fall back to process env only.
}

const github = require('./github');

const PORT = parseInt(process.env.PORT, 10) || 3004;
const NODE_ENV = process.env.NODE_ENV || 'production';
const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const CALLBACK_URL = process.env.OAUTH_CALLBACK_URL;
const COOKIE_SECRET = process.env.COOKIE_SECRET || '';
const ALLOWED_LOGIN = (process.env.ALLOWED_GITHUB_LOGIN || '').toLowerCase();
const NOTES_REPO = process.env.NOTES_REPO || 'gimd-notes';

// Fail fast on misconfiguration.
const required = {
  GITHUB_CLIENT_ID: CLIENT_ID,
  GITHUB_CLIENT_SECRET: CLIENT_SECRET,
  OAUTH_CALLBACK_URL: CALLBACK_URL,
  COOKIE_SECRET,
  ALLOWED_GITHUB_LOGIN: ALLOWED_LOGIN
};
const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}. See .env.sample.`);
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'gimd_session';
const STATE_COOKIE = 'gimd_oauth_state';
const SESSION_MAX_AGE = 90 * 24 * 60 * 60; // 90 days
const STATE_MAX_AGE = 600; // 10 minutes

// AES-256-GCM key derived from the configured secret.
const KEY = crypto.createHash('sha256').update(COOKIE_SECRET).digest();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// --- crypto helpers ---------------------------------------------------------

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decrypt(value) {
  try {
    const buf = Buffer.from(value, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

// --- cookie helpers ---------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join('=') || '');
  }
  return out;
}

function buildCookie(name, value, maxAge) {
  const flags = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (NODE_ENV === 'production') flags.push('Secure');
  return flags.join('; ');
}

function clearCookie(name) {
  return buildCookie(name, '', 0);
}

function getSession(req) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;
  const decrypted = decrypt(raw);
  if (!decrypted) return null;
  try {
    const obj = JSON.parse(decrypted);
    if (obj && obj.token && obj.login) return obj;
  } catch (_) {
    // fall through
  }
  return null;
}

// --- response helpers -------------------------------------------------------

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

function noticePage(title, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gimd — ${title}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0d0f14; color:#e6e6e6; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .card { max-width:32rem; padding:2rem; text-align:center; }
  h1 { color:#a78bfa; font-size:1.4rem; }
  a { color:#a78bfa; }
</style>
</head>
<body><div class="card"><h1>${title}</h1><p>${message}</p><p><a href="/">Back to gimd</a></p></div></body>
</html>`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let acc = '';
    req.on('data', (chunk) => {
      acc += chunk;
      if (acc.length > 5e6) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!acc.trim()) return resolve({});
      try {
        resolve(JSON.parse(acc));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// --- OAuth ------------------------------------------------------------------

function handleLogin(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', CALLBACK_URL);
  url.searchParams.set('scope', 'repo');
  url.searchParams.set('state', state);
  redirect(res, url.toString(), { 'Set-Cookie': buildCookie(STATE_COOKIE, state, STATE_MAX_AGE) });
}

async function handleCallback(req, res, urlObj) {
  const code = urlObj.searchParams.get('code');
  const state = urlObj.searchParams.get('state');
  const stateCookie = parseCookies(req.headers.cookie)[STATE_COOKIE];

  if (!code || !state || state !== stateCookie) {
    return sendHtml(res, 400, noticePage('Invalid request', 'OAuth state mismatch. Please try connecting again.'), {
      'Set-Cookie': clearCookie(STATE_COOKIE)
    });
  }

  // Exchange the authorization code for an access token (server-side: client_secret stays here).
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'gimd' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: CALLBACK_URL
    })
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  const token = tokenJson.access_token;
  if (!token) {
    return sendHtml(res, 502, noticePage('Connection failed', 'GitHub did not return an access token.'));
  }

  // Identify the user and enforce the single-user allowlist.
  let login;
  try {
    login = (await github.getUser(token)).login;
  } catch (_) {
    return sendHtml(res, 502, noticePage('Connection failed', 'Could not read your GitHub profile.'));
  }

  if (!login || login.toLowerCase() !== ALLOWED_LOGIN) {
    return sendHtml(res, 403, noticePage('Access restricted', 'This gimd instance is private.'), {
      'Set-Cookie': clearCookie(STATE_COOKIE)
    });
  }

  const session = encrypt(JSON.stringify({ token, login }));
  redirect(res, '/', {
    'Set-Cookie': [buildCookie(SESSION_COOKIE, session, SESSION_MAX_AGE), clearCookie(STATE_COOKIE)]
  });
}

function handleLogout(req, res) {
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(SESSION_COOKIE) });
}

// --- API --------------------------------------------------------------------

function handleMe(req, res) {
  const session = getSession(req);
  if (!session) return sendError(res, 401, 'Not authenticated');
  sendJson(res, 200, { login: session.login, repo: NOTES_REPO });
}

async function handleTree(res, session) {
  const branch = await github.ensureRepo(session.token, session.login, NOTES_REPO);
  const tree = await github.getTree(session.token, session.login, NOTES_REPO, branch);
  sendJson(res, 200, { repo: NOTES_REPO, branch, truncated: tree.truncated, entries: tree.entries });
}

async function handleGetFile(res, session, urlObj) {
  const filePath = urlObj.searchParams.get('path');
  if (!filePath) return sendError(res, 400, 'Missing path');
  const file = await github.getFile(session.token, session.login, NOTES_REPO, filePath);
  sendJson(res, 200, file);
}

async function handlePutFile(req, res, session) {
  const body = await parseBody(req);
  if (!body.path || typeof body.content !== 'string') {
    return sendError(res, 400, 'Missing path or content');
  }
  const sha = await github.putFile(
    session.token, session.login, NOTES_REPO, body.path, body.content, body.sha, body.message
  );
  sendJson(res, 200, { sha });
}

async function handleDeleteFile(req, res, session) {
  const body = await parseBody(req);
  if (!body.path || !body.sha) return sendError(res, 400, 'Missing path or sha');
  await github.deleteFile(session.token, session.login, NOTES_REPO, body.path, body.sha, body.message);
  sendJson(res, 200, { ok: true });
}

function handleApiError(res, err) {
  if (err instanceof github.GitHubError) {
    if (err.status === 409 || err.status === 422) {
      return sendError(res, 409, 'This file changed on GitHub, reload.');
    }
    if (err.status === 401) {
      return sendError(res, 401, 'GitHub authorization expired. Please reconnect.');
    }
    return sendError(res, err.status, err.message);
  }
  console.error('API error:', err);
  return sendError(res, 500, 'Internal server error');
}

// --- static -----------------------------------------------------------------

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, 403, 'Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendError(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// --- router -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = urlObj;
  const method = req.method;

  try {
    if (pathname === '/auth/login' && method === 'GET') return handleLogin(req, res);
    if (pathname === '/auth/callback' && method === 'GET') return await handleCallback(req, res, urlObj);
    if (pathname === '/auth/logout' && method === 'POST') return handleLogout(req, res);
    if (pathname === '/api/me' && method === 'GET') return handleMe(req, res);

    if (pathname.startsWith('/api/')) {
      const session = getSession(req);
      if (!session) return sendError(res, 401, 'Not authenticated');
      try {
        if (pathname === '/api/tree' && method === 'GET') return await handleTree(res, session);
        if (pathname === '/api/file' && method === 'GET') return await handleGetFile(res, session, urlObj);
        if (pathname === '/api/file' && method === 'PUT') return await handlePutFile(req, res, session);
        if (pathname === '/api/file' && method === 'DELETE') return await handleDeleteFile(req, res, session);
        return sendError(res, 404, 'Unknown endpoint');
      } catch (err) {
        return handleApiError(res, err);
      }
    }

    if (method === 'GET') return serveStatic(req, res, pathname);
    return sendError(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('Unhandled error:', err);
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`gimd listening on http://localhost:${PORT} (${NODE_ENV})`);
});
