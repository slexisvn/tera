import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import languageData from "../../../vscode-ext/language-data.json";
import { DocsPanel } from "../components/layout/DocsPanel";
import { Sidebar } from "../components/layout/Sidebar";
import { NotebookCell } from "../components/notebook/NotebookCell";
import { SEED_CELLS, STORAGE_KEY, THEME_KEY } from "../config/constants";
import { parseCsvInWorker, parseCsvOnMainThread } from "../services/csv-upload";
import { analyzeCells, type NotebookDiagnostic } from "../services/diagnostics";
import { fileExt, isBinaryFile, loadCommandFor } from "../utils/file-utils";
import { KernelClient } from "../services/kernel-client";
import { serializeNotebook, parseNotebook } from "../utils/tenb";
import { initDocsRuntime } from "../services/docs-runtime";
import { makeCompletionSource } from "../utils/completion";
import type { AddCellOptions, CellOutput, CellState, CsvRow, KernelRunResult, UploadedFileMeta } from "../types/notebook";

const makeId = () => `cell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function loadInitialCells(): CellState[] {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    saved = null;
  }
  const sources = Array.isArray(saved) && saved.length ? saved.filter((item): item is string => typeof item === "string") : SEED_CELLS;
  return sources.length ? sources.map((source) => ({ id: makeId(), source })) : [{ id: makeId(), source: "" }];
}

export default function App() {
  const [cells, setCells] = useState<CellState[]>(loadInitialCells);
  const [uploadedFiles, setUploadedFiles] = useState(() => new Map<string, UploadedFileMeta>());
  const [kernelText, setKernelText] = useState("ready");
  const [kernelBusy, setKernelBusy] = useState(false);
  const [docsOpen, setDocsOpen] = useState(true);
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem(THEME_KEY) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  });
  const [completionNames, setCompletionNames] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState(() => new Map<string, NotebookDiagnostic[]>());
  const kernelRef = useRef<KernelClient | null>(null);
  const execCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarRef = useRef<HTMLElement | null>(null);

  const setKernel = useCallback((text: string, busy = false) => {
    setKernelText(text);
    setKernelBusy(busy);
  }, []);

  const bootKernel = useCallback(() => {
    kernelRef.current?.terminate();
    kernelRef.current = new KernelClient();
    execCountRef.current = 0;
    kernelRef.current.call<string[]>("completionNames").then(setCompletionNames).catch(() => undefined);
  }, []);

  useEffect(() => {
    bootKernel();
    return () => kernelRef.current?.terminate();
  }, [bootKernel]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cells.map((cell) => cell.source)));
    const handle = window.setTimeout(() => setDiagnostics(analyzeCells(cells)), 250);
    return () => window.clearTimeout(handle);
  }, [cells]);

  useEffect(() => {
    void initDocsRuntime({ createCell: (source = "") => addCell(source, { focus: true }) }, languageData);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("docs-closed", !docsOpen);
    document.body.classList.toggle("docs-open", docsOpen);
  }, [docsOpen]);

  useEffect(() => {
    const syncToolbarHeight = () => {
      if (toolbarRef.current) document.documentElement.style.setProperty("--toolbar-h", `${toolbarRef.current.offsetHeight}px`);
    };
    syncToolbarHeight();
    const resizeObserver = "ResizeObserver" in window && toolbarRef.current ? new ResizeObserver(syncToolbarHeight) : null;
    if (resizeObserver && toolbarRef.current) resizeObserver.observe(toolbarRef.current);
    window.addEventListener("resize", syncToolbarHeight);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncToolbarHeight);
    };
  }, []);

  const addCell = useCallback((source = "", options: AddCellOptions = {}) => {
    const id = makeId();
    setCells((current) => {
    const nextCell: CellState = { id, source };
      if (!options.afterId) return [...current, nextCell];
      const index = current.findIndex((cell) => cell.id === options.afterId);
      if (index < 0) return [...current, nextCell];
      return [...current.slice(0, index + 1), nextCell, ...current.slice(index + 1)];
    });
    if (options.focus) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-cell-id="${id}"] .cm-content`)?.focus(), 50);
    return id;
  }, []);

  const updateCell = useCallback((id: string, source: string) => {
    setCells((current) => current.map((cell) => cell.id === id ? { ...cell, source } : cell));
  }, []);

  const deleteCell = useCallback((id: string) => {
    setCells((current) => {
      const next = current.filter((cell) => cell.id !== id);
      return next.length ? next : [{ id: makeId(), source: "" }];
    });
  }, []);

  const moveCell = useCallback((id: string, delta: number) => {
    setCells((current) => {
      const index = current.findIndex((cell) => cell.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = current.slice();
      const [cell] = next.splice(index, 1);
      next.splice(target, 0, cell);
      return next;
    });
  }, []);

  const runCell = useCallback(async (id: string) => {
    const kernel = kernelRef.current;
    const cell = cells.find((item) => item.id === id);
    if (!kernel || !cell) return null;
    setKernel("running", true);
    setCells((current) => current.map((item) => item.id === id ? { ...item, running: true, output: undefined } : item));
    let output: CellOutput;
    try {
      const result = await kernel.call<KernelRunResult>("execute", { source: cell.source });
      if (result.completionNames) setCompletionNames(result.completionNames);
      output = { ok: true, prints: result.prints || [], value: result.value };
    } catch (err) {
      output = { ok: false, prints: [], error: err instanceof Error ? err.message : String(err) };
    }
    const count = ++execCountRef.current;
    setCells((current) => current.map((item) => item.id === id ? { ...item, running: false, executionCount: count, output } : item));
    setKernel("ready");
    return output;
  }, [cells, setKernel]);

  const runAll = useCallback(async () => {
    for (const cell of cells) {
      const result = await runCell(cell.id);
      if (result && !result.ok) break;
    }
  }, [cells, runCell]);

  const restart = useCallback(() => {
    bootKernel();
    setCells((current) => current.map((cell) => ({ ...cell, executionCount: undefined, output: undefined, running: false })));
    setKernel("ready");
  }, [bootKernel, setKernel]);

  const clearOutputs = useCallback(() => {
    setCells((current) => current.map((cell) => ({ ...cell, executionCount: undefined, output: undefined, running: false })));
  }, []);

  const importNotebook = useCallback(async (file: File) => {
    const sources = parseNotebook(await file.text());
    setCells((sources.length ? sources : [""]).map((source) => ({ id: makeId(), source })));
  }, []);

  const exportNotebook = useCallback(() => {
    const text = serializeNotebook(cells.map((cell) => cell.source));
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "notebook.tenb";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [cells]);

  const uploadCsv = useCallback(async (file: File) => {
    const kernel = kernelRef.current;
    if (!kernel) return;
    const onProgress = (read: number) => setKernel(`loading ${file.name} ${file.size ? Math.round((read / file.size) * 100) : 0}%`, true);
    setKernel(`loading ${file.name}...`, true);
    await kernel.call("beginCsv", { name: file.name });
    let appended = false;
    const pending: Promise<unknown>[] = [];
    const onBatch = (rows: CsvRow[]) => {
      appended = true;
      pending.push(kernel.call("appendCsvRows", { name: file.name, rows }));
    };
    let result;
    try {
      result = await parseCsvInWorker(file, onBatch, onProgress);
    } catch (err) {
      if (appended) throw err;
      result = await parseCsvOnMainThread(file, onBatch, onProgress);
    }
    await Promise.all(pending);
    await kernel.call("finishCsv", { name: file.name });
    setUploadedFiles((current) => new Map(current).set(file.name, { kind: "csv", rowCount: result.rowCount, size: file.size }));
  }, [setKernel]);

  const uploadGenericFile = useCallback(async (file: File) => {
    const kernel = kernelRef.current;
    if (!kernel) return;
    const ext = fileExt(file.name);
    setKernel(`loading ${file.name}...`, true);
    if (isBinaryFile(file.name)) {
      const buffer = await file.arrayBuffer();
      await kernel.call("writeFile", { name: file.name, data: buffer, binary: true }, [buffer]);
    } else {
      await kernel.call("writeFile", { name: file.name, data: await file.text(), binary: false });
    }
    setUploadedFiles((current) => new Map(current).set(file.name, { kind: "file", ext, size: file.size }));
  }, [setKernel]);

  const uploadFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        if (fileExt(file.name) === "tenb") await importNotebook(file);
        else if (fileExt(file.name) === "csv") await uploadCsv(file);
        else await uploadGenericFile(file);
      } catch (err) {
        setKernel(`error in ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setKernel("ready");
  }, [importNotebook, setKernel, uploadCsv, uploadGenericFile]);

  const removeFile = useCallback(async (name: string) => {
    const meta = uploadedFiles.get(name);
    setUploadedFiles((current) => {
      const next = new Map(current);
      next.delete(name);
      return next;
    });
    if (meta) {
      try {
        await kernelRef.current?.call("removeFile", { name, kind: meta.kind });
      } catch {
        setKernel("ready");
      }
    }
  }, [setKernel, uploadedFiles]);

  const insertFileCell = useCallback((name: string) => {
    addCell(loadCommandFor(name), { focus: true });
  }, [addCell]);

  const handleDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    uploadFiles([...event.dataTransfer.files]);
  }, [uploadFiles]);

  const completionSource = useMemo(() => makeCompletionSource(completionNames), [completionNames]);

  return (
    <>
      <header className="toolbar" ref={toolbarRef}>
        <div className="brand">
          <span className="logo">Tera</span>
          <span className="sub">notebook</span>
        </div>
        <div className="actions">
          <button id="docs-toggle" className="docs-toggle" type="button" title="Open Tera docs" aria-controls="docs-panel" aria-expanded={docsOpen} onClick={() => setDocsOpen((open) => !open)}>Docs</button>
          <button type="button" title="Upload files" onClick={() => fileInputRef.current?.click()}>File</button>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => {
            uploadFiles([...(event.currentTarget.files || [])]);
            event.currentTarget.value = "";
          }} />
          <button type="button" title="Run all cells" onClick={runAll}>Run all</button>
          <button type="button" title="Restart kernel" onClick={restart}>Restart</button>
          <button type="button" title="Clear outputs" onClick={clearOutputs}>Clear</button>
          <button type="button" title="Export notebook (.tenb)" onClick={exportNotebook}>Export</button>
          <button id="theme-toggle" type="button" title="Toggle dark mode" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "Light" : "Dark"}</button>
          <span className={`kernel${kernelBusy ? " busy" : ""}`}>kernel: {kernelText}</span>
        </div>
      </header>
      <div className="layout" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
        <Sidebar files={uploadedFiles} onInsert={insertFileCell} onRemove={removeFile} />
        <div className="content">
          <main className="cells">
            {cells.map((cell) => (
              <NotebookCell
                key={cell.id}
                cell={cell}
                diagnostics={diagnostics.get(cell.id) || []}
                completionSource={completionSource}
                onChange={updateCell}
                onRun={runCell}
                onAdd={addCell}
                onDelete={deleteCell}
                onMove={moveCell}
                kernel={kernelRef}
              />
            ))}
          </main>
          <div id="docs-backdrop" className="docs-backdrop" hidden={!docsOpen} onClick={() => setDocsOpen(false)} />
          <DocsPanel onClose={() => setDocsOpen(false)} />
        </div>
      </div>
      <footer className="hint">
        <kbd>Shift</kbd>+<kbd>Enter</kbd> run and next · <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Enter</kbd> run · cells share one kernel
      </footer>
    </>
  );
}
