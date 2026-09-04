import { beforeEach, describe, expect, it } from "vitest";
import {
  CFGFunction,
  irCallKnownFunction,
  irConstant,
  irGenericGetProp,
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
  FIELD_TYPE_PROP,
  literalShapeSurface,
  VALUE_CLASS_PROP,
} from "../../../src/optimizing/metadata/class-table.js";
import {
  declaredTypeNameOf,
  fieldDeclaredType,
} from "../../../src/optimizing/metadata/call-signatures.js";
import type { TypeInference } from "../../../src/optimizing/analyses/type-inference.js";

beforeEach(() => resetIRNodeIds());

const FIELD = "held";
const FIELD_TYPE = "int | null";

interface Fixture {
  readonly graph: CFGFunction;
  readonly block: CFGFunction["blocks"][number];
  readonly types: TypeInference;
}

function fixture(params: string[] = []): Fixture {
  const graph = new CFGFunction("reads");
  graph.classes = buildClassTable([]);
  graph.declaredSignature = { params, returns: "int" };
  const block = graph.addBlock();
  return {
    graph,
    block,
    get types() {
      graph.rebuildUses();
      return new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId);
    },
  };
}

function shapedRecord(graph: CFGFunction, block: CFGFunction["blocks"][number]): CFGInstruction {
  const shape = graph.classes!.defineSynthetic(
    literalShapeSurface([{ name: FIELD, declaredType: FIELD_TYPE }]),
  );
  const record = block.addNode(irNewObject([]));
  record.props[VALUE_CLASS_PROP] = shape.id;
  return record;
}

function nameOf(value: CFGInstruction, fixed: Fixture): string | null {
  return declaredTypeNameOf(value, fixed.graph, fixed.graph.classes!, fixed.types);
}

describe("fieldDeclaredType", () => {
  it("reads a field's declared type off the shape its receiver holds", () => {
    const fixed = fixture();
    const record = shapedRecord(fixed.graph, fixed.block);
    const read = fixed.block.addNode(irGenericGetProp(record, FIELD));

    expect(fieldDeclaredType(read, fixed.graph.classes!, fixed.types)).toBe(FIELD_TYPE);
  });

  it("answers nothing for a member the shape does not carry", () => {
    const fixed = fixture();
    const record = shapedRecord(fixed.graph, fixed.block);
    const read = fixed.block.addNode(irGenericGetProp(record, "missing"));

    expect(fieldDeclaredType(read, fixed.graph.classes!, fixed.types)).toBeNull();
  });

  it("answers nothing for a value that is not a member read at all", () => {
    const fixed = fixture();
    const held = fixed.block.addNode(irConstant(1));

    expect(fieldDeclaredType(held, fixed.graph.classes!, fixed.types)).toBeNull();
  });
});

describe("declaredTypeNameOf", () => {
  it("prefers the type an earlier pass stamped on the value itself", () => {
    const fixed = fixture();
    const record = shapedRecord(fixed.graph, fixed.block);
    const read = fixed.block.addNode(irGenericGetProp(record, FIELD));
    read.props[FIELD_TYPE_PROP] = "string";

    expect(nameOf(read, fixed)).toBe("string");
  });

  it("falls back to the field the receiver's shape declares", () => {
    const fixed = fixture();
    const record = shapedRecord(fixed.graph, fixed.block);
    const read = fixed.block.addNode(irGenericGetProp(record, FIELD));

    expect(nameOf(read, fixed)).toBe(FIELD_TYPE);
  });

  it("reads a parameter's type off the signature the function declares", () => {
    const fixed = fixture(["string | undefined", "int"]);
    const first = fixed.graph.addParameter(0);
    const second = fixed.graph.addParameter(1);
    fixed.block.addNode(irReturn(second));

    expect(nameOf(first, fixed)).toBe("string | undefined");
    expect(nameOf(second, fixed)).toBe("int");
  });

  it("answers nothing for a parameter the signature does not name", () => {
    const fixed = fixture(["int"]);
    const beyond = fixed.graph.addParameter(1);

    expect(nameOf(beyond, fixed)).toBeNull();
  });

  it("reads a resolved call's type off the signature its callee declares", () => {
    const fixed = fixture();
    const call = fixed.block.addNode(
      irCallKnownFunction({ name: "held", declaredSignature: { params: [], returns: "float" } }, []),
    );

    expect(nameOf(call, fixed)).toBe("float");
  });

  it("answers nothing for a value that names no declared type anywhere", () => {
    const fixed = fixture();
    const held = fixed.block.addNode(irConstant(1));

    expect(nameOf(held, fixed)).toBeNull();
  });
});
