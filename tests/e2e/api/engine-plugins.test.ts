import { describe, expect, it } from "vitest";
import { Engine, nativeToTagged, taggedToNative } from "../../../src/index.js";

describe("Engine plugins", () => {
  it("installs host builtins in the engine heap", () => {
    const engine = new Engine({
      typecheck: "off",
      hostBuiltins: {
        twice: (value) => Number(value) * 2,
      },
    });

    expect(engine.runNative("twice(21)")).toBe(42);
  });

  it("bridges Tera callbacks to host functions", () => {
    const engine = new Engine({
      typecheck: "off",
      hostBuiltins: {
        call_now: (fn) => {
          if (typeof fn !== "function") throw new TypeError("expected function");
          return fn();
        },
      },
    });

    expect(engine.runNative("call_now(() => 7)")).toBe(7);
  });

  it("accepts named extension presets", () => {
    const engine = new Engine({
      typecheck: "strict",
      extensions: [{
        name: "test-extension",
        checker: {
          builtins: [{ name: "twice", params: [{ name: "value", type: "int" }], returns: "int" }],
        },
        hostBuiltins: {
          twice: (value) => Number(value) * 2,
        },
      }],
    });

    expect(engine.runNative("twice(21)")).toBe(42);
  });

  it("runs extension compiler passes without changing the default pipeline", () => {
    const phases: string[] = [];
    const engine = new Engine({
      typecheck: "off",
      extensions: [{
        name: "compiler-extension",
        compiler: {
          intrinsics: [{
            name: "__test_answer",
            phase: "bytecode",
            returns: "int",
            effects: ["pure"],
            guards: ["answer-guard"],
            deopts: ["answer-deopt"],
          }],
          effects: [{
            name: "answer",
            purity: "pure",
            effects: ["read"],
            guards: ["answer-guard"],
            deopts: ["answer-deopt"],
          }],
          guards: [{
            name: "answer-guard",
            kind: "type",
            target: "int",
            deoptsTo: "answer-deopt",
          }],
          deopts: [{
            name: "answer-deopt",
            reason: "answer value cannot be specialized",
            fallback: "host",
            recoverable: true,
          }],
          optimizerPasses: [{
            name: "inject-answer",
            phase: "ast",
            run(target) {
              phases.push("ast");
              const ast = target as { type?: string; body?: unknown[] };
              if (ast.type !== "Program" || !Array.isArray(ast.body)) return target;
              return {
                ...ast,
                body: [
                  {
                    type: "ExpressionStatement",
                    expression: {
                      type: "AssignmentExpression",
                      target: { type: "Identifier", name: "answer" },
                      value: { type: "Literal", value: 42, kind: "number" },
                    },
                  },
                  ...ast.body,
                ],
              };
            },
          }, {
            name: "mark-semantic",
            phase: "semantic",
            run(target) {
              phases.push("semantic");
              return target;
            },
          }, {
            name: "inspect-bytecode",
            phase: "bytecode",
            run(target) {
              phases.push("bytecode");
              expect(target).toHaveProperty("instructions");
              return target;
            },
          }],
        },
      }],
    });

    expect(engine.compilerExtensions.intrinsics.map((item) => item.name)).toEqual(["__test_answer"]);
    expect(engine.compilerExtensions.effects.map((item) => item.name)).toEqual(["answer"]);
    expect(engine.compilerExtensions.guards.map((item) => item.name)).toEqual(["answer-guard"]);
    expect(engine.compilerExtensions.deopts.map((item) => item.name)).toEqual(["answer-deopt"]);
    expect(engine.runNative("answer")).toBe(42);
    expect(phases).toEqual(["ast", "semantic", "bytecode"]);
  });

  it("orders compiler passes by extension order hints", () => {
    const calls: string[] = [];
    const engine = new Engine({
      compiler: {
        optimizerPasses: [
          { name: "late-pass", phase: "ast", order: "late", run: (target) => { calls.push("late"); return target; } },
          { name: "early-pass", phase: "ast", order: "early", run: (target) => { calls.push("early"); return target; } },
          { name: "normal-pass", phase: "ast", run: (target) => { calls.push("normal"); return target; } },
        ],
      },
    });

    engine.runCompilerPasses("ast", {});

    expect(calls).toEqual(["early", "normal", "late"]);
  });

  it("exposes guard and deopt metadata to IR optimizer passes", () => {
    const seen: string[] = [];
    const engine = new Engine({
      compiler: {
        guards: [{
          name: "reactive-handle",
          kind: "brand",
          target: "ReactiveSignal",
          deoptsTo: "reactive-bailout",
        }],
        deopts: [{
          name: "reactive-bailout",
          reason: "reactive handle cannot be proven local",
          fallback: "host",
          recoverable: true,
        }],
        optimizerPasses: [{
          name: "inspect-ir-context",
          phase: "ir",
          run(target, context) {
            seen.push(context.phase, context.guards[0].name, context.deopts[0].name);
            return { ...(target as Record<string, unknown>), lowered: true };
          },
        }],
      },
    });

    expect(engine.runCompilerPasses("ir", { nodes: [] })).toEqual({ nodes: [], lowered: true });
    expect(seen).toEqual(["ir", "reactive-handle", "reactive-bailout"]);
  });

  it("lowers runtime intrinsics to a dedicated bytecode call opcode", () => {
    const engine = new Engine({
      typecheck: "off",
      runtimeBuiltins: {
        __test_inc: {
          name: "__test_inc",
          call(args) {
            return nativeToTagged(Number(taggedToNative(args[0])) + 1);
          },
        },
      },
      compiler: {
        intrinsics: [{
          name: "__test_inc",
          phase: "bytecode",
          lowering: "runtime",
          parameters: ["value"],
          returns: "int",
          effects: ["pure"],
        }],
      },
    });

    const compiled = engine.compile("__test_inc(41)");

    expect(engine.runNative("__test_inc(41)")).toBe(42);
    expect(compiled.disassemble()).toContain("CallIntrinsic");
    expect(compiled.disassemble()).not.toContain("LdaGlobal [0] (__test_inc)");
  });

  it("runs runtime intrinsic bytecode through the optimized JIT tier", () => {
    const engine = new Engine({
      typecheck: "off",
      runtimeBuiltins: {
        __test_inc: {
          name: "__test_inc",
          call(args) {
            return nativeToTagged(Number(taggedToNative(args[0])) + 1);
          },
        },
      },
      compiler: {
        intrinsics: [{
          name: "__test_inc",
          phase: "bytecode",
          lowering: "runtime",
          parameters: ["value"],
          returns: "int",
          effects: ["pure"],
        }],
      },
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "fn bump(value):",
      "  return __test_inc(value)",
      "bump(0)",
      "bump(1)",
      "bump(2)",
      "bump(3)",
      "bump(4)",
      "bump(5)",
    ].join("\n"))).toBe(6);

    const bump = engine.collectFunctions().find((fn) => fn.name === "bump");
    const disassembly = bump?.disassemble() ?? "";
    expect(bump?.baselineCode?._isBaseline).toBe(true);
    expect(bump?.optimizedCode).toBeTruthy();
    expect(bump?.compileFailureCount).toBe(0);
    expect(bump?.lastCompileFailureReason).toBeNull();
    expect(disassembly).toContain("CallIntrinsic");
    expect(disassembly).not.toContain("LdaGlobal [0] (__test_inc)");
  });

  it("projects runtime intrinsic effect metadata into IR optimizer passes", () => {
    const seen: Array<Record<string, unknown>> = [];
    const engine = new Engine({
      typecheck: "off",
      runtimeBuiltins: {
        __test_track: {
          name: "__test_track",
          call(args) {
            return args[0];
          },
        },
      },
      compiler: {
        intrinsics: [{
          name: "__test_track",
          phase: "bytecode",
          lowering: "runtime",
          parameters: ["value"],
          returns: "int",
          effects: ["reactive-read"],
          guards: ["test-reactive-handle"],
          deopts: ["test-reactive-bailout"],
        }],
        guards: [{
          name: "test-reactive-handle",
          kind: "brand",
          deoptsTo: "test-reactive-bailout",
        }],
        deopts: [{
          name: "test-reactive-bailout",
          reason: "test reactive handle mismatch",
        }],
        optimizerPasses: [{
          name: "inspect-runtime-intrinsic-ir",
          phase: "ir",
          run(target) {
            for (const block of (target as { blocks?: Array<{ nodes: Array<{ type: string; props: Record<string, unknown>; effectKind: string }> }> }).blocks ?? []) {
              for (const node of block.nodes) {
                if (node.type === "CallIntrinsic" && node.props.name === "__test_track") {
                  seen.push({
                    type: node.type,
                    effectKind: node.effectKind,
                    intrinsic: node.props.intrinsic,
                    pure: node.props.pure,
                    effects: node.props.intrinsicEffects,
                    guards: node.props.guards,
                    deopts: node.props.deopts,
                  });
                }
              }
            }
          },
        }],
      },
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "fn observe(value):",
      "  return __test_track(value)",
      "observe(0)",
      "observe(1)",
      "observe(2)",
      "observe(3)",
      "observe(4)",
      "observe(5)",
    ].join("\n"))).toBe(5);

    expect(seen).toContainEqual({
      type: "CallIntrinsic",
      effectKind: "call",
      intrinsic: true,
      pure: undefined,
      effects: ["reactive-read"],
      guards: ["test-reactive-handle"],
      deopts: ["test-reactive-bailout"],
    });
  });

  it("eliminates unused pure runtime intrinsic calls in optimized code", () => {
    let calls = 0;
    const engine = new Engine({
      typecheck: "off",
      runtimeBuiltins: {
        __test_pure_note: {
          name: "__test_pure_note",
          call(args) {
            calls++;
            return args[0];
          },
        },
      },
      compiler: {
        intrinsics: [{
          name: "__test_pure_note",
          phase: "bytecode",
          lowering: "runtime",
          parameters: ["value"],
          returns: "int",
          effects: ["pure"],
        }],
      },
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "fn hot(value):",
      "  __test_pure_note(value)",
      "  return value + 1",
      "hot(0)",
      "hot(1)",
      "hot(2)",
      "hot(3)",
      "hot(4)",
      "hot(5)",
      "hot(6)",
      "hot(7)",
    ].join("\n"))).toBe(8);

    const hot = engine.collectFunctions().find((fn) => fn.name === "hot");
    expect(hot?.optimizedCode).toBeTruthy();
    expect(hot?.compileFailureCount).toBe(0);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(8);
  });

  it("common-subexpressions identical pure runtime intrinsic calls in optimized code", () => {
    let calls = 0;
    const engine = new Engine({
      typecheck: "off",
      runtimeBuiltins: {
        __test_pure_id: {
          name: "__test_pure_id",
          call(args) {
            calls++;
            return args[0];
          },
        },
      },
      compiler: {
        intrinsics: [{
          name: "__test_pure_id",
          phase: "bytecode",
          lowering: "runtime",
          parameters: ["value"],
          returns: "int",
          effects: ["pure"],
        }],
      },
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "fn hot(value: int) -> int:",
      "  return value * 2 + (__test_pure_id(value) - __test_pure_id(value))",
      "hot(0)",
      "hot(1)",
      "hot(2)",
      "hot(3)",
      "hot(4)",
      "hot(5)",
      "hot(6)",
      "hot(7)",
    ].join("\n"))).toBe(14);

    const hot = engine.collectFunctions().find((fn) => fn.name === "hot");
    expect(hot?.optimizedCode).toBeTruthy();
    expect(hot?.compileFailureCount).toBe(0);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(16);
  });

  it("uses per-compile runtime intrinsic metadata for optimized functions", () => {
    const engine = new Engine({
      typecheck: "off",
      runtimeBuiltins: {
        __local_inc: {
          name: "__local_inc",
          call(args) {
            return nativeToTagged(Number(taggedToNative(args[0])) + 1);
          },
        },
      },
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
    });

    expect(engine.runNative([
      "fn bump(value):",
      "  return __local_inc(value)",
      "bump(0)",
      "bump(1)",
      "bump(2)",
      "bump(3)",
      "bump(4)",
      "bump(5)",
    ].join("\n"), {
      compiler: {
        intrinsics: [{
          name: "__local_inc",
          phase: "bytecode",
          lowering: "runtime",
          parameters: ["value"],
          returns: "int",
          effects: ["pure"],
        }],
      },
    })).toBe(6);

    const bump = engine.collectFunctions().find((fn) => fn.name === "bump");
    expect(bump?.optimizedCode).toBeTruthy();
    expect(bump?.compileFailureCount).toBe(0);
    expect(bump?.disassemble()).toContain("CallIntrinsic");
    expect(bump?.disassemble()).not.toContain("LdaGlobal [0] (__local_inc)");
  });

  it("rejects runtime intrinsic lowering without a runtime handler", () => {
    expect(() => new Engine({
      compiler: {
        intrinsics: [{
          name: "__missing_intrinsic",
          lowering: "runtime",
        }],
      },
    })).toThrow("Runtime intrinsic '__missing_intrinsic' is not installed");
  });

  it("rejects duplicate extension names", () => {
    expect(() => new Engine({
      extensions: [
        { name: "dupe" },
        { name: "dupe" },
      ],
    })).toThrow(/Duplicate Tera extension/);
  });

  it("rejects duplicate compiler metadata names", () => {
    expect(() => new Engine({
      extensions: [
        { name: "left", compiler: { intrinsics: [{ name: "__dupe" }] } },
        { name: "right", compiler: { intrinsics: [{ name: "__dupe" }] } },
      ],
    })).toThrow(/Duplicate compiler intrinsic/);

    expect(() => new Engine({
      compiler: {
        guards: [
          { name: "dupe-guard", kind: "brand" },
          { name: "dupe-guard", kind: "shape" },
        ],
      },
    })).toThrow(/Duplicate compiler guard/);

    expect(() => new Engine({
      compiler: {
        deopts: [
          { name: "dupe-deopt", reason: "left" },
          { name: "dupe-deopt", reason: "right" },
        ],
      },
    })).toThrow(/Duplicate compiler deopt/);
  });
});
