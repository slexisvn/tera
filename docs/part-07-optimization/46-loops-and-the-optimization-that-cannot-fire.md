# 46. Loops, and the Optimization That Cannot Fire   ⟨J · N⟩

> **Status:** outline

**Thesis.** LICM refuses anything carrying a frame state and guard peeling requires one —
they are exact complements — and the pass with the most impressive machinery in the file has
never removed a single bounds check.

**What arrived.** For LICM: the graph at ordinal 5, right after
`trivial-phi-elimination-early` and `builtin-method-lowering`, with a `LoopForest`, a
`PointsToResult` and a `ModRef` in the cache. For the rest of this chapter: the graph at
ordinals 17–21, after GVN.

**What leaves.** Loop-invariant effect-free computations spliced into the preheader; a copy
of each peelable guard added to the preheader (with the in-loop original still there, for the
*next* pass to remove); `noOverflow` stamped on every `Int32Add`/`Sub`/`Mul` whose range fits
int32 and cannot be `-0`; branches whose comparison is decided by range folded to jumps; and
every `CheckBounds` still exactly where it was.

**New ideas.** Loop-invariant code motion; a preheader as a place to put things; strength of
a guard vs a computation; interval (range) analysis; induction variable; loop unswitching.

**Length.** 16 pages

## Anchors

- `src/optimizing/passes/loop-opts.ts` — `isSideEffectFree`, `hoistLoopInvariants`,
  `peelLoopChecks`, `buildNodeToBlock`, `isPeelableCheck`, `valueAvailableAtBlock`,
  `frameStateAvailableAtBlock`, `isLoopNode`.
- `src/optimizing/passes/unswitching.ts` — `loopUnswitching`, `InvariantBranch`,
  `invariantBranchIn`, `definedOutside`, `loopSize`, `routeEscapesThroughExit`,
  `enterEither`, `unswitchLoop`, `successorNamed`.
- `src/optimizing/passes/checks.ts` — `eliminateRedundantChecks` (and its `checkKey`),
  `rangeAnalysisAndBoundsCheckElimination`, `Range`, `LoopGuardEntry`, `InductionVariable`,
  `setRange`/`getRange`, `preNarrowRanges`/`getPreNarrowRange`, `narrowRange`,
  `mayBeMinusZero`, `nonNegative`, `nonZero`, `detectInductionVariable`, `loopGuardIndex`,
  `findLoopGuard`, `arrayLengthNodes`, `rangeText`, `removeDeadPureNodes`, `isDeadPureNode`,
  `UNBOUNDED_MIN`/`UNBOUNDED_MAX`/`INT32_MIN`/`INT32_MAX`.
- `src/optimizing/analyses/loops.ts` — `Loop.preheader`, `.exitBlocks`, `.exitingBlocks`,
  `.blocks`, `.latches`, `LoopForest.loops()` (preorder; both loop passes iterate it
  **reversed**, i.e. innermost-first), `.isHeader`, `.contains`.
- `src/optimizing/analyses/mod-ref.ts` — `writesOf(loop.blocks)` → `RegionMemory`, and
  `mayReadFrom(node, memory)`.
- `src/optimizing/ir/operations.ts` — `isMovable` (not pinned, not a terminator, writes
  nothing, allocates nothing), `IR_CHECK_SMI`/`CHECK_MAP`/`CHECK_NUMBER`/`CHECK_ARRAY`,
  `IR_CHECK_BOUNDS`, `IR_LOAD_ARRAY_LENGTH`.
- `src/optimizing/target/integer.ts` — `withinInt32`, `INT32_SHIFT_MASK`.
- `src/optimizing/ir/clone.ts` — `cloneBlocks` (used by unswitching to duplicate the loop).
- `src/optimizing/options.ts` — `peelBudget` (0 / 20 / 80 / 160 by level),
  `unswitchBudget` (0 / 0 / 48 / 96), `deoptimizes`.
- `src/optimizing/pipeline.ts:110` — `const unswitchBudget = options.deoptimizes ? 0 : options.unswitchBudget;`
- `src/optimizing/optimizer.ts:39` — `staticCompilerOptions` setting `deoptimizes: false`.

## Worked example

Two peeling tests side by side, both in `tests/optimizing/pipeline.test.ts`, both run through
the **whole** middle end rather than the pass alone:

- `"leaves the guard checked once, in the pre-header"` — a `CheckSmi` on a loop-invariant
  parameter. After `runMiddleEnd`, `guardsIn(preHeader) === 1` and `guardsIn(body) === 0`.
- `"keeps the guard inside the loop when the loop rewrites the field it guards"` — the same
  shape, but the guarded value is a `LoadField` and the body stores to that same offset.
  After `runMiddleEnd`, `guardsIn(body) === 1`.

The pair is the chapter's spine because the *second* is the one peeling gets right by
accident and redundant-check elimination gets right on purpose: peeling copies the guard into
the preheader either way, and only `redundant-checks-after-peeling` decides whether the
in-loop copy can go. The third test in the trio,
`"keeps the guard inside the loop when the peel budget forbids peeling"`, isolates the budget.

## Outline

- [ ] **`> **New idea.**` Loop-invariant code motion.** Establish the idea and the two
      questions it must answer: *is this value the same every iteration?* and *is it safe to
      compute it before the loop even runs?* Establish that the second question is where every
      real LICM gets hard.
- [ ] **LICM's first gate is a frame state.** Quote it whole:

      ```ts
      function isSideEffectFree(node: LoopNode): boolean {
        return ir.isMovable(node) && node.frameState === null;
      }
      ```
      — src/optimizing/passes/loop-opts.ts:20-22

      Establish `isMovable` (from the operation table: not pinned, not a terminator, writes
      nothing, allocates nothing) and then the second conjunct: **a node carrying a frame
      state describes a program point.** Move it and its frame state now describes somewhere
      the program was not. Pin with `"does NOT hoist node with frameState"`.
- [ ] **LICM's second gate is mod-ref.** Establish `modRef.writesOf(loop.blocks)` summarising
      the loop body once, then `!modRef.mayReadFrom(node, memory)` per candidate. Establish
      the three shapes the tests separate: a load whose slot the loop writes stays; a load of a
      *different* slot hoists; a load inside a loop that clobbers all memory stays, but a
      *declared-pure* call hoists even then. Pin with the four `hoistLoopInvariants speculation
      and memory dependence` titles.
- [ ] **The worklist, and why the pipeline order matters.** Establish the fixpoint: seed with
      every hoistable node in the body, pop, require every input to be outside the loop or
      already marked invariant, then re-enqueue the node's *uses* inside the loop. Establish
      that inputs coming through an untouched loop-header phi defeat it — and that this is
      exactly why `trivial-phi-elimination-early` runs at ordinal 3 and LICM at 5. Pin with
      the pipeline-order pair `"cannot hoist a value carried through an untouched loop-header
      phi"` / `"hoists that same value once trivial phis have been eliminated first"`, and
      cross-reference [Ch 47 § trivial-phis].
- [ ] **Peeling is the exact complement.** Establish `peelLoopChecks`'s gates in order:
      the loop must fit `budget`; the header terminator must be a `Branch` whose two targets
      split exactly one exit and one continuation; there must be a `preheader`; the node must
      be an `isPeelableCheck` (`CheckSmi` / `CheckMap` / `CheckNumber` / `CheckArray`); it must
      have `node.frameState` — **and the frame state's values must themselves be available at
      the preheader** (`frameStateAvailableAtBlock`). Establish `peelableLoads`: a `LoadField`
      whose inputs are all available in the preheader may be peeled *alongside* the guard that
      reads it. Establish the complementarity as one sentence: LICM moves things that cannot
      fail; peeling copies things that can.
- [ ] **War story: peeling added one guard and removed zero.** Symptom: `peelLoopChecks`
      reported `changed` and the graph grew, with the in-loop guard still there — because
      `peelLoopChecks` **only clones**; it never removes the original. Mechanism: the removal
      is a *different* pass. Fix: `step("redundant-checks-after-peeling", …)` at ordinal 21,
      immediately after `loop-check-peeling` at 20, running `eliminateRedundantChecks` a second
      time. Regression test: the pipeline-level `"leaves the guard checked once, in the
      pre-header"`, which asserts on both blocks. **General rule:** a pass that duplicates for
      a later pass to deduplicate must be adjacent to it in the pipeline, and the test must be
      written at pipeline level, not pass level — the pass-level test
      `"peels a body check into the pre-header when the loop fits the budget"` would pass with
      the bug still present.
- [ ] **Why the check key is deliberately narrow.** Establish `checkKey` in
      `eliminateRedundantChecks`:
      `smi_<inputId>`, `num_<inputId>`, `map_<inputId>_<mapId>_<version|any>`,
      `elements_<inputId>_<kind>`. Establish that keying on the **input node id** — not on a
      value number, not on an alias class — is what makes the peeled copy and the in-loop
      original match, and what makes two guards on *different* nodes holding the same object
      *not* match. **Why the obvious design fails:** widening the key to a value number would
      let a guard on a value that has since been rewritten discharge a guard on a value that
      has not. The narrowness is the soundness argument. Pin with
      `"does not remove CheckMap with different map ids"` and
      `"preserves CheckMap across StoreField on same object"`.
- [ ] **Unswitching, and the one line that turns it off for the JIT.** Establish
      `invariantBranchIn` (a branch inside the loop whose condition is `definedOutside`, both
      arms inside the loop), the three refusals in `unswitchLoop` (no single preheader ending
      in a `Jump`; more than one exit block; an exit also reached from outside), then the
      transform: `routeEscapesThroughExit`, `cloneBlocks`, two `rewriteBranchAsJump` calls in
      opposite directions, `enterEither`. Establish `routeEscapesThroughExit` as the SSA
      repair — every use *outside* the loop of a value defined *inside* it is rerouted through
      a new phi in the single exit block, including uses inside frame states. Then quote:

      ```ts
      const unswitchBudget = options.deoptimizes ? 0 : options.unswitchBudget;
      ```
      — src/optimizing/pipeline.ts:110

      Establish that `deoptimizes` is `true` for every JIT compile and `false` only via
      `staticCompilerOptions`, so **loop unswitching never runs in the JIT**, by construction,
      whatever `--opt-level` says. Establish the reasoning encoded in the pass's own remark:
      *"either because this optimisation level does not pay for loop duplication or because the
      target can deoptimize instead."* Cross-reference [Ch 55 § no-way-out].
- [ ] **`> **New idea.**` Range analysis.** Establish `Range = {min, max}` over ±`Infinity`,
      `setRange`'s "if it is not a sane interval, it is unbounded" guard, and the transfer
      rules for `Int32Add`/`Sub`/`Mul`/`Div`/`Mod` (with `Mul`'s four cases and `Div`'s
      divide-by-zero-straddling cases). Establish parameter seeding from the declared
      signature: `DECLARED_INT` gives `[INT32_MIN, INT32_MAX]`, anything else is unbounded.
      Pin with the three `parameter ranges` titles.
- [ ] **Per-branch edge narrowing, and the two range maps.** Establish `narrowRange` applied
      per comparison per successor for `<`, `<=`, `>`, `>=`. Then establish
      `preNarrowRanges` — a full copy taken *before* narrowing — and that the always-true /
      always-false branch folding reads `getPreNarrowRange`, not `getRange`. **Establish why:
      narrowing writes the assumption of a branch back into the same map, so folding on the
      narrowed range would fold a comparison using the very fact the comparison establishes.**
      This is the same failure mode as [Ch 49](49-speculative-types-are-not-facts.md) in a
      different currency, and the chapter should say so.
- [ ] **`mayBeMinusZero` and `noOverflow`.** Establish the stamping loop: an
      `Int32Add`/`Sub`/`Mul` gets `props.noOverflow = true` when `withinInt32(r.min, r.max)`
      **and** `!mayBeMinusZero(node)`. Establish `mayBeMinusZero`: only `Int32Mul` can produce
      `-0`, and only when the operands are not both non-negative and not both non-zero.
      Establish the real consumer: `strengthReduction` refuses to touch a multiply without
      `noOverflow` ([Ch 47 § strength-reduction]), and `SccpSolver.foldedArithmetic` wraps only
      with it ([Ch 43 § int32-is-not-int32]). Establish a second producer of the same flag —
      `settleInt32Arithmetic` in type narrowing ([Ch 48 § settle-int32]) — and that
      `int32-overflow-widening` at ordinal 19 rewrites every `Int32*` still lacking it into a
      `Float64*`.
- [ ] **Bounds-check elimination: the machinery.** Establish `detectInductionVariable`
      (a two-input phi one of whose inputs is an `Int32Add` involving the phi itself; requires
      `initRange.min >= 0` and `stepRange.min > 0`), the `loopGuardIndex` built from every
      `<`/`<=` branch keyed by `cmp.inputs[0].id`, `findLoopGuard`, `arrayLengthNodes`, and the
      three routes to `bounded`: a dominating comparison in a predecessor's terminator; a
      guarded induction variable; a known array length strictly greater than the index's max.
- [ ] **Bounds-check elimination: it has never removed one.** This is the chapter's title beat
      — see Honesty items for the measurement and the exact refusal. Establish the four
      supporting facts: (1) the pass has a `BCE-IV` trace message written for a loop it cannot
      reach; (2) no test in `tests/optimizing/passes/checks.test.ts` asserts a `CheckBounds` is
      removed; (3) the AOT pipeline emits no `CheckBounds` at all, so there is nothing for it
      to do there; (4) the JIT does, and they survive. Close with **why the fix is deferred**:
      the pass removes a memory-safety check, and `findLoopGuard` has not been audited for
      whether the guard is against *that array's* length. A soundness review, not a patch.

## Honesty items

> **Broken.** `rangeAnalysisAndBoundsCheckElimination`
> (`src/optimizing/passes/checks.ts:141-738`) does not remove a `CheckBounds` produced from
> tera source. **Measured 2026-09-07** on the book's own `docs/example/stats-deopt.tera`: the
> optimizing tier's graph for `total_of` still contains `v17 = CheckBounds v10, v15` after the
> full pipeline (`node dist/cli.js --print-ir --filter total_of docs/example/stats-deopt.tera`),
> and running the pass on that exact graph with a remark scope open prints
> `kept the bounds check: index v10 has range [-inf,+inf], which does not prove it is a
> non-negative number with a known upper bound`. The mechanism is the range walk: `setRange`
> is a **single forward pass over `graph.blocks` in list order** with no fixpoint over back
> edges, so a loop's induction phi joins an already-computed `[0,0]` with a not-yet-computed
> `Int32Add` that reads `[-inf,+inf]`, and the phi is unbounded forever. The index and the
> loop guard *do* name the same node in this graph (both `v10 = CheckSmi v6`), so the three
> `bounded` routes are never even reached — the pass returns at the range gate above them.
> Cost of finishing: a fixpoint over the loop's back edge in the range walk, **plus** the
> soundness review of `findLoopGuard` that has been deferred since 2026-08-24.

> **Never runs.** The `BCE-IV` trace message (`checks.ts:679-682`) and the `BCE-Range` message
> (`checks.ts:693-696`) describe successes the pass cannot reach on any tera program in this
> tree, for the reason above.

> **Never runs.** `loopUnswitching` cannot fire in the JIT: `pipeline.ts:110` forces its budget
> to `0` whenever `options.deoptimizes`, which is the default and is only cleared by
> `staticCompilerOptions` for AOT. `tests/optimizing/passes/unswitching.test.ts` exercises the
> pass directly with an explicit budget, so the transform is fully tested and half deployed.

> **Unenforced.** `checks.ts` refers to the array-length opcode by the bare string literal
> `"LoadArrayLength"` in two places (`checks.ts:592`, `checks.ts:620`) instead of the exported
> `IR_LOAD_ARRAY_LENGTH` constant (`src/optimizing/ir/operations.ts:64`). Renaming the opcode
> would silently disable both.

> **Unfinished.** `peelLoopChecks` returns a count of *loops peeled*, not nodes peeled, and it
> never removes the in-loop original — the pipeline compensates by running
> `eliminateRedundantChecks` immediately afterwards. If that adjacency is ever broken, peeling
> becomes a pure code-size regression with no test to catch it at pass level.

> **Unfinished.** `eliminateRedundantChecks` `walkBlock` and `removeDeadPureNodes` are both
> recursive/quadratic-ish: `removeDeadPureNodes` re-scans every node in the graph on every
> iteration of its `while (changed)` loop. It only runs when `elimCount > 0`, which today means
> it only runs after a branch fold.

## Verify it yourself

```bash
node dist/cli.js --print-ir --filter total_of docs/example/stats-deopt.tera | grep -n "CheckBounds\|Int32Compare\|Phi"
npx vitest run --project unit tests/optimizing/passes/loop-opts.test.ts tests/optimizing/passes/checks.test.ts
npx vitest run --project unit tests/optimizing/passes/unswitching.test.ts tests/optimizing/pipeline.test.ts
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | grep -E ' licm| loop-unswitching| loop-check-peeling| bounds-check-elimination'
grep -n "unswitchBudget" src/optimizing/pipeline.ts src/optimizing/options.ts
```

## Tests that pin this

- `tests/optimizing/passes/loop-opts.test.ts` > `"does NOT hoist node with frameState"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"does NOT hoist LoadField that aliases a store in loop"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"hoists LoadField with no aliasing store in loop body"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"hoists chain of invariant nodes via worklist"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"hoists a pure builtin call whose operands come from outside the loop"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"keeps a builtin call that is not declared pure inside the loop"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"still hoists a pure call when the loop clobbers all memory"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"keeps a field load inside a loop that clobbers all memory"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"hoists a field load when the loop only writes a different slot"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"keeps a global load that the loop overwrites"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"never hoists a store out of the loop"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"peels a body check into the pre-header when the loop fits the budget"`
- `tests/optimizing/passes/loop-opts.test.ts` > `"leaves the loop untouched when its node count exceeds the budget"`
- `tests/optimizing/pipeline.test.ts` > `"leaves the guard checked once, in the pre-header"`
- `tests/optimizing/pipeline.test.ts` > `"keeps the guard inside the loop when the peel budget forbids peeling"`
- `tests/optimizing/pipeline.test.ts` > `"keeps the guard inside the loop when the loop rewrites the field it guards"`
- `tests/optimizing/pipeline-order.test.ts` > `"cannot hoist a value carried through an untouched loop-header phi"`
- `tests/optimizing/pipeline-order.test.ts` > `"hoists that same value once trivial phis have been eliminated first"`
- `tests/optimizing/passes/checks.test.ts` > `"removes duplicate CheckMap on same object with same map"`
- `tests/optimizing/passes/checks.test.ts` > `"does not remove CheckMap with different map ids"`
- `tests/optimizing/passes/checks.test.ts` > `"propagates checks through dominator tree"`
- `tests/optimizing/passes/checks.test.ts` > `"preserves CheckMap across StoreField on same object"`
- `tests/optimizing/passes/checks.test.ts` > `"eliminates CheckMap in dominated block across StoreField"`
- `tests/optimizing/passes/checks.test.ts` > `"marks noOverflow on add with small constant ranges"`
- `tests/optimizing/passes/checks.test.ts` > `"folds always-true branch comparison"`
- `tests/optimizing/passes/checks.test.ts` > `"folds always-false branch comparison"`
- `tests/optimizing/passes/checks.test.ts` > `"bounds a parameter declared int by the int32 range"`
- `tests/optimizing/passes/checks.test.ts` > `"leaves a parameter with no declared type unbounded"`
- `tests/optimizing/passes/unswitching.test.ts` > `"clones the loop and tests the invariant condition once, in the preheader"`
- `tests/optimizing/passes/unswitching.test.ts` > `"keeps the graph in SSA form"`
- `tests/optimizing/passes/unswitching.test.ts` > `"hands the exit block one incoming value per copy"`
- `tests/optimizing/passes/unswitching.test.ts` > `"leaves a loop whose condition changes with the induction variable alone"`
- `tests/optimizing/passes/unswitching.test.ts` > `"does nothing when the budget is zero"`
- `tests/optimizing/infra/pass-remarks-from-passes.test.ts` > `"says the index range is unknown when the index is an opaque parameter"`
- `tests/optimizing/infra/pass-remarks-from-passes.test.ts` > `"gives a different reason once the index has a known range but no known length"`
- `tests/optimizing/analyses/loops.test.ts` > `"derives exiting blocks, exit blocks, and preheader"`
- **No test removes a `CheckBounds`.** `[unpinned]` — the pass's success path has no coverage.
