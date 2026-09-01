import { describe, it, expect } from "vitest";
import { nativeToTagged, registerHostType } from "../../../src/runtime/domain/host.js";
import { getPayload, isObject, type ObjectValue } from "../../../src/core/value/index.js";

class FakeTensor {
  argmax(_axis?: number, _keep?: boolean): number {
    return 0;
  }
  requiresGrad(_flag?: boolean): this {
    return this;
  }
  not_in_the_spec(): number {
    return 0;
  }
}

class DerivedTensor extends FakeTensor {}

class UnregisteredHost {
  argmax(_axis?: number): number {
    return 0;
  }
}

registerHostType(FakeTensor, "Tensor");
registerHostType(class Unknown {}, "NotAPseudoType");

function methodMetadata(value: object, name: string) {
  const wrapped = nativeToTagged(value);
  expect(isObject(wrapped)).toBe(true);
  const method = getPayload(wrapped as ObjectValue).getProperty(name);
  expect(method).toBeDefined();
  return getPayload(method!).metadata;
}

describe("host method metadata", () => {
  it("carries the parameter names the language spec declares", () => {
    expect(methodMetadata(new FakeTensor(), "argmax")?.params?.map((param) => param.name)).toEqual([
      "axis",
      "keep",
    ]);
  });

  it("matches a camelCase host method to its snake_case spec name", () => {
    expect(methodMetadata(new FakeTensor(), "requires_grad")?.params?.map((param) => param.name)).toEqual(["flag"]);
  });

  it("resolves the owner through a subclass", () => {
    expect(methodMetadata(new DerivedTensor(), "argmax")?.params?.map((param) => param.name)).toEqual([
      "axis",
      "keep",
    ]);
  });

  it("leaves a method the spec does not describe without metadata", () => {
    expect(methodMetadata(new FakeTensor(), "not_in_the_spec")).toBeUndefined();
  });

  it("leaves an unregistered host type without metadata", () => {
    expect(methodMetadata(new UnregisteredHost(), "argmax")).toBeUndefined();
  });
});
