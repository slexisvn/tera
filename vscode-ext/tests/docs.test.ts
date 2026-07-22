import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHART_METADATA, DOMAIN_BUILTIN_METADATA } from "@slexisvn/tera";
import { CHART_METHOD_DOCS } from "../../notebook/src/chart/docs.ts";
import { extractBuiltinDocs } from "../scripts/extractors/builtin-docs.ts";
import languageData from "../language-data.json" with { type: "json" };
import type { LanguageData } from "../src/shared/language-data.ts";

const DOCS = resolve(import.meta.dirname, "../data/builtin-docs.md");
const docs = extractBuiltinDocs(DOCS);
const data = languageData as unknown as LanguageData;

const builtin = (name: string) => data.builtins.find((entry) => entry.name === name);

describe("builtin-docs.md", () => {
  it("ignores fenced format examples in the preamble", () => {
    expect(docs.builtins.has("name")).toBe(false);
  });

  it("documents every runtime builtin", () => {
    const undocumented = Object.keys(DOMAIN_BUILTIN_METADATA).filter((name) => !docs.builtins.has(name));
    expect(undocumented).toEqual([]);
  });

  it("leaves the chart namespace to the notebook's own docs", () => {
    expect(docs.builtins.has("chart")).toBe(false);
  });

  it("documents nothing the runtime does not define, except scope-local names", () => {
    const runtime = new Set(Object.keys(DOMAIN_BUILTIN_METADATA));
    const extra = [...docs.builtins.values()]
      .filter((doc) => doc.name !== "chart" && !runtime.has(doc.name))
      .map((doc) => `${doc.name}{${doc.kind}}`);
    expect(extra.sort()).toEqual(["log{step}", "print{global}"]);
  });

  it("never disagrees with the runtime about a builtin's kind", () => {
    const mismatched = [...docs.builtins.values()]
      .filter((doc) => doc.kind && DOMAIN_BUILTIN_METADATA[doc.name])
      .filter((doc) => doc.kind !== DOMAIN_BUILTIN_METADATA[doc.name].kind)
      .map((doc) => doc.name);
    expect(mismatched).toEqual([]);
  });
});

describe("generated language-data", () => {
  it("carries a description for every builtin", () => {
    expect(data.builtins.filter((entry) => !entry.description)).toEqual([]);
  });

  it("takes each builtin's kind from the runtime domain", () => {
    expect(builtin("Linear")?.kind).toBe("module");
    expect(builtin("SGD")?.kind).toBe("optimizer");
    expect(builtin("StepLR")?.kind).toBe("scheduler");
    expect(builtin("Trainer")?.kind).toBe("trainer");
    expect(builtin("EarlyStopping")?.kind).toBe("callback");
    expect(builtin("Accuracy")?.kind).toBe("metric");
    expect(builtin("cpu")?.kind).toBe("device");
    expect(builtin("f32")?.kind).toBe("dtype");
    expect(builtin("tensor")?.kind).toBe("factory");
  });

  it("injects kind-template methods into builtins of that kind", () => {
    expect(builtin("Linear")?.methods.map((m) => m.name)).toContain("forward");
    expect(builtin("SGD")?.methods.map((m) => m.name)).toEqual(["step", "zero_grad", "param_groups"]);
    expect(builtin("StandardScaler")?.methods.map((m) => m.name)).toContain("fit_transform");
  });

  it("prefers documented parameters over the runtime's generic ones", () => {
    expect(builtin("Linear")?.signature?.display).toBe("Linear(in: int, out: int, bias: boolean = true) -> Object");
  });

  it("renders dtype and device constants without a call signature", () => {
    expect(builtin("f32")?.signature?.display).toBe("f32");
    expect(builtin("cpu")?.signature?.display).toBe("cpu");
  });

  it("treats chart as a namespace, not a neural-net module", () => {
    const chart = builtin("chart");
    expect(chart?.kind).toBe("namespace");
    expect(chart?.methods.map((m) => m.name)).not.toContain("forward");
  });

  it("takes chart methods from the runtime and their prose from the notebook", () => {
    const chart = builtin("chart");
    expect(chart?.methods.map((m) => m.name)).toEqual(Object.keys(CHART_METADATA));
    expect(chart?.methods.find((m) => m.name === "line")?.description).toMatch(/line chart/i);
    expect(chart?.methods.find((m) => m.name === "bar")?.signature.display)
      .toBe('bar(data, x?, y?, color?, mode="grouped", title?) -> ChartSpec');
  });

  it("drops chart.figure, which the notebook documents but the runtime does not expose", () => {
    expect(CHART_METHOD_DOCS.has("figure")).toBe(true);
    expect(CHART_METADATA.figure).toBeUndefined();
    expect(builtin("chart")?.methods.map((m) => m.name)).not.toContain("figure");
  });

  it("exposes print, which the runtime defines outside the domain metadata", () => {
    expect(builtin("print")?.kind).toBe("global");
    expect(builtin("print")?.signature?.display).toBe("print(...values)");
  });

  it("keeps pseudo-type methods sourced from the docs", () => {
    expect(Object.keys(data.pseudoTypes).sort()).toEqual(
      ["Column", "DataFrame", "GroupedData", "List", "Map", "Model", "String", "Tensor"],
    );
    expect(data.pseudoTypes.Tensor.find((m) => m.name === "relu")?.returns).toBe("Tensor");
  });
});
