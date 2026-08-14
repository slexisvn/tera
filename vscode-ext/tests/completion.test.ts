import { afterEach, describe, expect, it } from "vitest";
import { collectCompletions } from "../src/server/providers/completion.ts";
import { GEOMETRY, cleanupProjects, contextFor, projectFor, type ModuleProject } from "./provider-harness.ts";

function labels(source: string, line: number, character: number): string[] {
  return collectCompletions(contextFor(source), {
    textDocument: { uri: "file:///test.tera" },
    position: { line, character },
  }).items.map((item) => item.label);
}

function labelsAtEnd(source: string): string[] {
  const lines = source.split("\n");
  return labels(source, lines.length - 1, lines[lines.length - 1].length);
}

describe("completion", () => {
  it("includes class modifier keywords", () => {
    expect(labels("", 0, 0)).toEqual(expect.arrayContaining(["abstract", "public", "private", "protected"]));
  });

  it("filters inaccessible class members outside the declaring class", () => {
    const source = [
      "class Account:",
      "  private balance: int = 1",
      "  public owner: string = \"alice\"",
      "acc = Account()",
      "acc.",
    ].join("\n");

    const memberLabels = labels(source, 4, "acc.".length);
    expect(memberLabels).toContain("owner");
    expect(memberLabels).not.toContain("balance");
  });

  it("keeps private members visible inside the declaring class", () => {
    const source = [
      "class Account:",
      "  private balance: int = 1",
      "  public owner: string = \"alice\"",
      "  read():",
      "    this.",
    ].join("\n");

    const memberLabels = labels(source, 4, "    this.".length);
    expect(memberLabels).toEqual(expect.arrayContaining(["balance", "owner"]));
  });

  it("suggests members through private nullable class fields inside the declaring class", () => {
    const source = [
      "interface Image:",
      "  display() -> string",
      "class RealImage implements Image:",
      "  display() -> string:",
      "    return \"ok\"",
      "class ImageProxy implements Image:",
      "  private real: Image | null = null",
      "  display() -> string:",
      "    real = RealImage()",
      "    this.real = real",
      "    this.real.",
    ].join("\n");

    expect(labelsAtEnd(source)).toContain("display");
  });

  it("suggests primitive string methods", () => {
    const source = [
      "name: string = \"tera\"",
      "name.",
    ].join("\n");

    expect(labelsAtEnd(source)).toEqual(expect.arrayContaining(["to_upper_case", "split", "includes"]));
  });

  it("suggests primitive number and boolean methods", () => {
    expect(labelsAtEnd([
      "score: float = 3.14",
      "score.",
    ].join("\n"))).toEqual(expect.arrayContaining(["to_string", "to_fixed", "to_precision", "to_exponential", "value_of"]));

    expect(labelsAtEnd([
      "tally: int = 7",
      "tally.",
    ].join("\n"))).toEqual(expect.arrayContaining(["to_string", "to_fixed", "value_of"]));

    expect(labelsAtEnd([
      "ready: bool = true",
      "ready.",
    ].join("\n"))).toEqual(expect.arrayContaining(["to_string", "value_of"]));
  });

  it("suggests reactive signal members after reactive syntax declarations", () => {
    const memberLabels = labelsAtEnd([
      "signal tally = 1",
      "tally.",
    ].join("\n"));

    expect(memberLabels).toEqual(expect.arrayContaining(["set", "update", "subscribe", "dispose"]));
    expect(memberLabels).not.toContain("value");
  });

  it("suggests resource state members after reactive resource declarations", () => {
    const memberLabels = labelsAtEnd([
      "resource profile = 42",
      "profile.",
    ].join("\n"));

    expect(memberLabels).toEqual(expect.arrayContaining(["latest", "state", "loading", "error", "peek", "refetch", "mutate", "subscribe", "dispose"]));
    expect(memberLabels).not.toContain("value");
  });
});

describe("import completion", () => {
  afterEach(cleanupProjects);

  function importLabels(project: ModuleProject, relative: string, buffer: string): string[] {
    const uri = project.open(relative, buffer);
    const lines = buffer.split("\n");
    return collectCompletions(project.context, {
      textDocument: { uri },
      position: { line: lines.length - 1, character: lines[lines.length - 1]!.length },
    }).items.map((item) => item.label);
  }

  it("completes resolvable module specifiers after 'from'", () => {
    const project = projectFor(GEOMETRY);
    const suggestions = importLabels(project, "main.tera", "from ");

    expect(suggestions).toEqual(expect.arrayContaining(["mathx", "shapes"]));
  });

  it("completes module specifiers after 'import'", () => {
    const project = projectFor(GEOMETRY);
    expect(importLabels(project, "main.tera", "import ")).toEqual(expect.arrayContaining(["mathx", "shapes"]));
  });

  it("completes submodules after a package prefix", () => {
    const project = projectFor(GEOMETRY);
    expect(importLabels(project, "main.tera", "from shapes.")).toEqual(["area"]);
  });

  it("completes siblings after a relative dot", () => {
    const project = projectFor(GEOMETRY);
    expect(importLabels(project, "shapes/area.tera", "from .")).toEqual(["area"]);
  });

  it("completes only exported names after 'from X import'", () => {
    const project = projectFor(GEOMETRY);
    const suggestions = importLabels(project, "main.tera", "from mathx import ");

    expect(suggestions).toEqual(expect.arrayContaining(["abs_int", "max_int", "square"]));
    expect(suggestions).not.toContain("_negate");
  });

  it("completes re-exported names through a package index", () => {
    const project = projectFor(GEOMETRY);
    expect(importLabels(project, "main.tera", "from shapes import ")).toEqual(
      expect.arrayContaining(["square_area", "rect_area", "border_area"]),
    );
  });

  it("drops names already listed in the same import", () => {
    const project = projectFor(GEOMETRY);
    const suggestions = importLabels(project, "main.tera", "from mathx import abs_int, ");

    expect(suggestions).toContain("max_int");
    expect(suggestions).not.toContain("abs_int");
  });

  it("completes a namespace import's exports after a dot", () => {
    const project = projectFor(GEOMETRY);
    const suggestions = importLabels(project, "main.tera", "import shapes\nshapes.");

    expect(suggestions).toEqual(expect.arrayContaining(["square_area", "rect_area", "border_area"]));
  });

  it("keeps ordinary completions out of an import statement", () => {
    const project = projectFor(GEOMETRY);
    expect(importLabels(project, "main.tera", "from mathx import ")).not.toContain("tensor");
  });

  it("offers imported names as ordinary body completions", () => {
    const project = projectFor(GEOMETRY);
    const uri = project.open("main.tera", GEOMETRY["main.tera"]);
    const suggestions = collectCompletions(project.context, {
      textDocument: { uri },
      position: { line: 5, character: 2 },
    }).items;

    expect(suggestions.map((item) => item.label)).toEqual(
      expect.arrayContaining(["abs_int", "max_int", "border", "shapes"]),
    );
    expect(suggestions.find((item) => item.label === "border")?.detail).toBe("function of shapes.area");
    expect(suggestions.find((item) => item.label === "shapes")?.detail).toBe("module shapes");
  });

  it("completes names inside a parenthesised multi-line import", () => {
    const project = projectFor(GEOMETRY);
    const uri = project.open("main.tera", ["from mathx import (", "  abs_int,", "  "].join("\n"));
    const suggestions = collectCompletions(project.context, {
      textDocument: { uri },
      position: { line: 2, character: 2 },
    }).items.map((item) => item.label);

    expect(suggestions).toContain("max_int");
    expect(suggestions).not.toContain("abs_int");
    expect(suggestions).not.toContain("_negate");
  });
});
