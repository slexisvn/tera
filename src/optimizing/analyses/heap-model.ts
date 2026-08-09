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
  if (node.type === ir.IR_LOAD_FIELD || node.type === ir.IR_STORE_FIELD) {
    return typeof node.props.offset === "number"
      ? { kind: "slot", offset: node.props.offset }
      : null;
  }
  if (
    node.type === ir.IR_LOAD_ELEMENT ||
    node.type === ir.IR_STORE_ELEMENT
  ) {
    const index = node.inputs[1];
    if (index?.type === ir.IR_CONSTANT && typeof index.props.value === "number") {
      return { kind: "index", value: index.props.value };
    }
    return { kind: "anyIndex" };
  }
  if (
    node.type === ir.IR_GENERIC_GET_PROP ||
    node.type === ir.IR_GENERIC_SET_PROP ||
    node.type === ir.IR_GENERIC_GET_INDEX ||
    node.type === ir.IR_GENERIC_SET_INDEX
  ) {
    return { kind: "any" };
  }
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
