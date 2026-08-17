import { describe, it, expect } from "vitest";
import {
  CONST_POINTER_BYTES,
  GLOBAL_CELL_BYTES,
  WASM_MEMORY_MAX_PAGES,
  exceedsAddressSpace,
  pagesToGrow,
  slotAddress,
  wasmMemoryLayout,
} from "../../../../src/optimizing/backends/wasm/memory-layout.js";
import {
  DEOPT_SNAPSHOT_BASE,
  DEOPT_SNAPSHOT_SLOT_BYTES,
  WASM_PAGE_BYTES,
} from "../../../../src/optimizing/backends/wasm/wasm-format.js";

describe("wasm memory layout", () => {
  it("stacks every region above the deopt snapshot without gaps", () => {
    const layout = wasmMemoryLayout({
      deoptSnapshotSlots: 4,
      globalCells: 3,
      constPointers: 2,
    });

    expect(layout.deoptSnapshot.base).toBe(DEOPT_SNAPSHOT_BASE);
    expect(layout.deoptSnapshot.end).toBe(
      DEOPT_SNAPSHOT_BASE + 4 * DEOPT_SNAPSHOT_SLOT_BYTES,
    );
    expect(layout.globalCells.base).toBe(layout.deoptSnapshot.end);
    expect(layout.globalCells.end).toBe(layout.globalCells.base + 3 * GLOBAL_CELL_BYTES);
    expect(layout.constPointers.base).toBe(layout.globalCells.end);
    expect(layout.constPointers.end).toBe(
      layout.constPointers.base + 2 * CONST_POINTER_BYTES,
    );
    expect(layout.arenaBase).toBe(layout.constPointers.end);
  });

  it("keeps the arena clear of the fixed regions no matter how many entries they hold", () => {
    const many = wasmMemoryLayout({
      deoptSnapshotSlots: 512,
      globalCells: 4096,
      constPointers: 1024,
    });

    expect(many.globalCells.base).toBeGreaterThanOrEqual(many.deoptSnapshot.end);
    expect(many.constPointers.base).toBeGreaterThanOrEqual(many.globalCells.end);
    expect(many.arenaBase).toBeGreaterThanOrEqual(many.constPointers.end);
    expect(many.initialPages * WASM_PAGE_BYTES).toBeGreaterThanOrEqual(many.arenaBase);
  });

  it("reserves enough initial pages to hold the fixed regions", () => {
    const layout = wasmMemoryLayout({
      deoptSnapshotSlots: 0,
      globalCells: 0,
      constPointers: 2000,
    });

    expect(layout.constPointers.end).toBeGreaterThan(WASM_PAGE_BYTES);
    expect(layout.initialPages).toBe(Math.ceil(layout.constPointers.end / WASM_PAGE_BYTES));
  });

  it("always reserves at least one page for an empty program", () => {
    const layout = wasmMemoryLayout({
      deoptSnapshotSlots: 0,
      globalCells: 0,
      constPointers: 0,
    });

    expect(layout.initialPages).toBe(1);
    expect(exceedsAddressSpace(layout)).toBe(false);
  });

  it("refuses a layout whose fixed regions overflow the maximum memory", () => {
    const layout = wasmMemoryLayout({
      deoptSnapshotSlots: 0,
      globalCells: 0,
      constPointers: (WASM_MEMORY_MAX_PAGES * WASM_PAGE_BYTES) / CONST_POINTER_BYTES + 1,
    });

    expect(exceedsAddressSpace(layout)).toBe(true);
  });

  it("addresses each slot inside its own region", () => {
    const layout = wasmMemoryLayout({
      deoptSnapshotSlots: 1,
      globalCells: 4,
      constPointers: 4,
    });

    for (let index = 0; index < 4; index++) {
      const cell = slotAddress(layout.globalCells, index);
      expect(cell).toBeGreaterThanOrEqual(layout.globalCells.base);
      expect(cell + GLOBAL_CELL_BYTES).toBeLessThanOrEqual(layout.globalCells.end);

      const pointer = slotAddress(layout.constPointers, index);
      expect(pointer).toBeGreaterThanOrEqual(layout.constPointers.base);
      expect(pointer + CONST_POINTER_BYTES).toBeLessThanOrEqual(layout.constPointers.end);
    }
  });

  it("rejects a slot index past the end of its region instead of writing into the next one", () => {
    const layout = wasmMemoryLayout({
      deoptSnapshotSlots: 0,
      globalCells: 2,
      constPointers: 2,
    });

    expect(() => slotAddress(layout.globalCells, 2)).toThrow(RangeError);
    expect(() => slotAddress(layout.globalCells, -1)).toThrow(RangeError);
  });

  it("grows by whole pages covering the shortfall", () => {
    expect(pagesToGrow(WASM_PAGE_BYTES + 1, WASM_PAGE_BYTES)).toBe(1);
    expect(pagesToGrow(3 * WASM_PAGE_BYTES, WASM_PAGE_BYTES)).toBe(2);
    expect(
      pagesToGrow(WASM_PAGE_BYTES * 2, WASM_PAGE_BYTES) * WASM_PAGE_BYTES +
        WASM_PAGE_BYTES,
    ).toBeGreaterThanOrEqual(WASM_PAGE_BYTES * 2);
  });
});
