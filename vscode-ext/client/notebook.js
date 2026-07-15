import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import {
  notebooks, workspace, NotebookCellData, NotebookCellKind, NotebookData,
  NotebookCellOutput, NotebookCellOutputItem,
} from 'vscode';

const NOTEBOOK_TYPE = 'tera-notebook';
const CHART_MIME = 'application/x-tera-chart+json';

function joinSource(source) {
  if (Array.isArray(source)) return source.join('');
  return typeof source === 'string' ? source : '';
}

function splitSource(text) {
  const value = text || '';
  if (value === '') return [];
  const parts = value.split('\n');
  return parts.map((line, i) => (i < parts.length - 1 ? line + '\n' : line));
}

const serializer = {
  deserializeNotebook(content) {
    const text = new TextDecoder().decode(content);
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    const rawCells = data && Array.isArray(data.cells) ? data.cells : [];
    const cells = rawCells.map((c) => new NotebookCellData(
      NotebookCellKind.Code, joinSource(c && c.source), 'tera',
    ));
    return new NotebookData(cells);
  },
  serializeNotebook(data) {
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { name: 'tera', display_name: 'Tera' },
        language_info: { name: 'tera', file_extension: '.tera' },
      },
      cells: data.cells.map((c) => ({
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        source: splitSource(c.value),
        outputs: [],
      })),
    };
    return new TextEncoder().encode(JSON.stringify(notebook, null, 1));
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function dataframeHtml(value) {
  const cols = value.columns || [];
  const rows = value.rows || [];
  const head = cols.map((c) => `<th style="text-align:left;padding:2px 10px 2px 0">${escapeHtml(c)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = cols.map((c) => `<td style="padding:2px 10px 2px 0">${escapeHtml(row[c])}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  const more = value.total > rows.length ? `<div style="opacity:.6;margin-top:4px">${rows.length} of ${value.total} rows</div>` : '';
  return `<table style="border-collapse:collapse;font-family:var(--vscode-editor-font-family),monospace"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
}

function outputForValue(prints, value) {
  const outputs = [];
  if (prints && prints.length) outputs.push(new NotebookCellOutput([NotebookCellOutputItem.stdout(prints.join('\n'))]));
  if (value) {
    if (value.kind === 'text') outputs.push(new NotebookCellOutput([NotebookCellOutputItem.text(value.text)]));
    else if (value.kind === 'chart') outputs.push(new NotebookCellOutput([NotebookCellOutputItem.json(value.spec, CHART_MIME)]));
    else if (value.kind === 'dataframe') outputs.push(new NotebookCellOutput([NotebookCellOutputItem.text(dataframeHtml(value), 'text/html')]));
  }
  return outputs;
}

class KernelProcess {
  constructor(serverPath, cwd) {
    this.serverPath = serverPath;
    this.cwd = cwd;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.ready = null;
  }

  start() {
    if (this.proc) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [this.serverPath], {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      this.proc = proc;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => this._onData(chunk, resolve));
      proc.on('error', reject);
      proc.on('exit', () => {
        for (const { reject: rj } of this.pending.values()) rj(new Error('Tera kernel exited'));
        this.pending.clear();
        this.proc = null;
        this.ready = null;
      });
    });
    return this.ready;
  }

  _onData(chunk, onReady) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'ready') { onReady(); continue; }
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'kernel error'));
    }
  }

  async call(type, extra) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n');
    });
  }

  dispose() {
    if (this.proc) { this.proc.kill(); this.proc = null; }
    this.ready = null;
  }
}

export function registerTeraNotebook(context) {
  const serverPath = context.asAbsolutePath(join('media', 'kernel-server.mjs'));
  const kernels = new Map();

  function kernelFor(uri) {
    const key = uri.toString();
    if (!kernels.has(key)) {
      const folder = workspace.getWorkspaceFolder(uri);
      const cwd = folder ? folder.uri.fsPath : dirname(uri.fsPath);
      kernels.set(key, new KernelProcess(serverPath, cwd));
    }
    return kernels.get(key);
  }

  const controller = notebooks.createNotebookController('tera-kernel', NOTEBOOK_TYPE, 'Tera');
  controller.supportedLanguages = ['tera'];
  controller.supportsExecutionOrder = true;
  controller.description = 'Tera notebook kernel';

  let order = 0;
  controller.executeHandler = async (cells) => {
    for (const cell of cells) {
      const kernel = kernelFor(cell.notebook.uri);
      const exec = controller.createNotebookCellExecution(cell);
      exec.executionOrder = ++order;
      exec.start(Date.now());
      try {
        const result = await kernel.call('execute', { source: cell.document.getText() });
        await exec.replaceOutput(outputForValue(result.prints, result.value));
        exec.end(true, Date.now());
      } catch (err) {
        await exec.replaceOutput([new NotebookCellOutput([
          NotebookCellOutputItem.error(err instanceof Error ? err : new Error(String(err))),
        ])]);
        exec.end(false, Date.now());
      }
    }
  };

  controller.interruptHandler = async (notebook) => {
    const key = notebook.uri.toString();
    const kernel = kernels.get(key);
    if (kernel) { kernel.dispose(); kernels.delete(key); }
  };

  context.subscriptions.push(
    workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer),
    controller,
    workspace.onDidCloseNotebookDocument((doc) => {
      const key = doc.uri.toString();
      const kernel = kernels.get(key);
      if (kernel) { kernel.dispose(); kernels.delete(key); }
    }),
    { dispose() { for (const k of kernels.values()) k.dispose(); kernels.clear(); } },
  );
}
