import type { RuntimeFunctionMetadata, RuntimeFunctionPayload } from "../../core/value/index.js";
import { hostBuiltin } from "./host.js";
import { splitOptions } from "./common.js";
import { createChartSpec } from "./chart/api.js";

type BuiltinMap = Record<string, RuntimeFunctionPayload>;

export function installChartBuiltins(map: BuiltinMap, metadata: Record<string, RuntimeFunctionMetadata>): void {
  const chart: Record<string, RuntimeFunctionPayload> = {};
  for (const type of Object.keys(metadata)) {
    chart[type] = hostBuiltin(type, (data: unknown, ...args: unknown[]) => createChartSpec(type, data, splitOptions(args).options), metadata[type]);
  }
  (map as Record<string, unknown>).chart = chart;
}
