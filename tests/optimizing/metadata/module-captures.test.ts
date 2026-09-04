import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irLoadContextSlot,
  irReturn,
  irStoreContextSlot,
  resetIRNodeIds,
  IR_LOAD_CONTEXT_SLOT,
  IR_LOAD_GLOBAL,
  IR_STORE_CONTEXT_SLOT,
  IR_STORE_GLOBAL,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { createCompilationUnit, createModuleIR } from "../../../src/optimizing/compilation-unit.js";
import { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";
import { lowerModuleCaptures } from "../../../src/optimizing/metadata/module-captures.js";
import { cellKey } from "../../../src/runtime/intrinsics/global-cells.js";

beforeEach(() => resetIRNodeIds());

const ENTRY = "main";
const IMPORTED = "helper";
const IMPORTED_SPEC = "./lib.tera";
const VARIABLE = "total";
const SLOT = 0;

function compiledFunction(name: string, moduleSpec: string | null): RegisterCompiledFunction {
  const compiled = new RegisterCompiledFunction(name, 0);
  compiled.moduleSpec = moduleSpec;
  compiled.localNames = [VARIABLE];
  return compiled;
}

function nest(
  outer: RegisterCompiledFunction,
  inner: RegisterCompiledFunction,
  outerType: "local" | "upvalue",
): void {
  outer.constants.push(inner);
  inner.upvalues = [{ name: VARIABLE, outerType, outerSlot: SLOT }];
}

function readingGraph(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  block.addNode(irReturn(block.addNode(irLoadContextSlot(SLOT, "local"))));
  graph.rebuildUses();
  return graph;
}

function upvalueGraph(name: string): CFGFunction {
  const graph = new CFGFunction(name);
  const block = graph.addBlock();
  block.addNode(irReturn(block.addNode(irLoadContextSlot(SLOT, "upvalue"))));
  graph.rebuildUses();
  return graph;
}

function nodesOf(graph: CFGFunction): CFGInstruction[] {
  return graph.blocks.flatMap((block) => block.nodes);
}

function globalNamesIn(graph: CFGFunction, type: string): unknown[] {
  return nodesOf(graph)
    .filter((node) => node.type === type)
    .map((node) => node.props.name);
}

function moduleOf(
  entries: ReadonlyArray<{ graph: CFGFunction; compiled: RegisterCompiledFunction }>,
) {
  return createModuleIR(
    entries.map(({ graph, compiled }) => createCompilationUnit(graph, [], compiled)),
    "program",
  );
}

describe("lowerModuleCaptures over the entry module", () => {
  it("turns the entry's own context slot into a bare global", () => {
    const graph = readingGraph(ENTRY);
    const module = moduleOf([{ graph, compiled: compiledFunction(ENTRY, null) }]);

    expect(lowerModuleCaptures(module, ENTRY)).toBe(1);

    expect(globalNamesIn(graph, IR_LOAD_GLOBAL)).toEqual([VARIABLE]);
    expect(nodesOf(graph).some((node) => node.type === IR_LOAD_CONTEXT_SLOT)).toBe(false);
  });

  it("drops a write of undefined rather than spelling it as a global store", () => {
    const graph = new CFGFunction(ENTRY);
    const block = graph.addBlock();
    block.addNode(irStoreContextSlot(SLOT, block.addNode(irConstant(undefined)), "local"));
    block.addNode(irReturn(block.addNode(irConstant(0))));
    graph.rebuildUses();
    const module = moduleOf([{ graph, compiled: compiledFunction(ENTRY, null) }]);

    expect(lowerModuleCaptures(module, ENTRY)).toBe(1);

    expect(nodesOf(graph).some((node) => node.type === IR_STORE_CONTEXT_SLOT)).toBe(false);
    expect(globalNamesIn(graph, IR_STORE_GLOBAL)).toEqual([]);
  });

  it("answers nothing when no unit carries the entry's name", () => {
    const graph = readingGraph(ENTRY);
    const module = moduleOf([{ graph, compiled: compiledFunction(ENTRY, null) }]);

    expect(lowerModuleCaptures(module, "absent")).toBe(0);
    expect(nodesOf(graph).some((node) => node.type === IR_LOAD_CONTEXT_SLOT)).toBe(true);
  });
});

describe("lowerModuleCaptures over an imported module", () => {
  const imported = () => {
    const entryGraph = readingGraph(ENTRY);
    const importedGraph = readingGraph(IMPORTED);
    const module = moduleOf([
      { graph: entryGraph, compiled: compiledFunction(ENTRY, null) },
      { graph: importedGraph, compiled: compiledFunction(IMPORTED, IMPORTED_SPEC) },
    ]);
    return { entryGraph, importedGraph, module };
  };

  it("lowers the imported module's own top-level variable too", () => {
    const { importedGraph, module } = imported();

    expect(lowerModuleCaptures(module, ENTRY)).toBe(2);

    expect(nodesOf(importedGraph).some((node) => node.type === IR_LOAD_CONTEXT_SLOT)).toBe(false);
  });

  it("keys the imported variable by its module so it cannot collide with the entry's", () => {
    const { entryGraph, importedGraph, module } = imported();

    lowerModuleCaptures(module, ENTRY);

    expect(globalNamesIn(importedGraph, IR_LOAD_GLOBAL)).toEqual([
      cellKey(IMPORTED_SPEC, VARIABLE),
    ]);
    expect(globalNamesIn(entryGraph, IR_LOAD_GLOBAL)).toEqual([VARIABLE]);
    expect(globalNamesIn(importedGraph, IR_LOAD_GLOBAL)).not.toEqual(
      globalNamesIn(entryGraph, IR_LOAD_GLOBAL),
    );
  });
});

describe("lowerModuleCaptures over a function that captures its module", () => {
  const capturing = (spec: string | null, outerType: "local" | "upvalue" = "local") => {
    const scopeGraph = readingGraph(spec === null ? ENTRY : IMPORTED);
    const nestedGraph = upvalueGraph("counted");
    const scope = compiledFunction(spec === null ? ENTRY : IMPORTED, spec);
    const nested = compiledFunction("counted", spec);
    nest(scope, nested, outerType);
    const units = [
      { graph: scopeGraph, compiled: scope },
      { graph: nestedGraph, compiled: nested },
    ];
    if (spec !== null) {
      units.unshift({ graph: readingGraph(ENTRY), compiled: compiledFunction(ENTRY, null) });
    }
    return { nestedGraph, module: moduleOf(units) };
  };

  it("names an entry-level capture as the bare global it lowered to", () => {
    const { nestedGraph, module } = capturing(null);

    lowerModuleCaptures(module, ENTRY);

    expect(globalNamesIn(nestedGraph, IR_LOAD_GLOBAL)).toEqual([VARIABLE]);
  });

  it("names a capture of an imported module's variable by that module", () => {
    const { nestedGraph, module } = capturing(IMPORTED_SPEC);

    lowerModuleCaptures(module, ENTRY);

    expect(globalNamesIn(nestedGraph, IR_LOAD_GLOBAL)).toEqual([
      cellKey(IMPORTED_SPEC, VARIABLE),
    ]);
  });

  it("leaves a capture of something that is not a module scope alone", () => {
    const { nestedGraph, module } = capturing(IMPORTED_SPEC, "upvalue");

    lowerModuleCaptures(module, ENTRY);

    expect(nodesOf(nestedGraph).some((node) => node.type === IR_LOAD_CONTEXT_SLOT)).toBe(true);
    expect(globalNamesIn(nestedGraph, IR_LOAD_GLOBAL)).toEqual([]);
  });
});
