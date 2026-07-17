import { join } from 'node:path';
import { window, workspace } from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node.js';
import { registerNotebook } from './notebook.js';

let client;

export async function activate(context) {
  registerNotebook(context);

  const serverModule = context.asAbsolutePath(join('server', 'index.js'));
  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'tera' },
      { scheme: 'untitled', language: 'tera' },
      { scheme: 'vscode-notebook-cell', language: 'tera' },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.tera'),
    },
    outputChannel: window.createOutputChannel('Tera Language Server'),
  };
  client = new LanguageClient('tera', 'Tera Language Server', serverOptions, clientOptions);
  try {
    await client.start();
  } catch (err) {
    window.showErrorMessage(`Tera language server failed to start: ${err?.message ?? err}`);
  }
}

export function deactivate() {
  return client ? client.stop() : undefined;
}
