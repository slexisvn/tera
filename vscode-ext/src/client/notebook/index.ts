import { dirname, join } from "node:path";
import {
  NotebookCellOutput, NotebookCellOutputItem, notebooks, workspace,
  type ExtensionContext, type NotebookCell, type Uri,
} from "vscode";
import { KernelProcess } from "./kernel.ts";
import { buildOutputs } from "./outputs.ts";
import { NOTEBOOK_TYPE, serializer } from "./serializer.ts";

const KERNEL_ENTRY = join("dist", "kernel-server.mjs");

export function registerNotebook(context: ExtensionContext): void {
  const serverPath = context.asAbsolutePath(KERNEL_ENTRY);
  const kernels = new Map<string, KernelProcess>();

  const kernelFor = (uri: Uri): KernelProcess => {
    const key = uri.toString();
    const existing = kernels.get(key);
    if (existing) return existing;

    const folder = workspace.getWorkspaceFolder(uri);
    const kernel = new KernelProcess(serverPath, folder ? folder.uri.fsPath : dirname(uri.fsPath));
    kernels.set(key, kernel);
    return kernel;
  };

  const disposeKernel = (uri: Uri): void => {
    const key = uri.toString();
    kernels.get(key)?.dispose();
    kernels.delete(key);
  };

  const controller = notebooks.createNotebookController("tera-kernel", NOTEBOOK_TYPE, "Tera");
  controller.supportedLanguages = ["tera"];
  controller.supportsExecutionOrder = true;
  controller.description = "Tera notebook kernel";

  let order = 0;
  controller.executeHandler = async (cells: NotebookCell[]) => {
    for (const cell of cells) {
      const execution = controller.createNotebookCellExecution(cell);
      execution.executionOrder = ++order;
      execution.start(Date.now());
      try {
        const result = await kernelFor(cell.notebook.uri).execute(cell.document.getText());
        await execution.replaceOutput(buildOutputs(result.prints, result.value));
        execution.end(true, Date.now());
      } catch (error) {
        await execution.replaceOutput([
          new NotebookCellOutput([
            NotebookCellOutputItem.error(error instanceof Error ? error : new Error(String(error))),
          ]),
        ]);
        execution.end(false, Date.now());
      }
    }
  };

  controller.interruptHandler = async (notebook) => disposeKernel(notebook.uri);

  context.subscriptions.push(
    workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer),
    controller,
    workspace.onDidCloseNotebookDocument((notebook) => disposeKernel(notebook.uri)),
    {
      dispose() {
        for (const kernel of kernels.values()) kernel.dispose();
        kernels.clear();
      },
    },
  );
}
