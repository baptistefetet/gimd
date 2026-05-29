'use strict';

// gimd frontend: talks only to our own server (which proxies GitHub).
// No persistence in the browser; unsaved edits are lost on refresh by design.

const loginEl = document.getElementById('login');
const appEl = document.getElementById('app');
const treeEl = document.getElementById('tree');
const treeNoteEl = document.getElementById('treeNote');
const contentEl = document.getElementById('content');
const currentPathEl = document.getElementById('currentPath');
const dirtyDot = document.getElementById('dirtyDot');
const saveBtn = document.getElementById('saveBtn');
const newBtn = document.getElementById('newBtn');
const newFolderBtn = document.getElementById('newFolderBtn');
const reloadBtn = document.getElementById('reloadBtn');
const logoutBtn = document.getElementById('logoutBtn');
const backBtn = document.getElementById('backBtn');
const repoNameEl = document.getElementById('repoName');
const toastEl = document.getElementById('toast');

let entriesByPath = new Map(); // path -> { path, type, sha }
let current = null;            // { path, sha }
let dirty = false;

// --- helpers ----------------------------------------------------------------

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_) { /* leave null */ }
  }
  return { ok: res.ok, status: res.status, data };
}

let toastTimer;
function toast(message, isError) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', Boolean(isError));
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
}

function setDirty(value) {
  dirty = value;
  dirtyDot.classList.toggle('hidden', !value);
  saveBtn.disabled = !(current && value);
}

function showEditorView() {
  document.body.classList.remove('view-tree');
  document.body.classList.add('view-editor');
}
function showTreeView() {
  document.body.classList.remove('view-editor');
  document.body.classList.add('view-tree');
}

function setActive(path) {
  document.querySelectorAll('.file-row').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === path);
  });
}

// --- tree rendering ---------------------------------------------------------

function buildModel(entries) {
  const root = { dirs: new Map(), files: [] };
  for (const e of entries) {
    if (e.type !== 'blob') continue;
    const parts = e.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    const name = parts[parts.length - 1];
    // .gitkeep only exists to keep an otherwise-empty folder; its parent dir node
    // was created by the walk above, so the folder still shows — we just don't list it.
    if (name === '.gitkeep') continue;
    node.files.push({ name, path: e.path });
  }
  return root;
}

function renderNode(node) {
  const ul = document.createElement('ul');

  for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row dir-row';
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = '▾';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    row.append(twisty, label);
    const children = renderNode(node.dirs.get(name));
    row.addEventListener('click', () => {
      const collapsed = children.classList.toggle('hidden');
      twisty.textContent = collapsed ? '▸' : '▾';
    });
    li.append(row, children);
    ul.append(li);
  }

  for (const file of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row file-row';
    row.dataset.path = file.path;

    const marker = document.createElement('span');
    marker.className = 'marker';
    marker.textContent = '#';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = file.name;

    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'icon-btn';
    renameBtn.title = 'Rename';
    renameBtn.textContent = '✎';
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.title = 'Delete';
    delBtn.textContent = '🗑';
    actions.append(renameBtn, delBtn);

    row.append(marker, label, actions);
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.row-actions')) return;
      openFile(file.path);
    });
    renameBtn.addEventListener('click', (ev) => { ev.stopPropagation(); renameFile(file.path); });
    delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); deleteFile(file.path); });

    li.append(row);
    ul.append(li);
  }

  return ul;
}

function renderTree(entries, truncated) {
  treeEl.innerHTML = '';
  treeEl.append(renderNode(buildModel(entries)));
  if (current) setActive(current.path);
  treeNoteEl.classList.toggle('hidden', !truncated);
  if (truncated) treeNoteEl.textContent = 'Repository too large to list fully.';
}

// --- data operations --------------------------------------------------------

async function loadTree() {
  const r = await api('GET', '/api/tree');
  if (!r.ok) return toast((r.data && r.data.error) || 'Failed to load files', true);
  entriesByPath = new Map();
  for (const e of r.data.entries) entriesByPath.set(e.path, e);
  renderTree(r.data.entries, r.data.truncated);
}

async function openFile(path) {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  const r = await api('GET', '/api/file?path=' + encodeURIComponent(path));
  if (!r.ok) return toast((r.data && r.data.error) || 'Failed to open file', true);
  current = { path, sha: r.data.sha };
  contentEl.value = r.data.content;
  currentPathEl.textContent = path;
  setActive(path);
  setDirty(false);
  showEditorView();
  contentEl.focus();
}

async function save() {
  if (!current || !dirty) return;
  const r = await api('PUT', '/api/file', { path: current.path, content: contentEl.value, sha: current.sha });
  if (r.status === 409) return toast('This file changed on GitHub, reload.', true);
  if (!r.ok) return toast((r.data && r.data.error) || 'Save failed', true);
  current.sha = r.data.sha;
  setDirty(false);
  toast('Saved');
}

async function newFile() {
  const input = prompt('New file path (e.g. notes/idea.md):');
  if (!input) return;
  const path = input.trim().replace(/^\/+/, '');
  if (!path) return;
  if (entriesByPath.has(path)) return toast('File already exists', true);
  const r = await api('PUT', '/api/file', { path, content: '', message: 'gimd: create ' + path });
  if (!r.ok) return toast((r.data && r.data.error) || 'Create failed', true);
  await loadTree();
  await openFile(path);
}

async function newFolder() {
  const input = prompt('New folder path (e.g. projects/ideas):');
  if (!input) return;
  const dir = input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!dir) return;
  // Git has no empty folders, so we materialize the folder with a hidden .gitkeep file.
  const keep = dir + '/.gitkeep';
  if (entriesByPath.has(keep)) return toast('Folder already exists', true);
  const r = await api('PUT', '/api/file', { path: keep, content: '', message: 'gimd: create folder ' + dir });
  if (!r.ok) return toast((r.data && r.data.error) || 'Create folder failed', true);
  await loadTree();
  toast('Folder created');
}

async function renameFile(oldPath) {
  const input = prompt('Rename / move to:', oldPath);
  if (!input) return;
  const newPath = input.trim().replace(/^\/+/, '');
  if (!newPath || newPath === oldPath) return;
  if (entriesByPath.has(newPath)) return toast('Target already exists', true);

  const file = await api('GET', '/api/file?path=' + encodeURIComponent(oldPath));
  if (!file.ok) return toast('Rename failed (could not read source)', true);
  const msg = 'gimd: rename ' + oldPath + ' -> ' + newPath;
  const created = await api('PUT', '/api/file', { path: newPath, content: file.data.content, message: msg });
  if (!created.ok) return toast((created.data && created.data.error) || 'Rename failed', true);
  const deleted = await api('DELETE', '/api/file', { path: oldPath, sha: file.data.sha, message: msg });
  if (!deleted.ok) toast('Renamed, but original could not be removed', true);

  if (current && current.path === oldPath) {
    current = { path: newPath, sha: created.data.sha };
    currentPathEl.textContent = newPath;
  }
  await loadTree();
}

async function deleteFile(path) {
  const entry = entriesByPath.get(path);
  if (!entry) return;
  if (!confirm('Delete ' + path + ' ?')) return;
  const r = await api('DELETE', '/api/file', { path, sha: entry.sha });
  if (!r.ok) return toast((r.data && r.data.error) || 'Delete failed', true);
  if (current && current.path === path) {
    current = null;
    contentEl.value = '';
    currentPathEl.textContent = '';
    setDirty(false);
  }
  await loadTree();
}

async function logout() {
  if (dirty && !confirm('Discard unsaved changes and sign out?')) return;
  await api('POST', '/auth/logout');
  location.reload();
}

// --- bootstrap --------------------------------------------------------------

function showLogin() {
  loginEl.classList.remove('hidden');
  appEl.classList.add('hidden');
}

function showApp(me) {
  loginEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  repoNameEl.textContent = me.repo || '';
}

async function init() {
  const me = await api('GET', '/api/me');
  if (!me.ok) return showLogin();
  showApp(me.data);
  await loadTree();
}

contentEl.addEventListener('input', () => { if (current) setDirty(true); });
saveBtn.addEventListener('click', save);
newBtn.addEventListener('click', newFile);
newFolderBtn.addEventListener('click', newFolder);
reloadBtn.addEventListener('click', loadTree);
logoutBtn.addEventListener('click', logout);
backBtn.addEventListener('click', showTreeView);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => { /* PWA optional */ });
  });
}

init();
