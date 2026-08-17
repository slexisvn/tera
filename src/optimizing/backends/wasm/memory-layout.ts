import {
  DEOPT_SNAPSHOT_BASE,
  DEOPT_SNAPSHOT_SLOT_BYTES,
  WASM_PAGE_BYTES,
} from "./wasm-format.js";

export const GLOBAL_CELL_BYTES = 8;
export const CONST_POINTER_BYTES = 64;
export const WASM_MEMORY_MAX_PAGES = 256;

export interface WasmMemoryRegion {
  readonly base: number;
  readonly stride: number;
  readonly count: number;
  readonly end: number;
}

export interface WasmMemoryCounts {
  readonly deoptSnapshotSlots: number;
  readonly globalCells: number;
  readonly constPointers: number;
}

export interface WasmMemoryLayout {
  readonly deoptSnapshot: WasmMemoryRegion;
  readonly globalCells: WasmMemoryRegion;
  readonly constPointers: WasmMemoryRegion;
  readonly arenaBase: number;
  readonly initialPages: number;
}

function region(base: number, count: number, stride: number): WasmMemoryRegion {
  return { base, stride, count, end: base + count * stride };
}

export function slotAddress(area: WasmMemoryRegion, index: number): number {
  if (index < 0 || index >= area.count) {
    throw new RangeError(
      `slot ${index} outside region [${area.base}, ${area.end}) of ${area.count} entries`,
    );
  }
  return area.base + index * area.stride;
}

export function wasmMemoryLayout(counts: WasmMemoryCounts): WasmMemoryLayout {
  const deoptSnapshot = region(
    DEOPT_SNAPSHOT_BASE,
    counts.deoptSnapshotSlots,
    DEOPT_SNAPSHOT_SLOT_BYTES,
  );
  const globalCells = region(deoptSnapshot.end, counts.globalCells, GLOBAL_CELL_BYTES);
  const constPointers = region(globalCells.end, counts.constPointers, CONST_POINTER_BYTES);
  return {
    deoptSnapshot,
    globalCells,
    constPointers,
    arenaBase: constPointers.end,
    initialPages: Math.max(1, Math.ceil(constPointers.end / WASM_PAGE_BYTES)),
  };
}

export function pagesToGrow(needed: number, currentBytes: number): number {
  return Math.ceil((needed - currentBytes) / WASM_PAGE_BYTES);
}

export function exceedsAddressSpace(layout: WasmMemoryLayout): boolean {
  return layout.initialPages > WASM_MEMORY_MAX_PAGES;
}
