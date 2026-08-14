import * as ir from "../ir/index.js";
import { visitFrameStateValues } from "../ir/frame-state-values.js";
import { latticeFromDeclaredType } from "../types/declared.js";
import { anyType, isSubtype, TypeKind, type LatticeType } from "../types/lattice.js";

type GuardBuilder = (param: ir.CFGInstruction) => ir.CFGInstruction;

const GUARD_BY_KIND = new Map<string, GuardBuilder>([
  [TypeKind.Smi, (param) => ir.irCheckSmi(param)],
  [TypeKind.Double, (param) => ir.irCheckNumber(param)],
  [TypeKind.Number, (param) => ir.irCheckNumber(param)],
  [TypeKind.String, (param) => ir.irCheckPrimitive(param, "string")],
  [TypeKind.Boolean, (param) => ir.irCheckPrimitive(param, "boolean")],
]);

const UNCONSTRAINED: ir.TypeContext = {
  typeOf: () => anyType(),
  returnTypeOf: () => anyType(),
};

function guardBuilderFor(declared: LatticeType): GuardBuilder | null {
  return GUARD_BY_KIND.get(declared.kind) ?? null;
}

function firstEntryUse(
  param: ir.CFGInstruction,
  entry: ir.CFGBlock,
): ir.CFGInstruction | null {
  for (const node of entry.nodes) {
    if (node.inputs.includes(param)) return node;
  }
  return null;
}

function establishes(node: ir.CFGInstruction | null, declared: LatticeType): boolean {
  if (node === null || !ir.isGuard(node)) return false;
  return isSubtype(ir.transferType(node, UNCONSTRAINED), declared);
}

function definedAtOrAfter(entry: ir.CFGBlock, limit: number): ReadonlySet<unknown> {
  const blocked = new Set<unknown>();
  for (let index = limit; index < entry.nodes.length; index++) {
    const node = entry.nodes[index]!;
    if (!ir.isRematerializable(node.type)) blocked.add(node);
  }
  return blocked;
}

function availableBefore(
  frameState: ir.CFGInstruction["frameState"],
  blocked: ReadonlySet<unknown>,
): boolean {
  let available = true;
  visitFrameStateValues(frameState, (value) => {
    if (blocked.has(value)) available = false;
  });
  return available;
}

function guardFrameState(
  entry: ir.CFGBlock,
  limit: number,
): ir.CFGInstruction["frameState"] {
  const blocked = definedAtOrAfter(entry, limit);
  for (const node of entry.nodes) {
    if (node.frameState === null) continue;
    return availableBefore(node.frameState, blocked) ? node.frameState : null;
  }
  return null;
}

export function insertDeclaredParameterGuards(graph: ir.CFGFunction): number {
  const signature = graph.declaredSignature;
  const entry = graph.entry;
  if (signature === null || entry === null) return 0;

  const insertAt = entry.phis.length;
  const frameState = guardFrameState(entry, insertAt);
  if (frameState === null) return 0;

  const guards: ir.CFGInstruction[] = [];
  for (const param of graph.parameters) {
    const declaredName = signature.params[Number(param.props.index)] ?? null;
    if (declaredName === null) continue;
    const declared = latticeFromDeclaredType(declaredName);
    const build = guardBuilderFor(declared);
    if (build === null) continue;
    if (establishes(firstEntryUse(param, entry), declared)) continue;

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
  entry.nodes.splice(insertAt, 0, ...guards);
  graph.rebuildUses();
  return guards.length;
}
