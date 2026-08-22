import {
  irBranch,
  irConstant,
  irInt32Compare,
  irJump,
  IR_GENERIC_INSTANCEOF,
  IR_TYPEOF,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { addPhi, connect, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { globalNameOf } from "./global-promotion.js";
import { shapeIdOfReceiver } from "./class-member-lowering.js";
import {
  declaredTypeOf,
  descendsFrom,
  type ClassShape,
  type ClassTable,
} from "../metadata/class-table.js";
import { typeofName } from "../types/lattice.js";
import type { TypeInference } from "../analyses/type-inference.js";

type Stamp = (node: CFGInstruction) => CFGInstruction;

const SUBJECT = 0;
const CONSTRUCTOR = 1;

function namedClass(value: CFGInstruction | undefined, classes: ClassTable): ClassShape | null {
  if (value === undefined) return null;
  const name = globalNameOf(value) ?? (typeof value.props.value === "string" ? value.props.value : null);
  return name === null ? null : classes.shapeOf(name);
}

function staticShape(
  value: CFGInstruction | undefined,
  classes: ClassTable,
  types: TypeInference,
): ClassShape | null {
  if (value === undefined) return null;
  const declared = declaredTypeOf(types.typeOf(value), classes);
  return declared === null ? null : classes.shapeOf(declared);
}

function matchingIds(subject: ClassShape, target: ClassShape, classes: ClassTable): number[] {
  return classes
    .dispatchConeOf(subject.name)
    .filter((shape) => descendsFrom(classes, shape, target.name))
    .map((shape) => shape.id);
}

function answerBlock(
  graph: CFGFunction,
  after: CFGBlock,
  value: boolean,
  stamp: Stamp,
): CFGBlock {
  const block = graph.addBlock();
  const constant = stamp(irConstant(value));
  block.addNode(constant);
  block.addNode(stamp(irJump(after)));
  connect(block, after, [constant]);
  return block;
}

function selectBoolean(
  graph: CFGFunction,
  node: CFGInstruction,
  subject: CFGInstruction,
  shape: ClassShape,
  ids: readonly number[],
  stamp: Stamp,
): CFGInstruction {
  const entry = node.block!;
  const after = splitBlockBefore(graph, entry, node);
  const answer = stamp(addPhi(after, []));
  const whenMatched = answerBlock(graph, after, true, stamp);
  const whenNot = answerBlock(graph, after, false, stamp);

  const shapeId = shapeIdOfReceiver(subject, shape, stamp);
  entry.addNode(shapeId);
  let current = entry;
  ids.forEach((id, at) => {
    const expected = stamp(irConstant(id));
    current.addNode(expected);
    const test = stamp(irInt32Compare("==", shapeId, expected));
    current.addNode(test);
    const otherwise = at === ids.length - 1 ? whenNot : graph.addBlock();
    current.addNode(stamp(irBranch(test, whenMatched, otherwise)));
    link(current, whenMatched);
    link(current, otherwise);
    current = otherwise;
  });
  return answer;
}

function foldInstanceof(
  graph: CFGFunction,
  editor: GraphEditor,
  node: CFGInstruction,
  classes: ClassTable,
  types: TypeInference,
  stamp: Stamp,
): boolean {
  const subject = node.inputs[SUBJECT];
  const constructorValue = node.inputs[CONSTRUCTOR];
  const target = namedClass(constructorValue, classes);
  const shape = staticShape(subject, classes, types);
  if (subject === undefined || target === null || shape === null) return false;

  const ids = matchingIds(shape, target, classes);
  const cone = classes.dispatchConeOf(shape.name);
  const answer =
    ids.length === cone.length || ids.length === 0
      ? stamp(irConstant(ids.length > 0))
      : selectBoolean(graph, node, subject, shape, ids, stamp);
  if (answer.block === null) editor.insertBefore(node, answer);
  editor.replaceAllUses(node, answer);
  editor.remove(node);
  if (constructorValue !== undefined && constructorValue.uses.length === 0) {
    editor.remove(constructorValue);
  }
  return true;
}

function foldTypeof(
  editor: GraphEditor,
  node: CFGInstruction,
  types: TypeInference,
  stamp: Stamp,
): boolean {
  const value = node.inputs[SUBJECT];
  if (value === undefined) return false;
  const name = typeofName(types.typeOf(value));
  if (name === null) return false;
  const spelled = stamp(irConstant(name));
  editor.insertBefore(node, spelled);
  editor.replaceAllUses(node, spelled);
  editor.remove(node);
  return true;
}

export function foldStaticReflection(graph: CFGFunction, types: TypeInference): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  const classes = graph.classes;
  let count = 0;
  for (let at = 0; at < graph.blocks.length; at++) {
    const block = graph.blocks[at]!;
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      if (node.type === IR_TYPEOF && foldTypeof(editor, node, types, stamp)) count++;
      else if (
        node.type === IR_GENERIC_INSTANCEOF &&
        classes !== null &&
        foldInstanceof(graph, editor, node, classes, types, stamp)
      ) {
        count++;
      }
    }
  }
  if (count > 0) graph.rebuildUses();
  return count;
}
