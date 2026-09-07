# 35. Back edges: safepoints, budgets, and the tiering policy   ⟨I · B · J⟩

> **Status:** outline

**Thesis.** One hook does two unrelated jobs, and the loop budget is not an iteration
count: it is `3000 × bytecode length` drawn down by the back-jump distance, so what decides
when a loop goes hot is the *ratio* of function size to loop span.

**What arrived.** From [Ch 33 § typing-the-vector], a `FeedbackVector` whose `loopBudget`
and `loopBudgetSize` were both set to `INVOCATION_COUNT_FOR_OPTIMIZATION × instructions.length`
by `FeedbackVector.fromCompiledFunction`, and an `osrUrgency` at 0.

**What leaves.** A tier decision. Either the function keeps running interpreted, or
`compiledFn.baselineCode` is installed and `callMode` becomes `CALL_BASELINE`, or
`compiledFn.optimizedCode` is installed and `callMode` becomes `CALL_OPTIMIZED`, or
[Ch 37 § enter-osr] takes over mid-loop.

**New ideas.** *Safepoint* — a program point where the machine's state is well enough
described that a collector may run; *back edge* as the canonical safepoint in a loop;
*budget* versus *counter*; *tier* and *tier-up*; *cooldown* / *exponential backoff*.

**Length.** 12 pages

## Anchors

- `src/bytecode/register/interpreter/index.ts`
  - `RegisterInterpreter.onBackEdge` — the whole subject: a sweep tick
    (`(this._sweepTick = (this._sweepTick + 1) & 0xffff) === 0`) followed by a hotness
    poll (`feedback.decrementLoopBudget(Math.max(frame.pc - target, 1))`), then `enterOsr`.
  - `_maybeSweepHeapPayloads`, `_heapSweepThreshold`, and the module constants
    `MIN_HEAP_SWEEP_BYTES = 1 << 18` and `HEAP_SWEEP_GROWTH = 4`.
  - `runFrame` — the three call sites of `onBackEdge` (`ROP_JUMP`, `ROP_JUMP_IF_FALSE`,
    `ROP_JUMP_IF_TRUE`) and the `loopCounter` local.
  - `execute` — the function-entry half: `invocationCount`, `initFeedbackVector`, the
    `loopBudgetTriggered` read of `feedbackVector.loopBudgetExhausted`, the `shouldJIT`
    expression and its fallback when the policy has no `shouldOptimize`, the
    `resetLoopBudget` on tier-up, and the `baselineThreshold` branch below it.
  - `updateCallMode` and `CALL_GENERATOR` / `CALL_ASYNC` / `CALL_OPTIMIZED` /
    `CALL_BASELINE` / `CALL_INTERPRETED`; `callFunction`'s dispatch on `callMode`.
  - `requiresInterpreterOnly` (from `interpreter/helpers.ts`) — the veto that outranks
    every threshold.
- `src/runtime/tiering/defaults.ts` — `BACK_EDGES_PER_SAFEPOINT = 1024`,
  the `TieringThresholds` interface, the frozen `DEFAULT_TIERING_POLICY`
  (`baselineThreshold: 8`, `jitThreshold: 50`, `loopOsrThreshold: 30`, `maxDeoptCount: 3`,
  `feedbackSettleMs: 100`, `compileCooldownStepMs: 250`, `maxCompileCooldownMs: 5000`),
  and `compileCooldownUntil`.
- `src/runtime/tiering/policy.ts` — `createTieringPolicy`, `TieringPolicyOptions`, and the
  fact that the non-adaptive policy is a **frozen plain object with no methods**, which is
  why the interpreter has a `shouldOptimize ? … : …` fallback everywhere.
- `src/runtime/tiering/adaptive.ts` — `AdaptiveTieringPolicy` and its private constants
  `COOLDOWN_BASE_MS = 500`, `COOLDOWN_FACTOR = 4`, `MAX_CONSECUTIVE_DEOPTS = 10`,
  `OSR_URGENCY_MULTIPLIER = 0.1`, `MAX_COMPILE_FAILURES = 4`; the gate functions
  `feedbackHasSettled`, `hasStableFeedback`, `hasOSRReadyFeedback`, `hasOptimizedOSREntry`;
  and the methods `shouldOptimize`, `shouldBaselineCompile`, `shouldOSR`, `getOSRUrgency`,
  `recordDeopt`, `recordCompileFailure`, `recordCompileSuccess`, `getProfileStats`.
- `src/feedback/vector/index.ts` — `decrementLoopBudget`, `resetLoopBudget`,
  `incrementOsrUrgency`, `loopBudgetExhausted`, `osrUrgency`, `getSummaryStats`.
- `src/optimizing/baseline/compiler.ts` — `safepointBefore`, the emitted
  `if(++sp>=1024){sp=0;osr=$.backEdge(...);…}`, and hence the baseline's very different
  poll rate.
- `src/optimizing/baseline/runtime.ts` — `BaselineRuntime.backEdge`, which calls
  `_maybeSweepHeapPayloads()` *unconditionally* and decrements by
  `loopSpan * BACK_EDGES_PER_SAFEPOINT`.
- `src/cli/main.ts` — `buildTiering`: `--no-opt` sets `jitThreshold` and
  `loopOsrThreshold` to `Number.MAX_SAFE_INTEGER`; `--always-opt` sets
  `baselineThreshold: 2`, `jitThreshold: 3`, `loopOsrThreshold: 3`;
  `--opt-threshold`, `--baseline-threshold`, `--max-deopt` override individually;
  `--no-osr` sets `options.osr = false`.
- `src/cli/spec.ts` — the flag definitions those come from.

## Worked example

`docs/example/stats.tera` and `docs/example/stats-poly.tera`. The two functions the budget
formula separates are already in the file: `report` is 7 bytecodes and `mean` is 43.

```
node dist/cli.js --print-bytecode --filter report docs/example/stats.tera
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --baseline-threshold 1 --opt-threshold 2 --trace-opt docs/example/stats-poly.tera
```

The disassembly gives each function's instruction count, hence its budget
(`3000 × 7 = 21 000` against `3000 × 43 = 129 000`) and its loop span (`mean`'s back edge
at pc 31 jumps to pc 4, a span of 28). The third command walks `report` through
interpreter → baseline → optimized in one run and prints the reason line
`[JIT] Compiling "report": invocation count = 2`.

> The example cannot exhaust a budget. `Series.mean` iterates nine times in total against a
> budget of 129 000, so `loopBudgetExhausted` is never set in `stats.tera`. The chapter
> states the arithmetic from the constants and pins budget exhaustion to
> `tests/feedback/vector.test.ts > "returns true when budget exhausted"` and
> `tests/e2e/optimizing/osr.test.ts > "does not disturb loops that never reach the OSR budget"`.

## Outline

- [ ] **§ why-a-back-edge** — `> **New idea.**` primer on a safepoint, and the argument for
  why a back edge is the one in a purely interpreted loop. Establish that at a back edge
  the accumulator and every register are in the frame, no half-executed instruction is
  outstanding, and the pc is a real bytecode offset — the same three properties that make
  it the only place a frame can be *described* ([Ch 40 § frame-states]) and the only place
  it can be *replaced* ([Ch 37]). Establish that this is why one hook carries both jobs.
- [ ] **§ one-hook-two-jobs** — Walk `onBackEdge` line by line. Job one: increment
  `_sweepTick`, mask to 16 bits, and on wrap call `_maybeSweepHeapPayloads`, which itself
  early-returns unless `heapPayloadLiveBytesEstimate()` has passed `_heapSweepThreshold`
  and then re-arms the threshold to `max(1<<18, live × 4)`. Job two: the hotness poll.
  Establish that the two share nothing but the call site, and say plainly that this is a
  coupling of convenience — a collector tick and a compiler trigger are unrelated concerns
  that happen to want the same program point.
- [ ] **§ the-budget-is-not-a-counter** — Establish the arithmetic, which is the chapter's
  thesis. `loopBudgetSize = 3000 × instructions.length`. Each back edge subtracts
  `max(frame.pc - target, 1)` — the *span* of the back jump, in bytecodes, since `frame.pc`
  has already been advanced past the jump. So iterations-to-hot ≈
  `3000 × (instructions in the whole function) ÷ (bytecodes the loop spans)`. Establish the
  consequences and correct the intuition: a loop that *is* the whole function reaches the
  threshold in roughly 3000 iterations regardless of how fat it is; a small loop buried in
  a large function takes far longer. Fatness alone does not accelerate tier-up — the
  loop's *share* of the function does. Work both numbers for `report` and `mean`.
- [ ] **§ sticky-and-two-strikes** — Establish `decrementLoopBudget`'s two effects: it
  returns `true` exactly once per budget, *and* it sets `loopBudgetExhausted`, which
  nothing but `resetLoopBudget` clears. So the flag is read twice by two different
  deciders — immediately by `onBackEdge` to attempt OSR, and later at the next function
  *entry* by `execute`, where `loopBudgetTriggered` is an alternative to
  `invocationCount >= jitThreshold`. A loop that got hot but could not be entered on stack
  still causes the whole function to be optimized on its next call. Then establish
  `osrUrgency` as a two-strikes rule: `enterOsr` returns `null` and bumps urgency the first
  time it is asked, and only tries on a later ask ([Ch 37 § enter-osr]).
- [ ] **§ callmode** — Establish `updateCallMode` as the cached dispatch decision: five
  constants, checked in a fixed order in which `isGenerator` and `isAsync` outrank any
  compiled code, so a coroutine is never dispatched to baseline or optimized code even if
  it somehow has some. Establish where `callMode` is *recomputed* (after every successful
  compile, and lazily when `undefined`) and where it is *trusted* (`callFunction`'s
  fast path), and that a stale `CALL_OPTIMIZED` with a null `optimizedCode` is handled by
  re-running `updateCallMode` rather than by an assertion.
- [ ] **§ the-two-policies** — Establish that `createTieringPolicy` returns one of two
  unrelated things: a frozen record of numbers, or an `AdaptiveTieringPolicy` object with
  methods. Establish that every call site therefore reads
  `policy.shouldOptimize ? policy.shouldOptimize(fn) : <inline threshold expression>`, so
  the *default* engine runs the inline expression and the adaptive policy's gates never
  apply unless someone asks for `mode: "adaptive"`. Name the duplication: the fallback
  expression and `AdaptiveTieringPolicy.shouldOptimize` are two independent statements of
  the same rule, and they already differ (the fallback has no feedback gate).
- [ ] **§ the-adaptive-gates** — Establish `shouldOptimize`'s six refusals in order:
  already optimized; optimization disabled; inside a cooldown; four or more compile
  failures; *deopted before and feedback has not settled for `feedbackSettleMs`*; *deopted
  before and feedback is not stable*; ten consecutive deopts for the same reason; below
  `jitThreshold`; and finally `hasStableFeedback` unconditionally. Establish
  `hasStableFeedback`'s definition — no megamorphic slots, and every initialized slot
  either stable or monomorphic — and that an *uninitialized* vector passes, so a function
  that has never recorded anything is treated as stable.
- [ ] **§ the-cooldown** — `> **New idea.**` primer on exponential backoff. Establish
  `recordDeopt`: `500 × 4^min(deoptCount-1, 5)` milliseconds, capped by the exponent at
  ~512 s, and that it also nulls `optimizedCode` — the policy is the thing that
  *deoptimizes*, not just the thing that decides. Contrast with the unrelated
  `compileCooldownUntil` in `defaults.ts`, a linear `250 × failures` capped at 5 s, which
  exists for compile failures rather than deopts.
- [ ] **§ why-not-one** — Establish why `--always-opt` uses `baselineThreshold: 2`,
  `jitThreshold: 3` and not 1. At 1 the very first call would tier up before any
  instruction has executed, so the vector would be entirely uninitialized, every
  `FeedbackNexus` hint would be `generic`, and the "optimizing" compiler would emit
  fully generic code — the flag would test the pipeline while destroying the thing it is
  meant to exercise. Two and three give one interpreted call to fill the vector and one
  baseline call to fill the branch bias ([Ch 33 § two-writers-one-vector]) before the JIT
  reads either. Demonstrate with the two `--trace-opt` runs in § worked-example.
- [ ] **§ the-baseline-polls-differently** — Establish the second half of the thesis'
  first clause. The baseline emits `if(++sp>=1024){sp=0; osr=$.backEdge(...);}`, so it
  reaches `BaselineRuntime.backEdge` once per 1024 back edges — and `backEdge` then sweeps
  **unconditionally** and decrements by `loopSpan × 1024`. Two consequences to establish:
  the *budget* draw-down rate is identical to the interpreter's, deliberately; the *sweep*
  rate is not — the interpreter reaches `_maybeSweepHeapPayloads` once per 65 536 back
  edges and the baseline once per 1024, a factor of 64. Nothing in the tree explains the
  gap, and no test pins either number.
- [ ] **§ the-thresholds-that-decide-nothing** — Establish the honesty items below in place
  rather than as an appendix, because two of them change how the reader should read the
  defaults table: `loopOsrThreshold: 30` is in the frozen defaults, is settable from the
  CLI, and decides nothing.

## Honesty items

- > **Dead.** The `loopOsrThreshold` arm of `RegisterInterpreter.onBackEdge`
  (`src/bytecode/register/interpreter/index.ts`) — `policy ? loopCounter ===
  policy.loopOsrThreshold : false` — is reached only when `compiledFn.feedbackVector` is
  null. `execute` calls `initFeedbackVector` before creating any frame, and so do the
  generator, async and closure entry paths, so the vector is always present by the time
  `runFrame` takes a back edge. The threshold is exposed by `--always-opt` and `--no-opt`
  and has no effect through this path. [unpinned]
- > **Never runs.** `AdaptiveTieringPolicy.shouldOSR` (`src/runtime/tiering/adaptive.ts`)
  is implemented, has a declared slot on the interpreter's policy interface
  (`interpreter/index.ts:198`), is unit-tested, and is called from nowhere in `src/`.
  `onBackEdge` decides OSR from the loop budget alone and never consults the policy.
  `getOSRUrgency`, `hasOSRReadyFeedback` and `hasOptimizedOSREntry` exist only to serve it.
- > **Never runs.** `AdaptiveTieringPolicy.shouldBaselineCompile` has no caller in `src/`;
  both the interpreter's entry path and `callFunction` inline the
  `invocationCount >= baselineThreshold` comparison instead.
- > **Never runs.** `AdaptiveTieringPolicy.getProfileStats` — nine computed fields
  including `feedbackSettled`, `feedbackStable`, `osrFeedbackReady` and `osrEntryReady` —
  has no caller in `src/`. `--stats` does not surface it.
- > **Unfinished.** `compileCooldownUntil` (`src/runtime/tiering/defaults.ts`) and the two
  thresholds it reads (`compileCooldownStepMs`, `maxCompileCooldownMs`) are exported and
  reachable, but `AdaptiveTieringPolicy.recordCompileFailure` sets a counter without ever
  calling it; the actual cooldown on the deopt path uses the *other*, private constants
  (`COOLDOWN_BASE_MS`, `COOLDOWN_FACTOR`). Two backoff schemes, one wired.
- > **Unenforced.** No test or assertion pins the relationship between
  `BACK_EDGES_PER_SAFEPOINT` (1024, the baseline's poll period and its budget multiplier)
  and the interpreter's `0xffff` sweep mask. They are separate literals in separate files
  that must agree for the two tiers to draw down the same budget at the same rate, and
  nothing checks that they do. [unpinned]

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter report docs/example/stats.tera
node dist/cli.js --baseline-threshold 1 --opt-threshold 2 --trace-opt docs/example/stats-poly.tera
node dist/cli.js --always-opt --trace-opt docs/example/stats-poly.tera
node dist/cli.js --no-opt --trace-opt docs/example/stats-poly.tera
npx vitest run --project unit tests/runtime/tiering/adaptive.test.ts
npx vitest run --project e2e tests/e2e/gc/heap-payload-sweep.test.ts
```

## Tests that pin this

- `tests/feedback/vector.test.ts > "decrements and returns false while positive"`
- `tests/feedback/vector.test.ts > "returns true when budget exhausted"`
- `tests/feedback/vector.test.ts > "only fires exhaustion once"`
- `tests/feedback/vector.test.ts > "resetLoopBudget restores budget"`
- `tests/feedback/vector.test.ts > "creates vector with correct slot count"`
- `tests/runtime/tiering/adaptive.test.ts > "returns false when invocation count below jitThreshold"`
- `tests/runtime/tiering/adaptive.test.ts > "returns true when invocation count meets threshold"`
- `tests/runtime/tiering/adaptive.test.ts > "returns false during cooldown period"`
- `tests/runtime/tiering/adaptive.test.ts > "returns false after too many compile failures"`
- `tests/runtime/tiering/adaptive.test.ts > "compile success resets failure count"`
- `tests/runtime/tiering/adaptive.test.ts > "recordDeopt clears optimizedCode and sets cooldown"`
- `tests/runtime/tiering/adaptive.test.ts > "multiple deopts increase cooldown exponentially"`
- `tests/runtime/tiering/adaptive.test.ts > "declines while a slot changed shape inside the settle window"`
- `tests/runtime/tiering/adaptive.test.ts > "allows once the settle window has passed"`
- `tests/runtime/tiering/adaptive.test.ts > "ignores the settle window for a function that has never deopted"`
- `tests/runtime/tiering/adaptive.test.ts > "shouldOSR returns false without optimized OSR entry"` —
  the *only* exercise `shouldOSR` gets, and the reason its honesty item can be stated as fact.
- `tests/runtime/tiering/adaptive.test.ts > "returns frozen defaults with no args"`
- `tests/runtime/tiering/adaptive.test.ts > "takes every unset threshold from DEFAULT_TIERING_POLICY"`
- `tests/runtime/tiering/adaptive.test.ts > "honours a threshold of zero instead of falling back to a default"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the boxed-primitive slab bounded under a double-heavy loop"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the slab bounded once the loop runs in baseline-compiled code"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "still reaches a safepoint when the back edge is a conditional jump"`
- `tests/e2e/optimizing/osr.test.ts > "does not disturb loops that never reach the OSR budget"`
