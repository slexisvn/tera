import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irBranch,
  irConstant,
  irGenericGetIndex,
  irGenericIn,
  irGenericSetProp,
  irJump,
  irNot,
  irReturn,
  resetIRNodeIds,
  IR_CONSTANT,
  IR_GENERIC_COMPARE,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_IN,
  IR_GENERIC_SET_PROP,
  IR_INT32_OR,
  IR_LOAD_FIELD,
  IR_SELECT,
  IR_STORE_FIELD,
  type CFGBlock,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  buildClassTable,
  ITERATOR_MEMBER,
} from "../../../src/optimizing/metadata/class-table.js";
import type { ClassMemberSurface } from "../../../src/frontend/modules/interface.js";
import { link } from "../../../src/optimizing/ir/cfg-edit.js";
import { lowerClassMembers } from "../../../src/optimizing/passes/class-member-lowering.js";
import { MAY_BE_ABSENT_PROP } from "../../../src/optimizing/types/scalar.js";

beforeEach(() => resetIRNodeIds());

const TABLE = "Prices";
const KEYS = ["a", "b", "c"] as const;

function member(
  owner: string,
  name: string,
  declaredType: string,
  kind: "field" | "method" = "field",
): ClassMemberSurface {
  return {
    name,
    declaredType,
    member: kind,
    owner,
    abstract: false,
    visibility: "public",
    static: false,
  };
}

function tableOf(owner: string, members: readonly ClassMemberSurface[]) {
  return buildClassTable([
    {
      name: owner,
      parent: null,
      abstract: false,
      members,
      constructorParams: [],
      constructorParamNames: [],
    },
  ]);
}

const priceFields = KEYS.map((key) => member(TABLE, key, "int"));

interface Fixture {
  readonly graph: CFGFunction;
  readonly entry: CFGBlock;
  readonly record: CFGInstruction;
  readonly key: CFGInstruction;
}

function fixture(members: readonly ClassMemberSurface[] = priceFields): Fixture {
  const graph = new CFGFunction("looks");
  graph.classes = tableOf(TABLE, members);
  graph.declaredSignature = { params: [TABLE, "string"], returns: "int" };
  const entry = graph.addBlock();
  return { graph, entry, record: graph.addParameter(0), key: graph.addParameter(1) };
}

function lower(graph: CFGFunction): number {
  graph.rebuildUses();
  const analyses = new AnalysisManager(graph, createAnalysisRegistry());
  return lowerClassMembers(graph, analyses.get(typeInferenceAnalysisId));
}

const nodesOf = (graph: CFGFunction): CFGInstruction[] =>
  graph.blocks.flatMap((block) => block.nodes);

const ofType = (graph: CFGFunction, type: string): CFGInstruction[] =>
  nodesOf(graph).filter((node) => node.type === type);

const comparedNames = (graph: CFGFunction): unknown[] =>
  ofType(graph, IR_GENERIC_COMPARE).map((node) => node.inputs[1]!.props.value);

function membershipGraph(members?: readonly ClassMemberSurface[]) {
  const fixed = fixture(members);
  const test = fixed.entry.addNode(irGenericIn(fixed.key, fixed.record));
  fixed.entry.addNode(irReturn(test));
  return { ...fixed, test };
}

describe("a runtime key asked whether a record carries it", () => {
  it("asks the key against every name the record carries", () => {
    const { graph } = membershipGraph();

    expect(lower(graph)).toBe(1);

    expect(comparedNames(graph)).toEqual([...KEYS]);
    expect(ofType(graph, IR_GENERIC_IN)).toHaveLength(0);
  });

  it("answers true when any one of those matches", () => {
    const { graph } = membershipGraph();
    lower(graph);

    const ors = ofType(graph, IR_INT32_OR);
    const compares = ofType(graph, IR_GENERIC_COMPARE);

    expect(ors).toHaveLength(KEYS.length - 1);
    expect(ors[0]!.inputs).toEqual([compares[0], compares[1]]);
    expect(ors[1]!.inputs).toEqual([ors[0], compares[2]]);
  });

  it("answers the last of those tests, so no membership survives the pass", () => {
    const { graph } = membershipGraph();
    lower(graph);

    const returned = ofType(graph, "Return")[0]!;
    expect(returned.inputs[0]!.type).toBe(IR_INT32_OR);
  });

  it("leaves a record holding something that is not a number alone", () => {
    const { graph } = membershipGraph([...priceFields, member(TABLE, "label", "string")]);

    expect(lower(graph)).toBe(0);
    expect(ofType(graph, IR_GENERIC_IN)).toHaveLength(1);
  });

  it("leaves a record carrying nothing alone", () => {
    const { graph } = membershipGraph([member(TABLE, "step", "int", "method")]);

    expect(lower(graph)).toBe(0);
    expect(ofType(graph, IR_GENERIC_IN)).toHaveLength(1);
  });
});

describe("a record read at a runtime key", () => {
  function lookupGraph() {
    const fixed = fixture();
    const read = fixed.entry.addNode(irGenericGetIndex(fixed.record, fixed.key));
    fixed.entry.addNode(irReturn(read));
    return { ...fixed, read };
  }

  it("reads whichever field the key names", () => {
    const { graph } = lookupGraph();

    expect(lower(graph)).toBe(1);

    expect(ofType(graph, IR_GENERIC_GET_INDEX)).toHaveLength(0);
    expect(ofType(graph, IR_LOAD_FIELD)).toHaveLength(KEYS.length);
    expect(ofType(graph, IR_SELECT)).toHaveLength(KEYS.length);
  });

  it("falls back to an absence when the key names none of them", () => {
    const { graph } = lookupGraph();
    lower(graph);

    const innermost = ofType(graph, IR_SELECT)[0]!;
    const fallback = innermost.inputs[2]!;

    expect(fallback.type).toBe(IR_CONSTANT);
    expect(fallback.props.value).toBeUndefined();
    expect(fallback.props[MAY_BE_ABSENT_PROP]).toBe(true);
  });

  it("answers a spelled-out key the record does not carry with an absence outright", () => {
    const fixed = fixture();
    const missing = fixed.entry.addNode(irConstant("zz"));
    const read = fixed.entry.addNode(irGenericGetIndex(fixed.record, missing));
    fixed.entry.addNode(irReturn(read));

    expect(lower(fixed.graph)).toBe(1);

    const returned = ofType(fixed.graph, "Return")[0]!;
    expect(returned.inputs[0]!.type).toBe(IR_CONSTANT);
    expect(returned.inputs[0]!.props.value).toBeUndefined();
    expect(ofType(fixed.graph, IR_SELECT)).toHaveLength(0);
    expect(returned.inputs[0]!.props[MAY_BE_ABSENT_PROP]).toBe(true);
  });
});

describe("a record read under a guard that already proved the key is carried", () => {
  function guardedGraph(negate: boolean) {
    const fixed = fixture();
    const test = fixed.entry.addNode(irGenericIn(fixed.key, fixed.record));
    const condition = negate ? fixed.entry.addNode(irNot(test)) : test;

    const held = fixed.graph.addBlock();
    const missing = fixed.graph.addBlock();
    const taken = negate ? missing : held;
    const untaken = negate ? held : missing;
    fixed.entry.addNode(irBranch(condition, taken, untaken));
    link(fixed.entry, taken);
    link(fixed.entry, untaken);

    const after = fixed.graph.addBlock();
    const read = held.addNode(irGenericGetIndex(fixed.record, fixed.key));
    held.addNode(irReturn(read));
    missing.addNode(irJump(after));
    link(missing, after);
    after.addNode(irReturn(after.addNode(irConstant(0))));
    return { ...fixed, read };
  }

  it("spends no test on the last field, since one of them must hold", () => {
    const { graph } = guardedGraph(false);
    lower(graph);

    const selects = ofType(graph, IR_SELECT);
    expect(selects).toHaveLength(KEYS.length - 1);
    expect(selects[0]!.inputs[2]!.type).toBe(IR_LOAD_FIELD);
    expect(ofType(graph, IR_CONSTANT).some((node) => node.props.value === undefined)).toBe(false);
  });

  it("reads the same proof out of a guard written the other way round", () => {
    const { graph } = guardedGraph(true);
    lower(graph);

    expect(ofType(graph, IR_SELECT)).toHaveLength(KEYS.length - 1);
  });

  it("keeps the absence when nothing proved the key is carried", () => {
    const fixed = fixture();
    const read = fixed.entry.addNode(irGenericGetIndex(fixed.record, fixed.key));
    fixed.entry.addNode(irReturn(read));
    lower(fixed.graph);

    expect(ofType(fixed.graph, IR_SELECT)).toHaveLength(KEYS.length);
  });
});

describe("an iterator hook a receiver does not need", () => {
  function hookGraph(members: readonly ClassMemberSurface[]) {
    const fixed = fixture(members);
    const hook = fixed.entry.addNode(irConstant(0));
    fixed.entry.addNode(irGenericSetProp(fixed.record, ITERATOR_MEMBER, hook));
    fixed.entry.addNode(irReturn(fixed.entry.addNode(irConstant(0))));
    return fixed;
  }

  const steps = member(TABLE, "next", "int", "method");
  const handsBackItself = member(TABLE, ITERATOR_MEMBER, `() -> ${TABLE}`);

  const writes = (graph: CFGFunction): number =>
    ofType(graph, IR_GENERIC_SET_PROP).length + ofType(graph, IR_STORE_FIELD).length;

  it("drops the store when the receiver steps itself", () => {
    const { graph } = hookGraph([steps, handsBackItself]);

    expect(lower(graph)).toBe(1);
    expect(writes(graph)).toBe(0);
  });

  it("keeps the store when the hook hands back a stepper of its own", () => {
    const { graph } = hookGraph([steps, member(TABLE, ITERATOR_MEMBER, "() -> Walker")]);

    lower(graph);

    expect(writes(graph)).toBe(1);
  });

  it("keeps the store when the receiver answers no step at all", () => {
    const { graph } = hookGraph([handsBackItself, member(TABLE, "step", "int", "method")]);

    lower(graph);

    expect(writes(graph)).toBe(1);
  });
});
