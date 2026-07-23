import type { RuntimeFunctionMetadata, RuntimeFunctionParameterMetadata } from "../core/value/index.js";
import type { TeraBuiltinSpec, TeraChartMethodSpec, TeraParam } from "../../data/tera-language-spec.js";

function runtimeParam(param: TeraParam): RuntimeFunctionParameterMetadata {
  const out: RuntimeFunctionParameterMetadata = { name: param.name };
  if (param.type) out.type = param.type;
  if (param.optional) out.optional = true;
  if (param.defaultValue !== undefined && param.defaultValue !== null) out.defaultValue = param.defaultValue;
  if (param.rest) out.rest = true;
  if (param.named) out.named = true;
  return out;
}

function runtimeMetadata(name: string, spec: TeraBuiltinSpec | TeraChartMethodSpec): RuntimeFunctionMetadata {
  const out: RuntimeFunctionMetadata = { name };
  if (spec.params) out.params = spec.params.map(runtimeParam);
  if (spec.returns) out.returns = spec.returns;
  if (spec.kind && spec.kind !== "method of chart") out.kind = spec.kind as RuntimeFunctionMetadata["kind"];
  if (spec.effect) out.effect = spec.effect;
  if ("callConvention" in spec && spec.callConvention) out.callConvention = spec.callConvention;
  return out;
}

export function runtimeBuiltinMetadataFromSpec(spec: Record<string, TeraBuiltinSpec>): Record<string, RuntimeFunctionMetadata> {
  return Object.fromEntries(
    Object.entries(spec)
      .filter(([, entry]) => !!entry.returns)
      .map(([name, entry]) => [name, runtimeMetadata(name, entry)]),
  );
}

export function chartMetadataFromSpec(spec: Record<string, TeraChartMethodSpec>): Record<string, RuntimeFunctionMetadata> {
  return Object.fromEntries(
    Object.entries(spec).map(([name, entry]) => [
      name,
      { ...runtimeMetadata(name, entry), kind: "chart" as RuntimeFunctionMetadata["kind"] },
    ]),
  );
}
