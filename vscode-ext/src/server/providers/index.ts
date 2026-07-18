import completion from "./completion.ts";
import definition from "./definition.ts";
import diagnostics from "./diagnostics.ts";
import formatter from "./formatter.ts";
import hover from "./hover.ts";
import semanticTokens from "./semantic-tokens.ts";
import signatureHelp from "./signature-help.ts";
import type { Provider } from "./types.ts";

export const providers: Provider[] = [
  completion,
  definition,
  diagnostics,
  formatter,
  hover,
  semanticTokens,
  signatureHelp,
];

export type { Provider, ProviderContext } from "./types.ts";
