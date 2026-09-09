# 41. The pass manager   ⟨J · N⟩

Compile `docs/example/stats.tera` ahead of time with the pass tracer on and the engine prints
1,575 sections. Twenty-one functions, each dumped once for every pass that ran over it, plus
one synthetic section per function for the graph the builder handed over. Of those 1,575,
exactly **210 say `changed`** and **1,365 say `unchanged`**. Twenty-one of the changed ones
are the synthetic builder line. So 189 of 1,554 real pass runs did anything at all: the
pipeline spends nearly nine tenths of its work confirming that there is nothing to do.

That ratio is not a defect. Most of a pipeline is insurance — a pass exists because *some*
function somewhere is shaped the way it fixes, and the price of having it is that it walks
every other function and finds nothing. But it does make one thing load-bearing in a way a
reader would not guess: the boolean each pass returns. `changed` is not a statistic. It is
the signal that decides whether the graph gets repaired, whether the verifier looks at it,
and whether the cached dominator tree that four later passes are about to consult is thrown
away or believed. A pass that mutates the graph and returns `false` does not merely go
unreported. It leaves every one of those three mechanisms switched off over a graph that
moved.

This chapter is about the machinery that runs a pipeline: what a pass declares, what the
manager does with the declaration, and why the one field nothing verifies is the field
everything hangs on.

**What arrived.** One `CFGFunction` in canonical-phi SSA — blocks with explicit predecessor
and successor edges, every value defined once, phis whose inputs are positionally parallel to
their block's predecessors, node ids stamped by the ambient `IRNodeIdAllocator`
([Ch 38 § canonical-phi-ssa]) — and hanging off every node that can give up, a `FrameState`
naming the interpreter registers that must be restorable if it does
([Ch 40 § what-a-frame-state-holds]). Those frame states are the reason this chapter's central warning
has teeth: a frame state is a *use*, so `node.uses.length === 0` does not mean a node is
dead, and a pass that deletes on that test alone deletes a value a deoptimized frame still
needs.

## The pass manager {#the-pass-manager}

A pass in this engine is not a function you call. It is a record you hand to something else,
and four of its five fields are declarations *about* the transformation rather than the
transformation itself.

```ts
export interface TransformPass<G> {
  readonly name: string;
  readonly preserves: Preservation;
  readonly optional?: boolean;
  readonly requires?: ReadonlyArray<AnalysisId<unknown>>;
  run(graph: G, analyses: AnalysisManager<G>, options: CompilerOptions): TransformOutcome;
}
```
— `src/optimizing/infra/pass-manager.ts:16-22`

> **New idea. Pass, pipeline, analysis, transform.** A **pass** is one transformation over
> the whole function: constant folding, dead-code removal, hoisting a loop-invariant value.
> A **pipeline** is an ordered list of them. Passes are ordered because they enable each
> other — a fold exposes a dead branch, removing the branch exposes a trivial phi, folding
> the phi exposes another constant — and because some orders are simply wrong: tera has a
> test named `"cannot hoist a value carried through an untouched loop-header phi"` beside
> one named `"hoists that same value once trivial phis have been eliminated first"`
> [t: tests/optimizing/pipeline-order.test.ts > "cannot hoist a value carried through an untouched loop-header phi"].
> The second kind of thing a pipeline contains is an **analysis**: a computation that
> *answers questions* and changes nothing. "Which block dominates which?" is an analysis;
> "delete this node" is a transform. The distinction is not stylistic. An analysis result can
> be cached and shared between passes precisely because it does not mutate; the moment a
> transform runs, every cached answer is suspect.

`name` is the string that appears in traces and in bisect reports. `run` does the work.
`requires` names the analyses this pass will ask for, so the manager can compute them before
the pass starts rather than in the middle of it. `optional` says the pass may be skipped
without breaking the compile. `preserves` is the pass's claim about which cached analyses
survive it.

The manager itself is small — `PassManager<G>` is ninety-six lines including the class
declaration — and generic in the graph type. It knows nothing about SSA, blocks or nodes.
Everything graph-shaped reaches it through three optional hooks:

- `tracing` — a `GraphProbe` that can count and dump nodes, plus a sink for trace records.
- `maintain` — a repair function run after any pass that changed the graph.
- `verify` — a checker that returns a list of broken invariants, or an empty list.

All three default to `null` (`pass-manager.ts:55-57`).

> **Note.** The bare constructor `new PassManager(analyses, options)` — the form
> `tests/optimizing/pipeline.test.ts` uses to drive real passes — runs with `tracing`,
> `maintain` and `verify` all off. That is not an honesty item and not a defect: it is the
> default, and it is reached constantly, by `pipeline-order.test.ts` and
> `target/legalization.test.ts` as well. It is worth naming because it is precisely the
> configuration in which a graph-corrupting pass produces no trace, no repair and no
> complaint. Production compiles get `maintain` unconditionally and `verify` only under
> `--verify` (`src/optimizing/pipeline.ts:305-309`).

The pipeline is data, not control flow. `middleEndPipeline()` returns a plain array, which is
how the tests get hold of a real pass to exercise the manager with:

```ts
function passNamed(name: string) {
  const pass = middleEndPipeline({ feedback: undefined }).find(
    (candidate) => candidate.name === name,
  );
  if (!pass) throw new Error(`missing pass ${name}`);
  return pass;
}
```
— `tests/optimizing/pipeline.test.ts:40-46`

That is the whole reason `"invalidates analyses when a real pass mutates the graph"` is a
test of `sccp` and not of a mock.

## What "preserves" means {#preserves}

`preserves` has four shapes.

```ts
export type Preservation =
  | { readonly kind: "all" }
  | { readonly kind: "none" }
  | { readonly kind: "only"; readonly preserved: ReadonlyArray<AnalysisId<unknown>> }
  | { readonly kind: "allExcept"; readonly invalidated: ReadonlyArray<AnalysisId<unknown>> };
```
— `src/optimizing/infra/pass-manager.ts:10-14`

> **New idea. Cache invalidation as a correctness problem.** The joke says cache
> invalidation is one of the two hard problems in computer science, and in most systems
> getting it wrong costs you speed: you recompute something you already had. In a compiler
> it costs you the program. A `DominatorTree` is a snapshot of a control-flow graph. If a
> pass splits a block, adds an edge or deletes an unreachable region and the tree is *not*
> thrown away, the next pass asks "does block 4 dominate block 9?" and gets an answer about a
> graph that no longer exists. It will then hoist a value above a definition, or delete a
> guard that is no longer redundant, and the wrong code it emits will be perfectly
> self-consistent. Nothing crashes. The program answers wrongly. So "preserves" is not a
> performance annotation. It is a proof obligation the author of the pass is asserting and
> nothing is checking.

Two of the four shapes carry the pipeline. `src/optimizing/pipeline.ts` defines exactly two
`Preservation` values and reuses them everywhere:

- `preservesControlFlow` = `{ kind: "only", preserved: [dominance, loops] }` (`pipeline.ts:67`)
  — "I changed values, not the shape of the graph. Keep the dominator tree and the loop
  forest; drop everything else."
- `invalidatesAnalyses` = `{ kind: "none" }` (`pipeline.ts:68`) — "assume nothing survived."

Of the thirty-four middle-end passes, twenty-seven declare `preservesControlFlow` and seven
declare `invalidatesAnalyses`: `loop-unswitching`, `sccp`, `sccp-after-escape`, `gvn`,
`bounds-check-elimination`, `int32-overflow-widening` and `unreachable-block-elimination`.
Those seven are the passes that can add or delete blocks. The `all` and `allExcept` shapes are used only in the target
legalization pipeline (`representation-check` declares `{ kind: "all" }` because it validates
and mutates nothing — `src/optimizing/target/legalization.ts:99-106`) and in tests.

The declaration is turned into cache surgery by one private method:

```ts
  private applyInvalidation(preservation: Preservation): readonly AnalysisId<unknown>[] {
    if (preservation.kind === "all") return NOTHING_INVALIDATED;
    if (preservation.kind === "none") return this.analyses.invalidateAll();
    if (preservation.kind === "only") {
      return this.analyses.invalidateExcept(new Set(preservation.preserved));
    }
    const invalidated: AnalysisId<unknown>[] = [];
    for (const id of preservation.invalidated) invalidated.push(...this.analyses.invalidate(id));
    return invalidated;
  }
```
— `src/optimizing/infra/pass-manager.ts:129-138`

Note what it returns: the ids it actually *dropped from the cache*, not the ids the pass
declared invalid. This matters when you read a trace. A pass that declares
`{ kind: "none" }` at a moment when the cache happens to be empty reports
`invalidated nothing` — which is a true statement about the cache and a misleading one about
the pass.

> **Unenforced.** Nothing checks that a pass's declared `preserves` is true of what it did.
> `preservesControlFlow` is an assertion by the author, restated in twenty-seven `step(...)`
> calls in `src/optimizing/pipeline.ts`, and a pass that quietly splits a block while
> claiming to preserve dominance will be believed by every pass after it. `--verify` does not
> close this: `verifyAfterPass` runs `validateGraphInvariants`, which checks SSA structure —
> that uses dominate their definitions, that phi inputs are parallel to predecessors — not
> that a cached analysis still describes the graph. Closing it would cost a debug mode that
> recomputes each preserved analysis after every pass and compares it to the cached one,
> which is affordable only under a flag.

## Step order {#step-order}

`PassManager.run` is a loop over the pipeline that ORs the outcomes together
(`pass-manager.ts:60-66`). Everything interesting is in the private `step`, and the order of
its parts is the chapter's spine. Twelve things happen, in this order:

1. **Ordinal.** `const ordinal = this.ordinal++` (`:70`). Assigned *before* anything can
   decline to run, so a pass keeps its number whatever else happens
   [t: tests/optimizing/infra/pass-manager.test.ts > "gives a pass the same ordinal whatever the bisect limit is"].
2. **Node count probe**, but only if tracing is on (`:71`) — otherwise the count is `0` and
   the probe is never called.
3. **The bisect gate** (`:73`). Covered in § opt-bisect below. A pass stopped here is traced
   as `skipped: true` and returns `false` without running.
4. **Analysis prefetch.** `for (const id of pass.requires ?? []) this.analyses.get(id)`.
5. **Remark scope open**, only when tracing is on.
6. **Timing start**, only when tracing is on.
7. `pass.run(...)`.
8. **Remark scope close, in a `finally`** — so a pass that throws does not leave its scope on
   the stack for the next pass to inherit
   [t: tests/optimizing/infra/pass-manager.test.ts > "does not leak a throwing pass's remarks into the next run"].
9. **Maintain**, if changed.
10. **Verify**, if changed.
11. **Invalidate**, if changed.
12. **Trace**, then throw if verification found anything.

Steps 4 and 7 through 11 are the body:

```ts
    for (const id of pass.requires ?? []) this.analyses.get(id);
    let outcome: TransformOutcome;
    let noted: readonly Remark[];
    if (tracing !== null) remarks.open(pass.name);
    const started = tracing === null ? 0 : performance.now();
    try {
      outcome = pass.run(graph, this.analyses, this.options);
    } finally {
      noted = remarks.close();
    }
    const elapsedMs = tracing === null ? 0 : performance.now() - started;

    if (outcome.changed && this.maintain !== null) this.maintain(graph);
    const verification =
      outcome.changed && this.verify !== null ? this.verify(graph, pass.name) : NOTHING_BROKEN;
    const invalidated = outcome.changed
      ? this.applyInvalidation(pass.preserves)
      : NOTHING_INVALIDATED;
```
— `src/optimizing/infra/pass-manager.ts:91-108`

Two details in that ordering are deliberate and easy to miss.

The prefetch is not an optimization. Analyses can be requested lazily from inside `run` —
`analyses.get(dominanceAnalysisId)` works at any point — so prefetching them changes nothing
about *what* is computed. What it changes is *when*, and therefore what the trace attributes
them to and what a bisect run measures. Computing the dominator tree in the middle of `licm`
would make `licm` look expensive and would mean a bisect limit that skips `licm` also skips
the tree it would have built
[t: tests/optimizing/infra/pass-manager.test.ts > "preloads required analyses before running a transform pass"].

And the throw comes **after** the trace (`:110-125`). If `--verify` catches a broken
invariant, the offending graph is dumped first and the `VerificationError` is raised second,
so the last thing on your terminal is the graph that broke, labelled with the pass that broke
it
[t: tests/optimizing/infra/pass-manager.test.ts > "traces the graph that broke an invariant before it throws"]
[t: tests/optimizing/pipeline.test.ts > "names the pass that left the graph inconsistent"].
The message is built by `verifyAfterPass` as `` `${graph.name} after ${pass}: ${message}` ``
(`pipeline.ts:297`), so it names a function and a pass, not a line number.

## Everything downstream of changed {#changed}

*(Why the obvious design fails.)*

The obvious design is to run maintenance, verification and invalidation unconditionally after
every pass. It is obviously correct: no pass can lie its way past a repair that always
happens. It is not what this does.

Look again at lines 103 to 108. All three are guarded by `outcome.changed`. A pass that
reports `false` gets: no `homeFloatingValues`, no `buildFrameStateIndex`, no
`validateGraphInvariants` even under `--verify`, and no cache invalidation at all.

The measurement at the top of this chapter is why. On `stats.tera`, 1,365 of 1,575 sections
report `unchanged`. Under the unconditional design, each of those would rebuild the
frame-state index — a walk over every frame state in the function — and, under `--verify`,
re-run the full structural validator. The guard buys back nearly nine tenths of that work, and the
work it buys back is exactly the work that provably has nothing to do.

The price is stated plainly, because it is the chapter's thesis: **a pass that mutates the
graph and returns `{changed: false}` leaves the graph un-homed, the frame-state index stale,
the verifier silent, and every analysis still cached against a graph that moved.** Four
mechanisms, all switched off, all by one boolean the pass computed about itself.

That failure is not hypothetical anywhere in this book. Chapter 40 traces the frame-state
index's staleness rules to exactly this line, and the symptom it produces there is an AOT
refusal naming a promise, several stages downstream of the pass that under-reported
([Ch 40 § stale-within-one-pass]).

> **Unenforced.** Nothing checks that `outcome.changed` matches reality. There is no
> before/after graph hash, no mutation counter on `CFGFunction`, no assertion. The manager
> takes the pass's word for it. A cheap partial check exists and is not used: the tracer
> already records `nodesBefore` and `nodesAfter`, so a pass reporting `unchanged` while the
> node count moved could be caught for free whenever tracing is on. It would not catch a
> pass that rewires inputs without changing the count, which is the common case. A real
> check costs a structural fingerprint of the graph computed twice per pass, which is why it
> does not exist.

## The changed() normaliser

`TransformOutcome` is a one-field record: `{ readonly changed: boolean }`
(`pass-manager.ts:6-8`). The passes themselves do not return that. They return counts.

```ts
function changed(result: PassResult): boolean {
  if (typeof result === "number") return result > 0;
  if (typeof result === "boolean") return result;
  return result.changed === true || (result.sunkCount ?? 0) > 0;
}
```
— `src/optimizing/pipeline.ts:75-79`

`PassResult` is `number | boolean | { changed?: boolean; sunkCount?: number }`
(`pipeline.ts:58`), and one adapter turns all three into the boolean the manager wants:

```ts
function step(
  name: string,
  preserves: Preservation,
  apply: PassApply,
  requires: readonly AnalysisId<unknown>[] = [],
): TransformPass<CFGFunction> {
  return {
    name,
    preserves,
    optional: true,
    requires,
    run: (graph, analyses) => ({ changed: changed(apply(graph, analyses)) }),
  };
}
```
— `src/optimizing/pipeline.ts:81-94`

Every middle-end pass function returns `number` — `deadCodeElimination`,
`sparseConditionalConstantPropagation`, `hoistLoopInvariants`, `globalValueNumbering`,
`typeNarrowing`, all of them — except `allocationSinking`, which returns
`{ sunkCount: number }` (`src/optimizing/passes/allocation-sinking.ts:41`).

This is the seam where a pass most easily lies, and it lies by arithmetic rather than by
intent. A pass that performs a rewrite and forgets to increment its counter on that path
returns `0`, and `0` becomes `false`, and `false` switches off the four mechanisms above. The
counter is not incidental bookkeeping the way it looks; it is a correctness variable.

> **Dead.** The `boolean` arm of `changed()` (`pipeline.ts:77`) has no producer. `changed()`
> is called from exactly one place — the `step()` adapter — and every function `step()` is
> given returns `number` or `{sunkCount}`. The legalization pipeline does not use `step()` at
> all; its passes build `{ changed: ... }` themselves. Removing the arm costs one line and
> one narrowing of `PassResult`; keeping it costs nothing and admits a pass that wants to
> report a rewrite it did not count.

## maintainGraph is two repairs {#maintaingraph}

The `maintain` hook the production pipeline installs is four lines and does two unrelated
jobs.

```ts
export function maintainGraph(graph: CFGFunction): void {
  homeFloatingValues(graph);
  buildFrameStateIndex(graph);
}
```
— `src/optimizing/pipeline.ts:70-73`

`homeFloatingValues` (`src/optimizing/ir/graph-edit.ts:64-81`) walks every input of every
node in every block and collects the ones whose `block` is `null` — values that exist and are
used but live in no block. A pass that builds a replacement node and wires it in without
placing it leaves exactly this. Parameters are exempt, because a `IR_PARAMETER` legitimately
belongs to no block. Everything else is re-homed into the entry block, which is always a
legal position for a value with no ordering constraints because the entry block dominates
everything.

`buildFrameStateIndex` rebuilds the map from a value to every frame-state slot that names it.
That relation is what makes "is this node still needed by something that can deoptimize?"
answerable in one lookup rather than a scan of the whole function, and chapter 40 is the
chapter about why it has to be exact. The manager's contribution is the rebuild point: the
index is rebuilt **between** passes, never during one, so within a single pass it is always
potentially stale in the over-reporting direction ([Ch 40 § the-index-and-what-it-costs]).

Two things happen outside this hook and are worth naming, because a reader who believes the
pass manager owns all graph maintenance will be surprised by them. `Optimizer.build` calls
`clearFrameStateIndex(graph)` and then `repairFrameStateDominance(graph)` *after*
`runMiddleEnd` returns and before `validateOptimizedGraph`
(`src/optimizing/optimizer.ts:190-199`). And the AOT driver invalidates two analyses by hand,
outside any pass: `analyses.invalidate(typeInferenceAnalysisId)` after
`stampCalleeSignatures` writes signatures onto the graph
(`src/optimizing/drivers/aot.ts:773-775`), and `analyses.invalidate(aotLegalityAnalysisId)`
after string escapes and wide-text decisions are stamped on
(`src/optimizing/drivers/aot.ts:863`). Both are the same situation: something that is not a
pass mutated the graph, so the pass manager's invalidation protocol never fired, and the
mutation site has to do it itself.

## The analysis manager is a lazy memo keyed by a branded symbol {#analysis-manager}

`AnalysisManager` is a cache with three ways to empty it and one way to fill it.

```ts
  get<T>(id: AnalysisId<T>): T {
    if (this.cache.has(id)) return this.cache.get(id) as T;
    const result = this.registry.resolve(id).run(this.graph, this);
    this.cache.set(id, result);
    return result;
  }
```
— `src/optimizing/infra/analysis-manager.ts:36-41`

Ask for something not cached and it is computed, stored and returned; ask again and you get
the stored one
[t: tests/optimizing/infra/analysis-manager.test.ts > "computes an analysis once and caches the result"].
The cache is `Map<symbol, unknown>` (`:29`), which would normally force a cast at every call
site. It does not, because of the key type:

```ts
export type AnalysisId<T> = symbol & { readonly __analysisResult?: T };

export function analysisId<T>(name: string): AnalysisId<T> {
  return Symbol(name) as AnalysisId<T>;
}
```
— `src/optimizing/infra/analysis-manager.ts:1-5`

The `T` is a phantom: `__analysisResult` is optional and never assigned, so at run time an
`AnalysisId<DominatorTree>` is an ordinary `Symbol("dominance")` and nothing more. At compile
time it carries the result type, so `analyses.get(dominanceAnalysisId)` is typed
`DominatorTree` and `analyses.get(loopForestAnalysisId)` is typed `LoopForest`, with the one
cast confined to the inside of `get`. The symbol's `description` is the name that appears in
traces, via `analysisName` (`src/optimizing/infra/pass-trace.ts:31-33`).

Because `run` receives the manager itself (`analysis-manager.ts:9`), an analysis may ask for
another analysis through the same cache. `loopForestAnalysis` asks for
`dominanceAnalysisId`, because a back edge is defined in terms of dominance
([Ch 42 § loops]). The cache is therefore transitive: requesting the loop forest can populate
the dominator tree as a side effect
[t: tests/optimizing/infra/analysis-manager.test.ts > "resolves a transitive analysis dependency through the manager"].
An unregistered id is not silently `undefined` — `AnalysisRegistry.resolve` throws
`No analysis registered for ${id.description ?? "anonymous"}`
[t: tests/optimizing/infra/analysis-manager.test.ts > "throws when resolving an unregistered analysis"].

Six analyses are registered (`src/optimizing/analyses/index.ts:10-19`): `aot-legality`,
`dominance`, `loops`, `points-to`, `mod-ref` and `type-inference`. Five of those are what
middle-end passes name in `requires`. The sixth, `aot-legality`, is asked for by the native
backend at emission time (`src/optimizing/machine/backend.ts:323`), which is why it is
registered here and never appears in a `requires` list.

## Remarks are English addressed to a programmer

A pass that declines to do something knows why, and the reason is usually more useful than
the fact. `RemarkRecorder` is where that reason goes.

```ts
  record(kind: RemarkKind, subject: RemarkSubject | null, message: string): void {
    const scope = this.scope;
    if (scope === null) return;
    const node = subjectId(subject);
    const key = `${kind} ${node} ${message}`;
    if (scope.seen.has(key)) return;
    if (scope.collected.length >= REMARK_BUDGET) {
      scope.dropped++;
      return;
    }
    scope.seen.add(key);
    scope.collected.push({ kind, pass: scope.pass, node, message });
  }
```
— `src/optimizing/infra/pass-remarks.ts:63-75`

Three kinds — `missed`, `applied`, `analysis` (`:1`) — with `missed` and `applied` reached
through one-line helpers. Four properties fall out of those thirteen lines.

**Recording is free when nobody listens.** `if (scope === null) return` is the first
statement, and `PassManager` opens a scope only when `tracing !== null`. A pass may call
`remarks.missed(...)` on every node of every function in a production compile and the cost is
a null check
[t: tests/optimizing/infra/pass-manager.test.ts > "keeps the recorder shut when nobody is tracing"]
[t: tests/optimizing/infra/pass-remarks.test.ts > "drops everything recorded while no pass scope is open"].

**Duplicates collapse.** The dedup key is `` `${kind} ${node} ${message}` `` — kind, node id
and the message text. Reaching the same conclusion about the same node twice produces one
line
[t: tests/optimizing/infra/pass-remarks.test.ts > "keeps one copy when the same decision is reached about the same node twice"].

**There is a cap, and overflow is reported rather than hidden.** `REMARK_BUDGET = 64` (`:14`).
Past it, `dropped` is counted and `close()` appends one synthetic `analysis` remark reading
`"N further remarks were not recorded"` (`:52-60`)
[t: tests/optimizing/infra/pass-remarks.test.ts > "stops at the budget and says how many it left out"]
[t: tests/optimizing/infra/pass-remarks.test.ts > "adds no overflow note when the pass stayed inside the budget"].

**Scopes nest.** `open_` is a stack and `scope` is its top, so when a module-level stage runs
a pipeline inside itself, a remark lands on the innermost pass rather than the outer stage
[t: tests/optimizing/infra/pass-remarks.test.ts > "gives a remark to the innermost pass when a stage runs a pipeline inside itself"].

The whole compile of `stats.tera` emits thirty remark lines. Here are two of them, verbatim:

```
remark missed: loop B5 has no branch whose condition is computed outside the loop, so there is nothing to hoist
remark applied: turned the branch at B4 into selects: both arms are cheap enough to run unconditionally, so the branch is gone
```

The first is `loop-unswitching` explaining, for one loop, exactly which precondition failed.
The second is `if-conversion` in the legalization pipeline saying what it did and on what
grounds. Neither is a log line; both are sentences addressed to a person who wanted an
optimization and did not get it — the same register as a compiler diagnostic, and for the
same reason ([Ch 1 § the-gate]).

## Opt-bisect {#opt-bisect}

> **New idea. Bisecting a compiler.** You have a program that answers correctly with
> optimization off and incorrectly with it on. Thirty-four passes ran. Which one broke it?
> The bisect trick, taken from LLVM's `-opt-bisect-limit`, is to make the compiler run only
> the first *N* optional passes and skip the rest, then binary-search *N* over the answer.
> Roughly log₂(34) ≈ 6 compiles localize the fault to a single pass. It works only if the
> compiler can be told "run fewer passes" without becoming *unable to compile*, which is why
> the mechanism has two halves: a counter, and a per-pass declaration of whether skipping is
> allowed.

The counter is seventeen lines.

```ts
export class OptBisect {
  private attempted = 0;

  constructor(private readonly limit: number) {}

  static unlimited(): OptBisect {
    return new OptBisect(Number.POSITIVE_INFINITY);
  }

  get attempts(): number {
    return this.attempted;
  }

  allow(): boolean {
    return ++this.attempted <= this.limit;
  }
}
```
— `src/optimizing/infra/opt-bisect.ts:1-17`

`allow()` increments first and compares second, so it says yes to the first `limit` callers
and no forever after. `attempts` keeps counting past the limit, which is how a driver
discovers how many optional passes there were in total without running them.

The gate is one line in `step`:

```ts
    if (pass.optional === true && this.options.optBisect !== null && !this.options.optBisect.allow()) {
```
— `src/optimizing/infra/pass-manager.ts:73`

Three conditions, and the first is the safety property. **Only a pass that declares itself
optional is skippable.** `grep -rn "optional: true" src/optimizing/` returns exactly one hit:
`src/optimizing/pipeline.ts:90`, inside the `step()` helper — so every middle-end pass is
optional, all thirty-four of them, by construction. `src/optimizing/target/legalization.ts`
contains **zero** `step(` calls; its forty-one passes are object literals with a `name:`
field, and none of them sets `optional`. A legalization pass rewrites an opcode the target
cannot emit into ones it can; skipping
one does not produce a slower binary, it produces no binary
([Ch 51](../part-08-wasm/51-legalizing-for-a-target.md)). The type makes `optional`
`?: boolean`, so the safe answer is the default, and the unsafe answer has to be written out
[t: tests/optimizing/infra/pass-manager.test.ts > "never skips a pass the pipeline needs, whatever the bisect limit"].

Two more properties matter for anyone driving a bisect. The counter is shared across every
pipeline a single `CompilerOptions` is handed to, so a limit spent on one function's middle
end is spent for the next function too
[t: tests/optimizing/infra/pass-manager.test.ts > "spends one bisect budget across every pipeline it is handed to"].
And because the ordinal is assigned before the gate, a pass reported at `#19` under an
unlimited run is still `#19` under a limit of 4 — it is just marked `skipped by bisect`
(`src/optimizing/infra/pass-trace.ts:46-48`)
[t: tests/optimizing/infra/pass-trace.test.ts > "names bisect as the reason a pass did nothing"].

> **Never runs.** `CompilerOptions.optBisect` has no CLI flag. There is no
> `--opt-bisect-limit` in `src/cli/spec.ts`, and `grep -rn optBisect src/` finds it only in
> `options.ts` and the gate itself. The only drivers are the library API and
> `tools/visualizer/src/workers/bisect.ts` (and `workers/observe.ts`). Cost to finish: one
> option in the CLI spec, threaded into `aotCompilerOptions`. Chapter 77 is the chapter that
> uses it ([Ch 77 § bisecting]).

## The pipeline: three phases {#the-pipeline}

`middleEndPhases(options)` returns three `OptimizationPhase` records
(`src/optimizing/pipeline.ts:103-276`):

| Phase | Passes | What it is for |
| --- | --- | --- |
| `high-level-optimization` | 9 | guards, IC lowering, LICM, unswitching, first narrowing |
| `canonicalization` | 19–20 | folding, memory, GVN, checks, phi and dead-code cleanup |
| `late-optimization` | 5 | dead stores, dead code, unreachable blocks, cleanup |

The canonicalization range is the only place the two roads out of the middle end differ in
*which* passes run. Two gates:

```ts
export function staticCompilerOptions(
  base: CompilerOptions = compilerOptions("speed"),
): CompilerOptions {
  return { ...base, sinkAllocations: false, deoptimizes: false };
}
```
— `src/optimizing/optimizer.ts:36-40`

`sinkAllocations: false` drops `allocation-sinking` from the array entirely
(`pipeline.ts:195-197`), so the AOT road runs **33** passes where the JIT runs **34**.
`deoptimizes: false` does not remove a pass; it forces one pass's budget:
`const unswitchBudget = options.deoptimizes ? 0 : options.unswitchBudget` (`pipeline.ts:110`).
`loop-unswitching` still runs on the JIT road, and immediately returns `0` because its budget
is zero. `scalarReplaceAggregates` is a third gate (it removes `escape-analysis` and
`escape-analysis-late`, two passes), but both roads have it on, so no configured road reaches
the seventeen-pass canonicalization the type permits. That is why the table's range is 19–20
and not 17–20: canonicalization is `#9` through `#27` on the AOT road, and the same nineteen
plus `allocation-sinking` on the JIT road.

Now the arithmetic, because the book's own front matter gets it wrong.

`docs/README.md:47` says the shared middle end has **"60 passes, 11 analyses"**. Those
numbers are *directory sizes*: `src/optimizing/passes/` holds 60 files and
`src/optimizing/analyses/` holds 11 besides `index.ts`. They are true and they are not the
pipeline. The pipeline runs 34 registered transform passes on the JIT road and 33 on the AOT
road, drawn from those 60 files with reuse — `eliminateTrivialPhis` is registered four times
under four names, `deadCodeElimination` three times,
`sparseConditionalConstantPropagation` twice — and it asks for **6** registered analyses, not
11. Where the two counts disagree, the
pipeline count is the one this book uses, because it is the number of times something runs.

## Ordinals {#ordinals}

Ordinals are per-`PassManager` instance, not per-phase. `runMiddleEnd` builds one manager and
calls `run` three times, once per phase:

```ts
  const passManager = cfgPassManager(analyses, options);
  for (const pipelinePhase of middleEndPhases(options)) {
    passManager.run(graph, pipelinePhase.passes);
  }
  return analyses;
```
— `src/optimizing/pipeline.ts:341-345`

So numbering is continuous across the three phases: `#0` `parameter-type-guards` through
`#32` `dead-code-elimination-after-unreachable`, with no restart at a phase boundary
[t: tests/optimizing/infra/pass-trace.test.ts > "numbers records continuously across separate pipeline runs"].
The target legalization pipeline runs under a *different* manager, constructed per function
in the AOT driver — `cfgPassManager(analyses, opts).run(graph, backend.loweringPipeline(opts))`
(`src/optimizing/drivers/aot.ts:772`) — so its ordinals restart at `#0`. That is why a
`--print-after-all` dump shows two different passes at ordinal `#9`: `sccp` in the middle end
and `math-surface` in legalization. The same `AnalysisManager` is carried across
(`aot.ts:765-766`), so the analysis cache survives the handover even though the ordinal
counter does not.

Note what `runMiddleEnd` returns: the `AnalysisManager`, not the graph. The graph was mutated
in place. The manager is the thing worth handing on, because its cache is warm with whatever
the last pass did not invalidate, and the backend will ask it for `aot-legality` and
`type-inference` again.

## Thirty-three passes over Series.mean

Here is the whole mechanism on one function. `Series.mean` is the loop at the centre of
`stats.tera`; on the AOT road its middle-end trace is thirty-four sections — the builder's
graph as the synthetic `#-1`, then one per pass from `#0` to `#32` — of which **six** say
`changed`. Five of the six are real passes:

```
*** IR after #-1 ir-builder [changed, nodes 26 -> 26 (+0), invalidated nothing] ***
*** IR after #5 licm [changed, nodes 26 -> 26 (+0), invalidated type-inference points-to mod-ref] ***
*** IR after #8 type-narrowing [changed, nodes 26 -> 26 (+0), invalidated type-inference] ***
*** IR after #19 int32-overflow-widening [changed, nodes 26 -> 26 (+0), invalidated dominance loops points-to mod-ref] ***
*** IR after #23 dead-phi-elimination [changed, nodes 26 -> 23 (-3), invalidated nothing] ***
*** IR after #27 dead-code-elimination-after-late-escape [changed, nodes 23 -> 20 (-3), invalidated points-to] ***
```

Twenty-six nodes in, twenty out. Read the `invalidated` column against the `preserves`
declarations and the whole protocol is visible.

`#5 licm` declares `preservesControlFlow`, so `invalidateExcept({dominance, loops})` runs. The
cache at that moment holds `loops`, `points-to` and `mod-ref` — the three `licm` itself
required — plus `type-inference`, left over from `#4 builtin-method-lowering`. Three are
dropped; `loops` survives because it is preserved. Hoisting a value out of a loop does not
change which block dominates which, and the manager is told so.

`#8 type-narrowing` also declares `preservesControlFlow`, but by then the only non-preserved
thing in the cache is `type-inference`, which `#8` required and therefore recomputed. So the
line reads `invalidated type-inference`: one entry, dropped immediately after being built. It
will be rebuilt the next time anything asks.

`#19 int32-overflow-widening` declares `{kind:"none"}` and drops all four cached analyses.
That pass rewrites arithmetic whose overflow it cannot prove ([Ch 48 § settle-int32]) and
can restructure control flow doing it, so it claims nothing.

`#23 dead-phi-elimination` removes three nodes and reports `invalidated nothing`. It declares
`preservesControlFlow`, and at that point the cache held only `dominance` and `loops` — both
preserved. This is the reading trap named in § preserves: the trace reports what
left the cache, so "invalidated nothing" here means "there was nothing left to invalidate",
not "this pass preserves everything".

Across all twenty-one functions the picture is the same. Twelve of the thirty-three
middle-end passes changed anything on any function, ever:

```
16 dead-code-elimination-after-late-escape   3 builtin-method-lowering
12 type-narrowing                            2 gvn
11 dead-phi-elimination                      1 strength-reduction
 9 licm                                      1 sccp
 8 trivial-phi-elimination-early             1 load-elimination
 7 int32-overflow-widening
 5 parameter-type-guards
```

Twenty-one of the thirty-three fired on nothing. `bounds-check-elimination` is among them,
and it fires on nothing for a structural reason chapter 46 is about
([Ch 46 § bounds-check-elimination]). The other twenty are simply insurance that was not
needed by these twenty-one functions, which is what a pipeline mostly is. Counts were taken
from one `--print-after-all` run in a fresh process; the ordering is deterministic and three
repeats agreed.

## Where the tracer comes from {#where-the-tracer-comes-from}

`CompilerOptions` has four tracer fields (`src/optimizing/options.ts:31-34`): `passTracer`,
`machineTracer`, `allocationTracer` and `moduleTracer`. Exactly one of them is reachable from
the command line, and it is reachable from exactly one place in `src/`:

```ts
function aotCompilerOptions(
  config: Pick<CompileConfig, "verify" | "printAfterAll" | "textBytes">,
): { compilerOptions?: CompilerOptions } {
  if (!config.verify && !config.printAfterAll && config.textBytes === null) return {};
  return {
    compilerOptions: compilerOptions("speed", {
      verifyEachPass: config.verify,
      passTracer: config.printAfterAll ? consolePassTracer(cfgGraphProbe) : null,
      ...(config.textBytes === null ? {} : { textBufferBytes: config.textBytes }),
    }),
  };
}
```
— `src/cli/compile.ts:37-48`

`--print-after-all` and `--verify` are options of the **`compile`** command only. On the run
path they are rejected:

```
$ node dist/cli.js --print-after-all docs/example/stats.tera
tera: unknown option '--print-after-all' for 'run' (see 'tera help run')
$ echo $?
2
```

So the JIT road's pass pipeline cannot be traced from the CLI at all. Everything printed in
this chapter came off the AOT road. The other consumer of the same records is
`tools/visualizer`, which sets `passTracer`, `moduleTracer` and `optBisect` through the
library API ([Ch 76 § replaying-passes]).

> **Never runs.** `PassTraceRecord.elapsedMs` (`src/optimizing/infra/pass-trace.ts:14`) is
> measured on every traced pass (`pass-manager.ts:95,101`) and pinned by a test
> [t: tests/optimizing/infra/pass-manager.test.ts > "times each pass it traces"], but
> `formatPassTrace` (`pass-trace.ts:50-60`) never renders it. `--print-after-all` therefore
> prints no timings. The only consumers in the tree are both in `tools/visualizer`, and they
> reach the field two different ways: `src/components/StageViewer.tsx:173-175` reads
> `stage.elapsedMs` **directly** to print a per-stage duration, while
> `src/components/CostView.tsx` reads it through `src/services/pass-cost.ts`. Finishing it is
> one interpolation in `formatPassTrace`, plus a decision about whether wall-clock noise
> belongs in output people diff.

> **Never runs.** `CompilerOptions.moduleTracer` has no CLI flag. Nothing in `src/` sets it —
> `src/optimizing/drivers/aot.ts:674` only reads it — and `consoleModuleTracer`
> (`src/optimizing/drivers/module-trace.ts:26-28`) has no caller. The only setter in the tree
> is `tools/visualizer/src/workers/compiler-worker.ts:741`. Every remark recorded by a
> module-level stage is therefore unreachable from the command line, including every remark
> from `inlineKnownCalls` ([Ch 50](50-inlining-and-tail-calls.md)) and from
> `promise-surface`. Cost: one flag in `src/cli/spec.ts` and a console sink that already
> exists.

## What leaves

The same `CFGFunction` object, mutated in place by 34 transform passes on the JIT road or 33
on the AOT road: guards inserted where a declared parameter needs one, inline caches lowered
to explicit map checks, loop-invariant values hoisted, arithmetic narrowed and — where
overflow could not be proved — widened again, phis folded, dead code and unreachable blocks
gone. On `Series.mean` that is twenty-six nodes reduced to twenty.

Alongside it, an `AnalysisManager` whose cache holds whatever the last pass did not
invalidate, and which `runMiddleEnd` returns *instead of* the graph. Both roads carry that
manager forward: the AOT driver reuses it for the legalization pipeline and hands it to the
backend, which asks it for `aot-legality`.

And one obligation, restated because everything after this depends on it. Every pass in
chapters 43 through 50 must return a truthful `changed`, must declare a `preserves` it can
justify, and must treat a frame state as a use ([Ch 40 § the-second-use-graph]). Nothing
checks any of the three. The next chapter is the six analyses those passes ask for and the
one cache that holds them — what a pass is allowed to *know* before it is allowed to act
([Ch 42 § dominance]).

## Verify it yourself

```bash
# 1,575 sections: 21 functions x (1 builder + 33 middle-end + 41 legalization)
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep -c '^\*\*\* IR after'

# which passes ever changed anything, and how often (210 lines' worth; 1365 said unchanged)
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | grep '\[changed' \
  | sed 's/^\*\*\* IR after #[-0-9]* \([a-zA-Z0-9-]*\) .*/\1/' | sort | uniq -c | sort -rn

# thirty remark lines, nineteen distinct after sort -u: passes explaining themselves in English
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^remark' | sort -u

# --verify checks SSA invariants after every pass that changed the graph (exit 0);
# both flags are compile-only, so the second line is rejected with exit 2
node dist/cli.js compile docs/example/stats.tera --emit source --verify -o /tmp/stats-v
node dist/cli.js --print-after-all docs/example/stats.tera

# only optional passes are skippable, only pipeline.ts marks any, legalization marks none
grep -rn "optional: true" src/optimizing/ ; grep -c "optional" src/optimizing/target/legalization.ts

# the manager, the cache, the recorder, the tracer, the bisect gate (113 tests)
npx vitest run --project unit tests/optimizing/infra/ tests/optimizing/pipeline.test.ts \
  tests/optimizing/pipeline-order.test.ts
```

## Tests that pin this

- `tests/optimizing/infra/pass-manager.test.ts` > `"preloads required analyses before running a transform pass"` — `requires` is prefetched before `run`, not lazily inside it.
- `tests/optimizing/infra/pass-manager.test.ts` > `"maintains the graph only after a pass that changed it"` — the `maintain` hook is guarded by `outcome.changed`.
- `tests/optimizing/infra/pass-manager.test.ts` > `"runs no maintenance at all when nothing changes"` — the guard, from the other side.
- `tests/optimizing/infra/pass-manager.test.ts` > `"verifies a graph only after a pass that changed it"` — `--verify` inherits the same guard.
- `tests/optimizing/infra/pass-manager.test.ts` > `"traces the graph that broke an invariant before it throws"` — the dump precedes the `VerificationError`.
- `tests/optimizing/infra/pass-manager.test.ts` > `"invalidates every analysis except preserved analyses under only preservation"` — `preservesControlFlow`.
- `tests/optimizing/infra/pass-manager.test.ts` > `"invalidates only the listed analyses under allExcept"` — the fourth `Preservation` shape.
- `tests/optimizing/infra/pass-manager.test.ts` > `"invalidates every analysis under a none preservation"` — `invalidatesAnalyses`.
- `tests/optimizing/infra/pass-manager.test.ts` > `"runs no pass past the bisect limit"` — `allow()` says yes exactly `limit` times.
- `tests/optimizing/infra/pass-manager.test.ts` > `"spends one bisect budget across every pipeline it is handed to"` — the counter lives on the options, not the manager.
- `tests/optimizing/infra/pass-manager.test.ts` > `"gives a pass the same ordinal whatever the bisect limit is"` — the ordinal is assigned before the gate.
- `tests/optimizing/infra/pass-manager.test.ts` > `"never skips a pass the pipeline needs, whatever the bisect limit"` — a pass without `optional: true` always runs.
- `tests/optimizing/infra/pass-manager.test.ts` > `"times each pass it traces"` — `elapsedMs` is measured, even though nothing prints it.
- `tests/optimizing/infra/pass-manager.test.ts` > `"does not leak a throwing pass's remarks into the next run"` — `remarks.close()` is in a `finally`.
- `tests/optimizing/infra/pass-manager.test.ts` > `"keeps the recorder shut when nobody is tracing"` — no scope is opened when `tracing` is null.
- `tests/optimizing/infra/pass-remarks.test.ts` > `"drops everything recorded while no pass scope is open"` — recording outside a scope costs a null check.
- `tests/optimizing/infra/pass-remarks.test.ts` > `"keeps one copy when the same decision is reached about the same node twice"` — the `kind node message` dedup key.
- `tests/optimizing/infra/pass-remarks.test.ts` > `"stops at the budget and says how many it left out"` — `REMARK_BUDGET = 64` plus the overflow note.
- `tests/optimizing/infra/pass-remarks.test.ts` > `"adds no overflow note when the pass stayed inside the budget"` — no note when `dropped === 0`.
- `tests/optimizing/infra/pass-remarks.test.ts` > `"gives a remark to the innermost pass when a stage runs a pipeline inside itself"` — scopes are a stack.
- `tests/optimizing/infra/analysis-manager.test.ts` > `"computes an analysis once and caches the result"` — the lazy memo.
- `tests/optimizing/infra/analysis-manager.test.ts` > `"resolves a transitive analysis dependency through the manager"` — an analysis may ask for another.
- `tests/optimizing/infra/analysis-manager.test.ts` > `"throws when resolving an unregistered analysis"` — a missing registration is an error, not `undefined`.
- `tests/optimizing/infra/pass-trace.test.ts` > `"numbers records continuously across separate pipeline runs"` — ordinals are per-manager, not per-phase.
- `tests/optimizing/infra/pass-trace.test.ts` > `"leaves dumping to the sink so an unused dump costs nothing"` — `probe.dump` is called by the tracer, not by the manager.
- `tests/optimizing/infra/pass-trace.test.ts` > `"names bisect as the reason a pass did nothing"` — `skipped by bisect` in the formatted line.
- `tests/optimizing/pipeline.test.ts` > `"invalidates analyses when a real pass mutates the graph"` — `sccp`, not a mock.
- `tests/optimizing/pipeline.test.ts` > `"keeps analyses cached when a real pass makes no change"` — the same pass on a graph it cannot improve.
- `tests/optimizing/pipeline.test.ts` > `"attributes each change and invalidation to the pass that caused it"` — the trace line's two fields.
- `tests/optimizing/pipeline.test.ts` > `"prints exactly one section per middle-end pass"` — one dump per pass, changed or not.
- `tests/optimizing/pipeline.test.ts` > `"opens with the graph the builder produced, before any pass ran"` — the synthetic `#-1 ir-builder` record.
- `tests/optimizing/pipeline.test.ts` > `"names the pass that left the graph inconsistent"` — `${graph.name} after ${pass}: ${message}`.
- `tests/optimizing/pipeline.test.ts` > `"leaves the graph unchecked when verification is off"` — `verify` is `null` unless `--verify`.
- `tests/optimizing/pipeline-order.test.ts` > `"cannot hoist a value carried through an untouched loop-header phi"` — order is a correctness property.
- `tests/optimizing/pipeline-order.test.ts` > `"hoists that same value once trivial phis have been eliminated first"` — the same graph, one pass earlier.
- `tests/optimizing/drivers/module-trace.test.ts` > `"names each module transform in the order the driver runs them"` — the module tracer nothing in `src/` installs.
