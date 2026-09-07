import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import { astToSemanticProgram } from "../../../src/frontend/checker/semantic-lowering.js";
import { provenTakes } from "../../../src/frontend/checker/length-bounds.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

const DECLARED = 'queue: string[] = ["a", "b", "c"]';
const HOLDS_ONE = "if queue.length >= 1:";
const HOLDS_TWO = "if queue.length >= 2:";

function provenLines(source: string): number[] {
  const { body } = astToSemanticProgram(parse(source, {}));
  return [...provenTakes(body)]
    .map((callee) => Number(callee.__line))
    .sort((left, right) => left - right);
}

function provenCount(source: string): number {
  return provenLines(source).length;
}

describe("what a take spends of a proven count", () => {
  it("proves the first take and refuses the next", () => {
    const source = src(DECLARED, HOLDS_ONE, "  a = queue.shift()", "  b = queue.shift()");

    expect(provenLines(source)).toEqual([3]);
  });

  it("counts a put back towards the take that follows it", () => {
    const source = src(
      DECLARED,
      HOLDS_ONE,
      "  a = queue.shift()",
      "  queue.push(a)",
      "  b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([3, 5]);
  });

  it("never lets put backs alone prove a take", () => {
    const source = src(DECLARED, 'queue.push("d")', 'queue.push("e")', "a = queue.shift()");

    expect(provenLines(source)).toEqual([]);
  });

  it("leaves a take on another array out of the count", () => {
    const source = src(
      DECLARED,
      'other: string[] = ["x"]',
      HOLDS_ONE,
      "  a = other.shift()",
      "  b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([5]);
  });

  it("counts both members that take one", () => {
    const source = src(DECLARED, HOLDS_ONE, "  a = queue.pop()", "  b = queue.shift()");

    expect(provenLines(source)).toEqual([3]);
  });

  it("counts a take that a larger expression encloses", () => {
    const source = src(DECLARED, HOLDS_ONE, '  a = queue.shift() + "-" + queue.shift()');

    expect(provenCount(source)).toEqual(1);
  });

  it("keeps the larger count when one test names the array twice", () => {
    const source = src(
      DECLARED,
      "if queue.length >= 2 and queue.length >= 1:",
      "  a = queue.shift()",
      "  b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([3, 4]);
  });

  it("keeps a count already proven when a weaker guard follows", () => {
    const source = src(
      DECLARED,
      "if queue.length >= 3:",
      "  a = queue.shift()",
      "  if queue.length >= 1:",
      "    b = queue.shift()",
      "    c = queue.shift()",
    );

    expect(provenLines(source)).toEqual([3, 5, 6]);
  });

  it("proves as many takes as the guard counted", () => {
    const source = src(
      DECLARED,
      HOLDS_TWO,
      "  a = queue.shift()",
      "  b = queue.shift()",
      "  c = queue.shift()",
    );

    expect(provenLines(source)).toEqual([3, 4]);
  });
});

describe("where the count starts", () => {
  it("starts the count over at the guard, forgetting earlier takes", () => {
    const source = src(DECLARED, HOLDS_ONE, "  a = queue.shift()", HOLDS_ONE, "  b = queue.shift()");

    expect(provenLines(source)).toEqual([3, 5]);
  });

  it("proves nothing about a take that came before the guard", () => {
    const source = src(DECLARED, "a = queue.shift()", HOLDS_ONE, "  b = queue.shift()");

    expect(provenLines(source)).toEqual([4]);
  });

  it("re-proves a count that a loop had made unknown", () => {
    const source = src(
      DECLARED,
      HOLDS_ONE,
      "  while true:",
      "    a = queue.shift()",
      "b = queue.shift()",
      HOLDS_ONE,
      "  c = queue.shift()",
    );

    expect(provenLines(source)).toEqual([7]);
  });
});

describe("a take a loop may repeat", () => {
  it("proves nothing about the take itself", () => {
    const source = src(DECLARED, HOLDS_ONE, "  while true:", "    a = queue.shift()");

    expect(provenLines(source)).toEqual([]);
  });

  it("proves nothing about a take that follows a loop which took one", () => {
    const source = src(
      DECLARED,
      HOLDS_TWO,
      "  while true:",
      "    a = queue.shift()",
      "  b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([]);
  });

  it("leaves the count alone across a loop that only puts back", () => {
    const source = src(DECLARED, HOLDS_ONE, "  while true:", '    queue.push("d")', "  a = queue.shift()");

    expect(provenLines(source)).toEqual([5]);
  });

  it("counts a for loop the same way as a while loop", () => {
    const source = src(DECLARED, HOLDS_ONE, "  for i of range(2):", "    a = queue.shift()");

    expect(provenLines(source)).toEqual([]);
  });

  it("proves nothing after a loop whose own test took an element", () => {
    const source = src(
      DECLARED,
      HOLDS_TWO,
      "  while queue.shift() != null:",
      '    print("round")',
      "  a = queue.shift()",
    );

    expect(provenLines(source)).toEqual([]);
  });

  it("proves a take under the loop's own count on every round", () => {
    const source = src(DECLARED, "while queue.length >= 1:", "  a = queue.shift()", "  b = queue.shift()");

    expect(provenLines(source)).toEqual([3]);
  });
});

describe("takes on separate arms of a branch", () => {
  it("starts each arm from the same count", () => {
    const source = src(
      DECLARED,
      HOLDS_ONE,
      "  if true:",
      "    a = queue.shift()",
      "  else:",
      "    b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([4, 6]);
  });

  it("carries the worst arm into what follows the branch", () => {
    const source = src(
      DECLARED,
      "if queue.length >= 3:",
      "  if true:",
      "    a = queue.shift()",
      "  else:",
      "    b = queue.shift()",
      "    c = queue.shift()",
      "  d = queue.shift()",
      "  e = queue.shift()",
    );

    expect(provenLines(source)).toEqual([4, 6, 7, 8]);
  });

  it("keeps the count across a branch that takes nothing", () => {
    const source = src(
      DECLARED,
      HOLDS_TWO,
      "  if true:",
      '    print("here")',
      "  a = queue.shift()",
      "  b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([5, 6]);
  });

  it("proves what the refuted guard leaves when every arm exits", () => {
    const source = src(
      "fn drain(queue: string[]) -> string:",
      "  if queue.length == 0:",
      '    return "empty"',
      "  return queue.shift()",
    );

    expect(provenLines(source)).toEqual([4]);
  });
});

describe("a take a scope of its own encloses", () => {
  it("proves nothing about a take inside a nested function", () => {
    const source = src(DECLARED, HOLDS_ONE, "  fn later() -> string:", "    return queue.shift()");

    expect(provenLines(source)).toEqual([]);
  });

  it("does not let a put back inside a nested function repay a take", () => {
    const source = src(
      DECLARED,
      HOLDS_ONE,
      "  a = queue.shift()",
      "  fn never():",
      "    queue.push(a)",
      "  b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([3]);
  });

  it("does not let a put back inside a loop repay a take that follows", () => {
    const source = src(
      DECLARED,
      HOLDS_ONE,
      "  a = queue.shift()",
      "  while true:",
      '    queue.push("d")',
      "  b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([3]);
  });

  it("forgets the count once a nested function may have taken from it", () => {
    const source = src(
      DECLARED,
      HOLDS_TWO,
      "  fn drain() -> string:",
      "    return queue.shift()",
      "  a = queue.shift()",
    );

    expect(provenLines(source)).toEqual([]);
  });

  it("sees a take inside a class member the same way", () => {
    const source = src(
      DECLARED,
      HOLDS_ONE,
      "  class Later:",
      "    public go() -> string:",
      "      return queue.shift()",
    );

    expect(provenLines(source)).toEqual([]);
  });

  it("counts a method's own guard against its own takes", () => {
    const source = src(
      "class Queue:",
      "  public items: string[]",
      "  public constructor():",
      "    this.items = []",
      "  public take() -> string:",
      "    if this.items.length == 0:",
      '      return ""',
      "    return this.items.shift()",
      "  public other() -> string:",
      "    return this.items.shift()",
    );

    expect(provenLines(source)).toEqual([8]);
  });

  it("proves nothing about a take inside a lambda the count encloses", () => {
    const source = src(
      DECLARED,
      'names: string[] = ["x"]',
      HOLDS_ONE,
      "  taken = names.map(name => queue.shift())",
    );

    expect(provenLines(source)).toEqual([]);
  });

  it("does not let a put back inside a lambda repay a take", () => {
    const source = src(
      DECLARED,
      'names: string[] = ["x"]',
      HOLDS_ONE,
      "  a = queue.shift()",
      "  taken = names.map(name => queue.push(name))",
      "  b = queue.shift()",
    );

    expect(provenLines(source)).toEqual([4]);
  });
});
