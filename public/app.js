'use strict';

// gimd frontend: talks only to our own server (which proxies GitHub).
// Unsaved edits are kept as per-file drafts in localStorage until committed.

const loginEl = document.getElementById('login');
const appEl = document.getElementById('app');
const treeEl = document.getElementById('tree');
const treeNoteEl = document.getElementById('treeNote');
const contentEl = document.getElementById('content');
const highlightEl = document.getElementById('highlight');
const currentPathEl = document.getElementById('currentPath');
const dirtyDot = document.getElementById('dirtyDot');
const saveBtn = document.getElementById('saveBtn');
const saveAllBtn = document.getElementById('saveAllBtn');
const newBtn = document.getElementById('newBtn');
const newFolderBtn = document.getElementById('newFolderBtn');
const reloadBtn = document.getElementById('reloadBtn');
const logoutBtn = document.getElementById('logoutBtn');
const backBtn = document.getElementById('backBtn');
const repoNameEl = document.getElementById('repoName');
const toastEl = document.getElementById('toast');

let entriesByPath = new Map(); // path -> { path, type, sha }
let treeTruncated = false;
let current = null;            // { path, sha }: sha = GitHub version the editor content is based on
let busy = false;              // a save is in flight

// --- helpers ----------------------------------------------------------------

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(url, opts); } catch (_) { return { ok: false, status: 0, data: { error: 'Network error' } }; }
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

// --- drafts -----------------------------------------------------------------
// One localStorage key per file ({ sha, content }), so several windows editing
// different files don't overwrite each other. A draft exists = the file is modified.

const DRAFT_PREFIX = 'gimd:draft:';

function getDraft(path) {
  try { return JSON.parse(localStorage.getItem(DRAFT_PREFIX + path)); } catch (_) { return null; }
}
function setDraft(path, draft) {
  try { localStorage.setItem(DRAFT_PREFIX + path, JSON.stringify(draft)); }
  catch (_) { toast('Could not store the draft locally', true); }
}
function dropDraft(path) {
  localStorage.removeItem(DRAFT_PREFIX + path);
}
function draftPaths() {
  return Object.keys(localStorage).filter((k) => k.startsWith(DRAFT_PREFIX)).map((k) => k.slice(DRAFT_PREFIX.length));
}

// Moves a draft along with its renamed file. A draft based on an outdated version
// keeps its stale sha, so saving it still conflicts instead of clobbering GitHub.
function moveDraft(oldPath, newPath, oldSha, newSha) {
  const d = getDraft(oldPath);
  if (!d) return;
  dropDraft(oldPath);
  setDraft(newPath, { sha: d.sha === oldSha ? newSha : d.sha, content: d.content });
}

// Sync every "modified" indicator: topbar dot, Save buttons, tree dots
// (a folder gets a dot when it contains a modified file).
function refreshDirty() {
  const paths = draftPaths();
  const set = new Set(paths);
  const isDirty = Boolean(current && set.has(current.path));
  dirtyDot.classList.toggle('hidden', !isDirty);
  saveBtn.disabled = !isDirty;
  saveAllBtn.disabled = !paths.length;
  treeEl.querySelectorAll('.row').forEach((el) => {
    const p = el.dataset.path;
    const dirty = el.classList.contains('dir-row') ? paths.some((d) => d.startsWith(p + '/')) : set.has(p);
    el.classList.toggle('dirty', dirty);
  });
}

// The Save buttons / path / dirty dot only make sense when a file is open.
// CSS uses body.has-file to show the Save buttons; the whole topbar shows only in the editor view.
function reflectCurrentFile() {
  document.body.classList.toggle('has-file', Boolean(current));
  contentEl.placeholder = current ? '' : 'Select a file on the left, or create one with +';
}

function closeEditor() {
  current = null;
  setEditorValue('');
  currentPathEl.textContent = '';
  refreshDirty();
  reflectCurrentFile();
}

function showEditorView() {
  document.body.classList.remove('view-tree');
  document.body.classList.add('view-editor');
}
function showTreeView() {
  document.body.classList.remove('view-editor');
  document.body.classList.add('view-tree');
}

function expandPath(filePath) {
  const parts = filePath.split('/');
  let ancestor = '';
  for (let i = 0; i < parts.length - 1; i++) {
    ancestor = ancestor ? ancestor + '/' + parts[i] : parts[i];
    const dirRow = treeEl.querySelector(`.dir-row[data-path="${ancestor}"]`);
    if (!dirRow) continue;
    const ul = dirRow.nextElementSibling;
    if (ul) ul.classList.remove('hidden');
    const twisty = dirRow.querySelector('.twisty');
    if (twisty) twisty.textContent = '▾';
  }
}

function setActive(path) {
  document.querySelectorAll('.file-row').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === path);
  });
  if (path) expandPath(path);
}

// --- markdown highlight -----------------------------------------------------
// A transparent <textarea> sits over the <pre> below, which paints structure.
// Block markers (headings, lists, quotes, fences) color a whole line or a
// leading marker; inline markers (emphasis, code) color a fragment. Source
// markers are ALWAYS kept — never stripped — so the painted layer stays exactly
// character-aligned with the textarea above it.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline tokens, scanned left-to-right on one raw line:
//  1: `code`   2: * / ** / *** (asterisk emphasis)
//  3: boundary char  4: _ / __ / ___ (underscore emphasis, word-bounded)
// Underscore emphasis must sit on a word boundary so snake_case is left alone.
// The {0,400}/{1,400} bounds cap how far each candidate scans for its closing
// marker, keeping a worst-case line (many unmatched delimiters) linear instead
// of O(n^2) — renderHighlight runs on every keystroke. Spans longer than ~400
// chars simply aren't highlighted, which is fine.
const INLINE_RE = new RegExp(
  '(`+)[\\s\\S]{0,400}?\\1' +
  '|(\\*\\*\\*|\\*\\*|\\*)(?=\\S)[\\s\\S]{1,400}?\\2' +
  '|(^|[^\\w])(_{1,3})(?=\\S)[\\s\\S]{1,400}?\\4(?![\\w])',
  'g'
);

function emphasisClass(run) {
  return run.length === 3 ? 'md-strong md-em' : run.length === 2 ? 'md-strong' : 'md-em';
}

function formatInline(src) {
  let out = '';
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(src))) {
    out += escapeHtml(src.slice(last, m.index));
    if (m[1] !== undefined) {            // inline code
      out += '<span class="md-code">' + escapeHtml(m[0]) + '</span>';
    } else if (m[2] !== undefined) {     // *asterisk* emphasis
      out += '<span class="' + emphasisClass(m[2]) + '">' + escapeHtml(m[0]) + '</span>';
    } else {                             // _underscore_ emphasis (m[4])
      out += escapeHtml(m[3]);           // re-emit the boundary char we consumed
      out += '<span class="' + emphasisClass(m[4]) + '">'
           + escapeHtml(m[0].slice(m[3].length)) + '</span>';
    }
    last = m.index + m[0].length;
  }
  return out + escapeHtml(src.slice(last));
}

// Paint a single line that is NOT inside a code fence.
function renderLine(line) {
  const h = /^ {0,3}(#{1,6})[ \t]/.exec(line);
  if (h) return '<span class="h' + h[1].length + '">' + escapeHtml(line) + '</span>';

  if (/^ {0,3}>/.test(line)) return '<span class="md-quote">' + formatInline(line) + '</span>';

  if (/^ {0,3}([-*_])(?: *\1){2,} *$/.test(line)) {
    return '<span class="md-hr">' + escapeHtml(line) + '</span>';
  }

  const list = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(line);
  if (list) {
    return escapeHtml(list[1]) + '<span class="md-marker">' + escapeHtml(list[2]) + '</span>'
         + escapeHtml(list[3]) + formatInline(line.slice(list[0].length));
  }

  return formatInline(line);
}

function renderHighlight() {
  const value = contentEl.value;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  const html = value.split('\n').map((line) => {
    // ``` or ~~~ (>=3) toggles a fenced code block; everything inside is code,
    // so no markdown is highlighted there (a `# foo` Python comment stays plain).
    // A closing fence must be the same char, at least as long as the opener, and
    // carry no trailing text (CommonMark) — otherwise it's just a line of code.
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const char = fence[1][0];
      const len = fence[1].length;
      if (!inFence) {
        inFence = true; fenceChar = char; fenceLen = len;
      } else if (char === fenceChar && len >= fenceLen && fence[2].trim() === '') {
        inFence = false;
      }
      return '<span class="md-code">' + escapeHtml(line) + '</span>';
    }
    if (inFence) return '<span class="md-code">' + escapeHtml(line) + '</span>';
    return renderLine(line);
  }).join('\n');
  // A trailing newline leaves an empty last line in the textarea; match its height.
  highlightEl.innerHTML = value.endsWith('\n') ? html + ' ' : html;
  syncHighlightScroll();
}

function syncHighlightScroll() {
  highlightEl.scrollTop = contentEl.scrollTop;
  highlightEl.scrollLeft = contentEl.scrollLeft;
}

function setEditorValue(value) {
  contentEl.value = value;
  renderHighlight();
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

// Dot shown by CSS when the row has the .dirty class.
function dirtyMark() {
  const dot = document.createElement('span');
  dot.className = 'dirty-dot';
  return dot;
}

function renderNode(node, prefix) {
  const ul = document.createElement('ul');

  for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
    const dirPath = prefix ? prefix + '/' + name : name;
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row dir-row';
    row.dataset.path = dirPath;
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = '▸';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;

    const actions = document.createElement('span');
    actions.className = 'row-actions';
    const renameBtn = document.createElement('button');
    renameBtn.className = 'icon-btn';
    renameBtn.title = 'Rename folder';
    renameBtn.textContent = '✎';
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.title = 'Delete folder';
    delBtn.textContent = '🗑';
    actions.append(renameBtn, delBtn);

    row.append(twisty, label, dirtyMark(), actions);
    const children = renderNode(node.dirs.get(name), dirPath);
    children.classList.add('hidden');
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.row-actions')) return;
      const collapsed = children.classList.toggle('hidden');
      twisty.textContent = collapsed ? '▸' : '▾';
    });
    renameBtn.addEventListener('click', (ev) => { ev.stopPropagation(); renameFolder(dirPath); });
    delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); deleteFolder(dirPath); });
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

    row.append(marker, label, dirtyMark(), actions);
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

// Drafts whose file is missing on GitHub (deleted elsewhere) still get a row,
// so they can be opened and resolved.
function renderTree() {
  const entries = [...entriesByPath.values()];
  for (const p of draftPaths()) if (!entriesByPath.has(p)) entries.push({ path: p, type: 'blob' });
  treeEl.innerHTML = '';
  treeEl.append(renderNode(buildModel(entries), ''));
  if (current) setActive(current.path);
  treeNoteEl.classList.toggle('hidden', !treeTruncated);
  if (treeTruncated) treeNoteEl.textContent = 'Repository too large to list fully.';
  refreshDirty();
}

// --- data operations --------------------------------------------------------

async function loadTree() {
  const r = await api('GET', '/api/tree');
  if (!r.ok) return toast((r.data && r.data.error) || 'Failed to load files', true);
  entriesByPath = new Map();
  for (const e of r.data.entries) entriesByPath.set(e.path, e);
  treeTruncated = r.data.truncated;
  renderTree();
}

// Resolves the draft of `path` against GitHub's version (`remote`, null if the
// file doesn't exist there). Returns the { sha, content } to edit, or null.
function reconcile(path, remote) {
  const draft = getDraft(path);
  const remoteSha = remote ? remote.sha : null;
  if (!draft || draft.sha === remoteSha) return draft || remote;
  const question = remote
    ? `"${path}" changed on GitHub since your unsaved edits.\n\n`
      + 'OK: discard your edits and load the GitHub version.\nCancel: keep your edits (saving will overwrite GitHub).'
    : `"${path}" was deleted on GitHub since your unsaved edits.\n\n`
      + 'OK: discard your edits.\nCancel: keep your edits (saving will recreate the file).';
  if (confirm(question)) {
    dropDraft(path);
    return remote;
  }
  const kept = { sha: remoteSha, content: draft.content };
  setDraft(path, kept);
  return kept;
}

// `force` reloads even if `path` is already open (used after a save conflict).
async function openFile(path, force) {
  // Tapping the already-open file just returns to the editor (mobile).
  if (!force && current && current.path === path) {
    showEditorView();
    contentEl.focus();
    return;
  }
  const r = await api('GET', '/api/file?path=' + encodeURIComponent(path));
  if (!r.ok && r.status !== 404) return toast((r.data && r.data.error) || 'Failed to open file', true);
  const doc = reconcile(path, r.ok ? r.data : null);
  if (!doc) {
    if (current && current.path === path) closeEditor();
    renderTree();
    return toast('File not found on GitHub', true);
  }
  current = { path, sha: doc.sha };
  setEditorValue(doc.content);
  currentPathEl.textContent = path;
  setActive(path);
  refreshDirty();
  reflectCurrentFile();
  showEditorView();
  contentEl.focus();
}

// Commits one draft (one commit). If the file was edited while the request was
// in flight, the draft stays, rebased on the new version.
async function commitDraft(path) {
  const d = getDraft(path);
  if (!d) return { ok: true }; // discarded meanwhile (e.g. during Save all)
  const r = await api('PUT', '/api/file', { path, content: d.content, sha: d.sha });
  if (!r.ok) return r;
  const now = getDraft(path);
  if (now && now.content === d.content) dropDraft(path);
  else if (now) setDraft(path, { sha: r.data.sha, content: now.content });
  if (current && current.path === path) current.sha = r.data.sha;
  entriesByPath.set(path, { path, type: 'blob', sha: r.data.sha });
  return r;
}

async function save() {
  if (busy || !current || !getDraft(current.path)) return;
  const path = current.path;
  busy = true;
  const r = await commitDraft(path);
  busy = false;
  refreshDirty();
  if (r.status === 409) {
    // Let the user choose between their edits and GitHub's version.
    if (current && current.path === path) await openFile(path, true);
    return;
  }
  if (!r.ok) return toast((r.data && r.data.error) || 'Save failed', true);
  toast('Saved');
}

// One commit per modified file. Failed files keep their draft (and their dot);
// opening or saving one alone shows the conflict popup.
async function saveAll() {
  const paths = draftPaths();
  if (busy || !paths.length) return;
  busy = true;
  const failed = [];
  for (const p of paths) {
    const r = await commitDraft(p);
    if (!r.ok) failed.push(p);
  }
  busy = false;
  refreshDirty();
  if (failed.length) return toast('Not saved: ' + failed.join(', ') + '. Open and save each one to resolve.', true);
  toast(paths.length > 1 ? paths.length + ' files saved' : 'Saved');
}

// Directory of the currently open file (with trailing slash), or '' at the root.
function currentDir() {
  if (current && current.path.includes('/')) {
    return current.path.slice(0, current.path.lastIndexOf('/') + 1);
  }
  return '';
}

async function newFile() {
  const input = prompt('New file path (e.g. notes/idea.md):', currentDir());
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
  const input = prompt('New folder path (e.g. projects/ideas):', currentDir());
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
  if (entriesByPath.has(newPath) || getDraft(newPath)) return toast('Target already exists', true);

  const file = await api('GET', '/api/file?path=' + encodeURIComponent(oldPath));
  if (!file.ok) return toast('Rename failed (could not read source)', true);
  const msg = 'gimd: rename ' + oldPath + ' -> ' + newPath;
  const created = await api('PUT', '/api/file', { path: newPath, content: file.data.content, message: msg });
  if (!created.ok) return toast((created.data && created.data.error) || 'Rename failed', true);
  const deleted = await api('DELETE', '/api/file', { path: oldPath, sha: file.data.sha, message: msg });
  if (!deleted.ok) toast('Renamed, but original could not be removed', true);

  moveDraft(oldPath, newPath, file.data.sha, created.data.sha);
  if (current && current.path === oldPath) {
    current = { path: newPath, sha: (getDraft(newPath) || created.data).sha };
    currentPathEl.textContent = newPath;
  }
  await loadTree();
}

async function deleteFile(path) {
  const entry = entriesByPath.get(path);
  const hasDraft = Boolean(getDraft(path));
  if (!entry && !hasDraft) return;
  if (!confirm('Delete ' + path + ' ?' + (hasDraft ? ' Unsaved edits will be lost.' : ''))) return;
  if (entry) {
    const r = await api('DELETE', '/api/file', { path, sha: entry.sha });
    if (!r.ok) return toast((r.data && r.data.error) || 'Delete failed', true);
  }
  dropDraft(path);
  if (current && current.path === path) closeEditor();
  await loadTree();
}

// All blob entries (including hidden .gitkeep) living under a folder path.
function entriesUnder(dirPath) {
  const prefix = dirPath + '/';
  const list = [];
  for (const e of entriesByPath.values()) {
    if (e.type === 'blob' && e.path.startsWith(prefix)) list.push(e);
  }
  return list;
}

// If the open file lives under dirPath, clear the editor.
function clearIfUnder(dirPath) {
  if (current && current.path.startsWith(dirPath + '/')) closeEditor();
}

async function deleteFolder(dirPath) {
  const items = entriesUnder(dirPath);
  if (!items.length) return toast('Folder is empty or missing', true);
  const hasDrafts = draftPaths().some((p) => p.startsWith(dirPath + '/'));
  if (!confirm('Delete folder "' + dirPath + '" and all its contents?'
    + (hasDrafts ? ' Unsaved edits inside will be lost.' : ''))) return;
  const msg = 'gimd: delete folder ' + dirPath;
  for (const e of items) {
    const r = await api('DELETE', '/api/file', { path: e.path, sha: e.sha, message: msg });
    if (!r.ok) { toast('Failed deleting ' + e.path, true); break; }
    dropDraft(e.path);
  }
  clearIfUnder(dirPath);
  await loadTree();
  toast('Folder deleted');
}

async function renameFolder(oldDir) {
  const input = prompt('Rename / move folder to:', oldDir);
  if (!input) return;
  const newDir = input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!newDir || newDir === oldDir) return;
  if ((newDir + '/').startsWith(oldDir + '/')) return toast('Cannot move a folder into itself', true);
  const items = entriesUnder(oldDir);
  if (!items.length) return toast('Folder is empty or missing', true);
  if (items.some((e) => getDraft(newDir + e.path.slice(oldDir.length)))) {
    return toast('Target has unsaved files with the same names', true);
  }
  const msg = 'gimd: rename folder ' + oldDir + ' -> ' + newDir;
  for (const e of items) {
    const newPath = newDir + e.path.slice(oldDir.length); // e.path keeps its leading '/<rest>'
    const file = await api('GET', '/api/file?path=' + encodeURIComponent(e.path));
    if (!file.ok) return toast('Rename failed reading ' + e.path, true);
    const created = await api('PUT', '/api/file', { path: newPath, content: file.data.content, message: msg });
    if (!created.ok) return toast((created.data && created.data.error) || 'Rename failed', true);
    const deleted = await api('DELETE', '/api/file', { path: e.path, sha: file.data.sha, message: msg });
    if (!deleted.ok) toast('Moved, but could not remove ' + e.path, true);
    moveDraft(e.path, newPath, file.data.sha, created.data.sha);
    if (current && current.path === e.path) {
      current = { path: newPath, sha: (getDraft(newPath) || created.data).sha };
      currentPathEl.textContent = newPath;
    }
  }
  await loadTree();
  toast('Folder renamed');
}

async function logout() {
  const drafts = draftPaths();
  if (drafts.length && !confirm('Discard unsaved edits (' + drafts.length + ' file(s)) and sign out?')) return;
  drafts.forEach(dropDraft);
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

// Every keystroke is persisted: switching files or closing the window loses nothing.
contentEl.addEventListener('input', () => {
  renderHighlight();
  if (!current) return;
  const wasDirty = Boolean(getDraft(current.path));
  setDraft(current.path, { sha: current.sha, content: contentEl.value });
  if (!wasDirty) refreshDirty();
});
contentEl.addEventListener('scroll', syncHighlightScroll);
saveBtn.addEventListener('click', save);
saveAllBtn.addEventListener('click', saveAll);
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

// Another gimd window changed the drafts.
window.addEventListener('storage', refreshDirty);

init();
