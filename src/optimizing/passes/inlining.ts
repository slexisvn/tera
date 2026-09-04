import {
  irConstant,
  irInt32Or,
  irJump,
  irRequiresFrameState,
  isTerminator,
  IR_AWAIT,
  IR_BRANCH,
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_FLOAT64_DIV,
  IR_FLOAT64_POW,
  IR_GENERIC_CALL,
  IR_DEOPTIMIZE,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_JUMP,
  IR_PARAMETER,
  IR_LOAD_CONTEXT_SLOT,
  IR_LOAD_TEXT,
  IR_PHI,
  IR_RETURN,
  IR_STORE_CONTEXT_SLOT,
  IR_STORE_TEXT,
  IR_YIELD,
  RESULT_INT32,
  resultClassOf,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  calleeSymbolName,
} from "../ir/index.js";
import { cloneBlocks, cloneGraph } from "../ir/clone.js";
import { GraphEditor } from "../ir/editor.js";
import { addPhi, link, splitBlockBefore } from "../ir/cfg-edit.js";
import { detachInputs, nodeIdStamper, type Stamp } from "../ir/graph-edit.js";
import { remarks } from "../infra/pass-remarks.js";
import {
  NAMED_ARGUMENTS_PROP,
} from "../metadata/call-signatures.js";
import { declaredAcceptsNull, DECLARED_INT } from "../types/declared.js";
import { declaredAotScalar } from "../metadata/class-table.js";
import { declaredInt32Return } from "../../runtime/declared-int.js";
import { isNumericScalar } from "../types/scalar.js";
import { withinInt32 } from "../target/integer.js";
import type { ModuleFunctions } from "../metadata/module-functions.js";
import type { CompilerOptions } from "../options.js";

const OPAQUE_TO_INLINING: ReadonlySet<string> = new Set<string>([
  IR_LOAD_CONTEXT_SLOT,
  IR_STORE_CONTEXT_SLOT,
  IR_DEOPTIMIZE,
  IR_AWAIT,
  IR_YIELD,
  IR_LOAD_TEXT,
  IR_STORE_TEXT,
]);

const STRING_TYPE = "string";

const STEP_COST = 1;
const FREE = 0;
const CALL_COST = 8;
const ROUTINE_COST = 16;
const ARGUMENT_COST = 1;
const CONSTANT_ARGUMENT_BONUS = 4;
const FOLDED_BRANCH_BONUS = 12;

const COSTED: ReadonlyMap<string, number> = new Map<string, number>([
  [IR_CONSTANT, FREE],
  [IR_PHI, FREE],
  [IR_JUMP, FREE],
  [IR_RETURN, FREE],
  [IR_CALL_KNOWN_FUNCTION, CALL_COST],
  [IR_GENERIC_CALL, CALL_COST],
  [IR_CALL_BUILTIN, CALL_COST],
  [IR_INT32_DIV, ROUTINE_COST],
  [IR_INT32_MOD, ROUTINE_COST],
  [IR_FLOAT64_DIV, ROUTINE_COST],
  [IR_FLOAT64_POW, ROUTINE_COST],
]);

export interface CallSite {
  readonly callee: CFGFunction;
  readonly args: readonly CFGInstruction[];
}

interface CalleeBody {
  readonly entry: CFGBlock;
  readonly returns: readonly CFGInstruction[];
  readonly size: number;
  readonly cost: number;
}

function nodeCost(node: CFGInstruction): number {
  return COSTED.get(node.type) ?? STEP_COST;
}

function calleeBody(callee: CFGFunction): CalleeBody | null {
  const entry = callee.entry ?? callee.blocks[0];
  if (entry === undefined || entry.predecessors.length > 0 || entry.phis.length > 0) return null;
  const returns: CFGInstruction[] = [];
  let size = 0;
  let cost = 0;
  for (const block of callee.blocks) {
    const terminator = block.getTerminator();
    if (terminator === null) return null;
    if (terminator.type === IR_RETURN) returns.push(terminator);
    for (const node of block.nodes) {
      if (OPAQUE_TO_INLINING.has(node.type)) return null;
      if (isTerminator(node.type)) continue;
      size++;
      cost += nodeCost(node);
    }
  }
  return returns.length === 0 ? null : { entry, returns, size, cost };
}

function decidesABranch(parameter: CFGInstruction): boolean {
  return parameter.uses.some(
    (use) => use.type === IR_BRANCH || use.uses.some((then) => then.type === IR_BRANCH),
  );
}

function foldingBonus(site: CallSite): number {
  let bonus = 0;
  site.args.forEach((argument, at) => {
    if (argument.type !== IR_CONSTANT) return;
    bonus += CONSTANT_ARGUMENT_BONUS;
    const parameter = site.callee.parameters[at];
    if (parameter !== undefined && decidesABranch(parameter)) bonus += FOLDED_BRANCH_BONUS;
  });
  return bonus;
}

export function inlineCostOf(site: CallSite, body: CalleeBody): number {
  return (
    body.cost - CALL_COST - site.args.length * ARGUMENT_COST - foldingBonus(site)
  );
}

export function callSiteOf(
  node: CFGInstruction,
  functions: ModuleFunctions,
): CallSite | null {
  if (node.type === IR_CALL_KNOWN_FUNCTION) {
    const name = calleeSymbolName(node);
    const named = name === null ? null : functions.named(name);
    return named === null ? null : { callee: named, args: node.inputs };
  }
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) return null;
  const callee = functions.referenced(node.inputs[0]);
  return callee === null ? null : { callee, args: node.inputs.slice(1) };
}

function inlinable(
  site: CallSite,
  call: CFGInstruction,
  caller: CFGFunction,
  body: CalleeBody,
): boolean {
  const callee = site.callee;
  if (call.props[NAMED_ARGUMENTS_PROP] !== undefined) return false;
  if (callee === caller) return false;
  if (callee.isAsync || callee.isGenerator || callee.recoversThrows) return false;
  if (callee.resumable) return false;
  if (callee.gatheredArguments !== null) return false;
  if (callee.declaredSignature?.returns === STRING_TYPE) return false;
  if ((callee.declaredSignature?.params ?? []).some((param) => declaredAcceptsNull(param)))
    return false;
  if (callee.parameters.length !== site.args.length) return false;
  if (call.uses.length === 0) return true;
  if (body.returns.some((returned) => returned.inputs[0] === undefined)) return false;
  return body.returns.length === 1 || mergesANumber(callee);
}

function mergesANumber(callee: CFGFunction): boolean {
  const scalar = declaredAotScalar(callee.declaredSignature?.returns, callee.classes);
  return scalar !== null && isNumericScalar(scalar);
}

function answersInt32(callee: CFGFunction, value: CFGInstruction | undefined): boolean {
  if (value === undefined) return false;
  if (resultClassOf(value.type) === RESULT_INT32) return true;
  if (value.type === IR_PARAMETER) {
    return callee.declaredSignature?.params[Number(value.props.index)] === DECLARED_INT;
  }
  if (value.type !== IR_CONSTANT) return false;
  const constant = value.props.value;
  return (
    typeof constant === "number" && Number.isInteger(constant) && withinInt32(constant, constant)
  );
}

function needsDeclaredIntWrap(callee: CFGFunction, body: CalleeBody): boolean {
  if (!declaredInt32Return(callee)) return false;
  return !body.returns.every((returned) => answersInt32(callee, returned.inputs[0]));
}

function wrapInInt32(
  answered: CFGInstruction,
  call: CFGInstruction,
  editor: GraphEditor,
  stamp: Stamp,
): CFGInstruction {
  const zero = stamp(irConstant(0));
  const wrapped = stamp(irInt32Or(answered, zero));
  editor.insertBefore(call, zero);
  editor.insertBefore(call, wrapped);
  return wrapped;
}

function substituteParameters(
  spliced: Iterable<CFGInstruction>,
  parameters: readonly CFGInstruction[],
  args: readonly CFGInstruction[],
): void {
  const passed = new Map<CFGInstruction, CFGInstruction>();
  parameters.forEach((parameter, at) => {
    const argument = args[at];
    if (argument !== undefined) passed.set(parameter, argument);
  });
  for (const node of spliced) {
    node.inputs.forEach((input, at) => {
      const argument = passed.get(input);
      if (argument !== undefined) node.replaceInput(at, argument);
    });
  }
}

function adoptFrameState(node: CFGInstruction, call: CFGInstruction): void {
  node.frameState = irRequiresFrameState(node) ? call.frameState : null;
}

function spliceStraightLine(
  caller: CFGFunction,
  call: CFGInstruction,
  site: CallSite,
  editor: GraphEditor,
  stamp: Stamp,
  wraps: boolean,
): boolean {
  const copy = cloneGraph(site.callee, `${caller.name}$inline`);
  const block = copy.graph.blocks[0];
  const terminator = block?.getTerminator();
  if (block === undefined || terminator === undefined || terminator === null) return false;

  substituteParameters(block.nodes, copy.graph.parameters, site.args);
  const spliced = block.nodes.filter((node) => node !== terminator);
  for (const node of spliced) {
    stamp(node);
    adoptFrameState(node, call);
    editor.insertBefore(call, node);
  }
  const answered = terminator.inputs[0] ?? null;
  if (answered !== null) {
    editor.replaceAllUses(call, wraps ? wrapInInt32(answered, call, editor, stamp) : answered);
  }
  editor.remove(call);
  return true;
}

function spliceRegion(
  caller: CFGFunction,
  call: CFGInstruction,
  site: CallSite,
  body: CalleeBody,
  editor: GraphEditor,
  stamp: Stamp,
  wraps: boolean,
): boolean {
  const entered = call.block;
  if (entered === null) return false;
  const continuation = splitBlockBefore(caller, entered, call);
  const clone = cloneBlocks(caller, site.callee.blocks, stamp);
  const spliced = [...clone.valueOf.values()];
  substituteParameters(spliced, site.callee.parameters, site.args);
  for (const node of spliced) adoptFrameState(node, call);

  entered.addNode(stamp(irJump(clone.blockOf.get(body.entry)!)));
  link(entered, clone.blockOf.get(body.entry)!);

  const answers: CFGInstruction[] = [];
  for (const returned of body.returns) {
    const copy = clone.blockOf.get(returned.block!)!;
    const terminator = copy.getTerminator()!;
    const answered = terminator.inputs[0];
    detachInputs(terminator);
    terminator.type = IR_JUMP;
    terminator.props = { targetBlock: continuation.id };
    link(copy, continuation);
    if (answered !== undefined) answers.push(answered);
  }

  if (call.uses.length > 0) {
    const merged =
      answers.length === 1 ? answers[0]! : stamp(addPhi(continuation, answers));
    editor.replaceAllUses(call, wraps ? wrapInInt32(merged, call, editor, stamp) : merged);
  }
  editor.remove(call);
  return true;
}

export function inlineKnownCalls(
  graph: CFGFunction,
  functions: ModuleFunctions,
  options: CompilerOptions,
): number {
  if (options.inlineBudget === 0) {
    remarks.analysis(
      null,
      "inlining is switched off here: the budget is zero, so every call stays a call",
    );
    return 0;
  }
  const editor = new GraphEditor(graph);
  const stamp = nodeIdStamper(graph);
  let remaining = options.inlineBudget;
  let inlined = 0;

  for (const block of [...graph.blocks]) {
    for (const node of [...block.nodes]) {
      if (node.block !== block) continue;
      const site = callSiteOf(node, functions);
      if (site === null) continue;
      const body = calleeBody(site.callee);
      if (body === null) {
        remarks.missed(
          node,
          `${site.callee.name} has no shape this pass can splice in: it either never returns a value or contains an operation that is opaque to inlining`,
        );
        continue;
      }
      if (body.size > remaining) {
        remarks.missed(
          node,
          `${site.callee.name} is ${body.size} nodes and only ${remaining} of the ${options.inlineBudget}-node budget is left, so it stays a call`,
        );
        continue;
      }
      if (!inlinable(site, node, graph, body)) {
        remarks.missed(
          node,
          `${site.callee.name} cannot be inlined here: its arity, its return shape or a property like async, generator or throw-recovery rules it out`,
        );
        continue;
      }
      const cost = inlineCostOf(site, body);
      if (cost > options.inlineThreshold) {
        remarks.missed(
          node,
          `${site.callee.name} scores ${cost} against a threshold of ${options.inlineThreshold}: the body is not worth the code it would add here`,
        );
        continue;
      }
      const wraps = needsDeclaredIntWrap(site.callee, body);
      const spliced =
        site.callee.blocks.length === 1
          ? spliceStraightLine(graph, node, site, editor, stamp, wraps)
          : spliceRegion(graph, node, site, body, editor, stamp, wraps);
      if (!spliced) {
        remarks.missed(node, `splicing ${site.callee.name} into this call failed late, so the call stands`);
        continue;
      }
      remarks.applied(
        node,
        `inlined ${site.callee.name} here: ${body.size} nodes at cost ${cost}, leaving ${remaining - body.size} of the budget`,
      );
      remaining -= body.size;
      inlined++;
    }
  }

  if (inlined > 0) graph.rebuildUses();
  return inlined;
}
