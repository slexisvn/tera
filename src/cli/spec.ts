import { TERA_HEAP_MINIMUM_BYTES } from "../optimizing/target/runtime-layout.js";
import {
  engineDefaults,
  sourceDefaults,
  type CheckConfig,
  type CliConfig,
  type CompileConfig,
  type DebugConfig,
  type EmitKind,
  type EngineFlags,
  type HelpConfig,
  type LinkMode,
  type ResultMode,
  type RunConfig,
  type SourceInputs,
  type TargetsConfig,
  type TypecheckMode,
} from "./config.js";

export class CliUsageError extends Error {}

export const STDIN_TOKEN = "-";

export const FLAG_GROUPS = [
  "Input",
  "Output",
  "Inspection",
  "Tracing",
  "Optimization",
  "Types",
] as const;

export type FlagGroup = (typeof FLAG_GROUPS)[number];

export interface FlagSpec<C> {
  readonly name: string;
  readonly short?: string;
  readonly value?: string;
  readonly valueOptional?: boolean;
  readonly group: FlagGroup;
  readonly summary: string;
  apply(config: C, value: string): void;
}

export interface CommandSpec<C> {
  readonly name: string;
  readonly summary: string;
  readonly arguments: string;
  readonly flags: readonly FlagSpec<C>[];
  defaults(): C;
  accept(config: C, token: string): void;
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

const BYTE_SUFFIXES = new Map<string, number>([
  ["k", 1 << 10],
  ["m", 1 << 20],
  ["g", 1 << 30],
]);

function parseBytes(name: string, value: string): number {
  const match = /^(\d+)([kmg]?)b?$/i.exec(value.trim());
  const scale = match === null ? undefined : BYTE_SUFFIXES.get(match[2]!.toLowerCase()) ?? 1;
  const parsed = match === null ? Number.NaN : Number(match[1]) * scale!;
  if (!Number.isSafeInteger(parsed) || parsed < TERA_HEAP_MINIMUM_BYTES) {
    throw new CliUsageError(
      `--${name} expects a size of at least ${TERA_HEAP_MINIMUM_BYTES} bytes (for example 64m), got '${value}'`,
    );
  }
  return parsed;
}

function parseChoice<T extends string>(
  name: string,
  value: string,
  choices: readonly T[],
): T {
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new CliUsageError(`--${name} expects ${choices.join("|")}, got '${value}'`);
}

function traceCategories(value: string): readonly string[] {
  if (value.length === 0) return ["all"];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const TRACE_ALIASES: readonly (readonly [string, string, readonly string[]])[] = [
  ["trace-opt", "trace optimizing compilation", ["jit", "compile", "wasm"]],
  ["trace-deopt", "trace deoptimizations", ["deopt"]],
  ["trace-ic", "trace inline caches", ["ic"]],
  ["trace-maps", "trace hidden-class transitions", ["hidden_class", "hidden-class"]],
  ["trace-gc", "trace garbage collection", ["GC"]],
  ["trace-feedback", "trace feedback vectors", ["feedback"]],
];

const TYPECHECK_FLAG: FlagSpec<{ typecheck: TypecheckMode | null }> = {
  name: "typecheck",
  value: "off|warn|strict",
  group: "Types",
  summary: "set the type checker mode",
  apply: (config, value) => (config.typecheck = parseTypecheck(value)),
};

const ENGINE_FLAGS: readonly FlagSpec<EngineFlags>[] = [
  {
    name: "print-bytecode",
    group: "Inspection",
    summary: "disassemble each function as it is compiled",
    apply: (config) => (config.printBytecode = true),
  },
  {
    name: "print-ast",
    group: "Inspection",
    summary: "print the parsed AST of each program",
    apply: (config) => (config.printAst = true),
  },
  {
    name: "print-ir",
    group: "Inspection",
    summary: "dump the optimizer CFG of each optimized function",
    apply: (config) => (config.printIr = true),
  },
  {
    name: "trace-turbo",
    group: "Inspection",
    summary: "alias of --print-ir",
    apply: (config) => (config.printIr = true),
  },
  {
    name: "filter",
    value: "substr",
    group: "Inspection",
    summary: "restrict name-filtered dumps to matching functions",
    apply: (config, value) => (config.filter = value),
  },
  {
    name: "stats",
    group: "Inspection",
    summary: "print engine statistics after running",
    apply: (config) => (config.stats = true),
  },
  {
    name: "print-module-graph",
    group: "Inspection",
    summary: "print the resolved module graph, its cycles and its init order",
    apply: (config) => (config.printModuleGraph = true),
  },
  {
    name: "module-path",
    value: "dir",
    group: "Input",
    summary: "add a directory to the module search path (repeatable)",
    apply: (config, value) => config.modulePaths.push(value),
  },
  {
    name: "trace",
    value: "cats",
    valueOptional: true,
    group: "Tracing",
    summary: "enable the tracer (all categories, or a comma list)",
    apply: (config, value) => config.traceCategories.push(...traceCategories(value)),
  },
  ...TRACE_ALIASES.map(([name, summary, categories]) => ({
    name,
    group: "Tracing" as FlagGroup,
    summary,
    apply: (config: EngineFlags) => config.traceCategories.push(...categories),
  })),
  {
    name: "no-opt",
    group: "Optimization",
    summary: "never tier up to the optimizing compiler",
    apply: (config) => (config.optMode = "none"),
  },
  {
    name: "always-opt",
    group: "Optimization",
    summary: "optimize functions as early as possible",
    apply: (config) => (config.optMode = "always"),
  },
  {
    name: "opt-threshold",
    value: "n",
    group: "Optimization",
    summary: "call count before optimizing",
    apply: (config, value) => (config.jitThreshold = parseCount("opt-threshold", value)),
  },
  {
    name: "baseline-threshold",
    value: "n",
    group: "Optimization",
    summary: "call count before baseline compilation",
    apply: (config, value) =>
      (config.baselineThreshold = parseCount("baseline-threshold", value)),
  },
  {
    name: "max-deopt",
    value: "n",
    group: "Optimization",
    summary: "deopts tolerated before optimization is disabled",
    apply: (config, value) => (config.maxDeopt = parseCount("max-deopt", value)),
  },
  {
    name: "no-osr",
    group: "Optimization",
    summary: "disable on-stack replacement",
    apply: (config) => (config.osr = false),
  },
  {
    name: "allow-natives-syntax",
    group: "Optimization",
    summary: "expose OptimizeFunctionOnNextCall and friends",
    apply: (config) => (config.allowNatives = true),
  },
  {
    name: "expose-gc",
    group: "Optimization",
    summary: "expose a global gc() function",
    apply: (config) => (config.exposeGc = true),
  },
  TYPECHECK_FLAG,
];

const INPUT_FLAGS: readonly FlagSpec<SourceInputs>[] = [
  {
    name: "eval",
    short: "e",
    value: "source",
    group: "Input",
    summary: "run source passed on the command line",
    apply: (config, value) => (config.eval = value),
  },
];

function acceptSource(config: SourceInputs, token: string): void {
  if (token === STDIN_TOKEN) {
    config.readStdin = true;
    return;
  }
  config.files.push(token);
}

function acceptSingleFile(name: string) {
  return (config: { files: string[] }, token: string): void => {
    if (config.files.length > 0) {
      throw new CliUsageError(`${name} takes exactly one input file`);
    }
    config.files.push(token);
  };
}

function rejectArguments(name: string) {
  return (_config: unknown, token: string): never => {
    throw new CliUsageError(`${name} takes no arguments, got '${token}'`);
  };
}

export const RUN_COMMAND: CommandSpec<RunConfig> = {
  name: "run",
  summary: "run a program (the default when a file is given)",
  arguments: "[file ...]",
  flags: [...INPUT_FLAGS, ...ENGINE_FLAGS],
  defaults: () => ({ command: "run", ...engineDefaults(), ...sourceDefaults() }),
  accept: acceptSource,
};

export const CHECK_COMMAND: CommandSpec<CheckConfig> = {
  name: "check",
  summary: "type-check a program without running it",
  arguments: "<file ...>",
  flags: [
    ...INPUT_FLAGS,
    {
      name: "module-path",
      value: "dir",
      group: "Input",
      summary: "add a directory to the module search path (repeatable)",
      apply: (config: CheckConfig, value: string) => config.modulePaths.push(value),
    },
  ],
  defaults: () => ({ command: "check", ...sourceDefaults(), modulePaths: [] }),
  accept: acceptSource,
};

export const REPL_COMMAND: CommandSpec<EngineFlags & { command: "repl" }> = {
  name: "repl",
  summary: "start the interactive session (the default with no input)",
  arguments: "",
  flags: ENGINE_FLAGS,
  defaults: () => ({ command: "repl", ...engineDefaults() }),
  accept: rejectArguments("repl"),
};

export const DEBUG_COMMAND: CommandSpec<DebugConfig> = {
  name: "debug",
  summary: "run a program under the stepping debugger",
  arguments: "<file>",
  flags: ENGINE_FLAGS,
  defaults: () => ({ command: "debug", files: [], ...engineDefaults() }),
  accept: acceptSingleFile("debug"),
};

const EMIT_KINDS: readonly EmitKind[] = ["exe", "obj", "source"];
const LINK_MODES: readonly LinkMode[] = ["auto", "cc", "none"];
const RESULT_MODES: readonly ResultMode[] = ["print", "exit"];

export const COMPILE_COMMAND: CommandSpec<CompileConfig> = {
  name: "compile",
  summary: "compile a program ahead of time",
  arguments: "<file>",
  flags: [
    {
      name: "output",
      short: "o",
      value: "path",
      group: "Output",
      summary: "where to write the artifact (default: beside the input)",
      apply: (config, value) => (config.output = value),
    },
    {
      name: "target",
      value: "arch",
      group: "Output",
      summary: "architecture to build for (default: this machine)",
      apply: (config, value) => (config.target = value),
    },
    {
      name: "platform",
      value: "os",
      group: "Output",
      summary: "operating system to build for (default: this machine)",
      apply: (config, value) => (config.platform = value),
    },
    {
      name: "emit",
      value: EMIT_KINDS.join("|"),
      group: "Output",
      summary: "artifact to produce (default: exe)",
      apply: (config, value) => (config.emit = parseChoice("emit", value, EMIT_KINDS)),
    },
    {
      name: "link",
      value: LINK_MODES.join("|"),
      group: "Output",
      summary: "how to reach an executable (default: auto)",
      apply: (config, value) => (config.link = parseChoice("link", value, LINK_MODES)),
    },
    {
      name: "result",
      value: RESULT_MODES.join("|"),
      group: "Output",
      summary: "deliver the entry result on stdout or as the exit status (default: by its type)",
      apply: (config, value) => (config.result = parseChoice("result", value, RESULT_MODES)),
    },
    {
      name: "entry",
      value: "name",
      group: "Output",
      summary: "entry function to call (default: the top level of the file)",
      apply: (config, value) => (config.entry = value),
    },
    {
      name: "heap-size",
      value: "bytes",
      group: "Output",
      summary: "address space to reserve for the heap (default: 1g)",
      apply: (config, value) => (config.heapBytes = parseBytes("heap-size", value)),
    },
    {
      name: "cc",
      value: "path",
      group: "Output",
      summary: "C compiler to use when linking through a toolchain",
      apply: (config, value) => (config.cc = value),
    },
    {
      name: "keep-temps",
      group: "Output",
      summary: "keep the generated intermediates",
      apply: (config) => (config.keepTemps = true),
    },
    TYPECHECK_FLAG,
    {
      name: "module-path",
      value: "dir",
      group: "Input",
      summary: "add a directory to the module search path (repeatable)",
      apply: (config: CompileConfig, value: string) => config.modulePaths.push(value),
    },
  ],
  defaults: () => ({
    command: "compile",
    files: [],
    output: null,
    entry: null,
    target: null,
    platform: null,
    emit: "exe",
    link: "auto",
    result: null,
    cc: null,
    heapBytes: null,
    keepTemps: false,
    typecheck: null,
    modulePaths: [],
  }),
  accept: acceptSingleFile("compile"),
};

export const TARGETS_COMMAND: CommandSpec<TargetsConfig> = {
  name: "targets",
  summary: "list the code generators this build can use",
  arguments: "",
  flags: [],
  defaults: () => ({ command: "targets" }),
  accept: rejectArguments("targets"),
};

export const HELP_COMMAND: CommandSpec<HelpConfig> = {
  name: "help",
  summary: "show help for tera or for one command",
  arguments: "[command]",
  flags: [],
  defaults: () => ({ command: "help", topic: null }),
  accept: (config, token) => (config.topic = token),
};

export const VERSION_COMMAND: CommandSpec<{ command: "version" }> = {
  name: "version",
  summary: "show the version",
  arguments: "",
  flags: [],
  defaults: () => ({ command: "version" }),
  accept: rejectArguments("version"),
};

export const COMMANDS: readonly CommandSpec<CliConfig>[] = [
  RUN_COMMAND,
  REPL_COMMAND,
  CHECK_COMMAND,
  DEBUG_COMMAND,
  COMPILE_COMMAND,
  TARGETS_COMMAND,
  HELP_COMMAND,
  VERSION_COMMAND,
];

export function commandNamed(name: string): CommandSpec<CliConfig> | undefined {
  return COMMANDS.find((command) => command.name === name);
}
