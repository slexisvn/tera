import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { EventEmitter } from 'node:events';
import { DocumentAnalyzer } from './analyzer/document_analyzer.js';
import { loadProviders } from './registry/providers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANGUAGE_DATA_PATH = join(HERE, '../language-data.json');

export async function startServer(connection = createConnection(ProposedFeatures.all)) {
  const documents = new TextDocuments(TextDocument);
  const languageData = loadLanguageData();
  const analyzer = new DocumentAnalyzer(languageData);
  const bus = new EventEmitter();
  const providers = await loadProviders();

  const ctx = { analyzer, languageData, bus, documents };

  const semanticLegend = providers.find(p => p.legend)?.legend ?? { tokenTypes: [], tokenModifiers: [] };

  connection.onInitialize(params => {
    connection.console.info(`Tera Language Server initialize — clientPid=${params.processId}, rootUri=${params.rootUri}, providers=${providers.map(p => p.id).join(',')}`);
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { triggerCharacters: ['.', '(', ' '], resolveProvider: false },
        hoverProvider: true,
        definitionProvider: true,
        signatureHelpProvider: { triggerCharacters: ['(', ','] },
        documentFormattingProvider: true,
        semanticTokensProvider: {
          legend: semanticLegend,
          full: true,
        },
      },
    };
  });
  connection.onInitialized(() => {
    connection.console.info('Tera Language Server initialized.');
  });

  documents.onDidChangeContent(e => {
    const doc = analyzer.update(e.document.uri, e.document.getText());
    bus.emit('analyzed', { uri: e.document.uri, doc });
  });

  documents.onDidClose(e => {
    analyzer.drop(e.document.uri);
    bus.emit('closed', { uri: e.document.uri });
  });

  for (const provider of providers) {
    provider.register(connection, ctx);
  }

  process.on('uncaughtException', err => {
    connection.console.error(`uncaughtException: ${err.message}\n${err.stack}`);
  });
  process.on('unhandledRejection', reason => {
    connection.console.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });

  documents.listen(connection);
  connection.listen();
  return { connection, documents, analyzer, ctx };
}

function loadLanguageData() {
  return JSON.parse(readFileSync(LANGUAGE_DATA_PATH, 'utf8'));
}

const isEntry = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server/index.js');
if (isEntry) {
  startServer();
}
