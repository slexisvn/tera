# 65. The Branch in the Middle of a Block   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** A list scheduler that bounds regions at terminators is wrong the moment a guard
emits a branch without the terminator flag — and the failure is an access violation in real
binaries that no unit test sees.

**What arrived.** A `MachineFunction` over virtual registers, still in three-address form,
with phi copies placed and guard forks already emitted as `cmp` / `ja <slow>` / fast path /
`jmp <rejoin>` sequences *inside one block*.

**What leaves.** The same function with the instructions inside each scheduling region
reordered by critical-path height. No instruction crosses a region boundary; no instruction
is added or removed.

**New ideas.** A dependence DAG; RAW / WAR / WAW dependences; a resource model; a barrier;
list scheduling and the ready set; critical-path height as a priority; instruction latency;
in-order versus out-of-order execution (needed to explain why the measurement is what it
is).

**Length.** 12 pages

## Anchors

- `src/optimizing/machine/schedule.ts` — `scheduleMachineCode`, `scheduleRegion`,
  `regionsOf`, `bounds`, `branches`, `readResourcesOf`, `writeResourcesOf`,
  `touchesMemory`, the `FLAGS` / `MEMORY` / `ORDER` resource singletons, `Slot`,
  `ReadyQueue` (a hand-rolled binary heap ordered by `height`, ties broken by original
  index), `InstructionEffect`, `UNMODELLED_EFFECT`, `DEFAULT_LATENCY`.
- `src/optimizing/backends/x64/mc/opcodes.ts` — `OpcodeGroup.effect` sitting in the *same*
  table entry as the encodings; `OpcodeEffect` (`readsFlags`, `writesFlags`, `barrier`,
  `latency`); `opcodeEffectOf` and its `UNMODELLED` fallback; the named latencies
  `MULTIPLY_LATENCY = 3`, `DIVIDE_LATENCY = 20`, `FLOAT_LATENCY = 4`,
  `FLOAT_DIVIDE_LATENCY = 14`; the `WRITES_FLAGS` / `READS_FLAGS` / `BARRIER` constants and
  which opcode families carry them (`addArithmetic`, `addShifts`, `addUnary`, `addControl`).
- `src/optimizing/backends/x64/lowering.ts` — `X64Lowering.effectOf` (one line:
  `opcodeEffectOf(node.opcode)`), and `selectNewObject`, which emits
  `movq tera_context+8(%rip)` / `leaq` / `cmpq` / **`ja <fork.taken>`** / cursor commit /
  header stores / young-list append / `jmp <fork.rejoin>` all into one block.
- `src/optimizing/machine/lowering-base.ts` — `MachineLoweringBase.effectOf` returns
  `UNMODELLED_EFFECT` (reads, writes and blocks), which is what riscv64 inherits until it
  overrides.
- `src/optimizing/machine/pipeline.ts` — the call site: `scheduleMachineCode(fn, lowering)`
  sits between `selectMachineFunction` and `lowerTwoAddress`, with a `verify` on each side.
- `tests/optimizing/machine/schedule.test.ts` — the whole behavioural contract, including
  the regression for this chapter's bug.

## Worked example

`docs/example/stats.tera`. `Series.label()` concatenates three strings, so
`selectNewObject` runs three times and produces three guard forks. The first one is at
line 2396 of the emitted assembly:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-asm
grep -n "ja \.L_fixed_text_0_alloc_0$" -A 3 /tmp/stats-asm/stats.s
```

The instruction immediately after the `ja` is `movq %rcx, tera_context+8(%rip)` — the arena
cursor commit. That is the instruction the first version of the scheduler was free to hoist
*above* the `ja`, which advances the bump pointer on the path that jumps to `tera_alloc` and
never allocates from the arena at all.

## Outline

- [ ] **§ why-schedule-at-all** — Establish what a pre-allocation list scheduler is for, and
      set the expectation the measurement will later collapse: on an out-of-order core the
      hardware reorders anyway; the value is for in-order targets and for shortening the
      window a value is live. Name that this pass is `optional` in the opt-bisect sense
      [Ch 74 § opt-bisect].
- [ ] **§ one-resource-model** — Establish the uniform model. Every instruction reads
      `ORDER` and its `use` operands; it writes its `def` operands. On top of that:
      `readsFlags` adds a read of the `FLAGS` singleton, `writesFlags` a write; any
      instruction with a `memory` operand both reads *and* writes `MEMORY`; a `barrier` or
      `flags.call === true` writes `ORDER`. Then one edge builder produces RAW, WAR and WAW
      edges from that. Establish the two consequences the code depends on: **memory is
      totally ordered** (deliberately — there is no alias analysis at this layer), and
      **every instruction reading `ORDER` while a barrier writes it makes the barrier a
      two-sided fence in O(n)**.
- [ ] **§ waw-on-flags** — Establish that WAW chaining on `FLAGS` is what keeps x86 correct
      with no flag-liveness pass at all. Every flag writer gets an edge from the previous
      flag writer, so the last writer stays last; that is why a `cmp` cannot be separated
      from the `jcc` or `cmov` that reads it, even when the reader is the block terminator
      and therefore outside the scheduled window. Invariant → enforcement → test.
- [ ] **§ call-is-a-barrier-here** — Establish a deliberate placement decision:
      `flags.call === true` is treated as a barrier **in the scheduler**, in
      `writeResourcesOf`, not in each target's `effectOf` hook. A target that implements
      `effectOf` directly therefore cannot forget it. Contrast with the flag effects, which
      *are* the target's job.
- [ ] **§ latency-in-the-encoding-table** — Establish the single-source-of-truth argument:
      the x64 flag and latency model is `OpcodeGroup.effect`, in the same map entry as the
      bytes, so an arithmetic opcode cannot be added to the encoder without also stating its
      flag effect. Show `opcodeEffectOf`'s fallback: an unknown mnemonic is
      conservatively `{readsFlags, writesFlags, barrier}` — it will not be moved and nothing
      will be moved across it. Note that riscv64 has no condition-code register at all and
      so answers latencies only.
- [ ] **§ height-priority** — Establish critical-path height: walk the DAG backwards,
      `height = max(height of successors) + latency`, then pop the ready queue by greatest
      height with the original index as tie-break so the schedule is deterministic. Show
      `ReadyQueue` as a plain binary heap over integer slot indices. Establish the
      cheap-and-important detail: if the resulting order is the identity, `scheduleRegion`
      returns `false` and splices nothing.
- [ ] **§ regions** — *Why the obvious design fails.* Stage the obvious definition first —
      "a scheduling region is a basic block, minus its trailing terminator" — and show it is
      what shipped. Then `bounds(node)`: a region ends at any instruction with
      `flags.terminator`, or `flags.prologue`, **or that carries a label operand at all**.
      That last clause is the fix. Also establish the trailing-copy rule:
      `while (end > start && instructions[end-1].flags.copy) end--` pins the run of copies
      that feed a terminator, because those implement a parallel copy the selector already
      sequenced and moving them buys nothing. And regions shorter than two instructions are
      skipped.
- [ ] **§ the-miscompile** — Bugs are told as engineering. **Symptom:** an access violation
      in any program that allocates in a loop. **Mechanism:** `SelectionContext.guard()`
      emits `ja <slow>` and keeps writing the fast path into the same block; that `ja` has
      no `flags.terminator`, so the first region definition put it *inside* the window; the
      arena cursor commit floated above it (advancing the bump pointer on the slow path
      too), and the size argument the slow path passes to `tera_alloc` sank below it.
      **Fix:** `branches(node)` — "does this instruction carry a label operand" — rather
      than trusting `flags.terminator`. **Regression test:**
      `'moves nothing across a branch that sits in the middle of a block'`. **General rule:**
      an invariant that depends on every emitter remembering to set a flag is not an
      invariant; derive it from the operands instead.
- [ ] **§ before-two-address** — Establish the ordering constraint against chapter 66:
      scheduling must run *before* `lowerTwoAddress`, so the tied copies that pass inserts
      stay adjacent to their worker instruction and `coalesceRoundTrips` can still fold
      them. A scheduler placed after coalescing would undo the fold that took the float
      loop from 130 ms to 66 ms — see [Ch 66 § coalescing].
- [ ] **§ measured** — The numbers, with their provenance stated: measured on the user's
      Windows machine, best of five, one case per fresh process, answers identical in every
      case. `acc + i * 3 - 1` over 200M iterations: 96.8–98.4 ms off, 96.4–103.5 ms on —
      noise. `acc + 1.5` float over 60M: 89.3 ms off, 90.1 ms on — noise. Two independent
      float chains over 60M: 194–204 ms off, **182–193 ms on** — about 6%, confirmed by
      disassembly (the two `mulsd`s now issue back to back). Conclusion stated as a rule:
      on an out-of-order x86 core a pre-RA scheduler is worth nothing on a loop bound by its
      own dependence chain, and something only where there are independent chains to
      interleave. Do not chase the numeric row with scheduling again. The value elsewhere is
      riscv64, which is in-order — and which is unmeasured here because there is no riscv64
      machine in this tree [Ch 72].
- [ ] **§ what-the-cheap-tiers-cannot-see** — The honest counterweight to [Ch 79]. `npm test`
      and `--project e2e` never executed a native binary, so neither could observe this bug;
      every unit test the scheduler had was still green. The tier that catches it is
      `--project native`, which runs real binaries without needing a C toolchain. State the
      rule for the reader: run it for any codegen change. Note `--project full` adds gas and
      objdump and is only needed for encoding and DWARF checks [Ch 69], [Ch 71].

## Honesty items

- > **Measured worse.** Not the pass itself, but the claim usually made for it:
  `scheduleMachineCode` moves wall time only on interleavable chains (~6%) and is noise on
  the dependence-bound shapes that dominate `stats.tera`. It stays on because it is not a
  regression and because riscv64 is in-order, not because it was shown to pay here.
- > **Unenforced.** Nothing checks that a target's `effectOf` agrees with what its
  instructions actually do. `opcodeEffectOf` returns `{}` — no flag effects at all — for any
  mnemonic present in the table without an `effect` field; `movsd`, `movss`, `movapd`,
  `movups`, `movaps`, the `movd`/`movq` cross-file forms, `leal`/`leaq` and `mov*` all rely
  on that being correct by inspection. Cost of finishing: a table-driven test asserting an
  effect entry for every mnemonic any lowering can emit, which
  `tests/optimizing/backends/x64/effects.test.ts` approaches by listing mnemonics by hand
  rather than deriving them from `emittedOpcodesOf`.
- > **Unenforced.** `regionsOf` derives the region boundary from "carries a label operand".
  Nothing prevents a future lowering from emitting a control transfer whose target is a
  `symbol` rather than a `label` — `call` is exactly that shape, and is caught only because
  `flags.call` separately writes `ORDER`. An indirect branch through a register would be
  caught by neither.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-asm
grep -n "ja \.L_fixed_text_0_alloc_0$" -A 3 /tmp/stats-asm/stats.s
npx vitest run --project unit tests/optimizing/machine/schedule.test.ts
npx vitest run --project unit tests/optimizing/backends/x64/effects.test.ts
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe
```

## Tests that pin this

- The bug's regression test: `tests/optimizing/machine/schedule.test.ts` >
  `"moves nothing across a branch that sits in the middle of a block"`.
- Flags: `tests/optimizing/machine/schedule.test.ts` >
  `"never lets another flag writer come between a compare and its reader"`.
- Memory and barriers: `tests/optimizing/machine/schedule.test.ts` >
  `"keeps memory in the order the selector wrote it"`,
  `"does not move anything across a call"`.
- Pinned trailing copies: `tests/optimizing/machine/schedule.test.ts` >
  `"leaves the terminator and the copies that feed it in place"`.
- The scheduler doing its job at all: `tests/optimizing/machine/schedule.test.ts` >
  `"starts a long chain before the work that does not depend on it"`,
  `"leaves an order it cannot improve alone"`.
- The effect model: `tests/optimizing/backends/x64/effects.test.ts` >
  `"prices a divide above a multiply and a multiply above a move"`,
  `"treats an opcode it does not model as reading, writing and blocking"`, and the
  parametrised rows under `describe("x64 instruction effects")` and
  `describe("x64 scheduling keeps the flags a branch reads")` >
  `"still folds the compare into the conditional move"`.
- That scheduled code still runs: `tests/e2e/optimizing/x64/windows-executable.test.ts` >
  `"allocates an instance and reads a field back through a method"`,
  `"runs accessors, statics, super and for-of in one native program"` — these are the tests
  that execute a real PE, and therefore the ones that would have caught the miscompile.
