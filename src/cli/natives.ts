import type { Engine } from "../api/engine.js";
import type { TeraExtension } from "../api/extensions.js";
import type { RegisterCompiledFunction } from "../bytecode/register/ops/bytecode.js";
import type { RuntimeFunctionPayload, TaggedValue } from "../core/value/index.js";
import { getPayload, mkBool, mkNumber, mkUndefined } from "../core/value/index.js";

const STATUS_INTERPRETED = 1;
const STATUS_BASELINE = 2;
const STATUS_OPTIMIZED = 4;
const STATUS_TIERING_DISABLED = 8;

type NativeContext = { jitEngine: Engine | null };

function engineOf(interpreter: object | undefined): Engine {
  const engine = (interpreter as NativeContext | undefined)?.jitEngine ?? null;
  if (!engine) throw new Error("Native intrinsic requires an engine context");
  return engine;
}

function compiledOf(value: TaggedValue | undefined): RegisterCompiledFunction | null {
  if (value === undefined) return null;
  const payload = getPayload(value) as { compiled?: RegisterCompiledFunction | null };
  return payload && typeof payload === "object" ? payload.compiled ?? null : null;
}

function optimizationStatus(compiled: RegisterCompiledFunction): number {
  let bits = compiled.optimizedCode
    ? STATUS_OPTIMIZED
    : compiled.baselineCode
      ? STATUS_BASELINE
      : STATUS_INTERPRETED;
  if (compiled.disableOptimization) bits |= STATUS_TIERING_DISABLED;
  return bits;
}

const NATIVES: RuntimeFunctionPayload[] = [
  {
    name: "OptimizeFunctionOnNextCall",
    call: (args, _thisValue, interpreter) => {
      const compiled = compiledOf(args[0]);
      if (compiled && !compiled.disableOptimization) {
        engineOf(interpreter).optimizeFunction(compiled);
      }
      return mkUndefined();
    },
  },
  {
    name: "DeoptimizeFunction",
    call: (args, _thisValue, interpreter) => {
      const compiled = compiledOf(args[0]);
      if (compiled) engineOf(interpreter).deoptimizeFunction(compiled);
      return mkUndefined();
    },
  },
  {
    name: "NeverOptimizeFunction",
    call: (args, _thisValue, interpreter) => {
      const compiled = compiledOf(args[0]);
      if (compiled) {
        engineOf(interpreter).deoptimizeFunction(compiled);
        compiled.disableOptimization = true;
      }
      return mkUndefined();
    },
  },
  {
    name: "GetOptimizationStatus",
    call: (args) => {
      const compiled = compiledOf(args[0]);
      return mkNumber(compiled ? optimizationStatus(compiled) : 0);
    },
  },
  {
    name: "IsOptimized",
    call: (args) => {
      const compiled = compiledOf(args[0]);
      return mkBool(compiled !== null && compiled.optimizedCode !== null);
    },
  },
  {
    name: "CollectGarbage",
    call: (args, _thisValue, interpreter) => {
      engineOf(interpreter).collectGarbage(args[0] !== undefined ? "major" : "minor");
      return mkUndefined();
    },
  },
];

function intrinsicNames(): TeraExtension {
  return {
    name: "tera/natives",
    runtimeBuiltins: Object.fromEntries(NATIVES.map((native) => [native.name!, native])),
    compiler: {
      intrinsics: NATIVES.map((native) => ({
        name: native.name!,
        lowering: "runtime" as const,
      })),
    },
  };
}

export function nativesExtension(): TeraExtension {
  return intrinsicNames();
}

export function exposeGcExtension(): TeraExtension {
  return {
    name: "tera/expose-gc",
    runtimeBuiltins: {
      gc: {
        name: "gc",
        call: (args, _thisValue, interpreter) => {
          engineOf(interpreter).collectGarbage(args[0] !== undefined ? "major" : "minor");
          return mkUndefined();
        },
      },
    },
  };
}
