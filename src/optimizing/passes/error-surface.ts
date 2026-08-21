import {
  irConstant,
  irGenericAdd,
  irGenericCall,
  irGenericGetProp,
  propertyNameOf,
  IR_CALL_BUILTIN,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_CONSTANT,
  IR_LOAD_GLOBAL,
  IR_PHI,
  IR_STORE_FIELD,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { forwardsPendingThrow, takesPendingThrow } from "../builder/throw-recovery.js";
import { THROW_BUILTIN } from "../metadata/builtin-methods.js";
import type { ClassShape, ClassTable } from "../metadata/class-table.js";
import type { ModuleIR } from "../compilation-unit.js";

const ERROR_GLOBAL = "Error";
const MESSAGE_MEMBER = "message";
const SLICE_MEMBER = "slice";
const NAME_SEPARATOR = ": ";
const ONE_ARGUMENT = 2;
const ONE_MESSAGE = 1;

interface ErrorSite {
  readonly graph: CFGFunction;
  readonly call: CFGInstruction;
  readonly message: CFGInstruction;
}

interface ThrowSite {
  readonly thrown: CFGInstruction;
}

function globalName(node: CFGInstruction | undefined): string | null {
  if (node?.type !== IR_LOAD_GLOBAL) return null;
  const name = node.props.name;
  return typeof name === "string" ? name : null;
}

function stateless(shape: ClassShape | null): boolean {
  return (
    shape === null ||
    (shape.fields.size === 0 && shape.constructorParamNames.length <= ONE_MESSAGE)
  );
}

function raisesErrors(shape: ClassShape | null, classes: ClassTable | null): boolean {
  let walk = shape;
  const seen = new Set<string>();
  while (walk !== null && !seen.has(walk.name)) {
    seen.add(walk.name);
    if (!stateless(walk)) return false;
    if (walk.parent === ERROR_GLOBAL) return true;
    walk = walk.parent === null ? null : (classes?.shapeOf(walk.parent) ?? null);
  }
  return false;
}

function constructedError(
  node: CFGInstruction,
  graph: CFGFunction,
  classes: ClassTable | null,
): ErrorSite | null {
  if (node.type !== IR_GENERIC_CALL || node.props.isMethod === true) return null;
  const name = globalName(node.inputs[0]);
  if (name === null || node.inputs.length !== ONE_ARGUMENT) return null;
  const shape = classes === null ? null : classes.shapeOf(name);
  const raises = name === ERROR_GLOBAL ? stateless(shape) : raisesErrors(shape, classes);
  if (!raises) return null;
  return { graph, call: node, message: node.inputs[1]! };
}

function thrownAt(node: CFGInstruction): ThrowSite | null {
  if (node.type === IR_CALL_BUILTIN && node.props.name === THROW_BUILTIN) {
    const thrown = node.inputs[0];
    return thrown === undefined ? null : { thrown };
  }
  if (node.type !== IR_STORE_FIELD || !forwardsPendingThrow(node)) return null;
  const thrown = node.inputs[1];
  return thrown === undefined ? null : { thrown };
}

function unset(node: CFGInstruction): boolean {
  if (node.type !== IR_CONSTANT) return false;
  const value = node.props.value;
  return value === undefined || value === null;
}

function deadMerges(merges: readonly CFGInstruction[]): Set<CFGInstruction> {
  const dead = new Set<CFGInstruction>(merges);
  for (let shrank = true; shrank; ) {
    shrank = false;
    for (const phi of dead) {
      if (phi.uses.every((use) => dead.has(use))) continue;
      dead.delete(phi);
      shrank = true;
    }
  }
  return dead;
}

interface MessageRead {
  readonly graph: CFGFunction;
  readonly node: CFGInstruction;
}

interface Survey {
  readonly errors: ErrorSite[];
  readonly messages: MessageRead[];
}

function surveyed(module: ModuleIR): Survey | null {
  const errors: ErrorSite[] = [];
  const tracked = new Set<CFGInstruction>();
  const throws: CFGInstruction[] = [];
  const owners = new Map<CFGInstruction, CFGFunction>();
  for (const unit of module.units) {
    const graph = unit.graph;
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        owners.set(node, graph);
        const site = constructedError(node, graph, graph.classes);
        if (site !== null) {
          errors.push(site);
          tracked.add(node);
        }
        if (takesPendingThrow(node)) tracked.add(node);
        if (thrownAt(node) !== null) throws.push(node);
      }
    }
  }
  if (errors.length === 0) return null;

  const merges: CFGInstruction[] = [];
  for (const unit of module.units) {
    for (const block of unit.graph.blocks) merges.push(...block.phis);
  }
  const dead = deadMerges(merges);
  for (let grew = true; grew; ) {
    grew = false;
    for (const phi of merges) {
      if (dead.has(phi)) continue;
      if (tracked.has(phi) || !phi.inputs.some((input) => tracked.has(input))) continue;
      tracked.add(phi);
      grew = true;
    }
  }
  for (const phi of merges) {
    if (!tracked.has(phi) || dead.has(phi)) continue;
    if (phi.inputs.every((input) => tracked.has(input) || unset(input))) continue;
    return null;
  }

  const messages: MessageRead[] = [];
  const carriers = new Set<CFGInstruction>(tracked);
  const pending = [...tracked];
  while (pending.length > 0) {
    const value = pending.pop()!;
    for (const use of value.uses) {
      if (propertyNameOf(use) === MESSAGE_MEMBER && use.inputs[0] === value) {
        if (!tracked.has(value)) continue;
        const graph = owners.get(use);
        if (graph === undefined) return null;
        messages.push({ graph, node: use });
        continue;
      }
      if (thrownAt(use)?.thrown === value || dead.has(use)) continue;
      if (use.type !== IR_PHI) return null;
      if (carriers.has(use)) continue;
      carriers.add(use);
      pending.push(use);
    }
  }
  for (const site of throws) {
    if (tracked.has(thrownAt(site)!.thrown)) continue;
    return null;
  }
  return { errors, messages };
}

function spellDisplay(site: ErrorSite, stamp: (node: CFGInstruction) => CFGInstruction): void {
  const editor = new GraphEditor(site.graph);
  const prefix = stamp(irConstant(`${ERROR_GLOBAL}${NAME_SEPARATOR}`));
  editor.insertBefore(site.call, prefix);
  const display = stamp(irGenericAdd(prefix, site.message));
  editor.insertBefore(site.call, display);
  editor.replaceAllUses(site.call, display);
  editor.remove(site.call);
}

function spellMessage(
  node: CFGInstruction,
  graph: CFGFunction,
  stamp: (node: CFGInstruction) => CFGInstruction,
): void {
  const editor = new GraphEditor(graph);
  const held = node.inputs[0]!;
  const callee = stamp(irGenericGetProp(held, SLICE_MEMBER));
  editor.insertBefore(node, callee);
  const start = stamp(irConstant(`${ERROR_GLOBAL}${NAME_SEPARATOR}`.length));
  editor.insertBefore(node, start);
  const call = stamp(irGenericCall(callee, [held, start]));
  call.props.isMethod = true;
  call.frameState = node.frameState;
  editor.insertBefore(node, call);
  editor.replaceAllUses(node, call);
  editor.remove(node);
}

export function lowerErrorSurface(module: ModuleIR): number {
  const survey = surveyed(module);
  if (survey === null) return 0;
  const stampers = new Map<CFGFunction, (node: CFGInstruction) => CFGInstruction>();
  const stamperFor = (graph: CFGFunction): ((node: CFGInstruction) => CFGInstruction) => {
    let stamp = stampers.get(graph);
    if (stamp === undefined) {
      stamp = nodeIdStamper(graph);
      stampers.set(graph, stamp);
    }
    return stamp;
  };

  for (const read of survey.messages) {
    spellMessage(read.node, read.graph, stamperFor(read.graph));
  }
  for (const site of survey.errors) spellDisplay(site, stamperFor(site.graph));
  for (const unit of module.units) unit.graph.rebuildUses();
  return survey.errors.length;
}
