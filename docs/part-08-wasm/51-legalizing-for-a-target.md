# 51. Legalizing for a target   ⟨ J · N ⟩

> **Status:** outline

**Thesis.** Forty-one more passes, and most of them are not optimizations at all —
they are where a dynamic language stops being dynamic.

**What arrived.** One optimized `CFGFunction` in canonical-phi SSA from Part VII:
typed by `typeInferenceAnalysisId`, with `frameState` edges on every node that can
bail out, and no idea which of four code generators is about to read it.

**What leaves.** The same `CFGFunction`, now *legal for one named `TargetModel`*:
every surface construct rewritten into nodes that target admits, representations
stamped (`_rep`) if the target has tagged values and absent if it does not, frame
states kept or stripped, and `capabilityCheck` having either passed or thrown a
`BackendLoweringError` whose message is the refusal sentence.

**New ideas.** *Legalization* (as distinct from optimization); *capability* as a
target-model predicate that changes which passes exist; *fixpoint over a set of
rewrites* (`untilStable`); *if-conversion* and the branchless `select`;
*cost model* / *budget*; *pass-ordering constraint*.

**Length.** 14 pages

## Anchors

- `src/optimizing/target/legalization.ts` — `targetLegalizationPipeline(target, options)`,
  the single 41-entry array both drivers run; `untilStable`; the const-hoisted
  `representationSelectionPass` and `representationCheckPass`; the three
  `...(tagged ? [] : [ ... ])` splices; `preservesControlFlow`;
  `SPLIT_LOWERINGS`, `HEAP_ITERATION_LOWERINGS`.
- `src/optimizing/target/capabilities.ts` — the `Capability` union (ten names) and
  `capabilitySet`. This file is 17 lines and decides the shape of the pipeline.
- `src/optimizing/backends/wasm/target.ts` — `wasmTarget`: `capabilitySet("deopt",
  "osr", "tagged-values", "float-text")`, `speculation: deoptToInterpreter`.
- `src/optimizing/backends/c/target.ts` — `cTarget`: seven capabilities, none of them
  `deopt` or `tagged-values`, `speculation: proveOrGeneric`.
- `src/optimizing/passes/if-conversion.ts` — `ifConversion`, `valuesTargetSelects`,
  `SELECTED_BY` (`SCALAR_INT32 → "select-integer"`, `SCALAR_FLOAT64 → "select-float"`),
  `diamondAt`, `armOf`, `speculatable`, `STEP_COST = 1`, `ROUTINE_COST = 16`,
  `THROUGH_A_ROUTINE`, `convert`, `scheduleBeforeChoice`.
- `src/optimizing/passes/operation-legalization.ts` — `legalizeOperations`,
  `expandSelect`, `EXPANSIONS` (one entry, `IR_SELECT`), `ValueLegality`,
  `illegalIn`, and the first line of the pass: `const legal = graph.emits; if (legal
  === null) return 0;`.
- `src/optimizing/passes/speculation-lowering.ts` — `speculationLowering`,
  `STRATEGIES` keyed by `SpeculationKind`, `proveOrGeneric`, `DESPECIALIZE`,
  `GENERIC_LOWERINGS`, `isProven` (`node.props.noOverflow === true`),
  `NUMERIC_OR_UNKNOWN`.
- `src/optimizing/passes/frame-state-elision.ts` — `elideFrameStates`: 18 lines,
  returns 0 immediately if the target has `deopt`, otherwise nulls every
  `node.frameState`.
- `src/optimizing/passes/capability-check.ts` — `capabilityCheck`,
  `UnsupportedSpeculationError`, `deoptimizesOnItsOwn`, `throwsOutOfTheProgram`,
  `rendersFloatText`.
- `src/optimizing/target/errors.ts` — `BackendLoweringError`, `isBackendLoweringError`.
- `src/optimizing/target/jit.ts` — `CompileRejection`, `RejectionKind`
  (`"unsupported" | "speculation" | "malformed"`).
- `src/optimizing/prelude/index.ts` — `SOURCE_PRELUDES`, `sourcePreludes`,
  `adoptSourcePreludes`, `LOWERED_PRELUDE_FUNCTIONS`; and `src/api/engine.ts:1407`
  `const prelude = aot ? preludeFor(built) : ""`, which is why the prelude pattern is
  an AOT fact and not a JIT one.
- `src/optimizing/passes/collection-surface.ts`, `string-split.ts`,
  `iterator-lowering.ts`, `generator-iteration.ts`, `promise-surface.ts`,
  `json-surface.ts`, `print-expansion.ts`, `math-surface.ts`, `array-methods.ts`,
  `text-method-calls.ts` — the surface tour.
- `tests/optimizing/pipeline-order.test.ts` — `passNamesFor`, `loweringDeltasByPass`,
  the `describe("legalization phase order")` block.
- `tests/optimizing/target/legalization.test.ts` — the four capability/select cases.

## Worked example

The ordering constraint *"splits strings before it shapes the collections a split
fills"*, expressed as an executable claim rather than a comment:

```bash
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts
```

Then break it deliberately: in `targetLegalizationPipeline`, move the
`"string-split-lowering"` entry after `"collection-surface"`, re-run, and read the
failure. The book shows the assertion, not a paragraph:

```ts
expect(at("string-split-lowering")).toBeLessThan(at("collection-surface"));
```

— tests/optimizing/pipeline-order.test.ts:251-254

## Outline

- [ ] **§ the-second-pipeline** — Establish that there are *two* pass lists, not one:
      `middleEndPhases` (Part VII, target-neutral) and `targetLegalizationPipeline`
      (here, target-bound). Both are `TransformPass<CFGFunction>` arrays run by the
      same `PassManager`; the only difference is that this one takes a `TargetModel`.
      Show `WasmBackend.loweringPipeline()` and note that the AOT driver calls the
      identical function. **`> **New idea.** Legalization** — a rewrite whose job is
      not to make the program faster but to make it *expressible*.
- [ ] **§ capabilities-decide-which-passes-exist** — The ten-name `Capability` union.
      Establish that a capability is checked in three different places and does three
      different things: (a) `tagged` splices three passes in or out of the array
      (`zero-divisor`, `parse-number-surface`, `builtin-domains` for untagged;
      `representation-selection` + `representation-check` for tagged); (b) `deopt`
      makes `elideFrameStates` a no-op or a scythe; (c) `select-integer` /
      `select-float` are asked per *value*, not per target. Give the count honestly:
      **41 passes for a target without tagged values, 40 for `wasmTarget`** — the
      forty-one in the thesis is the native number.
      `[t: tests/optimizing/pipeline-order.test.ts > "selects representations only for
      targets that have tagged values"]`
- [ ] **§ surface-lowering-tour** — Walk the surface passes in pipeline order, one
      paragraph each, naming the exported function: `lowerIterators`,
      `lowerStringSplit`, `lowerCollectionSurface`, `lowerMathSurface`,
      `lowerGlobalBuiltins`, `lowerJsonSurface`, `lowerObjectSurface`,
      `lowerGeneratorIteration`, `lowerClassMembers`, `lowerElementMembers`,
      `lowerTextMethodCalls`, `lowerArrayMethods`, `lowerBuiltinMethods`,
      `lowerArrayAccess`, `expandAggregatePrints`, `lowerPrintedText`,
      `joinTextConcatenations`, `coerceStringOperands`, `lowerNamedArguments`. Establish
      the shared shape: each finds a generic node, proves something from
      `TypeInference`, and replaces it with nodes the backend has a case for.
      `[t: tests/optimizing/passes/math-surface.test.ts > "leaves no generic Math call
      for a backend to refuse"]`
      `[t: tests/optimizing/passes/string-split.test.ts > "leaves no generic call for a
      backend to refuse"]`
- [ ] **§ lowering-to-tera-not-to-c** — The recurring answer to "where does the
      implementation live?": not in the backend, but in tera source assembled by
      `sourcePreludes` and adopted by `adoptSourcePreludes`. Show `SOURCE_PRELUDES`
      (four entries) and `LOWERED_PRELUDE_FUNCTIONS`. **Then state the limit
      immediately:** `src/api/engine.ts:1407` reads `aot ? preludeFor(built) : ""`, so
      the prelude is an *ahead-of-time* mechanism. On `wasmTarget` the same passes run,
      the prelude callees do not exist, and the work that would have gone to a prelude
      function stays a generic node — which chapter 53 turns into a runtime stub.
      This is the cleanest statement in the book of why the two backends diverge in
      cost rather than in meaning.
- [ ] **§ untilstable** — Why two entries in this list are fixpoints and the rest are
      not. `untilStable(graph, analyses, lowerings)` loops until a whole round moves
      nothing, invalidating `typeInferenceAnalysisId` after any lowering that changed
      the graph. `SPLIT_LOWERINGS = [lowerStringSplit]` (one element — a split can
      produce a split). `HEAP_ITERATION_LOWERINGS = [stampElementTypes,
      lowerStringSplit, lowerIterators]` (three that feed each other).
      **`> **New idea.** Fixpoint** — run until nothing changes, and why "nothing
      changes" is a safe stopping rule only when each rewrite strictly consumes
      something. `[t: tests/optimizing/pipeline-order.test.ts > "runs the split lowering
      to a fixpoint rather than once"]`
- [ ] **§ speculation-lowering-three-strategies** — `STRATEGIES` is a three-entry map
      keyed by `target.speculation.kind`. Establish what each does and that the choice
      is a target property, not a flag:
      `"deopt-to-interpreter"` → `() => 0`, literally nothing (wasm keeps its guards
      because it has somewhere to bail out to);
      `"guard-with-slowpath"` → `proveOrGeneric(..., false)` (drop base guards,
      de-specialize unproven int32 arithmetic to float64);
      `"prove-or-generic"` → `proveOrGeneric(..., true)` (also drop native guards, also
      rewrite every `IR_GENERIC_*` arithmetic node whose inputs are in
      `NUMERIC_OR_UNKNOWN`, also resolve `IR_GENERIC_CALL` to `irCallKnownFunction`).
      Land the point: `isProven` is one field read, `node.props.noOverflow === true`,
      and everything the middle end proved in Part VII is cashed here.
- [ ] **§ frame-state-elision** — Eighteen lines that delete the entire deopt
      machinery from a graph. `elideFrameStates` returns 0 the moment
      `target.capabilities.has("deopt")`. For a native target it nulls every
      `frameState` — which is exactly why chapter 49's rule ("speculative types are not
      facts") is load-bearing: after this pass a `CheckSmi` has no snapshot to bail out
      with, and the following `capabilityCheck` will refuse the function if one is left.
      Note the pass declares `preserves: { kind: "all" }`, which is true of control flow
      and false of everything a later pass might want to know about liveness.
      `> **Unenforced.**` — nothing verifies that a graph with `deopt` absent contains
      no `frameState` before `capabilityCheck` runs; the check *is* the verification, and
      it runs 3 passes later.
- [ ] **§ if-conversion-under-a-budget** — The pass that turns a diamond into
      straight-line code. Establish: `diamondAt` recognises the shape (including a
      triangle whose else-arm is the join); `armOf` refuses any arm holding a node that
      is not `speculatable` (`isMovable && isEffectFree && !canDeoptimize &&
      frameState === null`) — because both arms will now run *unconditionally*;
      `speculationCost` charges `ROUTINE_COST = 16` for the four opcodes in
      `THROUGH_A_ROUTINE` and `STEP_COST = 1` for everything else;
      `options.ifConversionBudget` is the ceiling. **`> **New idea.** Cost model** — a
      pass that can make code slower needs a number, not a rule. Note the pass emits
      real English through `remarks.missed` naming the block and the two numbers.
      `[t: tests/optimizing/passes/if-conversion.test.ts > "refuses an arm that costs
      more than the budget"]`
      `[t: tests/optimizing/passes/if-conversion.test.ts > "refuses an arm that reads
      memory, which the untaken path never would"]`
- [ ] **§ select-twice-illegal** — *Why the obvious design fails.* The obvious design
      is one legality question: "can the target emit `IR_SELECT`?" The code asks it
      twice, differently, and the reader should see why. `valuesTargetSelects(target,
      types)` maps the *value's* `AotScalar` through `SELECTED_BY` to a capability — so
      x64 (which has `select-integer` but not `select-float`) selects an integer phi
      and refuses a float one, in the same function. `legalizeOperations` then asks a
      *second* question against `graph.emits`, the opcode set the chosen backend
      actually implements, and expands what is left via `expandSelect` into
      head→branch→two jumps→join with a fresh phi. Two reasons, two mechanisms, one
      opcode.
      `[t: tests/optimizing/target/legalization.test.ts > "expands a float select on a
      target that selects only integers"]`
      `[t: tests/optimizing/passes/operation-legalization.test.ts > "rewrites a select
      the target cannot emit into a branch over a phi"]`
- [ ] **§ neither-fires-on-wasm** — The honest close to the previous section, and the
      one place this chapter's material contradicts its own tidy story. `wasmTarget`
      has neither `select-integer` nor `select-float`, so `ifConversion` never converts
      a diamond on the JIT path. `graph.emits` is assigned in exactly one place —
      `src/optimizing/drivers/aot.ts:769` — so on the JIT path it is `null` and
      `legalizeOperations` returns 0 on its first line. Both Select-shaped passes are
      inert for wasm. Meanwhile `lowerMathSurface` still *produces* an `IR_SELECT` for
      `Math.sign`, and `IR_SELECT` is not in `SUPPORTED_GRAPH_NODES`, so the graph is
      refused at the backend with `block 0 instruction 16 Select is not supported by
      wasm backend`. Show the trace line. See § honesty-items.
- [ ] **§ the-final-check** — `capabilityCheck` as the pipeline's last word. Three
      predicates, three refusals, all `BackendLoweringError`:
      `deoptimizesOnItsOwn` → `UnsupportedSpeculationError("target native64 cannot
      deoptimize but CheckSmi requires a frame state")`;
      `throwsOutOfTheProgram` → `target ${name} cannot lower ${THROW_BUILTIN}`;
      `rendersFloatText` → `target ${name} cannot lower ${AOT_FLOAT_TO_STRING}`.
      Note the early return on line 39: a target with all three capabilities never walks
      the graph at all, so this pass costs nothing on `wasmTarget`… except `wasmTarget`
      lacks `terminating-throw`, so it *does* walk.
- [ ] **§ order-as-executable-claim** — Close on the mechanism this chapter is really
      about. The engine has a hard no-comment rule, so the pipeline's ordering
      constraints are written as assertions in `tests/optimizing/pipeline-order.test.ts`
      using `passNamesFor(cTarget).indexOf(name)`. List all five constraints by their
      verbatim titles. Establish the general rule: *an ordering constraint that is only
      a comment is not a constraint.*
- [ ] **§ refusal-is-an-outcome** — `CompileRejection` has three `RejectionKind`s and
      they are not severities, they are *audiences*. `WasmBackend.legalize` catches
      `BackendLoweringError` and returns `{ kind: "unsupported", reason: error.message }`,
      which the JIT swallows into a trace line and a fallback. The AOT driver prints the
      same sentence to the user. Same error object, two readers. Hand over to chapter 52
      (what the wasm backend does when it does *not* refuse) and forward-reference
      [Ch 56 § refusing-well].

## Honesty items

- `> **Never runs.**` — `legalizeOperations` in
  `src/optimizing/passes/operation-legalization.ts` is a member of
  `targetLegalizationPipeline` for every target, but its first two lines are
  `const legal = graph.emits; if (legal === null) return 0;`, and `graph.emits` is
  assigned in exactly one place, `src/optimizing/drivers/aot.ts:769`. On the JIT path
  it is `null`. The pass and its only expansion, `expandSelect`, never execute for
  `wasmTarget`. Cost to finish: give `WasmBackend` an `emits` set (it has none) and
  assign it in `WasmBackend.jitCompile` the way the AOT driver does — plus the
  `IR_SELECT` handling `expandSelect` would then make unnecessary.
- `> **Dead.**` — `OP_SELECT = 0x1b` in
  `src/optimizing/backends/wasm/wasm-format.ts:87`. The wasm select opcode is
  defined and never referenced anywhere in `src/optimizing/backends/wasm/`. Cost to
  use it: add `IR_SELECT` to `SUPPORTED_GRAPH_NODES` and one case to `emitNode`
  (~15 lines), which would also make `ifConversion` worth enabling on wasm.
- `> **Never runs.**` — `ifConversion` is in the wasm pipeline but cannot convert
  anything there. `valuesTargetSelects` returns true only when the value's scalar
  maps through `SELECTED_BY` to a capability the target holds, and `wasmTarget`
  (`src/optimizing/backends/wasm/target.ts`) holds neither `select-integer` nor
  `select-float`, so every candidate phi hits the `unselectable` branch. Cost:
  the same ~15 lines as above, plus the `remarks` output to re-read.
- `> **Broken.**` — `lowerMathSurface` (`src/optimizing/passes/math-surface.ts:106-107`)
  emits two `irSelect` nodes for `Math.sign`, and `IR_SELECT` is not in
  `SUPPORTED_GRAPH_NODES` (`src/optimizing/backends/wasm/graph-support.ts:207`). A
  function calling `Math.sign` is therefore *always* refused by the JIT —
  `Wasm: graph not compilable: block 0 instruction 16 Select is not supported by wasm
  backend` — while compiling cleanly ahead of time. Not a wrong answer, but a
  permanent, silent tiering hole in a builtin. Cost: identical to the `OP_SELECT`
  item; it is the same fix three times.
- `> **Unenforced.**` — the pipeline's ordering constraints live only in
  `tests/optimizing/pipeline-order.test.ts`. Five orderings are asserted; the array in
  `targetLegalizationPipeline` has 41 entries and roughly a dozen real dependencies.
  Nothing in `src/` checks that `speculation-lowering` precedes
  `class-member-lowering`, or that `frame-state-elision` precedes `capability-check`.
  Cost: a declared `after: [...]` field on `TransformPass` plus a topological check in
  `PassManager` — a real design change, not a patch.
- `> **Unfinished.**` — `EXPANSIONS` in `operation-legalization.ts` has exactly one
  entry. The pass is written as a general opcode-expansion framework
  (`OperationExpansion`, a worklist over blocks, re-queuing the block after each
  rewrite) and carries one rewrite. Cost to finish: nothing is missing — but the
  generality is currently unpaid for, and the chapter should say so once.

## Verify it yourself

```bash
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts
npx vitest run --project unit tests/optimizing/target/legalization.test.ts
node dist/cli.js targets
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 -e 'fn s(x):
  return Math.sign(x) + 1
fn driver(n):
  t = 0
  k = 0
  while k < n:
    t = s(k - 5)
    k += 1
  return t
print(driver(50))' 2>&1 | grep -i "Select\|not compilable"
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe
```

## Tests that pin this

- `tests/optimizing/pipeline-order.test.ts` > `"splits strings before it shapes the collections a split fills"`
- `tests/optimizing/pipeline-order.test.ts` > `"settles types again after it learns what a generator yields"`
- `tests/optimizing/pipeline-order.test.ts` > `"hands a fractional remainder over only after types say which one it is"`
- `tests/optimizing/pipeline-order.test.ts` > `"leaves a whole remainder by zero to fault before it rewrites any remainder"`
- `tests/optimizing/pipeline-order.test.ts` > `"runs the split lowering to a fixpoint rather than once"`
- `tests/optimizing/pipeline-order.test.ts` > `"selects representations only for targets that have tagged values"`
- `tests/optimizing/pipeline-order.test.ts` > `"leaves no boxing ceremony for an untagged target to strip"`
- `tests/optimizing/pipeline-order.test.ts` > `"gives every surviving node a representation once wasm lowering finishes"`
- `tests/optimizing/pipeline-order.test.ts` > `"never grows the graph after representation selection"`
- `tests/optimizing/target/legalization.test.ts` > `"expands a float select on a target that selects only integers"`
- `tests/optimizing/target/legalization.test.ts` > `"keeps an integer select on that same target"`
- `tests/optimizing/target/legalization.test.ts` > `"keeps a float select on a target that selects floats too"`
- `tests/optimizing/target/legalization.test.ts` > `"expands an integer select on a target that selects neither"`
- `tests/optimizing/passes/operation-legalization.test.ts` > `"rewrites a select the target cannot emit into a branch over a phi"`
- `tests/optimizing/passes/operation-legalization.test.ts` > `"does nothing when no target has named its opcodes"`
- `tests/optimizing/passes/operation-legalization.test.ts` > `"keeps the graph well formed and every node id its own"`
- `tests/optimizing/passes/if-conversion.test.ts` > `"replaces a diamond's phi with one select in the head"`
- `tests/optimizing/passes/if-conversion.test.ts` > `"refuses a merged value the target cannot select"`
- `tests/optimizing/passes/if-conversion.test.ts` > `"refuses an arm that costs more than the budget"`
- `tests/optimizing/passes/if-conversion.test.ts` > `"refuses an arm that reads memory, which the untaken path never would"`
- `tests/optimizing/passes/if-conversion.test.ts` > `"refuses an arm whose arithmetic can still overflow into a deopt"`
- `tests/optimizing/passes/if-conversion.test.ts` > `"does nothing when the budget is zero"`
- `tests/optimizing/passes/math-surface.test.ts` > `"leaves no generic Math call for a backend to refuse"`
- `tests/optimizing/passes/math-surface.test.ts` > `"answers one, minus one, or the value itself so zero and NaN survive"`
- `tests/optimizing/passes/string-split.test.ts` > `"leaves no generic call for a backend to refuse"`
- `tests/optimizing/passes/collection-surface.test.ts` > `"leaves no iterator reading the collection itself"`
- `tests/optimizing/passes/print-expansion.test.ts` > `"tests the reference before reading any field off it"`
- `tests/optimizing/passes/iterator-lowering.test.ts` > `"drops every operand of the range call it removed, not only the callee"`
- `speculationLowering`, `elideFrameStates` and `capabilityCheck` — **[unpinned]**.
  No test file under `tests/` references any of the three by name; they are exercised
  only transitively through `lower(graph, target)` in `pipeline-order.test.ts` and
  through the e2e AOT suites.
