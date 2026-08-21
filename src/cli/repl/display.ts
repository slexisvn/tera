import { getTag, TAG_UNDEFINED, toDisplayString, type TaggedValue } from "../../core/value/index.js";
import { paint, type Theme, type UiRole } from "./theme.js";
import { suggestNames } from "./suggest.js";
import type { Terminal } from "./types.js";

const IDENTIFIER_PATTERNS = [
  /['"`]?([A-Za-z_$][\w$]*)['"`]? is not defined/,
  /Cannot find name ['"`]?([A-Za-z_$][\w$]*)/,
  /Unknown (?:variable|identifier|name) ['"`]?([A-Za-z_$][\w$]*)/,
  /([A-Za-z_$][\w$]*) is not a function/,
];

function extractIdentifier(message: string): string | null {
  for (const pattern of IDENTIFIER_PATTERNS) {
    const match = message.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(error);
}

export type Printer = {
  line(role: UiRole, text: string): void;
  result(value: TaggedValue): void;
  error(error: unknown, names?: Iterable<string>): void;
  raw(text: string): void;
};

export function createPrinter(term: Terminal, theme: Theme): Printer {
  const line = (role: UiRole, text: string): void => {
    term(`${paint(term, theme.ui[role], text)}\n`);
  };
  return {
    line,
    raw(text) {
      term(text.endsWith("\n") ? text : `${text}\n`);
    },
    result(value) {
      if (getTag(value) === TAG_UNDEFINED) return;
      line("result", toDisplayString(value));
    },
    error(error, names) {
      const message = errorMessage(error);
      line("error", message);
      const identifier = names ? extractIdentifier(message) : null;
      if (!identifier || !names) return;
      const suggestions = suggestNames(identifier, names);
      if (suggestions.length) line("muted", `did you mean: ${suggestions.join(", ")}?`);
    },
  };
}
