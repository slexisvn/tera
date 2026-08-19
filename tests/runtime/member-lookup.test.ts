import { describe, expect, it } from "vitest";
import {
  getPayload,
  isFunction,
  mkArray,
  mkBool,
  mkDouble,
  mkFunction,
  mkGenerator,
  mkNull,
  mkObject,
  mkRegex,
  mkSmi,
  mkString,
  mkUndefined,
  type TaggedValue,
} from "../../src/core/value/index.js";
import { createJSArray, createJSObject } from "../../src/objects/heap/factory.js";
import { GeneratorObject } from "../../src/runtime/iteration/generator.js";
import { MicrotaskQueue } from "../../src/runtime/microtasks/microtask.js";
import { mkPromiseCapability } from "../../src/runtime/async/promise.js";
import { RegisterFrame } from "../../src/bytecode/register/interpreter/frame.js";
import {
  RegisterCompiledFunction,
  RegisterInstruction,
  ROP_RETURN,
} from "../../src/bytecode/register/ops/bytecode.js";
import {
  memberLookupValue,
  type MemberLookupInterpreter,
} from "../../src/runtime/member-lookup.js";

const PROTOTYPE_NAMES = [
  "arrayPrototype",
  "stringPrototype",
  "regexPrototype",
  "numberPrototype",
  "booleanPrototype",
] as const;

type Consulted = { prototype: string; propName: string };

const withPrototypes = () => {
  const consulted: Consulted[] = [];
  const markers = new Map<object, string>();
  const builtinPrototypes: Record<string, object> = {};
  for (const name of PROTOTYPE_NAMES) {
    const marker = {};
    markers.set(marker, name);
    builtinPrototypes[name] = marker;
  }
  const interpreter = {
    builtinPrototypes,
    _lookupBuiltinPrototype: (proto: object, propName: string) => {
      consulted.push({ prototype: markers.get(proto) ?? "unknown", propName });
      return mkString("resolved");
    },
    callFunctionValue: () => mkUndefined(),
    constructFunctionValue: () => mkUndefined(),
    exceptionToValue: () => mkUndefined(),
    microtaskQueue: new MicrotaskQueue(),
    runFrame: () => mkUndefined(),
    suspendedFrames: new Map(),
  } as unknown as MemberLookupInterpreter;
  return { interpreter, consulted };
};

const generatorValue = (): TaggedValue => {
  const compiled = new RegisterCompiledFunction("gen", 0);
  compiled.instructions.push(new RegisterInstruction(ROP_RETURN));
  const frame = new RegisterFrame(compiled, [], mkUndefined(), null);
  const resuming = {
    runFrame: () => mkUndefined(),
    suspendedFrames: new Map(),
  };
  return mkGenerator(new GeneratorObject(frame, resuming as never));
};

const promiseValue = (): TaggedValue => mkPromiseCapability(new MicrotaskQueue()).value;

describe("the member lookup registry", () => {
  it("routes each prototype-backed value kind to its own prototype", () => {
    const { interpreter, consulted } = withPrototypes();
    memberLookupValue(mkArray(createJSArray([mkSmi(1)])), "map", interpreter);
    memberLookupValue(mkString("hello"), "slice", interpreter);
    memberLookupValue(mkRegex(/ab/g), "test", interpreter);
    memberLookupValue(mkSmi(1), "to_fixed", interpreter);
    memberLookupValue(mkDouble(1.5), "to_fixed", interpreter);
    memberLookupValue(mkBool(true), "to_string", interpreter);
    expect(consulted).toEqual([
      { prototype: "arrayPrototype", propName: "map" },
      { prototype: "stringPrototype", propName: "slice" },
      { prototype: "regexPrototype", propName: "test" },
      { prototype: "numberPrototype", propName: "to_fixed" },
      { prototype: "numberPrototype", propName: "to_fixed" },
      { prototype: "booleanPrototype", propName: "to_string" },
    ]);
  });

  it("answers a value kind's own members without consulting a prototype", () => {
    const { interpreter, consulted } = withPrototypes();
    const array = mkArray(createJSArray([mkSmi(7), mkSmi(8)]));
    expect(memberLookupValue(array, "length", interpreter)).toEqual(mkSmi(2));
    expect(memberLookupValue(array, "1", interpreter)).toEqual(mkSmi(8));
    expect(memberLookupValue(array, "5", interpreter)).toEqual(mkUndefined());
    expect(memberLookupValue(mkString("hey"), "length", interpreter)).toEqual(mkSmi(3));
    expect(getPayload(memberLookupValue(mkString("hey"), "1", interpreter) as never)).toBe("e");
    expect(getPayload(memberLookupValue(mkRegex(/ab/g), "source", interpreter) as never)).toBe("ab");
    expect(consulted).toEqual([]);
  });

  it("resolves a promise member through the registry", () => {
    const { interpreter } = withPrototypes();
    expect(isFunction(memberLookupValue(promiseValue(), "then", interpreter) as never)).toBe(true);
    expect(isFunction(memberLookupValue(promiseValue(), "catch", interpreter) as never)).toBe(true);
  });

  it("resolves a generator member through the registry", () => {
    const { interpreter } = withPrototypes();
    expect(isFunction(memberLookupValue(generatorValue(), "next", interpreter) as never)).toBe(true);
  });

  it("resolves a function member through the registry", () => {
    const { interpreter } = withPrototypes();
    const fn = mkFunction({ name: "twice", compiled: null });
    expect(getPayload(memberLookupValue(fn, "name", interpreter) as never)).toBe("twice");
  });

  it("declines the kinds its callers resolve themselves", () => {
    const { interpreter } = withPrototypes();
    expect(memberLookupValue(mkObject(createJSObject()), "x", interpreter)).toBeNull();
    expect(memberLookupValue(mkNull(), "x", interpreter)).toBeNull();
    expect(memberLookupValue(mkUndefined(), "x", interpreter)).toBeNull();
  });

  it("declines a prototype member when no interpreter can supply prototypes", () => {
    expect(memberLookupValue(mkArray(createJSArray([])), "map", null)).toBeNull();
    expect(memberLookupValue(mkString("hello"), "slice", null)).toBeNull();
    expect(memberLookupValue(mkRegex(/ab/g), "test", null)).toBeNull();
    expect(memberLookupValue(mkSmi(1), "to_fixed", null)).toBeNull();
    expect(memberLookupValue(mkBool(true), "to_string", null)).toBeNull();
  });

  it("still answers own members when no interpreter is available", () => {
    expect(memberLookupValue(mkArray(createJSArray([mkSmi(4)])), "length", null)).toEqual(mkSmi(1));
    expect(memberLookupValue(mkString("hey"), "length", null)).toEqual(mkSmi(3));
  });

  it("answers undefined rather than declining when a coroutine member cannot settle", () => {
    expect(memberLookupValue(promiseValue(), "then", null)).toEqual(mkUndefined());
    expect(memberLookupValue(generatorValue(), "next", null)).toEqual(mkUndefined());
  });
});
