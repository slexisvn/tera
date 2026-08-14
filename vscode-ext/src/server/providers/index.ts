import codeAction from "./code-action.ts";
import completion from "./completion.ts";
import definition from "./definition.ts";
import diagnostics from "./diagnostics.ts";
import documentHighlight from "./document-highlight.ts";
import documentSymbols from "./document-symbols.ts";
import formatter from "./formatter.ts";
import hover from "./hover.ts";
import references from "./references.ts";
import rename from "./rename.ts";
import semanticTokens from "./semantic-tokens.ts";
import signatureHelp from "./signature-help.ts";
import workspaceSymbols from "./workspace-symbols.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [
  codeAction,
  completion,
  definition,
  diagnostics,
  documentHighlight,
  documentSymbols,
  formatter,
  hover,
  references,
  rename,
  semanticTokens,
  signatureHelp,
  workspaceSymbols,
];

export type { Provider, ProviderContext } from "./types.ts";
