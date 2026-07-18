import { join } from "node:path";
import { window, workspace, type ExtensionContext } from "vscode";
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node.js";
import { registerNotebook } from "./notebook/index.ts";

const SERVER_ENTRY = join("dist", "server.mjs");

let client: LanguageClient | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  registerNotebook(context);

  const module = context.asAbsolutePath(SERVER_ENTRY);
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: {
      module,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "tera" },
      { scheme: "untitled", language: "tera" },
      { scheme: "vscode-notebook-cell", language: "tera" },
    ],
    synchronize: { fileEvents: workspace.createFileSystemWatcher("**/*.tera") },
    outputChannel: window.createOutputChannel("Tera Language Server"),
  };

  client = new LanguageClient("tera", "Tera Language Server", serverOptions, clientOptions);
  try {
    await client.start();
  } catch (error) {
    window.showErrorMessage(`Tera language server failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop();
}
