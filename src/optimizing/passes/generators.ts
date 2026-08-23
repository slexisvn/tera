import {
  irReturn,
  CFGFunction,
  IR_GENERIC_ADD,
  IR_GENERIC_DIV,
  IR_GENERIC_MUL,
  IR_GENERIC_SUB,
  IR_YIELD,
  type CFGBlock,
  type CFGInstruction,
} from "../ir/index.js";
import { fieldDeclaredType } from "./array-shapes.js";
import type { TypeInference } from "../analyses/type-inference.js";
import { disconnect } from "../ir/cfg-edit.js";
import { inferTypes } from "../analyses/type-inference.js";
import { TypeKind } from "../types/lattice.js";
import {
  Emitter,
  FrameSpills,
  dispatchStates,
  localizeConstantArrays,
  localizeRuntimeBases,
  returnsOf,
  severAfter,
  unlink,
  withFreshNodeIds,
  CoroutineSplitError,
} from "./coroutines.js";
import { coroutineParameterName } from "../metadata/coroutines.js";
import {
  generatorFrameShape,
  generatorResumeName,
  GEN_ENTRY_STATE,
  GEN_FINISHED,
  GEN_RUNNING,
  GEN_STATE_FIELD,
  GEN_STATUS_FIELD,
  GEN_VALUE_FIELD,
} from "../metadata/generators.js";
import type { ClassShape, ClassTable } from "../metadata/class-table.js";

const INT = "int";
const DEFAULT_YIELD = "int";

const YIELD_TYPES: ReadonlyMap<string, string> = new Map<string, string>([
  [TypeKind.Smi, "int"],
  [TypeKind.Double, "float"],
  [TypeKind.Number, "float"],
  [TypeKind.String, "string"],
  [TypeKind.Boolean, "bool"],
]);

const ARITHMETIC: ReadonlySet<string> = new Set<string>([
  IR_GENERIC_ADD,
  IR_GENERIC_SUB,
  IR_GENERIC_MUL,
]);

const YIELDABLE: ReadonlySet<string> = new Set<string>(["int", "float", "string", "bool"]);

interface YieldPoint {
  readonly state: number;
  readonly block: CFGBlock;
  readonly resume: CFGBlock;
  readonly value: CFGInstruction;
}

export interface GeneratorSplit {
  readonly resume: CFGFunction;
  readonly frame: ClassShape;
  readonly yields: string;
}

export type YieldType = { readonly yields: string } | { readonly reason: string };

function yieldedValues(graph: CFGFunction): readonly CFGInstruction[] {
  const values: CFGInstruction[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === IR_YIELD) values.push(node.inputs[0]!);
    }
  }
  return values;
}

function joinedNames(carried: string, found: string): string | null {
  if (carried === found) return carried;
  const numeric = carried !== "string" && found !== "string";
  return numeric ? "float" : null;
}

function namedYield(
  value: CFGInstruction,
  graph: CFGFunction,
  types: TypeInference,
): string | null {
  const kind = YIELD_TYPES.get(types.typeOf(value).kind);
  if (kind !== undefined) return kind;
  const classes = graph.classes;
  if (classes === null) return null;
  const declared = fieldDeclaredType(value, classes, types);
  if (declared !== null) return YIELDABLE.has(declared) ? declared : null;
  if (value.type === IR_GENERIC_DIV) return "float";
  if (!ARITHMETIC.has(value.type)) return null;
  let carried: string | null = null;
  for (const input of value.inputs) {
    const named = namedYield(input, graph, types);
    if (named === null) return null;
    carried = carried === null ? named : joinedNames(carried, named);
    if (carried === null) return null;
  }
  return carried;
}

export function generatorYieldType(graph: CFGFunction): YieldType {
  const values = yieldedValues(graph);
  if (values.length === 0) return { yields: DEFAULT_YIELD };
  const types = inferTypes(graph);
  let carried: string | null = null;
  for (const value of values) {
    const named = namedYield(value, graph, types);
    if (named === null) {
      return {
        reason:
          `${graph.name} yields a value the compiler has no generator slot for; annotate what ` +
          `it yields, or keep this part interpreted`,
      };
    }
    if (carried !== null && carried !== named) {
      return {
        reason:
          `${graph.name} yields both ${carried} and ${named}, and a compiled generator yields ` +
          `one type; yield one type, or keep this part interpreted`,
      };
    }
    carried = named;
  }
  return { yields: carried! };
}

function yieldPointsOf(graph: CFGFunction): readonly YieldPoint[] {
  const points: YieldPoint[] = [];
  for (let index = 0; index < graph.blocks.length; index++) {
    const block = graph.blocks[index]!;
    const at = block.nodes.findIndex((node) => node.type === IR_YIELD);
    if (at < 0) continue;
    const suspend = block.nodes[at]!;
    const value = suspend.inputs[0]!;
    const resume = severAfter(graph, block, at);
    unlink(suspend);
    points.push({ state: points.length + 1, block, resume, value });
  }
  return points;
}

function yieldAt(
  classes: ClassTable,
  frame: ClassShape,
  self: CFGInstruction,
  point: YieldPoint,
): void {
  unlink(point.block.getTerminator()!);
  disconnect(point.block, point.resume);
  const out = new Emitter(classes, point.block);
  out.store(self, frame, GEN_STATE_FIELD, out.constant(point.state));
  out.store(self, frame, GEN_VALUE_FIELD, point.value);
  point.block.addNode(irReturn(out.constant(GEN_RUNNING)));
}

function finishIn(
  classes: ClassTable,
  frame: ClassShape,
  done: number,
  self: CFGInstruction,
  block: CFGBlock,
): void {
  const out = new Emitter(classes, block);
  out.store(self, frame, GEN_STATE_FIELD, out.constant(done));
  block.addNode(irReturn(out.constant(GEN_FINISHED)));
}

function finishAt(
  classes: ClassTable,
  frame: ClassShape,
  done: number,
  self: CFGInstruction,
  exit: CFGInstruction,
): void {
  const block = exit.block!;
  unlink(exit);
  finishIn(classes, frame, done, self, block);
}

function splitInPlace(
  graph: CFGFunction,
  classes: ClassTable,
  yields: string,
): GeneratorSplit {
  const points = yieldPointsOf(graph);
  localizeRuntimeBases(graph);
  localizeConstantArrays(graph);
  const spills = new FrameSpills(graph, classes, points);
  const frame = generatorFrameShape(classes, graph.name, spills.slots, yields);
  const parameters = [...graph.parameters];
  const body = graph.entry!;
  const done = points.length + 1;

  const resume = new CFGFunction(generatorResumeName(graph.name));
  resume.classes = classes;
  resume.internal = true;
  resume.resumable = true;
  resume.declaredSignature = { params: [frame.name], returns: INT };
  const self = resume.addParameter(0);
  resume.takeBlocks([...graph.blocks], body);

  const exits = returnsOf(resume);
  for (const point of points) yieldAt(classes, frame, self, point);
  spills.spillInto(frame, self);
  for (const exit of exits) finishAt(classes, frame, done, self, exit);
  const finished = resume.addBlock();
  finishIn(classes, frame, done, self, finished);
  const head = dispatchStates(resume, classes, frame, self, [
    body,
    ...points.map((point) => point.resume),
    finished,
  ]);
  resume.takeBlocks([head, ...resume.blocks.filter((block) => block !== head)], head);
  resume.rebuildUses();

  graph.blocks = [];
  graph.entry = null;
  const opening = new Emitter(classes, graph.addBlock());
  const created = opening.allocate(frame);
  opening.store(created, frame, GEN_STATE_FIELD, opening.constant(GEN_ENTRY_STATE));
  opening.store(created, frame, GEN_STATUS_FIELD, opening.constant(GEN_RUNNING));
  parameters.forEach((parameter, index) => {
    opening.store(created, frame, coroutineParameterName(index), parameter);
  });
  opening.add(irReturn(created));
  graph.declaredSignature = { params: graph.declaredSignature?.params ?? [], returns: frame.name };
  graph.rebuildUses();

  const generator = { frame, resume: resume.name, yields };
  classes.declareGenerator(graph.name, generator);
  classes.declareGenerator(frame.name, generator);
  classes.declareGenerator(resume.name, generator);
  return { resume, frame, yields };
}

export function splitGenerator(
  graph: CFGFunction,
  classes: ClassTable,
  yields: string,
): GeneratorSplit {
  return withFreshNodeIds(graph, () => splitInPlace(graph, classes, yields));
}
