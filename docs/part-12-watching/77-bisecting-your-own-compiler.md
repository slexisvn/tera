# 77. Bisecting Your Own Compiler   ⟨I · B · **J** · **N**⟩

> **Status:** outline

**Thesis.** When a program's answer changes and thirty passes ran, you want `git bisect`
over the pipeline — which costs seventeen lines in the pass manager and one choice of
oracle per backend.

**What arrived.** From [Ch 76]: an instrumented middle end. `CompilerOptions.passTracer`
delivers one `PassTraceRecord<CFGFunction>` per pass — `ordinal`, `pass`, `changed`,
`skipped`, `elapsedMs`, node counts, `requires`, `invalidated`, `remarks`, `verification`
and the live `graph` — and the visualizer has already shown that a recording of the
optimizer is a linear, replayable sequence of stages with an identity-keyed diff between
neighbours. That sequence is what this chapter searches.

**What leaves.** The `verification: readonly string[]` field on that same record, and the
`GraphVerification<G>` hook on `PassManager` that fills it — a pass that broke an invariant
is traced *carrying the broken graph* and only then throws `VerificationError`. Chapter 78
takes that hook and asks what the checks behind it actually check.

**New ideas.**

- `> **New idea.** Bisection over a pipeline.` `git bisect` finds the first bad commit in a
  history by halving. A compiler has a history too: pass #1, pass #2, … pass #n on one
  function. If passes 1..k give the right answer and 1..k+1 give the wrong one, pass k+1 is
  the suspect. Same search, same log₂(n) cost.
- `> **New idea.** An oracle.` A bisect needs a yes/no question it can ask about a build.
  "Is this right?" is not answerable; "does this differ from a reference we trust?" is.
  That reference is the oracle, and it is *different for each backend* — which is the
  chapter's second half.
- `> **New idea.** Monotonicity as an unstated assumption.` Binary search is only valid if
  the predicate flips once. Nothing in this tree enforces that.

**Length.** 10 pages

## Anchors

- `src/optimizing/infra/opt-bisect.ts` — the whole file is 17 lines. `OptBisect`, a private
  `attempted` counter, `constructor(private readonly limit: number)`,
  `static unlimited()` (`new OptBisect(Number.POSITIVE_INFINITY)`), `get attempts()`, and
  `allow(): boolean { return ++this.attempted <= this.limit; }`. Note the pre-increment:
  every *attempt* is counted whether or not it is allowed, which is what makes
  `attempts` after an unlimited run the size of the search space.
- `src/optimizing/infra/pass-manager.ts` — `PassManager.step`, lines 68–127. Line 70
  stamps `const ordinal = this.ordinal++` **before** anything else; line 73 is the gate,
  `pass.optional === true && this.options.optBisect !== null && !this.options.optBisect.allow()`;
  lines 74–87 emit a full trace record with `skipped: true`, `changed: false`,
  `elapsedMs: 0` and `nodesAfter: nodesBefore` before returning `false`. Also
  `TransformPass<G>.optional?: boolean` (line 19) — the flag the gate reads —
  `GraphVerification<G>`, `VerificationError`, and `PassManagerHooks<G>`.
- `src/optimizing/pipeline.ts` — `step(name, preserves, apply, requires)` at line 81 sets
  `optional: true` on **every** middle-end pass it builds; `middleEndPhases` (line 103)
  groups them into `phase("high-level-optimization")`, `phase("canonicalization")` and
  `phase("late-optimization")`; `middleEndPipeline`; `cfgPassManager`; `runMiddleEnd`,
  which emits the synthetic `ordinal: -1` `IR_BUILDER_STAGE` record so the reader can see
  the graph as built.
- `src/optimizing/target/legalization.ts` — `targetLegalizationPipeline`,
  `representationSelectionPass`, `representationCheckPass`, and the inline passes
  `callee-returns`, `spread-calls`, `iterator-lowering`, `element-types`,
  `array-access-lowering`, `zero-divisor`, `parse-number-surface`, `builtin-domains`.
  **None of them sets `optional`.** This is the safety property stated as code.
- `src/optimizing/options.ts` — `CompilerOptions.optBisect: OptBisect | null` (line 36),
  defaulted to `null` in `compilerOptions()` (line 130) and listed in the
  `OptLevelPreset` `Omit` (line 52) so no optimization level can set it.
- `src/optimizing/infra/pass-trace.ts` — `PassTraceRecord<G>`, `PassTracer<G>`,
  `PassTracing<G>`, `GraphProbe<G>`, `outcomeOf` (returns the literal string
  `"skipped by bisect"`), `formatPassTrace`, `formatRemark`, `consolePassTracer`.
- `src/optimizing/infra/pass-remarks.ts` — `RemarkRecorder`, `remarks` (module singleton),
  `REMARK_BUDGET = 64`, `missed`/`applied`/`analysis`, the `seen` de-duplication set and
  the `"N further remarks were not recorded"` tail. This is the complementary instrument:
  bisect says *which* pass, a remark says *why a pass did not fire*.
- `tools/visualizer/src/workers/bisect.ts` — the only bisect driver in the tree.
  `JIT_ORACLE = "what the program printed"`, `AOT_ORACLE = "whether the build produced
  every function"`, `firstBadLimit(total, differs)` (lines 44–53, the plain halving loop),
  `nameAt(request, limit)` (lines 25–38, re-runs at `limit - 1` with a `passTracer` that
  latches the first `record.skipped` and reports `record.pass` **and**
  `record.graph.name`), `bisect(request)` and its verdicts.
- `tools/visualizer/src/workers/observe.ts` — `Observation` (`signature`, `lines`,
  `attempts`, `ok`), `seen`, `runWith`, `buildWith`, `observeInterpreter`,
  `observeBaseline`, `observeJit`, `observeAot`. `observeAot` is where the AOT oracle is
  actually spelled: build error → `the build threw: …`; any `program.skipped` entry →
  those entries; otherwise the single line `"built every function"`.
- `tools/visualizer/src/types/stage.ts` — `BisectVerdict = "found" | "clean" |
  "before-passes" | "no-passes" | "failed"` (line 99) and `BisectResult` (lines 101–113:
  `verdict`, `oracle`, `total`, `limit`, `pass`, `owner`, `reference`, `observed`,
  `compiles`, `elapsedMs`, `error`).
- `tools/visualizer/src/components/BisectView.tsx` — `HEADLINE`, and the four explanation
  bodies. `"before-passes"` is the one worth quoting: it tells the reader to stop looking
  at optimization passes and go read module lowering, machine IR or the backend.
- `src/optimizing/passes/type-narrowing.ts:300` — `widenUnprovenInt32Arithmetic`, the pass
  the worked example lands on.

## Worked example

The book already carries a live divergence: the bignum comparison reproducer in
[Ch 82 § the-inventory], which answers one thing under `--no-opt` and another with the
optimizing tier on. This chapter localizes it.

```bash
node dist/cli.js --no-opt /tmp/bignum.tera
node dist/cli.js /tmp/bignum.tera
```

`--no-opt` prints `-1` then fifty-three `1`s. The optimizing tier prints the same until the
fiftieth mark and then five `0`s. Driving `OptBisect` over that difference — reference at
limit 0, full run unlimited, then `firstBadLimit` — gives, measured on this tree:

```
optional passes attempted: 68
verdict: found at limit 21 in 8 compiles
culprit: {"pass":"int32-overflow-widening","owner":"compare","ordinal":20}
```

Eight compiles to turn "one of sixty-eight passes" into one pass name and one function
name. The before/after IR is then read with `--print-after-all`, where the same pass
reports itself as the only one in the neighbourhood that did anything:

```
*** IR after #18 strength-reduction [unchanged, nodes 32 -> 32 (+0), invalidated nothing] ***
*** IR after #19 int32-overflow-widening [changed, nodes 32 -> 32 (+0), invalidated points-to mod-ref dominance loops] ***
*** IR after #20 loop-check-peeling [unchanged, nodes 32 -> 32 (+0), invalidated nothing] ***
```

The ordinal moved — 20 in the JIT recording, 19 under `compile` — and the reason is worth
a paragraph, because it is the "one counter, many pipelines" point made concrete:
`staticCompilerOptions` in `src/optimizing/optimizer.ts:36-40` sets
`sinkAllocations: false`, so the AOT pipeline has no `allocation-sinking` at ordinal 13 and
everything after it shifts down by one. **An ordinal is only comparable within one
pipeline configuration.** The pass *name* is the stable identifier, which is why
`BisectResult` carries `pass` and `owner` rather than an index.

> The reproducer is not a `docs/example/*.tera` file. It is written to `/tmp` by the
> heredoc in [Ch 82 § the-inventory] and this chapter reuses that file rather than
> introducing a ninth variation — see [Conventions § 1](../CONVENTIONS.md).

## Outline

- [ ] **A wrong answer and sixty-eight suspects.** Establish the shape of the problem
      before any machinery: two commands, two different answers, and the fact that
      `--no-opt` vs default is a *binary* switch that localizes nothing. Establish that
      "read all thirty pass implementations" is the alternative being replaced.
- [ ] **`> **New idea.** Bisection over a pipeline.** Establish the `git bisect` analogy
      and the cost: log₂(n) builds instead of n. Establish what a "commit" is here — one
      pass on one function — and that the history is linear because `PassManager` runs
      passes in order and nothing runs concurrently.
- [ ] **Seventeen lines.** Walk `OptBisect` in full (it fits inside the 20-line excerpt
      rule twice over) and the gate at `pass-manager.ts:73`. Establish the pre-increment
      in `allow()` and why `attempts` after an unlimited run *is* the search space size —
      the driver needs the upper bound before it can halve.
- [ ] **Why the obvious design fails: skipping any pass you like.** Stage the design a
      reader reaches for — "give me a flag that turns off pass #k" — then the program that
      breaks it. `targetLegalizationPipeline` contains `array-access-lowering`,
      `operation-legalization` and `representation-selection`; skip one and the backend is
      handed IR it has no opcode for, and the build fails for a reason that has nothing to
      do with the bug being hunted. Establish the fix as a *type-level* one: `optional?:
      boolean` on `TransformPass`, set by `step()` in `pipeline.ts` and by nothing in
      `legalization.ts`. Establish the measured consequence: at limit 0 the JIT still
      prints the right answer and the AOT build still produces every function, so any
      divergence found really is attributable to an optimization pass.
- [ ] **Ordinals are stamped before the gate.** Establish why this is not a detail:
      `this.ordinal++` happens on line 70, above the gate, so a trace taken at limit 1
      lines up row-for-row with a trace taken at infinity. Establish that a skipped pass
      still emits a full record — with `skipped: true` and `nodesAfter === nodesBefore` —
      because "the first record with `skipped === true`" is how the driver names pass
      #limit+1 without doing arithmetic.
- [ ] **One counter, many graphs.** Establish that the ordinal is per-`PassManager` (one
      per function) while the `OptBisect` lives on the shared `CompilerOptions`, so a
      whole-module compile is *one* linear sequence to search across every function. Then
      establish the consequence honestly: the two numbers are therefore **not** the same
      number once more than one function is optimized, which is exactly why `nameAt`
      re-runs and reads the record rather than indexing a list. Second consequence, from
      the worked example: an ordinal is not comparable across pipeline *configurations*
      either — `staticCompilerOptions` drops `allocation-sinking`, so every AOT ordinal
      after 12 is one lower than the JIT's for the same pass.
- [ ] **Choosing an oracle, per backend.** Establish that the JIT and the native compiler
      cannot be asked the same question. For the JIT the oracle is *what the program
      printed*, compared against the same program run cold in the interpreter
      (`observeInterpreter`, `COLD_TIERING`). For AOT there is no browser that can run an
      ELF or PE file, so the oracle is *whether the build produced every function* —
      `program.skipped` empty, or the single line `"built every function"`. Establish the
      limit this buys: an AOT bisect finds a pass that causes a *refusal*, never one that
      causes a wrong answer. Cross-reference [Ch 79 § native-tier] for the harness that
      does run the binary, and why it cannot run in a worker.
- [ ] **The driver, read top to bottom.** `bisect(request)`: unlimited run first (for
      `attempts`); the `no-passes` early exit; the reference; for the JIT the extra
      `observe(0)` guard that produces `before-passes` when even an unoptimized run
      disagrees; `firstBadLimit`; then one final `observe(low)` and `nameAt(request, low)`.
      Establish `signature` as `JSON.stringify(lines)` — the comparison is on the whole
      printed transcript, not a hash.
- [ ] **Naming the culprit *and* its function.** Establish `nameAt`'s trick: compile again
      at `limit - 1` with a tracer that latches the first `record.skipped`, then report
      `record.pass` and `record.graph.name`. Establish why the function name matters as
      much as the pass name — the same `licm` runs on every function in the module, and
      the answer the reader needs is "licm, on `compare`".
- [ ] **The five verdicts.** `found`, `clean`, `before-passes`, `no-passes`, `failed`, and
      what each one tells you to go read next. `before-passes` is the useful one: it moves
      the search out of the middle end entirely.
- [ ] **What bisect cannot see, and the two instruments that fill the gap.**
      `--print-after-all` (the whole recording, with the `*** IR after #N pass [changed,
      nodes a -> b (+d), invalidated …] ***` header) for reading the offending rewrite once
      it is named; and `remarks` for the opposite question — not "which pass broke it" but
      "why did the pass I expected never fire". Establish `REMARK_BUDGET`, the
      de-duplication `seen` set, and that remarks are only recorded while a tracer is
      attached (`remarks.listening` is false otherwise). Establish the identity-keyed diff
      from [Ch 76 § ir-diff] as the third instrument: bisect names the pass, the diff shows
      the one value it rewrote.
- [ ] **What this costs to keep working.** One flag on an interface, one counter, one
      `if`, and the discipline that new lowering passes are never marked `optional`.
      Nothing enforces that discipline — close on it, and hand it to [Ch 78].

## Honesty items

> **Unfinished.** `OptBisect` has no CLI surface. `src/cli/spec.ts` exposes `--verify` and
> `--print-after-all` on the `compile` command (lines 426–436) and nothing named
> `--opt-bisect` or `--opt-bisect-limit` anywhere; a grep for `optBisect` across `src/`
> finds it only in `options.ts`, `pass-manager.ts`, `opt-bisect.ts` and the
> `index.browser.ts` re-export. The only driver in the tree is
> `tools/visualizer/src/workers/bisect.ts`, which means bisecting requires either the
> visualizer or a hand-written script against the package entry point. Finishing it is one
> flag entry with `parseInt`, one line threading `new OptBisect(n)` into
> `buildEngineOptions`, and a decision about which oracle the CLI should use.

> **Unenforced.** `firstBadLimit` in `tools/visualizer/src/workers/bisect.ts:44` assumes
> the `differs` predicate is monotone — false for every limit below the culprit, true for
> every limit at or above it. Two passes that cancel each other out violate that, and the
> search will silently return a limit that is not the first bad one. Nothing checks it;
> the test `"finds the first limit that differs"` supplies a monotone predicate by
> construction.

> **Unenforced.** Nothing prevents a new lowering pass from being written with
> `optional: true`, or a new middle-end pass from being written by hand without it. The
> invariant lives entirely in the fact that `pipeline.ts` builds its passes through
> `step()` and `legalization.ts` builds its own by object literal. The test
> `"never skips a pass the pipeline needs, whatever the bisect limit"` pins the
> *mechanism* — a non-optional pass runs at limit 0 — not the *population*: no test
> asserts that every pass in `targetLegalizationPipeline` is non-optional.

> **Unfinished.** The AOT oracle in `observeAot` cannot detect a miscompile. It reports
> `"built every function"` for any build that produced a program with an empty `skipped`
> list, so an AOT bisect over a *wrong answer* will report `clean`. Making it real means
> running the produced binary, which is what `tests/helpers/c-executor.ts` does and what a
> browser worker cannot do — see [Ch 79 § native-tier].

> **Never runs.** `OptBisect.unlimited()` is exported and has no caller in `src/` or
> `tools/`; every unlimited run in the tree constructs `new OptBisect(Number.POSITIVE_INFINITY)`
> directly (`observe.ts:93`, `observe.ts:99` via a `limit` of `Infinity`).

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe --print-after-all 2>&1 | sed -n 's/^\*\*\* IR after #\([0-9-]*\) \([a-z0-9-]*\) .*/\1 \2/p' | sort -u -n
grep -rn "optional: true" src/optimizing/ ; grep -c "optional" src/optimizing/target/legalization.ts
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe --print-after-all 2>&1 | grep "^remark" | sort | uniq -c | sort -rn | head
npx vitest run --project unit tests/optimizing/infra/pass-manager.test.ts tests/optimizing/infra/pass-trace.test.ts
cd tools/visualizer && npx vitest run tests/bisect.test.ts
```

The first command prints ordinals `-1` (the `ir-builder` record) through `40` for
`stats.tera` on the C backend, in pipeline order. The second prints exactly one hit —
`src/optimizing/pipeline.ts:90`, inside `step()` — and `0` occurrences of `optional` in
`legalization.ts`.

## Tests that pin this

- `tests/optimizing/infra/pass-manager.test.ts`
  - `"runs no pass past the bisect limit"` — three optional passes, `new OptBisect(2)`,
    two run, and `bisect.attempts` is `3`: the third pass was *attempted* and refused.
  - `"never skips a pass the pipeline needs, whatever the bisect limit"` — `new
    OptBisect(0)`, a non-optional `lowering` pass and an optional one; only `lowering`
    runs and `attempts` is `1`. This is the safety property.
  - `"spends one bisect budget across every pipeline it is handed to"` — one `OptBisect`,
    two graphs, two `PassManager`s, one shared `CompilerOptions`; only the first graph's
    pass runs.
  - `"gives a pass the same ordinal whatever the bisect limit is"` — traces at limit ∞ and
    limit 1 and asserts the `[ordinal, pass]` pairs are equal, with
    `skipped` equal to `[false, true, true]`.
  - `"traces the graph that broke an invariant before it throws"` — one record, carrying
    `graph.value === 99`, then `VerificationError`. This is the handover to [Ch 78].
  - `"verifies a graph only after a pass that changed it"`.
- `tests/optimizing/infra/pass-trace.test.ts`
  - `"names bisect as the reason a pass did nothing"` — pins the literal
    `skipped by bisect` in the header.
  - `"numbers records continuously across separate pipeline runs"`.
  - `"renders a section header naming the pass, delta and invalidated analyses"`.
  - `"prints every invariant the pass broke under the header"`.
- `tools/visualizer/tests/bisect.test.ts`
  - `"finds the first limit that differs"` — `firstBadLimit(64, …)` returns 23 in at most
    seven probes.
  - `"blames the very first pass when even one is enough"`.
  - `"blames the last pass when only the whole pipeline differs"`.
  - `"clears every optional pass when the JIT agrees with the interpreter"` — verdict
    `clean`, reference and observed both `["89634"]`.
  - `"keeps the search to a handful of compiles"` — `report.compiles <= 4`.
  - `"still has passes to bisect for a program with no function of its own"`.
  - `"optimizes a function the program calls once, like the pipeline pane does"`.
- `tests/optimizing/infra/pass-remarks.test.ts`
  - `"drops everything recorded while no pass scope is open"`.
  - `"tags each remark with the pass that was running when it was recorded"`.
  - `"keeps one copy when the same decision is reached about the same node twice"`.
  - `"stops at the budget and says how many it left out"`.
- `tests/optimizing/infra/pass-remarks-from-passes.test.ts`
  - `"names the allocation it refused to scalar replace and why it escapes"`.
  - `"says the index range is unknown when the index is an opaque parameter"`.
  - `"gives a different reason once the index has a known range but no known length"`.
