import { afterEach, describe, expect, it } from "vitest";
import { computeDefinition } from "../src/server/providers/definition.ts";
import { GEOMETRY, cleanupProjects, contextFor, projectFor, type ModuleProject } from "./provider-harness.ts";

function jump(project: ModuleProject, relative: string, line: number, character: number) {
  return computeDefinition(project.context, {
    textDocument: { uri: project.uri(relative) },
    position: { line, character },
  });
}

describe("definition", () => {
  it("does not jump from an unknown member to a same-named parameter", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  embed = Embedding(vocab_size, embed_size)",
      "",
      "tok = Tokenizer()",
      "net = ChatBotLarge(tok.vocab_size, 8)",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 4, character: "net = ChatBotLarge(tok.vocab_size".length },
    });

    expect(location).toBeNull();
  });

  it("does not jump from a model parameter access that is not a runtime field", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  embed = Embedding(vocab_size, embed_size)",
      "",
      "net = ChatBotLarge(\"abc\", 8)",
      "net.vocab_size",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 4, character: "net.vocab_size".length },
    });

    expect(location).toBeNull();
  });

  it("jumps from a model field access to the body assignment", () => {
    const source = [
      "model ChatBotLarge(vocab_size: string, embed_size: int):",
      "  saved_vocab = vocab_size",
      "",
      "net = ChatBotLarge(\"abc\", 8)",
      "net.saved_vocab",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 4, character: "net.saved_vocab".length },
    });

    expect(location?.range.start).toEqual({ line: 1, character: 2 });
    expect(location?.range.end).toEqual({ line: 1, character: "  saved_vocab".length });
  });

  it("jumps from a comprehension variable use to the comprehension binding", () => {
    const source = [
      "interface ChatRow:",
      "  question: string",
      "  answer: string",
      "train_rows = load_csv(\"examples/chat_train.csv\").to_array<ChatRow>()",
      "train_q_text = [r.question for r of train_rows]",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 4, character: "train_q_text = [r".length },
    });

    const binding = "train_q_text = [r.question for ".length;
    expect(location?.range.start).toEqual({ line: 4, character: binding });
    expect(location?.range.end).toEqual({ line: 4, character: binding + 1 });
  });

  it("jumps from an interface member access to the field declaration", () => {
    const source = [
      "interface ChatRow:",
      "  question: string",
      "  answer: string",
      "train_rows = load_csv(\"examples/chat_train.csv\").to_array<ChatRow>()",
      "train_q_text = [r.question for r of train_rows]",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 4, character: "train_q_text = [r.question".length },
    });

    expect(location?.range.start).toEqual({ line: 1, character: 2 });
    expect(location?.range.end).toEqual({ line: 1, character: "  question".length });
  });

  it("jumps from a this-member access to the class field declaration, not the constructor assignment", () => {
    const source = [
      "class Report:",
      "  public title: string",
      "  public sections: string[]",
      "  constructor(title: string, sections: string[]):",
      "    this.title = title",
      "    this.sections = sections",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 5, character: "    this.sections".length },
    });

    expect(location?.range.start).toEqual({ line: 2, character: "  public ".length });
    expect(location?.range.end).toEqual({ line: 2, character: "  public sections".length });
  });

  it("jumps from a super constructor call to the base constructor", () => {
    const source = [
      "class Handler:",
      "  constructor(next: RequestHandler | null = null):",
      "    this.next = next",
      "  handle(request: string) -> string:",
      "    return request",
      "class CacheHandler extends Handler:",
      "  constructor(next: RequestHandler | null = null):",
      "    super(next)",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 7, character: "    super".length },
    });

    expect(location?.range.start).toEqual({ line: 1, character: 2 });
    expect(location?.range.end).toEqual({ line: 1, character: "  constructor".length });
  });

  it("jumps from super member access to the inherited method declaration", () => {
    const source = [
      "class Handler:",
      "  protected handle(request: string) -> string:",
      "    return request",
      "class CacheHandler extends Handler:",
      "  handle(request: string) -> string:",
      "    return super.handle(request)",
    ].join("\n");
    const context = contextFor(source);

    const fromSuper = computeDefinition(context, {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 5, character: "    return super".length },
    });
    const fromMethod = computeDefinition(context, {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 5, character: "    return super.handle".length },
    });

    expect(fromSuper?.range.start).toEqual({ line: 1, character: "  protected ".length });
    expect(fromSuper?.range.end).toEqual({ line: 1, character: "  protected handle".length });
    expect(fromMethod?.range.start).toEqual({ line: 1, character: "  protected ".length });
    expect(fromMethod?.range.end).toEqual({ line: 1, character: "  protected handle".length });
  });

  it("does not treat object literal keys as variable references", () => {
    const source = [
      "async fn fetch_user(id: int):",
      "  return { id: id, name: `user-${id}` }",
    ].join("\n");
    const context = contextFor(source);

    const key = computeDefinition(context, {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 1, character: "  return { id".length },
    });
    const value = computeDefinition(context, {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 1, character: "  return { id: id".length },
    });

    expect(key).toBeNull();
    expect(value?.range.start).toEqual({ line: 0, character: "async fn fetch_user(".length });
    expect(value?.range.end).toEqual({ line: 0, character: "async fn fetch_user(id".length });
  });

  it("does not jump from quoted string literal text to a same-named symbol", () => {
    const source = [
      "a = tensor(0)",
      "print('a')",
    ].join("\n");

    const location = computeDefinition(contextFor(source), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 1, character: "print('a".length },
    });

    expect(location).toBeNull();
  });
});

describe("definition across modules", () => {
  afterEach(cleanupProjects);

  it("jumps from an import specifier to the declaration in the owning module", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const location = jump(project, "main.tera", 1, "from mathx import abs_int".length);

    expect(location?.uri).toBe(project.uri("mathx.tera"));
    expect(location?.range).toEqual({
      start: { line: 3, character: "fn ".length },
      end: { line: 3, character: "fn abs_int".length },
    });
  });

  it("jumps from an aliased import to the original declaration", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const onAlias = jump(project, "main.tera", 2, "from shapes.area import border_area as border".length);

    expect(onAlias?.uri).toBe(project.uri("shapes/area.tera"));
    expect(onAlias?.range.start).toEqual({ line: 8, character: "fn ".length });
  });

  it("opens the package index from a module path segment", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const onPackage = jump(project, "main.tera", 2, "from shapes".length);
    const onSubmodule = jump(project, "main.tera", 2, "from shapes.area".length);

    expect(onPackage?.uri).toBe(project.uri("shapes/__init__.tera"));
    expect(onSubmodule?.uri).toBe(project.uri("shapes/area.tera"));
  });

  it("opens the module named by a plain import", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const location = jump(project, "main.tera", 0, "import shapes".length);

    expect(location?.uri).toBe(project.uri("shapes/__init__.tera"));
    expect(location?.range.start).toEqual({ line: 0, character: 0 });
  });

  it("follows a parent-relative import path from inside a package", () => {
    const project = projectFor(GEOMETRY, ["shapes/area.tera"]);
    const location = jump(project, "shapes/area.tera", 0, "from ..mathx".length);

    expect(location?.uri).toBe(project.uri("mathx.tera"));
  });

  it("follows a re-export chain through the package index", () => {
    const project = projectFor({
      ...GEOMETRY,
      "main.tera": "from shapes import square_area\nprint(square_area(2))\n",
    }, ["main.tera"]);
    const location = jump(project, "main.tera", 0, "from shapes import square_area".length);

    expect(location?.uri).toBe(project.uri("shapes/area.tera"));
    expect(location?.range).toEqual({
      start: { line: 2, character: "fn ".length },
      end: { line: 2, character: "fn square_area".length },
    });
  });

  it("jumps from a body use of an imported name, not only from the import line", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const location = jump(project, "main.tera", 5, "  return shapes.square_area(4) + border".length);

    expect(location?.uri).toBe(project.uri("shapes/area.tera"));
    expect(location?.range.start).toEqual({ line: 8, character: "fn ".length });
  });

  it("jumps from a namespace member access to the exporting module", () => {
    const project = projectFor(GEOMETRY, ["main.tera"]);
    const location = jump(project, "main.tera", 5, "  return shapes.square_area".length);

    expect(location?.uri).toBe(project.uri("shapes/area.tera"));
    expect(location?.range.start).toEqual({ line: 2, character: "fn ".length });
  });

  it("returns nothing for a module path that does not resolve", () => {
    const project = projectFor({ ...GEOMETRY, "main.tera": "from nowhere import thing\n" }, ["main.tera"]);
    expect(jump(project, "main.tera", 0, "from nowhere".length)).toBeNull();
  });
});
