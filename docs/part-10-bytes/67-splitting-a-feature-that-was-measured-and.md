# 67. Splitting: A Feature That Was Measured and Left Off   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** Register allocation is where a compiler book usually ends and this one starts
asking whether the clever version pays — it did not, and the implementation is still in the
tree behind a default-off flag.

**What arrived.** The allocator of [Ch 66]: whole intervals, assigned or spilled, with
`Allocation.splitRegisters` empty and `resolveSplitIntervals` returning immediately.

**What leaves.** Nothing new on the default path — that is the chapter's point. On the
`splitLiveRanges: true` path, an `Allocation` in which one virtual register may hold
different locations at different positions, plus the resolution moves that make the boundary
between them correct.

**New ideas.** Live-range splitting; the resolution problem (a value in two places on two
sides of an edge); monotonicity of the scan and why it can be lost; a difference array; the
reload break-even question.

**Length.** 12 pages

## Anchors

- `src/optimizing/machine/linear-scan.ts` — `Allocation.splitRegisters` and
  `Allocation.locationAt(register, position)`; `LinearScan.track` / `byRegister`;
  `split`; `splitPositionFor`; `resolvableBoundaries`; `placeableEdge`; `firstAbove`;
  `RELOAD_BREAK_EVEN_USES = 2`; `NO_SPLIT = -1`; the `splitting` constructor argument and
  the `boundaries` field it fills (empty when splitting is off); the surviving call site in
  `allocateBlocked`'s `victim === null` branch.
- `src/optimizing/machine/liveness.ts` — the interval surgery splitting needs and nothing
  else uses: `LiveInterval.splitAt`, `splittableAt`, `firstUseAfter`, `useCountFrom`,
  `shortenTo`.
- `src/optimizing/machine/resolve.ts` — `resolveSplitIntervals`, the `Resolver` class
  (`run`, `resolveEdges`, `resolveWithinBlocks`, `at`, `movesFor`, `placeOnEdge`, `flush`),
  `differingLocation`, `CarriedValue`, `UnresolvableEdgeError`.
- `src/optimizing/machine/rewrite.ts` — `rewriteAllocations` calls
  `resolveSplitIntervals` itself, on its first line, rather than relying on the caller.
- `src/optimizing/options.ts` — `CompilerOptions.splitLiveRanges`, defaulted to `false` in
  `compilerOptions()`; not present in any `OptLevelPreset`, so no optimization level turns
  it on.
- `src/optimizing/machine/pipeline.ts` — the single read:
  `allocateRegisters(fn, lowering.target, liveness, options.splitLiveRanges)`.
- `src/optimizing/infra/priority-queue.ts` — `PriorityQueue.push`, which is what lets the
  unhandled queue accept children created mid-scan.
- `src/cli/spec.ts` — searched, and there is no flag; see Honesty items.

## Worked example

The `examples/*.tera` corpus compiled to x64 Linux assembly with each split rule on in turn,
one case per fresh process, counting emitted instructions and stack references. Thirteen
files at the time of measurement; fourteen today. The reproduction command is written down
with the date and the machine, and the chapter cites it as a claim id rather than as a fact
about compilers in general:

```bash
for f in examples/*.tera; do
  node dist/cli.js compile "$f" --emit source --platform linux -o /tmp/split-off 2>/dev/null
done
```

## Outline

- [ ] **§ what-splitting-buys** — Establish the idea before the code. A whole-interval
      allocator has exactly two answers for a value: a register for its entire life, or a
      stack slot for its entire life. Splitting adds a third: a register here, a slot there,
      with a move at the seam. Draw the canonical win — a value defined early, unused across
      a register-hungry middle region, and read three times at the end.
- [ ] **§ three-wimmer-rules** — Establish the three rules the literature offers, each as a
      place in the existing scan where a split could be inserted. **Rule A**: in
      `allocateFree`, when the best register is free only until `freeUntilPos < current.end`,
      take it anyway and split `current` there. **Rule B**: in `allocateBlocked`, evict by
      splitting the victim at `current.start` rather than spilling it whole. **Rule C**: when
      `current` itself must be spilled, spill only up to its next use and re-queue the rest.
- [ ] **§ ab-numbers** — The measurement, with its provenance in the sentence: the
      `examples/` corpus, x64 Linux assembly, one case per fresh process, versus no
      splitting.

      | rule | instructions | stack references |
      | --- | --- | --- |
      | A — take a partially free register, split at `freeUntilPos` | +1.8% (worst file +11%) | +3.4% |
      | B — evict by splitting the victim at `current.start` | +1.4% | +4.9% |
      | C — spill only to the next use | +0.14% | +1.4% |
      | C + `RELOAD_BREAK_EVEN_USES` gate | **+0.05%** | **+0.5%** |

      Every row is a *regression*: more instructions and more stack traffic than not
      splitting at all. Wall time on a register-pressure benchmark (native executable, five
      runs, best of) showed **no measurable difference**. Record the near-miss honestly: an
      early "7% faster" reading was noise on a loaded machine, which is why the baseline arm
      is always repeated [Ch 79 § measuring].
- [ ] **§ why-a-and-b-lose** — *What was tried and rejected.* Explain the mechanism behind
      the sign of the numbers rather than just reporting it. Both A and B create seams; every
      seam needs a resolution move; the moves land on block boundaries where they cannot be
      coalesced away by [Ch 66 § coalescing], which only works within a block. A whole-
      interval spill costs one store and one reload per use; a split costs a move at every
      boundary the value crosses. On this corpus, with twelve allocatable GPRs and functions
      of a few hundred instructions, the boundaries outnumber the saved reloads.
- [ ] **§ what-shipped** — Establish what survived. Rules A and B were **deleted**, not
      disabled — `allocateFree` still requires `bestUntil > current.end` and
      `allocateBlocked` still calls `spill` + `retire` on the victim. Rule C survives, gated
      twice: `splitPositionFor` must find a *resolvable* boundary at or before the next use,
      and `current.useCountFrom(at) >= RELOAD_BREAK_EVEN_USES` must hold, i.e. the tail must
      be read at least twice or the reload does not pay for itself. And the whole path is
      inert unless `splitLiveRanges` is true, because `boundaries` is then the empty array
      and `splitPositionFor` always answers `NO_SPLIT`.
- [ ] **§ locationAt** — Establish the interface change that stayed. A per-value register map
      cannot express a value in two places, so `Allocation` answers
      `locationAt(register, position)`: search the parts for one that `covers` the position,
      else the nearest part starting at or before it, else the nearest after. Every consumer
      moved to it — `rewriteAllocations`, `resolve.ts`, the allocation report. This is real
      complexity carried on the default path for a feature that is off, and the chapter
      should say so plainly rather than pretend it is free.
- [ ] **§ resolvable-boundaries** — Establish the trap that cost the most time. **Split
      positions live in the linear position space, not in the CFG.** Any edge whose two
      endpoints straddle a split position needs a resolution move — not just edges into the
      block that happens to start there. `resolvableBoundaries` therefore walks every edge,
      skips the ones a move can be placed on (`placeableEdge`: the successor has one
      predecessor, or the predecessor has one successor), and marks the *position range* the
      remaining critical edges forbid, using a **difference array** over the sorted list of
      instruction starts — `crossed[first]++`, `crossed[last+1]--`, then a running sum, and
      the positions where the sum is zero are the legal split points. Primer for the
      difference array; it is the only one in the back end.
- [ ] **§ resolution** — Establish `resolveSplitIntervals`. Two passes: `resolveEdges` looks
      at every predecessor/successor pair, asks `locationAt(register, pred.to - 1)` and
      `locationAt(register, succ.from)` for each split register, and builds a `CarriedValue`
      for each disagreement; `resolveWithinBlocks` catches the in-block case, where one part
      ends exactly where the next begins and that position is not a block start. `movesFor`
      then emits stores for values going to a slot, reloads for values coming from one, and
      hands the register-to-register moves to `sequenceParallelCopies` [Ch 64
      § parallel-copy] — with the temporary drawn from the class's **physical scratch**
      register, not a fresh virtual, because allocation is already over.
- [ ] **§ monotonicity** — Establish the second trap as an invariant. **An evicted victim
      must be split exactly at `current.start`, never earlier**: a child interval starting
      before the scan position would be pushed back onto the unhandled queue with a `start`
      the scan has already passed, and linear scan's whole correctness argument is that it
      processes intervals in non-decreasing start order. This is why rule B, had it survived,
      would have had exactly one legal split position.
- [ ] **§ resolution-is-mandatory** — Establish the third trap: `rewriteAllocations` alone no
      longer emits correct code once splitting can happen, so it calls `resolveSplitIntervals`
      itself rather than trusting its caller to. State the general rule: when a feature makes
      a previously-optional pass mandatory, move the call inside the pass that would break
      without it.
- [ ] **§ why-keep-it** — Close by defending the decision to leave dead-by-default code in a
      tree that otherwise deletes what it does not use. The measurement is corpus-specific:
      twelve allocatable GPRs, functions of a few hundred instructions, an out-of-order x86
      core. riscv64 has more registers and is in-order; a target with four allocatable
      registers would tell a different story. The flag is the record of *what was measured*,
      and rules A and B were deleted precisely because keeping all three would have been
      keeping an untested claim rather than a switchable one.

## Honesty items

- > **Measured worse.** `CompilerOptions.splitLiveRanges` is complete, correct and tested,
  and is `false` in `compilerOptions()` because every A/B row above is a regression. Cost of
  finishing: nothing to finish — the cost is of *turning it on*, which is +0.05%
  instructions and +0.5% stack references for no measured wall-time change.
- > **Dead.** With `splitLiveRanges: false` — the only value anything in `src/` ever passes,
  and the only one any test passes outside `tests/optimizing/machine/resolve.test.ts` and
  one case in `tests/optimizing/machine/linear-scan.test.ts` — `LinearScan.boundaries` is
  `[]`, so `splitPositionFor`'s loop never iterates and always answers `NO_SPLIT`;
  `LinearScan.split`, `LiveInterval.splitAt`, `LiveInterval.splittableAt` and
  `LiveInterval.useCountFrom` are therefore never called; `Allocation.splitRegisters` is
  always empty, so `resolveSplitIntervals` returns on its first line and the whole
  `Resolver` class in `src/optimizing/machine/resolve.ts` (204 lines) never runs. Two
  neighbours are **not** dead and the chapter must not sweep them in:
  `LiveInterval.firstUseAfter` runs on the default path with its result discarded, and
  `LiveInterval.shortenTo` is used by `takeHinted` [Ch 66 § taking-a-hint]. Cost of
  finishing: deleting it would cost the record of the measurement.
- > **Unfinished.** There is no CLI flag for `splitLiveRanges`. `src/cli/spec.ts` exposes
  `--verify` and `--print-after-all` under *Optimization* and nothing else that reaches
  `CompilerOptions`, so reproducing the A/B measurement today requires editing
  `compilerOptions()` or calling `compileMachineFunction` from a script. Cost of finishing:
  one option entry, plus a decision about whether a measured-worse switch belongs on a
  user-facing CLI at all.
- > **Unenforced.** `UnresolvableEdgeError` exists for the case where a carried value must
  cross a critical edge that has no home. `resolvableBoundaries` is supposed to make that
  unreachable by refusing to split at any position such an edge straddles. Nothing checks
  that the two agree, and no test reaches the throw.

## Verify it yourself

```bash
grep -rn "splitLiveRanges" src/optimizing
npx vitest run --project unit tests/optimizing/machine/resolve.test.ts
npx vitest run --project unit tests/optimizing/machine/linear-scan.test.ts
node dist/cli.js compile docs/example/stats.tera --emit source --platform linux -o /tmp/sysv
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe
```

## Tests that pin this

- That splitting works when switched on:
  `tests/optimizing/machine/resolve.test.ts` >
  `"splits the value rather than spilling it for its whole life"`,
  `"reloads it once, in the block that reads it"`,
  `"stores it once, before the block that crowds it out"`. These are the only tests in the
  tree that pass `true` for the `splitting` argument.
- That the default path does *not* split, and what it does instead:
  `tests/optimizing/machine/linear-scan.test.ts` >
  `"leaves the whole value spilled when splitting is switched off"`.
- The break-even gate: `tests/optimizing/machine/linear-scan.test.ts` >
  `"leaves a value read only once fully spilled, since a split would not pay"`,
  `"spills a crowded-out value only up to the use that needs it back"`,
  `"reloads a crowded-out value once however many times it is read after"`.
- Interval surgery: `tests/optimizing/machine/liveness.test.ts` >
  `"splits a range in two that meet exactly at the split"`,
  `"moves uses at or after the split to the child"`,
  `"keeps whole ranges on the side of the split they fall on"`,
  `"carries the register of the value it was split from"`,
  `"is splittable only strictly inside one of its ranges"`,
  `"reports the first use strictly after a position"`.
- The wall-time claim is `[unpinned]`: there is no benchmark harness in this tree, and the
  register-pressure benchmark was a one-off program run five times by hand.
