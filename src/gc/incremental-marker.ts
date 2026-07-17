export const COLOR_WHITE = 0;
export const COLOR_GREY = 1;
export const COLOR_BLACK = 2;

const DEFAULT_TIME_BUDGET_MS = 1;

export type MarkColor =
  | typeof COLOR_WHITE
  | typeof COLOR_GREY
  | typeof COLOR_BLACK;

export type GCObject = {
  gcHeader?: {
    color: MarkColor;
    generation?: string;
  } | null;
  visitReferences?: (visitor: (ref: GCObject | null | undefined) => void) => void;
};

export class IncrementalMarker {
  worklist: GCObject[];
  marking: boolean;
  markingComplete: boolean;
  timeBudgetMs: number;
  totalMarked: number;
  stepsRun: number;

  constructor() {
    this.worklist = [];
    this.marking = false;
    this.markingComplete = false;
    this.timeBudgetMs = DEFAULT_TIME_BUDGET_MS;
    this.totalMarked = 0;
    this.stepsRun = 0;
  }

  startMarking(roots: Iterable<GCObject | null | undefined>): void {
    this.worklist = [];
    this.marking = true;
    this.markingComplete = false;
    this.totalMarked = 0;
    this.stepsRun = 0;

    for (const root of roots) {
      if (root && root.gcHeader && root.gcHeader.color === COLOR_WHITE) {
        root.gcHeader.color = COLOR_GREY;
        this.worklist.push(root);
      }
    }
  }

  step(budgetMs = this.timeBudgetMs): boolean {
    if (!this.marking || this.markingComplete) return false;
    this.stepsRun++;

    const deadline = performance.now() + budgetMs;
    let processed = 0;

    while (this.worklist.length > 0) {
      if (processed > 0 && performance.now() >= deadline) break;

      const obj = this.worklist.pop()!;
      if (!obj.gcHeader || obj.gcHeader.color === COLOR_BLACK) continue;

      obj.gcHeader.color = COLOR_BLACK;
      processed++;
      this.totalMarked++;

      if (obj.visitReferences) {
        obj.visitReferences((ref: GCObject | null | undefined) => {
          if (ref && ref.gcHeader && ref.gcHeader.color === COLOR_WHITE) {
            ref.gcHeader.color = COLOR_GREY;
            this.worklist.push(ref);
          }
        });
      }
    }

    if (this.worklist.length === 0) {
      this.markingComplete = true;
    }

    return !this.markingComplete;
  }

  writeBarrier(
    holder: GCObject | null | undefined,
    newRef?: GCObject | null,
    oldRef?: GCObject | null,
  ): void {
    if (!this.marking || this.markingComplete) return;
    if (!holder || !holder.gcHeader) return;

    if (oldRef && oldRef.gcHeader && holder.gcHeader.color === COLOR_BLACK) {
      if (oldRef.gcHeader.color === COLOR_WHITE) {
        oldRef.gcHeader.color = COLOR_GREY;
        this.worklist.push(oldRef);
      }
    }

    if (newRef && newRef.gcHeader) {
      if (
        holder.gcHeader.color === COLOR_BLACK &&
        newRef.gcHeader.color === COLOR_WHITE
      ) {
        newRef.gcHeader.color = COLOR_GREY;
        this.worklist.push(newRef);
      }
    }
  }

  finishMarking(): void {
    while (this.worklist.length > 0) {
      this.step(Infinity);
    }
    this.marking = false;
    this.markingComplete = true;
  }

  isMarking(): boolean {
    return this.marking && !this.markingComplete;
  }

  reset(): void {
    this.worklist = [];
    this.marking = false;
    this.markingComplete = false;
    this.totalMarked = 0;
    this.stepsRun = 0;
  }
}
