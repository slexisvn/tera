import {
  irLoadField,
  irLoadText,
  irRuntimeBase,
  irStoreField,
  irStoreText,
  IR_LOAD_GLOBAL,
  IR_STORE_GLOBAL,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  FIELD_SCALAR_PROP,
  FIELD_TYPE_PROP,
  type ClassTable,
  type GlobalVariable,
} from "../metadata/class-table.js";
import { carryValueClass } from "./class-member-lowering.js";
import { TERA_STATICS } from "../target/runtime-layout.js";
import { scalarWidth, SCALAR_TEXT } from "../types/scalar.js";

type Access = {
  readonly node: CFGInstruction;
  readonly variable: GlobalVariable;
};

function accessesIn(graph: CFGFunction, classes: ClassTable): readonly Access[] {
  const accesses: Access[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_LOAD_GLOBAL && node.type !== IR_STORE_GLOBAL) continue;
      const name = node.props.name;
      if (typeof name !== "string") continue;
      const variable = classes.globalOf(name);
      if (variable === null) continue;
      if (node.type === IR_LOAD_GLOBAL && node.uses.length === 0) continue;
      accesses.push({ node, variable });
    }
  }
  return accesses;
}

function accessNode(
  node: CFGInstruction,
  base: CFGInstruction,
  variable: GlobalVariable,
): CFGInstruction {
  const loads = node.type === IR_LOAD_GLOBAL;
  if (variable.scalar === SCALAR_TEXT) {
    const capacity = scalarWidth(SCALAR_TEXT);
    return loads
      ? irLoadText(base, variable.offset, capacity, variable.name)
      : irStoreText(base, variable.offset, node.inputs[0]!, capacity, variable.name);
  }
  return loads
    ? irLoadField(base, variable.offset)
    : irStoreField(base, variable.offset, node.inputs[0]!, variable.name);
}

export function lowerGlobalVariables(graph: CFGFunction): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const accesses = accessesIn(graph, classes);
  if (accesses.length === 0) return 0;

  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  for (const { node, variable } of accesses) {
    const base = stamp(irRuntimeBase(TERA_STATICS.symbol));
    editor.insertBefore(node, base);
    const replacement = stamp(accessNode(node, base, variable));
    replacement.props[FIELD_TYPE_PROP] = variable.declaredType;
    replacement.props[FIELD_SCALAR_PROP] = variable.scalar;
    replacement.frameState = node.frameState;
    if (node.type === IR_LOAD_GLOBAL) {
      carryValueClass(replacement, variable.declaredType, classes);
    }
    editor.insertBefore(node, replacement);
    editor.replaceAllUses(node, replacement);
    editor.remove(node);
  }
  graph.rebuildUses();
  return accesses.length;
}
