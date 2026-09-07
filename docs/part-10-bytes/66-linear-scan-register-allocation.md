# 66. Linear scan register allocation   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** Positions, intervals with holes, active and inactive sets, and a victim chosen
by use density rather than by furthest next use.

**What arrived.** A scheduled `MachineFunction` over virtual registers, still in
three-address form, with `flags.tied` marking every instruction the machine can only write
destructively.

**What leaves.** The same function with `lowerTwoAddress` applied, every operand holding a
`PhysicalRegister`, spill slots created on `fn.slots`, reload/spill instructions inserted
around the instructions that need them, redundant copies gone, and an `Allocation` recording
which callee-saved registers were used — which is exactly what `layoutFrame` needs next
[Ch 68].

**New ideas.** A register class and its allocation order; caller-saved versus callee-saved;
a live interval and a lifetime hole; the active / inactive / handled partition; spilling; a
spill slot; a register hint (coalescing by preference); a fixed interval; a scratch
(reserved) register; copy coalescing.

**Length.** 20 pages

## Anchors

- `src/optimizing/machine/liveness.ts` — `assignPositions` (step 2), `computeLiveness`,
  `LiveInterval` (`ranges`, `uses`, `fixed`, `assigned`, `spillSlot`, `hint`, `hintAt`,
  `addRange`, `setFrom`, `addUse`, `orderUses`, `covers`, `intersectionWith`, `weightFrom`,
  `densityFrom`, `useCountFrom`, `firstUseAfter`, `splittableAt`, `splitAt`, `shortenTo`),
  `LiveRange`, `UsePosition`, `Liveness`, `loopWeightOf` with `LOOP_WEIGHT_FACTOR = 2` and
  `LOOP_DEPTH_LIMIT = 4`, `loopsOf` / `loopBodyOf`, the `hintTo` closure.
- `src/optimizing/machine/linear-scan.ts` — `allocateRegisters`, the `LinearScan` class
  (`run`, `advance`, `occupied`, `sameClass`, `freeUntilOf`, `hintOf`, `takeHinted`,
  `allocateFree`, `allocateBlocked`, `retire`, `spill`, `slotFor`, `calleeSavedInUse`,
  `track`, `locationAt`), `Allocation`, `UNBOUNDED`. (`split`, `splitPositionFor`,
  `resolvableBoundaries`, `placeableEdge`, `firstAbove`, `RELOAD_BREAK_EVEN_USES` and
  `NO_SPLIT` also live here and belong to [Ch 67].)
- `src/optimizing/machine/two-address.ts` — `lowerTwoAddress`, the tied contract enforced by
  a thrown `"<opcode> is tied but is not in destructive form"`.
- `src/optimizing/machine/rewrite.ts` — `rewriteAllocations`, `applyAssignment`,
  `locationOf`, `isRedundantCopy`, `OutOfScratchRegistersError`, the `claim` closure and its
  per-role scratch counters.
- `src/optimizing/machine/coalesce.ts` — `coalesceRoundTrips`, `coalesceOnce`,
  `foldDefineThenCopy`, `worksOnScratch`, `closingIndex`, `definesOnly`, `touches`,
  `readsThroughMemory`, `renamed`.
- `src/optimizing/machine/physical-liveness.ts` — `physicalLiveness`, `liveAfter`,
  `stepBackwards`, `answeredBy`, `liveOutOf`, `namesTheReturn`, `sameNames`, the `EVERYTHING`
  sentinel `"*"`.
- `src/optimizing/target/registers.ts` — `RegisterClassSpec` (`allocation`, `scratch`,
  `reserved`), `RegisterFile`, `allocationOrder` (caller-saved first, so a leaf function
  never forces a callee-saved save).
- `src/optimizing/backends/x64/registers.ts` — `X64_GPR_SCRATCH = ["r10","r11"]`,
  `X64_FPR_SCRATCH = ["xmm14","xmm15"]`, `X64_GPR_RESERVED = ["rsp","rbp"]`.
- `src/optimizing/machine/peephole.ts` — `peepholeMachineCode`, `dropSelfCopies`,
  `fallThrough` (jump-to-next removal and branch inversion via `lowering.invertBranch`).
- `src/optimizing/machine/placement.ts` — `placeLoopHeadersAfterBodies`, `backEdgesOf`.

## Worked example

`Series.mean()` from `docs/example/stats.tera` — the only loop in the spine, and the only
place where the example has real register pressure: a float accumulator, an integer index,
the receiver, and a root-frame slot that must survive the calls inside the loop.

```bash
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-asm
sed -n '/^Series_mean:/,/^\t\.cfi_endproc/p' /tmp/stats-asm/stats.s
```

Read off the prologue what the allocator decided: eight callee-saved registers are spilled
(`rbx`, `xmm6`, `xmm7`, `rsi`, `rdi`, `r12`, `r13`), the receiver lives in `%rbx`, the
accumulator and the divisor in `%xmm6`/`%xmm7`, and the root frame pointer is *spilled* to
`32(%rsp)` and reloaded at every use — because `tera_enter_roots` and every call inside the
loop clobber it. Then show the same body with `coalesceRoundTrips` disabled and count
instructions.

## Outline

- [ ] **§ positions** — Establish the linear position space. `assignPositions` numbers every
      instruction in block order, **stepping by two**, and records `block.from` / `block.to`.
      Establish why the step is two rather than one: a *use* interval closes at
      `position + 1`, one past the instruction that reads it, so the odd numbers are the
      closing points and never collide with the next instruction's position. A *definition*
      opens at its own position. The consequence to state plainly: an instruction's use and
      its def overlap at that instruction, so a def can never quietly steal the register a
      source still needs.
- [ ] **§ intervals-and-holes** — Establish `LiveInterval` as a *sorted list of ranges*, not
      one span. Show why holes matter with a value defined in a loop preheader, dead through
      the loop body, and read after: one span would make it conflict with everything in the
      loop; a hole lets the register be reused. Read `addRange`'s merge (it always prepends
      or extends the *first* range, because construction walks blocks and instructions
      backwards) and `covers` / `intersectionWith` as the two queries the scan makes.
- [ ] **§ construction** — Walk `computeLiveness`: blocks in reverse order; `live` seeded
      from the union of successors' live-in sets; every live value given a range spanning
      the whole block; then instructions backwards, `setFrom` on defs and delete from
      `live`, `addRange(block.from, position + 1)` on uses and add to `live`. Then the loop
      extension: `loopsOf` finds back edges by block *order* (not by dominance), computes
      the loop body by backward reachability from the latch, and records the maximum `to` of
      any member; anything still live at a loop header is extended to that end.
- [ ] **§ use-weights** — Establish `addUse(position, weight)` with
      `weight = 2 ** min(depth, 4)`. State the cap as a deliberate saturation, not a bug: a
      quintuply-nested loop is not sixteen times more important than a quadruply-nested one,
      and an uncapped weight overflows the density comparison on deep nests. `orderUses`
      then reverses the list once, because construction walked backwards.
- [ ] **§ hints** — Establish copy hints as pre-coalescing. `hintTo` is called on **both**
      ends of every `flags.copy` instruction — destination hinted to source *and* source
      hinted to destination — with a priority rule: a physical hint is never overwritten,
      and a virtual hint never overwrites an existing one. `hintAt` records where the copy
      was, which § taking-a-hint needs.
- [ ] **§ fixed-intervals** — Establish that physical registers get intervals too.
      `LiveInterval.fixed` is true when the register is physical, `assigned` is itself, and
      those intervals go straight into `inactive` before the scan starts. This is how the
      ABI's clobbers (every `callerSaved` register `def`'d on a call), the shift counter
      (`%rcx`), and the argument registers become constraints without any special case in
      the allocator.
- [ ] **§ the-scan** — Establish the loop: a priority queue of unhandled intervals ordered
      by `start`; take the earliest; `advance(start)` moves expired intervals out of both
      sets and moves inactive intervals that now cover the position into `active` and vice
      versa; then `allocateFree`, and on failure `allocateBlocked`. Draw the three-state
      partition as a diagram. Establish the meaning of *inactive*: an interval with a hole
      covering the current position — it still owns its register, but only for positions its
      ranges cover.
- [ ] **§ freeUntilPos** — Establish `freeUntilOf`: every allocatable register in the class
      starts at `UNBOUNDED`; every *active* interval of the same class drops its register to
      `0`; every *inactive* interval drops it to the first position where it intersects the
      current interval. `allocateFree` then takes the register with the greatest
      `freeUntil`, and **only if it exceeds `current.end`** — this implementation does not
      take a partially free register (see [Ch 67 § rule-a]).
- [ ] **§ taking-a-hint** — Establish `takeHinted`, which runs *before* the general search.
      If the hinted register is free past `current.end`, take it. Otherwise, if exactly one
      interval blocks it and that interval is the hint's own interval and the two are
      adjacent across the copy (`current.start === current.hintAt && blocker.end ===
      current.hintAt + 1`, or the mirror image), **shorten the blocker to `hintAt`** and take
      the register anyway. This is the allocator deliberately handing a register over at the
      copy so the copy becomes `mov %r,%r` and `isRedundantCopy` deletes it. Pin both
      directions to tests.
- [ ] **§ allocateBlocked** — *Why the obvious design fails.* Stage the textbook rule first:
      spill the interval whose next use is furthest away. Then show what this allocator does
      instead. It partitions conflicts into *blocked* (fixed intervals, or intervals that
      start at or after `current.start` — these cannot be evicted) and *evictable*, sums
      `densityFrom(current.start)` over the evictable intervals per register, and takes the
      register whose summed density is lowest — comparing against `current`'s own density as
      the floor, so if nothing is cheaper than spilling `current` itself, `current` is
      spilled. Establish `densityFrom` as `weightFrom(position) / (end - max(position,
      start))`: loop-weighted uses per unit of live range, with an empty span answering
      `+Infinity` so a zero-length interval is never chosen as a victim.
- [ ] **§ two-address-lowering** — Establish the pass that runs *before* liveness and after
      scheduling. For every `flags.tied` instruction whose def and first use hold different
      virtuals, insert `copy dst := src` and rewrite the use to `dst`. Restate the tied
      contract from [Ch 64 § tied-operands] and note that it is enforced twice: here by a
      thrown error, and in `validateTiedForm` post-allocation by name comparison.
- [ ] **§ rewriting** — Establish `rewriteAllocations` as the pass that makes the function
      physical. Three jobs in one walk: replace every virtual with
      `allocation.locationAt(register, node.position).assigned`; for spilled operands, claim
      a reserved *scratch* register per class, emit a `reload` before the instruction for
      each spilled use and a `spill` after it for each spilled def; and drop copies whose two
      ends became the same register. Establish the loud failure: `OutOfScratchRegistersError`
      names the opcode and the class, because silently running out would produce a wrong
      register rather than no code.
- [ ] **§ scratch-registers** — Establish why two registers per class are reserved out of the
      allocation order entirely (`r10`, `r11`; `xmm14`, `xmm15`) rather than allocated. State
      the cost — two general-purpose registers permanently unavailable, on a machine with
      twelve allocatable — and the benefit: reloading never itself needs allocation, so there
      is no second allocator pass and no "spill the spiller" problem.
- [ ] **§ physical-liveness** — Establish the post-allocation liveness that coalescing needs,
      and why the pre-allocation one cannot serve: after rewriting, values are physical
      registers with no SSA structure. `physicalLiveness` runs a backward fixpoint to a
      round limit of `fn.blocks.length`, seeds exit blocks with the ABI's `returnRegisters`,
      treats a `call` as making the sentinel `"*"` live (everything), and then materialises a
      per-instruction `liveAfter` table. Three details had to be right or every coalescing
      candidate is silently refused: seed with the return registers rather than "everything"
      (a `*` injected at a `ret` never leaves the set and poisons the whole function through
      the CFG); start from **empty** sets, not conservative full ones; and compare set
      *contents*, because comparing sizes converges on the wrong answer.
- [ ] **§ the-return-register-bug** — Bugs are told as engineering. **Symptom:** an extra
      `movl` appeared in the float loop, and the newly landed scheduler was blamed.
      **Mechanism:** `physicalLiveness` seeded *every* return register as live at *every*
      `ret`, so `%rax` looked live in a function that returns in `%xmm0`; that blocked
      `foldDefineThenCopy` on `%eax`, and the scheduler had merely nudged the allocator into
      using `%eax` as the loop scratch. **Fix:** `answeredBy` — a `ret` contributes the
      registers it actually names as operands, falling back to the whole set only for a bare
      `ret` (void, or the pending-throw return). **Regression test:**
      `'keeps alive only the register the return names, not every return register'`.
      **General rule:** when a new pass makes an old pass regress, suspect the analysis they
      share before you suspect either pass.
- [ ] **§ coalescing** — Establish the two folds in `coalesceRoundTrips`, run to a fixpoint,
      each guarded by `liveAfter`. (1) *Round trip*: `copy scratch := held`, a tied
      instruction working on `scratch`, and a closing `copy held := scratch` become one tied
      instruction working directly on `held` — provided nothing between touches either
      register, neither is read through a memory operand, and `scratch` is dead after the
      closing copy. (2) *Define-then-copy*: an instruction whose only def is `scratch`,
      followed later by `copy dst := scratch`, writes `dst` directly. Note the permission
      that matters: the worker may *read* `dst` (`leal 1(%r8),%r8d` is fine, since an
      instruction reads its sources before writing), which is where the integer loops'
      remaining copy went.
- [ ] **§ coalescing-measured** — The number, with provenance. Same algorithm written twice —
      tera compiled to a PE, and C compiled with `gcc -O2` — best of three runs each, one
      case per fresh process, on the user's Windows machine. `acc + 1.5` float over 60M
      iterations: **130 ms before, 66 ms after; gcc -O2 is 65 ms** — parity. The float loop
      body went from six instructions to four. State the noise honestly: an earlier reading
      of the same change on the same machine recorded 126 ms → 72 ms, which is the spread you
      should expect and the reason every number in this book states how it was taken.
      Cross-reference [Ch 79 § measuring].
- [ ] **§ after-allocation** — Close the pipeline: `placeLoopHeadersAfterBodies` rotates a
      loop header below its body so the back edge becomes a fall-through, and
      `peepholeMachineCode` drops self-copies, removes a jump to the next block, and inverts
      a conditional branch whose fall-through target is the block after it. Note that
      instruction *count* can go up while dynamic work goes down (loop rotation removes a
      branch per iteration and changed the static count by +1), which is why static counts
      are not used as evidence anywhere in this part.

## Honesty items

- > **Unenforced.** `rewriteAllocations`'s `claim` closure runs twice with **independent**
  per-class counters — `claim("use", new Map())` then `claim("def", new Map())` — so a
  spilled use and a spilled def of two different virtuals on the same instruction can both
  receive `scratch[0]` (`%r10`). That is correct only because every instruction either reads
  all sources before writing its destination or is tied (in which case def and use[0] are
  the same virtual and share one entry through `scratchOf`). Nothing checks it. An
  instruction that wrote its destination before reading a source would miscompile silently.
  Cost of finishing: one shared counter map, at the price of needing twice the scratch
  registers on some instructions.
- > **Unenforced.** `loopsOf` identifies a back edge as "a successor earlier in
  `fn.blocks` order" rather than using the dominator tree, so use weights depend on block
  *layout*. `placeLoopHeadersAfterBodies` runs after allocation and cannot disturb it, but
  any future reordering before `assignPositions` would silently change spill decisions.
- > **Never runs.** `CompilerOptions.allocationTracer` and
  `machine/allocation-report.ts`'s `allocationReport` have no CLI surface at all — no flag
  in `src/cli/spec.ts` sets them. The only in-tree consumer is
  `tools/visualizer/src/workers/compiler-worker.ts`. Reading an allocation from the command
  line means reading the emitted assembly, which is what this chapter's worked example does.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-asm
sed -n '/^Series_mean:/,/call tera_enter_roots/p' /tmp/stats-asm/stats.s
npx vitest run --project unit tests/optimizing/machine/liveness.test.ts
npx vitest run --project unit tests/optimizing/machine/linear-scan.test.ts
npx vitest run --project unit tests/optimizing/machine/coalesce.test.ts tests/optimizing/machine/physical-liveness.test.ts
npx vitest run --project unit tests/optimizing/machine/pipeline.test.ts
```

## Tests that pin this

- Interval construction: `tests/optimizing/machine/liveness.test.ts` >
  `"starts a range at the definition and ends after the last use"`,
  `"gives an unused definition a range covering only the defining instruction"`,
  `"extends a value live across a back edge to the end of the loop"`,
  `"tracks physical registers as fixed intervals"`,
  `"keeps ranges disjoint when a later block adds an earlier range"`,
  `"reports the first overlapping position"`,
  `"reports no intersection for adjacent ranges"`.
- The scan: `tests/optimizing/machine/linear-scan.test.ts` >
  `"gives simultaneously live values distinct registers"`,
  `"spills only what does not fit and keeps the rest disjoint"`,
  `"never reuses a register a fixed interval is holding"`,
  `"keeps values in separate register classes independent"`,
  `"reports callee saved registers it decided to use"`,
  `"leaves no virtual register behind"`.
- Weights: `tests/optimizing/machine/linear-scan.test.ts` >
  `"keeps the value read inside the loop in a register and pays for the outer one"`.
- Hints: `tests/optimizing/machine/linear-scan.test.ts` >
  `"gives a copy destination the register it is copied from"`,
  `"leaves the copy in place when the source outlives it"`.
- Rewriting: `tests/optimizing/machine/linear-scan.test.ts` >
  `"reloads before the use and stores after the definition"`,
  `"fails loudly when one instruction needs more scratch than the target reserves"`.
- Two-address: `tests/optimizing/machine/linear-scan.test.ts` >
  `"copies the first source into the destination and ties the operand"`,
  `"leaves an already destructive instruction alone"`,
  `"rejects a tied instruction that is not in destructive form"`.
- Physical liveness, including the bug: `tests/optimizing/machine/physical-liveness.test.ts`
  > `"keeps alive only the register the return names, not every return register"`,
  `"reports a register dead once nothing reads it again"`,
  `"keeps the register a return answers with alive"`,
  `"carries liveness backwards across a loop"`,
  `"treats everything as live across a call"`.
- Coalescing: `tests/optimizing/machine/coalesce.test.ts` >
  `"accumulates into the held register when the scratch dies right after"`,
  `"writes a computed value straight into the register it is copied to"`,
  `"folds even when the computation reads the register it will write"`,
  `"keeps the copy when something between reads the register it would write"`,
  `"keeps the round trip when the scratch is read afterwards"`,
  `"coalesces across instructions that touch neither register"`,
  `"keeps the round trip when something between reads the held register"`,
  `"leaves a call between the copies alone"`.
- End to end over every target: `tests/optimizing/machine/pipeline.test.ts` >
  `"aligns the frame so the stack pointer is aligned at a call"`,
  `"places every local slot inside the frame it reserved"`, and the parametrised rows
  `"allocates every register for a %s"` / `"keeps live ranges of a %s in disjoint registers"`
  under `describe.each(targets)("machine pipeline on %s", …)`.
