import { describe, expect, it } from "vitest";
import {
  CELL_CONSTANT,
  CELL_MUTABLE,
  CELL_UNINITIALIZED,
  ENTRY_MODULE_SPEC,
  GlobalCell,
  GlobalCellMap,
  cellKey,
  splitCellKey,
} from "../../src/runtime/intrinsics/global-cells.js";
import { RegisterBytecodeCompiler } from "../../src/bytecode/register/compiler/index.js";
import { parse } from "../../src/frontend/parser/language.js";
import * as bytecode from "../../src/bytecode/register/ops/bytecode.js";
import { mkNumber } from "../../src/core/value/index.js";

function globalNames(source: string, options: ConstructorParameters<typeof RegisterBytecodeCompiler>[0]): string[] {
  const compiled = new RegisterBytecodeCompiler(options).compile(parse(source));
  const names: string[] = [];
  for (const instruction of compiled.instructions) {
    if (
      instruction.opcode !== bytecode.ROP_LDA_GLOBAL &&
      instruction.opcode !== bytecode.ROP_STA_GLOBAL
    ) {
      continue;
    }
    names.push(String(compiled.constants[instruction.operands[0]!]));
  }
  return names;
}

describe("cell keys", () => {
  it("leaves the entry module unqualified", () => {
    expect(cellKey(ENTRY_MODULE_SPEC, "x")).toBe("x");
  });

  it("leaves a null module unqualified", () => {
    expect(cellKey(null, "x")).toBe("x");
  });

  it("qualifies every other module", () => {
    expect(cellKey("app.util.text", "slugify")).toBe("app.util.text#slugify");
  });

  it("round-trips a qualified key", () => {
    expect(splitCellKey("app.util.text#slugify")).toEqual({
      module: "app.util.text",
      name: "slugify",
    });
  });

  it("reports no module for a bare key", () => {
    expect(splitCellKey("print")).toEqual({ module: null, name: "print" });
  });
});

describe("cell aliasing", () => {
  it("makes two names share one cell object", () => {
    const cells = new GlobalCellMap();
    const source = cells.getOrCreate("helper#value");
    cells.alias("value", source);
    expect(cells.get("value")).toBe(source);
  });

  it("sees a write made through the other name", () => {
    const cells = new GlobalCellMap();
    cells.alias("value", cells.getOrCreate("helper#value"));
    cells.write("helper#value", mkNumber(7));
    expect(cells.read("value")).toBe(cells.read("helper#value"));
  });

  it("shares the constant state across both names", () => {
    const cells = new GlobalCellMap();
    cells.alias("value", cells.getOrCreate("helper#value"));
    expect(cells.get("value")!.state).toBe(CELL_UNINITIALIZED);
    cells.write("helper#value", mkNumber(1));
    expect(cells.get("value")!.state).toBe(CELL_CONSTANT);
    cells.write("helper#value", mkNumber(2));
    expect(cells.get("value")!.state).toBe(CELL_MUTABLE);
  });

  it("replaces a cell with a fresh one on reload", () => {
    const cells = new GlobalCellMap();
    const original = cells.getOrCreate("helper#value");
    original.write(mkNumber(1));
    const replaced = cells.replace("helper#value");
    expect(replaced).not.toBe(original);
    expect(replaced.state).toBe(CELL_UNINITIALIZED);
  });

  it("leaves an uninitialised alias readable as undefined", () => {
    const cells = new GlobalCellMap();
    cells.alias("value", new GlobalCell("helper#value"));
    expect(cells.read("value")).toBeUndefined();
  });
});

describe("compiled global names", () => {
  it("stays unqualified without a module spec", () => {
    expect(globalNames("x = 1\nprint(x)\n", {})).toEqual(["x", "print", "x"]);
  });

  it("stays unqualified for the entry module", () => {
    expect(globalNames("x = 1\n", { moduleSpec: ENTRY_MODULE_SPEC })).toEqual(["x"]);
  });

  it("qualifies module-level names outside the entry module", () => {
    expect(globalNames("x = 1\ny = x\n", { moduleSpec: "helper" })).toEqual([
      "helper#x",
      "helper#x",
      "helper#y",
    ]);
  });

  it("keeps shared globals unqualified inside a module", () => {
    expect(
      globalNames("x = 1\nprint(x)\n", {
        moduleSpec: "helper",
        isSharedGlobal: (name) => name === "print",
      }),
    ).toEqual(["helper#x", "print", "helper#x"]);
  });

  it("qualifies function declarations and their call sites", () => {
    expect(
      globalNames("fn twice(n):\n  return n * 2\nv = twice(2)\n", { moduleSpec: "helper" }),
    ).toEqual(["helper#twice", "helper#twice", "helper#v"]);
  });
});
