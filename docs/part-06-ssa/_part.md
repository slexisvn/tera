# Part VI — Bytecode becomes SSA   ⟨· · J · N⟩

> **Status:** outline

**Length.** 2 pages

## What this stage is

- Register bytecode is a *machine*: registers are storage, a slot can hold three
  different values at three points in time, and "which definition does this read see?"
  has no answer without walking the program.
- Everything downstream of here — every pass in Part VII, the wasm emitter in Part VIII,
  the native backends in Parts IX and X — needs that question answered by looking at one
  edge. Part VI is where the answer gets built into the data structure.
- The output is **one** artifact shared by two of the four machines: a `CFGFunction`
  holding `CFGBlock`s of `CFGInstruction`s in canonical phi SSA, with a frozen operation
  table describing what each opcode does and a frame state hanging off every node that
  can give up.

## What it owes everything downstream

- **A definition per value.** After this part, `v13 = GenericAdd v3, v12` names its two
  operands by identity, not by register slot. Nothing later re-derives reaching
  definitions.
- **A schedule.** Values are pinned to a block and to a position in that block's node
  list. There is no scheduler pass in the middle end — program order *is* the schedule,
  and every pass is responsible for keeping it legal. The one scheduler in the tree,
  `src/optimizing/machine/schedule.ts`, runs on MachineIR long after this part
  [Ch 68 § machine-list-scheduler].
- **One structural authority.** `OPERATIONS` in `src/optimizing/ir/operations.ts` answers
  effects, terminator-ness, pinning, arity, result class, operand class, memory-access
  kind, speculation role and type transfer for all 98 opcodes. 26 source files consult it.
  No pass carries its own opcode switch for these questions.
- **A way back.** A frame state on each deoptimizing node describes the interpreter frame
  the JIT no longer has, so speculation is reversible. Part V bought the speculation;
  this part pays for the undo.
- **A text form.** `printIR` / `parseIR` round-trip exactly, which is what lets every
  later chapter's pass fixture be text in, text out instead of a hand-built graph.

## The chapters

| # | Title | Tiers | Pages |
| --- | --- | --- | --- |
| 38 | A control-flow graph, not a sea of nodes | ⟨· · J · N⟩ | 18 |
| 39 | Building SSA from bytecode | ⟨· · J · N⟩ | 20 |
| 40 | Frame states: describing a frame you no longer have | ⟨I · · J · N⟩ | 16 |

- **38** is the data structure and its frozen description table. It establishes the
  vocabulary — block, instruction, phi, use, effect — that Parts VII through X spend
  their whole length manipulating.
- **39** is the single walk that turns `mean`'s bytecode into that structure, and the
  one hard problem in it: a loop header must place phis before the values on the back
  edge exist.
- **40** is the second, invisible graph the frame states form, and the rule it forces on
  every pass in the book: `uses.length === 0` is not death.

## Which of the four machines this constrains

- **Interpreter ⟨I⟩** — untouched by the IR itself. It appears in chapter 40 only as the
  *destination*: a frame state describes an interpreter frame, and deoptimization
  rebuilds one.
- **Baseline ⟨B⟩** — untouched entirely. `src/optimizing/baseline/compiler.ts` imports
  nothing from `src/optimizing/ir/`; it goes from bytecode straight to JavaScript
  [Ch 36 § baseline-emits-javascript]. This is the only part of the book the baseline
  compiler skips.
- **JIT ⟨J⟩** — builds this IR through `buildIR`, keeps every frame state, and is the
  only consumer that calls `validateOptimizedGraph`.
- **Native ⟨N⟩** — builds the *same* IR through the *same* `buildIR`, then deletes every
  frame state in `elideFrameStates` because its target model has no `deopt` capability.
  It also turns on one thing the JIT never does: `graph.recoversThrows`, which makes
  exceptions ordinary control flow (chapter 39).

## What this part deliberately is not

- Not a sea of nodes. There are no floating values with effect-chain edges and no
  scheduling phase. Chapter 38 § why-the-obvious-design-fails states the trade.
- Not an optimizer. Not one value is folded here. Part VII does that.
- Not typed. `CFGInstruction.props` is an untyped bag; the lattice types live in the
  transfer functions of the operation table and are computed on demand by an analysis
  in [Ch 42 § type-inference].
