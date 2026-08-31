export type OptMode = "default" | "none" | "always";
export type TypecheckMode = "off" | "warn" | "strict";
export type EmitKind = "exe" | "obj" | "source";
export type LinkMode = "auto" | "cc" | "none";
export type ResultMode = "print" | "exit";

export interface EngineFlags {
  typecheck: TypecheckMode | null;
  optMode: OptMode;
  jitThreshold: number | null;
  baselineThreshold: number | null;
  maxDeopt: number | null;
  osr: boolean;
  exposeGc: boolean;
  allowNatives: boolean;
  printBytecode: boolean;
  printAst: boolean;
  printIr: boolean;
  filter: string | null;
  traceCategories: string[];
  stats: boolean;
  modulePaths: string[];
  printModuleGraph: boolean;
}

export interface SourceInputs {
  files: string[];
  eval: string | null;
  readStdin: boolean;
}

export interface RunConfig extends EngineFlags, SourceInputs {
  readonly command: "run";
}

export interface ReplConfig extends EngineFlags {
  readonly command: "repl";
}

export interface CheckConfig extends SourceInputs {
  modulePaths: string[];
  readonly command: "check";
}

export interface DebugConfig extends EngineFlags {
  readonly command: "debug";
  files: string[];
}

export interface CompileConfig {
  readonly command: "compile";
  files: string[];
  output: string | null;
  entry: string | null;
  target: string | null;
  platform: string | null;
  emit: EmitKind;
  link: LinkMode;
  result: ResultMode | null;
  cc: string | null;
  heapBytes: number | null;
  textBytes: number | null;
  keepTemps: boolean;
  verify: boolean;
  printAfterAll: boolean;
  modulePaths: string[];
}

export interface TargetsConfig {
  readonly command: "targets";
}

export interface HelpConfig {
  readonly command: "help";
  topic: string | null;
}

export interface VersionConfig {
  readonly command: "version";
}

export type CliConfig =
  | RunConfig
  | ReplConfig
  | CheckConfig
  | DebugConfig
  | CompileConfig
  | TargetsConfig
  | HelpConfig
  | VersionConfig;

export function engineDefaults(): EngineFlags {
  return {
    typecheck: null,
    optMode: "default",
    jitThreshold: null,
    baselineThreshold: null,
    maxDeopt: null,
    osr: true,
    exposeGc: false,
    allowNatives: false,
    printBytecode: false,
    printAst: false,
    printIr: false,
    filter: null,
    traceCategories: [],
    stats: false,
    modulePaths: [],
    printModuleGraph: false,
  };
}

export function sourceDefaults(): SourceInputs {
  return { files: [], eval: null, readStdin: false };
}
