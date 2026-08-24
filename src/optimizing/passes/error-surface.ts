import {
  irConstant,
  irGenericAdd,
  irGenericGetProp,
  IR_CALL_BUILTIN,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_SET_PROP,
  IR_PHI,
  IR_STORE_FIELD,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import { GraphEditor } from "../ir/editor.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import {
  carriesPendingThrow,
  forwardsPendingThrow,
  isThrownValue,
  retypePendingThrow,
  takesPendingThrow,
} from "../builder/throw-recovery.js";
import { THROW_BUILTIN } from "../metadata/builtin-methods.js";
import {
  commonShapeOf,
  descendsFrom,
  CLASS_ID_PROP,
  VALUE_CLASS_PROP,
  type ClassShape,
  type ClassTable,
} from "../metadata/class-table.js";
import { constructedShapeOf } from "./class-member-lowering.js";
import { SCALAR_POINTER } from "../types/scalar.js";
import {
  ERROR_DISPLAY_PREFIX,
  ERROR_GLOBAL,
  ERROR_MESSAGE_FIELD,
} from "../prelude/errors.js";
import type { ModuleIR } from "../compilation-unit.js";

type Stamp = (node: CFGInstruction) => CFGInstruction;

interface ReportSite {
  readonly graph: CFGFunction;
  readonly node: CFGInstruction;
  readonly thrown: CFGInstruction;
}

interface Survey {
  readonly reports: readonly ReportSite[];
  readonly merges: ReadonlySet<CFGInstruction>;
  readonly held: ClassShape;
}

function reportsThrow(node: CFGInstruction): boolean {
  return node.type === IR_CALL_BUILTIN && node.props.name === THROW_BUILTIN;
}

function forwardedValue(node: CFGInstruction): CFGInstruction | null {
  if (node.type !== IR_STORE_FIELD || !forwardsPendingThrow(node)) return null;
  return node.inputs[1] ?? null;
}

function unset(node: CFGInstruction): boolean {
  if (node.type !== IR_CONSTANT) return false;
  const value = node.props.value;
  return value === undefined || value === null;
}

function heldShape(node: CFGInstruction, classes: ClassTable): ClassShape | null {
  const carried = node.props[VALUE_CLASS_PROP] ?? node.props[CLASS_ID_PROP];
  if (typeof carried === "number") return classes.shapeById(carried);
  return constructedShapeOf(node, classes);
}

interface Raised {
  readonly reports: readonly ReportSite[];
  readonly carriers: ReadonlySet<CFGInstruction>;
}

function raisedIn(module: ModuleIR): Raised {
  const reports: ReportSite[] = [];
  const carriers = new Set<CFGInstruction>();
  for (const unit of module.units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (takesPendingThrow(node) || isThrownValue(node)) carriers.add(node);
        const forwarded = forwardedValue(node);
        if (forwarded !== null) carriers.add(forwarded);
        if (!reportsThrow(node)) continue;
        const thrown = node.inputs[0];
        if (thrown === undefined) continue;
        reports.push({ graph: unit.graph, node, thrown });
        carriers.add(thrown);
      }
    }
  }
  return { reports, carriers };
}

function mergedThrough(seeds: ReadonlySet<CFGInstruction>): Set<CFGInstruction> {
  const carried = new Set<CFGInstruction>(seeds);
  const pending = [...seeds];
  while (pending.length > 0) {
    const value = pending.pop()!;
    for (const merge of value.uses) {
      if (merge.type !== IR_PHI || carried.has(merge)) continue;
      if (!merge.inputs.every((input) => carried.has(input) || unset(input))) continue;
      carried.add(merge);
      pending.push(merge);
    }
  }
  return carried;
}

function observesMembers(value: CFGInstruction, use: CFGInstruction): boolean {
  if (use.type === IR_PHI || reportsThrow(use)) return true;
  if (use.type === IR_GENERIC_GET_PROP || use.type === IR_GENERIC_SET_PROP) {
    return use.inputs[0] === value;
  }
  if (use.type === IR_GENERIC_CALL) return use.props.isMethod === true && use.inputs[1] === value;
  return forwardedValue(use) === value;
}

function rejectsThroughPromises(module: ModuleIR): boolean {
  return module.units.some((unit) => unit.graph.isAsync);
}

function surveyed(module: ModuleIR, classes: ClassTable | null): Survey | null {
  if (classes === null || classes.shapeOf(ERROR_GLOBAL) === null) return null;
  if (rejectsThroughPromises(module)) return null;
  const { reports, carriers } = raisedIn(module);
  const merges = new Set<CFGInstruction>();
  const shapes: ClassShape[] = [];
  for (const value of mergedThrough(carriers)) {
    if (unset(value)) continue;
    if (!value.uses.every((use) => observesMembers(value, use))) return null;
    if (value.type === IR_PHI) {
      merges.add(value);
      continue;
    }
    if (takesPendingThrow(value)) continue;
    const shape = heldShape(value, classes);
    if (shape === null) return null;
    shapes.push(shape);
  }
  if (shapes.length === 0) return null;
  const held = commonShapeOf(classes, shapes);
  if (held === null || !descendsFrom(classes, held, ERROR_GLOBAL)) return null;
  return { reports, merges, held };
}

function spellDisplay(site: ReportSite, stamp: Stamp): void {
  const editor = new GraphEditor(site.graph);
  const message = stamp(irGenericGetProp(site.thrown, ERROR_MESSAGE_FIELD));
  message.frameState = site.node.frameState;
  editor.insertBefore(site.node, message);
  const prefix = stamp(irConstant(ERROR_DISPLAY_PREFIX));
  editor.insertBefore(site.node, prefix);
  const display = stamp(irGenericAdd(prefix, message));
  editor.insertBefore(site.node, display);
  editor.setInput(site.node, 0, display);
}

export function lowerErrorSurface(module: ModuleIR, classes: ClassTable | null): number {
  const survey = surveyed(module, classes);
  if (survey === null) return 0;

  for (const unit of module.units) {
    for (const block of unit.graph.blocks) {
      for (const node of block.nodes) {
        if (carriesPendingThrow(node)) {
          retypePendingThrow(node, survey.held.name, SCALAR_POINTER);
        }
      }
    }
  }
  for (const merge of survey.merges) merge.props[VALUE_CLASS_PROP] = survey.held.id;

  const stampers = new Map<CFGFunction, Stamp>();
  const stamperFor = (graph: CFGFunction): Stamp => {
    let stamp = stampers.get(graph);
    if (stamp === undefined) {
      stamp = nodeIdStamper(graph);
      stampers.set(graph, stamp);
    }
    return stamp;
  };

  for (const site of survey.reports) spellDisplay(site, stamperFor(site.graph));
  for (const unit of module.units) {
    unit.graph.rebuildUses();
    unit.analyses?.invalidateAll();
  }
  return survey.reports.length;
}
