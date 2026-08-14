import { describe, it, expect } from "vitest";
import { materializeFrameValue } from "../../src/deopt/frame-materializer.js";
import {
  mkSmi,
  mkNumber,
  mkString,
  mkBool,
  mkUndefined,
  getPayload,
  isSmi,
  isString,
  isBool,
  isUndefined,
  isNumber,
} from "../../src/core/value/index.js";
import {
  IR_PHI,
  IR_TYPEOF,
  IR_LOAD_LOCAL,
  IR_STORE_LOCAL,
  IR_CHECK_SMI,
  IR_CHECK_NUMBER,
  IR_CONSTANT,
  IR_INT32_ADD,
  IR_GENERIC_ADD,
  IR_NEG,
  IR_NOT,
} from "../../src/optimizing/ir/index.js";

function makeIRNode(type, props = {}, inputs = []) {
  return { id: Math.floor(Math.random() * 100000), type, props, inputs };
}

describe("materializeFrameValue — F1 block param / typeof / locals", () => {
  it("materializes single-input IR_PHI as a trivial value", () => {
    const constant = makeIRNode(IR_CONSTANT, { value: 77 });
    const blockParam = makeIRNode(IR_PHI, {}, [constant]);
    const result = materializeFrameValue(blockParam, new Map(), [], null, null);
    expect(getPayload(result)).toBe(77);
  });

  it("materializes single-input IR_PHI with runtime value on inner node", () => {
    const inner = makeIRNode("SomeOp", {}, []);
    const blockParam = makeIRNode(IR_PHI, {}, [inner]);
    const rv = new Map([[inner.id, mkSmi(42)]]);
    const result = materializeFrameValue(blockParam, rv, [], null, null);
    expect(isSmi(result)).toBe(true);
    expect(getPayload(result)).toBe(42);
  });

  it("materializes non-trivial IR_PHI from its runtime value", () => {
    const left = makeIRNode(IR_CONSTANT, { value: 77 });
    const right = makeIRNode(IR_CONSTANT, { value: 88 });
    const blockParam = makeIRNode(IR_PHI, {}, [left, right]);
    const rv = new Map([[blockParam.id, mkSmi(99)]]);
    const result = materializeFrameValue(blockParam, rv, [], null, null);
    expect(getPayload(result)).toBe(99);
  });

  it("rejects non-trivial IR_PHI without runtime value", () => {
    const left = makeIRNode(IR_CONSTANT, { value: 77 });
    const right = makeIRNode(IR_CONSTANT, { value: 88 });
    const blockParam = makeIRNode(IR_PHI, {}, [left, right]);
    expect(() => materializeFrameValue(blockParam, new Map(), [], null, null)).toThrow(
      /Cannot materialize non-trivial Phi/,
    );
  });

  it("materializes IR_LOAD_LOCAL by recursing into inputs[0]", () => {
    const constant = makeIRNode(IR_CONSTANT, { value: 55 });
    const loadLocal = makeIRNode(IR_LOAD_LOCAL, { slot: 0 }, [constant]);
    const result = materializeFrameValue(loadLocal, new Map(), [], null, null);
    expect(getPayload(result)).toBe(55);
  });

  it("materializes IR_STORE_LOCAL by recursing into inputs[1]", () => {
    const slot = makeIRNode(IR_CONSTANT, { value: 0 });
    const val = makeIRNode(IR_CONSTANT, { value: 99 });
    const storeLocal = makeIRNode(IR_STORE_LOCAL, { slot: 0 }, [slot, val]);
    const result = materializeFrameValue(storeLocal, new Map(), [], null, null);
    expect(getPayload(result)).toBe(99);
  });

  it("materializes IR_TYPEOF with number input to 'number' string", () => {
    const numConst = makeIRNode(IR_CONSTANT, { value: 42 });
    const typeofNode = makeIRNode(IR_TYPEOF, {}, [numConst]);
    const result = materializeFrameValue(typeofNode, new Map(), [], null, null);
    expect(isString(result)).toBe(true);
    expect(getPayload(result)).toBe("number");
  });

  it("materializes IR_TYPEOF with string input to 'string'", () => {
    const strConst = makeIRNode(IR_CONSTANT, { value: "hello" });
    const typeofNode = makeIRNode(IR_TYPEOF, {}, [strConst]);
    const result = materializeFrameValue(typeofNode, new Map(), [], null, null);
    expect(isString(result)).toBe(true);
    expect(getPayload(result)).toBe("string");
  });

  it("materializes IR_TYPEOF with boolean input to 'boolean'", () => {
    const boolConst = makeIRNode(IR_CONSTANT, { value: true });
    const typeofNode = makeIRNode(IR_TYPEOF, {}, [boolConst]);
    const result = materializeFrameValue(typeofNode, new Map(), [], null, null);
    expect(isString(result)).toBe(true);
    expect(getPayload(result)).toBe("boolean");
  });

  it("materializes IR_TYPEOF with undefined input to 'undefined'", () => {
    const undefConst = makeIRNode(IR_CONSTANT, { value: undefined });
    const typeofNode = makeIRNode(IR_TYPEOF, {}, [undefConst]);
    const result = materializeFrameValue(typeofNode, new Map(), [], null, null);
    expect(isString(result)).toBe(true);
    expect(getPayload(result)).toBe("undefined");
  });

  it("materializes nested block param → check → constant chain", () => {
    const constant = makeIRNode(IR_CONSTANT, { value: 10 });
    const check = makeIRNode(IR_CHECK_SMI, {}, [constant]);
    const blockParam = makeIRNode(IR_PHI, {}, [check]);
    const result = materializeFrameValue(blockParam, new Map(), [], null, null);
    expect(getPayload(result)).toBe(10);
  });

  it("materializes IR_TYPEOF on runtime value resolved block param", () => {
    const inner = makeIRNode("SomeOp", {}, []);
    const blockParam = makeIRNode(IR_PHI, {}, [inner]);
    const typeofNode = makeIRNode(IR_TYPEOF, {}, [blockParam]);
    const rv = new Map([[inner.id, mkSmi(5)]]);
    const result = materializeFrameValue(typeofNode, rv, [], null, null);
    expect(isString(result)).toBe(true);
    expect(getPayload(result)).toBe("number");
  });
});

describe("materializeFrameValue — existing pass-through nodes", () => {
  it("materializes IR_CHECK_SMI by recursing inputs[0]", () => {
    const constant = makeIRNode(IR_CONSTANT, { value: 33 });
    const check = makeIRNode(IR_CHECK_SMI, {}, [constant]);
    const result = materializeFrameValue(check, new Map(), [], null, null);
    expect(getPayload(result)).toBe(33);
  });

  it("materializes IR_CHECK_NUMBER by recursing inputs[0]", () => {
    const constant = makeIRNode(IR_CONSTANT, { value: 3.14 });
    const check = makeIRNode(IR_CHECK_NUMBER, {}, [constant]);
    const result = materializeFrameValue(check, new Map(), [], null, null);
    expect(getPayload(result)).toBe(3.14);
  });
});
