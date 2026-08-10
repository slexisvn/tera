import { describe, expect, it } from "vitest";
import { Engine } from "../../../src/api/engine.js";
import { Optimizer } from "../../../src/optimizing/optimizer.js";
import { differential, src, type Tier } from "../../helpers/tiers.js";
import {
  IR_CALL_BUILTIN,
  IR_CHECK_PRIMITIVE,
  IR_GENERIC_CALL,
  IR_GENERIC_GET_PROP,
} from "../../../src/optimizing/ir/index.js";
import type { CFGFunction } from "../../../src/optimizing/ir/index.js";
import type { RegisterCompiledFunction } from "../../../src/bytecode/register/ops/bytecode.js";

const jitTiers: Tier[] = ["baseline", "jit", "osr"];

const hot = (declaration: string, call: string) =>
  src(
    declaration,
    "fn run(n: int) -> int:",
    "  last = 0",
    "  i = 0",
    "  while (i < n):",
    "    i = (i + 1)",
    `    last = ${call}`,
    "  return last",
    "x = run(1200)",
    "[x]",
  );

function graphOf(source: string, name: string): CFGFunction {
  const engine = new Engine({
    typecheck: "off",
    tieringPolicy: { jitThreshold: 5, baselineThreshold: 2 },
  });
  engine.run(source);
  const compiledFn = engine
    .collectFunctions()
    .find((fn: RegisterCompiledFunction) => fn.name === name);
  expect(compiledFn).toBeDefined();
  return new Optimizer().compile(compiledFn!).graph;
}

function opcodesOf(graph: CFGFunction): string[] {
  return graph.blocks.flatMap((block) => block.nodes.map((node) => node.type));
}

describe("builtin string methods in the optimizing engine", () => {
  it("lowers a declared string receiver to a single builtin call", () => {
    const graph = graphOf(
      hot("fn code_at(s: string, i: int) -> int:\n  return s.char_code_at(i)", 'code_at("Hi", 0)'),
      "code_at",
    );
    const opcodes = opcodesOf(graph);

    expect(opcodes).toContain(IR_CALL_BUILTIN);
    expect(opcodes).not.toContain(IR_GENERIC_CALL);
    expect(opcodes).not.toContain(IR_GENERIC_GET_PROP);
  });

  it("guards and lowers an undeclared receiver that feedback saw as a string", () => {
    const graph = graphOf(
      hot("fn code_at(s, i):\n  return s.char_code_at(i)", 'code_at("Hi", 0)'),
      "code_at",
    );
    const opcodes = opcodesOf(graph);

    expect(opcodes).toContain(IR_CHECK_PRIMITIVE);
    expect(opcodes).toContain(IR_CALL_BUILTIN);
    expect(opcodes).not.toContain(IR_GENERIC_CALL);
  });

  it("leaves an undeclared receiver alone when feedback never saw a primitive", () => {
    const graph = graphOf(
      hot(
        "fn code_at(s, i):\n  return s.char_code_at(i)",
        "code_at({char_code_at: n => n}, 0)",
      ),
      "code_at",
    );

    expect(opcodesOf(graph)).not.toContain(IR_CHECK_PRIMITIVE);
  });

  it("agrees across tiers for a hot undeclared string receiver", () => {
    expect(
      differential(
        hot("fn code_at(s, i):\n  return s.char_code_at(i)", 'code_at("Hi", 0)'),
        { tiers: jitTiers },
      ),
    ).toEqual(["H".charCodeAt(0)]);
  }, 30000);

  it("deoptimizes correctly when the guarded receiver stops being a string", () => {
    expect(
      differential(
        src(
          "fn code_at(s, i):",
          "  return s.char_code_at(i)",
          "fn run(n: int) -> int:",
          "  last = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          '    last = code_at("Hi", 0)',
          "  return last",
          "warm = run(1200)",
          "swapped = code_at({char_code_at: k => (k + 41)}, 1)",
          "[warm, swapped]",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual(["H".charCodeAt(0), 42]);
  }, 30000);

  it("agrees with the interpreter on a hot declared call", () => {
    expect(
      differential(
        hot(
          "fn code_at(s: string, i: int) -> int:\n  return s.char_code_at(i)",
          'code_at("Hi", 0)',
        ),
        { tiers: jitTiers },
      ),
    ).toEqual(["H".charCodeAt(0)]);
  }, 30000);

  it("agrees with the interpreter when the index is out of range", () => {
    expect(
      differential(
        hot(
          "fn code_at(s: string, i: int) -> int:\n  return s.char_code_at(i)",
          'code_at("Hi", 9)',
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([NaN]);
  }, 30000);

  it("agrees with the interpreter when the receiver is not a string", () => {
    expect(
      differential(
        src(
          "fn own_code_at(index):",
          "  return (index + 1000)",
          "fn code_at(s: string, i: int) -> int:",
          "  return s.char_code_at(i)",
          "fn run(n: int) -> int:",
          "  fake = {char_code_at: own_code_at}",
          "  last = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          "    last = code_at(fake, 7)",
          "  return last",
          "x = run(1200)",
          "[x]",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([1007]);
  }, 30000);

  it("sums the code units of a string in a hot loop", () => {
    expect(
      differential(
        src(
          "fn checksum(s: string) -> int:",
          "  n = s.length",
          "  acc = 0",
          "  i = 0",
          "  while (i < n):",
          "    acc = (acc + s.char_code_at(i))",
          "    i = (i + 1)",
          "  return acc",
          "fn run(n: int) -> int:",
          "  last = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          '    last = checksum("tera")',
          "  return last",
          "x = run(1200)",
          "[x]",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([[..."tera"].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)]);
  }, 30000);

  it("keeps an unboxed integer result when it feeds integer arithmetic", () => {
    expect(
      differential(
        hot(
          "fn packed(s: string) -> int:\n  return (((s.char_code_at(0) * 1000000) + (s.char_code_at(1) * 1000)) + s.char_code_at(2))",
          'packed("tera")',
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([
      "t".charCodeAt(0) * 1000000 + "e".charCodeAt(0) * 1000 + "r".charCodeAt(0),
    ]);
  }, 30000);

  it("keeps a boolean result usable in a comparison", () => {
    expect(
      differential(
        hot(
          "fn is_digit(s: string, i: int) -> bool:\n  c = s.char_code_at(i)\n  return ((c >= 48) and (c <= 57))",
          'is_digit("a7", 1)',
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([true]);
  }, 30000);

  it("lowers a call on a string literal receiver", () => {
    const graph = graphOf(
      hot('fn first() -> int:\n  return "Hi".char_code_at(0)', "first()"),
      "first",
    );

    expect(opcodesOf(graph)).toContain(IR_CALL_BUILTIN);
  });

  it("matches the interpreter at every index including the ends", () => {
    expect(
      differential(
        src(
          "fn codes(s: string) -> [int]:",
          "  out = []",
          "  i = -1",
          "  while (i <= s.length):",
          "    out.push(s.char_code_at(i))",
          "    i = (i + 1)",
          "  return out",
          "fn run(n: int):",
          "  last = []",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          '    last = codes("ab")',
          "  return last",
          "x = run(1200)",
          "[x]",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([[NaN, "a".charCodeAt(0), "b".charCodeAt(0), NaN]]);
  }, 30000);

  it("lowers a declared string length getter to a builtin call", () => {
    const graph = graphOf(
      hot("fn size(s: string) -> int:\n  return s.length", 'size("tera")'),
      "size",
    );
    const opcodes = opcodesOf(graph);

    expect(opcodes).toContain(IR_CALL_BUILTIN);
    expect(opcodes).not.toContain(IR_GENERIC_GET_PROP);
  });

  it("evaluates a loop-invariant length once instead of once per iteration", () => {
    const graph = graphOf(
      hot(
        "fn checksum(s: string) -> int:\n  acc = 0\n  i = 0\n  while (i < s.length):\n    acc = (acc + s.char_code_at(i))\n    i = (i + 1)\n  return acc",
        'checksum("tera")',
      ),
      "checksum",
    );
    const lengthCalls = graph.blocks.flatMap((block) =>
      block.nodes
        .filter((node) => node.props.name === "string.length")
        .map(() => block),
    );

    expect(lengthCalls).toHaveLength(1);
    expect(lengthCalls[0]!.predecessors).toHaveLength(0);
  });

  it("agrees with the interpreter when the length drives the loop bound", () => {
    expect(
      differential(
        hot(
          "fn checksum(s: string) -> int:\n  acc = 0\n  i = 0\n  while (i < s.length):\n    acc = (acc + s.char_code_at(i))\n    i = (i + 1)\n  return acc",
          'checksum("tera")',
        ),
        { tiers: jitTiers },
      ),
    ).toEqual([[..."tera"].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)]);
  }, 30000);

  it("stays correct after the receiver type is violated at run time", () => {
    expect(
      differential(
        src(
          "fn own_code_at(index):",
          "  return (index + 1000)",
          "fn code_at(s: string, i: int) -> int:",
          "  return s.char_code_at(i)",
          "fn run(n: int) -> int:",
          "  fake = {char_code_at: own_code_at}",
          "  total = 0",
          "  i = 0",
          "  while (i < n):",
          "    i = (i + 1)",
          '    total = (total + code_at("A", 0))',
          "  return (total + code_at(fake, 7))",
          "x = run(1200)",
          "[x]",
        ),
        { tiers: jitTiers },
      ),
    ).toEqual(["A".charCodeAt(0) * 1200 + 1007]);
  }, 30000);
});
