export type OptMode = "default" | "none" | "always";
export type TypecheckMode = "off" | "warn" | "strict";
export type CliCommand = "run" | "repl" | "debug" | "help" | "version";

export type CliConfig = {
  command: CliCommand;
  files: string[];
  eval: string | null;
  readStdin: boolean;
  printBytecode: boolean;
  printAst: boolean;
  printIr: boolean;
  filter: string | null;
  traceCategories: string[];
  typecheck: TypecheckMode | null;
  check: boolean;
  optMode: OptMode;
  jitThreshold: number | null;
  baselineThreshold: number | null;
  maxDeopt: number | null;
  osr: boolean;
  exposeGc: boolean;
  allowNatives: boolean;
  stats: boolean;
};

export class CliUsageError extends Error {}

const TRACE_ALIASES: Record<string, string[]> = {
  "trace-opt": ["jit", "compile", "wasm"],
  "trace-deopt": ["deopt"],
  "trace-ic": ["ic"],
  "trace-maps": ["hidden_class", "hidden-class"],
  "trace-gc": ["GC"],
  "trace-feedback": ["feedback"],
};

const BOOLEAN_FLAGS: Record<string, (config: CliConfig) => void> = {
  "print-bytecode": (c) => (c.printBytecode = true),
  "print-ast": (c) => (c.printAst = true),
  "print-ir": (c) => (c.printIr = true),
  "trace-turbo": (c) => (c.printIr = true),
  check: (c) => (c.check = true),
  "no-opt": (c) => (c.optMode = "none"),
  "always-opt": (c) => (c.optMode = "always"),
  "no-osr": (c) => (c.osr = false),
  "expose-gc": (c) => (c.exposeGc = true),
  "allow-natives-syntax": (c) => (c.allowNatives = true),
  stats: (c) => (c.stats = true),
};

const VALUE_FLAGS: Record<string, (config: CliConfig, value: string) => void> = {
  filter: (c, v) => (c.filter = v),
  typecheck: (c, v) => (c.typecheck = parseTypecheck(v)),
  "opt-threshold": (c, v) => (c.jitThreshold = parseCount("opt-threshold", v)),
  "baseline-threshold": (c, v) =>
    (c.baselineThreshold = parseCount("baseline-threshold", v)),
  "max-deopt": (c, v) => (c.maxDeopt = parseCount("max-deopt", v)),
};

function defaults(): CliConfig {
  return {
    command: "repl",
    files: [],
    eval: null,
    readStdin: false,
    printBytecode: false,
    printAst: false,
    printIr: false,
    filter: null,
    traceCategories: [],
    typecheck: null,
    check: false,
    optMode: "default",
    jitThreshold: null,
    baselineThreshold: null,
    maxDeopt: null,
    osr: true,
    exposeGc: false,
    allowNatives: false,
    stats: false,
  };
}

function parseTypecheck(value: string): TypecheckMode {
  if (value === "off" || value === "warn" || value === "strict") return value;
  throw new CliUsageError(`--typecheck expects off|warn|strict, got '${value}'`);
}

function parseCount(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliUsageError(`--${name} expects a non-negative integer, got '${value}'`);
  }
  return parsed;
}

function addTrace(config: CliConfig, value: string | null): void {
  const categories = value ? value.split(",").map((part) => part.trim()).filter(Boolean) : ["all"];
  for (const category of categories) config.traceCategories.push(category);
}

function applyLongFlag(config: CliConfig, name: string, value: string | null): void {
  if (name === "help") return void (config.command = "help");
  if (name === "version") return void (config.command = "version");
  if (name === "trace") return addTrace(config, value);
  if (name === "eval") throw new CliUsageError("--eval must be followed by source");
  const traceAlias = TRACE_ALIASES[name];
  if (traceAlias) {
    for (const category of traceAlias) config.traceCategories.push(category);
    return;
  }
  const booleanFlag = BOOLEAN_FLAGS[name];
  if (booleanFlag) {
    if (value !== null) throw new CliUsageError(`--${name} does not take a value`);
    booleanFlag(config);
    return;
  }
  const valueFlag = VALUE_FLAGS[name];
  if (valueFlag) {
    if (value === null) throw new CliUsageError(`--${name} requires a value (--${name}=...)`);
    valueFlag(config, value);
    return;
  }
  throw new CliUsageError(`Unknown option '--${name}'`);
}

export function parseArgs(argv: readonly string[]): CliConfig {
  const config = defaults();
  let sawPositional = false;
  let evalPending = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (evalPending) {
      config.eval = token;
      evalPending = false;
      continue;
    }

    if (token === "--") {
      config.files.push(...argv.slice(i + 1));
      sawPositional = true;
      break;
    }

    if (token === "-e" || token === "--eval") {
      evalPending = true;
      continue;
    }

    if (token === "-h") {
      config.command = "help";
      continue;
    }

    if (token === "-v") {
      config.command = "version";
      continue;
    }

    if (token === "-") {
      config.readStdin = true;
      continue;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const value = eq === -1 ? null : body.slice(eq + 1);
      applyLongFlag(config, name, value);
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      throw new CliUsageError(`Unknown option '${token}'`);
    }

    if (!sawPositional && token === "debug") {
      config.command = "debug";
      sawPositional = true;
      continue;
    }

    config.files.push(token);
    sawPositional = true;
  }

  if (evalPending) throw new CliUsageError("-e must be followed by source");

  return resolveCommand(config);
}

function resolveCommand(config: CliConfig): CliConfig {
  if (config.command === "help" || config.command === "version") return config;
  if (config.command === "debug") return config;
  if (config.eval !== null || config.files.length > 0 || config.readStdin) {
    config.command = "run";
  }
  return config;
}
