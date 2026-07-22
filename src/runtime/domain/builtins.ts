import { mkString } from "../../core/value/index.js";
import { installChartBuiltins } from "./chart-builtins.js";
import { register, type BuiltinMap } from "./common.js";
import { DEVICE_NAMES, DTYPE_NAMES } from "./metadata.js";
import { installDataFrameBuiltins } from "./dataframe-builtins.js";
import { installMlBuiltins } from "./ml-builtins.js";
import { createModelBuiltins } from "./model-builtins.js";
import { installNumericBuiltins } from "./numeric-builtins.js";
import { installQuantBuiltins } from "./quant-builtins.js";
import { installTensorBuiltins } from "./tensor-builtins.js";
import { CHART_METADATA, DOMAIN_BUILTIN_METADATA } from "./metadata.js";

const DOMAIN_CONSTANTS = [...DEVICE_NAMES, ...DTYPE_NAMES];

function installCoreBuiltins(map: BuiltinMap): void {
  for (const name of DOMAIN_CONSTANTS) {
    map[name] = { name, metadata: DOMAIN_BUILTIN_METADATA[name], globalConst: () => mkString(name) };
  }
  register(map, "range", (...args) => {
    const start = args.length === 1 ? 0 : Number(args[0] ?? 0);
    const stop = Number(args.length === 1 ? args[0] : args[1]);
    const step = Number(args[2] ?? 1);
    if (step === 0) throw new Error("range() step cannot be zero");
    const out: number[] = [];
    if (step > 0) for (let value = start; value < stop; value += step) out.push(value);
    else for (let value = start; value > stop; value += step) out.push(value);
    return out;
  }, DOMAIN_BUILTIN_METADATA.range);
}

export function createDomainBuiltins(): BuiltinMap {
  const map: BuiltinMap = { ...createModelBuiltins() };
  installTensorBuiltins(map, DOMAIN_BUILTIN_METADATA);
  installDataFrameBuiltins(map, DOMAIN_BUILTIN_METADATA);
  installMlBuiltins(map, DOMAIN_BUILTIN_METADATA);
  installNumericBuiltins(map, DOMAIN_BUILTIN_METADATA);
  installQuantBuiltins(map, DOMAIN_BUILTIN_METADATA);
  installChartBuiltins(map, CHART_METADATA);
  installCoreBuiltins(map);
  return map;
}
