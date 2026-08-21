import {
  irConstant,
  irGenericCall,
  irGenericMul,
  namespaceCallArguments,
  namespaceMemberOf,
  IR_CONSTANT,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { BUILTIN_NAMESPACE } from "../metadata/builtin-methods.js";

const POWER_MEMBER = "pow";
const FOLDED_MEMBERS: ReadonlySet<string> = new Set<string>(["min", "max"]);
const NAMESPACE_CONSTANTS: ReadonlyMap<string, number> = new Map<string, number>([
  ["PI", Math.PI],
  ["E", Math.E],
]);
const PAIR = 2;
const IDENTITY = 1;
const HIGHEST_EXPANDED_POWER = 64;

type Stamp = (node: CFGInstruction) => CFGInstruction;

function wholeExponent(value: CFGInstruction | undefined): number | null {
  if (value === undefined || value.type !== IR_CONSTANT) return null;
  const exponent = value.props.value;
  if (typeof exponent !== "number" || !Number.isInteger(exponent)) return null;
  return exponent >= 0 && exponent <= HIGHEST_EXPANDED_POWER ? exponent : null;
}

function raised(
  editor: GraphEditor,
  before: CFGInstruction,
  base: CFGInstruction,
  exponent: number,
  stamp: Stamp,
): CFGInstruction {
  if (exponent === 0) {
    const one = stamp(irConstant(IDENTITY));
    editor.insertBefore(before, one);
    return one;
  }
  let square = base;
  let carried: CFGInstruction | null = null;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining % PAIR === IDENTITY) {
      if (carried === null) carried = square;
      else {
        const grown = stamp(irGenericMul(carried, square));
        editor.insertBefore(before, grown);
        carried = grown;
      }
    }
    remaining = Math.floor(remaining / PAIR);
    if (remaining === 0) break;
    const doubled = stamp(irGenericMul(square, square));
    editor.insertBefore(before, doubled);
    square = doubled;
  }
  return carried!;
}

function expandPower(
  editor: GraphEditor,
  node: CFGInstruction,
  stamp: Stamp,
): boolean {
  const args = namespaceCallArguments(node, BUILTIN_NAMESPACE, POWER_MEMBER);
  if (args === null || args.length !== PAIR) return false;
  const exponent = wholeExponent(args[1]);
  if (exponent === null) return false;
  const expanded = raised(editor, node, args[0]!, exponent, stamp);
  editor.replaceAllUses(node, expanded);
  editor.remove(node);
  return true;
}

function foldPairs(
  editor: GraphEditor,
  node: CFGInstruction,
  stamp: Stamp,
): boolean {
  for (const member of FOLDED_MEMBERS) {
    const args = namespaceCallArguments(node, BUILTIN_NAMESPACE, member);
    if (args === null || args.length === PAIR || args.length === 0) continue;
    if (args.length < PAIR) {
      editor.replaceAllUses(node, args[0]!);
      editor.remove(node);
      return true;
    }
    const callee = node.inputs[0]!;
    const receiver = node.inputs[1]!;
    let folded = args[0]!;
    for (const next of args.slice(1)) {
      const call = stamp(irGenericCall(callee, [receiver, folded, next]));
      call.props.isMethod = true;
      call.frameState = node.frameState;
      editor.insertBefore(node, call);
      folded = call;
    }
    editor.replaceAllUses(node, folded);
    editor.remove(node);
    return true;
  }
  return false;
}

function spellConstant(
  editor: GraphEditor,
  node: CFGInstruction,
  stamp: Stamp,
): boolean {
  const member = namespaceMemberOf(node, BUILTIN_NAMESPACE);
  if (member === null) return false;
  const value = NAMESPACE_CONSTANTS.get(member);
  if (value === undefined) return false;
  const spelled = stamp(irConstant(value));
  editor.insertBefore(node, spelled);
  editor.replaceAllUses(node, spelled);
  editor.remove(node);
  return true;
}

export function lowerMathSurface(graph: CFGFunction): number {
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let lowered = 0;
  for (const block of graph.blocks) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      if (expandPower(editor, node, stamp)) lowered += 1;
      else if (foldPairs(editor, node, stamp)) lowered += 1;
      else if (spellConstant(editor, node, stamp)) lowered += 1;
    }
  }
  if (lowered > 0) graph.rebuildUses();
  return lowered;
}
