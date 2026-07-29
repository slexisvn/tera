import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProposedFeatures, TextDocumentSyncKind, TextDocuments, createConnection,
  type Connection, type SemanticTokensLegend,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { LanguageData } from "../shared/language-data.ts";
import { DocumentAnalyzer } from "./analyzer/index.ts";
import { EventBus, type AnalyzerEvents } from "./bus.ts";
import { TypeResolver } from "./language/type-resolver.ts";
import { providers } from "./providers/index.ts";
import type { ProviderContext } from "./providers/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANGUAGE_DATA_PATH = join(HERE, "../language-data.json");

const EMPTY_LEGEND: SemanticTokensLegend = { tokenTypes: [], tokenModifiers: [] };

export function startServer(connection: Connection = createConnection(ProposedFeatures.all)) {
  const documents = new TextDocuments(TextDocument);
  const languageData = loadLanguageData();
  const analyzer = new DocumentAnalyzer(languageData);
  const bus = new EventBus<AnalyzerEvents>();

  const context: ProviderContext = {
    analyzer,
    languageData,
    types: new TypeResolver(languageData),
    bus,
  };

  const legend = providers.find((provider) => provider.legend)?.legend ?? EMPTY_LEGEND;

  connection.onInitialize((params) => {
    connection.console.info(
      `Tera Language Server initialize — clientPid=${params.processId}, ` +
      `rootUri=${params.rootUri}, providers=${providers.map((p) => p.id).join(",")}`,
    );
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        completionProvider: { triggerCharacters: [".", "(", " "], resolveProvider: false },
        hoverProvider: true,
        definitionProvider: true,
        signatureHelpProvider: { triggerCharacters: ["(", ","] },
        documentFormattingProvider: true,
        semanticTokensProvider: { legend, full: true },
      },
    };
  });

  connection.onInitialized(() => connection.console.info("Tera Language Server initialized."));

  documents.onDidChangeContent((event) => {
    const document = analyzer.update(event.document.uri, event.document.getText());
    bus.emit("analyzed", { uri: event.document.uri, document });
  });

  documents.onDidClose((event) => {
    analyzer.drop(event.document.uri);
    bus.emit("closed", { uri: event.document.uri });
  });

  for (const provider of providers) provider.register(connection, context);

  process.on("uncaughtException", (error) => {
    connection.console.error(`uncaughtException: ${error.stack ?? error.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    connection.console.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });

  documents.listen(connection);
  connection.listen();

  return { connection, documents, analyzer, context };
}

function loadLanguageData(): LanguageData {
  return JSON.parse(readFileSync(LANGUAGE_DATA_PATH, "utf8")) as LanguageData;
}

startServer();
