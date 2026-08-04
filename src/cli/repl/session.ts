import { getPayload, isPromise, toDisplayString, type PromisePayload, type TaggedValue } from "../../core/value/index.js";
import { COMMAND_PREFIX, CONTINUATION_PROMPT, HELP_PREFIX, PRIMARY_PROMPT } from "./config.js";
import { assess, lineContinuation, nextIndent, stripLineContinuation } from "./multiline.js";
import { showDocumentation, type CommandContext, type CommandRegistry } from "./commands.js";
import type { Analyzer, ReadLine, ReplEngine } from "./types.js";
import type { Printer } from "./display.js";
import type { Language } from "./language.js";
import type { History } from "./history.js";
import type { SessionState } from "./session-state.js";

export type { ReadLine } from "./types.js";

export type SessionDeps = {
  engine: ReplEngine;
  printer: Printer;
  language: Language;
  analyzer: Analyzer;
  history: History;
  state: SessionState;
  commander: CommandRegistry;
  readLine: ReadLine;
  knownNames: () => Iterable<string>;
  clearScreen: () => void;
  publishPending: (source: string) => void;
};

function settlePromise(engine: ReplEngine, value: TaggedValue): TaggedValue {
  if (!isPromise(value)) return value;
  engine.drainMicrotasks?.();
  const payload = getPayload(value) as PromisePayload;
  if (payload.state === "fulfilled") return payload.result;
  if (payload.state === "rejected") throw new Error(toDisplayString(payload.result));
  return value;
}

export async function runSession(deps: SessionDeps): Promise<void> {
  const { engine, printer, history, state, readLine, commander } = deps;

  const evaluate = (code: string): void => {
    try {
      printer.result(settlePromise(engine, engine.run(code)));
      state.append(code);
    } catch (error) {
      printer.error(error, deps.knownNames());
    }
  };

  const commandCtx: CommandContext = {
    engine,
    printer,
    language: deps.language,
    analyzer: deps.analyzer,
    session: { source: state.source, reset: state.reset },
    evaluate,
    clearScreen: deps.clearScreen,
  };

  let buffer = "";
  let indentHint = "";

  const resetBuffer = (): void => {
    buffer = "";
    indentHint = "";
  };

  while (true) {
    const inBlock = buffer !== "";
    const prompt = inBlock ? CONTINUATION_PROMPT : PRIMARY_PROMPT;
    deps.publishPending(buffer);
    const result = await readLine(prompt, inBlock ? indentHint : "");

    if (result === null) {
      if (inBlock) {
        printer.line("muted", "^C");
        resetBuffer();
        continue;
      }
      break;
    }

    const text = result.text;

    if (!inBlock) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith(COMMAND_PREFIX)) {
        history.push(trimmed);
        if (commander.dispatch(trimmed, commandCtx) === "exit") break;
        continue;
      }
      if (trimmed.startsWith(HELP_PREFIX)) {
        history.push(trimmed);
        showDocumentation(trimmed.slice(HELP_PREFIX.length), commandCtx);
        continue;
      }
    }

    if (text.trim() || inBlock) history.push(text);

    const continued = lineContinuation(text);
    const body = continued ? stripLineContinuation(text) : text;
    buffer = buffer === "" ? body : `${buffer}\n${body}`;

    if (continued || result.forceContinue) {
      indentHint = nextIndent(buffer);
      continue;
    }

    const status = assess(buffer);
    if (!status.complete) {
      indentHint = status.indent;
      continue;
    }

    const code = buffer;
    resetBuffer();
    evaluate(code);
  }

  printer.line("muted", "bye");
}
