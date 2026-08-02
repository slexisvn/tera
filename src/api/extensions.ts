import type { BuiltinRegistryMap } from "../runtime/builtins/index.js";
import type { BindOptions, ExternalBuiltinSignature, ExternalInterface, ExternalTypeAlias } from "../frontend/checker/index.js";
import type { SyntaxPlugin } from "../frontend/parser/extensions.js";

export type NativeHostBuiltin = (...args: unknown[]) => unknown;
export type NativeHostBuiltinRegistry = Record<string, NativeHostBuiltin>;
export type TeraCompilerPhase = "ast" | "semantic" | "bytecode" | "ir";
export type TeraCompilerEffect = "pure" | "read" | "write" | "io" | "reactive-read" | "reactive-write" | "schedule" | "allocate" | "unknown";
export type TeraGuardKind = "type" | "shape" | "brand" | "bounds" | "effect" | "intrinsic" | "custom";
export type TeraDeoptSpec = {
  name: string;
  reason: string;
  phase?: TeraCompilerPhase;
  fallback?: string;
  recoverable?: boolean;
  description?: string;
};
export type TeraGuardSpec = {
  name: string;
  kind: TeraGuardKind;
  target?: string;
  effects?: readonly TeraCompilerEffect[];
  deoptsTo?: string;
  description?: string;
};
export type TeraIntrinsicSpec = {
  name: string;
  phase?: TeraCompilerPhase;
  lowering?: "global" | "runtime";
  parameters?: readonly string[];
  returns?: string;
  effects?: readonly TeraCompilerEffect[];
  reads?: readonly string[];
  writes?: readonly string[];
  allocates?: readonly string[];
  guards?: readonly string[];
  deopts?: readonly string[];
  fallback?: string;
  description?: string;
};
export type TeraEffectMetadata = {
  name: string;
  purity?: "pure" | "readonly" | "impure";
  reads?: readonly string[];
  writes?: readonly string[];
  allocates?: readonly string[];
  effects?: readonly TeraCompilerEffect[];
  schedules?: boolean;
  async?: boolean;
  canThrow?: boolean;
  deopt?: "never" | "guarded" | "always";
  guards?: readonly string[];
  deopts?: readonly string[];
  description?: string;
};
export type TeraOptimizerPassContext = {
  phase: TeraCompilerPhase;
  intrinsics: readonly TeraIntrinsicSpec[];
  effects: readonly TeraEffectMetadata[];
  guards: readonly TeraGuardSpec[];
  deopts: readonly TeraDeoptSpec[];
};
export type TeraOptimizerPass = {
  name: string;
  phase: TeraCompilerPhase;
  order?: "early" | "normal" | "late";
  run(target: unknown, context: TeraOptimizerPassContext): unknown | void;
};
export type TeraCompilerExtension = {
  intrinsics?: readonly TeraIntrinsicSpec[];
  effects?: readonly TeraEffectMetadata[];
  guards?: readonly TeraGuardSpec[];
  deopts?: readonly TeraDeoptSpec[];
  optimizerPasses?: readonly TeraOptimizerPass[];
};

export type TeraExtension = {
  name: string;
  syntaxPlugins?: readonly SyntaxPlugin[];
  checker?: BindOptions;
  hostBuiltins?: NativeHostBuiltinRegistry;
  runtimeBuiltins?: BuiltinRegistryMap;
  compiler?: TeraCompilerExtension;
};

export type ResolvedTeraExtensions = {
  syntaxPlugins: SyntaxPlugin[];
  checker: BindOptions;
  hostBuiltins: NativeHostBuiltinRegistry;
  runtimeBuiltins: BuiltinRegistryMap;
  compiler: Required<TeraCompilerExtension>;
};

function assertExtensionName(name: string): void {
  if (!name || !/^[A-Za-z0-9_.@/-]+$/.test(name)) {
    throw new Error(`Invalid Tera extension name '${name}'`);
  }
}

export function mergeNamedExtensionItems<T extends { name: string }>(kind: string, ...sources: Array<readonly T[] | undefined>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const source of sources) {
    for (const value of source ?? []) {
      if (!value.name) throw new Error(`Unnamed ${kind}`);
      if (seen.has(value.name)) throw new Error(`Duplicate ${kind} '${value.name}'`);
      seen.add(value.name);
      out.push(value);
    }
  }
  return out;
}

export function mergeExtensionRecords<T>(kind: string, ...sources: Array<Record<string, T> | undefined>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (Object.prototype.hasOwnProperty.call(out, name)) throw new Error(`Duplicate ${kind} '${name}'`);
      out[name] = value;
    }
  }
  return out;
}

export function mergeCompilerExtensions(...sources: Array<TeraCompilerExtension | undefined>): Required<TeraCompilerExtension> {
  return {
    intrinsics: mergeNamedExtensionItems("compiler intrinsic", ...sources.map((source) => source?.intrinsics)),
    effects: mergeNamedExtensionItems("compiler effect metadata", ...sources.map((source) => source?.effects)),
    guards: mergeNamedExtensionItems("compiler guard", ...sources.map((source) => source?.guards)),
    deopts: mergeNamedExtensionItems("compiler deopt", ...sources.map((source) => source?.deopts)),
    optimizerPasses: mergeNamedExtensionItems("optimizer pass", ...sources.map((source) => source?.optimizerPasses)).sort(compareOptimizerPasses),
  };
}

export function resolveTeraExtensions(extensions: readonly TeraExtension[] = []): ResolvedTeraExtensions {
  const names = new Set<string>();
  const syntaxPlugins: SyntaxPlugin[] = [];
  const checkerBuiltins: ExternalBuiltinSignature[] = [];
  const checkerAliases: ExternalTypeAlias[] = [];
  const checkerInterfaces: ExternalInterface[] = [];
  const hostBuiltinRecords: NativeHostBuiltinRegistry[] = [];
  const runtimeBuiltinRecords: BuiltinRegistryMap[] = [];
  const intrinsics: TeraIntrinsicSpec[] = [];
  const effects: TeraEffectMetadata[] = [];
  const guards: TeraGuardSpec[] = [];
  const deopts: TeraDeoptSpec[] = [];
  const optimizerPasses: TeraOptimizerPass[] = [];

  for (const extension of extensions) {
    assertExtensionName(extension.name);
    if (names.has(extension.name)) throw new Error(`Duplicate Tera extension '${extension.name}'`);
    names.add(extension.name);
    syntaxPlugins.push(...(extension.syntaxPlugins ?? []));
    checkerBuiltins.push(...(extension.checker?.builtins ?? []));
    checkerAliases.push(...(extension.checker?.aliases ?? []));
    checkerInterfaces.push(...(extension.checker?.interfaces ?? []));
    if (extension.hostBuiltins) hostBuiltinRecords.push(extension.hostBuiltins);
    if (extension.runtimeBuiltins) runtimeBuiltinRecords.push(extension.runtimeBuiltins);
    intrinsics.push(...(extension.compiler?.intrinsics ?? []));
    effects.push(...(extension.compiler?.effects ?? []));
    guards.push(...(extension.compiler?.guards ?? []));
    deopts.push(...(extension.compiler?.deopts ?? []));
    optimizerPasses.push(...(extension.compiler?.optimizerPasses ?? []));
  }

  return {
    syntaxPlugins: mergeNamedExtensionItems("syntax plugin", syntaxPlugins),
    checker: {
      builtins: mergeNamedExtensionItems("checker builtin", checkerBuiltins),
      aliases: mergeNamedExtensionItems("checker alias", checkerAliases),
      interfaces: mergeNamedExtensionItems("checker interface", checkerInterfaces),
    },
    hostBuiltins: mergeExtensionRecords("host builtin", ...hostBuiltinRecords),
    runtimeBuiltins: mergeExtensionRecords("runtime builtin", ...runtimeBuiltinRecords),
    compiler: mergeCompilerExtensions({ intrinsics, effects, guards, deopts, optimizerPasses }),
  };
}

function compareOptimizerPasses(left: TeraOptimizerPass, right: TeraOptimizerPass): number {
  return orderRank(left.order) - orderRank(right.order);
}

function orderRank(order: TeraOptimizerPass["order"]): number {
  if (order === "early") return 0;
  if (order === "late") return 2;
  return 1;
}
