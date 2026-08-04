import { describe, expect, it } from "vitest";
import { checkSource, inferSymbolTypes, type Diagnostic } from "../../src/index.js";
import { cleanType, createTypeEnv, resolveType } from "../../src/frontend/checker/type-system.js";
import {
  TERA_BUILTIN_ALIASES,
  TERA_BUILTIN_INTERFACES,
  TERA_BUILTINS,
  TERA_CHART_METHODS,
  TERA_KIND_METHODS,
  TERA_PSEUDO_TYPES,
  type TeraBuiltinSpec,
  type TeraMethodSpec,
  type TeraParam,
} from "../../data/tera-language-spec.js";

type Failure = {
  label: string;
  source: string;
  detail: string;
};

let seed = 0xdecafbad;

function next(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed;
}

function pick<T>(items: T[]): T {
  return items[next() % items.length];
}

function lineText(source: string, line: number): string {
  return source.split("\n")[line - 1] ?? "";
}

function colOf(source: string, needle: string, line: number): number {
  return lineText(source, line).indexOf(needle) + 1;
}

function pushFailure(failures: Failure[], label: string, source: string, detail: string): void {
  failures.push({ label, source, detail });
}

function expectDiagnosticsInSource(failures: Failure[], label: string, source: string, diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (!Number.isInteger(diagnostic.line) || !Number.isInteger(diagnostic.column)) {
      pushFailure(failures, label, source, `non-integer position ${JSON.stringify(diagnostic)}`);
    }
    if (diagnostic.line < 1 || diagnostic.line > source.split("\n").length) {
      pushFailure(failures, label, source, `line out of range ${JSON.stringify(diagnostic)}`);
    }
    if (diagnostic.column < 1 || diagnostic.column > lineText(source, diagnostic.line).length + 1) {
      pushFailure(failures, label, source, `column out of range ${JSON.stringify(diagnostic)}`);
    }
    if (diagnostic.severity !== "error") {
      pushFailure(failures, label, source, `expected strict error ${JSON.stringify(diagnostic)}`);
    }
  }
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`).join("\n") || "<none>";
}

function splitTopLevel(source: string, separator: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    else if (depth === 0 && ch === separator) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out;
}

function exprForType(type: string | null | undefined): string {
  const normalized = cleanType(type);
  const union = splitTopLevel(normalized, "|").map((part) => part.trim()).filter(Boolean);
  if (union.length > 1) return exprForType(union[0]);
  if (normalized.endsWith("[]")) return `[${exprForType(normalized.slice(0, -2))}]`;
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return `[${splitTopLevel(normalized.slice(1, -1), ",").map((part) => exprForType(part.trim())).join(", ")}]`;
  }
  const functionType = normalized.match(/^\((.*)\)\s*->\s*(.+)$/);
  if (functionType) {
    const params = splitTopLevel(functionType[1], ",").map((part) => part.trim()).filter(Boolean).map((_, index) => `arg${index}`);
    return `(${params.join(", ")}) => ${exprForType(functionType[2])}`;
  }
  if (normalized === "Function") return "x => x";
  if (normalized === "int") return "1";
  if (normalized === "float") return "1.5";
  if (normalized === "string") return "\"x\"";
  if (normalized === "bool") return "true";
  if (normalized === "Object") return "{ ok: 1 }";
  if (normalized === "Array") return "[1]";
  if (normalized === "Tensor") return "tensor([1])";
  if (normalized === "Device") return "\"cpu\"";
  if (normalized === "DataFrame") return "DataFrame(a=[1])";
  if (normalized === "Tokenizer") return "Tokenizer()";
  if (normalized === "Module") return "Linear(1, 1)";
  if (normalized === "Optimizer") return "SGD([tensor([1.0], grad=true)])";
  if (normalized === "LRScheduler") return "StepLR(SGD([tensor([1.0], grad=true)]), 1)";
  if (normalized === "ReduceLROnPlateau") return "ReduceLROnPlateau(SGD([tensor([1.0], grad=true)]))";
  if (normalized === "Metric") return "Accuracy()";
  if (normalized === "MLModel") return "Ridge()";
  if (normalized === "MLTransform") return "StandardScaler()";
  if (normalized === "MetricCollection") return "MetricCollection({ acc: Accuracy() })";
  if (normalized === "Callback") return "Timer()";
  if (normalized === "Logger") return "ConsoleLogger()";
  if (normalized === "Dataset") return "TensorDataset(tensor([1.0]))";
  if (normalized === "DataLoader") return "DataLoader(TensorDataset(tensor([1.0])))";
  if (normalized === "TensorDataset") return "TensorDataset(tensor([1.0]))";
  if (normalized in TERA_BUILTIN_ALIASES) return exprForType(TERA_BUILTIN_ALIASES[normalized as keyof typeof TERA_BUILTIN_ALIASES].type);
  if (normalized in TERA_BUILTIN_INTERFACES) return objectExprForInterface(normalized);
  return "__any";
}

function badExprForType(type: string | null | undefined): string | null {
  const normalized = cleanType(type);
  if (normalized === "any" || normalized === "unknown") return null;
  const union = splitTopLevel(normalized, "|").map((part) => part.trim()).filter(Boolean);
  if (union.length > 1) {
    if (!union.some((part) => part === "string" || part === "DType" || part === "DeviceLike" || part === "LossReduction" || part === "TokenizerSpecialTokens")) return "\"bad\"";
    if (!union.some((part) => part === "bool")) return "false";
    if (!union.some((part) => part === "int" || part === "float" || part === "NumericScalar")) return "1";
    return "DataFrame(a=[1])";
  }
  if (normalized === "bool") return "\"bad\"";
  if (normalized === "string" || normalized === "DType" || normalized === "DeviceLike" || normalized === "LossReduction") return "true";
  if (normalized === "Tensor" || normalized === "MLTensor" || normalized === "Module" || normalized === "Optimizer" || normalized === "LRScheduler" || normalized === "Metric" || normalized === "MLModel" || normalized === "MLTransform" || normalized === "MetricCollection" || normalized === "Callback" || normalized === "Logger" || normalized === "Dataset" || normalized === "DataLoader") return "\"bad\"";
  if (normalized in TERA_BUILTIN_ALIASES) return badExprForType(TERA_BUILTIN_ALIASES[normalized as keyof typeof TERA_BUILTIN_ALIASES].type);
  if (normalized in TERA_BUILTIN_INTERFACES) return "\"bad\"";
  return "true";
}

function objectExprForInterface(name: string): string {
  if (name === "SVDResult") return "{ U: tensor([1]), S: tensor([1]), V: tensor([1]) }";
  if (name === "EighResult") return "{ values: tensor([1]), vectors: tensor([1]) }";
  if (name === "QRResult") return "{ Q: tensor([1]), R: tensor([1]) }";
  if (name === "TestResult") return "{ statistic: 1.0, pvalue: 0.5, df: 1.0 }";
  if (name === "TestResultNoDf") return "{ statistic: 1.0, pvalue: 0.5 }";
  if (name === "CubicSpline") return "{ xs: [1.0], ys: [1.0], coefficients: [1.0], evaluate: x => 1.0 }";
  if (name === "OptimizationResult") return "{ point: [1.0], value: 1.0, iterations: 1, converged: true }";
  if (name === "RootResult") return "{ root: 1.0, iterations: 1, converged: true }";
  if (name === "Fold") return "{ train: [1], test: [2] }";
  if (name === "TokenizerSpecialTokenMap") return "{ pad: \"<pad>\", unk: \"<unk>\", bos: \"<bos>\", eos: \"<eos>\" }";
  if (name === "TokenizerStrategyData") return "{ lowercase: true, num_merges: 1, end_of_word: \"</w>\", merges: [[\"a\", \"b\"]] }";
  if (name === "TokenizerConfig") return "{ lowercase: true, num_merges: 1, end_of_word: \"</w>\", merges: [[\"a\", \"b\"]], vocab_size: 100 }";
  if (name === "TokenizerJSON") return "{ format: \"mlfw-tokenizer\", version: 1, mode: \"word\", config: { vocab_size: 100 }, special_tokens: { pad: \"<pad>\", unk: \"<unk>\", bos: \"<bos>\", eos: \"<eos>\" }, vocab: [\"x\"], strategy: {} }";
  if (name === "MetricRecord") return "{ acc: 1.0 }";
  if (name === "MetricMap") return "{ acc: Accuracy() }";
  if (name === "ParamGrid") return "{ alpha: [1.0] }";
  if (name === "NumericMetricRecord") return "{ loss: 1.0 }";
  if (name === "OptimizerConfig") return "{ optimizer: SGD([tensor([1.0], grad=true)]) }";
  if (name === "OptimizerParamGroupInput") return "{ params: [tensor([1.0], grad=true)] }";
  if (name === "CompileOptions") return "{ name: \"x\" }";
  if (name === "LogOptions") return "{ on_step: true }";
  if (name === "SchedulerConfig") return "{ scheduler: StepLR(SGD([tensor([1.0], grad=true)]), 1) }";
  if (name === "OptimizerStateDict") return "{ state: Map(), paramGroups: [{}] }";
  if (name === "GarchParams") return "{ omega: 0.1, alpha: 0.1, beta: 0.8 }";
  if (name === "CriticalValues") return "{ one: 1.0, five: 1.0, ten: 1.0 }";
  return "{}";
}

function argForParam(param: TeraParam): string {
  const expr = exprForType(param.type);
  return param.named ? `${param.name}=${expr}` : expr;
}

function validArgs(params: TeraParam[] | null | undefined): string {
  const args: string[] = [];
  for (const param of params ?? []) {
    if (param.rest) {
      if (param.named) args.push(`extra_${args.length}=${exprForType(param.type)}`);
      else args.push(exprForType(param.type));
      continue;
    }
    args.push(argForParam(param));
  }
  return args.join(", ");
}

function validArgsWithBadParam(params: TeraParam[] | null | undefined, target: TeraParam): string | null {
  const args: string[] = [];
  const bad = badExprForType(target.type);
  if (!bad) return null;
  for (const param of params ?? []) {
    if (param.rest) continue;
    const expr = param === target ? bad : exprForType(param.type);
    args.push(param.named ? `${param.name}=${expr}` : expr);
  }
  return args.join(", ");
}

function typedBadTarget(params: TeraParam[] | null | undefined, typeParams: readonly string[] | undefined = []): TeraParam | undefined {
  const generic = new Set(typeParams);
  return (params ?? []).find((param) => !param.rest && !generic.has(cleanType(param.type)) && badExprForType(param.type));
}

function requiredTarget(params: TeraParam[] | null | undefined): TeraParam | undefined {
  return (params ?? []).find((param) => !param.rest && !param.optional);
}

function hasRest(params: TeraParam[] | null | undefined, named: boolean): boolean {
  return (params ?? []).some((param) => !!param.rest && !!param.named === named);
}

function positionalArgs(params: TeraParam[] | null | undefined): string {
  return (params ?? []).filter((param) => !param.rest && !param.named).map((param) => exprForType(param.type)).join(", ");
}

function appendArg(args: string, arg: string): string {
  return args ? `${args}, ${arg}` : arg;
}

function safeName(source: string): string {
  return source.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^[^A-Za-z_$]/, "_");
}

function expectedBuiltinReturn(name: string, spec: TeraBuiltinSpec): string {
  const kindMethods = spec.kind ? TERA_KIND_METHODS[spec.kind as keyof typeof TERA_KIND_METHODS] : undefined;
  const returns = kindMethods?.length && cleanType(spec.returns) === "Object" ? name : cleanType(spec.returns ?? "undefined");
  return substituteFuzzTypeArgs(returns, spec.typeParams);
}

function expectedMethodReturn(type: string, method: TeraMethodSpec, ownerTypeParams: readonly string[] | undefined = []): string {
  const returns = cleanType(method.returns ?? "undefined");
  return substituteReceiverTypeArgs(substituteFuzzTypeArgs(returns === "this" ? type : returns, method.typeParams), type, ownerTypeParams);
}

function explicitFuzzTypeArgs(typeParams: readonly string[] | undefined): string {
  return typeParams?.length ? `<${typeParams.map(() => "float").join(", ")}>` : "";
}

function substituteFuzzTypeArgs(type: string, typeParams: readonly string[] | undefined): string {
  let out = cleanType(type);
  for (const param of typeParams ?? []) out = out.replace(new RegExp(`\\b${param}\\b`, "g"), "float");
  return cleanType(out);
}

function substituteReceiverTypeArgs(type: string, receiverType: string, typeParams: readonly string[] | undefined): string {
  let out = cleanType(type);
  const generic = cleanType(receiverType).match(/^[A-Za-z_$][\w$]*\s*<(.+)>$/);
  const args = generic ? splitTopLevel(generic[1], ",").map((arg) => cleanType(arg)) : [];
  for (let i = 0; i < (typeParams ?? []).length; i++) out = out.replace(new RegExp(`\\b${typeParams![i]}\\b`, "g"), args[i] ?? "any");
  return cleanType(out);
}

function pseudoReceiverType(owner: string, spec: { typeParams?: readonly string[] }): string {
  return spec.typeParams?.length ? `${owner}<${spec.typeParams.map(() => "any").join(", ")}>` : owner;
}

function kindReceiver(kind: string, fallback: string): string {
  const families: Record<string, string> = {
    module: "Module",
    optimizer: "Optimizer",
    scheduler: "LRScheduler",
    metric: "Metric",
    ml_model: "MLModel",
    ml_transform: "MLTransform",
    metric_collection: "MetricCollection",
    callback: "Callback",
    logger: "Logger",
    trainer: "Trainer",
  };
  return families[kind] ?? fallback;
}

function expectNoDiagnostics(failures: Failure[], label: string, source: string): void {
  const diagnostics = checkSource(source, "strict");
  expectDiagnosticsInSource(failures, label, source, diagnostics);
  if (diagnostics.length > 0) pushFailure(failures, label, source, formatDiagnostics(diagnostics));
}

function expectDiagnostic(
  failures: Failure[],
  label: string,
  source: string,
  expected: { line?: number; column?: number; message: string },
): void {
  const diagnostics = checkSource(source, "strict");
  expectDiagnosticsInSource(failures, label, source, diagnostics);
  if (!diagnostics.some((diagnostic) =>
    (expected.line === undefined || diagnostic.line === expected.line) &&
    (expected.column === undefined || diagnostic.column === expected.column) &&
    diagnostic.message === expected.message
  )) {
    pushFailure(failures, label, source, formatDiagnostics(diagnostics));
  }
}

describe("checker fuzz invariants", () => {
  it("keeps assignment compatibility stable across scalar, union, and array types", () => {
    const exprs = {
      int: ["1", "42", "7 + 3"],
      float: ["1.5", "2 / 2", "3.25"],
      string: ["\"x\"", "\"hello\"", "\"a\" + \"b\""],
      bool: ["true", "false", "1 < 2"],
      stringArray: ["[\"a\", \"b\"]"],
      intArray: ["[1, 2]"],
    };
    const goodTypes = {
      int: ["int", "float", "int | string"],
      float: ["float", "float | string"],
      string: ["string", "string | float"],
      bool: ["bool"],
      stringArray: ["string[]", "Array", "string | string[]"],
      intArray: ["int[]", "float[]", "Array"],
    };
    const badTypes = {
      int: ["string", "bool", "string[]"],
      float: ["int", "string", "bool"],
      string: ["int", "float", "bool", "string[]"],
      bool: ["string", "int", "float"],
      stringArray: ["string", "int[]", "float[]"],
      intArray: ["string[]", "string"],
    };
    const failures: Failure[] = [];

    for (let i = 0; i < 500; i++) {
      const kind = pick(Object.keys(exprs) as Array<keyof typeof exprs>);
      const expr = pick(exprs[kind]);
      for (const [label, type, shouldPass] of [
        [`assign-good-${kind}`, pick(goodTypes[kind]), true],
        [`assign-bad-${kind}`, pick(badTypes[kind]), false],
      ] as const) {
        const source = `value: ${type} = ${expr}`;
        const diagnostics = checkSource(source, "strict");
        expectDiagnosticsInSource(failures, label, source, diagnostics);
        if (shouldPass && diagnostics.length > 0) {
          pushFailure(failures, label, source, formatDiagnostics(diagnostics));
        }
        if (!shouldPass && diagnostics.length === 0) {
          pushFailure(failures, label, source, "expected a diagnostic");
        }
        if (!shouldPass && diagnostics[0]) {
          const expectedColumn = colOf(source, expr, 1);
          if (diagnostics[0].line !== 1 || diagnostics[0].column !== expectedColumn) {
            pushFailure(failures, label, source, `expected 1:${expectedColumn}, got ${diagnostics[0].line}:${diagnostics[0].column}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("fuzzes contextual arrays, spreads, tuple slots, nested indexes, and slices", () => {
    const failures: Failure[] = [];
    const vectors = {
      int: { values: "[1, 2]", good: ["int[]", "float[]", "Array"], bad: ["string[]", "bool[]"] },
      float: { values: "[1.5, 2.5]", good: ["float[]", "Array"], bad: ["int[]", "string[]", "bool[]"] },
      string: { values: "[\"a\", \"b\"]", good: ["string[]", "Array"], bad: ["int[]", "float[]", "bool[]"] },
      bool: { values: "[true, false]", good: ["bool[]", "Array"], bad: ["int[]", "float[]", "string[]"] },
    };

    for (const [kind, vector] of Object.entries(vectors)) {
      for (const expr of [vector.values, `[...${vector.values}]`]) {
        const source = `xs = ${expr}`;
        const symbols = inferSymbolTypes(source);
        if (!symbols.some((symbol) => symbol.name === "xs" && symbol.type === `${kind}[]`)) {
          pushFailure(failures, `array-infer-${kind}`, source, JSON.stringify(symbols));
        }
        for (const type of vector.good) expectNoDiagnostics(failures, `array-good-${kind}-${type}`, `value: ${type} = ${expr}`);
        for (const type of vector.bad) {
          const badSource = `value: ${type} = ${expr}`;
          const diagnostics = checkSource(badSource, "strict");
          expectDiagnosticsInSource(failures, `array-bad-${kind}-${type}`, badSource, diagnostics);
          if (!diagnostics.some((diagnostic) => diagnostic.message.includes(`not assignable to '${type}'`))) {
            pushFailure(failures, `array-bad-${kind}-${type}`, badSource, formatDiagnostics(diagnostics));
          }
        }
      }

      const getter = [`fn get(xs: ${kind}[]) -> ${kind}:`, "  return xs[0]"].join("\n");
      expectNoDiagnostics(failures, `index-return-${kind}`, getter);

      const badKey = [`xs: ${kind}[] = ${vector.values}`, "v = xs[\"0\"]"].join("\n");
      const badKeyDiagnostics = checkSource(badKey, "strict");
      expectDiagnosticsInSource(failures, `index-key-${kind}`, badKey, badKeyDiagnostics);
      if (!badKeyDiagnostics.some((diagnostic) => diagnostic.line === 2 && diagnostic.column === 8 && diagnostic.message.includes("index type 'int'"))) {
        pushFailure(failures, `index-key-${kind}`, badKey, formatDiagnostics(badKeyDiagnostics));
      }

      const slice = [`xs: ${kind}[] = ${vector.values}`, "ys = xs[0:2]"].join("\n");
      const symbols = inferSymbolTypes(slice);
      if (!symbols.some((symbol) => symbol.name === "ys" && symbol.type === `${kind}[]`)) {
        pushFailure(failures, `slice-infer-${kind}`, slice, JSON.stringify(symbols));
      }

      const badSlice = [`xs: ${kind}[] = ${vector.values}`, "ys = xs[\"0\":2]"].join("\n");
      const badSliceDiagnostics = checkSource(badSlice, "strict");
      if (!badSliceDiagnostics.some((diagnostic) => diagnostic.line === 2 && diagnostic.column === 9 && diagnostic.message.includes("index type 'int'"))) {
        pushFailure(failures, `slice-key-${kind}`, badSlice, formatDiagnostics(badSliceDiagnostics));
      }
    }

    const nonIterableSpread = "value = [...1]";
    const spreadDiagnostics = checkSource(nonIterableSpread, "strict");
    if (!spreadDiagnostics.some((diagnostic) => diagnostic.line === 1 && diagnostic.column === 13 && diagnostic.message === "Type 'int' is not iterable")) {
      pushFailure(failures, "spread-non-iterable", nonIterableSpread, formatDiagnostics(spreadDiagnostics));
    }

    const tuple = ["pair = [1, \"x\"]", "a = pair[0]", "b = pair[-1]", "bad: int = pair[1]"].join("\n");
    const tupleSymbols = inferSymbolTypes(tuple);
    for (const expected of [
      { name: "a", type: "int" },
      { name: "b", type: "string" },
    ]) {
      if (!tupleSymbols.some((symbol) => symbol.name === expected.name && symbol.type === expected.type)) {
        pushFailure(failures, `tuple-${expected.name}`, tuple, JSON.stringify(tupleSymbols));
      }
    }
    const tupleDiagnostics = checkSource(tuple, "strict");
    if (!tupleDiagnostics.some((diagnostic) => diagnostic.message === "Type 'string' is not assignable to 'int'")) {
      pushFailure(failures, "tuple-bad-slot", tuple, formatDiagnostics(tupleDiagnostics));
    }

    const nested = ["matrix = [[1, 2], [3, 4]]", "cell: int = matrix[0][1]", "bad: string = matrix[0][1]"].join("\n");
    const nestedSymbols = inferSymbolTypes(nested);
    if (!nestedSymbols.some((symbol) => symbol.name === "matrix" && symbol.type === "int[][]")) {
      pushFailure(failures, "nested-matrix", nested, JSON.stringify(nestedSymbols));
    }
    if (!checkSource(nested, "strict").some((diagnostic) => diagnostic.message === "Type 'int' is not assignable to 'string'")) {
      pushFailure(failures, "nested-bad-cell", nested, formatDiagnostics(checkSource(nested, "strict")));
    }

    expect(failures).toEqual([]);
  });

  it("fuzzes binary operator diagnostics in expressions and control-flow tests", () => {
    const failures: Failure[] = [];
    const cases = [
      { left: "1", right: "2", ok: true },
      { left: "1.5", right: "2", ok: true },
      { left: "\"a\"", right: "\"b\"", ok: true },
      { left: "\"a\"", right: "2", ok: false },
      { left: "true", right: "2", ok: false },
      { left: "[1]", right: "2", ok: false },
    ];

    for (const item of cases) {
      for (const source of [
        [`if ${item.left} <= ${item.right}:`, "  value = 1"].join("\n"),
        `value = ${item.left} <= ${item.right}`,
      ]) {
        const diagnostics = checkSource(source, "strict");
        expectDiagnosticsInSource(failures, `binary-${item.left}-${item.right}`, source, diagnostics);
        if (item.ok && diagnostics.length > 0) pushFailure(failures, "binary-good", source, formatDiagnostics(diagnostics));
        if (!item.ok && !diagnostics.some((diagnostic) => diagnostic.message.includes("Operator '<=' cannot be applied"))) {
          pushFailure(failures, "binary-bad", source, formatDiagnostics(diagnostics));
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("fuzzes the typed expression surface that must not collapse to any", () => {
    const failures: Failure[] = [];

    expectDiagnostic(failures, "return-operator", ["fn f(x: float) -> float:", "  return x * \"bad\""].join("\n"), {
      line: 2,
      column: 14,
      message: "Operator '*' cannot be applied to 'float' and 'string'",
    });
    expectDiagnostic(failures, "return-call-argument", [
      "fn id(x: int) -> int:",
      "  return x",
      "fn f() -> int:",
      "  return id(\"bad\")",
    ].join("\n"), {
      line: 4,
      column: 13,
      message: "Type 'string' is not assignable to parameter 'x: int'",
    });

    for (const source of [
      ["if 1:", "  value = 1"].join("\n"),
      ["while \"x\":", "  value = 1"].join("\n"),
    ]) {
      const diagnostics = checkSource(source, "strict");
      expectDiagnosticsInSource(failures, "condition-type", source, diagnostics);
      if (!diagnostics.some((diagnostic) => diagnostic.message.includes("condition type 'bool'"))) {
        pushFailure(failures, "condition-type", source, formatDiagnostics(diagnostics));
      }
    }

    expectDiagnostic(failures, "for-of-non-iterable", ["for item of 1:", "  value = item"].join("\n"), {
      line: 1,
      column: 13,
      message: "Type 'int' is not iterable",
    });
    expectDiagnostic(failures, "for-in-non-indexable", ["for key in 1:", "  value = key"].join("\n"), {
      line: 1,
      column: 12,
      message: "Type 'int' is not indexable",
    });

    const contextualCases = [
      {
        label: "conditional-bad-branch",
        source: ["flag = true", "value: int = flag ? 1 : \"bad\""].join("\n"),
        line: 2,
        column: 25,
        message: "Type 'string' is not assignable to 'int'",
      },
      {
        label: "conditional-bad-test",
        source: "value: int = 1 ? 2 : 3",
        line: 1,
        column: 14,
        message: "Type 'int' is not assignable to condition type 'bool'",
      },
      {
        label: "nullish-bad-right",
        source: ["maybe: string | null = null", "value: string = maybe ?? 1"].join("\n"),
        line: 2,
        column: 26,
        message: "Type 'int' is not assignable to 'string'",
      },
      {
        label: "nullish-bad-left",
        source: ["maybe: int | null = null", "value: string = maybe ?? \"x\""].join("\n"),
        line: 2,
        column: 17,
        message: "Type 'int' is not assignable to 'string'",
      },
      {
        label: "sequence-last-value",
        source: "value: int = (1, \"bad\")",
        line: 1,
        column: 18,
        message: "Type 'string' is not assignable to 'int'",
      },
    ];
    for (const item of contextualCases) expectDiagnostic(failures, item.label, item.source, item);

    const expressionSource = [
      "label = `v=${1}`",
      "seq = (true, 42)",
      "waited = await 1",
      "yielded = yield \"x\"",
      "fn_value = x => x",
      "word_and = true and false",
      "word_or = false or true",
      "word_not = not false",
      "bad_template: int = `v=${1}`",
      "bad_function: int = x => x",
    ].join("\n");
    const symbols = inferSymbolTypes(expressionSource);
    for (const expected of [
      { name: "label", type: "string" },
      { name: "seq", type: "int" },
      { name: "waited", type: "int" },
      { name: "yielded", type: "string" },
      { name: "fn_value", type: "(any) -> any" },
      { name: "word_and", type: "bool" },
      { name: "word_or", type: "bool" },
      { name: "word_not", type: "bool" },
    ]) {
      if (!symbols.some((symbol) => symbol.name === expected.name && symbol.type === expected.type)) {
        pushFailure(failures, `surface-infer-${expected.name}`, expressionSource, JSON.stringify(symbols));
      }
    }
    expectDiagnostic(failures, "template-not-int", expressionSource, {
      line: 9,
      column: 21,
      message: "Type 'string' is not assignable to 'int'",
    });
    expectDiagnostic(failures, "function-not-int", expressionSource, {
      line: 10,
      column: 21,
      message: "Type '(any) -> any' is not assignable to 'int'",
    });
    expectDiagnostic(failures, "word-and-bad-operand", "value = true and 1", {
      line: 1,
      column: 18,
      message: "Type 'int' is not assignable to logical operand type 'bool'",
    });
    expectDiagnostic(failures, "word-not-bad-operand", "value = not 1", {
      line: 1,
      column: 13,
      message: "Operator '!' cannot be applied to 'int'",
    });

    expectNoDiagnostics(failures, "new-expression-good", "layer = new Linear(4, 8)");
    expectDiagnostic(failures, "new-expression-bad-argument", "layer = new Linear(\"bad\", 8)", {
      line: 1,
      column: 20,
      message: "Type 'string' is not assignable to parameter 'in: int'",
    });

    const objectSpread = [
      "interface User:",
      "  name: string",
      "base: User = { name: \"Ada\" }",
      "copy: User = { ...base }",
      "bad_spread = { ...1 }",
      "bad_field = { ok: 1 * \"bad\" }",
    ].join("\n");
    expectNoDiagnostics(failures, "object-spread-good", objectSpread.replace("bad_spread = { ...1 }\n", "").replace("bad_field = { ok: 1 * \"bad\" }", ""));
    expectDiagnostic(failures, "object-spread-non-object", objectSpread, {
      line: 5,
      column: 19,
      message: "Type 'int' is not assignable to object spread type 'Object'",
    });
    expectDiagnostic(failures, "object-field-expression", objectSpread, {
      line: 6,
      column: 23,
      message: "Operator '*' cannot be applied to 'int' and 'string'",
    });

    const assignmentTargets = [
      "interface Box:",
      "  value: int",
      "box: Box = { value: 1 }",
      "box.value = \"bad\"",
      "xs: int[] = [1, 2]",
      "xs[0] = \"bad\"",
      "xs[\"0\"] = 1",
    ].join("\n");
    expectDiagnostic(failures, "member-assignment-value", assignmentTargets, {
      line: 4,
      column: 13,
      message: "Type 'string' is not assignable to 'int'",
    });
    expectDiagnostic(failures, "index-assignment-value", assignmentTargets, {
      line: 6,
      column: 9,
      message: "Type 'string' is not assignable to 'int'",
    });
    expectDiagnostic(failures, "index-assignment-key", assignmentTargets, {
      line: 7,
      column: 4,
      message: "Type 'string' is not assignable to index type 'int'",
    });

    expect(failures).toEqual([]);
  });

  it("fuzzes the operator type matrix including equality, bitwise, membership, and tensor matmul", () => {
    const failures: Failure[] = [];
    const tensorSetup = "a = tensor([[1]])\nb = tensor([[2]])\n";
    const tensorExpressions = [
      ["ok_matmul", "a @ b"],
      ["ok_tensor_add_int", "a + 2"],
      ["ok_tensor_add_float", "a + 2.5"],
      ["ok_tensor_sub_int", "a - 2"],
      ["ok_tensor_sub_tensor", "a - b"],
      ["ok_tensor_mul_float", "a * 2.5"],
      ["ok_tensor_mul_tensor", "a * b"],
      ["ok_tensor_div_int", "a / 2"],
      ["ok_tensor_pow_float", "a ** 2.0"],
      ["ok_scalar_add_tensor", "2 + a"],
      ["ok_scalar_mul_tensor", "2.0 * a"],
    ];
    const good = [
      "ok_add_int = 1 + 2",
      "ok_add_float = 1 + 2.5",
      "ok_add_string = \"a\" + \"b\"",
      "ok_concat_int = 1 + \"x\"",
      "ok_concat_string_float = \"area \" + 2.5",
      "ok_eq_number = 1 == 2.0",
      "ok_eq_null = null == undefined",
      "ok_bitwise = 1 << 2",
      "ok_in_array = 0 in [1, 2]",
      "ok_in_object = \"name\" in { name: \"Ada\" }",
      tensorSetup.trimEnd(),
      ...tensorExpressions.map(([name, expr]) => `${name} = ${expr}`),
      "a *= 2",
      "a += 1.5",
      "ok_tensor_neg = -a",
    ].join("\n");
    expectNoDiagnostics(failures, "operator-matrix-good", good);
    const symbols = inferSymbolTypes(good);
    for (const [name] of tensorExpressions) {
      if (!symbols.some((symbol) => symbol.name === name && symbol.type === "Tensor")) {
        pushFailure(failures, `operator-tensor-infer-${name}`, good, JSON.stringify(symbols));
      }
    }

    const bad = [
      { label: "bad-equality", source: "value = true == 1", message: "Operator '==' cannot be applied to 'bool' and 'int'" },
      { label: "bad-bitwise", source: "value = 1 & 2.5", message: "Operator '&' cannot be applied to 'int' and 'float'" },
      { label: "bad-in-key", source: "value = true in [1, 2]", message: "Type 'bool' is not assignable to index type 'int'" },
      { label: "bad-in-container", source: "value = 1 in 2", message: "Type 'int' is not indexable" },
      { label: "bad-matmul", source: "value = 1 @ 2", message: "Operator '@' cannot be applied to 'int' and 'int'" },
    ];
    for (const item of bad) expectDiagnostic(failures, item.label, item.source, { message: item.message });

    const badTensor = [
      { label: "bad-tensor-string-right", expr: "a + \"x\"", needle: "\"x\"", message: "Operator '+' cannot be applied to 'Tensor' and 'string'" },
      { label: "bad-string-tensor-left", expr: "\"x\" + a", needle: "\"x\"", message: "Operator '+' cannot be applied to 'string' and 'Tensor'" },
      { label: "bad-tensor-mul-string", expr: "a * \"x\"", needle: "\"x\"", message: "Operator '*' cannot be applied to 'Tensor' and 'string'" },
      { label: "bad-reflected-sub", expr: "2 - a", needle: "2", message: "Operator '-' cannot be applied to 'int' and 'Tensor'" },
      { label: "bad-reflected-div", expr: "2 / a", needle: "2", message: "Operator '/' cannot be applied to 'int' and 'Tensor'" },
      { label: "bad-reflected-pow", expr: "2 ** a", needle: "2", message: "Operator '**' cannot be applied to 'int' and 'Tensor'" },
      { label: "bad-tensor-mod", expr: "a % 2", needle: "2", message: "Operator '%' cannot be applied to 'Tensor' and 'int'" },
    ];
    for (const item of badTensor) {
      const source = `${tensorSetup}bad = ${item.expr}`;
      expectDiagnostic(failures, item.label, source, {
        line: 3,
        column: colOf(source, item.needle, 3),
        message: item.message,
      });
    }

    expect(failures).toEqual([]);
  });

  it("does not duplicate diagnostics while propagating expected types", () => {
    const cases = [
      {
        label: "declared-binary",
        source: "value: int = 1 * \"bad\"",
        message: "Operator '*' cannot be applied to 'int' and 'string'",
      },
      {
        label: "call-binary",
        source: ["fn f(x: int) -> int:", "  return x", "value = f(1 * \"bad\")"].join("\n"),
        message: "Operator '*' cannot be applied to 'int' and 'string'",
      },
      {
        label: "shape-binary",
        source: ["interface Box:", "  value: int", "box: Box = { value: 1 * \"bad\" }"].join("\n"),
        message: "Operator '*' cannot be applied to 'int' and 'string'",
      },
      {
        label: "return-binary",
        source: ["fn f() -> int:", "  return 1 * \"bad\""].join("\n"),
        message: "Operator '*' cannot be applied to 'int' and 'string'",
      },
    ];
    const failures: Failure[] = [];

    for (const item of cases) {
      const diagnostics = checkSource(item.source, "strict");
      expectDiagnosticsInSource(failures, item.label, item.source, diagnostics);
      if (diagnostics.length !== 1 || diagnostics[0]?.message !== item.message) {
        pushFailure(failures, item.label, item.source, formatDiagnostics(diagnostics));
      }
    }

    expect(failures).toEqual([]);
  });

  it("fuzzes contextual arrow bodies from annotations and callback parameters", () => {
    const failures: Failure[] = [];
    const good = [
      "double: (float) -> float = x => x * 2",
      "fn apply(x: float, f: (float) -> float) -> float:",
      "  return f(x)",
      "ok = apply(21, x => x * 2)",
    ].join("\n");
    expectNoDiagnostics(failures, "arrow-good", good);

    const badOperator = "bad: (float) -> float = x => x * \"nope\"";
    const badOperatorDiagnostics = checkSource(badOperator, "strict");
    if (!badOperatorDiagnostics.some((diagnostic) => diagnostic.message === "Operator '*' cannot be applied to 'float' and 'string'")) {
      pushFailure(failures, "arrow-bad-operator", badOperator, formatDiagnostics(badOperatorDiagnostics));
    }

    const badCallback = [
      "fn apply(x: float, f: (float) -> float) -> float:",
      "  return f(x)",
      "bad = apply(21, x => x * \"nope\")",
    ].join("\n");
    const badCallbackDiagnostics = checkSource(badCallback, "strict");
    if (!badCallbackDiagnostics.some((diagnostic) => diagnostic.message === "Operator '*' cannot be applied to 'float' and 'string'")) {
      pushFailure(failures, "arrow-callback-bad-operator", badCallback, formatDiagnostics(badCallbackDiagnostics));
    }

    expect(failures).toEqual([]);
  });

  it("fuzzes function type spellings, nesting, and variance", () => {
    const failures: Failure[] = [];
    const spellings = ["(int) -> int", "fn(int) -> int", "fn (int) -> int"];

    for (const spelling of spellings) {
      const name = `f_${safeName(spelling)}`;
      const source = [
        `${name}: ${spelling} = x => x + 1`,
        `value_${name}: int = ${name}(2)`,
      ].join("\n");
      expectNoDiagnostics(failures, `function-spelling-good-${name}`, source);
      const symbols = inferSymbolTypes(source);
      if (!symbols.some((symbol) => symbol.name === name && symbol.type === "(int) -> int")) {
        pushFailure(failures, `function-spelling-type-${name}`, source, JSON.stringify(symbols));
      }

      const badReturn = `${name}_bad: ${spelling} = x => "bad"`;
      expectDiagnostic(failures, `function-spelling-bad-${name}`, badReturn, {
        message: "Type 'string' is not assignable to return type 'int'",
      });
    }

    const higherOrder = [
      "fn adder(base: int) -> fn(int) -> int:",
      "  fn add(x: int) -> int:",
      "    return base + x",
      "  return add",
      "inc = adder(1)",
      "ok: int = inc(2)",
      "bad: string = inc(2)",
    ].join("\n");
    expectDiagnostic(failures, "function-higher-order-bad-use", higherOrder, {
      line: 7,
      column: 15,
      message: "Type 'int' is not assignable to 'string'",
    });

    expectNoDiagnostics(failures, "function-variance-good", [
      "source: fn(float) -> int = x => 1",
      "target: fn(int) -> float = source",
    ].join("\n"));
    expectDiagnostic(failures, "function-variance-bad", [
      "source: fn(int) -> float = x => x + 1",
      "target: fn(float) -> int = source",
    ].join("\n"), {
      line: 2,
      column: 28,
      message: "Type '(int) -> float' is not assignable to '(float) -> int'",
    });

    expect(failures).toEqual([]);
  });

  it("fuzzes unary, logical, reassignment, compound assignment, and update rules", () => {
    const failures: Failure[] = [];
    const good = [
      "a = -1",
      "b = +1.5",
      "c = !false",
      "d = ~1",
      "e = true && false",
      "f = false || true",
      "x: float = 1",
      "x = 2",
      "x += 3",
      "x /= 2",
    ].join("\n");
    expectNoDiagnostics(failures, "operators-good", good);

    const badCases = [
      { label: "unary-minus", source: "x = -\"bad\"", line: 1, column: 6, message: "Operator '-' cannot be applied to 'string'" },
      { label: "unary-plus", source: "x = +\"bad\"", line: 1, column: 6, message: "Operator '+' cannot be applied to 'string'" },
      { label: "unary-not", source: "x = !1", line: 1, column: 6, message: "Operator '!' cannot be applied to 'int'" },
      { label: "unary-bitnot", source: "x = ~\"bad\"", line: 1, column: 6, message: "Operator '~' cannot be applied to 'string'" },
      { label: "logical-and", source: "x = true && 1", line: 1, column: 13, message: "Type 'int' is not assignable to logical operand type 'bool'" },
      { label: "logical-or", source: "x = false || \"x\"", line: 1, column: 14, message: "Type 'string' is not assignable to logical operand type 'bool'" },
      { label: "reassign", source: ["x: int = 1", "x = \"bad\""].join("\n"), line: 2, column: 5, message: "Type 'string' is not assignable to 'int'" },
      { label: "compound-type", source: ["x: int = 1", "x += \"bad\""].join("\n"), line: 2, column: 6, message: "Operator '+=' produces 'string' which is not assignable to 'int'" },
      { label: "compound-result", source: ["x: int = 1", "x /= 2"].join("\n"), line: 2, column: 6, message: "Operator '/=' produces 'float' which is not assignable to 'int'" },
      { label: "update", source: ["x: string = \"a\"", "x++"].join("\n"), line: 2, column: 1, message: "Operator '++' cannot be applied to 'string'" },
    ];

    for (const item of badCases) {
      const diagnostics = checkSource(item.source, "strict");
      expectDiagnosticsInSource(failures, item.label, item.source, diagnostics);
      if (!diagnostics.some((diagnostic) => diagnostic.line === item.line && diagnostic.column === item.column && diagnostic.message === item.message)) {
        pushFailure(failures, item.label, item.source, formatDiagnostics(diagnostics));
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps call diagnostics on the offending argument or argument name", () => {
    const exprs = {
      int: ["1", "42", "7 + 3"],
      float: ["1.5", "2 / 2", "3.25"],
      string: ["\"x\"", "\"hello\"", "\"a\" + \"b\""],
      bool: ["true", "false", "1 < 2"],
    };
    const goodTypes = {
      int: ["int", "float"],
      float: ["float"],
      string: ["string"],
      bool: ["bool"],
    };
    const badTypes = {
      int: ["string", "bool"],
      float: ["int", "string", "bool"],
      string: ["int", "float", "bool"],
      bool: ["string", "int", "float"],
    };
    const failures: Failure[] = [];

    for (let i = 0; i < 300; i++) {
      const leftKind = pick(Object.keys(exprs) as Array<keyof typeof exprs>);
      const rightKind = pick(Object.keys(exprs) as Array<keyof typeof exprs>);
      const leftType = pick(goodTypes[leftKind]);
      const rightType = pick(badTypes[rightKind]);
      const goodArg = pick(exprs[leftKind]);
      const badArg = pick(exprs[rightKind]);
      const source = [`fn f(a: ${leftType}, b: ${rightType}) -> ${leftType}:`, "  return a", `f(${goodArg}, ${badArg})`].join("\n");
      const diagnostics = checkSource(source, "strict");
      expectDiagnosticsInSource(failures, "positional-call", source, diagnostics);
      if (diagnostics[0]) {
        const expectedColumn = colOf(source, badArg, 3);
        if (diagnostics[0].line !== 3 || diagnostics[0].column !== expectedColumn) {
          pushFailure(failures, "positional-call-span", source, `expected 3:${expectedColumn}, got ${diagnostics[0].line}:${diagnostics[0].column}`);
        }
      }
    }

    for (const source of [
      ["fn f(a: int, b: string) -> int:", "  return a", "f(a=\"bad\", b=2)"].join("\n"),
      ["fn f(a: int):", "  return a", "f(a=1, a=2)", "f(extra=1)", "f(1, 2)"].join("\n"),
    ]) {
      const diagnostics = checkSource(source, "strict");
      expectDiagnosticsInSource(failures, "named-call", source, diagnostics);
    }

    const named = checkSource(["fn f(a: int, b: string) -> int:", "  return a", "f(a=\"bad\", b=2)"].join("\n"), "strict");
    if (named[0]?.line !== 3 || named[0]?.column !== 5) pushFailure(failures, "named-a-value", "f(a=\"bad\", b=2)", JSON.stringify(named[0]));
    if (named[1]?.line !== 3 || named[1]?.column !== 14) pushFailure(failures, "named-b-value", "f(a=\"bad\", b=2)", JSON.stringify(named[1]));

    const arity = checkSource(["fn f(a: int):", "  return a", "f(a=1, a=2)", "f(extra=1)", "f(1, 2)"].join("\n"), "strict");
    if (arity[0]?.line !== 3 || arity[0]?.column !== 8) pushFailure(failures, "duplicate-name", "f(a=1, a=2)", JSON.stringify(arity[0]));
    if (arity[1]?.line !== 4 || arity[1]?.column !== 3) pushFailure(failures, "unknown-name", "f(extra=1)", JSON.stringify(arity[1]));
    if (arity[2]?.line !== 4 || arity[2]?.column !== 1) pushFailure(failures, "missing-required", "f(extra=1)", JSON.stringify(arity[2]));
    if (arity[3]?.line !== 5 || arity[3]?.column !== 6) pushFailure(failures, "extra-positional", "f(1, 2)", JSON.stringify(arity[3]));

    expect(failures).toEqual([]);
  });

  it("fuzzes explicit generic type arguments against argument and return checking", () => {
    const failures: Failure[] = [];
    const types = ["int", "float", "string", "bool", "int[]", "string[]"];

    for (const type of types) {
      const good = exprForType(type);
      const bad = badExprForType(type);
      const name = safeName(type);
      expectNoDiagnostics(failures, `generic-explicit-good-${name}`, [
        "fn id<T>(value: T) -> T:",
        "  return value",
        `ok_${name}: ${type} = id<${type}>(${good})`,
      ].join("\n"));

      if (bad) {
        const badArg = [
          "fn id<T>(value: T) -> T:",
          "  return value",
          `bad_${name} = id<${type}>(${bad})`,
        ].join("\n");
        const diagnostics = checkSource(badArg, "strict");
        expectDiagnosticsInSource(failures, `generic-explicit-bad-arg-${name}`, badArg, diagnostics);
        if (!diagnostics.some((diagnostic) => diagnostic.message === `Type '${cleanType(type) === "bool" ? "string" : "bool"}' is not assignable to parameter 'value: ${cleanType(type)}'`)) {
          pushFailure(failures, `generic-explicit-bad-arg-${name}`, badArg, formatDiagnostics(diagnostics));
        }
      }
    }

    expectDiagnostic(failures, "generic-explicit-return", [
      "fn id<T>(value: T) -> T:",
      "  return value",
      "bad: int = id<string>(\"x\")",
    ].join("\n"), {
      line: 3,
      column: 12,
      message: "Type 'string' is not assignable to 'int'",
    });

    expect(failures).toEqual([]);
  });

  it("keeps object shape diagnostics on field values and preserves structural interface rules", () => {
    const failures: Failure[] = [];
    const scoped = ["interface User:", "  name: string", "fn make(name: int) -> User:", "  user: User = { name: name }", "  return user"].join("\n");
    const pair = ["interface Pair:", "  left: int", "  right: string", "left = \"bad\"", "p: Pair = { left: left, right: 1 }"].join("\n");
    const structural = ["interface Named:", "  name: string", "interface Point:", "  x: int", "point: Point = { x: 1 }", "bad: Named = point"].join("\n");

    const scopedDiagnostics = checkSource(scoped, "strict");
    expectDiagnosticsInSource(failures, "scoped-shape", scoped, scopedDiagnostics);
    if (scopedDiagnostics[0]?.line !== 4 || scopedDiagnostics[0]?.column !== 24) pushFailure(failures, "scoped-shape-span", scoped, JSON.stringify(scopedDiagnostics[0]));

    const pairDiagnostics = checkSource(pair, "strict");
    expectDiagnosticsInSource(failures, "pair-shape", pair, pairDiagnostics);
    if (pairDiagnostics[0]?.line !== 5 || pairDiagnostics[0]?.column !== 19) pushFailure(failures, "pair-left-span", pair, JSON.stringify(pairDiagnostics[0]));
    if (pairDiagnostics[1]?.line !== 5 || pairDiagnostics[1]?.column !== 32) pushFailure(failures, "pair-right-span", pair, JSON.stringify(pairDiagnostics[1]));

    const structuralDiagnostics = checkSource(structural, "strict");
    expectDiagnosticsInSource(failures, "structural", structural, structuralDiagnostics);
    if (!structuralDiagnostics.some((diagnostic) => diagnostic.message === "Type 'Point' is not assignable to 'Named'")) {
      pushFailure(failures, "structural-interface", structural, formatDiagnostics(structuralDiagnostics));
    }

    expect(failures).toEqual([]);
  });

  it("keeps inference precise for loops, object members, functions, methods, and narrowing", () => {
    const source = [
      "interface User:",
      "  name: string",
      "  age: int",
      "user: User = { name: \"Ada\", age: 36 }",
      "label = user.name",
      "for item of [1, 2]:",
      "  value = item",
      "for key in { a: 1 }:",
      "  name = key",
      "fn id(x: string) -> string:",
      "  return x",
      "out = id(\"ok\")",
      "upper = out.to_upper_case()",
      "maybe: string | null = \"x\"",
      "if maybe != null:",
      "  narrowed = maybe",
    ].join("\n");

    expect(inferSymbolTypes(source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "user", type: "User" }),
      expect.objectContaining({ name: "label", type: "string" }),
      expect.objectContaining({ name: "item", type: "int" }),
      expect.objectContaining({ name: "value", type: "int" }),
      expect.objectContaining({ name: "key", type: "string" }),
      expect.objectContaining({ name: "name", type: "string" }),
      expect.objectContaining({ name: "out", type: "string" }),
      expect.objectContaining({ name: "upper", type: "string" }),
      expect.objectContaining({ name: "narrowed", type: "string" }),
    ]));
  });

  it("fuzzes nullable member access, optional chaining, and symmetric narrowing", () => {
    const failures: Failure[] = [];
    const source = [
      "interface User:",
      "  name: string",
      "maybe: User | null = null",
      "bad = maybe.name",
      "ok = maybe?.name",
      "need: string = maybe?.name",
      "ok_key = maybe?.[\"name\"]",
      "need_key: string = maybe?.[\"name\"]",
      "if maybe != null:",
      "  narrowed = maybe.name",
      "if null !== maybe:",
      "  narrowed_again = maybe.name",
    ].join("\n");

    const diagnostics = checkSource(source, "strict");
    expectDiagnosticsInSource(failures, "nullable-member", source, diagnostics);
    if (!diagnostics.some((diagnostic) => diagnostic.line === 4 && diagnostic.column === 7 && diagnostic.message === "Cannot access member 'name' on nullable type 'User | null'")) {
      pushFailure(failures, "nullable-member-direct", source, formatDiagnostics(diagnostics));
    }
    if (!diagnostics.some((diagnostic) => diagnostic.line === 6 && diagnostic.column === 16 && diagnostic.message === "Type 'string | undefined' is not assignable to 'string'")) {
      pushFailure(failures, "nullable-member-optional", source, formatDiagnostics(diagnostics));
    }
    if (!diagnostics.some((diagnostic) => diagnostic.line === 8 && diagnostic.column === 20 && diagnostic.message === "Type 'string | undefined' is not assignable to 'string'")) {
      pushFailure(failures, "nullable-member-optional-computed", source, formatDiagnostics(diagnostics));
    }
    const symbols = inferSymbolTypes(source);
    for (const expected of [
      { name: "ok", type: "string | undefined" },
      { name: "ok_key", type: "string | undefined" },
      { name: "narrowed", type: "string" },
      { name: "narrowed_again", type: "string" },
    ]) {
      if (!symbols.some((symbol) => symbol.name === expected.name && symbol.type === expected.type)) {
        pushFailure(failures, `nullable-infer-${expected.name}`, source, JSON.stringify(symbols));
      }
    }

    expect(failures).toEqual([]);
  });

  it("covers every builtin and chart signature from the language spec", () => {
    const failures: Failure[] = [];
    const covered = {
      builtins: 0,
      charts: 0,
      badParams: 0,
      possibleBadParams: 0,
    };

    for (const [name, spec] of Object.entries(TERA_BUILTINS)) {
      const args = validArgs(spec.params);
      const result = `ret_${safeName(name)}`;
      const source = [`__any: any = 1`, `${result} = ${name}${explicitFuzzTypeArgs(spec.typeParams)}(${args})`].join("\n");
      expectNoDiagnostics(failures, `builtin-good-${name}`, source);
      const symbols = inferSymbolTypes(source);
      const expected = expectedBuiltinReturn(name, spec);
      if (!symbols.some((symbol) => symbol.name === result && symbol.type === expected)) {
        pushFailure(failures, `builtin-return-${name}`, source, JSON.stringify(symbols));
      }
      covered.builtins++;

      const target = typedBadTarget(spec.params, spec.typeParams);
      if (target) covered.possibleBadParams++;
      const badArgs = target ? validArgsWithBadParam(spec.params, target) : null;
      if (target && badArgs) {
        const badSource = [`__any: any = 1`, `${name}(${badArgs})`].join("\n");
        const diagnostics = checkSource(badSource, "strict");
        expectDiagnosticsInSource(failures, `builtin-bad-${name}`, badSource, diagnostics);
        if (!diagnostics.some((diagnostic) => diagnostic.message.includes(`parameter '${target.name}:`))) {
          pushFailure(failures, `builtin-bad-${name}`, badSource, formatDiagnostics(diagnostics));
        }
        covered.badParams++;
      }
    }

    for (const [name, spec] of Object.entries(TERA_CHART_METHODS)) {
      const args = validArgs(spec.params);
      const result = `ret_chart_${safeName(name)}`;
      const source = [`__any: any = 1`, `${result} = chart.${name}(${args})`].join("\n");
      expectNoDiagnostics(failures, `chart-good-${name}`, source);
      const symbols = inferSymbolTypes(source);
      const expected = cleanType(spec.returns ?? "undefined");
      if (!symbols.some((symbol) => symbol.name === result && symbol.type === expected)) {
        pushFailure(failures, `chart-return-${name}`, source, JSON.stringify(symbols));
      }
      covered.charts++;

      const target = typedBadTarget(spec.params);
      if (target) covered.possibleBadParams++;
      const badArgs = target ? validArgsWithBadParam(spec.params, target) : null;
      if (target && badArgs) {
        const badSource = [`__any: any = 1`, `chart.${name}(${badArgs})`].join("\n");
        const diagnostics = checkSource(badSource, "strict");
        expectDiagnosticsInSource(failures, `chart-bad-${name}`, badSource, diagnostics);
        if (!diagnostics.some((diagnostic) => diagnostic.message.includes(`parameter '${target.name}:`))) {
          pushFailure(failures, `chart-bad-${name}`, badSource, formatDiagnostics(diagnostics));
        }
        covered.badParams++;
      }
    }

    if (covered.builtins !== Object.keys(TERA_BUILTINS).length) pushFailure(failures, "builtin-coverage", "", JSON.stringify(covered));
    if (covered.charts !== Object.keys(TERA_CHART_METHODS).length) pushFailure(failures, "chart-coverage", "", JSON.stringify(covered));
    if (covered.badParams !== covered.possibleBadParams) pushFailure(failures, "bad-param-coverage", "", JSON.stringify(covered));

    expect(failures).toEqual([]);
  });

  it("covers every pseudo type method and every kind method from the language spec", () => {
    const failures: Failure[] = [];
    const covered = {
      pseudoMethods: 0,
      kindMethods: 0,
      badParams: 0,
      possibleBadParams: 0,
    };
    const representatives = new Map<string, string>();
    for (const [name, spec] of Object.entries(TERA_BUILTINS)) {
      if (spec.kind && TERA_KIND_METHODS[spec.kind as keyof typeof TERA_KIND_METHODS] && !representatives.has(spec.kind)) {
        representatives.set(spec.kind, name);
      }
    }

    for (const [owner, spec] of Object.entries(TERA_PSEUDO_TYPES)) {
      for (const method of spec.methods ?? []) {
        const receiverType = pseudoReceiverType(owner, spec);
        const receiver = `recv_${safeName(receiverType)}`;
        const result = `ret_${safeName(owner)}_${safeName(method.name)}`;
        const target = `${receiver}.${method.name}`;
        const expr = method.isGetter ? target : `${target}${explicitFuzzTypeArgs(method.typeParams)}(${validArgs(method.params)})`;
        const source = [`__any: any = 1`, `${receiver}: ${receiverType} = __any`, `${result} = ${expr}`].join("\n");
        expectNoDiagnostics(failures, `pseudo-good-${owner}.${method.name}`, source);
        const expected = expectedMethodReturn(receiverType, method, spec.typeParams);
        const symbols = inferSymbolTypes(source);
        if (!symbols.some((symbol) => symbol.name === result && symbol.type === expected)) {
          pushFailure(failures, `pseudo-return-${owner}.${method.name}`, source, JSON.stringify(symbols));
        }
        covered.pseudoMethods++;

        const targetParam = typedBadTarget(method.params, [...(method.typeParams ?? []), ...(spec.typeParams ?? [])]);
        if (!method.isGetter && targetParam) covered.possibleBadParams++;
        const badArgs = targetParam ? validArgsWithBadParam(method.params, targetParam) : null;
        if (!method.isGetter && targetParam && badArgs) {
          const badSource = [`__any: any = 1`, `${receiver}: ${receiverType} = __any`, `${target}(${badArgs})`].join("\n");
          const diagnostics = checkSource(badSource, "strict");
          expectDiagnosticsInSource(failures, `pseudo-bad-${owner}.${method.name}`, badSource, diagnostics);
          if (!diagnostics.some((diagnostic) => diagnostic.message.includes(`parameter '${targetParam.name}:`))) {
            pushFailure(failures, `pseudo-bad-${owner}.${method.name}`, badSource, formatDiagnostics(diagnostics));
          }
          covered.badParams++;
        }
      }
    }

    for (const [kind, methods] of Object.entries(TERA_KIND_METHODS)) {
      const owner = representatives.get(kind);
      if (!owner) {
        pushFailure(failures, `kind-representative-${kind}`, "", "missing representative builtin");
        continue;
      }
      for (const method of methods as TeraMethodSpec[]) {
        const receiverType = kindReceiver(kind, owner);
        const receiver = `recv_${safeName(receiverType)}`;
        const result = `ret_${safeName(kind)}_${safeName(method.name)}`;
        const target = `${receiver}.${method.name}`;
        const expr = method.isGetter ? target : `${target}${explicitFuzzTypeArgs(method.typeParams)}(${validArgs(method.params)})`;
        const source = [`__any: any = 1`, `${receiver}: ${receiverType} = __any`, `${result} = ${expr}`].join("\n");
        expectNoDiagnostics(failures, `kind-good-${kind}.${method.name}`, source);
        const expected = expectedMethodReturn(receiverType, method);
        const symbols = inferSymbolTypes(source);
        if (!symbols.some((symbol) => symbol.name === result && symbol.type === expected)) {
          pushFailure(failures, `kind-return-${kind}.${method.name}`, source, JSON.stringify(symbols));
        }
        covered.kindMethods++;
      }
    }

    const pseudoCount = Object.values(TERA_PSEUDO_TYPES).flatMap((spec) => spec.methods).length;
    const kindCount = Object.values(TERA_KIND_METHODS).flatMap((methods) => methods).length;
    if (covered.pseudoMethods !== pseudoCount) pushFailure(failures, "pseudo-coverage", "", JSON.stringify(covered));
    if (covered.kindMethods !== kindCount) pushFailure(failures, "kind-coverage", "", JSON.stringify(covered));
    if (covered.badParams !== covered.possibleBadParams) pushFailure(failures, "method-bad-param-coverage", "", JSON.stringify(covered));

    expect(failures).toEqual([]);
  });

  it("covers arity and named-argument contracts from the whole language spec", () => {
    const failures: Failure[] = [];
    const covered = {
      missingRequired: 0,
      possibleMissingRequired: 0,
      extraPositional: 0,
      possibleExtraPositional: 0,
      unknownNamed: 0,
      possibleUnknownNamed: 0,
    };

    function checkCallable(label: string, target: string, params: TeraParam[] | null | undefined, prefix: string[] = ["__any: any = 1"]): void {
      const required = requiredTarget(params);
      if (required) {
        covered.possibleMissingRequired++;
        const source = [...prefix, `${target}()`].join("\n");
        const diagnostics = checkSource(source, "strict");
        expectDiagnosticsInSource(failures, `${label}-missing`, source, diagnostics);
        if (!diagnostics.some((diagnostic) => diagnostic.message.includes(`Missing required argument '${required.name}'`))) {
          pushFailure(failures, `${label}-missing`, source, formatDiagnostics(diagnostics));
        }
        covered.missingRequired++;
      }

      if (!hasRest(params, false)) {
        covered.possibleExtraPositional++;
        const args = appendArg(positionalArgs(params), "true");
        const source = [...prefix, `${target}(${args})`].join("\n");
        const diagnostics = checkSource(source, "strict");
        expectDiagnosticsInSource(failures, `${label}-extra-positional`, source, diagnostics);
        if (!diagnostics.some((diagnostic) => diagnostic.message.includes(`Too many positional arguments for `))) {
          pushFailure(failures, `${label}-extra-positional`, source, formatDiagnostics(diagnostics));
        }
        covered.extraPositional++;
      }

      if (!hasRest(params, true)) {
        covered.possibleUnknownNamed++;
        const args = appendArg(positionalArgs(params), "unknown_spec_arg=true");
        const source = [...prefix, `${target}(${args})`].join("\n");
        const diagnostics = checkSource(source, "strict");
        expectDiagnosticsInSource(failures, `${label}-unknown-named`, source, diagnostics);
        if (!diagnostics.some((diagnostic) => diagnostic.message.includes("Unknown named argument 'unknown_spec_arg'"))) {
          pushFailure(failures, `${label}-unknown-named`, source, formatDiagnostics(diagnostics));
        }
        covered.unknownNamed++;
      }
    }

    for (const [name, spec] of Object.entries(TERA_BUILTINS)) {
      checkCallable(`builtin-${name}`, name, spec.params);
    }

    for (const [name, spec] of Object.entries(TERA_CHART_METHODS)) {
      checkCallable(`chart-${name}`, `chart.${name}`, spec.params);
    }

    for (const [owner, spec] of Object.entries(TERA_PSEUDO_TYPES)) {
      for (const method of spec.methods ?? []) {
        if (method.isGetter) continue;
        const receiverType = pseudoReceiverType(owner, spec);
        const receiver = `recv_${safeName(receiverType)}`;
        checkCallable(`pseudo-${owner}.${method.name}`, `${receiver}.${method.name}`, method.params, ["__any: any = 1", `${receiver}: ${receiverType} = __any`]);
      }
    }

    const representatives = new Map<string, string>();
    for (const [name, spec] of Object.entries(TERA_BUILTINS)) {
      if (spec.kind && TERA_KIND_METHODS[spec.kind as keyof typeof TERA_KIND_METHODS] && !representatives.has(spec.kind)) {
        representatives.set(spec.kind, name);
      }
    }
    for (const [kind, methods] of Object.entries(TERA_KIND_METHODS)) {
      const owner = representatives.get(kind);
      if (!owner) continue;
      for (const method of methods as TeraMethodSpec[]) {
        if (method.isGetter) continue;
        const receiverType = kindReceiver(kind, owner);
        const receiver = `recv_${safeName(receiverType)}`;
        checkCallable(`kind-${kind}.${method.name}`, `${receiver}.${method.name}`, method.params, ["__any: any = 1", `${receiver}: ${receiverType} = __any`]);
      }
    }

    if (covered.missingRequired !== covered.possibleMissingRequired) pushFailure(failures, "missing-coverage", "", JSON.stringify(covered));
    if (covered.extraPositional !== covered.possibleExtraPositional) pushFailure(failures, "extra-coverage", "", JSON.stringify(covered));
    if (covered.unknownNamed !== covered.possibleUnknownNamed) pushFailure(failures, "unknown-coverage", "", JSON.stringify(covered));

    expect(failures).toEqual([]);
  });

  // The passes above cover call sites, arity, and return *types*. The passes below add the
  // surface they do not: member/field access on returned records, indexer access, method
  // chains on returned handles, and function-typed handles threaded back into other builtins.
  // These are exercised through the quantc builtins, which are the spec's richest record shapes.

  function firstType(source: string, name: string): string | undefined {
    return inferSymbolTypes(source).find((symbol) => symbol.name === name)?.type;
  }
  function expectType(failures: Failure[], label: string, source: string, name: string, want: string): void {
    const got = firstType(source, name);
    if (got !== want) pushFailure(failures, label, source, `got ${got}, want ${want}`);
  }

  // A statically valid call for each record/handle-returning builtin (argument values are
  // irrelevant to the checker; only declared parameter types must be satisfied).
  const RESULT_CALLS: Record<string, string> = {
    adf_test: "adf_test([1.5, 2.5, 3.5, 2.0])",
    kpss_test: "kpss_test([1.5, 2.5, 3.5, 2.0])",
    engle_granger: "engle_granger([1.5, 2.5, 3.5], [[1.5], [2.5], [3.5]])",
    johansen: "johansen([[1.5, 2.5], [2.5, 3.5], [3.5, 4.5]])",
    kalman_filter: "kalman_filter([1.5, 2.5], [[1.0], [1.0]], { transition: [[1.0]] })",
    dynamic_beta: "dynamic_beta([1.5, 2.5, 3.5], [[1.5], [2.5], [3.5]])",
    fit_garch: "fit_garch([1.5, 2.5, 3.5, 2.0])",
    backtest: "backtest(DataFrame(a=[1.5, 2.0, 1.8]))",
  };
  const RESULT_TYPE: Record<string, string> = {
    adf_test: "UnitRootTest", kpss_test: "UnitRootTest", engle_granger: "EngleGrangerResult",
    johansen: "JohansenResult", kalman_filter: "KalmanResult", dynamic_beta: "KalmanResult",
    fit_garch: "GarchFit", backtest: "QuantBacktestResult",
  };

  it("resolves every declared field of record-returning builtins (nested + array element)", () => {
    const failures: Failure[] = [];
    const env = createTypeEnv();
    for (const [name, call] of Object.entries(RESULT_CALLS)) {
      const callSource = `__any: any = 1\nr = ${call}`;
      expectNoDiagnostics(failures, `record-call-${name}`, callSource);
      expectType(failures, `record-return-${name}`, callSource, "r", RESULT_TYPE[name]);

      const iface = TERA_BUILTIN_INTERFACES[RESULT_TYPE[name] as keyof typeof TERA_BUILTIN_INTERFACES] as
        { fields: Record<string, { type: string; optional?: boolean }> };
      for (const [fieldName, field] of Object.entries(iface.fields)) {
        const declared = cleanType(field.type);
        const src = `__any: any = 1\nv = ${call}.${fieldName}`;
        expectNoDiagnostics(failures, `record-field-${name}.${fieldName}`, src);
        if (!field.optional) expectType(failures, `record-field-type-${name}.${fieldName}`, src, "v", declared);

        if (declared.endsWith("[]")) {
          const elem = cleanType(declared.slice(0, -2));
          const isrc = `__any: any = 1\nv = ${call}.${fieldName}[0]`;
          expectNoDiagnostics(failures, `record-index-${name}.${fieldName}`, isrc);
          expectType(failures, `record-index-type-${name}.${fieldName}`, isrc, "v", elem);
        }
        const nested = TERA_BUILTIN_INTERFACES[resolveType(declared, env) as keyof typeof TERA_BUILTIN_INTERFACES] as
          { fields: Record<string, { type: string }> } | undefined;
        if (nested && !declared.endsWith("[]")) {
          for (const [nn, nf] of Object.entries(nested.fields)) {
            const nsrc = `__any: any = 1\nv = ${call}.${fieldName}.${nn}`;
            expectNoDiagnostics(failures, `record-nested-${name}.${fieldName}.${nn}`, nsrc);
            expectType(failures, `record-nested-type-${name}.${fieldName}.${nn}`, nsrc, "v", cleanType(nf.type));
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("fuzzes random valid field access and keeps unknown record fields non-concrete", () => {
    const failures: Failure[] = [];
    const names = Object.keys(RESULT_CALLS);
    for (let i = 0; i < 400; i++) {
      const name = pick(names);
      const iface = TERA_BUILTIN_INTERFACES[RESULT_TYPE[name] as keyof typeof TERA_BUILTIN_INTERFACES] as { fields: Record<string, unknown> };
      const field = pick(Object.keys(iface.fields));
      expectNoDiagnostics(failures, `rand-field-${name}.${field}`, `__any: any = 1\nv = ${RESULT_CALLS[name]}.${field}`);
      const got = firstType(`__any: any = 1\nv = ${RESULT_CALLS[name]}.no_such_field_${i}`, "v");
      if (got !== "unknown") pushFailure(failures, `rand-bogus-${name}`, RESULT_CALLS[name], `unknown field inferred as ${got}`);
    }
    expect(failures).toEqual([]);
  });

  it("threads Signal/Portfolio handles into backtest and walk_forward", () => {
    const failures: Failure[] = [];
    for (const factory of ["momentum(20)", "mean_reversion(10)", "zscore(30)"]) {
      expectType(failures, `signal-${factory}`, `sig = ${factory}`, "sig", "Signal");
    }
    for (const factory of ["equal_weight()", "cross_sectional()", "long_short(0.3)"]) {
      expectType(failures, `portfolio-${factory}`, `p = ${factory}`, "p", "Portfolio");
    }
    for (const bt of ["backtest", "walk_forward"]) {
      expectNoDiagnostics(failures, `${bt}-string-handles`, `r = ${bt}(DataFrame(a=[1.5]), signal="momentum", portfolio="long_short")`);
      expectNoDiagnostics(failures, `${bt}-fn-handles`, `r = ${bt}(DataFrame(a=[1.5]), signal=momentum(10), portfolio=long_short(0.2))`);
      expectDiagnostic(failures, `${bt}-bad-signal`, `r = ${bt}(DataFrame(a=[1.5]), signal=42)`, {
        message: "Type 'int' is not assignable to parameter 'signal: string | Signal'",
      });
    }
    expect(failures).toEqual([]);
  });

  it("checks the quill product handle and its .price(...) method chain", () => {
    const failures: Failure[] = [];
    const base = `p = quill("product Foo { }")`;
    expectType(failures, "quill-handle", base, "p", "QuillProduct");
    expectType(failures, "quill-name", `${base}\nn = p.name`, "n", "string | null");
    const priced = `${base}\npr = p.price(rate=0.03, spot=100.0, vol=0.2)`;
    expectNoDiagnostics(failures, "quill-price-call", priced);
    expectType(failures, "quill-price-return", priced, "pr", "QuillPriceResult");
    expectType(failures, "quill-price-field", `${priced}\nx = pr.price`, "x", "float");
    expectType(failures, "quill-greeks-index", `${priced}\ng = pr.greeks["delta"]`, "g", "float");
    expectDiagnostic(failures, "quill-price-missing-rate", `${base}\np.price()`, { message: "Missing required argument 'rate' for QuillProduct.price()" });
    expect(failures).toEqual([]);
  });

  it("types quant weight vectors, smoothed matrices, and scalar/array returns precisely", () => {
    const failures: Failure[] = [];
    const cov = "[[1.0, 0.5], [0.5, 1.0]]";
    for (const call of [`risk_parity(${cov})`, `hrp(${cov})`, `mean_variance([0.1, 0.2], ${cov})`]) {
      expectType(failures, `weights-${call}`, `w = ${call}`, "w", "float[]");
      expectType(failures, `weights-index-${call}`, `w = ${call}\nx = w[0]`, "x", "float");
    }
    const ks = `m = kalman_smoother([1.5, 2.5], [[1.0], [1.0]], { transition: [[1.0]] })`;
    expectType(failures, "kalman-smoother", ks, "m", "float[][]");
    expectType(failures, "kalman-smoother-cell", `${ks}\nx = m[0][0]`, "x", "float");

    const scalars: Array<[string, string]> = [
      ["hurst_exponent([1.5, 2.5])", "float"], ["half_life([1.5, 2.5])", "float"],
      ["roll_spread([1.5, 2.5])", "float"], ["sharpe([0.1, 0.2])", "float"],
      ["cusum_events([1.5, 2.5], 0.1)", "int[]"], ["bsadf([1.5, 2.5])", "float[]"],
      ["tick_rule([1.5, 2.5])", "int[]"], ["vpin([{price: 1.0, volume: 2.0}], 1.0)", "float[]"],
      ["garch_volatility([0.1, 0.2], { omega: 0.1, alpha: 0.1, beta: 0.8 })", "float[]"],
    ];
    for (const [call, want] of scalars) {
      const src = `__any: any = 1\nv = ${call}`;
      expectNoDiagnostics(failures, `scalar-call-${call}`, src);
      expectType(failures, `scalar-type-${call}`, src, "v", want);
    }
    expect(failures).toEqual([]);
  });

  it("rejects bad params on quant builtins with a precise parameter diagnostic", () => {
    const failures: Failure[] = [];
    expectDiagnostic(failures, "garch-bad-params", `garch_volatility([0.1, 0.2], "bad")`, {
      message: "Type 'string' is not assignable to parameter 'params: GarchParams'",
    });
    expectDiagnostic(failures, "adf-bad-lags", `adf_test([1.5, 2.5], lags=true)`, {
      message: "Type 'bool' is not assignable to parameter 'lags: int'",
    });
    expect(failures).toEqual([]);
  });
});
