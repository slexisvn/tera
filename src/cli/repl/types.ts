import type { TaggedValue } from "../../core/value/index.js";
import type { GlobalCell } from "../../runtime/intrinsics/global-cells.js";
import type { IntrospectedMember } from "../../runtime/introspect.js";
import type { SourceSymbolTable, SymbolPosition } from "../../frontend/index.js";
import type { Language } from "./language.js";

export type { IntrospectedMember } from "../../runtime/introspect.js";

export type ModuleSession = {
  readonly root: string;
  readonly searchPaths: readonly string[];
};

export type ReplOptions = {
  readonly modulePaths: readonly string[];
};

export type ReplEngine = {
  interpreter: { globalCells?: { cells?: Iterable<[string, GlobalCell]> } };
  input?: ((prompt: string) => string | null) | undefined;
  run(source: string, options?: { moduleRoot?: string; searchPaths?: readonly string[] }): TaggedValue;
  runWithDisassembly(source: string): TaggedValue;
  reset(): void;
  getStats(): unknown;
  drainMicrotasks?(): void;
  introspectMembers?(receiver: string): IntrospectedMember[] | null;
  loadedModules?(): string[];
  reloadModule?(spec: string): boolean;
};

export type TermStyle = ((text: string) => void) & {
  noFormat(text: string): void;
};

export type KeyData = { isCharacter?: boolean };
export type KeyHandler = (key: string, matches?: unknown, data?: KeyData) => void;

export type TokenHook = (
  token: string,
  isEndOfInput: boolean,
  previousTokens: string[],
  term: Terminal,
  config: unknown,
) => TermStyle | string | undefined;

export type InputFieldOptions = {
  history?: string[];
  autoComplete?: (input: string) => string | string[];
  autoCompleteHint?: boolean;
  autoCompleteMenu?: boolean | Record<string, unknown>;
  autoClosePairs?: Record<string, string>;
  cancelable?: boolean;
  default?: string;
  hintStyle?: TermStyle;
  style?: TermStyle;
  keyBindings?: Record<string, string>;
  tokenRegExp?: RegExp;
  tokenHook?: TokenHook;
};

export type InputController = {
  promise: Promise<string | undefined>;
  getInput(): string;
  getCursorPosition(): number;
  getPosition(): { x: number; y: number };
  redraw(): void;
  abort(): void;
};

export type LineResult = { text: string; forceContinue: boolean };

export type ReadLine = (prompt: string, defaultText: string) => Promise<LineResult | null>;

export type Terminal = ((text: string) => void) & {
  inputField(options: InputFieldOptions): InputController;
  grabInput(grab: boolean): void;
  saveCursor(): void;
  restoreCursor(): void;
  eraseLineAfter(): void;
  eraseLine(): void;
  clear(): void;
  column(n: number): void;
  up(n: number): void;
  down(n: number): void;
  on(event: "key", handler: KeyHandler): void;
  removeListener(event: "key", handler: KeyHandler): void;
  emit(event: "key", key: string, matches: unknown, data: KeyData): void;
} & Record<string, unknown>;

export type SessionAnalysis = {
  source: string;
  symbols: SourceSymbolTable;
  positionOf(fragmentOffset: number): SymbolPosition;
};

export type Analyzer = {
  analyze(sessionSource: string, fragment: string): SessionAnalysis;
};

export type CompletionItem = {
  label: string;
  kind: string;
  detail?: string;
  doc?: string;
};

export type CompletionContext = {
  line: string;
  word: string;
  prefix: string;
  isMember: boolean;
  ownerExpr: string | null;
  language: Language;
  analysis: SessionAnalysis;
  globals: readonly string[];
  introspect: (receiver: string) => IntrospectedMember[] | null;
};

export type CompletionProvider = {
  match(ctx: CompletionContext): boolean;
  complete(ctx: CompletionContext): CompletionItem[];
};
