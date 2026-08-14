import * as ir from "../ir/index.js";

export type Partition =
  | { readonly kind: "alloc"; readonly site: number }
  | { readonly kind: "shape"; readonly mapId: number }
  | { readonly kind: "global"; readonly name: string }
  | { readonly kind: "any" };

export type Field =
  | { readonly kind: "slot"; readonly offset: number }
  | { readonly kind: "index"; readonly value: number }
  | { readonly kind: "anyIndex" }
  | { readonly kind: "any" };

export function partitionKey(partition: Partition): string {
  if (partition.kind === "alloc") return `alloc:${partition.site}`;
  if (partition.kind === "shape") return `shape:${partition.mapId}`;
  if (partition.kind === "global") return `global:${partition.name}`;
  return "any";
}

export function fieldKey(field: Field): string {
  if (field.kind === "slot") return `slot:${field.offset}`;
  if (field.kind === "index") return `index:${field.value}`;
  if (field.kind === "any") return "any";
  return "anyIndex";
}

export function locationKey(partition: Partition, field: Field): string {
  return `${partitionKey(partition)}|${fieldKey(field)}`;
}

export function fieldOf(node: ir.CFGInstruction): Field | null {
  const access = ir.memoryAccessOf(node.type);
  if (access === ir.ACCESS_SLOT) {
    return typeof node.props.offset === "number"
      ? { kind: "slot", offset: node.props.offset }
      : null;
  }
  if (access === ir.ACCESS_ELEMENT) {
    const index = node.inputs[1];
    if (index?.type === ir.IR_CONSTANT && typeof index.props.value === "number") {
      return { kind: "index", value: index.props.value };
    }
    return { kind: "anyIndex" };
  }
  if (access === ir.ACCESS_PROPERTY) return { kind: "any" };
  if (access === ir.ACCESS_GLOBAL) return { kind: "anyIndex" };
  return null;
}

export function fieldsOverlap(left: Field, right: Field): boolean {
  if (left.kind === "any" || right.kind === "any") return true;
  if (left.kind === "slot" || right.kind === "slot") {
    return left.kind === "slot" && right.kind === "slot" && left.offset === right.offset;
  }
  if (left.kind === "anyIndex" || right.kind === "anyIndex") return true;
  return left.value === right.value;
}

export type MemoryLocation = {
  readonly key: string;
  readonly baseKey: string;
  readonly base: ir.CFGInstruction | null;
  readonly partition: Partition;
  readonly field: Field;
};

type PartitionResolver = { partitionOf(value: ir.CFGInstruction): Partition };
type AliasResolver = PartitionResolver & {
  mayAlias(a: ir.CFGInstruction, b: ir.CFGInstruction): boolean;
};

function locationOf(
  base: ir.CFGInstruction | null,
  partition: Partition,
  field: Field,
): MemoryLocation {
  return {
    key: locationKey(partition, field),
    baseKey: partitionKey(partition),
    base,
    partition,
    field,
  };
}

export function memoryLocationOf(
  node: ir.CFGInstruction,
  partitions: PartitionResolver,
): MemoryLocation | null {
  const field = fieldOf(node);
  if (!field) return null;
  if (ir.memoryAccessOf(node.type) === ir.ACCESS_GLOBAL) {
    if (typeof node.props.name !== "string") return null;
    return locationOf(null, { kind: "global", name: node.props.name }, field);
  }
  const base = node.inputs[0];
  if (!base) return null;
  return locationOf(base, partitions.partitionOf(base), field);
}

export function basesMayAlias(
  left: Pick<MemoryLocation, "base" | "baseKey">,
  right: Pick<MemoryLocation, "base" | "baseKey">,
  aliases: AliasResolver,
): boolean {
  if (left.base === null || right.base === null) return left.baseKey === right.baseKey;
  return aliases.mayAlias(left.base, right.base);
}

export function locationsMayAlias(
  left: MemoryLocation,
  right: MemoryLocation,
  aliases: AliasResolver,
): boolean {
  if (!fieldsOverlap(left.field, right.field)) return false;
  return basesMayAlias(left, right, aliases);
}
