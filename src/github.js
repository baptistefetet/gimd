'use strict';

// Thin wrapper around the GitHub REST API.
// Every call is authenticated with the user's OAuth token (Bearer).
// No local storage: GitHub is the single source of truth.

const API = 'https://api.github.com';

const BASE_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'gimd'
};

// Error carrying the HTTP status so the server can map it to a response.
class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

// Perform an authenticated request. Returns the parsed JSON body (or null for 204).
// Throws GitHubError on non-2xx responses.
async function request(token, method, endpoint, body) {
  const headers = { ...BASE_HEADERS, Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${API}${endpoint}`, init);

  if (res.status === 204) return null;

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_) {
      payload = { message: text };
    }
  }

  if (!res.ok) {
    const message = (payload && payload.message) || `GitHub API error (${res.status})`;
    throw new GitHubError(res.status, message);
  }
  return payload;
}

// Encode a repo path while preserving the slash separators.
function encodePath(filePath) {
  return filePath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

// Returns the authenticated user's profile ({ login, ... }).
function getUser(token) {
  return request(token, 'GET', '/user');
}

// Ensures the notes repository exists (creates it private if missing).
// Returns the repository's default branch name.
async function ensureRepo(token, owner, repo) {
  try {
    const info = await request(token, 'GET', `/repos/${owner}/${encodeURIComponent(repo)}`);
    return info.default_branch || 'main';
  } catch (err) {
    if (err.status !== 404) throw err;
    const created = await request(token, 'POST', '/user/repos', {
      name: repo,
      description: 'Notes managed by gimd (https://github.com/baptistefetet/gimd).',
      private: true,
      auto_init: true
    });
    return created.default_branch || 'main';
  }
}

// Returns the full recursive tree of the repo as a flat list of
// { path, type ('blob'|'tree'), sha }. The GitHub trees endpoint accepts a
// branch/tag/ref name in place of a tree SHA.
async function getTree(token, owner, repo, branch) {
  const data = await request(
    token,
    'GET',
    `/repos/${owner}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );
  const tree = Array.isArray(data.tree) ? data.tree : [];
  return {
    truncated: Boolean(data.truncated),
    entries: tree.map((e) => ({ path: e.path, type: e.type, sha: e.sha }))
  };
}

// Returns { content (utf-8 string), sha } for a file.
async function getFile(token, owner, repo, filePath) {
  const data = await request(
    token,
    'GET',
    `/repos/${owner}/${encodeURIComponent(repo)}/contents/${encodePath(filePath)}`
  );
  if (Array.isArray(data)) {
    throw new GitHubError(400, 'Path is a directory, not a file');
  }
  const content = Buffer.from(data.content || '', 'base64').toString('utf8');
  return { content, sha: data.sha };
}

// Creates or updates a file (one commit). Pass sha to update an existing file;
// omit it to create a new one. Returns the new blob sha.
// A stale sha makes GitHub answer 409 -> surfaced as GitHubError(409).
async function putFile(token, owner, repo, filePath, content, sha, message) {
  const body = {
    message: message || `gimd: update ${filePath}`,
    content: Buffer.from(content, 'utf8').toString('base64')
  };
  if (sha) body.sha = sha;
  const data = await request(
    token,
    'PUT',
    `/repos/${owner}/${encodeURIComponent(repo)}/contents/${encodePath(filePath)}`,
    body
  );
  return data.content.sha;
}

// Deletes a file (one commit). Requires the current sha.
function deleteFile(token, owner, repo, filePath, sha, message) {
  return request(
    token,
    'DELETE',
    `/repos/${owner}/${encodeURIComponent(repo)}/contents/${encodePath(filePath)}`,
    { message: message || `gimd: delete ${filePath}`, sha }
  );
}

module.exports = {
  GitHubError,
  getUser,
  ensureRepo,
  getTree,
  getFile,
  putFile,
  deleteFile
};
