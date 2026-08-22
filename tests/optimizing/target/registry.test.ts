import { describe, expect, it } from "vitest";
import {
  BackendRegistry,
  UnknownBackendError,
} from "../../../src/optimizing/target/registry.js";
import type { CodeBackend } from "../../../src/optimizing/target/backend.js";

function backendOf(id: string): CodeBackend {
  return {
    id,
    mode: "aot",
    target: {
      name: id,
      capabilities: new Set(),
      speculation: { allows: () => false },
      abi: null,
      machineReprOf: () => "pointer",
    },
    loweringPipeline: () => [],
  } as unknown as CodeBackend;
}

describe("resolving a backend by id", () => {
  it("hands back the backend that was registered under the id", () => {
    const registry = new BackendRegistry();
    const backend = backendOf("c");
    registry.register(backend);

    expect(registry.resolve("c")).toBe(backend);
  });

  it("reports whether an id has a backend", () => {
    const registry = new BackendRegistry();
    registry.register(backendOf("c"));

    expect(registry.has("c")).toBe(true);
    expect(registry.has("x64-windows")).toBe(false);
  });

  it("throws an UnknownBackendError naming the id nothing was registered under", () => {
    const registry = new BackendRegistry();

    expect(() => registry.resolve("riscv64")).toThrow(UnknownBackendError);
    expect(() => registry.resolve("riscv64")).toThrow('No backend registered with id "riscv64"');
  });

  it("keeps the error catchable as a plain Error and names it", () => {
    const registry = new BackendRegistry();
    let caught: unknown;
    try {
      registry.resolve("absent");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("UnknownBackendError");
  });

  it("replaces a backend when a second one claims the same id", () => {
    const registry = new BackendRegistry();
    const first = backendOf("c");
    const second = backendOf("c");
    registry.register(first);
    registry.register(second);

    expect(registry.resolve("c")).toBe(second);
    expect([...registry.list()]).toEqual([second]);
  });

  it("lists every registered backend in registration order", () => {
    const registry = new BackendRegistry();
    const ids = ["c", "x64-windows", "riscv64"];
    for (const id of ids) registry.register(backendOf(id));

    expect([...registry.list()].map((backend) => backend.id)).toEqual(ids);
  });

  it("lists nothing before anything is registered", () => {
    expect([...new BackendRegistry().list()]).toEqual([]);
  });

  it("resolves every backend it lists", () => {
    const registry = new BackendRegistry();
    for (const id of ["c", "x64-windows"]) registry.register(backendOf(id));

    for (const backend of registry.list()) {
      expect(registry.has(backend.id)).toBe(true);
      expect(registry.resolve(backend.id)).toBe(backend);
    }
  });

  it("keeps two registries from seeing each other's backends", () => {
    const one = new BackendRegistry();
    const other = new BackendRegistry();
    one.register(backendOf("c"));

    expect(other.has("c")).toBe(false);
  });
});
