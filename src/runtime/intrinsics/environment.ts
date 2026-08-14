import type { TaggedValue } from "../../core/value/index.js";
import type { RegisterValue } from "../../bytecode/register/interpreter/frame.js";

type UpvalueFrame = {
  locals: RegisterValue[];
};

export class UpvalueCell {
  frame: UpvalueFrame | null;
  localSlot: number;
  closed: boolean;
  closedValue: RegisterValue | null;

  constructor(frame: UpvalueFrame, localSlot: number) {
    this.frame = frame;
    this.localSlot = localSlot;
    this.closed = false;
    this.closedValue = null;
  }

  get(): RegisterValue | null {
    if (this.closed) return this.closedValue;
    return this.frame!.locals[this.localSlot];
  }

  set(value: TaggedValue): void {
    if (this.closed) {
      this.closedValue = value;
    } else {
      this.frame!.locals[this.localSlot] = value;
    }
  }

  close(): void {
    if (!this.closed) {
      this.closedValue = this.frame!.locals[this.localSlot];
      this.closed = true;
      this.frame = null;
    }
  }
}

export class Environment {
  cells: UpvalueCell[];

  constructor(cells: UpvalueCell[]) {
    this.cells = cells;
  }

  getUpvalue(index: number): RegisterValue | null {
    return this.cells[index].get();
  }

  setUpvalue(index: number, value: TaggedValue): void {
    this.cells[index].set(value);
  }
}
