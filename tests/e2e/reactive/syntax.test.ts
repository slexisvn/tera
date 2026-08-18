import { describe, expect, it } from "vitest";
import { createReactiveCheckOptions, createReactiveTeraExtension, createReactiveTeraOptions, REACTIVE_TERA_EXTENSION_NAME, REACTIVE_TERA_SYNTAX_PLUGIN_NAME, reactiveCheckerMetadata, reactiveSyntaxPlugin } from "@slexisvn/reactive/tera";
import { Engine, diagnoseSource, inferSymbolTypes, nativeToTagged, parse, taggedToNative, type ASTNode, type ParserContext } from "../../../src/index.js";

const converters = { nativeToTagged, taggedToNative };

type TestToken = {
  type: string;
  value: unknown;
  line: number;
  column: number;
};

class TestContext {
  pos = 0;

  constructor(private readonly tokens: TestToken[]) {}

  current(): TestToken {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1];
  }

  peek(offset = 1): TestToken {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }

  advance(): TestToken {
    return this.tokens[this.pos++];
  }

  check(type: string, value?: unknown): boolean {
    const token = this.current();
    return token.type === type && (value === undefined || token.value === value);
  }

  expect(type: string, value?: unknown): TestToken {
    if (!this.check(type, value)) throw new Error("unexpected token");
    return this.advance();
  }

  tokenString(token: TestToken): string {
    return String(token.value);
  }

  parseExpression() {
    const token = this.advance();
    return { type: "Literal", value: token.value, kind: "number" };
  }

  parseBlock() {
    this.expect("Punctuator", ":");
    return { type: "BlockStatement", body: [] };
  }

  withSpan<T>(node: T): T {
    return node;
  }
}

function token(type: string, value: unknown): TestToken {
  return { type, value, line: 1, column: 1 };
}

function statementsOf(ast: ASTNode): ASTNode[] {
  return ast.body as ASTNode[];
}

function assignmentValue(statement: ASTNode): ASTNode {
  return (statement.expression as ASTNode).value as ASTNode;
}

function callArg(node: ASTNode, index: number): ASTNode {
  return ((node as { args: ASTNode[] }).args)[index];
}

describe("Tera reactive syntax", () => {
  it("lowers signal declarations to Signal calls", () => {
    const context = new TestContext([
      token("Identifier", "signal"),
      token("Identifier", "price"),
      token("Punctuator", "="),
      token("Number", 100),
      token("EOF", ""),
    ]) as unknown as ParserContext;

    const result = reactiveSyntaxPlugin().parseStatement?.(context);

    expect(result).toMatchObject({
      type: "ExpressionStatement",
      expression: {
        type: "AssignmentExpression",
        target: { type: "Identifier", name: "price" },
        value: {
          type: "CallExpression",
          callee: { type: "Identifier", name: "Signal" },
        },
      },
    });
  });

  it("lowers effect blocks to effect calls", () => {
    const context = new TestContext([
      token("Identifier", "effect"),
      token("Punctuator", ":"),
      token("EOF", ""),
    ]) as unknown as ParserContext;

    const result = reactiveSyntaxPlugin().parseStatement?.(context);

    expect(result).toMatchObject({
      type: "ExpressionStatement",
      expression: {
        type: "CallExpression",
        callee: { type: "Identifier", name: "effect" },
      },
    });
  });

  it("exports checker metadata for host integration", () => {
    expect(reactiveCheckerMetadata.builtins?.map((builtin) => builtin.name)).toEqual([
      "Signal",
      "signal",
      "computed",
      "resource",
      "effect",
      "batch",
      "untrack",
      "watch",
      "root",
      "cleanup",
    ]);
    expect(reactiveCheckerMetadata.interfaces?.map((iface) => iface.name)).toEqual(["ReactiveSignal", "ReactiveComputed", "ReactiveResource"]);
    expect(reactiveCheckerMetadata.interfaces?.[0].fields).toMatchObject({
      value: { type: "T" },
      set: { type: "(value: T) -> ReactiveSignal<T>" },
      update: { type: "(update: (T) -> T) -> ReactiveSignal<T>" },
      subscribe: { type: "(listener: (T) -> void) -> () -> void" },
      dispose: { type: "() -> void" },
    });
  });

  it("exports check options for editor integrations", () => {
    const options = createReactiveCheckOptions("strict");
    expect(options.mode).toBe("strict");
    expect(options.syntaxPlugins?.[0].name).toBe(REACTIVE_TERA_SYNTAX_PLUGIN_NAME);
    expect(options.builtins?.some((builtin) => builtin.name === "signal" && builtin.returns === "ReactiveSignal<T>")).toBe(true);
    expect(options.interfaces?.some((iface) => iface.name === "ReactiveComputed")).toBe(true);
    expect(options.interfaces?.some((iface) => iface.name === "ReactiveResource")).toBe(true);
  });

  it("exports a named Tera extension preset", () => {
    const extension = createReactiveTeraExtension(converters);
    expect(extension.name).toBe(REACTIVE_TERA_EXTENSION_NAME);
    expect(extension.syntaxPlugins?.[0].name).toBe(REACTIVE_TERA_SYNTAX_PLUGIN_NAME);
    expect(extension.syntaxPlugins?.[0].statementStarts).toEqual(["signal", "computed", "resource", "effect"]);
    expect(extension.checker?.interfaces?.[0].fields.value.type).toBe("T");
    expect(Object.keys(extension.runtimeBuiltins ?? {})).toEqual(expect.arrayContaining([
      "__tera_reactive_signal",
      "__tera_reactive_read",
      "__tera_reactive_write",
    ]));
    expect(extension.compiler?.intrinsics?.map((intrinsic) => intrinsic.name)).toEqual(expect.arrayContaining([
      "__tera_reactive_signal",
      "__tera_reactive_read",
      "__tera_reactive_write",
      "__tera_reactive_computed",
      "__tera_reactive_effect",
      "__tera_reactive_resource",
    ]));
    expect(extension.compiler?.effects?.map((effect) => effect.name)).toEqual(expect.arrayContaining([
      "ReactiveSignal.value",
      "ReactiveSignal.set",
      "ReactiveResource.refetch",
    ]));
    expect(extension.compiler?.guards?.map((guard) => guard.name)).toEqual(expect.arrayContaining([
      "reactive-handle-brand",
      "reactive-default-scheduler",
      "reactive-local-handle",
    ]));
    expect(extension.compiler?.deopts?.map((deopt) => deopt.name)).toEqual(expect.arrayContaining([
      "reactive-handle-brand-mismatch",
      "reactive-custom-scheduler",
      "reactive-escaped-handle",
    ]));
    expect(extension.compiler?.intrinsics?.find((intrinsic) => intrinsic.name === "__tera_reactive_read")).toMatchObject({
      lowering: "runtime",
      reads: ["reactive-value"],
      guards: ["reactive-handle-brand"],
      deopts: ["reactive-handle-brand-mismatch"],
    });
    expect(extension.compiler?.optimizerPasses?.map((pass) => pass.name)).toContain("reactive-lower-to-intrinsics");
  });

  it("typechecks reactive syntax and exposes signal member types", () => {
    const source = [
      "signal tally = 1",
      "computed doubled = tally * 2",
      "value = doubled",
    ].join("\n");

    expect(diagnoseSource(source, createReactiveCheckOptions())).toEqual([]);
    expect(inferSymbolTypes(source, createReactiveCheckOptions()).filter((symbol) => symbol.name === "tally" || symbol.name === "doubled" || symbol.name === "value")).toEqual([
      expect.objectContaining({ name: "tally", type: "ReactiveSignal<int>" }),
      expect.objectContaining({ name: "doubled", type: "ReactiveComputed<int>" }),
      expect.objectContaining({ name: "value", type: "int" }),
    ]);
  });

  it("desugars reactive reads to internal value access", () => {
    const ast = parse([
      "signal tally = 1",
      "computed doubled = tally * 2",
      "value = doubled",
    ].join("\n"), { syntaxPlugins: [reactiveSyntaxPlugin()] });

    const doubledCall = assignmentValue(statementsOf(ast)[1]);
    const doubledArrow = callArg(doubledCall, 0);
    const doubledBody = (doubledArrow as { body: ASTNode }).body;
    const valueRead = assignmentValue(statementsOf(ast)[2]);

    expect(doubledBody).toMatchObject({
      type: "BinaryExpression",
      left: {
        type: "MemberExpression",
        object: { type: "Identifier", name: "tally" },
        property: "value",
      },
    });
    expect(valueRead).toMatchObject({
      type: "MemberExpression",
      object: { type: "Identifier", name: "doubled" },
      property: "value",
    });
  });

  it("lowers resource declarations to resource calls and direct reads", () => {
    const ast = parse([
      "signal tally = 1",
      "resource doubled = tally * 2",
      "value = doubled",
    ].join("\n"), { syntaxPlugins: [reactiveSyntaxPlugin()] });

    const resourceCall = assignmentValue(statementsOf(ast)[1]);
    const resourceArrow = callArg(resourceCall, 0);
    const resourceBody = (resourceArrow as { body: ASTNode }).body;
    const valueRead = assignmentValue(statementsOf(ast)[2]);

    expect(resourceCall).toMatchObject({
      type: "CallExpression",
      callee: { type: "Identifier", name: "resource" },
    });
    expect(resourceBody).toMatchObject({
      type: "BinaryExpression",
      left: {
        type: "MemberExpression",
        object: { type: "Identifier", name: "tally" },
        property: "value",
      },
    });
    expect(valueRead).toMatchObject({
      type: "MemberExpression",
      object: { type: "Identifier", name: "doubled" },
      property: "value",
    });
  });

  it("does not unwrap reactive handles used as mutation receivers", () => {
    const ast = parse([
      "signal tally = 1",
      "tally.set(2)",
      "tally.update(x => x + 1)",
    ].join("\n"), { syntaxPlugins: [reactiveSyntaxPlugin()] });

    const setCall = (statementsOf(ast)[1].expression as ASTNode);
    const updateCall = (statementsOf(ast)[2].expression as ASTNode);

    expect(setCall).toMatchObject({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: { type: "Identifier", name: "tally" },
        property: "set",
      },
    });
    expect(updateCall).toMatchObject({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: { type: "Identifier", name: "tally" },
        property: "update",
      },
    });
  });

  it("passes direct reactive identifiers as watch source handles", () => {
    const ast = parse([
      "signal tally = 1",
      "watch(tally, (value, previous) => value)",
    ].join("\n"), { syntaxPlugins: [reactiveSyntaxPlugin()] });

    const watchCall = statementsOf(ast)[1].expression as ASTNode;

    expect(callArg(watchCall, 0)).toMatchObject({ type: "Identifier", name: "tally" });
  });

  it("lets plugin options preserve reactive handles for custom call arguments", () => {
    const ast = parse([
      "signal tally = 1",
      "take(tally)",
    ].join("\n"), { syntaxPlugins: [reactiveSyntaxPlugin({ preserveHandleArgs: { take: [0] } })] });

    const takeCall = statementsOf(ast)[1].expression as ASTNode;

    expect(callArg(takeCall, 0)).toMatchObject({ type: "Identifier", name: "tally" });
  });

  it("honors lexical shadowing inside callbacks", () => {
    const source = [
      "signal tally = 1",
      "fn read(tally: int) -> int:",
      "  return tally + 1",
      "value = read(2)",
    ].join("\n");

    expect(diagnoseSource(source, createReactiveCheckOptions())).toEqual([]);
    expect(inferSymbolTypes(source, createReactiveCheckOptions())).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "tally", type: "ReactiveSignal<int>" }),
      expect.objectContaining({ name: "value", type: "int" }),
    ]));
  });

  it("honors ordinary local declarations that shadow reactive handles", () => {
    const ast = parse([
      "signal tally = 1",
      "fn read() -> int:",
      "  tally: int = 2",
      "  return tally",
      "value = read()",
    ].join("\n"), { syntaxPlugins: [reactiveSyntaxPlugin()] });
    const read = statementsOf(ast).find((statement) => statement.type === "FunctionDeclaration" && (statement as { name?: unknown }).name === "read") as ASTNode;
    const body = ((read as { body: { body: ASTNode[] } }).body.body);
    const returned = (body[1] as { argument: ASTNode }).argument;
    const prints: string[] = [];
    const engine = new Engine({ ...createReactiveTeraOptions(converters), output: (text) => prints.push(String(text)) });

    expect(returned).toMatchObject({ type: "Identifier", name: "tally" });
    expect(engine.runNative([
      "signal tally = 1",
      "fn read() -> int:",
      "  tally: int = 2",
      "  return tally",
      "read()",
    ].join("\n"))).toBe(2);
  });

  it("honors loop bindings that shadow reactive handles only inside the loop", () => {
    const prints: string[] = [];
    const engine = new Engine({ ...createReactiveTeraOptions(converters), output: (text) => prints.push(String(text)) });

    engine.runNative([
      "signal item = 9",
      "for item of [1, 2]:",
      "  print(item)",
      "print(item)",
    ].join("\n"));

    expect(prints).toEqual(["1", "2", "9"]);
  });

  it("does not preserve handles for lexically declared functions named like reactive builtins", () => {
    const ast = parse([
      "signal tally = 1",
      "fn watch(source, cb):",
      "  return source",
      "value = watch(tally, (value, previous) => value)",
    ].join("\n"), { syntaxPlugins: [reactiveSyntaxPlugin()] });
    const valueRead = assignmentValue(statementsOf(ast)[2]);

    expect(callArg(valueRead, 0)).toMatchObject({
      type: "MemberExpression",
      object: { type: "Identifier", name: "tally" },
      property: "value",
    });
  });

  it("runs reactive syntax through the Tera engine", () => {
    const prints: string[] = [];
    const engine = new Engine({ ...createReactiveTeraOptions(converters), output: (text) => prints.push(String(text)) });

    engine.runNative([
      "signal tally = 1",
      "computed doubled = tally * 2",
      "effect:",
      "  print(doubled)",
      "tally.set(2)",
      "tally.update(x => x + 1)",
    ].join("\n"));

    expect(prints).toEqual(["2", "4", "6"]);
  });

  it("runs resource syntax through the Tera engine", () => {
    const prints: string[] = [];
    const engine = new Engine({ ...createReactiveTeraOptions(converters), output: (text) => prints.push(String(text)) });

    engine.runNative([
      "signal tally = 1",
      "resource doubled = tally * 2",
      "effect:",
      "  print(doubled)",
      "tally.set(2)",
    ].join("\n"));

    expect(prints).toEqual(["2", "4"]);
  });

  it("runs watch on direct reactive syntax identifiers", () => {
    const prints: string[] = [];
    const engine = new Engine({ ...createReactiveTeraOptions(converters), output: (text) => prints.push(String(text)) });

    engine.runNative([
      "signal tally = 1",
      "watch(tally, (value, previous) => print(previous, \"->\", value))",
      "tally.set(2)",
      "tally.set(3)",
    ].join("\n"));

    expect(prints).toEqual(["1 -> 2", "2 -> 3"]);
  });

  it("reports host errors for invalid watch sources", () => {
    const engine = new Engine(createReactiveTeraOptions(converters));

    expect(() => engine.runNative("watch(1, (value, previous) => value)")).toThrow("watch expects a function, signal, or computed source");
  });
});
