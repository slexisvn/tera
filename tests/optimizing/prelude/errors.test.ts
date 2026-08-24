import { describe, expect, it } from "vitest";
import { parse } from "../../../src/frontend/parser/language.js";
import {
  errorPrelude,
  ERROR_DISPLAY_PREFIX,
  ERROR_GLOBAL,
  ERROR_MESSAGE_FIELD,
} from "../../../src/optimizing/prelude/errors.js";

const src = (...lines: string[]) => `${lines.join("\n")}\n`;

const preludeFor = (source: string) => errorPrelude([parse(source)]);

const classesIn = (prelude: string) =>
  prelude
    .split("\n")
    .filter((line) => line.startsWith("class "))
    .map((line) => line.slice("class ".length).replace(":", ""));

describe("errorPrelude", () => {
  it("declares the error class for a program that constructs one", () => {
    expect(classesIn(preludeFor(src('throw Error("boom")')))).toEqual([ERROR_GLOBAL]);
  });

  it("declares the error class for a program that only extends one", () => {
    expect(
      classesIn(
        preludeFor(
          src(
            "class AppError extends Error:",
            "  public constructor(msg: string):",
            "    super(msg)",
          ),
        ),
      ),
    ).toEqual([ERROR_GLOBAL]);
  });

  it("finds the name however deeply the program nests it", () => {
    expect(
      preludeFor(
        src(
          "fn risky(n: int) -> int:",
          "  while n > 0:",
          "    if n == 1:",
          '      throw Error("deep")',
          "    n -= 1",
          "  return n",
        ),
      ),
    ).not.toBe("");
  });

  it("declares nothing for a program that never names an error", () => {
    expect(preludeFor(src("try:", '  throw "boom"', "catch e:", "  print(e)"))).toBe("");
  });

  it("declares nothing for a program that spells the name only as text", () => {
    expect(preludeFor(src('print("Error: not really")'))).toBe("");
  });

  it("stands aside for a program that declares the class itself", () => {
    expect(
      preludeFor(
        src(
          "class Error:",
          "  public code: int",
          "  public constructor(code: int):",
          "    this.code = code",
          "throw Error(4)",
        ),
      ),
    ).toBe("");
  });

  it("declares the class once for several roots that all name it", () => {
    const prelude = errorPrelude([
      parse(src('throw Error("a")')),
      parse(src('throw Error("b")')),
    ]);

    expect(classesIn(prelude)).toEqual([ERROR_GLOBAL]);
  });

  it("stands aside when any root declares the class", () => {
    const prelude = errorPrelude([
      parse(src('throw Error("a")')),
      parse(src("class Error:", "  public constructor():", "    this.n = 1")),
    ]);

    expect(prelude).toBe("");
  });

  it("gives the class the message field a handler reads", () => {
    const prelude = preludeFor(src('throw Error("boom")'));

    expect(prelude).toContain(`  public ${ERROR_MESSAGE_FIELD}: string`);
    expect(prelude).toContain(`    this.${ERROR_MESSAGE_FIELD} = ${ERROR_MESSAGE_FIELD}`);
  });

  it("takes the message as the one constructor parameter", () => {
    expect(preludeFor(src('throw Error("boom")'))).toContain(
      `  public constructor(${ERROR_MESSAGE_FIELD}: string):`,
    );
  });

  it("parses back into a class the compiler can see", () => {
    const program = parse(preludeFor(src('throw Error("boom")')));
    const declared = (program.body as { type: string; name?: string }[]).filter(
      (node) => node.type === "ClassDeclaration",
    );

    expect(declared.map((node) => node.name)).toEqual([ERROR_GLOBAL]);
  });

  it("names the display prefix after the class it declares", () => {
    expect(ERROR_DISPLAY_PREFIX.startsWith(ERROR_GLOBAL)).toBe(true);
    expect(preludeFor(src('throw Error("boom")'))).toContain(
      `class ${ERROR_DISPLAY_PREFIX.trimEnd()}`,
    );
  });
});
