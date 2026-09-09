# Part VII — The graph is optimized   ⟨· · J · N⟩

> **Status:** written

**What arrived.** One `CFGFunction` per function, in canonical-phi SSA, from Part VI: blocks
with explicit predecessor and successor edges, every value defined once, phis whose input
lists are positionally parallel to their block's predecessor lists, node ids stamped by the
ambient allocator, and a `FrameState` hanging off every node that can give up
([Ch 40 § the-second-use-graph]). Frame states are intact on **both** roads at this point; the
native road does not discard them until legalization, long after this part is over.

**What leaves.** The same object, mutated in place, plus one cache:

1. **A smaller, more specific `CFGFunction`.** Generic arithmetic specialised where a proof
   allowed it, redundant loads and dead stores gone, some allocations gone entirely, guards
   hoisted or peeled out of loops where they could be proved once, congruent computations
   collapsed onto one leader, constants folded, unreachable blocks removed, and — on the wasm
   road only — every surviving node stamped with a representation.
2. **An `AnalysisManager`.** `runMiddleEnd` returns the *manager*, not the graph, because the
   graph was mutated in place and the cache is the thing worth handing on
   ([Ch 41 § ordinals]). Both roads carry it forward.
3. **One promise, and one rule.** Every frame state that named an object scalar replacement
   deleted carries a `sunkAllocations` entry that will rebuild a real `JSObject` on the
   bailout path ([Ch 45 § the-promise-recordvirtualstate]). And every fold from here on owes
   `isSpeculative` a question before it owes anything else
   ([Ch 49 § the-single-consumer]).

## What this stage owes everything downstream

- **One middle end, two machines.** Everything in Part VII runs on that one graph, and the
  same pipeline — `middleEndPhases` in `src/optimizing/pipeline.ts`, three phases, numbered
  continuously with no restart at a phase boundary (`#0` through `#32` on the AOT road) — runs
  whether the graph is on its way to WebAssembly or to an ELF/PE binary. **34 passes on the
  JIT road, 33 on the AOT road**, drawn with reuse from the 60 files in
  `src/optimizing/passes/` (`eliminateTrivialPhis` is registered four times under four names),
  asking **6** registered analyses
  ([Ch 41 § the-pipeline]). Part VIII and Part IX differ in what they do *after* this, not
  during it.
- **Two option flags split the roads, and each has exactly one reader.**
  `staticCompilerOptions` (`src/optimizing/optimizer.ts:36-40`) sets `sinkAllocations: false`
  and `deoptimizes: false`, against defaults of `true` for both. `sinkAllocations` is read at
  `pipeline.ts:195`, and dropping `allocation-sinking` is the whole of the 34-versus-33
  difference. `deoptimizes` is read at `pipeline.ts:110` and nowhere else in `src/`; it forces
  `unswitchBudget` from the `speed` preset's 48 down to 0, so `loop-unswitching` still runs on
  the JIT road and immediately returns `0` ([Ch 46 § unswitching-and-the-line-that-turns-it-off]).
  Everything else is literally the same code on the same graph.
- **Frame states are the currency, and `changed` is the fuse.** A pass that moves, deletes or
  merges a value must keep every frame state that names it answerable, because
  `node.uses.length === 0` is not a test for death. Two passes are defined by that rule — LICM
  refuses to hoist anything carrying a frame state ([Ch 46 § licms-first-gate-is-a-frame-state]),
  and guard peeling *requires* one ([Ch 46 § peeling-is-the-exact-complement]). And the boolean
  a pass returns about itself switches four mechanisms on or off at once: graph repair,
  verification, the frame-state index rebuild, and analysis-cache invalidation
  ([Ch 41 § changed]). Nothing checks that boolean, and nothing checks the `preserves`
  declaration beside it ([Ch 41 § preserves]).
- **Speculative types are not facts, and the distinction is computed here.** `TypeInference`
  answers two questions per node — `typeOf` and `isSpeculative` — and the second exists because
  the JIT may act on a guess a guard can undo and the native compiler may not
  ([Ch 42 § type-inference], [Ch 49 § the-taint-set]). That is the book's hinge in one bit per
  node.
- **Nothing here decides *whether* a function compiles.** Legality is Part IX's job
  ([Ch 56](../part-09-ahead-of-time/56-legality-and-the-art-of-refusing-well.md)); the
  `aot-legality` analysis is registered in this part's registry but asked for only by the
  native backend at emission time ([Ch 41 § analysis-manager]). Representation *selection* is a
  legalization pass, not a middle-end one, and it is spliced in only for a target that declares
  `tagged-values` ([Ch 48 § repr-selection]).
- **Inlining is not one of the 33.** `passes/inlining.ts` runs at *module* level, bottom-up
  over a call graph, outside `middleEndPhases`, and the functions it rewrites go through the
  middle end a second time ([Ch 50 § module-level-bottom-up-and-the-pipeline-that-runs-twice]).
  The JIT's inliner is a different program in a different file at a different stage
  ([Ch 50 § two-inliners-one-book-chapter]).

## Which of the four machines this constrains

| Ch | Title | Badge | Why |
| --- | --- | --- | --- |
| 41 | [The pass manager](41-the-pass-manager.md) | ⟨· · J · N⟩ | one `PassManager` class, both compiling tiers |
| 42 | [The analyses everything stands on](42-the-analyses-everything-stands-on.md) | ⟨· · J · N⟩ | one shared analysis cache |
| 43 | [SCCP](43-sccp.md) | ⟨· · J · N⟩ | same pass, both pipelines |
| 44 | [GVN-PRE](44-gvn-pre.md) | ⟨· · J · N⟩ | same pass, both pipelines |
| 45 | [Memory](45-memory-what-a-load-can-be-told.md) | ⟨I · · J · N⟩ | scalar replacement is shared; the materializer rebuilds an **interpreter** object |
| 46 | [Loops](46-loops-and-the-optimization-that-cannot-fire.md) | ⟨· · J · N⟩ | unswitching is AOT-only by budget; BCE fires on neither road |
| 47 | [Simplification and dead code](47-simplification-dead-code-and-the-identities-that.md) | ⟨· · J · N⟩ | same passes, both pipelines |
| 48 | [Types and representations](48-types-and-representations-in-the-middle-end.md) | ⟨· · J · N⟩ narrowing, ⟨· · J⟩ repr selection | reps are gated on the `tagged-values` capability, which only wasm declares |
| 49 | [Speculative types are not facts](49-speculative-types-are-not-facts.md) | ⟨· · J · N⟩ | the chapter *is* the difference between the two |
| 50 | [Inlining and tail calls](50-inlining-and-tail-calls.md) | ⟨· · J · N⟩ | two inliners, one per road |

**The baseline compiler ⟨B⟩ appears nowhere in this part.** `src/optimizing/baseline/compiler.ts`
imports nothing from `src/optimizing/ir/`; it goes from bytecode straight to a JavaScript source
string ([Ch 36 § why-emit-source]). The interpreter ⟨I⟩ appears once, and only as a
*destination*: [Ch 45 § redeeming-the-promise-objectmaterializer] rebuilds an interpreter
object out of a frame state after an allocation this part deleted. Neither ever sees a
`CFGFunction`.

## The chapters

**41 and 42 are infrastructure**, and they are first because every later chapter is a pass or
an analysis and would otherwise have to re-explain the frame it runs in. [Ch 41] is what a pass
*declares* — a name, a `preserves` claim, a `requires` list, an `optional` flag — and the
twelve-step `step` that runs it, ordinal assigned before the bisect gate, analyses prefetched
before `run`, and the graph dumped before the verifier throws ([Ch 41 § step-order]). Its thesis
is one measurement: of 1,554 real pass runs on `stats.tera`, 189 did anything at all, which is
why maintenance, verification and invalidation are all guarded by `outcome.changed` — and why a
pass that lies about that boolean corrupts a graph silently ([Ch 41 § changed]).
[Ch 42] is the six analyses those passes ask for, each narrower than its name: Cooper–Harvey–Kennedy
dominance with an Euler numbering that makes `dominates` two integer comparisons
([Ch 42 § dominance]), an LLVM-shaped loop forest whose most consequential output is whether a
*preheader* happens to exist ([Ch 42 § loops]), Andersen points-to with one Steensgaard rule
deliberately put back, and a memory model that is a **string** — `alloc:17|slot:0`
([Ch 42 § one-string-key]).

**43 through 47 are the passes.** [Ch 43 § why-constants-and-reachability-must-be-solved-together]
is why SCCP solves two problems in one fixpoint rather than two passes in sequence.
[Ch 44 § value-numbering] collapses congruent computations, then spends most of its length on
the harder half — anticipability, phi translation per predecessor, and the critical edge you
have to split before you can insert anything on it
([Ch 44 § a-critical-edge-and-why-you-cannot-insert-on-one]). [Ch 45] is three passes sharing one
dataflow driver and one string key ([Ch 45 § a-snapshot-dataflow]), ending in the pass that
deletes an object and promises to rebuild it ([Ch 45 § the-nine-refusals-read-as-a-specification]).
[Ch 46] is the part's honesty chapter: bounds-check elimination is complete, tested, wired into
the pipeline at ordinal 17, and has never removed a bounds check, for a structural reason
([Ch 46 § it-has-never-removed-one]). [Ch 47] takes the textbook identity list and reads it
mostly as a list of bugs — IEEE-754 has two zeros and a value not equal to itself
([Ch 47 § the-identities-that-are-deliberately-absent-read-off-their-own-test-titles]) — and
finds that ten of the thirty-three passes are dead-code sweepers
([Ch 47 § the-dce-family-is-ten-of-the-thirty-three-passes]).

**48, 49 and 50 are where the two roads start to be visible.** [Ch 48 § settle-int32] narrows
generic arithmetic on both roads; [Ch 48 § repr-selection] runs on neither by default and on
exactly one by capability, which is the first place in the book a pass exists for one back end
only ([Ch 48 § where-this-leaves-the-two-roads]). **[Ch 49] is this part's load-bearing
chapter**: a type that is true *because a guard says so* is not the same kind of fact as a type
that was proved, the difference is one bit per node, and the wrong answer that comes out when a
pass forgets to ask for it is a real bug told as engineering
([Ch 49 § this-is-the-hinge-in-miniature], [Ch 49 § what-the-taint-set-does-not-cover]).
[Ch 50] closes the part with a cost model, two splices and a nested frame-state chain
([Ch 50 § the-cost-model-arithmetic-first]), and one thing that is not here at all: a machine
tail call ([Ch 50 § what-is-not-here-a-machine-tail-call]).

## What this part deliberately is not

- **Not a scheduler.** Values are pinned to a block and to an index in that block's node list,
  and every pass is responsible for keeping program order legal. The one scheduler in the tree
  runs on MachineIR, long afterwards ([Ch 65 § why-schedule-at-all]).
- **Not verified.** `--verify` runs `validateGraphInvariants` after every pass that reported a
  change, and it checks SSA structure — that uses dominate definitions, that phi inputs are
  parallel to predecessors. It does not check that a `preserves` declaration was true, that a
  `changed` boolean was honest, or that a frame state still names a live node
  ([Ch 41 § changed], [Ch 40 § what-checks-this-and-what-does-not]).
- **Not target-aware.** No pass in `middleEndPhases` asks what the target is. The one gate that
  looks like it does — `deoptimizes` — is a question about whether a guard can *bail out*, not
  about which code generator is next.

## Where the running example cannot reach

`docs/example/stats.tera` compiles ahead of time and exercises the whole pipeline, and most of
this part's measurements come off exactly that run. But it is a twenty-four-line program, and
the pipeline is mostly insurance: **twelve of the thirty-three middle-end passes ever change
anything on any of its twenty-one functions**, and the other twenty-one fire on nothing
([Ch 41 § thirty-three-passes-over-seriesmean]). So four chapters reach past it, and each says
so in its opener:

- **Partial redundancy.** `stats.tera` contains no partially-redundant shape at all, so [Ch 44]'s
  PRE half works from the pass's own fixtures.
- **Deoptimization.** Scalar replacement's promise is only ever *called in* on the JIT road, and
  `stats.tera` never tiers up. [Ch 45]'s materializer sections and [Ch 46]'s peeling
  measurements use `docs/example/stats-deopt.tera`.
- **Representations.** `--print-after-all` on `tera compile` prints neither
  `representation-selection` nor `representation-check` and the string `_rep` appears nowhere in
  the dump, because the C target does not declare `tagged-values`; and on the JIT road
  `--print-ir` fires from `onOptimize`, before legalization runs. [Ch 48] says both out loud.
- **A bounds check that could be removed.** [Ch 46 § bounds-check-elimination] cannot show the
  optimization firing on any program, because it does not fire on any program.

## Verify it yourself

```bash
# 1,575 trace sections: 21 functions x (1 builder + 33 middle-end + 41 legalization).
# 210 say [changed; 1,365 say [unchanged.
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats \
  | grep -c '^\*\*\* IR after'
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats \
  | grep '^\*\*\* IR after' | grep -c '\[changed'

# which passes ever changed anything, and how often. Keep the ordinal, because three names
# (type-narrowing, builtin-method-lowering, dead-code-elimination) appear in BOTH pipelines:
# twelve middle-end ordinals ever fire, out of thirty-three.
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats \
  | grep '^\*\*\* IR after' | grep '\[changed' \
  | sed 's/^\*\*\* IR after \(#[-0-9]* [a-zA-Z0-9-]*\) .*/\1/' | sort | uniq -c | sort -rn

# the two flags that split the roads, and their single readers
grep -rn "sinkAllocations\|deoptimizes" src/optimizing/pipeline.ts src/optimizing/optimizer.ts

# neither representation pass runs for a native target, and no node is stamped
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats \
  | grep -c 'representation-selection\|_rep='

# the answer is unchanged by all of it
node dist/cli.js docs/example/stats.tera

npx vitest run --project unit tests/optimizing/infra tests/optimizing/analyses \
  tests/optimizing/passes tests/optimizing/pipeline.test.ts tests/optimizing/pipeline-order.test.ts
```

## What Parts VIII and IX receive

The same object, and this is the structural hinge of the book: **both roads out consume exactly
what Part VII produces, and nothing else.** One optimized `CFGFunction` in canonical-phi SSA,
frame states still attached, no representation stamps, no machine registers, no target opinion
anywhere in it — plus the warm `AnalysisManager` the middle end returned.

[Ch 51](../part-08-wasm/51-legalizing-for-a-target.md) runs a *second*, target-specific pipeline
over that graph — 41 more passes for a native target, 43 for wasm — under a different
`PassManager` whose ordinals restart at `#0` ([Ch 41 § ordinals]). Only after that do the roads
actually part: Part VIII hands the graph to a WebAssembly emitter that keeps every frame state
because a guard there is a bailout; Part IX hands it to MachineIR after `frame-state-elision` has
set every frame state to `null`, because no native target declares the `deopt` capability and a
guard there is an assertion that must be discharged or the function refused.

The graph does not know which of those is about to happen. That is the point of the part, and it
is why the two failure modes the rest of the book compares — *guess and check* versus *prove or
refuse* — can be attributed to the back ends rather than to the optimizer they share.
