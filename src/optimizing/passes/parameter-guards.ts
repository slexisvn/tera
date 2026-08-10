import * as ir from "../ir/index.js";
import { latticeFromDeclaredType } from "../types/declared.js";
import { TypeKind, type LatticeType } from "../types/lattice.js";

type GuardBuilder = (param: ir.CFGInstruction) => ir.CFGInstruction;

const GUARD_BY_KIND = new Map<string, GuardBuilder>([
  [TypeKind.Smi, (param) => ir.irCheckSmi(param)],
  [TypeKind.Double, (param) => ir.irCheckNumber(param)],
  [TypeKind.Number, (param) => ir.irCheckNumber(param)],
  [TypeKind.String, (param) => ir.irCheckPrimitive(param, "string")],
  [TypeKind.Boolean, (param) => ir.irCheckPrimitive(param, "boolean")],
]);

function guardBuilderFor(declared: LatticeType): GuardBuilder | null {
  return GUARD_BY_KIND.get(declared.kind) ?? null;
}

function entryFrameState(entry: ir.CFGBlock): ir.CFGInstruction["frameState"] {
  for (const node of entry.nodes) {
    if (node.frameState !== null) return node.frameState;
  }
  return null;
}

export function insertDeclaredParameterGuards(graph: ir.CFGFunction): number {
  const signature = graph.declaredSignature;
  const entry = graph.entry;
  if (signature === null || entry === null) return 0;

  const frameState = entryFrameState(entry);
  if (frameState === null) return 0;

  const guards: ir.CFGInstruction[] = [];
  for (const param of graph.parameters) {
    const declared = signature.params[Number(param.props.index)] ?? null;
    if (declared === null) continue;
    const build = guardBuilderFor(latticeFromDeclaredType(declared));
    if (build === null) continue;
    if (param.uses.some((use) => use.inputs[0] === param && GUARDED.has(use.type))) continue;

    const guard = build(param);
    guard.frameState = frameState;
    guard.block = entry;
    for (const use of [...param.uses]) {
      if (use === guard) continue;
      for (let index = 0; index < use.inputs.length; index++) {
        if (use.inputs[index] === param) use.replaceInput(index, guard);
      }
    }
    guards.push(guard);
  }

  if (guards.length === 0) return 0;
  entry.nodes.splice(entry.phis.length, 0, ...guards);
  graph.rebuildUses();
  return guards.length;
}

const GUARDED = new Set<string>([
  ir.IR_CHECK_SMI,
  ir.IR_CHECK_NUMBER,
  ir.IR_CHECK_PRIMITIVE,
]);
