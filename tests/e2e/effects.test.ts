import { describe, expect, it } from "vitest";
import * as mlfw from "@slexisvn/mlfw";
import { DataFrame } from "@slexisvn/query-engine";
import { Engine } from "../../src/index.js";
import { ASYNC_DOMAIN_TYPES } from "../../src/runtime/domain/metadata.js";

const printed = async (source: string) => {
  const out: string[] = [];
  const engine = new Engine({ output: (text: unknown) => out.push(String(text)) });
  await engine.runNative(source);
  return out.join("|");
};

function hasAsyncMethod(target: unknown): boolean {
  const prototype = (target as { prototype?: object }).prototype;
  if (!prototype) return false;
  return Object.getOwnPropertyNames(prototype).some((name) => {
    if (name === "constructor") return false;
    const value = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    return typeof value === "function" && /^async\b/.test(String(value));
  });
}

describe("effect analysis and implicit await", () => {
  it("keeps the declared async domain types in sync with the native classes", () => {
    const classes: Record<string, unknown> = { DataFrame, Trainer: (mlfw as Record<string, unknown>).Trainer };
    for (const [name, target] of Object.entries(classes)) {
      expect(ASYNC_DOMAIN_TYPES.has(name), `${name} is declared async`).toBe(true);
      expect(hasAsyncMethod(target), `${name} has async methods`).toBe(true);
    }
    const sync: Record<string, unknown> = { Linear: (mlfw as Record<string, unknown>).Linear, DataLoader: (mlfw as Record<string, unknown>).DataLoader };
    for (const [name, target] of Object.entries(sync)) {
      expect(ASYNC_DOMAIN_TYPES.has(name), `${name} is not declared async`).toBe(false);
      expect(hasAsyncMethod(target), `${name} has no async methods`).toBe(false);
    }
  });

  it("awaits a domain method without an await keyword", async () => {
    const source = [
      "df = DataFrame(a=[1, 2, 3])",
      "print(df.collect())",
    ].join("\n");
    expect(await printed(source)).toBe("[{ a: 1 }, { a: 2 }, { a: 3 }]");
  });

  it("propagates the effect through user functions", async () => {
    const source = [
      "fn load():",
      "  return DataFrame(a=[1, 2])",
      "",
      "fn rows():",
      "  return load().collect()",
      "",
      "print(rows())",
    ].join("\n");
    expect(await printed(source)).toBe("[{ a: 1 }, { a: 2 }]");
  });

  it("still honours an explicit await", async () => {
    const source = [
      "df = DataFrame(a=[7])",
      "print(await df.collect())",
    ].join("\n");
    expect(await printed(source)).toBe("[{ a: 7 }]");
  });

  it("leaves synchronous code untouched", async () => {
    const source = [
      "fn add(a, b):",
      "  return a + b",
      "print(add(2, 3))",
    ].join("\n");
    expect(await printed(source)).toBe("5");
  });

  it("converts a frame to a tensor and encodes labels", async () => {
    const source = [
      "df = DataFrame(a=[1.0, 2.0], b=[3.0, 4.0])",
      "print(df.to_tensor().shape)",
      "labels = DataFrame(kind=[\"x\", \"y\", \"x\"])",
      "encoded, classes = labels.encode(\"kind\")",
      "print(classes, encoded.shape)",
      "print(df.head(1).collect())",
    ].join("\n");
    expect(await printed(source)).toBe("[2, 2]|[x, y] [3]|[{ a: 1, b: 3 }]");
  });
});
