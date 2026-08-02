import { describe, expect, it } from "vitest";
import { collectCompletions } from "../src/server/providers/completion.ts";
import { contextFor } from "./provider-harness.ts";

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
