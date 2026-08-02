import type { TeraCompilerEffect, TeraCompilerExtension, TeraIntrinsicSpec } from "../../api/extensions.js";
import * as ir from "../ir/index.js";

export type IntrinsicOptimizationMetadata = {
  intrinsics: ReadonlyMap<string, TeraIntrinsicSpec>;
};

const EMPTY_INTRINSIC_METADATA: IntrinsicOptimizationMetadata = {
  intrinsics: new Map(),
};

export function createIntrinsicOptimizationMetadata(compiler?: Pick<Required<TeraCompilerExtension>, "intrinsics"> | null): IntrinsicOptimizationMetadata {
  if (!compiler || compiler.intrinsics.length === 0) return EMPTY_INTRINSIC_METADATA;
  return {
    intrinsics: new Map(compiler.intrinsics.map((intrinsic) => [intrinsic.name, intrinsic])),
  };
}

export function intrinsicCallMetadata(name: string, argCount: number, metadata: IntrinsicOptimizationMetadata = EMPTY_INTRINSIC_METADATA): ir.IRMetadata {
  const intrinsic = metadata.intrinsics.get(name);
  const effects = intrinsic?.effects ?? ["unknown"];
  const effectKind = effectKindForEffects(effects);
  const props: ir.IRMetadata = {
    name,
    argCount,
    intrinsic: true,
    effectKind,
  };
  if (effectKind === ir.EFFECT_NONE || effectKind === ir.EFFECT_READ) props.pure = true;
  if (effectKind === ir.EFFECT_READ) props.readonly = true;
  if (intrinsic) {
    props.intrinsicEffects = [...effects];
    if (intrinsic.reads?.length) props.intrinsicReads = [...intrinsic.reads];
    if (intrinsic.writes?.length) props.intrinsicWrites = [...intrinsic.writes];
    if (intrinsic.allocates?.length) props.intrinsicAllocates = [...intrinsic.allocates];
    if (intrinsic.guards?.length) props.guards = [...intrinsic.guards];
    if (intrinsic.deopts?.length) props.deopts = [...intrinsic.deopts];
    if (intrinsic.fallback) props.fallback = intrinsic.fallback;
    if (intrinsic.returns) props.returns = intrinsic.returns;
  }
  return props;
}

function effectKindForEffects(effects: readonly TeraCompilerEffect[]): ir.EffectKind {
  const set = new Set(effects);
  if (set.has("unknown") || set.has("io")) return ir.EFFECT_CALL;
  if (set.has("write") || set.has("reactive-write") || set.has("schedule")) return ir.EFFECT_WRITE;
  if (set.has("allocate")) return ir.EFFECT_ALLOC;
  if (set.has("reactive-read")) return ir.EFFECT_CALL;
  if (set.has("read")) return ir.EFFECT_READ;
  if (set.has("pure")) return ir.EFFECT_NONE;
  return ir.EFFECT_CALL;
}
