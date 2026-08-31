import { beforeEach, describe, expect, it } from "vitest";
import { shapeModuleCollections } from "../../../src/optimizing/passes/collection-surface.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  CFGFunction,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
  IR_ITERATOR_INIT,
  IR_LOAD_GLOBAL,
  irConstant,
  irGenericCall,
  irGenericGetProp,
  irIteratorInit,
  irLoadGlobal,
  irReturn,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import {
  buildClassTable,
  VALUE_CLASS_PROP,
} from "../../../src/optimizing/metadata/class-table.js";
import {
  mapClassName,
  setClassName,
} from "../../../src/optimizing/prelude/collections.js";

beforeEach(() => resetIRNodeIds());

type Key = number | string;

interface Built {
  readonly graph: CFGFunction;
  readonly construction: CFGInstruction;
  readonly iteration: CFGInstruction | null;
}

interface Options {
  readonly kind?: "Set" | "Map";
  readonly key?: Key;
  readonly value?: Key;
  readonly iterate?: "directly" | "values" | "never";
}

function build({ kind = "Set", key = 1, value, iterate = "never" }: Options = {}): Built {
  const graph = new CFGFunction("f");
  graph.classes = buildClassTable([]);
  const block = graph.addBlock();

  const global = irLoadGlobal(kind);
  block.addNode(global);
  const construction = irGenericCall(global, []);
  block.addNode(construction);

  const member = kind === "Set" ? "add" : "set";
  const held = irConstant(key);
  block.addNode(held);
  const args = [construction, held];
  if (value !== undefined) {
    const stored = irConstant(value);
    block.addNode(stored);
    args.push(stored);
  }
  const memberProp = irGenericGetProp(construction, member);
  block.addNode(memberProp);
  const call = irGenericCall(memberProp, args);
  call.props.isMethod = true;
  block.addNode(call);

  let iteration: CFGInstruction | null = null;
  if (iterate !== "never") {
    let iterated: CFGInstruction = construction;
    if (iterate === "values") {
      const listing = irGenericGetProp(construction, "values");
      block.addNode(listing);
      iterated = irGenericCall(listing, [construction]);
      iterated.props.isMethod = true;
      block.addNode(iterated);
    }
    iteration = irIteratorInit(iterated);
    block.addNode(iteration);
  }

  block.addNode(irReturn(construction));
  graph.rebuildUses();
  return { graph, construction, iteration };
}

function shape(built: Built): readonly CFGFunction[] {
  const analyses = new AnalysisManager(built.graph, createAnalysisRegistry());
  return shapeModuleCollections([
    { graph: built.graph, types: analyses.get(typeInferenceAnalysisId) },
  ]);
}

const constructedName = (built: Built): string =>
  String(built.construction.inputs[0]!.props.name);

function iteratedMember(built: Built): string | null {
  const iterated = built.iteration?.inputs[0];
  if (iterated === undefined || iterated.type !== IR_GENERIC_CALL) return null;
  const callee = iterated.inputs[0];
  return callee === undefined ? null : String(callee.props.propName);
}

const globalLoads = (graph: CFGFunction): string[] =>
  graph.blocks
    .flatMap((block) => block.nodes)
    .filter((node) => node.type === IR_LOAD_GLOBAL)
    .map((node) => String(node.props.name));

describe("collection flavours", () => {
  it("names a set by the key type it holds", () => {
    const built = build({ key: 1 });
    shape(built);

    expect(constructedName(built)).toBe(setClassName("int"));
  });

  it("names a set of text by its key type", () => {
    const built = build({ key: "a" });
    shape(built);

    expect(constructedName(built)).toBe(setClassName("string"));
  });

  it("names a map by both the key and the value it holds", () => {
    const built = build({ kind: "Map", key: "a", value: 1 });
    shape(built);

    expect(constructedName(built)).toBe(mapClassName("string", "int"));
  });

  it("reports the graph it rewrote", () => {
    const built = build({ key: 1 });

    expect(shape(built)).toEqual([built.graph]);
  });
});

describe("direct set iteration", () => {
  it("reads the set through its values instead of iterating it raw", () => {
    const built = build({ key: 1, iterate: "directly" });
    shape(built);

    expect(iteratedMember(built)).toBe("values");
  });

  it("still names the set class it lowered to", () => {
    const built = build({ key: 1, iterate: "directly" });
    shape(built);

    expect(constructedName(built)).toBe(setClassName("int"));
  });

  it("leaves no iterator reading the collection itself", () => {
    const built = build({ key: 1, iterate: "directly" });
    shape(built);
    const raw = built.graph.blocks
      .flatMap((block) => block.nodes)
      .filter((node) => node.type === IR_ITERATOR_INIT && node.inputs[0] === built.construction);

    expect(raw).toEqual([]);
  });

  it("does not list a values call that the source already wrote", () => {
    const built = build({ key: 1, iterate: "values" });
    shape(built);
    const listings = built.graph.blocks
      .flatMap((block) => block.nodes)
      .filter((node) => node.type === IR_GENERIC_GET_PROP && node.props.propName === "values");

    expect(iteratedMember(built)).toBe("values");
    expect(listings).toHaveLength(1);
  });

  it("points the collection at its own class once lowered", () => {
    const built = build({ key: 1, iterate: "directly" });
    shape(built);

    expect(globalLoads(built.graph)).toContain(setClassName("int"));
  });

  it("lists a map that is iterated directly through its entries", () => {
    const built = build({ kind: "Map", key: "a", value: 1, iterate: "directly" });
    shape(built);

    expect(iteratedMember(built)).toBe("entries");
  });

  it("points a directly iterated map at its own class", () => {
    const built = build({ kind: "Map", key: "a", value: 1, iterate: "directly" });
    shape(built);

    expect(constructedName(built)).toBe(mapClassName("string", "int"));
  });
});

describe("collections a call answers", () => {
  function calling(returns: string): { callee: CFGFunction; rewrote: readonly CFGFunction[] } {
    const classes = buildClassTable([]);
    const callee = new CFGFunction("makeSet");
    callee.classes = classes;
    callee.declaredSignature = { params: [], returns };
    const madeIn = callee.addBlock();
    const global = madeIn.addNode(irLoadGlobal("Set"));
    madeIn.addNode(irReturn(madeIn.addNode(irGenericCall(global, []))));
    callee.rebuildUses();

    const caller = new CFGFunction("f");
    caller.classes = classes;
    const block = caller.addBlock();
    const call = block.addNode(irGenericCall(block.addNode(irLoadGlobal("makeSet")), []));
    const member = block.addNode(irGenericGetProp(call, "add"));
    const adding = irGenericCall(member, [call, block.addNode(irConstant(1))]);
    adding.props.isMethod = true;
    block.addNode(adding);
    block.addNode(irReturn(call));
    caller.rebuildUses();

    const units = [caller, callee].map((graph) => ({
      graph,
      types: new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
    }));
    return { callee, rewrote: shapeModuleCollections(units) };
  }

  it("seeds the caller from a call whose declared return names a collection", () => {
    const { rewrote } = calling("Set<int>");

    expect(rewrote.map((graph) => graph.name)).toContain("f");
  });

  it("leaves the caller alone when the declared return names no collection", () => {
    const { rewrote } = calling("int");

    expect(rewrote.map((graph) => graph.name)).not.toContain("f");
  });

  it("still shapes the callee that constructs the collection either way", () => {
    const { callee } = calling("Set<int>");

    expect(globalLoads(callee)).toContain(setClassName("int"));
  });
});
