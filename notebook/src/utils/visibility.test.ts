import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { analyzeCells } from "../services/diagnostics";
import { notebookHoverDocFor } from "./codemirror-tera";
import { makeCompletionSource } from "./completion";
import { highlightHtml } from "./highlight";
import { analyzeNotebookSource } from "./source-analysis";

const cellId = "cell";

function analysisFor(source: string) {
  return analyzeNotebookSource([{ id: cellId, source }]);
}

function completionLabels(source: string, pos = source.length): string[] {
  const state = EditorState.create({ doc: source });
  const context = new CompletionContext(state, pos, true);
  return makeCompletionSource([], () => analysisFor(source), cellId)(context)?.options.map((item) => item.label) ?? [];
}

describe("notebook visibility modifiers", () => {
  it("highlights visibility keywords", () => {
    expect(highlightHtml("private balance: int = 1")).toContain('<span class="tok-kw">private</span>');
    expect(highlightHtml("protected value: int")).toContain('<span class="tok-kw">protected</span>');
    expect(highlightHtml("public read()")).toContain('<span class="tok-kw">public</span>');
    expect(highlightHtml("abstract class Exporter:")).toContain('<span class="tok-kw">abstract</span>');
  });

  it("completes abstract as a class modifier keyword", () => {
    expect(completionLabels("")).toEqual(expect.arrayContaining(["abstract"]));
  });

  it("filters private members from completion outside the declaring class", () => {
    const source = [
      "class Account:",
      "  private balance: int = 1",
      "  public owner: string = \"alice\"",
      "acc = Account()",
      "acc.",
    ].join("\n");

    const labels = completionLabels(source);
    expect(labels).toContain("owner");
    expect(labels).not.toContain("balance");
  });

  it("keeps private members in completion inside the declaring class", () => {
    const source = [
      "class Account:",
      "  private balance: int = 1",
      "  public owner: string = \"alice\"",
      "  read():",
      "    this.",
    ].join("\n");

    expect(completionLabels(source)).toEqual(expect.arrayContaining(["balance", "owner"]));
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

    expect(completionLabels(source)).toContain("display");
  });

  it("suggests and hovers primitive string methods", () => {
    const source = [
      "name: string = \"tera\"",
      "name.",
    ].join("\n");
    const hoverSource = [
      "name: string = \"tera\"",
      "name.to_upper_case()",
    ].join("\n");
    const analysis = () => analysisFor(hoverSource);
    const from = hoverSource.lastIndexOf("to_upper_case");

    expect(completionLabels(source)).toEqual(expect.arrayContaining(["to_upper_case", "split", "includes"]));
    expect(notebookHoverDocFor(hoverSource, "to_upper_case", from, { analysis, cellId })).toMatchObject({
      title: "string.to_upper_case",
      description: "type: () -> string",
    });
  });

  it("suggests and hovers primitive number and boolean methods", () => {
    const numberSource = [
      "score: float = 3.14",
      "score.",
    ].join("\n");
    const boolSource = [
      "ready: bool = true",
      "ready.",
    ].join("\n");
    const numberHover = [
      "score: float = 3.14",
      "score.to_fixed(2)",
    ].join("\n");
    const boolHover = [
      "ready: bool = true",
      "ready.to_string()",
    ].join("\n");

    expect(completionLabels(numberSource)).toEqual(expect.arrayContaining(["to_string", "to_fixed", "to_precision", "to_exponential", "value_of"]));
    expect(completionLabels(boolSource)).toEqual(expect.arrayContaining(["to_string", "value_of"]));
    expect(notebookHoverDocFor(numberHover, "to_fixed", numberHover.lastIndexOf("to_fixed"), { analysis: () => analysisFor(numberHover), cellId })).toMatchObject({
      title: "float.to_fixed",
      description: "type: (int) -> string",
    });
    expect(notebookHoverDocFor(boolHover, "to_string", boolHover.lastIndexOf("to_string"), { analysis: () => analysisFor(boolHover), cellId })).toMatchObject({
      title: "bool.to_string",
      description: "type: () -> string",
    });
  });

  it("hides private member hover outside the declaring class", () => {
    const source = [
      "class Account:",
      "  private balance: int = 1",
      "acc = Account()",
      "acc.balance",
    ].join("\n");
    const from = source.lastIndexOf("balance");

    expect(notebookHoverDocFor(source, "balance", from, { analysis: () => analysisFor(source), cellId })).toBeNull();
  });

  it("shows super and inherited method hover inside subclasses", () => {
    const source = [
      "interface RequestHandler:",
      "  handle(request: string) -> string",
      "class Handler implements RequestHandler:",
      "  constructor(next: RequestHandler | null = null):",
      "    this.next = next",
      "  handle(request: string) -> string:",
      "    return request",
      "class CacheHandler extends Handler:",
      "  constructor(next: RequestHandler | null = null):",
      "    super(next)",
      "  handle(request: string) -> string:",
      "    return super.handle(request)",
    ].join("\n");
    const analysis = () => analysisFor(source);
    const superFrom = source.indexOf("super(next)");
    const methodFrom = source.indexOf("handle(request: string) -> string:", source.indexOf("class CacheHandler"));
    const inheritedFrom = source.lastIndexOf("handle(request)");

    expect(notebookHoverDocFor(source, "super", superFrom, { analysis, cellId })).toMatchObject({
      title: "super",
      description: "type: Handler",
    });
    expect(notebookHoverDocFor(source, "handle", methodFrom, { analysis, cellId })).toMatchObject({
      title: "handle",
      description: "type: (string) -> string",
    });
    expect(notebookHoverDocFor(source, "handle", inheritedFrom, { analysis, cellId })).toMatchObject({
      title: "Handler.handle",
      description: "type: (string) -> string",
    });
  });

  it("shows protected inherited method hover through super inside subclasses", () => {
    const source = [
      "class Handler:",
      "  protected handle(request: string) -> string:",
      "    return request",
      "class CacheHandler extends Handler:",
      "  read(request: string) -> string:",
      "    return super.handle(request)",
    ].join("\n");
    const analysis = () => analysisFor(source);
    const inheritedFrom = source.lastIndexOf("handle(request)");

    expect(notebookHoverDocFor(source, "handle", inheritedFrom, { analysis, cellId })).toMatchObject({
      title: "Handler.handle",
      description: "type: (string) -> string",
    });
  });

  it("reports private member diagnostics", () => {
    const source = [
      "class Account:",
      "  private balance: int = 1",
      "acc = Account()",
      "acc.balance",
    ].join("\n");

    expect(analyzeCells([{ id: cellId, source }]).get(cellId)?.map((diagnostic) => diagnostic.message)).toEqual([
      "Cannot access private member 'balance' of 'Account'",
    ]);
  });

  it("ranges missing member-call argument diagnostics on the method name", () => {
    const source = [
      "interface Notifier:",
      "  send(message: string) -> string",
      "class PlainNotifier implements Notifier:",
      "  send(message: string) -> string:",
      "    return message",
      "class SmsDecorator implements Notifier:",
      "  private next: Notifier = PlainNotifier()",
      "  constructor(next: Notifier):",
      "    this.next = next",
      "  send(message: string) -> string:",
      "    return this.next.send()",
    ].join("\n");
    const diagnostic = analyzeCells([{ id: cellId, source }]).get(cellId)?.[0];
    const from = source.lastIndexOf("send()");

    expect(diagnostic).toMatchObject({
      from,
      to: from + "send".length,
      message: "Missing required argument 'arg0' for send()",
    });
  });
});
