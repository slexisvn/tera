import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irConstant,
  irGenericCall,
  irGenericGetIndex,
  irGenericGetProp,
  irGenericSetProp,
  irNewObject,
  irReturn,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import { AnalysisManager } from "../../../src/optimizing/infra/analysis-manager.js";
import {
  createAnalysisRegistry,
  typeInferenceAnalysisId,
} from "../../../src/optimizing/analyses/index.js";
import {
  buildClassTable,
  VALUE_CLASS_PROP,
} from "../../../src/optimizing/metadata/class-table.js";
import { shapeObjectLiterals } from "../../../src/optimizing/passes/object-literal-shapes.js";

beforeEach(() => resetIRNodeIds());

function shape(graph: CFGFunction): number {
  return shapeObjectLiterals(
    graph,
    new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId),
  );
}

function adoptedField(graph: CFGFunction, record: CFGInstruction, name: string): string | null {
  const held = record.props[VALUE_CLASS_PROP];
  if (typeof held !== "number") return null;
  return graph.classes!.shapeById(held)?.fields.get(name)?.declaredType ?? null;
}

function holding(params: readonly string[]): CFGFunction {
  const graph = new CFGFunction("rows");
  graph.declaredSignature = { params: [...params], returns: null };
  graph.classes = buildClassTable([]);
  return graph;
}

function recordOf(
  graph: CFGFunction,
  name: string,
  build: (block: ReturnType<CFGFunction["addBlock"]>) => CFGInstruction,
): CFGInstruction {
  const block = graph.addBlock();
  const value = build(block);
  const record = block.addNode(irNewObject());
  block.addNode(irGenericSetProp(record, name, value));
  block.addNode(irReturn(record));
  graph.rebuildUses();
  return record;
}

describe("shapeObjectLiterals over values whose type inference cannot name", () => {
  it("types a field read out of a string array by the array's element type", () => {
    const graph = holding(["string[]"]);
    const names = graph.addParameter(0);
    const record = recordOf(graph, "n", (block) =>
      block.addNode(irGenericGetIndex(names, block.addNode(irConstant(0)))),
    );

    shape(graph);

    expect(adoptedField(graph, record, "n")).toBe("string");
  });

  it("shapes the literal that holds an element read rather than leaving it generic", () => {
    const graph = holding(["string[]"]);
    const names = graph.addParameter(0);
    recordOf(graph, "n", (block) =>
      block.addNode(irGenericGetIndex(names, block.addNode(irConstant(0)))),
    );

    expect(shape(graph)).toBe(1);
  });

  it("types a field copied out of a member of another array's element", () => {
    const graph = holding(["Row[]"]);
    graph.classes = buildClassTable([
      {
        name: "Row",
        parent: null,
        abstract: false,
        members: [
          {
            name: "n",
            declaredType: "string",
            member: "field",
            owner: "Row",
            abstract: false,
            visibility: "public",
            static: false,
          },
        ],
        constructorParams: [],
        constructorParamNames: [],
      },
    ]);
    const rows = graph.addParameter(0);
    const record = recordOf(graph, "n", (block) =>
      block.addNode(
        irGenericGetProp(
          block.addNode(irGenericGetIndex(rows, block.addNode(irConstant(0)))),
          "n",
        ),
      ),
    );

    shape(graph);

    expect(adoptedField(graph, record, "n")).toBe("string");
  });

  it("types a field holding what a builtin method answers on an element", () => {
    const graph = holding(["string[]"]);
    const names = graph.addParameter(0);
    const record = recordOf(graph, "n", (block) => {
      const element = block.addNode(irGenericGetIndex(names, block.addNode(irConstant(0))));
      const callee = block.addNode(irGenericGetProp(element, "trim"));
      const call = block.addNode(irGenericCall(callee, [element]));
      call.props.isMethod = true;
      return call;
    });

    shape(graph);

    expect(adoptedField(graph, record, "n")).toBe("string");
  });

  it("types a field holding a builtin getter read off an element", () => {
    const graph = holding(["string[]"]);
    const names = graph.addParameter(0);
    const record = recordOf(graph, "size", (block) =>
      block.addNode(
        irGenericGetProp(
          block.addNode(irGenericGetIndex(names, block.addNode(irConstant(0)))),
          "length",
        ),
      ),
    );

    shape(graph);

    expect(adoptedField(graph, record, "size")).toBe("int");
  });

  it("names a field the literal leaves empty as an absent one", () => {
    const graph = holding([]);
    const record = recordOf(graph, "note", (block) => block.addNode(irConstant(null)));

    shape(graph);

    expect(adoptedField(graph, record, "note")).toBe("null");
  });

  it("gives a literal pushed into a declared array that array's element shape", () => {
    const graph = new CFGFunction("collect");
    graph.declaredSignature = { params: ["Row[]"], returns: null };
    graph.classes = buildClassTable([
      {
        name: "Row",
        parent: null,
        abstract: false,
        members: [
          {
            name: "score",
            declaredType: "int",
            member: "field",
            owner: "Row",
            abstract: false,
            visibility: "public",
            static: false,
          },
        ],
        constructorParams: [],
        constructorParamNames: [],
      },
    ]);
    const rows = graph.addParameter(0);
    const block = graph.addBlock();
    const record = block.addNode(irNewObject());
    block.addNode(irGenericSetProp(record, "score", block.addNode(irConstant(1.5))));
    const call = block.addNode(
      irGenericCall(block.addNode(irGenericGetProp(rows, "push")), [rows, record]),
    );
    call.props.isMethod = true;
    block.addNode(irReturn(rows));
    graph.rebuildUses();

    shape(graph);

    expect(graph.classes.shapeById(Number(record.props[VALUE_CLASS_PROP]))?.name).toBe("Row");
  });

  it("leaves a literal unshaped when nothing can name what it holds", () => {
    const graph = holding([null as unknown as string]);
    const unknown = graph.addParameter(0);
    const record = recordOf(graph, "n", () => unknown);

    shape(graph);

    expect(record.props[VALUE_CLASS_PROP]).toBeUndefined();
  });
});
