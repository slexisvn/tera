const { join } = require('node:path');
const { window, workspace } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

async function activate(context) {
  const serverModule = context.asAbsolutePath(join('server', 'index.js'));
  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'tera' },
      { scheme: 'untitled', language: 'tera' },
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
    window.showErrorMessage(`Tera language server failed to start: ${err && err.message ? err.message : err}`);
  }
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
