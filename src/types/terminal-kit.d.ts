declare module "terminal-kit" {
  type TerminalKeyData = {
    isCharacter?: boolean;
  };

  type InputController = {
    promise: Promise<string | undefined>;
    getInput(): string;
    getCursorPosition(): number;
  };

  type TerminalInputOptions = {
    history: string[];
    autoComplete(input: string): string | string[];
    autoCompleteHint: boolean;
    autoCompleteMenu: boolean;
    cancelable: boolean;
    keyBindings: Record<string, string>;
    tokenRegExp: RegExp;
    tokenHook(token: string): string;
  };

  type Terminal = {
    (text: string): void;
    inputField(options: TerminalInputOptions): InputController;
    emit(event: string, key: string, trash?: object | null, data?: TerminalKeyData): void;
    on(event: string, handler: (key: string, trash?: object | null, data?: TerminalKeyData) => void): void;
    removeListener(event: string, handler: (key: string, trash?: object | null, data?: TerminalKeyData) => void): void;
  };

  const terminalKit: {
    terminal: Terminal;
  };

  export default terminalKit;
}

declare module "cli-highlight" {
  type HighlightOptions = Record<string, string | number | boolean | RegExp>;
  type HighlightFn = (code: string, options?: HighlightOptions) => string;
  const cliHighlight: HighlightFn & {
    highlight?: HighlightFn;
    default?: { highlight?: HighlightFn };
  };

  export default cliHighlight;
}
