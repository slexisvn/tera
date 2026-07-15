import { CsvStreamParser, analyzeDocument, buildMethodReturns } from './dist/mlfw.esm.js';
import { renderChart } from './chart/index.js';
import { CHART_METHOD_DOCS, chartMethodOwner } from './chart/docs.js';
import { highlightHtml, TYPE_SET } from './highlight.js';
import { initNotebookDocs, setNotebookDocsError, updateNotebookDocs } from './tera-docs.js';
import { appendInlineCode } from './format.js';
import { serializeNotebook, parseNotebook } from './tenb.js';

const STORAGE_KEY = 'mlfw-notebook-v1';
const THEME_KEY = 'mlfw-notebook-theme';

const KEYWORDS = [
  'model', 'forward', 'train', 'validate', 'optimizer', 'return', 'fn',
  'if', 'else', 'for', 'in', 'while', 'break', 'continue',
  'and', 'or', 'not', 'true', 'false', 'null',
];
const PAIR = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
const OPENERS = new Set(['(', '[', '{']);
const QUOTES = new Set(['"', "'"]);
const CLOSERS = new Set([')', ']', '}']);

function highlight(cell) {
  cell.pre.innerHTML = highlightHtml(cell.editor.value);
}

const SEED = [
  `a = tensor([[1, 2], [3, 4]])\nb = tensor([[5, 6], [7, 8]])\na @ b`,
  `x = randn([3, 4])\nprint(x.shape)\nx.relu().mean()`,
  `metrics = DataFrame(epoch=[1, 2, 3, 4], loss=[1.0, 0.72, 0.48, 0.31], val_loss=[1.1, 0.81, 0.6, 0.44])\nchart.line(metrics, x="epoch", y=["loss", "val_loss"], title="Training")`,
  `model MLP(input: int, hidden: int, output: int):\n  fc1 = Linear(input, hidden)\n  fc2 = Linear(hidden, output)\n\n  forward (x: Tensor) -> Tensor:\n    x = fc1(x).relu()\n    return fc2(x)\n\nnet = MLP(2, 4, 1)\nnet(randn([8, 2]))`,
  `fn fib(n: int) -> int:\n  if n < 2:\n    return n\n  return fib(n - 1) + fib(n - 2)\n\nfib(12)`,
  `prices = DataFrame(\n  tech=[100, 102, 101, 105, 108, 107, 110, 113, 111, 115],\n  bank=[50, 49, 51, 50, 48, 49, 47, 48, 46, 45],\n  energy=[30, 31, 33, 32, 34, 36, 35, 37, 39, 38],\n)\nresult = backtest(prices, signal="momentum", portfolio="long_short", lookback=3)\nresult.metrics`,
];

const listEl = document.getElementById('cells');
const kernelStatus = document.getElementById('kernel-status');
const docsPanel = document.getElementById('docs-panel');
const docsToggle = document.getElementById('docs-toggle');
const docsClose = document.getElementById('docs-close');
const docsBackdrop = document.getElementById('docs-backdrop');

let execCount = 0;
let kernel = null;
let kernelCompletionNames = [];
const cells = [];

function makeRuntime() {
  execCount = 0;
  kernel?.terminate();
  kernel = createKernelClient();
  kernel.call('completionNames').then(names => { kernelCompletionNames = names || []; }).catch(() => {});
}

function createKernelClient() {
  const worker = new Worker(new URL('./kernel-worker.js', import.meta.url), { type: 'module' });
  let nextId = 0;
  const pending = new Map();
  worker.onmessage = event => {
    const { id, ok, result, error } = event.data || {};
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(error || 'Kernel worker failed'));
  };
  worker.onerror = event => {
    const error = new Error(event.message || 'Kernel worker failed');
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  return {
    call(type, payload = {}, transfer = []) {
      const id = ++nextId;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      worker.postMessage({ id, type, payload }, transfer);
      return promise;
    },
    terminate() {
      worker.terminate();
      for (const entry of pending.values()) entry.reject(new Error('Kernel restarted'));
      pending.clear();
    },
  };
}

function setKernel(text, busy) {
  kernelStatus.textContent = 'kernel: ' + text;
  kernelStatus.classList.toggle('busy', !!busy);
}

function setDocsOpen(open) {
  const mobile = window.matchMedia('(max-width: 980px)').matches;
  if (mobile) {
    document.body.classList.toggle('docs-open', open);
    if (docsBackdrop) docsBackdrop.hidden = !open;
  } else {
    document.body.classList.toggle('docs-closed', !open);
    document.body.classList.remove('docs-open');
    if (docsBackdrop) docsBackdrop.hidden = true;
  }
  docsToggle?.setAttribute('aria-expanded', isDocsVisible() ? 'true' : 'false');
  if (open) setTimeout(() => document.getElementById('docs-search')?.focus(), 80);
}

function toggleDocs() {
  setDocsOpen(!isDocsVisible());
}

function isDocsVisible() {
  const mobile = window.matchMedia('(max-width: 980px)').matches;
  return mobile ? document.body.classList.contains('docs-open') : !document.body.classList.contains('docs-closed');
}

const uploadedFiles = new Map();

function csvVarName(filename) {
  let base = filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(base)) base = '_' + base;
  return base || 'data';
}

function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

const BINARY_EXTS = new Set(['ckpt', 'safetensors', 'bin', 'npy', 'png', 'jpg', 'jpeg', 'gif', 'webp']);

function loadCommandFor(name) {
  const ext = fileExt(name);
  const v = csvVarName(name);
  if (ext === 'csv' || ext === 'tsv') return `${v} = load_csv("${name}")`;
  if (ext === 'json') return `${v} = load_json("${name}")`;
  if (ext === 'ckpt' || ext === 'safetensors') return `load_model(model, "${name}")`;
  return `${v} = read_text("${name}")`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

const BATCH_ROWS = 16384;

function parseCsvInWorker(file, onBatch, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./csv-worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
      reject(err);
      return;
    }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'batch') onBatch(m.rows);
      else if (m.type === 'progress') onProgress(m.read);
      else if (m.type === 'done') { worker.terminate(); resolve({ rowCount: m.rowCount }); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = (err) => { worker.terminate(); reject(new Error(err.message || 'worker failed')); };
    worker.postMessage({ file, separator: ',' });
  });
}

async function parseCsvOnMainThread(file, onBatch, onProgress) {
  const parser = new CsvStreamParser(',');
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    parser.feed(decoder.decode(value, { stream: true }));
    if (parser.pending.length >= BATCH_ROWS) onBatch(parser.drain());
    onProgress(read);
  }
  const { rowCount } = parser.finish();
  const last = parser.drain();
  if (last.length) onBatch(last);
  return { rowCount };
}

async function uploadCsv(file) {
  const onProgress = (read) => {
    const pct = file.size ? Math.round((read / file.size) * 100) : 0;
    setKernel(`loading ${file.name} ${pct}%`, true);
  };
  setKernel(`loading ${file.name}…`, true);
  await kernel.call('beginCsv', { name: file.name });
  let appended = false;
  const pending = [];
  const onBatch = (rows) => {
    appended = true;
    pending.push(kernel.call('appendCsvRows', { name: file.name, rows }));
  };
  let result;
  try {
    result = await parseCsvInWorker(file, onBatch, onProgress);
  } catch (err) {
    if (appended) throw err;
    result = await parseCsvOnMainThread(file, onBatch, onProgress);
  }
  await Promise.all(pending);
  await kernel.call('finishCsv', { name: file.name });
  uploadedFiles.set(file.name, { kind: 'csv', rowCount: result.rowCount, size: file.size });
  renderFiles();
}

async function uploadGenericFile(file) {
  setKernel(`loading ${file.name}…`, true);
  const ext = fileExt(file.name);
  if (BINARY_EXTS.has(ext)) {
    const buffer = await file.arrayBuffer();
    await kernel.call('writeFile', { name: file.name, data: buffer, binary: true }, [buffer]);
  } else {
    await kernel.call('writeFile', { name: file.name, data: await file.text(), binary: false });
  }
  uploadedFiles.set(file.name, { kind: 'file', ext, size: file.size });
  renderFiles();
}

async function uploadFiles(fileList) {
  for (const file of fileList) {
    try {
      if (fileExt(file.name) === 'tenb') await importNotebook(file);
      else if (fileExt(file.name) === 'csv') await uploadCsv(file);
      else await uploadGenericFile(file);
    } catch (err) {
      setKernel(`error in ${file.name}: ${err.message || err}`);
      return;
    }
  }
  setKernel('ready');
}

async function importNotebook(file) {
  const sources = parseNotebook(await file.text());
  for (const cell of cells.slice()) {
    clearCellOutput(cell);
    cell.root.remove();
  }
  cells.length = 0;
  for (const src of sources) createCell(src);
  if (cells.length === 0) createCell('', { focus: true });
  save();
}

function exportNotebook() {
  const text = serializeNotebook(cells.map((c) => c.editor.value));
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'notebook.tenb';
  a.click();
  URL.revokeObjectURL(url);
}

async function removeFile(name) {
  const meta = uploadedFiles.get(name);
  uploadedFiles.delete(name);
  if (meta) {
    try { await kernel.call('removeFile', { name, kind: meta.kind }); } catch (_) { setKernel('ready'); }
  }
  renderFiles();
}

function renderFiles() {
  const list = document.getElementById('files-list');
  const empty = document.getElementById('files-empty');
  list.innerHTML = '';
  empty.style.display = uploadedFiles.size ? 'none' : 'block';
  for (const [name, meta] of uploadedFiles) {
    const li = document.createElement('li');
    li.className = 'file-item';
    const cmd = loadCommandFor(name);
    const open = document.createElement('button');
    open.className = 'file-open';
    open.title = `Insert: ${cmd}`;
    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = name;
    const metaEl = document.createElement('span');
    metaEl.className = 'file-meta';
    metaEl.textContent = meta.kind === 'csv' ? `${meta.rowCount} rows · ${fmtSize(meta.size)}` : `${(meta.ext || 'file').toUpperCase()} · ${fmtSize(meta.size)}`;
    open.append(nameEl, metaEl);
    open.addEventListener('click', () => createCell(cmd, { focus: true }));
    const del = document.createElement('button');
    del.className = 'file-del';
    del.textContent = '×';
    del.title = 'Remove file';
    del.addEventListener('click', () => { removeFile(name); });
    li.append(open, del);
    list.append(li);
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cells.map((c) => c.editor.value)));
  scheduleTypecheck();
}

let methodReturns = null;
let languageData = null;
let nbSymbols = null;
let nbRanges = [];

let typecheckTimer = null;
function scheduleTypecheck() {
  if (typecheckTimer) clearTimeout(typecheckTimer);
  typecheckTimer = setTimeout(typecheckAll, 400);
}

function typecheckAll() {
  if (!cells.length) return;
  const ranges = [];
  let start = 1;
  for (const cell of cells) {
    const lineCount = cell.editor.value.split('\n').length;
    ranges.push({ cell, start, end: start + lineCount - 1 });
    start += lineCount;
  }
  nbRanges = ranges;
  const combined = cells.map((c) => c.editor.value).join('\n');
  let diagnostics;
  try {
    const result = analyzeDocument(combined, { methodReturns });
    diagnostics = result.diagnostics;
    nbSymbols = result.symbols;
  } catch {
    // Mid-edit parse error (e.g. a trailing `obj.`): keep the last good symbol
    // table so hover/completion still work while the expression is incomplete.
    for (const cell of cells) renderDiagnostics(cell, []);
    return;
  }
  const byCell = new Map();
  for (const d of diagnostics) {
    const range = ranges.find((r) => d.line >= r.start && d.line <= r.end);
    if (!range) continue;
    if (!byCell.has(range.cell)) byCell.set(range.cell, []);
    byCell.get(range.cell).push({ line: d.line - range.start + 1, column: d.column ?? 1, message: (d.message || '').replace(/ at \d+:\d+$/, '') });
  }
  for (const cell of cells) renderDiagnostics(cell, byCell.get(cell) ?? []);
}

function renderDiagnostics(cell, diags) {
  if (!cell.diagLayer) return;
  cell.diags = [];
  cell.diagLayer.innerHTML = '';
  const text = cell.editor.value;
  const lh = parseFloat(getComputedStyle(cell.editor).lineHeight) || 20;
  for (const d of diags) {
    const start = offsetOf(text, d.line, d.column);
    const a = caretCoordinates(cell.editor, start);
    const b = caretCoordinates(cell.editor, tokenEnd(text, start));
    const width = Math.max(b.top === a.top ? b.left - a.left : 7, 7);
    const u = document.createElement('div');
    u.className = 'diag-underline';
    u.style.left = a.left + 'px';
    u.style.top = a.top + lh - 3 + 'px';
    u.style.width = width + 'px';
    cell.diagLayer.append(u);
    cell.diags.push({ message: d.message, x: a.left, y: a.top, w: width, h: lh });
  }
}

function offsetOf(text, line, column) {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + (column - 1);
}

function tokenEnd(text, offset) {
  const ch = text[offset];
  if (ch === undefined) return offset + 1;
  if (ch === '"' || ch === "'") {
    let i = offset + 1;
    while (i < text.length && text[i] !== '\n') {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === ch) { i++; break; }
      i++;
    }
    return i;
  }
  let i = offset;
  if (/[A-Za-z0-9_]/.test(ch)) { while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) i++; return i; }
  while (i < text.length && /[-+*/@<>=!|]/.test(text[i])) i++;
  return Math.max(i, offset + 1);
}

function diagAt(cell, clientX, clientY) {
  if (!cell.diags || !cell.diags.length) return null;
  const ta = cell.editor;
  const rect = ta.getBoundingClientRect();
  const x = clientX - rect.left + ta.scrollLeft;
  const y = clientY - rect.top + ta.scrollTop;
  for (const d of cell.diags) {
    if (x >= d.x - 1 && x <= d.x + d.w + 1 && y >= d.y && y <= d.y + d.h) return d;
  }
  return null;
}

function autoSize(ta) {
  const sx = window.scrollX, sy = window.scrollY;
  ta.style.height = 'auto';
  ta.style.height = Math.max(ta.scrollHeight, 24) + 'px';
  if (window.scrollX !== sx || window.scrollY !== sy) window.scrollTo(sx, sy);
}

function createCell(code = '', { focus = false, before = null } = {}) {
  const root = document.createElement('div');
  root.className = 'cell';

  const gutter = document.createElement('div');
  gutter.className = 'gutter';
  const runStack = document.createElement('div');
  runStack.className = 'run-stack';
  const runBtn = document.createElement('button');
  runBtn.className = 'run';
  runBtn.textContent = '▶';
  runBtn.title = 'Run this cell';
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = '[ ]';
  runStack.append(runBtn, count);
  gutter.append(runStack);

  const main = document.createElement('div');
  main.className = 'main';
  const wrap = document.createElement('div');
  wrap.className = 'editor-wrap';
  const pre = document.createElement('pre');
  pre.className = 'highlight';
  pre.setAttribute('aria-hidden', 'true');
  const editor = document.createElement('textarea');
  editor.className = 'editor';
  editor.spellcheck = false;
  editor.value = code;
  editor.rows = 1;
  const diagLayer = document.createElement('div');
  diagLayer.className = 'diag-layer';
  diagLayer.setAttribute('aria-hidden', 'true');
  wrap.append(pre, editor, diagLayer);
  const output = document.createElement('div');
  output.className = 'output';
  const diag = document.createElement('div');
  diag.className = 'diagnostics';
  main.append(wrap, diag, output);

  const tools = document.createElement('div');
  tools.className = 'cell-tools';
  const upBtn = document.createElement('button');
  upBtn.textContent = '↑ up';
  upBtn.title = 'Move cell up';
  const downBtn = document.createElement('button');
  downBtn.textContent = '↓ down';
  downBtn.title = 'Move cell down';
  const addBtn = document.createElement('button');
  addBtn.className = 'add-cell';
  addBtn.textContent = '＋ cell';
  addBtn.title = 'Add a cell below';
  const delBtn = document.createElement('button');
  delBtn.textContent = '🗑 delete';
  tools.append(addBtn, upBtn, downBtn, delBtn);

  root.append(gutter, main, tools);

  const cell = { root, editor, output, count, runBtn, pre, diag, diagLayer, diags: [], chartCleanup: null };

  runBtn.addEventListener('click', () => runCell(cell));
  addBtn.addEventListener('click', () => {
    const c = createCell('', { focus: true, before: nextSibling(cell) });
    return c;
  });
  delBtn.addEventListener('click', () => deleteCell(cell));
  upBtn.addEventListener('click', () => moveCell(cell, -1));
  downBtn.addEventListener('click', () => moveCell(cell, 1));
  editor.addEventListener('input', (e) => {
    // During IME composition (e.g. Vietnamese Telex/VNI), only repaint the
    // highlight; resizing or autocomplete here resets the caret mid-compose.
    if (e.isComposing) { highlight(cell); return; }
    autoSize(editor); highlight(cell); save(); updateAutocomplete(cell);
  });
  editor.addEventListener('compositionend', () => { autoSize(editor); highlight(cell); save(); updateAutocomplete(cell); });
  editor.addEventListener('keydown', (e) => onEditorKey(e, cell));
  editor.addEventListener('blur', () => setTimeout(() => { if (ac.cell === cell) closeAutocomplete(); }, 120));
  editor.addEventListener('scroll', () => { pre.scrollTop = editor.scrollTop; pre.scrollLeft = editor.scrollLeft; });
  editor.addEventListener('mousemove', (e) => onEditorHover(e, cell));
  editor.addEventListener('mouseleave', hideHover);

  if (before) {
    listEl.insertBefore(root, before);
    const idx = cells.findIndex((c) => c.root === before);
    cells.splice(idx === -1 ? cells.length : idx, 0, cell);
  } else {
    listEl.append(root);
    cells.push(cell);
  }

  autoSize(editor);
  highlight(cell);
  if (focus) editor.focus();
  save();
  return cell;
}

function nextSibling(cell) {
  const idx = cells.indexOf(cell);
  return idx >= 0 && idx + 1 < cells.length ? cells[idx + 1].root : null;
}

function deleteCell(cell) {
  const idx = cells.indexOf(cell);
  if (idx === -1) return;
  clearCellOutput(cell);
  cell.root.remove();
  cells.splice(idx, 1);
  if (cells.length === 0) createCell('', { focus: true });
  save();
}

function moveCell(cell, dir) {
  const idx = cells.indexOf(cell);
  const target = idx + dir;
  if (idx === -1 || target < 0 || target >= cells.length) return;
  const other = cells[target];
  cells[target] = cell;
  cells[idx] = other;
  if (dir < 0) listEl.insertBefore(cell.root, other.root);
  else listEl.insertBefore(cell.root, other.root.nextSibling);
  hideHover();
  closeAutocomplete();
  save();
  cell.editor.focus();
}

function onEditorKey(e, cell) {
  if (e.isComposing || e.keyCode === 229) return;
  hideHover();
  if (autocompleteOpen()) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveAutocomplete(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveAutocomplete(-1); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeAutocomplete(); return; }
    if (e.key === 'Tab') { e.preventDefault(); acceptAutocomplete(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); acceptAutocomplete(); return; }
    if (e.key === 'Enter') closeAutocomplete();
  }
  if (e.key.length === 1 || e.key === 'Backspace') {
    if (handleAutoPairs(e, cell)) return;
  }
  if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    runCell(cell).then(() => {
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const idx = cells.indexOf(cell);
        if (idx === cells.length - 1) createCell('', { focus: true });
        else cells[idx + 1].editor.focus();
      }
    });
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    insertText(e.target, '  ');
    return;
  }
  if (e.key === 'Enter') {
    const ta = e.target;
    const upto = ta.value.slice(0, ta.selectionStart);
    const line = upto.slice(upto.lastIndexOf('\n') + 1);
    const indent = (line.match(/^\s*/) || [''])[0];
    const extra = /:\s*$/.test(line) ? '  ' : '';
    if (indent || extra) {
      e.preventDefault();
      insertText(ta, '\n' + indent + extra);
    }
  }
}

function afterEdit(cell) {
  autoSize(cell.editor);
  highlight(cell);
  save();
  updateAutocomplete(cell);
}

function handleAutoPairs(e, cell) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const ta = cell.editor;
  const s = ta.selectionStart;
  const en = ta.selectionEnd;
  const key = e.key;

  if (OPENERS.has(key) || QUOTES.has(key)) {
    const close = PAIR[key];
    if (s !== en) {
      const sel = ta.value.slice(s, en);
      e.preventDefault();
      ta.value = ta.value.slice(0, s) + key + sel + close + ta.value.slice(en);
      ta.selectionStart = s + 1;
      ta.selectionEnd = en + 1;
      afterEdit(cell);
      return true;
    }
    if (QUOTES.has(key) && ta.value[s] === key) {
      e.preventDefault();
      ta.selectionStart = ta.selectionEnd = s + 1;
      return true;
    }
    e.preventDefault();
    ta.value = ta.value.slice(0, s) + key + close + ta.value.slice(en);
    ta.selectionStart = ta.selectionEnd = s + 1;
    afterEdit(cell);
    return true;
  }

  if (CLOSERS.has(key) && s === en && ta.value[s] === key) {
    e.preventDefault();
    ta.selectionStart = ta.selectionEnd = s + 1;
    return true;
  }

  if (key === 'Backspace' && s === en && s > 0) {
    const before = ta.value[s - 1];
    if (PAIR[before] && ta.value[s] === PAIR[before]) {
      e.preventDefault();
      ta.value = ta.value.slice(0, s - 1) + ta.value.slice(s + 1);
      ta.selectionStart = ta.selectionEnd = s - 1;
      afterEdit(cell);
      return true;
    }
  }
  return false;
}

function insertText(ta, text) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + text.length;
  autoSize(ta);
  const pre = ta.previousElementSibling;
  if (pre && pre.classList.contains('highlight')) pre.innerHTML = highlightHtml(ta.value);
  save();
}

async function runCell(cell) {
  closeAutocomplete();
  const code = cell.editor.value;
  if (!code.trim()) {
    clearCellOutput(cell);
    cell.count.textContent = '[ ]';
    return;
  }

  cell.count.textContent = '[*]';
  cell.runBtn.classList.add('running');
  cell.runBtn.disabled = true;
  cell.runBtn.title = 'Running';
  cell.runBtn.setAttribute('aria-busy', 'true');
  setKernel('running…', true);

  let result;
  try {
    // In the notebook, `df.show()` is the idiomatic "display this frame" call —
    // drop a trailing .show(...) so the DataFrame itself renders as a paginated table.
    const value = await kernel.call('execute', { source: code.replace(SHOW_TAIL, '') });
    kernelCompletionNames = value.completionNames || kernelCompletionNames;
    result = { ok: true, prints: value.prints || [], value: value.value };
  } catch (err) {
    result = { ok: false, prints: [], error: (err && err.message) || String(err) };
  }

  execCount += 1;
  cell.count.textContent = '[' + execCount + ']';
  cell.runBtn.classList.remove('running');
  cell.runBtn.disabled = false;
  cell.runBtn.title = 'Run this cell';
  cell.runBtn.removeAttribute('aria-busy');
  renderOutput(cell, result);
  setKernel('ready');
  save();
  return result;
}

function renderOutput(cell, result) {
  clearCellOutput(cell);
  const out = cell.output;
  for (const line of result.prints) {
    const pre = document.createElement('div');
    pre.className = 'print';
    pre.textContent = line;
    out.append(pre);
  }
  if (!result.ok) {
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = result.error;
    out.append(err);
    return;
  }
  if (result.value?.kind === 'dataframe') {
    renderDataFrameTable(out, result.value);
    return;
  }
  if (result.value?.kind === 'chart') {
    cell.chartCleanup = renderChart(out, result.value.spec);
    return;
  }
  const text = result.value?.kind === 'text' ? result.value.text : '';
  if (text) {
    const res = document.createElement('div');
    res.className = 'result';
    res.textContent = text;
    out.append(res);
  }
}

const SHOW_TAIL = /\.show\s*\([^()]*\)\s*;?\s*$/;
const DF_PAGE_SIZE = 25;

async function renderDataFrameTable(out, df) {
  const view = document.createElement('div');
  view.className = 'df-view';
  out.append(view);
  let offset = 0;
  const total = df.total;
  const columns = df.columns;

  async function load() {
    view.classList.add('df-loading');
    try {
      const { rows } = await kernel.call('dataframePage', { id: df.id, offset, limit: DF_PAGE_SIZE });
      render(rows);
    } catch (e) {
      view.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = (e && e.message) || String(e);
      view.append(err);
    } finally {
      view.classList.remove('df-loading');
    }
  }

  function render(rows) {
    view.innerHTML = '';
    const scroll = document.createElement('div');
    scroll.className = 'df-scroll';
    const table = document.createElement('table');
    table.className = 'df-grid';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const c of columns) {
      const th = document.createElement('th');
      th.textContent = c;
      htr.append(th);
    }
    thead.append(htr);
    table.append(thead);
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const c of columns) {
        const td = document.createElement('td');
        const v = row[c];
        if (v === null || v === undefined) { td.textContent = 'NULL'; td.className = 'df-null'; }
        else td.textContent = String(v);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    scroll.append(table);
    view.append(scroll);

    const pager = document.createElement('div');
    pager.className = 'df-pager';
    const from = total === 0 ? 0 : offset + 1;
    const to = offset + rows.length;
    const info = document.createElement('span');
    info.className = 'df-info';
    info.textContent = `${from}–${to} of ${total} · ${columns.length} cols`;
    const prev = document.createElement('button');
    prev.textContent = '‹ Prev';
    prev.disabled = offset <= 0;
    prev.addEventListener('click', () => { offset = Math.max(0, offset - DF_PAGE_SIZE); load(); });
    const next = document.createElement('button');
    next.textContent = 'Next ›';
    next.disabled = to >= total;
    next.addEventListener('click', () => { offset += DF_PAGE_SIZE; load(); });
    pager.append(prev, info, next);
    view.append(pager);
  }

  await load();
}

async function runAll() {
  for (const cell of cells) {
    const r = await runCell(cell);
    if (r && !r.ok) break;
  }
}

function restart() {
  makeRuntime();
  for (const cell of cells) {
    cell.count.textContent = '[ ]';
    clearCellOutput(cell);
  }
  setKernel('ready');
}

function clearOutputs() {
  for (const cell of cells) {
    cell.count.textContent = '[ ]';
    clearCellOutput(cell);
  }
}

function clearCellOutput(cell) {
  cell.chartCleanup?.();
  cell.chartCleanup = null;
  cell.output.innerHTML = '';
}

function load() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { saved = null; }
  const source = Array.isArray(saved) && saved.length ? saved : SEED;
  for (const code of source) createCell(code);
  if (cells.length === 0) createCell('', { focus: true });
}

const themeBtn = document.getElementById('theme-toggle');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeBtn.textContent = theme === 'dark' ? '☀ Light' : '🌙 Dark';
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  let theme = localStorage.getItem(THEME_KEY);
  if (!theme) theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(theme);
}

themeBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

docsToggle?.addEventListener('click', toggleDocs);
docsClose?.addEventListener('click', () => setDocsOpen(false));
docsBackdrop?.addEventListener('click', () => setDocsOpen(false));
window.addEventListener('resize', () => {
  if (!window.matchMedia('(max-width: 980px)').matches) {
    document.body.classList.remove('docs-open');
    if (docsBackdrop) docsBackdrop.hidden = true;
  }
  docsToggle?.setAttribute('aria-expanded', isDocsVisible() ? 'true' : 'false');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('docs-open')) setDocsOpen(false);
});

const ac = { el: null, items: [], index: 0, cell: null, start: 0, end: 0 };

function closeAutocomplete() {
  if (ac.el) { ac.el.remove(); ac.el = null; }
  ac.items = [];
  ac.cell = null;
}

function autocompleteOpen() {
  return !!ac.el;
}

function caretCoordinates(ta, position) {
  const mirror = document.createElement('div');
  const style = getComputedStyle(ta);
  const props = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
  ];
  for (const p of props) mirror.style[p] = style[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre';
  mirror.style.width = 'auto';
  mirror.style.top = '0';
  mirror.style.left = '0';
  mirror.textContent = ta.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  mirror.remove();
  return { top, left };
}

// --- Scope-accurate language service (same analysis as the VSCode extension) ---
function cellRange(cell) { return nbRanges.find((r) => r.cell === cell); }

function localOffsetToPos(text, offset) {
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 0; } else col++;
  }
  return { line, character: col };
}

function combinedPos(cell, localOffset) {
  const range = cellRange(cell);
  const lp = localOffsetToPos(cell.editor.value, localOffset);
  return { line: (range ? range.start - 1 : 0) + lp.line, character: lp.character };
}

function nodeOffset(pre, target) {
  let offset = 0;
  for (const node of pre.childNodes) {
    if (node === target || (node.contains && node.contains(target))) return offset;
    offset += (node.textContent || '').length;
  }
  return offset;
}

function resolveSymbolAt(cell, name, localOffset) {
  return nbSymbols ? nbSymbols.resolve(name, combinedPos(cell, localOffset)) : null;
}

function visibleSymbols(cell) {
  if (!nbSymbols) return [];
  let scope = nbSymbols.findScopeAt(combinedPos(cell, cell.editor.selectionStart));
  const out = [];
  while (scope) { out.push(...scope.symbols); scope = scope.parent; }
  return out;
}

function resolveTypeMethods(typeName, seen = new Set()) {
  if (!typeName || seen.has(typeName) || !languageData) return [];
  seen.add(typeName);
  const builtin = (languageData.builtins || []).find((b) => b.name === typeName);
  if (builtin && builtin.methods && builtin.methods.length) return builtin.methods;
  const pseudo = languageData.pseudoTypes && languageData.pseudoTypes[typeName];
  if (pseudo) return pseudo;
  if (builtin && builtin.returns && builtin.returns !== typeName) return resolveTypeMethods(builtin.returns, seen);
  return [];
}

function membersForType(typeName) {
  const scope = nbSymbols && typeName && nbSymbols.scopes.find((s) => s.name === typeName);
  if (scope) {
    const fields = scope.symbols.filter((s) => s.kind === 'variable').map((s) => ({ name: s.name, kind: 'field' }));
    const inherited = ((languageData && languageData.pseudoTypes && languageData.pseudoTypes.Model) || [])
      .map((m) => ({ name: m.name, kind: m.isGetter ? 'property' : 'method' }));
    return [...fields, ...inherited];
  }
  return resolveTypeMethods(typeName).map((m) => ({ name: m.name, kind: m.isGetter ? 'property' : 'method' }));
}

function completionCandidates(cell) {
  const ta = cell.editor;
  const before = ta.value.slice(0, ta.selectionStart);
  const member = before.match(/([A-Za-z_]\w*)\s*\.\s*(\w*)$/);
  const seen = new Set();
  const items = [];
  const add = (name, kind) => {
    if (!name || seen.has(name) || name.startsWith('_') || name === 'constructor') return;
    seen.add(name); items.push({ name, kind });
  };
  if (member) {
    const [, receiver, prefix] = member;
    const sym = resolveSymbolAt(cell, receiver, ta.selectionStart - prefix.length - 1);
    for (const m of membersForType(sym ? sym.typeName : receiver)) if (m.name.startsWith(prefix)) add(m.name, m.kind);
    if (!items.length) return null;
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { start: ta.selectionStart - prefix.length, items };
  }
  const word = before.match(/([A-Za-z_]\w*)$/);
  if (!word || word[1].length < 1) return null;
  const prefix = word[1];
  for (const s of visibleSymbols(cell)) if (s.name.startsWith(prefix)) add(s.name, s.kind);
  for (const name of kernelCompletionNames) if (name.startsWith(prefix)) add(name, 'name');
  for (const kw of KEYWORDS) if (kw.startsWith(prefix)) add(kw, 'keyword');
  items.sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length || (items.length === 1 && items[0].name === prefix)) return null;
  return { start: ta.selectionStart - prefix.length, items };
}

function updateAutocomplete(cell) {
  const ta = cell.editor;
  const data = completionCandidates(cell);
  if (!data) { closeAutocomplete(); return; }

  ac.items = data.items;
  ac.index = 0;
  ac.cell = cell;
  ac.start = data.start;
  ac.end = ta.selectionStart;

  if (!ac.el) {
    ac.el = document.createElement('div');
    ac.el.className = 'autocomplete';
    document.body.append(ac.el);
  }
  renderAutocomplete();

  const coords = caretCoordinates(ta, ta.selectionStart);
  const rect = ta.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
  ac.el.style.left = window.scrollX + rect.left + coords.left - ta.scrollLeft + 'px';
  ac.el.style.top = window.scrollY + rect.top + coords.top - ta.scrollTop + lh + 4 + 'px';
}

function renderAutocomplete() {
  ac.el.innerHTML = '';
  ac.items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'item' + (i === ac.index ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = item.kind;
    row.append(name, kind);
    row.addEventListener('mousedown', (e) => { e.preventDefault(); acceptAutocomplete(i); });
    ac.el.append(row);
  });
}

function moveAutocomplete(delta) {
  ac.index = (ac.index + delta + ac.items.length) % ac.items.length;
  renderAutocomplete();
  const active = ac.el.children[ac.index];
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function acceptAutocomplete(i = ac.index) {
  const item = ac.items[i];
  const cell = ac.cell;
  if (!item || !cell) { closeAutocomplete(); return; }
  const ta = cell.editor;
  ta.value = ta.value.slice(0, ac.start) + item.name + ta.value.slice(ac.end);
  const caret = ac.start + item.name.length;
  ta.selectionStart = ta.selectionEnd = caret;
  closeAutocomplete();
  autoSize(ta);
  highlight(cell);
  save();
  ta.focus();
}

const docs = new Map();
const memberDocs = new Map();
let hoverEl = null;

async function loadDocs() {
  try {
    const res = await fetch('./dist/language-data.json');
    if (!res.ok) return;
    const data = await res.json();
    languageData = data;
    methodReturns = buildMethodReturns(data);
    scheduleTypecheck();
    for (const b of data.builtins || []) {
      docs.set(b.name, {
        display: (b.signature && b.signature.display) || b.name,
        kind: b.kind || null,
        description: b.description || null,
      });
    }
    for (const [group, names] of Object.entries(data.keywordGroups || {})) {
      for (const name of names) {
        if (!docs.has(name)) docs.set(name, { display: name, kind: group + ' keyword', description: null });
      }
    }
    for (const name of (data.keywordGroups && data.keywordGroups.type) || []) TYPE_SET.add(name);
    for (const cell of cells) highlight(cell);
    for (const [typeName, methods] of Object.entries(data.pseudoTypes || {})) {
      for (const m of methods) {
        if (memberDocs.has(m.name)) continue;
        memberDocs.set(m.name, {
          display: typeName + '.' + ((m.signature && m.signature.display) || m.name),
          kind: (m.isGetter ? 'property of ' : 'method of ') + typeName,
          description: m.description || null,
        });
      }
    }
    updateNotebookDocs(data);
  } catch {
    setNotebookDocsError('Tera docs unavailable.');
  }
}

let hoverSpan = null;

function spanAtPoint(pre, x, y) {
  const spans = pre.querySelectorAll('span');
  for (const span of spans) {
    const r = span.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return span;
  }
  return null;
}

function showHoverAt(info, rect) {
  if (!hoverEl) {
    hoverEl = document.createElement('div');
    hoverEl.className = 'hover-doc';
    document.body.append(hoverEl);
  }
  hoverEl.classList.toggle('error', !!info.error);
  hoverEl.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'hd-title';
  title.textContent = info.display;
  hoverEl.append(title);
  if (info.kind) {
    const kind = document.createElement('div');
    kind.className = 'hd-kind';
    kind.textContent = info.kind;
    hoverEl.append(kind);
  }
  if (info.description) {
    const desc = document.createElement('div');
    desc.className = 'hd-desc';
    appendInlineCode(desc, info.description);
    hoverEl.append(desc);
  }
  hoverEl.style.display = 'block';
  const box = hoverEl.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top - box.height - 6;
  if (top < 8) top = rect.bottom + 6;
  if (left + box.width > window.innerWidth - 12) left = window.innerWidth - box.width - 12;
  hoverEl.style.left = window.scrollX + Math.max(8, left) + 'px';
  hoverEl.style.top = window.scrollY + top + 'px';
}

function hideHover() {
  if (hoverEl) hoverEl.style.display = 'none';
  hoverSpan = null;
  hoverDiag = null;
}

let hoverDiag = null;

function onEditorHover(e, cell) {
  if (autocompleteOpen()) { hideHover(); return; }
  const diag = diagAt(cell, e.clientX, e.clientY);
  if (diag) {
    if (diag === hoverDiag && hoverEl && hoverEl.style.display === 'block') return;
    hoverDiag = diag;
    hoverSpan = null;
    const ta = cell.editor;
    const r = ta.getBoundingClientRect();
    const top = r.top + diag.y - ta.scrollTop;
    showHoverAt({ display: diag.message, kind: 'type error', error: true }, { left: r.left + diag.x - ta.scrollLeft, top, bottom: top + diag.h, height: diag.h, width: diag.w });
    return;
  }
  hoverDiag = null;
  const span = spanAtPoint(cell.pre, e.clientX, e.clientY);
  if (!span) { hideHover(); return; }
  if (span === hoverSpan && hoverEl && hoverEl.style.display === 'block') return;
  const isMember = span.classList.contains('tok-method') || span.classList.contains('tok-prop');
  const owner = isMember ? chartMethodOwner(cell.pre, span) : null;
  let info = owner === 'chart' ? CHART_METHOD_DOCS.get(span.textContent) : isMember ? memberDocs.get(span.textContent) : docs.get(span.textContent);
  if (!info && !isMember) {
    const sym = resolveSymbolAt(cell, span.textContent, nodeOffset(cell.pre, span));
    if (sym) info = { display: sym.name, kind: sym.kind, description: sym.typeName ? `type: ${sym.typeName}` : null };
  }
  if (!info) { hideHover(); return; }
  hoverSpan = span;
  showHoverAt(info, span.getBoundingClientRect());
}

const csvInput = document.getElementById('csv-file');
document.getElementById('upload-csv').addEventListener('click', () => csvInput.click());
csvInput.addEventListener('change', () => { uploadFiles([...csvInput.files]); csvInput.value = ''; });
document.getElementById('export-tenb').addEventListener('click', exportNotebook);

const sidebarEl = document.querySelector('.sidebar');
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); sidebarEl.classList.add('drag-over'); } });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) sidebarEl.classList.remove('drag-over'); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  sidebarEl.classList.remove('drag-over');
  const files = [...e.dataTransfer.files];
  if (files.length) uploadFiles(files);
});
document.addEventListener('click', (e) => { if (ac.el && !ac.el.contains(e.target)) closeAutocomplete(); });
document.addEventListener('scroll', hideHover, true);

const toolbarEl = document.querySelector('.toolbar');
function syncToolbarHeight() {
  if (toolbarEl) document.documentElement.style.setProperty('--toolbar-h', toolbarEl.offsetHeight + 'px');
}
if (toolbarEl && 'ResizeObserver' in window) new ResizeObserver(syncToolbarHeight).observe(toolbarEl);
window.addEventListener('resize', syncToolbarHeight);
syncToolbarHeight();

initTheme();
initNotebookDocs({ createCell });
loadDocs();
makeRuntime();
renderFiles();
load();
