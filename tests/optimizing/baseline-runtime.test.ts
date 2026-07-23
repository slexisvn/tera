import { describe, it, expect } from "vitest";
import { BaselineRuntime } from "../../src/optimizing/baseline/runtime.js";
import { RegisterCompiledFunction } from "../../src/bytecode/register/ops/bytecode.js";
import {
  mkSmi,
  mkDouble,
  mkBool,
  mkString,
  mkUndefined,
  mkNull,
  mkArray,
  mkObject,
  mkFunction,
  getPayload,
  isSmi,
  isDouble,
  isBool,
  isString,
  isFunction,
  toNumber,
} from "../../src/core/value/index.js";
import { createJSObject, createJSArray } from "../../src/objects/heap/factory.js";
import { Engine } from "../../src/api/engine.js";

function makeRuntime() {
  const fn = new RegisterCompiledFunction("test", 0);
  fn.constants = ["x", "y", 42, "hello"];
  fn.feedbackVector = null;
  const interp = {
    icManager: { getOrCreate: () => ({ lookup: () => ({ hit: false }), lookupCall: () => {}, lookupForWrite: () => {} }) },
    globalCells: new Map(),
    callFunctionValue: () => mkUndefined(),
    constructFunctionValue: () => mkUndefined(),
  };
  return new BaselineRuntime(fn, interp);
}

describe("BaselineRuntime", () => {
  describe("constant wrapping (wc/c)", () => {
    it("wraps number constants as smi or double", () => {
      const rt = makeRuntime();
      rt.consts = [42, 3.14];
      const smi = rt.wc(0);
      const dbl = rt.wc(1);
      expect(isSmi(smi)).toBe(true);
      expect(getPayload(smi)).toBe(42);
      expect(isDouble(dbl)).toBe(true);
      expect(getPayload(dbl)).toBeCloseTo(3.14);
    });

    it("wraps string/boolean/null/undefined", () => {
      const rt = makeRuntime();
      rt.consts = ["hello", true, null, undefined];
      expect(isString(rt.wc(0))).toBe(true);
      expect(getPayload(rt.wc(0))).toBe("hello");
      expect(isBool(rt.wc(1))).toBe(true);
      expect(getPayload(rt.wc(1))).toBe(true);
    });

    it("c() caches constants — same index returns same tagged value", () => {
      const rt = makeRuntime();
      rt.consts = [99];
      const a = rt.c(0);
      const b = rt.c(0);
      expect(a).toBe(b);
    });

    it("wraps integer constants beyond the smi range without truncating", () => {
      const rt = makeRuntime();
      rt.consts = [1e10, 2147483648, 4294967295, -2147483649];
      expect(getPayload(rt.wc(0))).toBe(1e10);
      expect(getPayload(rt.wc(1))).toBe(2147483648);
      expect(getPayload(rt.wc(2))).toBe(4294967295);
      expect(getPayload(rt.wc(3))).toBe(-2147483649);
    });
  });

  describe("arithmetic (add/sub/mul/div/mod)", () => {
    it("smi + smi → smi when result fits", () => {
      const rt = makeRuntime();
      const result = rt.add(mkSmi(3), mkSmi(4), -1);
      expect(isSmi(result)).toBe(true);
      expect(getPayload(result)).toBe(7);
    });

    it("smi + smi → double on overflow", () => {
      const rt = makeRuntime();
      const result = rt.add(mkSmi(2147483647), mkSmi(1), -1);
      expect(toNumber(result)).toBe(2147483648);
    });

    it("string + anything → string concatenation", () => {
      const rt = makeRuntime();
      const result = rt.add(mkString("foo"), mkSmi(1), -1);
      expect(isString(result)).toBe(true);
      expect(getPayload(result)).toBe("foo1");
    });

    it("sub: smi - smi → smi", () => {
      const rt = makeRuntime();
      const result = rt.sub(mkSmi(10), mkSmi(3), -1);
      expect(getPayload(result)).toBe(7);
    });

    it("mul: smi * smi → smi when fits", () => {
      const rt = makeRuntime();
      const result = rt.mul(mkSmi(6), mkSmi(7), -1);
      expect(getPayload(result)).toBe(42);
    });

    it("div: produces smi for integer result, double otherwise", () => {
      const rt = makeRuntime();
      const exact = rt.div(mkSmi(10), mkSmi(2), -1);
      expect(isSmi(exact)).toBe(true);
      expect(getPayload(exact)).toBe(5);

      const frac = rt.div(mkSmi(7), mkSmi(2), -1);
      expect(toNumber(frac)).toBe(3.5);
    });

    it("mod: smi % smi → smi", () => {
      const rt = makeRuntime();
      const result = rt.mod(mkSmi(10), mkSmi(3), -1);
      expect(getPayload(result)).toBe(1);
    });

    it("mod: double fallback when divisor is 0", () => {
      const rt = makeRuntime();
      const result = rt.mod(mkSmi(10), mkSmi(0), -1);
      expect(toNumber(result)).toBeNaN();
    });
  });

  describe("comparison (eq/neq/cmp)", () => {
    it("eq: same smi values → true", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.eq(mkSmi(5), mkSmi(5), -1))).toBe(true);
      expect(getPayload(rt.eq(mkSmi(5), mkSmi(6), -1))).toBe(false);
    });

    it("eq: same string values → true", () => {
      const rt = makeRuntime();
      const a = mkString("abc");
      const b = mkString("abc");
      expect(getPayload(rt.eq(a, b, -1))).toBe(true);
    });

    it("eq: null == undefined → true", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.eq(mkNull(), mkUndefined(), -1))).toBe(true);
      expect(getPayload(rt.eq(mkNull(), mkNull(), -1))).toBe(true);
    });

    it("neq: different values → true", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.neq(mkSmi(1), mkSmi(2), -1))).toBe(true);
      expect(getPayload(rt.neq(mkSmi(1), mkSmi(1), -1))).toBe(false);
    });

    it("cmp: all four comparison operators (lt/gt/lte/gte)", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.cmp(mkSmi(1), mkSmi(2), 0, -1))).toBe(true);   
      expect(getPayload(rt.cmp(mkSmi(2), mkSmi(1), 1, -1))).toBe(true);   
      expect(getPayload(rt.cmp(mkSmi(2), mkSmi(2), 2, -1))).toBe(true);   
      expect(getPayload(rt.cmp(mkSmi(2), mkSmi(2), 3, -1))).toBe(true);   
      expect(getPayload(rt.cmp(mkSmi(2), mkSmi(1), 0, -1))).toBe(false);  
    });

    it("cmp: string comparison is lexicographic", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.cmp(mkString("a"), mkString("b"), 0, -1))).toBe(true);
      expect(getPayload(rt.cmp(mkString("b"), mkString("a"), 0, -1))).toBe(false);
    });
  });

  describe("unary ops (not/neg/typeof)", () => {
    it("not: inverts truthiness", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.not(mkBool(true), -1))).toBe(false);
      expect(getPayload(rt.not(mkBool(false), -1))).toBe(true);
      expect(getPayload(rt.not(mkSmi(0), -1))).toBe(true);
      expect(getPayload(rt.not(mkSmi(1), -1))).toBe(false);
    });

    it("neg: negates number", () => {
      const rt = makeRuntime();
      expect(toNumber(rt.neg(mkSmi(5), -1))).toBe(-5);
      expect(toNumber(rt.neg(mkDouble(3.14), -1))).toBeCloseTo(-3.14);
    });

    it("typeofOp: returns correct type strings", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.typeofOp(mkSmi(1)))).toBe("number");
      expect(getPayload(rt.typeofOp(mkString("hi")))).toBe("string");
      expect(getPayload(rt.typeofOp(mkBool(true)))).toBe("boolean");
      expect(getPayload(rt.typeofOp(mkUndefined()))).toBe("undefined");
    });
  });

  describe("bitwise ops", () => {
    it("bitand/bitor/bitxor compute correctly", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.bitand(mkSmi(0b1100), mkSmi(0b1010), -1))).toBe(0b1000);
      expect(getPayload(rt.bitor(mkSmi(0b1100), mkSmi(0b1010), -1))).toBe(0b1110);
      expect(getPayload(rt.bitxor(mkSmi(0b1100), mkSmi(0b1010), -1))).toBe(0b0110);
    });

    it("shl/shr/ushr shift correctly", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.shl(mkSmi(1), mkSmi(3), -1))).toBe(8);
      expect(getPayload(rt.shr(mkSmi(8), mkSmi(2), -1))).toBe(2);
      expect(getPayload(rt.ushr(mkSmi(-1), mkSmi(28), -1))).toBe(15);
    });

    it("bitnot flips bits", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.bitnot(mkSmi(0), -1))).toBe(-1);
      expect(getPayload(rt.bitnot(mkSmi(5), -1))).toBe(-6);
    });

    it("pow computes exponentiation", () => {
      const rt = makeRuntime();
      expect(getPayload(rt.pow(mkSmi(2), mkSmi(10), -1))).toBe(1024);
    });
  });

  describe("loose equality", () => {
    it("looseEq: null == undefined → true", () => {
      const rt = makeRuntime();
      expect(rt.looseEq(mkNull(), mkUndefined(), -1)).toBe(rt.t);
    });

    it("looseNeq: 1 != '1' depends on abstract equality algorithm", () => {
      const rt = makeRuntime();
      const result = rt.looseNeq(mkSmi(1), mkString("2"), -1);
      expect(isBool(result)).toBe(true);
    });
  });

  describe("utility methods", () => {
    it("isNullish: null and undefined → true, others → false", () => {
      const rt = makeRuntime();
      expect(rt.isNullish(mkNull())).toBe(true);
      expect(rt.isNullish(mkUndefined())).toBe(true);
      expect(rt.isNullish(mkSmi(0))).toBe(false);
      expect(rt.isNullish(mkString(""))).toBe(false);
    });

    it("getLength: returns length of arrays and strings", () => {
      const rt = makeRuntime();
      const arr = mkArray(createJSArray([mkSmi(1), mkSmi(2), mkSmi(3)]));
      expect(getPayload(rt.getLength(arr))).toBe(3);

      const str = mkString("hello");
      expect(getPayload(rt.getLength(str))).toBe(5);
    });

    it("getKeys: returns enumerable property names of object", () => {
      const rt = makeRuntime();
      const obj = createJSObject();
      obj.setProperty("a", mkSmi(1));
      obj.setProperty("b", mkSmi(2));
      const keys = rt.getKeys(mkObject(obj));
      const arr = getPayload(keys);
      expect(arr.getLength()).toBe(2);
    });

    it("newObj/newArr: create tagged object/array values", () => {
      const rt = makeRuntime();
      const obj = rt.newObj();
      const arr = rt.newArr([mkSmi(1), mkSmi(2)]);
      expect(getPayload(obj)).toBeDefined();
      expect(getPayload(arr).getLength()).toBe(2);
    });

    it("restArgs: extracts rest parameters from register array", () => {
      const rt = makeRuntime();
      const regs = [mkSmi(1), mkSmi(2), mkSmi(3), mkSmi(4)];
      const rest = rt.restArgs(regs, 2, 4);
      const arr = getPayload(rest);
      expect(arr.getLength()).toBe(2);
      expect(getPayload(arr.getIndex(0))).toBe(3);
      expect(getPayload(arr.getIndex(1))).toBe(4);
    });

    it("copyProps: copies enumerable properties from source to target", () => {
      const rt = makeRuntime();
      const src = createJSObject();
      src.setProperty("x", mkSmi(10));
      src.setProperty("y", mkSmi(20));
      const tgt = createJSObject();
      rt.copyProps(mkObject(tgt), mkObject(src));
      expect(tgt.getProperty("x")).toBe(mkSmi(10));
      expect(tgt.getProperty("y")).toBe(mkSmi(20));
    });

    it("newRegex: creates regex from constant", () => {
      const rt = makeRuntime();
      rt.consts = [{ pattern: "abc", flags: "g" }];
      const regex = rt.newRegex(0);
      const re = getPayload(regex);
      const native = re.nativeRegex || re;
      expect(native.source).toBe("abc");
      expect(native.flags).toBe("g");
    });
  });
});

describe("BaselineRuntime gp() prototype and property lookups", () => {
  function makeEngineRuntime(constantNames) {
    const engine = new Engine();
    engine.run("0;");
    const fn = new RegisterCompiledFunction("gpTest", 0);
    fn.constants = constantNames;
    fn.feedbackVector = null;
    return new BaselineRuntime(fn, engine.interpreter);
  }

  describe("array prototype methods", () => {
    it("resolves push on an array", () => {
      const rt = makeEngineRuntime(["push"]);
      const arr = mkArray(createJSArray([mkSmi(1)]));
      const result = rt.gp(arr, 0, 0);
      expect(isFunction(result)).toBe(true);
    });

    it("resolves slice on an array", () => {
      const rt = makeEngineRuntime(["slice"]);
      const arr = mkArray(createJSArray([mkSmi(1), mkSmi(2)]));
      const result = rt.gp(arr, 0, 0);
      expect(isFunction(result)).toBe(true);
    });

    it("resolves join on an array", () => {
      const rt = makeEngineRuntime(["join"]);
      const arr = mkArray(createJSArray([]));
      const result = rt.gp(arr, 0, 0);
      expect(isFunction(result)).toBe(true);
    });

    it("returns length as smi for arrays", () => {
      const rt = makeEngineRuntime(["length"]);
      const arr = mkArray(createJSArray([mkSmi(1), mkSmi(2), mkSmi(3)]));
      const result = rt.gp(arr, 0, 0);
      expect(isSmi(result)).toBe(true);
      expect(getPayload(result)).toBe(3);
    });

    it("returns element by numeric index string", () => {
      const rt = makeEngineRuntime(["1"]);
      const arr = mkArray(createJSArray([mkSmi(10), mkSmi(20)]));
      const result = rt.gp(arr, 0, 0);
      expect(getPayload(result)).toBe(20);
    });
  });

  describe("string prototype methods", () => {
    it("resolves charAt on a string", () => {
      const rt = makeEngineRuntime(["char_at"]);
      const str = mkString("hello");
      const result = rt.gp(str, 0, 0);
      expect(isFunction(result)).toBe(true);
    });

    it("resolves indexOf on a string", () => {
      const rt = makeEngineRuntime(["index_of"]);
      const str = mkString("abc");
      const result = rt.gp(str, 0, 0);
      expect(isFunction(result)).toBe(true);
    });

    it("returns length as smi for strings", () => {
      const rt = makeEngineRuntime(["length"]);
      const str = mkString("hello");
      const result = rt.gp(str, 0, 0);
      expect(isSmi(result)).toBe(true);
      expect(getPayload(result)).toBe(5);
    });

    it("returns character by numeric index string", () => {
      const rt = makeEngineRuntime(["2"]);
      const str = mkString("abc");
      const result = rt.gp(str, 0, 0);
      expect(isString(result)).toBe(true);
      expect(getPayload(result)).toBe("c");
    });
  });

  describe("function property access", () => {
    it("resolves own properties on a function object", () => {
      const rt = makeEngineRuntime(["myProp"]);
      const fn = { name: "test", properties: { myProp: mkSmi(42) } };
      const tagged = mkFunction(fn);
      const result = rt.gp(tagged, 0, 0);
      expect(isSmi(result)).toBe(true);
      expect(getPayload(result)).toBe(42);
    });

    it("returns undefined for missing function properties", () => {
      const rt = makeEngineRuntime(["missing"]);
      const fn = { name: "test", properties: {} };
      const tagged = mkFunction(fn);
      const result = rt.gp(tagged, 0, 0);
      expect(getPayload(result)).toBeUndefined();
    });

    it("auto-creates prototype property on a function", () => {
      const rt = makeEngineRuntime(["prototype"]);
      const fn = { name: "Ctor", properties: {} };
      const tagged = mkFunction(fn);
      const result = rt.gp(tagged, 0, 0);
      expect(getPayload(result)).toBeDefined();
      expect(fn.prototypeObj).toBeDefined();
    });
  });
});

describe("baseline inline caches are isolated per function (not by name)", () => {
  it("redefining same-named function with a different object shape does not pollute IC", () => {
    const engine = new Engine({
      tieringPolicy: { jitThreshold: 99999, baselineThreshold: 2 },
    });
    engine.run(`
      fn f():
        o = { a: 1 }
        return o.a
      r = 0
      for k of range(60):
        r = f()
    `);
    const second = engine.runValue(
      `
        fn f():
          o = { p: 0, q: 11 }
          return o.p * o.q + o.p
        r = 0
        for k of range(60):
          r = f()
        r
      `,
    ).value;
    expect(second).toBe(0);
  });

  it("two distinct hot functions with the same name keep separate property caches", () => {
    const engine = new Engine({
      tieringPolicy: { jitThreshold: 99999, baselineThreshold: 2 },
    });
    engine.run(`
      fn g():
        o = { x: 5 }
        return o.x
      for k of range(60):
        g()
    `);
    expect(
      engine.runValue(
        `
          fn g():
            o = { y: 9, z: 7 }
            return o.y + o.z
          r = 0
          for k of range(60):
            r = g()
          r
        `,
      ).value,
    ).toBe(16);
  });
});

describe("baseline compiler bails to interpreter on unsupported opcodes", () => {
  const run = (src) => {
    const engine = new Engine({
      tieringPolicy: { jitThreshold: 99999, baselineThreshold: 2 },
    });
    return engine.runValue(src).value;
  };

  it("object-rest destructuring stays correct past the baseline threshold", () => {
    expect(
      run(
        `function f(o){var {a,...rest}=o;return a+Object.keys(rest).length;}
         var s=0;for(var i=0;i<10;i++)s=f({a:i,b:1,c:2});return s;`,
      ),
    ).toBe(11);
  });

  it("array-rest destructuring stays correct past the baseline threshold", () => {
    expect(
      run(
        `function f(arr){var [x,...y]=arr;return x+y.length;}
         var s=0;for(var i=0;i<10;i++)s=f([i,1,2,3]);return s;`,
      ),
    ).toBe(12);
  });

  it("arguments object stays correct past the baseline threshold", () => {
    expect(
      run(
        `function f(){var t=0;for(var i=0;i<arguments.length;i++)t+=arguments[i];return t;}
         var s=0;for(var i=0;i<10;i++)s=f(1,2,3);return s;`,
      ),
    ).toBe(6);
  });
});
