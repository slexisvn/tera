import {
  irConstant,
  irNewArray,
  namespaceCallArguments,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import type { ClassShape, ClassTable } from "../metadata/class-table.js";
import {
  constructedShape,
  constructedShapeOf,
  fieldLoadNode,
} from "./class-member-lowering.js";
import { TypeKind } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";

const OBJECT_NAMESPACE = "Object";
const KEYS_MEMBER = "keys";
const VALUES_MEMBER = "values";
const ONE_SUBJECT = 1;

type Stamp = (node: CFGInstruction) => CFGInstruction;

function namespaceCall(node: CFGInstruction, member: string): CFGInstruction | null {
  const args = namespaceCallArguments(node, OBJECT_NAMESPACE, member);
  return args?.length === ONE_SUBJECT ? args[0]! : null;
}

function shapeOf(
  subject: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  const type = types.typeOf(subject);
  const named =
    type.kind === TypeKind.Object && typeof type.map === "number"
      ? classes.shapeById(type.map)
      : constructedShapeOf(subject, classes) ?? constructedShape(subject, classes);
  if (named === null || named.parent !== null || named.unsupported.length > 0) return null;
  return named;
}

function ownNames(shape: ClassShape): readonly string[] {
  return [...shape.fields.keys()];
}

function ownFields(shape: ClassShape) {
  return [...shape.fields.values()];
}

function spelledKeys(
  editor: GraphEditor,
  node: CFGInstruction,
  shape: ClassShape,
  stamp: Stamp,
): CFGInstruction {
  const names = ownNames(shape).map((name) => {
    const spelled = stamp(irConstant(name));
    editor.insertBefore(node, spelled);
    return spelled;
  });
  const array = stamp(irNewArray(names));
  array.frameState = node.frameState;
  editor.insertBefore(node, array);
  return array;
}

function readValues(
  editor: GraphEditor,
  node: CFGInstruction,
  subject: CFGInstruction,
  shape: ClassShape,
  classes: ClassTable,
  stamp: Stamp,
): CFGInstruction {
  const reads = ownFields(shape).map((field) => {
    const read = stamp(fieldLoadNode(subject, field, classes));
    read.frameState = node.frameState;
    editor.insertBefore(node, read);
    return read;
  });
  const array = stamp(irNewArray(reads));
  array.frameState = node.frameState;
  editor.insertBefore(node, array);
  return array;
}

export function lowerObjectSurface(graph: CFGFunction, types: TypeInference): number {
  const classes = graph.classes;
  if (classes === null) return 0;
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let lowered = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const keyed = namespaceCall(node, KEYS_MEMBER);
      const valued = keyed === null ? namespaceCall(node, VALUES_MEMBER) : null;
      const subject = keyed ?? valued;
      if (subject === null) continue;
      const shape = shapeOf(subject, classes, types);
      if (shape === null || shape.fields.size === 0) continue;
      const replacement =
        keyed === null
          ? readValues(editor, node, subject, shape, classes, stamp)
          : spelledKeys(editor, node, shape, stamp);
      editor.replaceAllUses(node, replacement);
      editor.remove(node);
      lowered += 1;
    }
  }
  if (lowered > 0) graph.rebuildUses();
  return lowered;
}
