const noop = () => {};
const disposable = { dispose: noop };

export const calls = {
  notebookControllers: [] as string[],
  serializers: [] as string[],
  languageClients: [] as string[],
  errors: [] as string[],
};

export function resetCalls(): void {
  calls.notebookControllers = [];
  calls.serializers = [];
  calls.languageClients = [];
  calls.errors = [];
}

export const window = {
  createOutputChannel: (name: string) => ({ name, appendLine: noop, dispose: noop }),
  showErrorMessage: (message: string) => {
    calls.errors.push(message);
  },
};

export const workspace = {
  createFileSystemWatcher: () => disposable,
  registerNotebookSerializer: (type: string) => {
    calls.serializers.push(type);
    return disposable;
  },
  onDidCloseNotebookDocument: () => disposable,
  getWorkspaceFolder: () => undefined,
  getConfiguration: () => ({ get: () => undefined }),
};

export const notebooks = {
  createNotebookController: (id: string) => {
    calls.notebookControllers.push(id);
    return { dispose: noop, supportedLanguages: [] as string[], supportsExecutionOrder: false, description: "" };
  },
};

export class NotebookCellData {
  constructor(public kind: number, public value: string, public languageId: string) {}
}
export class NotebookData {
  constructor(public cells: NotebookCellData[]) {}
}
export class NotebookCellOutput {
  constructor(public items: unknown[]) {}
}
export const NotebookCellOutputItem = {
  stdout: (text: string) => ({ mime: "application/vnd.code.notebook.stdout", text }),
  text: (text: string, mime = "text/plain") => ({ mime, text }),
  json: (value: unknown, mime: string) => ({ mime, value }),
  error: (error: Error) => ({ mime: "application/vnd.code.notebook.error", error }),
};
export const NotebookCellKind = { Markup: 1, Code: 2 };
