import { expect } from "vitest";
import { capabilitySet } from "../../../src/optimizing/target/capabilities.js";
import { proveOrGeneric } from "../../../src/optimizing/target/speculation.js";
import { RegisterFile } from "../../../src/optimizing/target/registers.js";
import {
  STACK_GUARD_GRANULE_BYTES,
  type RuntimeAbi,
} from "../../../src/optimizing/target/abi.js";
import type { MachineTargetModel } from "../../../src/optimizing/target/model.js";
import {
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
} from "../../../src/optimizing/types/scalar.js";
import type { MachineFunction } from "../../../src/optimizing/machine/ir.js";
import {
  def,
  instruction,
  isVirtual,
  label,
  mem,
  registerOperandsOf,
  sym,
  use,
} from "../../../src/optimizing/machine/ir.js";
import type { MachineLowering } from "../../../src/optimizing/machine/lowering.js";
import type { Liveness } from "../../../src/optimizing/machine/liveness.js";
import type { Allocation } from "../../../src/optimizing/machine/linear-scan.js";

export const TEST_GPR = "gpr";
export const TEST_FPR = "fpr";

export interface TestTargetOptions {
  readonly allocation?: readonly string[];
  readonly floatAllocation?: readonly string[];
}

export function testRegisterFile(options: TestTargetOptions = {}): RegisterFile {
  return new RegisterFile([
    {
      id: TEST_GPR,
      width: 8,
      saveBytes: 8,
      allocation: options.allocation ?? ["a0", "a1", "a2", "a3"],
      scratch: ["s0", "s1"],
      reserved: ["sp", "fp"],
    },
    {
      id: TEST_FPR,
      width: 8,
      saveBytes: 8,
      allocation: options.floatAllocation ?? ["f0", "f1"],
      scratch: ["f2"],
    },
  ]);
}

export function testTarget(options: TestTargetOptions = {}): MachineTargetModel {
  const registers = testRegisterFile(options);
  const abi: RuntimeAbi = {
    name: "test",
    pointerWidthBytes: 8,
    stackAlignmentBytes: 16,
    entryStackAdjustBytes: 0,
    stackProbeBytes: STACK_GUARD_GRANULE_BYTES,
    framePointer: registers.register("fp"),
    stackPointer: registers.register("sp"),
    savedOnCall: [],
    callingConvention: {
      name: "test",
      argumentRegisters: new Map([
        [TEST_GPR, registers.select(["a0", "a1"])],
        [TEST_FPR, registers.select(["f0"])],
      ]),
      returnRegisters: new Map([
        [TEST_GPR, registers.register("a0")],
        [TEST_FPR, registers.register("f0")],
      ]),
      callerSaved: registers.select(["a0", "a1"]),
      calleeSaved: registers.select(["a2", "a3"]),
      sharedArgumentPositions: false,
      shadowSpaceBytes: 0,
      stackArgumentSlotBytes: 8,
    },
  };
  return {
    name: "test-machine",
    capabilities: capabilitySet(),
    speculation: proveOrGeneric,
    abi,
    registers,
    integerClass: registers.classOf(TEST_GPR),
    floatClass: registers.classOf(TEST_FPR),
    locationOf: (scalar) =>
      scalar === SCALAR_FLOAT64
        ? { classId: TEST_FPR, width: 8 }
        : { classId: TEST_GPR, width: scalar === SCALAR_INT32 ? 4 : 8 },
    machineReprOf: () => "pointer",
  };
}

export function expectDisjointAllocation(liveness: Liveness, allocation: Allocation): void {
  const assigned = [...liveness.fixedIntervals, ...allocation.intervals].filter(
    (interval) => interval.assigned !== null,
  );
  for (let left = 0; left < assigned.length; left++) {
    for (let right = left + 1; right < assigned.length; right++) {
      const a = assigned[left]!;
      const b = assigned[right]!;
      if (a.assigned !== b.assigned) continue;
      expect({
        register: a.assigned!.name,
        first: a.ranges,
        second: b.ranges,
        at: a.intersectionWith(b),
      }).toMatchObject({ at: -1 });
    }
  }
}

export function expectFullyAllocated(fn: MachineFunction): void {
  for (const block of fn.blocks) {
    for (const node of block.instructions) {
      for (const operand of registerOperandsOf(node)) {
        expect({ opcode: node.opcode, virtual: isVirtual(operand.register) }).toMatchObject({
          virtual: false,
        });
      }
    }
  }
}

export const SCALARS = {
  int32: SCALAR_INT32,
  float64: SCALAR_FLOAT64,
  string: SCALAR_STRING,
} as const;

const OPPOSITE_TEST_CONDITIONS = new Map<string, string>([
  ["jle", "jg"],
  ["jg", "jle"],
  ["jeq", "jne"],
  ["jne", "jeq"],
]);

export function testLowering(target: MachineTargetModel): MachineLowering {
  return {
    target,
    rules: () => [],
    materialize: (context) => context.temp(SCALAR_INT32),
    convert: (context, source, _from, to) => {
      const destination = context.temp(to);
      context.emit(
        instruction("convert", [def(destination, destination.width), use(source, source.width)]),
      );
      return destination;
    },
    copy: (destination, source) =>
      instruction("copy", [destination, source], { copy: true }),
    reload: (destination, slot) =>
      instruction("reload", [destination, mem(destination.width, { slot })]),
    spill: (slot, source) =>
      instruction("store", [mem(source.width, { slot }), source]),
    loadIncoming: (destination, slot) =>
      instruction("reload", [destination, mem(destination.width, { slot })]),
    storeOutgoing: (offset, source) =>
      instruction("store", [mem(source.width, { displacement: offset }), source]),
    jump: (block) => instruction("jump", [label(block)], { terminator: true }),
    effectOf: () => ({}),
    fusedInputOf: () => null,
    invertBranch: (node, block) => {
      const opposite = OPPOSITE_TEST_CONDITIONS.get(node.opcode);
      if (opposite === undefined) return null;
      return instruction(opposite, [label(block)], { terminator: true });
    },
    call: (symbol, operands) =>
      instruction("call", [sym(symbol), ...operands], { call: true, implicitFrom: 1 }),
  };
}
