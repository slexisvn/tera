type DocsRuntime = {
  initNotebookDocs(options: { createCell(source?: string): string }): void;
  updateNotebookDocs(languageData: unknown): void;
  setNotebookDocsError(message: string): void;
};

const docsModules = import.meta.glob<DocsRuntime>("../docs.ts");

async function loadDocsRuntime(): Promise<DocsRuntime> {
  const load = docsModules["../docs.ts"];
  if (!load) throw new Error("Notebook docs runtime is unavailable");
  return load();
}

export async function initDocsRuntime(options: { createCell(source?: string): string }, languageData: unknown): Promise<void> {
  try {
    const runtime = await loadDocsRuntime();
    runtime.initNotebookDocs(options);
    runtime.updateNotebookDocs(languageData);
  } catch {
    const runtime = await loadDocsRuntime();
    runtime.setNotebookDocsError("Tera docs unavailable.");
  }
}
