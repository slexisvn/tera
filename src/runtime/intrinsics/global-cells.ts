import { getTag } from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";

export const CELL_UNINITIALIZED = "uninitialized";
export const CELL_CONSTANT = "constant";
export const CELL_MUTABLE = "mutable";

export type GlobalCellState =
  | typeof CELL_UNINITIALIZED
  | typeof CELL_CONSTANT
  | typeof CELL_MUTABLE;

export class GlobalCell {
  name: string;
  value: TaggedValue | undefined;
  state: GlobalCellState;
  writeCount: number;
  firstValue: TaggedValue | undefined;

  constructor(name: string) {
    this.name = name;
    this.value = undefined;
    this.state = CELL_UNINITIALIZED;
    this.writeCount = 0;
    this.firstValue = undefined;
  }

  read(): TaggedValue | undefined {
    return this.value;
  }

  write(value: TaggedValue): void {
    this.writeCount++;
    if (this.state === CELL_UNINITIALIZED) {
      this.state = CELL_CONSTANT;
      this.firstValue = value;
    } else if (this.state === CELL_CONSTANT) {
      if (
        value !== this.firstValue ||
        getTag(value) !== getTag(this.firstValue)
      ) {
        this.state = CELL_MUTABLE;
      }
    }
    this.value = value;
  }

  isConstant(): boolean {
    return this.state === CELL_CONSTANT;
  }

  isMutable(): boolean {
    return this.state === CELL_MUTABLE;
  }
}

export class GlobalCellMap {
  cells: Map<string, GlobalCell>;

  constructor() {
    this.cells = new Map();
  }

  getOrCreate(name: string): GlobalCell {
    if (!this.cells.has(name)) {
      this.cells.set(name, new GlobalCell(name));
    }
    return this.cells.get(name)!;
  }

  get(name: string): GlobalCell | undefined {
    return this.cells.get(name);
  }

  has(name: string): boolean {
    return this.cells.has(name);
  }

  read(name: string): TaggedValue | undefined {
    const cell = this.cells.get(name);
    return cell ? cell.read() : undefined;
  }

  write(name: string, value: TaggedValue): void {
    this.getOrCreate(name).write(value);
  }
}
