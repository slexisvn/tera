import { describe, expect, it } from "vitest";
import { Engine, nativeToTagged, taggedToNative, type RuntimeFunctionPayload, type TaggedValue, type TeraExtension } from "../../src/index.js";
import { REACTIVE_INTRINSICS, createReactiveRuntimeBuiltins, reactiveCheckerMetadata, reactiveCompilerMetadata, reactiveSyntaxPlugin } from "@slexisvn/reactive/tera";

const converters = { nativeToTagged, taggedToNative };

function optimizedOnlyExtension(): TeraExtension {
  return {
    name: "reactive-optimized-only",
    syntaxPlugins: [reactiveSyntaxPlugin()],
    runtimeBuiltins: createReactiveRuntimeBuiltins(converters),
    checker: reactiveCheckerMetadata,
    compiler: reactiveCompilerMetadata,
  };
}

function collectConstantStrings(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") out.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectConstantStrings(item, out);
  }
  if (value && typeof value === "object" && Array.isArray((value as { constants?: unknown }).constants)) {
    collectConstantStrings((value as { constants: unknown[] }).constants, out);
  }
  return out;
}

function optimizedIntrinsicNames(engine: Engine, name: string): string[] {
  const fn = engine.collectFunctions().find((candidate) => candidate.name === name);
  expect(fn).toBeTruthy();
  const optimizing = engine as unknown as {
    optimizer: {
      setCompilerExtensions(extensions: unknown): void;
      compile(compiledFn: unknown): { graph: { blocks: Array<{ nodes: Array<{ type: string; props: Record<string, unknown> }> }> } };
    };
    compilerExtensionsFor(compiledFn: unknown): unknown;
  };
  optimizing.optimizer.setCompilerExtensions(optimizing.compilerExtensionsFor(fn));
  const { graph } = optimizing.optimizer.compile(fn);
  const names: string[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === "CallIntrinsic" && typeof node.props.name === "string") names.push(node.props.name);
    }
  }
  return names;
}

function hotCounterProgram(callCount: number): string {
  return [
    "signal count = 0",
    "fn tick() -> int:",
    "  count.update(value => value + 1)",
    "  return count",
    ...Array.from({ length: callCount }, () => "tick()"),
  ].join("\n");
}

describe("reactive Tera optimizer", () => {
  it("lowers reactive syntax and hot handle operations to engine intrinsics", () => {
    const engine = new Engine({ typecheck: "off", extensions: [optimizedOnlyExtension()] });
    const compiled = engine.compile([
      "signal count = 1",
      "computed doubled = count * 2",
      "effect:",
      "  print(doubled)",
      "count.set(2)",
      "count.update(value => value + value)",
      "print(count.peek())",
    ].join("\n"));
    const constants = collectConstantStrings(compiled);
    const disassembly = compiled.disassemble();

    expect([...constants]).toEqual(expect.arrayContaining([
      "__tera_reactive_signal",
      "__tera_reactive_computed",
      "__tera_reactive_read",
      "__tera_reactive_effect",
      "__tera_reactive_write",
      "__tera_reactive_update",
      "__tera_reactive_peek",
    ]));
    expect(constants.has("Signal")).toBe(false);
    expect(constants.has("computed")).toBe(false);
    expect(constants.has("effect")).toBe(false);
    expect(disassembly).toContain("CallIntrinsic");
    expect(disassembly).not.toContain("LdaGlobal [0] (__tera_reactive_signal)");
  });

  it("runs reactive syntax through optimized runtime intrinsics without public host builtins", () => {
    const prints: string[] = [];
    const engine = new Engine({ typecheck: "off", extensions: [optimizedOnlyExtension()], output: (text) => prints.push(String(text)) });

    engine.runNative([
      "signal count = 1",
      "computed doubled = count * 2",
      "effect:",
      "  print(\"render\", doubled)",
      "count.set(2)",
      "count.update(value => value + 1)",
      "print(\"peek\", count.peek())",
    ].join("\n"));

    expect(prints).toEqual(["render 2", "render 4", "render 6", "peek 3"]);
  });

  it("lowers all hot reactive operations to runtime intrinsic bytecode", () => {
    const engine = new Engine({ typecheck: "off", extensions: [optimizedOnlyExtension()] });
    const compiled = engine.compile([
      "signal count = 1",
      "computed doubled = count * 2",
      "resource data = count + 1",
      "effect:",
      "  print(data.value)",
      "watch(count, (value, previous) => value)",
      "fn change() -> any:",
      "  count.set(2)",
      "  count.update(value => value + value)",
      "  data.mutate(9)",
      "  data.refetch()",
      "  return untrack(() => data.latest)",
      "batch(change)",
      "print(data.state, data.loading, data.error, count.peek())",
    ].join("\n"));
    const disassembly = compiled.disassemble() + "\n" + compiled.constants
      .filter((constant) => constant && typeof constant === "object" && Array.isArray((constant as { instructions?: unknown }).instructions))
      .map((constant) => (constant as { disassemble(): string }).disassemble())
      .join("\n");

    expect(disassembly).toEqual(expect.stringContaining(`CallIntrinsic`));
    for (const name of Object.values(REACTIVE_INTRINSICS)) {
      expect(disassembly).toContain(name);
    }
    expect(disassembly).not.toMatch(/LdaGlobal .*__tera_reactive_/);
  });

  it("optimizes resource members and methods through runtime intrinsics", () => {
    const prints: string[] = [];
    const engine = new Engine({ typecheck: "off", extensions: [optimizedOnlyExtension()], output: (text) => prints.push(String(text)) });

    engine.runNative([
      "signal count = 2",
      "resource doubled = count * 2",
      "print(doubled.state, doubled.loading, doubled.peek())",
      "doubled.mutate(9)",
      "print(doubled.latest, doubled.value)",
    ].join("\n"));

    expect(prints).toEqual(["ready false 4", "9 9"]);
  });

  it("keeps intrinsic guards observable at runtime", () => {
    const engine = new Engine({ typecheck: "off", runtimeBuiltins: createReactiveRuntimeBuiltins(converters) });

    expect(engine.runNative("__tera_reactive_read({ value: 7 })")).toBe(7);
    expect(() => engine.runNative("__tera_reactive_read(1)")).toThrow("__tera_reactive_read expects a reactive handle");
  });

  it("does not lower ordinary locals that shadow reactive handles", () => {
    const engine = new Engine({
      typecheck: "off",
      extensions: [optimizedOnlyExtension()],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "signal count = 7",
      "fn read() -> int:",
      "  let count = 2",
      "  return count",
      "read()",
      "read()",
      "read()",
      "read()",
      "read()",
      "read()",
    ].join("\n"))).toBe(2);

    const read = engine.collectFunctions().find((fn) => fn.name === "read");
    expect(read?.optimizedCode).toBeTruthy();
    expect(read?.compileFailureCount).toBe(0);
    expect(optimizedIntrinsicNames(engine, "read")).not.toContain(REACTIVE_INTRINSICS.read);
  });

  it("does not lower lexically declared functions named like reactive builtins", () => {
    const engine = new Engine({
      typecheck: "off",
      extensions: [optimizedOnlyExtension()],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "fn effect(value) -> int:",
      "  return value + 1",
      "fn run() -> int:",
      "  return effect(1)",
      "run()",
      "run()",
      "run()",
      "run()",
      "run()",
      "run()",
    ].join("\n"))).toBe(2);

    const run = engine.collectFunctions().find((fn) => fn.name === "run");
    expect(run?.optimizedCode).toBeTruthy();
    expect(run?.compileFailureCount).toBe(0);
    expect(optimizedIntrinsicNames(engine, "run")).not.toContain(REACTIVE_INTRINSICS.effect);
  });

  it("still lowers reactive syntax forms when user declarations share builtin names", () => {
    const prints: string[] = [];
    const engine = new Engine({
      typecheck: "off",
      extensions: [optimizedOnlyExtension()],
      output: (text) => prints.push(String(text)),
    });

    engine.runNative([
      "fn Signal(value) -> int:",
      "  return 0",
      "fn effect(value) -> int:",
      "  return 0",
      "signal count = 1",
      "effect:",
      "  print(count)",
      "count.set(2)",
    ].join("\n"));

    expect(prints).toEqual(["1", "2"]);
  });

  it("runs runtime intrinsic bytecode through the baseline tier", () => {
    const engine = new Engine({
      typecheck: "off",
      extensions: [optimizedOnlyExtension()],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 1_000_000 },
    });

    expect(engine.runNative(hotCounterProgram(4))).toBe(4);

    const tick = engine.collectFunctions().find((fn) => fn.name === "tick");
    expect(tick?.baselineCode?._isBaseline).toBe(true);
  });

  it("runs runtime intrinsic bytecode through the optimized JIT tier", () => {
    const engine = new Engine({
      typecheck: "off",
      extensions: [optimizedOnlyExtension()],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative(hotCounterProgram(6))).toBe(6);

    const tick = engine.collectFunctions().find((fn) => fn.name === "tick");
    const disassembly = tick?.disassemble() ?? "";
    expect(tick?.baselineCode?._isBaseline).toBe(true);
    expect(tick?.optimizedCode).toBeTruthy();
    expect(tick?.compileFailureCount).toBe(0);
    expect(tick?.lastCompileFailureReason).toBeNull();
    expect(disassembly).toContain("CallIntrinsic");
    expect(disassembly).toContain(REACTIVE_INTRINSICS.peek);
    expect(disassembly).toContain(REACTIVE_INTRINSICS.write);
    expect(disassembly).toContain(REACTIVE_INTRINSICS.read);
    expect(disassembly).not.toContain(REACTIVE_INTRINSICS.update);
    expect(disassembly).not.toMatch(/LdaGlobal .*__tera_reactive_/);
  });

  it("projects reactive intrinsic effects into Tera IR metadata", () => {
    const seen: Array<Record<string, unknown>> = [];
    const engine = new Engine({
      typecheck: "off",
      extensions: [{
        ...optimizedOnlyExtension(),
        name: "reactive-ir-inspect",
        compiler: {
          ...reactiveCompilerMetadata,
          optimizerPasses: [
            ...(reactiveCompilerMetadata.optimizerPasses ?? []),
            {
              name: "inspect-reactive-intrinsic-ir",
              phase: "ir",
              run(target) {
                for (const block of (target as { blocks?: Array<{ nodes: Array<{ type: string; props: Record<string, unknown>; effectKind: string }> }> }).blocks ?? []) {
                  for (const node of block.nodes) {
                    if (node.type !== "CallIntrinsic") continue;
                    if (typeof node.props.name !== "string" || !node.props.name.startsWith("__tera_reactive_")) continue;
                    seen.push({
                      type: node.type,
                      name: node.props.name,
                      effectKind: node.effectKind,
                      pure: node.props.pure,
                      readonly: node.props.readonly,
                      effects: node.props.intrinsicEffects,
                      reads: node.props.intrinsicReads,
                      writes: node.props.intrinsicWrites,
                      allocates: node.props.intrinsicAllocates,
                    });
                  }
                }
              },
            },
          ],
        },
      }],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "signal count = 0",
      "fn inspect() -> int:",
      "  count.peek()",
      "  count.update(value => value + 1)",
      "  return count",
      "inspect()",
      "inspect()",
      "inspect()",
      "inspect()",
      "inspect()",
      "inspect()",
    ].join("\n"))).toBe(6);

    expect(seen).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: REACTIVE_INTRINSICS.peek,
        type: "CallIntrinsic",
        effectKind: "read",
        pure: true,
        readonly: true,
        effects: ["read"],
        reads: ["reactive-value"],
      }),
      expect.objectContaining({
        name: REACTIVE_INTRINSICS.write,
        type: "CallIntrinsic",
        effectKind: "write",
        pure: undefined,
        readonly: undefined,
        effects: ["reactive-write", "schedule"],
        writes: ["reactive-value"],
      }),
      expect.objectContaining({
        name: REACTIVE_INTRINSICS.read,
        type: "CallIntrinsic",
        effectKind: "call",
        pure: undefined,
        readonly: undefined,
        effects: ["reactive-read"],
        reads: ["reactive-value"],
      }),
    ]));
  });

  it("eliminates unused readonly reactive peek calls in optimized code", () => {
    let peekCalls = 0;
    const runtimeBuiltins = createReactiveRuntimeBuiltins(converters);
    const originalPeek = runtimeBuiltins[REACTIVE_INTRINSICS.peek] as RuntimeFunctionPayload;
    runtimeBuiltins[REACTIVE_INTRINSICS.peek] = {
      ...originalPeek,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        peekCalls++;
        return originalPeek.call!(args, thisValue, interpreter);
      },
    };
    const engine = new Engine({
      typecheck: "off",
      extensions: [{
        name: "reactive-peek-dce",
        syntaxPlugins: [reactiveSyntaxPlugin()],
        runtimeBuiltins,
        checker: reactiveCheckerMetadata,
        compiler: reactiveCompilerMetadata,
      }],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "signal count = 0",
      "fn tick(value) -> int:",
      "  count.peek()",
      "  count.set(value)",
      "  return count",
      "tick(1)",
      "tick(2)",
      "tick(3)",
      "tick(4)",
      "tick(5)",
      "tick(6)",
      "tick(7)",
      "tick(8)",
    ].join("\n"))).toBe(8);

    const tick = engine.collectFunctions().find((fn) => fn.name === "tick");
    expect(tick?.optimizedCode).toBeTruthy();
    expect(tick?.compileFailureCount).toBe(0);
    expect(peekCalls).toBeGreaterThan(0);
    expect(peekCalls).toBeLessThan(8);
  });

  it("lowers simple signal updates to peek plus write instead of callback update", () => {
    let updateCalls = 0;
    let writeCalls = 0;
    let peekCalls = 0;
    const runtimeBuiltins = createReactiveRuntimeBuiltins(converters);
    const originalUpdate = runtimeBuiltins[REACTIVE_INTRINSICS.update] as RuntimeFunctionPayload;
    const originalWrite = runtimeBuiltins[REACTIVE_INTRINSICS.write] as RuntimeFunctionPayload;
    const originalPeek = runtimeBuiltins[REACTIVE_INTRINSICS.peek] as RuntimeFunctionPayload;
    runtimeBuiltins[REACTIVE_INTRINSICS.update] = {
      ...originalUpdate,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        updateCalls++;
        return originalUpdate.call!(args, thisValue, interpreter);
      },
    };
    runtimeBuiltins[REACTIVE_INTRINSICS.write] = {
      ...originalWrite,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        writeCalls++;
        return originalWrite.call!(args, thisValue, interpreter);
      },
    };
    runtimeBuiltins[REACTIVE_INTRINSICS.peek] = {
      ...originalPeek,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        peekCalls++;
        return originalPeek.call!(args, thisValue, interpreter);
      },
    };
    const engine = new Engine({
      typecheck: "off",
      extensions: [{
        name: "reactive-simple-update-lowering",
        syntaxPlugins: [reactiveSyntaxPlugin()],
        runtimeBuiltins,
        checker: reactiveCheckerMetadata,
        compiler: reactiveCompilerMetadata,
      }],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative(hotCounterProgram(8))).toBe(8);

    const tick = engine.collectFunctions().find((fn) => fn.name === "tick");
    const disassembly = tick?.disassemble() ?? "";
    expect(tick?.optimizedCode).toBeTruthy();
    expect(tick?.compileFailureCount).toBe(0);
    expect(disassembly).toContain(REACTIVE_INTRINSICS.peek);
    expect(disassembly).toContain(REACTIVE_INTRINSICS.write);
    expect(disassembly).not.toContain(REACTIVE_INTRINSICS.update);
    expect(updateCalls).toBe(0);
    expect(writeCalls).toBeGreaterThan(0);
    expect(peekCalls).toBeGreaterThan(0);
  });

  it("common-subexpressions duplicate reactive reads in optimized code", () => {
    let readCalls = 0;
    const runtimeBuiltins = createReactiveRuntimeBuiltins(converters);
    const originalRead = runtimeBuiltins[REACTIVE_INTRINSICS.read] as RuntimeFunctionPayload;
    runtimeBuiltins[REACTIVE_INTRINSICS.read] = {
      ...originalRead,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        readCalls++;
        return originalRead.call!(args, thisValue, interpreter);
      },
    };
    const engine = new Engine({
      typecheck: "off",
      extensions: [{
        name: "reactive-read-cse",
        syntaxPlugins: [reactiveSyntaxPlugin()],
        runtimeBuiltins,
        checker: reactiveCheckerMetadata,
        compiler: reactiveCompilerMetadata,
      }],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "signal count = 7",
      "fn diff() -> int:",
      "  return count - count",
      "diff()",
      "diff()",
      "diff()",
      "diff()",
      "diff()",
      "diff()",
      "diff()",
      "diff()",
    ].join("\n"))).toBe(0);

    const diff = engine.collectFunctions().find((fn) => fn.name === "diff");
    expect(diff?.optimizedCode).toBeTruthy();
    expect(diff?.compileFailureCount).toBe(0);
    expect(readCalls).toBeGreaterThan(0);
    expect(readCalls).toBeLessThan(16);
  });

  it("common-subexpressions dominated reactive reads in optimized code", () => {
    let readCalls = 0;
    const runtimeBuiltins = createReactiveRuntimeBuiltins(converters);
    const originalRead = runtimeBuiltins[REACTIVE_INTRINSICS.read] as RuntimeFunctionPayload;
    runtimeBuiltins[REACTIVE_INTRINSICS.read] = {
      ...originalRead,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        readCalls++;
        return originalRead.call!(args, thisValue, interpreter);
      },
    };
    const engine = new Engine({
      typecheck: "off",
      extensions: [{
        name: "reactive-dominated-read-cse",
        syntaxPlugins: [reactiveSyntaxPlugin()],
        runtimeBuiltins,
        checker: reactiveCheckerMetadata,
        compiler: reactiveCompilerMetadata,
      }],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "signal count = 7",
      "fn hot(flag) -> int:",
      "  base = count",
      "  if flag:",
      "    return count - base",
      "  return count - base",
      "hot(true)",
      "hot(false)",
      "hot(true)",
      "hot(false)",
      "hot(true)",
      "hot(false)",
      "hot(true)",
      "hot(false)",
    ].join("\n"))).toBe(0);

    const hot = engine.collectFunctions().find((fn) => fn.name === "hot");
    expect(hot?.optimizedCode).toBeTruthy();
    expect(hot?.compileFailureCount).toBe(0);
    expect(readCalls).toBeGreaterThan(0);
    expect(readCalls).toBeLessThan(16);
  });

  it("common-subexpressions duplicate readonly reactive peeks in optimized code", () => {
    let peekCalls = 0;
    const runtimeBuiltins = createReactiveRuntimeBuiltins(converters);
    const originalPeek = runtimeBuiltins[REACTIVE_INTRINSICS.peek] as RuntimeFunctionPayload;
    runtimeBuiltins[REACTIVE_INTRINSICS.peek] = {
      ...originalPeek,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        peekCalls++;
        return originalPeek.call!(args, thisValue, interpreter);
      },
    };
    const engine = new Engine({
      typecheck: "off",
      extensions: [{
        name: "reactive-peek-cse",
        syntaxPlugins: [reactiveSyntaxPlugin()],
        runtimeBuiltins,
        checker: reactiveCheckerMetadata,
        compiler: reactiveCompilerMetadata,
      }],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "signal count = 7",
      "fn stable() -> int:",
      "  return count.peek() - count.peek()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
    ].join("\n"))).toBe(0);

    const stable = engine.collectFunctions().find((fn) => fn.name === "stable");
    expect(stable?.optimizedCode).toBeTruthy();
    expect(stable?.compileFailureCount).toBe(0);
    expect(peekCalls).toBeGreaterThan(0);
    expect(peekCalls).toBeLessThan(16);
  });

  it("keeps reactive reads available across non-aliasing signal allocations in optimized IR", () => {
    let readCalls = 0;
    let signalCalls = 0;
    const runtimeBuiltins = createReactiveRuntimeBuiltins(converters);
    const originalRead = runtimeBuiltins[REACTIVE_INTRINSICS.read] as RuntimeFunctionPayload;
    const originalSignal = runtimeBuiltins[REACTIVE_INTRINSICS.signal] as RuntimeFunctionPayload;
    runtimeBuiltins[REACTIVE_INTRINSICS.read] = {
      ...originalRead,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        readCalls++;
        return originalRead.call!(args, thisValue, interpreter);
      },
    };
    runtimeBuiltins[REACTIVE_INTRINSICS.signal] = {
      ...originalSignal,
      call(args: TaggedValue[], thisValue?: TaggedValue, interpreter?: object) {
        signalCalls++;
        return originalSignal.call!(args, thisValue, interpreter);
      },
    };
    const engine = new Engine({
      typecheck: "off",
      extensions: [{
        name: "reactive-allocation-alias-cse",
        syntaxPlugins: [reactiveSyntaxPlugin()],
        runtimeBuiltins,
        checker: reactiveCheckerMetadata,
        compiler: reactiveCompilerMetadata,
      }],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "signal count = 7",
      "fn stable() -> int:",
      "  left = count",
      "  scratch = Signal(0)",
      "  return left - count",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
      "stable()",
    ].join("\n"))).toBe(0);

    const stable = engine.collectFunctions().find((fn) => fn.name === "stable");
    expect(stable?.optimizedCode).toBeTruthy();
    expect(stable?.compileFailureCount).toBe(0);
    const names = optimizedIntrinsicNames(engine, "stable");
    expect(names.filter((name) => name === REACTIVE_INTRINSICS.read)).toHaveLength(1);
    expect(names).toContain(REACTIVE_INTRINSICS.signal);
    expect(readCalls).toBeGreaterThan(0);
    expect(readCalls).toBeLessThan(16);
    expect(signalCalls).toBeGreaterThan(8);
  });

  it("does not reuse reactive reads after conditional writes in optimized code", () => {
    const engine = new Engine({
      typecheck: "off",
      extensions: [optimizedOnlyExtension()],
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "signal count = 1",
      "fn hot(flag) -> int:",
      "  base = count",
      "  if flag:",
      "    count.set(base + 1)",
      "    return count - base",
      "  return count - base",
      "hot(true)",
      "hot(false)",
      "hot(true)",
      "hot(false)",
      "hot(true)",
      "hot(false)",
      "hot(true)",
      "hot(true)",
    ].join("\n"))).toBe(1);

    const hot = engine.collectFunctions().find((fn) => fn.name === "hot");
    expect(hot?.optimizedCode).toBeTruthy();
    expect(hot?.compileFailureCount).toBe(0);
  });

  it("does not eliminate untrack callbacks with observable effects", () => {
    const prints: string[] = [];
    const engine = new Engine({
      typecheck: "off",
      extensions: [optimizedOnlyExtension()],
      output: (text) => prints.push(String(text)),
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "fn tick(value):",
      "  untrack(() => print(\"hit\"))",
      "  return value",
      "tick(0)",
      "tick(1)",
      "tick(2)",
      "tick(3)",
      "tick(4)",
      "tick(5)",
      "tick(6)",
      "tick(7)",
    ].join("\n"))).toBe(7);

    const tick = engine.collectFunctions().find((fn) => fn.name === "tick");
    expect(tick?.optimizedCode).toBeTruthy();
    expect(tick?.compileFailureCount).toBe(0);
    expect(prints).toEqual([
      "hit",
      "hit",
      "hit",
      "hit",
      "hit",
      "hit",
      "hit",
      "hit",
    ]);
  });
});
