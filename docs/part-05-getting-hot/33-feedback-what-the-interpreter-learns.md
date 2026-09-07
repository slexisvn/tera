# 33. Feedback: what the interpreter learns   ⟨I · B · J⟩

> **Status:** outline

**Thesis.** Slots are allocated at compile time as trailing operands, typed at first
execution by scanning the instruction stream, and advance through a four-state lattice that
only ever moves up.

**What arrived.** A `RegisterCompiledFunction` from [Ch 20 § scopes-closures-classes]: an
instruction array whose property, arithmetic, call and branch opcodes each carry an extra
integer operand nobody has read yet, plus a `feedbackSlotCount` counting how many were
handed out.

**What leaves.** The same function with `feedbackVector` populated: one `FeedbackSlot` per
allocated index, each carrying an `icState`, the maps / call targets / type tags / elements
kinds it observed, and an `isStable` flag. This is the entire input to
[Ch 39 § building-ssa] and [Ch 49 § speculative-taint].

**New ideas.** *Profile-guided speculation* (why an interpreter records anything at all);
*lattice* and *monotone / one-way transition* (first use in the book — [Ch 10] taught the
type lattice, this is the second, unrelated one, and the chapter must say so);
*monomorphic / polymorphic / megamorphic*; *saturating counter*.

**Length.** 14 pages

## Anchors

- `src/feedback/vector/index.ts` — `FeedbackSlot`, `FeedbackVector`, and the six kind
  constants `FEEDBACK_PROPERTY` / `FEEDBACK_BINARY_OP` / `FEEDBACK_UNARY_OP` /
  `FEEDBACK_CALL` / `FEEDBACK_ALLOCATION` / `FEEDBACK_BRANCH`. The lattice is
  `IC_UNINITIALIZED` / `IC_MONOMORPHIC` / `IC_POLYMORPHIC` / `IC_MEGAMORPHIC` ordered by
  the `LATTICE_ORDER` table; `MAX_POLYMORPHIC_ENTRIES = 4`;
  `STABILITY_SETTLE_THRESHOLD = 50`; `DEFAULT_LOOP_BUDGET = 1000`;
  `INVOCATION_COUNT_FOR_OPTIMIZATION = 3000`. The one-way step is `_advanceLattice`; the
  settle counter is `_checkStability`; the recorders are `recordPropertyAccess`,
  `recordPrimitiveReceiver`, `recordUnaryOp`, `recordBinaryOp`, `recordBranch`,
  `recordReturnType`, `recordCallTarget`, `recordAllocationSite`, `recordIndexedAccess`,
  `recordArrayAccess`, `recordArrayLengthAccess`, `recordInlineDecision`. Read-side:
  `getMonomorphicMap`, `getMonomorphicOffset`, `getMonomorphicMapVersion`,
  `getMonomorphicProtoDepth`, `getPolymorphicMaps`, `getMonomorphicCallTargetRef`,
  `getPolymorphicCallTargets`, `getMonomorphicElementsKind`, `getBranchBias`,
  `hasOnlySmiReturns`, `hasOnlyNumberReturns`, `dominantPrimitiveReceiver`. Vector level:
  `fromCompiledFunction`, `initSlot`, `getSummaryStats`, `isSettled`,
  `getSlotsNeedingRefresh`, `decrementLoopBudget`, `incrementOsrUrgency`,
  `resetLoopBudget`, and the `serialize` / `deserialize` pair.
- `src/bytecode/register/ops/bytecode.ts` — `RegisterCompiledFunction.allocFeedbackSlot`
  (the whole allocator: `return this.feedbackSlotCount++`), `feedbackSlotCount`,
  `getICKey` and its `_icKeys` memo, and `disassemble` — the printer the reader will use to
  see slots on screen.
- `src/bytecode/register/compiler/expressions.ts` and
  `src/bytecode/register/compiler/functions.ts` — every `allocFeedbackSlot()` call site;
  `compileForInStatement` is the one that does not make one.
- `src/bytecode/register/interpreter/index.ts` — `RegisterInterpreter.initFeedbackVector`
  (the instruction-stream scan and its per-opcode-family operand positions),
  `recordCallFeedback`, `recordReturnFeedback`.
- `src/bytecode/register/interpreter/handlers.ts` — `recordPropertyFeedback`,
  `handleLdaProp`, `handleLdaIndex`, `getBinaryOperands`.
- `src/feedback/nexus/index.ts` — `FeedbackNexus` and the read-side hint types
  `BinaryOpHint` / `PropertyHint` / `ElementsHint` / `CallHint` / `BranchHint`;
  `typeFromFeedbackTag`, `observedBinaryType`, `isStableSlot`, and the hint constants
  `FEEDBACK_HINT_GENERIC` / `_MONOMORPHIC` / `_POLYMORPHIC` / `_MEGAMORPHIC`.
- `src/feedback/profile/index.ts` — `ExecutionProfile`: `recordExecution` (EMA with
  `EMA_ALPHA = 0.3`), `recordDeopt`, `recordLoopIterations`, `avgTimeMs`, `callFrequency`,
  `hotness`, `timeSinceLastDeopt`. The *other* profile — per-function timing, not
  per-site shape.
- `src/core/tracing/index.ts` — `tracer.feedbackRecord` and `tracer.feedbackTransition`.
- `src/optimizing/baseline/runtime.ts` — `BaselineRuntime.branch` and
  `_recordBinaryFb`, the second writer into the same vector ([Ch 36 § runtime-surface]).

## Worked example

`docs/example/stats.tera`. `Series.mean` is the target: four allocated slots, all
monomorphic, all reached from one shape.

```
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --trace-feedback docs/example/stats.tera
```

The first command shows the slots as trailing operands
(`LdaNamedProperty r4 [1] (values) r0`, `TestLessThan r3 r2`, `Add r2 r6`); the second
shows every lattice step the run makes.

> The example cannot reach stability. `STABILITY_SETTLE_THRESHOLD` is 50 and
> `Series.mean`'s loop runs nine times across both instances, so no slot in `stats.tera`
> ever sets `isStable`. The chapter states the settle rule from the code and pins it to
> `tests/feedback/vector.test.ts > "becomes stable after 50 records without transition"`
> rather than pretending the example demonstrates it.

## Outline

- [ ] **§ the-question-a-guess-answers** — Establish why an interpreter that already
  computes the right answer would spend cycles writing down *how* it computed it: the JIT
  never runs the program. Contrast in one paragraph with Part IX, where the AOT compiler
  answers the same question by proof. Sets up the book's guess-versus-prove spine.
- [ ] **§ slots-are-operands** — Establish that a feedback slot is not a side table: it is
  an integer operand appended to the instruction at bytecode-generation time by
  `allocFeedbackSlot`, whose entire body is `return this.feedbackSlotCount++`. Show three
  emission sites from `expressions.ts` and the resulting operand list in `--print-bytecode`
  output. Establish that slot numbering is therefore *emission order*, unrelated to
  program order.
- [ ] **§ reading-the-disassembly** — Establish how to read slots on screen, and the trap
  in doing so. `RegisterCompiledFunction.disassemble` special-cases only constant-pool
  operands; everything else falls through to `parts.push(\`r${op}\`)`, so a feedback slot
  *and a jump target* both print as `rN`. In `JumpIfFalse r32 r3`, `r32` is a bytecode
  offset and `r3` is a feedback slot; neither is a register. First honesty item.
- [ ] **§ typing-the-vector** — Establish `initFeedbackVector` as the second half of
  allocation: on first entry it walks `compiledFn.instructions` and, per opcode family,
  reads the slot index from a *fixed operand position* (2 for `LDA_PROP`/`STA_PROP`/
  `DEFINE_CLASS_MEMBER`, 1 for the twenty binary opcodes, 0 for the three unary ones, 3 for
  `CALL` and `CALL_METHOD`, 1 for the two conditional jumps) and calls `initSlot`. Establish
  that `initSlot` is create-if-null, so the *first* instruction to name an index fixes its
  kind. Establish the vector's size: `FeedbackVector.fromCompiledFunction` sets the loop
  budget to `3000 × instructions.length`, which [Ch 35 § budget] takes up.
- [ ] **§ the-lattice** — `> **New idea.**` primer on a lattice and a one-way transition,
  explicitly distinguished from the type lattice of [Ch 10]. Establish `LATTICE_ORDER` and
  that `_advanceLattice` compares orders and returns early when the new state is not
  higher: no path demotes a slot. Establish the consequence — warm-up noise is permanent —
  and that `reset()` / `resetSlot()` / `resetAll()` are the only escapes, used by
  deoptimization, not by ordinary execution.
- [ ] **§ what-each-recorder-stores** — Establish, one short subsection per recorder, the
  *shape* each one accumulates and how each reaches the lattice:
  `recordPropertyAccess` keys on hidden-class id with parallel `maps` / `mapVersions` /
  `offsets` / `protoDepths` arrays and a `_mapIndex` map; a repeat visit *updates in place*
  and never transitions. `recordBinaryOp` and `recordUnaryOp` route through
  `_recordTypeShape`, counting distinct `lhs|rhs` tag pairs. `recordCallTarget` keys
  targets by a `WeakMap`-assigned identity string, not by name, and drops `callTargetRef`
  the moment a second target appears. `recordArrayAccess` goes straight to megamorphic on
  a non-array receiver or a non-integer index. `recordBranch` is counts only — it never
  touches the lattice, which is why a branch slot shows no line in `--trace-feedback`.
- [ ] **§ four-is-the-limit** — Establish `MAX_POLYMORPHIC_ENTRIES = 4` as the vector's
  polymorphic ceiling, and flag forward that the inline cache's ceiling is *eight*
  ([Ch 34 § two-limits]). Two numbers, two files, no shared constant.
- [ ] **§ stability-and-the-decision-to-stop** — Establish `_checkStability`: 50
  transition-free records set `isStable`, and a transition resets `stableSinceCount` to 0.
  Establish that `isStable` is a *stop-recording* signal, honoured by
  `recordCallFeedback` (`if (!slot || slot.isStable) return`), `recordReturnFeedback` and
  `getBinaryOperands` — and **not** by the property path.
- [ ] **§ the-property-exception** — Establish that `handleLdaProp` calls
  `recordPropertyFeedback` unconditionally, with no `isStable` guard, so a settled property
  site keeps paying a `lookupProperty` on every access forever. Establish the reason the
  code gives — none; there is no comment — and what it would cost to close (the same
  three-line guard the call path uses, plus a decision about whether a stable site should
  still refresh `mapVersion`, which `recordPropertyAccess`'s in-place update currently
  does).
- [ ] **§ the-nexus** — Establish `FeedbackNexus` as the read-side boundary: the optimizer
  never touches a `FeedbackSlot` directly, it asks for a *hint*. Walk `property(index)`
  producing the four hint kinds, and `typeFromFeedbackTag` converting recorded tag strings
  into the middle end's `LatticeType`. Establish `isStableSlot`'s widening — a slot counts
  as stable if `isStable` **or** it is monomorphic with any records at all — which is a
  looser rule than the vector's own, and the one the optimizer actually uses.
- [ ] **§ two-writers-one-vector** — Establish that the interpreter is not the only
  recorder: `BaselineRuntime` writes into the same slots (`gp`, `sp`, `gi`, `si`,
  `_recordBinaryFb`, `rcn`, `invokeCall`), and `recordBranch` has *exactly one* caller
  anywhere — `BaselineRuntime.branch`. Establish the consequence: a function that reaches
  the JIT without ever running in baseline has no branch bias at all, and
  `hotSuccessorOf` in `src/optimizing/builder/ir-builder.ts` returns `null` for it.
- [ ] **§ the-slot-that-was-never-allocated** *(Why the obvious design fails)* — Establish
  the closing argument. `initFeedbackVector` reads `LDA_INDEX` / `STA_INDEX` slots as
  `operands[operands.length - 1]` — a *convention* ("the slot is last") rather than a
  position. `compileForInStatement` emits `ROP_LDA_INDEX` with two operands and no slot at
  all, so the convention reads a register number. Show the two-line proof:
  `functions.ts:1293` versus the five other `ROP_LDA_INDEX` emissions in `expressions.ts`.
  Establish both consequences and their asymmetry: the mistyped `initSlot` is prevented
  only by an unrelated bound check (`slotIndex < fv.slots.length`), while the *unconditional*
  damage is on the runtime side — `handleLdaIndex` falls back to `getICKey(funcName, 0)`
  when no slot is present, so every `for ... in` element load shares an inline-cache site
  with whatever real slot 0 is in that function. Land the general rule: an operand layout
  that is a convention rather than a table has no enforcement, and this is the argument for
  the effects/operand table of [Ch 41 § effects].

## Honesty items

- > **Broken.** `FeedbackSlot._advanceLattice` (`src/feedback/vector/index.ts`) passes a
  literal `0` as the slot id to `tracer.feedbackRecord(0, this.kind, …)`. Every
  `--trace-feedback` line therefore reads `Slot #0`, whichever slot moved. `FeedbackSlot`
  carries no index field, so the fix is either threading the index through every
  `_advanceLattice` call or storing it at `initSlot` time — a one-field change plus the
  eleven recorders that call it.
- > **Broken.** `RegisterCompiledFunction.disassemble`
  (`src/bytecode/register/ops/bytecode.ts`) prints jump targets and feedback slots as
  `rN`, i.e. as registers. Only `ROP_LDA_CONST`, `ROP_LDA_GLOBAL`, `ROP_STA_GLOBAL`,
  `ROP_CALL_INTRINSIC` and the name operand of the three property opcodes are
  special-cased; everything else falls through. Fixing it needs the per-opcode operand-kind
  table the tree does not have.
- > **Never runs.** `tracer.feedbackTransition` (`src/core/tracing/index.ts`) has no caller
  in `src/`, `tests/` or `tools/`. It duplicates the message `feedbackRecord` already
  prints — and would have printed the right slot id.
- > **Dead.** `getBinaryOperands` (`src/bytecode/register/interpreter/helpers.ts`) guards
  binary-op recording with `if (fv && !fv.saturated)`. `saturated` is an optional field on
  a *structural* type declared in that same file; `FeedbackVector` has no such property and
  nothing anywhere assigns it. The guard is always true. Either wire it to a real
  saturation rule or delete the field.
- > **Unfinished.** `FeedbackSlot.recordAllocationSite` accumulates `allocationSiteHCs`
  and `FEEDBACK_ALLOCATION` is exported as a kind, but `initFeedbackVector` never types a
  slot with it and `FeedbackNexus` exposes no allocation hint. Allocation-site feedback is
  collected and unread.
- > **Unfinished.** `FeedbackVector.getSlotsNeedingRefresh` and `getPolymorphicProfile`
  have no caller in `src/`. `getPolymorphicProfile` reads `slot.mapCounts`, a field
  declared optional on `FeedbackSlot` that no recorder ever writes, so it always reports an
  empty distribution.
- > **Unenforced.** Nothing checks that the operand position `initFeedbackVector` reads for
  an opcode matches the position the bytecode compiler emitted, or that every opcode that
  consumes a slot at run time was given one. `ROP_LDA_INDEX` from `compileForInStatement`
  is the live counter-example; see § the-slot-that-was-never-allocated. No test pins the
  correspondence. [unpinned]

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --trace-feedback docs/example/stats.tera
node dist/cli.js --stats docs/example/stats.tera
node dist/cli.js --trace-feedback docs/example/stats-poly.tera
npx vitest run --project unit tests/feedback/vector.test.ts
```

## Tests that pin this

- `tests/feedback/vector.test.ts > "transitions uninitialized -> monomorphic on first record"`
- `tests/feedback/vector.test.ts > "transitions monomorphic -> polymorphic on second class"`
- `tests/feedback/vector.test.ts > "transitions to megamorphic after >4 unique classes"`
- `tests/feedback/vector.test.ts > "updates version/offset for existing class without transition"`
- `tests/feedback/vector.test.ts > "cannot go backwards from polymorphic to monomorphic"`
- `tests/feedback/vector.test.ts > "becomes stable after 50 records without transition"`
- `tests/feedback/vector.test.ts > "resets stability on state transition"`
- `tests/feedback/vector.test.ts > "tracks protoDepth"`
- `tests/feedback/vector.test.ts > "megamorphic on non-array access"`
- `tests/feedback/vector.test.ts > "megamorphic on non-integer index"`
- `tests/feedback/vector.test.ts > "polymorphic with multiple targets"`
- `tests/feedback/vector.test.ts > "lazily initializes slots"`
- `tests/feedback/vector.test.ts > "does not overwrite existing slot"`
- `tests/feedback/vector.test.ts > "creates vector with correct slot count"`
- `tests/feedback/vector.test.ts > "reports the newest transition across every slot"`
- `tests/feedback/vector.test.ts > "true when stable with enough records"`
- `tests/optimizing/baseline/runtime.test.ts > "records a taken branch as taken"`
- `tests/optimizing/baseline/runtime.test.ts > "reports an evenly split branch as mixed"`
- `tests/optimizing/baseline/runtime.test.ts > "ignores an unallocated slot"`
- `tests/feedback/profile.test.ts > "computes EMA — first call sets directly, subsequent weighted"`
- `tests/feedback/profile.test.ts > "keeps circular buffer of recent times (max 32)"`
