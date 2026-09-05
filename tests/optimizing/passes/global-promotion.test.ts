import { beforeEach, describe, expect, it } from "vitest";
import {
  irConstant,
  irLoadGlobal,
  irLoadLocal,
  irStoreGlobal,
  resetIRNodeIds,
  type CFGInstruction,
} from "../../../src/optimizing/ir/index.js";
import {
  declaredGlobalTypeOf,
  DECLARED_TYPE_PROP,
} from "../../../src/optimizing/passes/global-promotion.js";

beforeEach(() => resetIRNodeIds());

const VARIABLE = "total";
const DECLARED = "float[]";
const SLOT = 0;

function annotated(node: CFGInstruction, declared: unknown): CFGInstruction {
  node.props[DECLARED_TYPE_PROP] = declared;
  return node;
}

describe("the type a global access was declared with", () => {
  it("reads the type a store was given", () => {
    expect(declaredGlobalTypeOf(annotated(irStoreGlobal(VARIABLE, irConstant(1)), DECLARED))).toBe(
      DECLARED,
    );
  });

  it("reads the type a load was given", () => {
    expect(declaredGlobalTypeOf(annotated(irLoadGlobal(VARIABLE), DECLARED))).toBe(DECLARED);
  });

  it("answers nothing for a global the program wrote no type for", () => {
    expect(declaredGlobalTypeOf(irStoreGlobal(VARIABLE, irConstant(1)))).toBe(null);
  });

  it("answers nothing for a node that reads no global at all", () => {
    expect(declaredGlobalTypeOf(annotated(irLoadLocal(SLOT), DECLARED))).toBe(null);
  });

  it("answers nothing when what it carries is not a type name", () => {
    expect(declaredGlobalTypeOf(annotated(irLoadGlobal(VARIABLE), SLOT))).toBe(null);
  });
});
