import { describe, expect, it } from "vitest";
import {
  def,
  instruction,
  label,
  MachineFunction,
  use,
  type MachineBlock,
  type VirtualRegister,
} from "../../../src/optimizing/machine/ir.js";
import {
  assignPositions,
  computeLiveness,
  LiveInterval,
} from "../../../src/optimizing/machine/liveness.js";
import { testTarget, TEST_GPR } from "./support.js";

const target = testTarget();

function connect(from: MachineBlock, to: MachineBlock): void {
  from.successors.push(to);
  to.predecessors.push(from);
}

function gpr(fn: MachineFunction): VirtualRegister {
  return fn.createVirtual(TEST_GPR, 8);
}

function rangesOf(fn: MachineFunction, register: VirtualRegister) {
  const liveness = computeLiveness(fn);
  return liveness.intervalOf(register)?.ranges ?? [];
}

describe("live interval construction", () => {
  it("starts a range at the definition and ends after the last use", () => {
    const fn = new MachineFunction("straight", "straight");
    const block = fn.createBlock(".L0");
    const value = gpr(fn);
    block.instructions.push(instruction("nop", []));
    block.instructions.push(instruction("define", [def(value, 8)]));
    block.instructions.push(instruction("nop", []));
    block.instructions.push(instruction("consume", [use(value, 8)]));
    assignPositions(fn);

    expect(rangesOf(fn, value)).toEqual([{ from: 2, to: 7 }]);
  });

  it("gives an unused definition a range covering only the defining instruction", () => {
    const fn = new MachineFunction("dead", "dead");
    const block = fn.createBlock(".L0");
    const value = gpr(fn);
    block.instructions.push(instruction("define", [def(value, 8)]));
    block.instructions.push(instruction("nop", []));
    assignPositions(fn);

    expect(rangesOf(fn, value)).toEqual([{ from: 0, to: 1 }]);
  });

  it("extends a value live across a back edge to the end of the loop", () => {
    const fn = new MachineFunction("loop", "loop");
    const entry = fn.createBlock(".L0");
    const header = fn.createBlock(".L1");
    const latch = fn.createBlock(".L2");
    connect(entry, header);
    connect(header, latch);
    connect(latch, header);

    const carried = gpr(fn);
    entry.instructions.push(instruction("define", [def(carried, 8)]));
    entry.instructions.push(instruction("jump", [label(header)], { terminator: true }));
    header.instructions.push(instruction("jump", [label(latch)], { terminator: true }));
    latch.instructions.push(instruction("consume", [use(carried, 8)]));
    latch.instructions.push(instruction("jump", [label(header)], { terminator: true }));
    assignPositions(fn);

    expect(rangesOf(fn, carried)).toEqual([{ from: 0, to: latch.to }]);
  });

  it("tracks physical registers as fixed intervals", () => {
    const fn = new MachineFunction("fixed", "fixed");
    const block = fn.createBlock(".L0");
    const scratch = target.registers.register("a0");
    block.instructions.push(instruction("define", [def(scratch, 8)]));
    block.instructions.push(instruction("consume", [use(scratch, 8)]));
    assignPositions(fn);

    const liveness = computeLiveness(fn);
    expect(liveness.fixedIntervals).toHaveLength(1);
    expect(liveness.fixedIntervals[0]!.assigned).toBe(scratch);
    expect(liveness.fixedIntervals[0]!.ranges).toEqual([{ from: 0, to: 3 }]);
  });

  it("keeps ranges disjoint when a later block adds an earlier range", () => {
    const fn = new MachineFunction("holes", "holes");
    const first = fn.createBlock(".L0");
    const middle = fn.createBlock(".L1");
    const last = fn.createBlock(".L2");
    connect(first, middle);
    connect(middle, last);

    const value = gpr(fn);
    first.instructions.push(instruction("define", [def(value, 8)]));
    first.instructions.push(instruction("jump", [label(middle)], { terminator: true }));
    middle.instructions.push(instruction("nop", []));
    middle.instructions.push(instruction("jump", [label(last)], { terminator: true }));
    last.instructions.push(instruction("consume", [use(value, 8)]));
    assignPositions(fn);

    const ranges = rangesOf(fn, value);
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index]!.from).toBeGreaterThan(ranges[index - 1]!.to);
    }
    expect(ranges[0]!.from).toBe(0);
    expect(ranges[ranges.length - 1]!.to).toBe(last.from + 1);
  });
});

describe("LiveInterval intersection", () => {
  it("reports the first overlapping position", () => {
    const left = new LiveInterval({ kind: "virtual", id: 0, classId: TEST_GPR, width: 8 });
    const right = new LiveInterval({ kind: "virtual", id: 1, classId: TEST_GPR, width: 8 });
    left.addRange(20, 30);
    left.addRange(0, 10);
    right.addRange(25, 40);
    right.addRange(12, 15);

    expect(left.intersectionWith(right)).toBe(25);
  });

  it("reports no intersection for adjacent ranges", () => {
    const left = new LiveInterval({ kind: "virtual", id: 0, classId: TEST_GPR, width: 8 });
    const right = new LiveInterval({ kind: "virtual", id: 1, classId: TEST_GPR, width: 8 });
    left.addRange(0, 10);
    right.addRange(10, 20);

    expect(left.intersectionWith(right)).toBe(-1);
  });
});

describe("splitting a live interval", () => {
  function interval(ranges: ReadonlyArray<readonly [number, number]>, uses: readonly number[]) {
    const built = new LiveInterval({ kind: "virtual", id: 0, classId: TEST_GPR, width: 8 });
    for (const [from, to] of [...ranges].reverse()) built.addRange(from, to);
    for (const at of [...uses].reverse()) built.addUse(at, 1);
    built.orderUses();
    return built;
  }

  it("splits a range in two that meet exactly at the split", () => {
    const whole = interval([[0, 10]], [0, 4, 8]);
    const child = whole.splitAt(4);
    expect(whole.ranges).toEqual([{ from: 0, to: 4 }]);
    expect(child.ranges).toEqual([{ from: 4, to: 10 }]);
    expect(whole.end).toBe(child.start);
  });

  it("moves uses at or after the split to the child", () => {
    const whole = interval([[0, 10]], [0, 4, 8]);
    const child = whole.splitAt(4);
    expect(whole.uses.map((at) => at.position)).toEqual([0]);
    expect(child.uses.map((at) => at.position)).toEqual([4, 8]);
  });

  it("keeps whole ranges on the side of the split they fall on", () => {
    const whole = interval(
      [
        [0, 4],
        [10, 20],
      ],
      [0, 12],
    );
    const child = whole.splitAt(12);
    expect(whole.ranges).toEqual([
      { from: 0, to: 4 },
      { from: 10, to: 12 },
    ]);
    expect(child.ranges).toEqual([{ from: 12, to: 20 }]);
  });

  it("carries the register of the value it was split from", () => {
    const whole = interval([[0, 10]], [0, 8]);
    expect(whole.splitAt(4).register).toBe(whole.register);
  });

  it("is splittable only strictly inside one of its ranges", () => {
    const whole = interval(
      [
        [0, 4],
        [10, 20],
      ],
      [0, 12],
    );
    expect(whole.splittableAt(2)).toBe(true);
    expect(whole.splittableAt(0)).toBe(false);
    expect(whole.splittableAt(4)).toBe(false);
    expect(whole.splittableAt(6)).toBe(false);
    expect(whole.splittableAt(10)).toBe(false);
    expect(whole.splittableAt(20)).toBe(false);
  });

  it("reports the first use strictly after a position", () => {
    const whole = interval([[0, 10]], [0, 4, 8]);
    expect(whole.firstUseAfter(0)).toBe(4);
    expect(whole.firstUseAfter(4)).toBe(8);
    expect(whole.firstUseAfter(8)).toBe(-1);
  });
});
