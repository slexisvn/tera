# 41. The pass manager   ⟨J · N⟩

> **Status:** outline

**Thesis.** A pass declares what it needs and what it preserves, and everything —
verification, invalidation, remarks, bisect — hinges on it reporting truthfully whether it
changed anything.

**What arrived.** One `CFGFunction` in canonical-phi SSA, node ids stamped by the ambient
`IRNodeIdAllocator`, with a `FrameState` hanging off every node that can bail out
([Ch 40 § frame-states]).

**What leaves.** The same `CFGFunction` object, mutated in place by up to thirty-four
transform passes, plus an `AnalysisManager` whose cache is warm with whatever the last pass
did not invalidate. `runMiddleEnd` returns that manager, not the graph.

**New ideas.** Pass, pipeline, analysis vs transform; "preserves"; cache invalidation as a
correctness problem, not a performance one; bisecting a compiler.

**Length.** 14 pages

## Anchors

- `src/optimizing/infra/pass-manager.ts` — `TransformPass<G>` (`name`, `preserves`,
  `optional?`, `requires?`, `run`), the four-way `Preservation` union
  (`all` / `none` / `only` / `allExcept`), `TransformOutcome`, `PassManager.run`,
  the private `step`, `applyInvalidation`, `PassManagerHooks<G>`,
  `GraphMaintenance<G>`, `GraphVerification<G>`, `VerificationError`.
- `src/optimizing/infra/analysis-manager.ts` — `analysisId<T>(name)` returning a branded
  `symbol`, `AnalysisPass<G,T>`, `AnalysisRegistry`, `AnalysisManager.get` (the lazy memo),
  `invalidate` / `invalidateAll` / `invalidateExcept`.
- `src/optimizing/infra/pass-remarks.ts` — `RemarkKind`, `Remark`, `REMARK_BUDGET = 64`,
  `RemarkRecorder` (`open` / `close` / `record` / `missed` / `applied` / `analysis`,
  `listening`, `depth`), the module-level `remarks` singleton, and the dedup key
  `` `${kind} ${node} ${message}` ``.
- `src/optimizing/infra/pass-trace.ts` — `GraphProbe<G>`, `PassTraceRecord<G>`,
  `PassTracer<G>`, `PassTracing<G>`, `analysisName`, `formatRemark`, `formatPassTrace`,
  `consolePassTracer`.
- `src/optimizing/infra/opt-bisect.ts` — `OptBisect`, `allow()`, `attempts`, `unlimited()`.
- `src/optimizing/pipeline.ts` — `middleEndPhases`, `middleEndPipeline`,
  `CompilerPipelinePhase` (the three names), the `step()` adapter and its `changed()`
  normaliser, `maintainGraph`, `verifyAfterPass`, `cfgPassManager`, `cfgPassTracing`,
  `IR_BUILDER_STAGE`, `runMiddleEnd`.
- `src/optimizing/ir/graph-edit.ts` — `homeFloatingValues`, `reserveNodeIds`,
  `nodeIdStamper`, `maxNodeId`.
- `src/optimizing/ir/frame-state-values.ts` — `buildFrameStateIndex`, `clearFrameStateIndex`.
- `src/optimizing/options.ts` — `CompilerOptions`, the four `OptLevel` presets,
  `compilerOptions()`, and the fields this chapter reads: `passTracer`, `verifyEachPass`,
  `optBisect`.
- `src/cli/compile.ts:43-44` — the only place in `src/` that installs a `passTracer` or
  turns on `verifyEachPass`.

## Worked example

`docs/example/stats.tera`, compiled ahead of time with the pass tracer on:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c
```

Twenty-one functions, each traced twice: once through the middle end (ordinals `0`–`32`,
thirty-three passes at AOT settings) and once through target legalization (ordinals `0`–`40`,
forty-one passes), preceded by one synthetic `#-1 ir-builder` record. **1575 sections in
total; 210 report `changed`, 1365 report `unchanged`.** Twenty-one of the "changed" records
are the synthetic builder line, so 189 of 1554 real pass runs did anything at all.

Per-pass histogram of what actually changed the graph (`type-narrowing` 18, `licm` 9,
`gvn` 2, `sccp` 1, `load-elimination` 1, `strength-reduction` 1) is the section's payload:
most of the pipeline is insurance.

> Note for the writing pass: `--print-after-all` is a flag of the **`compile`** command, not
> of `run`. `node dist/cli.js --print-after-all <file>` is rejected with
> `tera: unknown option '--print-after-all' for 'run'`.

## Outline

- [ ] **A pass is a declaration, not a function.** Establish `TransformPass<G>`: four fields
      plus `run`. Show that the pipeline is data — `middleEndPipeline()` returns an array you
      can `.find(p => p.name === "sccp")`, which is exactly how `tests/optimizing/pipeline.test.ts`
      gets hold of a real pass to test the manager with.
- [ ] **`> **New idea.**` What "preserves" means.** Establish the four-way `Preservation`
      union and that `all`/`none` are the two used in practice (`preservesControlFlow` is
      `{kind:"only", preserved:[dominance, loops]}`; `invalidatesAnalyses` is `{kind:"none"}`).
      Establish that an over-claimed preservation is a *correctness* bug: a stale
      `DominatorTree` answers questions about blocks that no longer exist.
- [ ] **`step()` in order.** Establish the exact nine-step sequence in
      `pass-manager.ts:68-127`: ordinal, node count probe (only if tracing), **bisect gate**,
      **analysis prefetch** (`for (const id of pass.requires ?? []) this.analyses.get(id)`),
      **remark scope open**, **timing start**, `pass.run`, **remark scope close in `finally`**,
      timing stop, **maintain**, **verify**, **invalidate**, **trace**, then throw if the
      verifier found anything. Note that the throw happens *after* the trace, so the broken
      graph is dumped before the exception.
- [ ] **Everything downstream of `changed`.** Establish that `maintain`, `verify` and
      `applyInvalidation` are all guarded by `outcome.changed`. **Why the obvious design
      fails:** running maintenance unconditionally is the safe design and it is not what this
      does; the price of the cheap design is that a pass which mutates and returns
      `{changed:false}` leaves the graph un-homed, the frame-state index stale, the verifier
      silent and every analysis still cached against a graph that moved.
- [ ] **The `changed()` normaliser.** Establish `pipeline.ts:75-79`: passes return `number`,
      `boolean`, or `{changed?, sunkCount?}`, and one adapter turns all three into a boolean.
      Name this as the seam where a pass most easily lies — a pass that returns a count it
      forgot to increment reports `false`.
- [ ] **`maintainGraph` is two repairs.** Establish `homeFloatingValues` (any input with
      `block === null` that is not a `Parameter` gets homed into the entry block) and
      `buildFrameStateIndex`. Connect to [Ch 40 § frame-state-index] for why the index goes
      stale mid-pass and is only rebuilt *between* passes.
- [ ] **The analysis manager is a lazy memo keyed by a branded symbol.** Establish
      `analysisId<T>()` returning `Symbol(name) as AnalysisId<T>` — the phantom type parameter
      is what makes `analyses.get(dominanceAnalysisId)` return a `DominatorTree` with no cast
      at the call site, while `AnalysisManager` stores `unknown`. Establish that an analysis
      may ask for another analysis through the same manager (`loopForestAnalysis` calls
      `analyses.get(dominanceAnalysisId)`), so the cache is transitive.
- [ ] **Remarks are English addressed to a programmer.** Establish the three kinds
      (`missed` / `applied` / `analysis`), the dedup key, the `REMARK_BUDGET = 64` cap and the
      `"N further remarks were not recorded"` note appended on overflow. Establish that
      recording is free when nobody listens: `record` returns immediately if no scope is open,
      and `PassManager` opens a scope only when `tracing !== null`. Quote two real messages
      verbatim from the worked example.
- [ ] **`> **New idea.**` Bisect.** Establish `OptBisect` as LLVM's `-opt-bisect-limit`: a
      counter that says yes to the first *N* `allow()` calls. Establish that only passes marked
      `optional: true` are skippable, that `pipeline.ts`'s `step()` helper marks every
      middle-end pass optional, and that the ordinal is assigned *before* the gate so a pass
      keeps its number whatever the limit — pinned by
      `"gives a pass the same ordinal whatever the bisect limit is"`.
- [ ] **The three phases.** Establish `high-level-optimization` (9 passes),
      `canonicalization` (18–20 depending on `scalarReplaceAggregates` and `sinkAllocations`),
      `late-optimization` (5), listed with each pass's `requires` set. Establish that
      `runMiddleEnd` runs them as three separate `passManager.run` calls but the ordinal
      counter is per-manager, so numbering is continuous across phases and *restarts* for the
      legalization pipeline — which is why the worked example shows two passes at ordinal `9`.
- [ ] **Where the tracer comes from.** Establish that `passTracer` is set in exactly one place
      in `src/` (`src/cli/compile.ts:44`) and `moduleTracer` in none, and that
      `tools/visualizer` sets both. Cross-reference [Ch 76 § replaying-passes] and
      [Ch 77 § bisecting].

## Honesty items

> **Never runs.** `PassTraceRecord.elapsedMs` (`src/optimizing/infra/pass-trace.ts:14`) is
> measured on every traced pass (`pass-manager.ts:95,101`) and tested
> (`tests/optimizing/infra/pass-manager.test.ts` → `"times each pass it traces"`), but
> `formatPassTrace` never renders it, so `--print-after-all` prints no timings. The only
> consumer in the tree is `tools/visualizer` (`tools/visualizer/src/components/CostView.tsx`,
> `tools/visualizer/src/components/StageViewer.tsx`). Finishing it is one interpolation in `formatPassTrace`
> plus a decision about whether wall-clock noise belongs in golden output.

> **Never runs.** `CompilerOptions.moduleTracer` has no CLI flag. Nothing in `src/` ever sets
> it; only `tools/visualizer/src/workers/compiler-worker.ts:741` does. Every remark recorded
> by a module-level stage — which is *every* remark from `inlineKnownCalls` ([Ch 50](50-inlining-and-tail-calls.md))
> — is therefore unreachable from the command line. Cost: one flag in `src/cli/spec.ts` and a
> console sink.

> **Never runs.** `CompilerOptions.optBisect` likewise has no CLI flag; `--opt-bisect-limit`
> does not exist. `OptBisect` is reachable only through the library API and
> `tools/visualizer/src/workers/bisect.ts`.

> **Unenforced.** Nothing checks that a pass's declared `preserves` is true of what it did.
> `preservesControlFlow` is an assertion by the author, re-stated in twenty-odd `step(...)`
> calls in `pipeline.ts`, and a pass that quietly splits a block while claiming to preserve
> dominance will be believed. `verifyEachPass` checks SSA invariants, not analysis validity.

> **Unenforced.** Nothing checks that `outcome.changed` matches reality. This is the pivot of
> the whole chapter and the thing the reader should leave most aware of.

> **Dead.** `PassManagerHooks.tracing`, `.maintain` and `.verify` are all optional and default
> to `null`; the bare `new PassManager(analyses, options)` constructed in
> `tests/optimizing/pipeline.test.ts` runs with all three off, which is the configuration in
> which a graph-corrupting pass goes unnoticed. Not a defect — worth naming as the default.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | wc -l
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | grep '\[changed' \
  | sed 's/^\*\*\* IR after #[-0-9]* \([a-z0-9-]*\) .*/\1/' | sort | uniq -c | sort -rn
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^remark' | sort -u
node dist/cli.js compile docs/example/stats.tera --emit source --verify -o /tmp/stats.c
npx vitest run --project unit tests/optimizing/infra/ tests/optimizing/pipeline.test.ts
```

## Tests that pin this

- `tests/optimizing/infra/pass-manager.test.ts` > `"preloads required analyses before running a transform pass"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"maintains the graph only after a pass that changed it"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"runs no maintenance at all when nothing changes"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"verifies a graph only after a pass that changed it"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"traces the graph that broke an invariant before it throws"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"invalidates every analysis except preserved analyses under only preservation"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"invalidates only the listed analyses under allExcept"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"invalidates every analysis under a none preservation"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"runs no pass past the bisect limit"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"spends one bisect budget across every pipeline it is handed to"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"gives a pass the same ordinal whatever the bisect limit is"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"never skips a pass the pipeline needs, whatever the bisect limit"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"times each pass it traces"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"does not leak a throwing pass's remarks into the next run"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"keeps the recorder shut when nobody is tracing"`
- `tests/optimizing/infra/pass-remarks.test.ts` > `"drops everything recorded while no pass scope is open"`
- `tests/optimizing/infra/pass-remarks.test.ts` > `"keeps one copy when the same decision is reached about the same node twice"`
- `tests/optimizing/infra/pass-remarks.test.ts` > `"stops at the budget and says how many it left out"`
- `tests/optimizing/infra/pass-remarks.test.ts` > `"adds no overflow note when the pass stayed inside the budget"`
- `tests/optimizing/infra/pass-remarks.test.ts` > `"gives a remark to the innermost pass when a stage runs a pipeline inside itself"`
- `tests/optimizing/infra/analysis-manager.test.ts` > `"computes an analysis once and caches the result"`
- `tests/optimizing/infra/analysis-manager.test.ts` > `"resolves a transitive analysis dependency through the manager"`
- `tests/optimizing/infra/analysis-manager.test.ts` > `"throws when resolving an unregistered analysis"`
- `tests/optimizing/infra/pass-trace.test.ts` > `"numbers records continuously across separate pipeline runs"`
- `tests/optimizing/infra/pass-trace.test.ts` > `"leaves dumping to the sink so an unused dump costs nothing"`
- `tests/optimizing/infra/pass-trace.test.ts` > `"names bisect as the reason a pass did nothing"`
- `tests/optimizing/pipeline.test.ts` > `"invalidates analyses when a real pass mutates the graph"`
- `tests/optimizing/pipeline.test.ts` > `"keeps analyses cached when a real pass makes no change"`
- `tests/optimizing/pipeline.test.ts` > `"attributes each change and invalidation to the pass that caused it"`
- `tests/optimizing/pipeline.test.ts` > `"prints exactly one section per middle-end pass"`
- `tests/optimizing/pipeline.test.ts` > `"opens with the graph the builder produced, before any pass ran"`
- `tests/optimizing/pipeline.test.ts` > `"names the pass that left the graph inconsistent"`
- `tests/optimizing/pipeline.test.ts` > `"leaves the graph unchecked when verification is off"`
- `tests/optimizing/drivers/module-trace.test.ts` > `"names each module transform in the order the driver runs them"`
