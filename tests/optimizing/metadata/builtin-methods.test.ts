import { describe, expect, it } from "vitest";
import {
  builtinMethodCallMetadata,
  builtinMethodIntrinsicByName,
  builtinMethodIntrinsicFor,
  qualifiedMethodName,
  BUILTIN_METHOD_DECLARATIONS,
} from "../../../src/optimizing/metadata/builtin-methods.js";
import {
  anyType,
  arrayType,
  booleanType,
  objectType,
  smiType,
  stringType,
} from "../../../src/optimizing/types/lattice.js";
import { EFFECT_READ } from "../../../src/optimizing/ir/index.js";
import { builtinMethod } from "../../../src/frontend/checker/type-system.js";
import { builtinMethodImplementation } from "../../../src/runtime/intrinsics/builtin-methods.js";
import { mkString, type TaggedValue } from "../../../src/core/value/index.js";

const CHAR_CODE_AT = qualifiedMethodName("string", "char_code_at");

const RECEIVER_SAMPLES: Record<string, TaggedValue> = { string: mkString("sample") };

describe("qualifiedMethodName", () => {
  it("joins the owner and the method name", () => {
    expect(qualifiedMethodName("string", "char_code_at")).toBe("string.char_code_at");
  });
});

describe("builtinMethodIntrinsicByName", () => {
  it("resolves a declared intrinsic", () => {
    const intrinsic = builtinMethodIntrinsicByName(CHAR_CODE_AT);

    expect(intrinsic).not.toBeNull();
    expect(intrinsic!.owner).toBe("string");
    expect(intrinsic!.name).toBe("char_code_at");
    expect(intrinsic!.qualifiedName).toBe(CHAR_CODE_AT);
  });

  it("takes the arity and the types from the language spec", () => {
    const spec = builtinMethod("string", "char_code_at")!;
    const intrinsic = builtinMethodIntrinsicByName(CHAR_CODE_AT)!;

    expect(intrinsic.argCount).toBe(spec.signature.positional.length + 1);
    expect(intrinsic.signature.returns).toBe(spec.returns);
    expect(intrinsic.signature.params).toEqual([
      "string",
      ...spec.signature.positional.map((param) => spec.signature.params.get(param)!.type),
    ]);
  });

  it("counts the receiver as the first argument", () => {
    const intrinsic = builtinMethodIntrinsicByName(CHAR_CODE_AT)!;

    expect(intrinsic.argCount).toBe(intrinsic.signature.params.length);
  });

  it("returns null for a method that is not declared as an intrinsic", () => {
    expect(builtinMethodIntrinsicByName(qualifiedMethodName("string", "trim"))).toBeNull();
    expect(builtinMethodIntrinsicByName(qualifiedMethodName("Array", "char_code_at"))).toBeNull();
    expect(builtinMethodIntrinsicByName("char_code_at")).toBeNull();
  });
});

describe("BUILTIN_METHOD_DECLARATIONS", () => {
  it("backs every declaration with a member the language spec declares", () => {
    for (const declaration of BUILTIN_METHOD_DECLARATIONS) {
      expect(builtinMethod(declaration.owner, declaration.name), declaration.name).not.toBeNull();
    }
  });

  it("takes the getter flag from the spec instead of the declaration", () => {
    for (const declaration of BUILTIN_METHOD_DECLARATIONS) {
      const qualified = qualifiedMethodName(declaration.owner, declaration.name);
      expect(builtinMethodIntrinsicByName(qualified)!.getter, qualified).toBe(
        builtinMethod(declaration.owner, declaration.name)!.getter,
      );
    }
  });

  it("registers every declaration", () => {
    for (const declaration of BUILTIN_METHOD_DECLARATIONS) {
      const qualified = qualifiedMethodName(declaration.owner, declaration.name);
      expect(builtinMethodIntrinsicByName(qualified), qualified).not.toBeNull();
    }
  });

  it("backs every declared method with a runtime implementation", () => {
    for (const declaration of BUILTIN_METHOD_DECLARATIONS) {
      const qualified = qualifiedMethodName(declaration.owner, declaration.name);
      if (builtinMethodIntrinsicByName(qualified)!.getter) continue;
      const receiver = RECEIVER_SAMPLES[declaration.owner];
      expect(receiver, declaration.owner).toBeDefined();
      expect(
        builtinMethodImplementation(declaration.owner, declaration.name, receiver!),
        declaration.name,
      ).not.toBeNull();
    }
  });

  it("gives a getter no arguments beyond its receiver", () => {
    for (const declaration of BUILTIN_METHOD_DECLARATIONS) {
      const intrinsic = builtinMethodIntrinsicByName(
        qualifiedMethodName(declaration.owner, declaration.name),
      )!;
      if (!intrinsic.getter) continue;
      expect(intrinsic.argCount, intrinsic.qualifiedName).toBe(1);
      expect(intrinsic.signature.params, intrinsic.qualifiedName).toEqual([declaration.owner]);
    }
  });
});

describe("builtinMethodIntrinsicFor", () => {
  it("resolves an intrinsic from a string receiver type", () => {
    expect(builtinMethodIntrinsicFor(stringType(), "char_code_at")?.qualifiedName).toBe(
      CHAR_CODE_AT,
    );
  });

  it("rejects receiver types that do not own the method", () => {
    for (const receiver of [smiType(), booleanType(), arrayType(null), objectType(null)]) {
      expect(builtinMethodIntrinsicFor(receiver, "char_code_at")).toBeNull();
    }
  });

  it("rejects a receiver whose type is unknown", () => {
    expect(builtinMethodIntrinsicFor(anyType(), "char_code_at")).toBeNull();
  });

  it("rejects a method the string owner does not declare", () => {
    expect(builtinMethodIntrinsicFor(stringType(), "not_a_method")).toBeNull();
  });
});

describe("builtinMethodCallMetadata", () => {
  it("marks a pure intrinsic as a readonly read", () => {
    const props = builtinMethodCallMetadata(builtinMethodIntrinsicByName(CHAR_CODE_AT)!);

    expect(props.effectKind).toBe(EFFECT_READ);
    expect(props.pure).toBe(true);
    expect(props.readonly).toBe(true);
    expect(props.builtin).toBe(true);
  });

  it("carries the declared signature so callers can type the result", () => {
    const intrinsic = builtinMethodIntrinsicByName(CHAR_CODE_AT)!;
    const props = builtinMethodCallMetadata(intrinsic);
    const target = props.target as { declaredSignature: { returns: string; params: string[] } };

    expect(target.declaredSignature.returns).toBe(intrinsic.signature.returns);
    expect(target.declaredSignature.params).toEqual(intrinsic.signature.params);
  });

  it("copies the signature so a graph cannot mutate the registry", () => {
    const intrinsic = builtinMethodIntrinsicByName(CHAR_CODE_AT)!;
    const props = builtinMethodCallMetadata(intrinsic);
    const target = props.target as { declaredSignature: { params: string[] } };

    target.declaredSignature.params[0] = "mutated";

    expect(builtinMethodIntrinsicByName(CHAR_CODE_AT)!.signature.params[0]).toBe("string");
  });
});
