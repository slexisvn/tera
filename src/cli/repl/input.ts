import { paint, resolveStyle, type Theme } from "./theme.js";
import { createTokenHook, TERA_TOKEN_REGEXP } from "./highlight.js";
import { attachSignatureHint, type SignatureDeps } from "./signature.js";
import type { Analyzer, InputFieldOptions, KeyHandler, ReadLine, Terminal } from "./types.js";
import type { Language } from "./language.js";
import type { History } from "./history.js";

const AUTO_CLOSE_PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

const KEY_BINDINGS: Record<string, string> = {
  CTRL_C: "cancel",
  ESCAPE: "cancel",
  ENTER: "submit",
  KP_ENTER: "submit",
  CTRL_D: "cancel",
  BACKSPACE: "backDelete",
  DELETE: "delete",
  LEFT: "backward",
  RIGHT: "forward",
  UP: "historyPrevious",
  DOWN: "historyNext",
  HOME: "startOfInput",
  END: "endOfInput",
  TAB: "autoComplete",
  CTRL_R: "autoCompleteUsingHistory",
  CTRL_LEFT: "previousWord",
  CTRL_RIGHT: "nextWord",
  ALT_D: "deleteNextWord",
  CTRL_W: "deletePreviousWord",
  CTRL_U: "deleteAllBefore",
  CTRL_K: "deleteAllAfter",
  ALT_ENTER: "submit",
  ALT_KP_ENTER: "submit",
};

export type InputDeps = {
  term: Terminal;
  theme: Theme;
  language: Language;
  analyzer: Analyzer;
  history: History;
  complete: (input: string) => string | string[];
  sessionSource: () => string;
};

const CONTINUE_KEYS = new Set(["ALT_ENTER", "ALT_KP_ENTER"]);

function reserveLineBelow(term: Terminal, column: number): void {
  try {
    term("\n");
    term.up(1);
    term.column(column);
  } catch {}
}

export function createInput(deps: InputDeps): ReadLine {
  const { term, theme } = deps;
  const tokenHook = createTokenHook(deps.language, theme);
  const hintStyle = resolveStyle(term, theme.ui.hint);
  const signatureDeps: SignatureDeps = {
    term,
    theme,
    language: deps.language,
    analyzer: deps.analyzer,
    sessionSource: deps.sessionSource,
  };

  return async (prompt, defaultText) => {
    term(paint(term, theme.ui.prompt, prompt));
    reserveLineBelow(term, [...prompt].length + 1);
    const options: InputFieldOptions = {
      history: deps.history.entries,
      autoComplete: deps.complete,
      autoCompleteHint: true,
      autoCompleteMenu: true,
      autoClosePairs: AUTO_CLOSE_PAIRS,
      cancelable: true,
      keyBindings: KEY_BINDINGS,
      tokenRegExp: TERA_TOKEN_REGEXP,
      tokenHook,
    };
    if (hintStyle) options.hintStyle = hintStyle;
    if (defaultText) options.default = defaultText;

    const controller = term.inputField(options);
    const detach = attachSignatureHint(signatureDeps, controller);

    let forced = false;
    const onKey: KeyHandler = (key) => {
      if (CONTINUE_KEYS.has(key)) forced = true;
    };
    term.on("key", onKey);

    const line = await controller.promise;
    term.removeListener("key", onKey);
    detach();
    term("\n");

    if (forced) return { text: line ?? "", forceContinue: true };
    return line === undefined ? null : { text: line, forceContinue: false };
  };
}
