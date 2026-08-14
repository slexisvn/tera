import { TERA_BUILTINS, TERA_CHART_METHODS } from "../../../data/tera-language-spec.js";
import { chartMetadataFromSpec, runtimeBuiltinMetadataFromSpec } from "../../utils/language-spec-runtime.js";
import { installChartBuiltins } from "./chart-builtins.js";
import { register, type BuiltinMap } from "./common.js";
import { installDataFrameBuiltins } from "./dataframe-builtins.js";
import { installMlBuiltins } from "./ml-builtins.js";
import { createModelBuiltins } from "./model-builtins.js";
import { installNumericBuiltins } from "./numeric-builtins.js";
import { installQuantBuiltins } from "./quant-builtins.js";
import { installTensorBuiltins } from "./tensor-builtins.js";

const domainBuiltins = runtimeBuiltinMetadataFromSpec(TERA_BUILTINS);
const chartBuiltins = chartMetadataFromSpec(TERA_CHART_METHODS);

function installCoreBuiltins(map: BuiltinMap): void {
  register(map, "range", (...args) => {
    const start = args.length === 1 ? 0 : Number(args[0] ?? 0);
    const stop = Number(args.length === 1 ? args[0] : args[1]);
    const step = Number(args[2] ?? 1);
    if (step === 0) throw new Error("range() step cannot be zero");
    const out: number[] = [];
    if (step > 0) for (let value = start; value < stop; value += step) out.push(value);
    else for (let value = start; value > stop; value += step) out.push(value);
    return out;
  }, domainBuiltins.range);
}

export function createDomainBuiltins(): BuiltinMap {
  const map: BuiltinMap = { ...createModelBuiltins() };
  installTensorBuiltins(map, domainBuiltins);
  installDataFrameBuiltins(map, domainBuiltins);
  installMlBuiltins(map, domainBuiltins);
  installNumericBuiltins(map, domainBuiltins);
  installQuantBuiltins(map, domainBuiltins);
  installChartBuiltins(map, chartBuiltins);
  installCoreBuiltins(map);
  return map;
}
