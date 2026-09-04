import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../helpers/engine.js";
import { compilerOptions } from "../../../src/optimizing/options.js";
import {
  calleeSymbolName,
  IR_CALL_KNOWN_FUNCTION,
  type CFGFunction,
} from "../../../src/optimizing/ir/index.js";

const LOWERING = "text-method-calls";
const ENTRY = "tera_program";
const PRELUDE_FUNCTION = "_text_last_index_of";

const src = (...lines: string[]) => lines.join("\n");

function preludeCallsIn(graph: CFGFunction): number {
  let found = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_CALL_KNOWN_FUNCTION) continue;
      if (calleeSymbolName(node) === PRELUDE_FUNCTION) found++;
    }
  }
  return found;
}

function preludeCalls(source: string): number {
  let taken: number | null = null;
  nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
    format: "assembly",
    compilerOptions: compilerOptions("speed", {
      passTracer: (record) => {
        if (record.pass !== LOWERING) return;
        if (record.graph.name === ENTRY) taken = preludeCallsIn(record.graph);
      },
    }),
  });
  if (taken === null) throw new Error(`${LOWERING} never ran over ${ENTRY}`);
  return taken;
}

describe("claiming a member both text and an array carry, by the receiver's type", () => {
  it("sends a string receiver to the prelude function", () => {
    expect(preludeCalls(src('s = "abcabc"', 'print(s.last_index_of("b"))'))).toBe(1);
  });

  it("sends every string call site of one program to it", () => {
    expect(
      preludeCalls(
        src('s = "abcabc"', 'print(s.last_index_of("b"))', 'print(s.last_index_of("c"))'),
      ),
    ).toBe(2);
  });

  it("leaves an array receiver to the array lowering", () => {
    expect(preludeCalls(src("xs: int[] = [1, 2, 1]", "print(xs.last_index_of(1))"))).toBe(0);
  });

  it("leaves an array of strings to the array lowering", () => {
    expect(
      preludeCalls(src('xs: string[] = ["a", "b", "a"]', 'print(xs.last_index_of("a"))')),
    ).toBe(0);
  });

  it("leaves a class that declares the member itself alone", () => {
    expect(
      preludeCalls(
        src(
          "class Log:",
          "  public last_index_of(t: string) -> int:",
          "    return 7",
          'print(Log().last_index_of("x"))',
        ),
      ),
    ).toBe(0);
  });

  it("leaves a member of another name alone", () => {
    expect(preludeCalls(src('s = "abcabc"', 'print(s.index_of("b"))'))).toBe(0);
  });
});
