import { beforeEach, describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import { printIR } from "../../../src/optimizing/ir/text.js";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irReturn,
  resetIRNodeIds,
  IR_CALL_BUILTIN,
  IR_INT32_COMPARE,
  IR_PHI,
  IR_SELECT,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import { buildClassTable } from "../../../src/optimizing/metadata/class-table.js";
import {
  qualifiedMethodName,
  STRING_TO_END,
  STRING_TYPE,
} from "../../../src/optimizing/metadata/builtin-methods.js";
import { BYTEWISE_PROP } from "../../../src/optimizing/analyses/wide-text.js";
import { lowerStringSplit } from "../../../src/optimizing/passes/string-split.js";

beforeEach(() => resetIRNodeIds());

const LOWERING = "string-split-lowering";
const TAKER = "only";
const CALL_SITE = /^\s+v\d+ = GenericCall /m;

const src = (...lines: string[]) => lines.join("\n");

function lowered(source: string): string {
  let taken: string | null = null;
  nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
    format: "assembly",
    compilerOptions: compilerOptions("speed", {
      passTracer: (record) => {
        if (record.pass === LOWERING && record.graph.name === TAKER) taken = printIR(record.graph);
      },
    }),
  });
  if (taken === null) throw new Error(`${LOWERING} never ran over ${TAKER}`);
  return taken;
}

function loweredBody(...lines: string[]): string {
  return lowered(src("fn only(line: string) -> int:", ...lines, 'print(only("a,b,c"))'));
}

const branches = (text: string) => (text.match(/Branch /g) ?? []).length;

describe("lowering a split into a scan of the text", () => {
  it("leaves no generic call for a backend to refuse", () => {
    expect(CALL_SITE.test(loweredBody('  return line.split(",").length'))).toBe(false);
  });

  it("leaves none when the call also says how many pieces to keep", () => {
    expect(CALL_SITE.test(loweredBody('  return line.split(",", 2).length'))).toBe(false);
  });

  it("adds the tests that stop the scan once it has kept enough", () => {
    const plain = branches(loweredBody('  return line.split(",").length'));
    const limited = branches(loweredBody('  return line.split(",", 2).length'));

    expect(limited).toBe(plain + 2);
  });

  it("keeps the scan of an unlimited split as small as it was", () => {
    expect(branches(loweredBody('  return line.split(",").length'))).toBe(2);
  });

  it("bounds a split into characters without adding a test to its loop", () => {
    const plain = branches(loweredBody('  return line.split("").length'));
    const limited = branches(loweredBody('  return line.split("", 2).length'));

    expect(limited).toBe(plain);
  });

  it("leaves a separator outside ASCII to the interpreter", () => {
    expect(CALL_SITE.test(loweredBody('  return line.split("ộ", 2).length'))).toBe(true);
  });

  it("leaves a separator of several characters to the interpreter", () => {
    expect(CALL_SITE.test(loweredBody('  return line.split(", ", 2).length'))).toBe(true);
  });

  it("leaves a separator it cannot read at the call to the interpreter", () => {
    expect(
      CALL_SITE.test(
        lowered(
          src(
            "fn only(line: string, sep: string) -> int:",
            '  return line.split(sep, 2).length',
            'print(only("a,b,c", ","))',
          ),
        ),
      ),
    ).toBe(true);
  });
});

const SPLIT_MEMBER = "split";
const SEPARATOR = ",";
const EVERY_CHARACTER = "";
const LESS_THAN = "<";
const FIRST_INDEX = 0;
const IN_RANGE_LIMIT = 2;
const PAST_INT32_LIMIT = 3_000_000_000;
const NEGATIVE_LIMIT = -1;
const IN_LOOP_AND_TAIL = 2;
const SHARED_BOUND = 1;
const CHARACTER_AT_CALL = qualifiedMethodName(STRING_TYPE, "char_code_at");
const LENGTH_CALL = qualifiedMethodName(STRING_TYPE, "length");
const SLICE_CALL = qualifiedMethodName(STRING_TYPE, "slice");

function splitting(separator: string, limit: number | string | null): CFGFunction {
  const graph = new CFGFunction(TAKER);
  graph.classes = buildClassTable([]);
  graph.declaredSignature = {
    params: typeof limit === "string" ? ["string", limit] : ["string"],
    returns: "int",
  };
  const subject = graph.addParameter(0);
  const block = graph.addBlock();
  const callee = block.addNode(irGenericGetProp(subject, SPLIT_MEMBER));
  const args = [subject, block.addNode(irConstant(separator))];
  if (typeof limit === "string") args.push(graph.addParameter(1));
  else if (limit !== null) args.push(block.addNode(irConstant(limit)));
  const call = block.addNode(irGenericCall(callee, args));
  call.props.isMethod = true;
  block.addNode(irReturn(call));
  graph.rebuildUses();
  return graph;
}

function lowerings(graph: CFGFunction): number {
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return lowerStringSplit(graph, analyses.get(typeInferenceAnalysisId));
}

function scanned(separator: string, limit: number | string | null): CFGFunction {
  const graph = splitting(separator, limit);
  if (lowerings(graph) !== 1) throw new Error(`${SPLIT_MEMBER} was left for the interpreter`);
  return graph;
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const builtinNamesOf = (nodes: readonly CFGInstruction[]): string[] =>
  nodes
    .filter((node) => node.type === IR_CALL_BUILTIN)
    .map((node) => String(node.props.name))
    .sort();

const bytewiseNamesOf = (nodes: readonly CFGInstruction[]): string[] =>
  builtinNamesOf(nodes.filter((node) => node.props[BYTEWISE_PROP] === true));

const roomTestsOf = (graph: CFGFunction): CFGInstruction[] =>
  nodesOf(graph).filter(
    (node) =>
      node.type === IR_INT32_COMPARE &&
      node.inputs[0]?.type === IR_PHI &&
      node.inputs[1]?.type !== IR_CALL_BUILTIN,
  );

const keptBoundOf = (graph: CFGFunction): CFGInstruction => roomTestsOf(graph)[0]!.inputs[1]!;

describe("the bound a split's limit becomes", () => {
  it("keeps a limit an int32 can hold as it was written", () => {
    expect(keptBoundOf(scanned(SEPARATOR, IN_RANGE_LIMIT)).props.value).toBe(IN_RANGE_LIMIT);
  });

  it("clamps a limit past what an int32 holds down to the whole text", () => {
    expect(keptBoundOf(scanned(SEPARATOR, PAST_INT32_LIMIT)).props.value).toBe(STRING_TO_END);
  });

  it("reads a limit written below zero as the whole text", () => {
    expect(keptBoundOf(scanned(SEPARATOR, NEGATIVE_LIMIT)).props.value).toBe(STRING_TO_END);
  });

  it("bounds the scan in both the loop and its tail by the one value", () => {
    const rooms = roomTestsOf(scanned(SEPARATOR, IN_RANGE_LIMIT));

    expect([rooms.length, new Set(rooms.map((room) => room.inputs[1])).size]).toEqual([
      IN_LOOP_AND_TAIL,
      SHARED_BOUND,
    ]);
  });

  it("adds no bound at all when the call names no limit", () => {
    expect(roomTestsOf(scanned(SEPARATOR, null))).toEqual([]);
  });
});

describe("a split whose limit is only known at run time", () => {
  it("scans the text rather than leaving the call to the interpreter", () => {
    expect(lowerings(splitting(SEPARATOR, "int"))).toBe(1);
  });

  it("leaves a limit that is not a whole number to the interpreter", () => {
    expect(lowerings(splitting(SEPARATOR, "float"))).toBe(0);
  });

  it("bounds the scan by choosing between the limit and the whole text", () => {
    expect(keptBoundOf(scanned(SEPARATOR, "int")).type).toBe(IR_SELECT);
  });

  it("takes the whole text when the limit turns out to be below zero", () => {
    expect(keptBoundOf(scanned(SEPARATOR, "int")).inputs[1]!.props.value).toBe(STRING_TO_END);
  });

  it("takes the limit itself when it turns out not to be below zero", () => {
    const graph = scanned(SEPARATOR, "int");

    expect(keptBoundOf(graph).inputs[2]).toBe(graph.parameters[1]);
  });

  it("decides which to take by testing the limit against zero", () => {
    const graph = scanned(SEPARATOR, "int");
    const negative = keptBoundOf(graph).inputs[0]!;

    expect([
      negative.type,
      negative.props.op,
      negative.inputs[0],
      negative.inputs[1]!.props.value,
    ]).toEqual([IR_INT32_COMPARE, LESS_THAN, graph.parameters[1], FIRST_INDEX]);
  });
});

describe("how a split's own text reads count their characters", () => {
  it("counts a separator split's reads in bytes, so wide text still compiles", () => {
    expect(bytewiseNamesOf(nodesOf(scanned(SEPARATOR, null)))).toEqual([
      CHARACTER_AT_CALL,
      LENGTH_CALL,
      SLICE_CALL,
      SLICE_CALL,
    ]);
  });

  it("leaves a character split's reads counting characters", () => {
    const nodes = nodesOf(scanned(EVERY_CHARACTER, null));

    expect([bytewiseNamesOf(nodes), builtinNamesOf(nodes)]).toEqual([
      [],
      [LENGTH_CALL, SLICE_CALL],
    ]);
  });
});
