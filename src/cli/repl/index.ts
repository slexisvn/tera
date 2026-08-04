import terminalKit from "terminal-kit";
import { createLanguage } from "./language.js";
import { createAnalyzer } from "./analysis.js";
import { createCompleter } from "./completion.js";
import { createHistory } from "./history.js";
import { createPrinter } from "./display.js";
import { createInput } from "./input.js";
import { createCommandRegistry } from "./commands.js";
import { createSessionState } from "./session-state.js";
import { runSession } from "./session.js";
import { joinSource } from "./text.js";
import { defaultTheme } from "./theme.js";
import type { Printer } from "./display.js";
import type { ReplEngine, Terminal } from "./types.js";

function engineGlobalNames(engine: ReplEngine): string[] {
  const cells = engine.interpreter.globalCells?.cells;
  return cells ? Array.from(cells, ([key]) => String(key)) : [];
}

function printBanner(printer: Printer): void {
  printer.line("banner", "Tera REPL");
  printer.line("muted", "type .help for commands, ?<name> for docs, .exit to quit");
  printer.line("muted", "multiline: end a line with \\ (or press Alt+Enter) to continue");
}

export async function startREPL(engine: ReplEngine): Promise<void> {
  const term = terminalKit.terminal as unknown as Terminal;
  const theme = defaultTheme;
  const language = createLanguage();
  const analyzer = createAnalyzer();
  const history = createHistory();
  const printer = createPrinter(term, theme);
  const commander = createCommandRegistry();
  const state = createSessionState();

  let pending = "";
  const liveSource = () => joinSource(state.source(), pending);

  const complete = createCompleter({
    language,
    analyzer,
    sessionSource: liveSource,
    engineGlobals: () => engineGlobalNames(engine),
    commandNames: () => commander.names(),
    introspect: (receiver) => engine.introspectMembers?.(receiver) ?? null,
  });

  const readLine = createInput({ term, theme, language, analyzer, history, complete, sessionSource: liveSource });

  printBanner(printer);

  try {
    await runSession({
      engine,
      printer,
      language,
      analyzer,
      history,
      state,
      commander,
      readLine,
      knownNames: () => new Set<string>([...engineGlobalNames(engine), ...language.keywords, ...language.builtins.keys()]),
      clearScreen: () => term.clear(),
      publishPending: (source) => { pending = source; },
    });
  } finally {
    term.grabInput(false);
  }
}
