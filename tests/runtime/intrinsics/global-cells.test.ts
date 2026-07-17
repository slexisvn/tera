import { describe, it, expect } from "vitest";
import {
  GlobalCell,
  GlobalCellMap,
  CELL_UNINITIALIZED,
  CELL_CONSTANT,
  CELL_MUTABLE,
} from "../../../src/runtime/intrinsics/global-cells.js";
import { mkSmi, mkString } from "../../../src/core/value/index.js";

describe("GlobalCell", () => {
  describe("state transitions", () => {
    it("starts uninitialized", () => {
      const cell = new GlobalCell("x");
      expect(cell.state).toBe(CELL_UNINITIALIZED);
      expect(cell.read()).toBeUndefined();
    });

    it("first write transitions to constant", () => {
      const cell = new GlobalCell("x");
      cell.write(mkSmi(1));
      expect(cell.state).toBe(CELL_CONSTANT);
      expect(cell.isConstant()).toBe(true);
      expect(cell.read()).toBe(mkSmi(1));
    });

    it("writing same value stays constant", () => {
      const cell = new GlobalCell("x");
      const val = mkSmi(42);
      cell.write(val);
      cell.write(val);
      cell.write(val);
      expect(cell.state).toBe(CELL_CONSTANT);
    });

    it("writing different value transitions to mutable", () => {
      const cell = new GlobalCell("x");
      cell.write(mkSmi(1));
      cell.write(mkSmi(2));
      expect(cell.state).toBe(CELL_MUTABLE);
      expect(cell.isMutable()).toBe(true);
    });

    it("mutable is a terminal state — same value doesn't revert to constant", () => {
      const cell = new GlobalCell("x");
      const val = mkSmi(1);
      cell.write(val);
      cell.write(mkSmi(2));
      cell.write(val);
      expect(cell.state).toBe(CELL_MUTABLE);
    });

    it("different tagged values with same payload transition to mutable", () => {
      const cell = new GlobalCell("x");
      cell.write(mkSmi(1));
      cell.write(mkString("1"));
      expect(cell.state).toBe(CELL_MUTABLE);
    });
  });

  describe("write count", () => {
    it("tracks total number of writes", () => {
      const cell = new GlobalCell("x");
      cell.write(mkSmi(1));
      cell.write(mkSmi(2));
      cell.write(mkSmi(3));
      expect(cell.writeCount).toBe(3);
    });
  });
});

describe("GlobalCellMap", () => {
  it("getOrCreate returns same cell for same name", () => {
    const map = new GlobalCellMap();
    const a = map.getOrCreate("x");
    const b = map.getOrCreate("x");
    expect(a).toBe(b);
  });

  it("different names produce different cells", () => {
    const map = new GlobalCellMap();
    expect(map.getOrCreate("a")).not.toBe(map.getOrCreate("b"));
  });

  it("read returns undefined for non-existent cell", () => {
    const map = new GlobalCellMap();
    expect(map.read("nope")).toBeUndefined();
  });

  it("write then read round-trips", () => {
    const map = new GlobalCellMap();
    map.write("x", mkSmi(42));
    expect(map.read("x")).toBe(mkSmi(42));
  });

  it("has returns false for missing, true for existing", () => {
    const map = new GlobalCellMap();
    expect(map.has("x")).toBe(false);
    map.write("x", mkSmi(1));
    expect(map.has("x")).toBe(true);
  });

  it("write auto-creates cell and tracks state", () => {
    const map = new GlobalCellMap();
    map.write("x", mkSmi(1));
    map.write("x", mkSmi(2));
    const cell = map.get("x");
    expect(cell.isMutable()).toBe(true);
    expect(cell.writeCount).toBe(2);
  });
});
