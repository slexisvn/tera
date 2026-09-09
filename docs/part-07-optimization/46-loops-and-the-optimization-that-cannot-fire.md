# 46. Loops, and the Optimization That Cannot Fire   ⟨J · N⟩

Loops are where an optimizer earns its keep, because whatever you save inside one you save
every iteration. This chapter covers the four passes that act on loop structure, and three
of them turn on the same question from three directions: *what is safe to move out of a
loop, and what is only safe to copy?*

The answer is a frame state. Loop-invariant code motion refuses to hoist any node that
carries one, because a frame state describes a program point and a moved node describes the
wrong point. Guard peeling *requires* one, and requires more — that every value the frame
state names is already available in the preheader — because a guard peeled into the
preheader must be able to bail out into the same interpreter frame the in-loop guard would
have. The two passes are exact complements written in the same file, and the sentence that
separates them is one line long: `ir.isMovable(node) && node.frameState === null`.

The fourth pass is the chapter's title. `rangeAnalysisAndBoundsCheckElimination` is the
largest single function in the middle end — six hundred lines of interval arithmetic,
induction-variable detection, loop-guard indexing and three independent proofs that an index
is inside its array — and on this tree it has never removed a bounds check. Not because the
proofs are wrong. Because a numeric gate stands in front of them that the only fact capable
of proving the thing can never pass. That is not a war story with a fix at the end; it is a
design failure that is still open, and this chapter's job is to say exactly where it is.

**What arrived.** For LICM, the graph at ordinal #5, immediately after
`trivial-phi-elimination-early` (#3) and `builtin-method-lowering` (#4), with a `LoopForest`,
a `PointsToResult` and a `ModRef` in the pass manager's analysis cache
([Ch 42 § boundaries], [Ch 42 § mod-ref-the-oracle-three-passes-ask]). For the rest of the
chapter, the graph at ordinals #17 through #21 — after `gvn` at #16, so congruent
computations have already been collapsed onto one node each and the check keys this chapter
depends on are stable. `loop-unswitching` is the exception: it is ordinal #6, immediately
after LICM, and sees the same graph LICM leaves.

## Loop-invariant code motion

> **New idea.** *Loop-invariant code motion.* A computation inside a loop whose result is
> the same on every iteration can be computed once, before the loop starts, and read from
> there. The place to put it is the loop's **preheader** — the single block outside the loop
> whose only successor is the loop header ([Ch 42 § boundaries] derives it, and
> `preheader === null` is the most common reason both passes in this chapter decline). The
> transformation looks obvious and is not, because it has to answer two questions and only
> the first one is easy. *Is this value the same every iteration?* is a dataflow question.
> *Is it safe to compute it before the loop even runs?* is a semantics question, and it is
> where every real LICM gets hard: the loop might execute zero times, so anything hoisted
> now runs on paths where it would not have run at all.

`hoistLoopInvariants` handles the second question by refusing to move anything that could
be observed. Everything else in the pass is bookkeeping around that refusal.

The loops are visited innermost-first — `const loops = [...forest.loops()].reverse()` at
`src/optimizing/passes/loop-opts.ts:31`, because `LoopForest.loops()` yields them in
preorder and reversing it puts inner loops before their parents. Hoisting out of the inner
loop first leaves the value sitting in the inner preheader, which is inside the outer loop,
where the outer iteration can pick it up and hoist it again.

## LICM's first gate is a frame state

The whole safety argument is three lines:

```typescript
function isSideEffectFree(node: LoopNode): boolean {
  return ir.isMovable(node) && node.frameState === null;
}
```
— `src/optimizing/passes/loop-opts.ts:20-22`

`isMovable` comes from the operation table ([Appendix B](../appendix/b-ir-operations.md)):
a node is movable if it is not pinned, not a terminator, writes no memory and allocates
nothing. That is the ordinary half. The second conjunct is the one worth understanding.

A node carrying a frame state is a node that can give up. Its frame state is the answer to
"if this fails, what were the interpreter's locals and stack, and at which bytecode offset?"
— which is a statement about a **program point** ([Ch 40 § what-a-frame-state-holds]). Move
the node to the preheader and its frame state now describes a point the program was not at.
A bailout from the hoisted node would resume the interpreter at a bytecode offset inside the
loop body, with the loop's locals, having never entered the loop. LICM does not attempt to
rewrite the frame state, because there is no correct rewrite: the preheader is not any
bytecode offset the loop body has.

So it refuses, and `[t: tests/optimizing/passes/loop-opts.test.ts > "does NOT hoist node with frameState"]`
is the pin. The cost of that refusal on real code is not small, and the running example shows
it exactly.

Here are the two loop blocks of `Series.mean`'s graph as it enters LICM at ordinal #5, with
the entry block `B0` and the exit block `B1` left out:

```
  B2 succs=B3 preds=B3:
    v10 = GenericGetProp v0 [propName="values"] !fs
    v11 = GenericGetIndex v10, v5 !fs
    v12 = GenericAdd v4, v11
    v13 = Constant [value=1]
    v14 = GenericAdd v5, v13
    v21 = Jump [targetBlock=3]
  B3 loop-header succs=B2,B1 preds=B0,B2:
    v4 = Phi v1, v12 [index=0]
    v5 = Phi v2, v14 [index=1]
    v16 = Phi v15, v13 [index=2]
    v18 = Phi v17, v10 [index=3]
    v20 = Phi v19, v5 [index=4]
    v6 = GenericGetProp v0 [propName="values"] !fs
    v7 = GenericGetProp v6 [propName="length"] !fs
    v8 = GenericCompare v5, v7 [op="<"]
    v9 = Branch v8 [trueBlock=2, falseBlock=1]
```

`v6` and `v7` are `this.values.length`, recomputed on every iteration of the loop, from a
receiver the loop never writes. They are the textbook thing to hoist. LICM does not hoist
them, because both carry `!fs`. The one node it does move is `v13 = Constant [value=1]`,
which travels from B2 to B0 and changes nothing about what the loop does. The pass reports
`*** IR after #5 licm [changed, nodes 26 -> 26 (+0), invalidated type-inference points-to
mod-ref] ***` — a change that cost three analyses their cache entries.

That is not an isolated shape. Diffing every `--print-after-all` section pair across
`tera compile docs/example/stats.tera` (one run, 2026-09-08): LICM reports `changed` on nine
of the program's twenty-one graphs, and in eight of the nine every node it moved is an
`IR_CONSTANT`. The single non-constant hoist in the whole program is
`v262 = GenericSub v261, v236` in `_FixedDigits.format`, which moves from B33 to B30. Its
other input, `v236`, is defined in B24, outside the loop; `v261` is the constant that
travelled with it.

No claim follows about speed — there is no benchmark harness in this tree
([CONVENTIONS § 9](../CONVENTIONS.md)) — but the node counts are the node counts. LICM as
deployed here moves constants, and the reason it moves almost nothing else is the frame
state on every generic operation the front end emits.

## LICM's second gate is mod-ref

Once a node is movable and un-pinned by a frame state, the remaining question is memory: a
load can be hoisted only if nothing in the loop writes what it reads.

The pass asks that once per loop, not once per node. `modRef.writesOf(bodyBlocks)` summarises
every write in the loop body into a single `RegionMemory` — either `clobbersEverything`, or a
set of `MemoryLocation`s and their keys ([Ch 45 § one-key-cannot-answer-two-questions] for
what those keys can and cannot answer). Then per candidate:

```typescript
    const memory = modRef.writesOf(bodyBlocks);
    const isHoistable = (node: LoopNode): boolean =>
      isSideEffectFree(node) && !modRef.mayReadFrom(node, memory);
```
— `src/optimizing/passes/loop-opts.ts:41-43`

Note that `mayAlias` is the right question here, and this is the one place in the memory
story where a may-alias answer is exactly what you want: hoisting is unsafe if the load
*might* read something the loop writes. Redundancy elimination needed must-alias; motion
needs may-alias. Same heap model, opposite polarity.

Four shapes separate in the tests. A `LoadField` whose slot the loop writes stays
[t: tests/optimizing/passes/loop-opts.test.ts > "does NOT hoist LoadField that aliases a store in loop"];
a `LoadField` with no aliasing store hoists
[t: tests/optimizing/passes/loop-opts.test.ts > "hoists LoadField with no aliasing store in loop body"];
a load of a *different* slot hoists even though the loop does write
[t: tests/optimizing/passes/loop-opts.test.ts > "hoists a field load when the loop only writes a different slot"];
and a global the loop overwrites stays
[t: tests/optimizing/passes/loop-opts.test.ts > "keeps a global load that the loop overwrites"].

The `clobbersEverything` case is where the pass shows it is reading declared effects and not
guessing. A field load inside a loop that clobbers all memory stays
[t: tests/optimizing/passes/loop-opts.test.ts > "keeps a field load inside a loop that clobbers all memory"],
but a *declared-pure* call hoists out of that same loop
[t: tests/optimizing/passes/loop-opts.test.ts > "still hoists a pure call when the loop clobbers all memory"],
because a pure call reads nothing, so there is nothing for the clobber to invalidate. A
builtin call that is not declared pure stays
[t: tests/optimizing/passes/loop-opts.test.ts > "keeps a builtin call that is not declared pure inside the loop"].
And a store is never hoisted at all
[t: tests/optimizing/passes/loop-opts.test.ts > "never hoists a store out of the loop"] — that
falls out of `isMovable`, which requires the node to write nothing.

## The worklist, and why the pipeline order matters

Invariance is transitive: if `a` and `b` are invariant then so is `a + b`. The pass computes
the closure with a worklist.

Seed it with every hoistable node in the body. Pop one. Require every input to be either
defined outside the loop — `isDefinedOutsideLoop` treats parameters and constants as always
outside, and otherwise asks whether the input's block is in this loop — or already marked
invariant. If that holds, mark it and push every *use* of it that is inside the loop and
itself hoistable. If it does not hold, drop it; a later pop through another path may bring it
back. The order of the hoisted list is the order they were marked, and the whole list is
spliced into the preheader in front of its terminator, so a value is placed before anything
that consumed it. `v262 = GenericSub v261, v236` above is one pop of this worklist: `v261`
was marked first as a constant, which unblocked `v262` on the next visit.

There is one input shape the worklist cannot see through, and it is the reason for a pipeline
ordering that otherwise looks arbitrary. A value that enters the loop through a loop-header
phi is, as far as `isDefinedOutsideLoop` is concerned, defined *inside* the loop — the phi
lives in the header, and the header is in `loop.blocks`. If that phi is trivial (every input
is the same value), it means nothing and could be deleted, and then the value behind it would
be visibly outside. If it is still there, the whole chain behind it is stuck.

That is exactly why `trivial-phi-elimination-early` runs at ordinal #3 and LICM at #5, and
the pair
[t: tests/optimizing/pipeline-order.test.ts > "cannot hoist a value carried through an untouched loop-header phi"] /
[t: tests/optimizing/pipeline-order.test.ts > "hoists that same value once trivial phis have been eliminated first"]
is written at *pipeline* level for that reason: neither test would say anything if it ran the
pass alone. Pipeline order is a correctness-of-outcome property here, not a tuning knob.

## Peeling is the exact complement

A guard is not a computation. `CheckSmi`, `CheckMap`, `CheckNumber`, `CheckArray` — the four
that `isPeelableCheck` recognises — produce their input unchanged and exist only to bail out
if a speculation was wrong ([Ch 39 § feedback-becomes-speculation]). Hoisting one out of a
loop is not allowed: on a zero-iteration loop it would bail out for a value the program never
touched. But *copying* one into the preheader is fine, and if the copy succeeds the in-loop
original becomes redundant and someone else can delete it. LICM moves things that cannot
fail; peeling copies things that can.

> **The name.** This book's own conventions cite `loopUnrolling` as their example of a
> misleading name that must be kept anyway ([CONVENTIONS § 4](../CONVENTIONS.md)). That
> symbol no longer exists: a tree-wide grep over `src/`, `tests/` and `tools/` finds it
> nowhere. The pass is `peelLoopChecks` in `src/optimizing/passes/loop-opts.ts`, registered
> as `loop-check-peeling` at `src/optimizing/pipeline.ts:222`. The name now says what the
> code does, and the convention's example is stale rather than the code being wrong.

`peelLoopChecks` asks its gates in this order, per loop:

1. **Budget.** The loop's total node count must not exceed `budget`, which is `peelBudget`
   from the optimization level: `0` at `none`, `20` at `baseline`, `80` at `speed`, `160` at
   `max` (`src/optimizing/options.ts:62,76,90,104`). At `none` the pass is off by arithmetic.
2. **Shape.** The header's terminator must be an `IR_BRANCH` whose two named successors split
   exactly one exit and one continuation — `trueIsExit === falseIsExit` is a refusal, so a
   branch that leaves the loop both ways or neither way is skipped — and the continuation
   must be in the loop.
3. **A preheader.** `loop.preheader` must not be `null`.
4. **The node.** It must be one of the four `isPeelableCheck` opcodes, it must not be the
   header terminator, it must **have** a frame state, and every input must be resolvable in
   the preheader.
5. **The frame state's values.** `frameStateAvailableAtBlock` walks every value the frame
   state names and requires each one's defining block to dominate the preheader. This is the
   gate that makes the whole thing sound, and it is the mirror image of LICM's: LICM refuses
   because a frame state exists; peeling requires one *and* requires it to still be
   answerable one block earlier.

`peelableLoads` is the small extension that makes the common shape work. A guard on
`o.field` has a `LoadField` between it and the receiver, and that load is not itself
peelable. So the pass pre-computes every `LoadField` in the body whose inputs are all
available in the preheader, and lets a guard resolve its input through that set; when the
guard is peeled, its load is peeled with it, first, so the clone's inputs resolve.

The clone is built directly — `new ir.IRNode(original.type, { ...original.props })`, inputs
mapped through `cloneMap` so a peeled load feeds the peeled guard, and `peeled.frameState =
original.frameState`, the *same* frame-state object, not a copy. That is correct precisely
because gate 5 proved every value in it is available here.

[t: tests/optimizing/passes/loop-opts.test.ts > "peels a body check into the pre-header when the loop fits the budget"]
and
[t: tests/optimizing/passes/loop-opts.test.ts > "leaves the loop untouched when its node count exceeds the budget"]
pin the pass alone. On `docs/example/stats.tera` compiled ahead of time, `loop-check-peeling`
reports `changed` on **zero** of the twenty-one graphs: every guard in the program either
sits in a loop whose header branch does not split one exit from one continuation, or names a
value the preheader cannot see.

## Peeling added one guard and removed zero

**The symptom.** `peelLoopChecks` reported `changed`, the graph grew by exactly the number of
nodes it had peeled, and the in-loop guard was still there. A pass whose entire purpose is to
take a guard out of a loop body had made the graph strictly larger and left the guard where
it was.

**The mechanism.** Read the pass to the end and there is no removal in it. It splices clones
into the preheader at `:222` and increments `peelCount` at `:224`; nothing anywhere in the
function deletes, detaches or rewrites the original. That is not an oversight in the sense of
a missing line — removing the original *from inside this pass* would require re-deciding
whether the preheader copy actually dominates every use, which is a dominance question the
pass has no reason to duplicate.

**The fix** was in the pipeline, not the pass. `eliminateRedundantChecks` already knows how to
delete a guard that a dominating guard has discharged; it runs once at ordinal #7, long before
peeling. So a second copy was scheduled immediately after peeling:

```typescript
      step(
        "redundant-checks-after-peeling",
        preservesControlFlow,
        (g, analyses) => eliminateRedundantChecks(g, analyses.get(dominanceAnalysisId)),
        [dominanceId],
      ),
```
— `src/optimizing/pipeline.ts:233-238`

`loop-check-peeling` is ordinal #20 and `redundant-checks-after-peeling` is #21. The
preheader dominates the whole loop, so the peeled copy is seen first by the dominator walk
and the in-loop original matches its key and goes.

**The regression test** is at pipeline level, and had to be:
[t: tests/optimizing/pipeline.test.ts > "leaves the guard checked once, in the pre-header"]
runs the entire middle end and then asserts on *both* blocks — one guard in the preheader,
zero in the body. Its two siblings prove the assertion is discriminating:
[t: tests/optimizing/pipeline.test.ts > "keeps the guard inside the loop when the peel budget forbids peeling"]
and
[t: tests/optimizing/pipeline.test.ts > "keeps the guard inside the loop when the loop rewrites the field it guards"],
where the guarded value is a `LoadField` and the body stores to that same offset.

**The general rule.** A pass that duplicates for a later pass to deduplicate must be adjacent
to that pass in the pipeline, and its test must be written at pipeline level. The pass-level
test [t: tests/optimizing/passes/loop-opts.test.ts > "peels a body check into the pre-header when the loop fits the budget"]
passes with the bug fully present — it asserts the copy arrived, which was never in doubt.
Adjacency that a test cannot see is adjacency that a refactor will break.

> **Unfinished.** `peelLoopChecks` returns a count of *loops peeled*, not nodes peeled, so
> `[Ch 41 § the-changed-normaliser]`'s reporting says "changed" without saying how much, and
> nothing at pass level notices that the pass is a pure code-size regression on its own. If
> the `#20`/`#21` adjacency is ever broken, the three pipeline tests above are the only thing
> that fails. Cost to finish: have the pass remove the original itself once it has re-asked
> dominance, or assert the adjacency in `tests/optimizing/pipeline-order.test.ts` where the
> other ordering invariants live.

## Why the check key is deliberately narrow

`eliminateRedundantChecks` is a dominator-tree walk carrying a map from key to the guard that
established it; a child block inherits a copy of its parent's map, so a fact proved in a
dominator is available below and nowhere else. The interesting part is the key:

```typescript
  const checkKey = (node: IRNodeLike): string | null => {
    if (node.type === ir.IR_CHECK_MAP && node.inputs[0]) {
      return `map_${node.inputs[0].id}_${String(node.props.expectedMapId)}_${String(node.props.expectedMapVersion ?? "any")}`;
    } else if (node.type === ir.IR_CHECK_SMI && node.inputs[0]) {
      return `smi_${node.inputs[0].id}`;
    } else if (node.type === ir.IR_CHECK_NUMBER && node.inputs[0]) {
      return `num_${node.inputs[0].id}`;
    } else if (node.type === ir.IR_CHECK_ELEMENTS_KIND && node.inputs[0]) {
      return `elements_${node.inputs[0].id}_${String(node.props.elementsKind)}`;
    }
    return null;
  };
```
— `src/optimizing/passes/checks.ts:77-88`

The key is the **input node's id**. Not a value number, not an alias class, not a partition —
the identity of the one SSA node being guarded. That is what makes the peeled copy and the
in-loop original match: `peelLoopChecks` clones the guard with the *same* input node, so both
compute `smi_<same id>`.

*Why the obvious design fails.* The obvious improvement is to widen the key to a value
number, so that two guards on congruent values collapse. It is unsound here, and the reason is
the same as [Ch 45 § one-key-cannot-answer-two-questions]'s. A guard is a statement about a
particular SSA value at a particular point; a value number is a statement that two
computations produce equal results. Two nodes can be congruent and yet one of them have been
rewritten by a later pass into something the guard no longer covers — and unlike a forwarded
load, a dropped guard fails silently, by letting a wrong value through into speculated code.
The narrowness is the soundness argument, not a limitation waiting to be lifted.

The map version in the `CheckMap` key is the same discipline one level down.
[t: tests/optimizing/passes/checks.test.ts > "does not remove CheckMap with different map ids"]
is the obvious half;
[t: tests/optimizing/passes/checks.test.ts > "preserves CheckMap across StoreField on same object"]
is the half that matters, because a store can transition a hidden class
([Ch 23 § the-transition-tree]) and the second guard is therefore not redundant. Its complement,
[t: tests/optimizing/passes/checks.test.ts > "eliminates CheckMap in dominated block across StoreField"],
shows the case where it is.
[t: tests/optimizing/passes/checks.test.ts > "propagates checks through dominator tree"] pins
the inheritance, and
[t: tests/optimizing/passes/checks.test.ts > "removes duplicate CheckMap on same object with same map"]
the base case.

## Unswitching, and the line that turns it off

Loop unswitching takes a branch *inside* a loop whose condition is computed *outside* it,
duplicates the entire loop, rewrites the branch to a jump in each copy — one arm in one copy,
the other arm in the other — and tests the condition once, in the preheader. The loop body
then contains no branch at all.

`invariantBranchIn` looks for it: a block in the loop whose terminator is an `IR_BRANCH`,
whose condition is `definedOutside` (the value's block is `null`, or is not in `loop.blocks`),
and whose two successors are distinct and both inside the loop. Then `unswitchLoop` asks three
questions, each with a `missed` remark in English:

- there must be a single preheader ending in a `Jump` — *"loop B`N` has no single preheader
  ending in a jump, so there is nowhere to put the hoisted test"*;
- the loop must have exactly one exit block — *"loop B`N` leaves through `K` exits, and
  unswitching would have to duplicate every one of them"*;
- that exit must not also be reached from outside — *"the exit of loop B`N` is also reached
  from outside the loop, so the two copies could not agree on what flows out of it"*.

The transform itself is four steps. `routeEscapesThroughExit` is the SSA repair and runs
*first*: for every value defined inside the loop and used outside it, a phi is created in the
single exit block and every outside use is rerouted through it — including uses inside frame
states, via `visitFrameStateValues(node.frameState, (value, replace) => …)` at
`unswitching.ts:82-84`. That is what makes the duplication legal: after it, the outside world
reads one phi in one block, and the second copy can add its own input to that phi rather than
needing every consumer rewritten. Then `cloneBlocks` duplicates the region, two
`rewriteBranchAsJump` calls collapse the branch in opposite directions in the two copies, and
`enterEither` replaces the preheader's jump with a branch on the invariant condition.
[t: tests/optimizing/passes/unswitching.test.ts > "keeps the graph in SSA form"] and
[t: tests/optimizing/passes/unswitching.test.ts > "hands the exit block one incoming value per copy"]
are the pins on the repair;
[t: tests/optimizing/passes/unswitching.test.ts > "clones the loop and tests the invariant condition once, in the preheader"]
on the transform, and
[t: tests/optimizing/passes/unswitching.test.ts > "leaves a loop whose condition changes with the induction variable alone"]
on the recogniser.

And then one line in the pipeline decides whether any of it ever runs:

```typescript
  const unswitchBudget = options.deoptimizes ? 0 : options.unswitchBudget;
```
— `src/optimizing/pipeline.ts:110`

`deoptimizes` is `true` in `compilerOptions()` (`src/optimizing/options.ts:121`) and is set
to `false` in exactly one place, `staticCompilerOptions` for the AOT road
([Ch 55 § three-fields-wide]). Every JIT compile therefore hands `loopUnswitching` a budget
of zero, and the pass returns immediately with an `analysis` remark that states the reasoning
in its own words: *"unswitching is switched off here: the budget is zero, either because this
optimisation level does not pay for loop duplication or because the target can deoptimize
instead."*

> **Never runs.** `loopUnswitching` cannot fire in the JIT, by construction, at any
> optimization level. `unswitchBudget` is `0` at `none` and `baseline` anyway, and `48` /
> `96` at `speed` / `max` — but `pipeline.ts:110` overrides all four to `0` whenever
> `deoptimizes`. The transform is fully implemented and has nine unit tests, all of which
> pass it an explicit budget. Cost to deploy: decide whether a tier that can bail out should ever
> pay for loop duplication, which is a policy question the code has already answered "no"
> without saying so anywhere a reader would find it.

The reasoning behind that "no" is worth stating, because it is the cleanest illustration of
the book's hinge. Unswitching buys you a loop with no branch in it. A tier that can
deoptimize gets the same thing without duplicating anything: speculate that the condition
holds, guard it once, and if the guess is wrong throw the compiled code away. A tier that
cannot deoptimize has no such option, so it pays in code size instead. The same pass, the same graph, opposite
answers, and the whole difference is one boolean.

On `docs/example/stats.tera` compiled ahead of time — where the budget is 48, not 0 —
`loop-unswitching` runs on all twenty-one graphs, emits nineteen `missed` remarks, and every
one of them is the same sentence: *"loop B`N` has no branch whose condition is computed
outside the loop, so there is nothing to hoist."* The pass is deployed on the road that can
use it, and the program has nothing for it.

## Range analysis

> **New idea.** *Interval (range) analysis.* Attach to every integer value a pair
> `{min, max}` bounding what it can hold, propagate those bounds through the arithmetic, and
> read facts off the result: an addition whose interval fits in 32 bits cannot overflow; a
> comparison whose two intervals do not overlap is decided. The bounds are an
> over-approximation — the real set of values is somewhere inside the interval — so a proof
> that the *interval* is safe is a proof that the value is.

`rangeAnalysisAndBoundsCheckElimination` implements this as a `Map<number, Range>` from node
id to interval, with `±Infinity` as the unbounded ends. `setRange` has one guard worth
noticing:

```typescript
  const setRange = (id: number, min: number, max: number): void => {
    const known = !Number.isNaN(min) && !Number.isNaN(max) && min <= max;
    ranges.set(id, known ? { min, max } : { min: NEG_INF, max: INF });
  };
```
— `src/optimizing/passes/checks.ts:151-154`

Anything that is not a sane interval — a `NaN` from `Infinity - Infinity`, or an inverted
pair — becomes unbounded rather than becoming nonsense. Every arithmetic rule in the pass is
allowed to be sloppy because of this line.

Parameters are seeded from the declared signature: `DECLARED_INT` gives
`[INT32_MIN, INT32_MAX]` and everything else is unbounded
[t: tests/optimizing/passes/checks.test.ts > "bounds a parameter declared int by the int32 range"],
[t: tests/optimizing/passes/checks.test.ts > "leaves a parameter with no declared type unbounded"].
Constants that are integers get `[v, v]`. `CheckSmi`, `CheckNumber` and `CheckElementsKind`
copy their input's range, because they forward their input unchanged.
`Int32Add`/`Sub` are interval addition and subtraction; `Int32Mul` has four cases (both
operands non-negative; a constant on the left; a constant on the right; otherwise the minimum
and maximum of the four corner products); `Int32Div` splits on whether the divisor's interval
straddles zero, with two half-open cases that clamp the divisor to `±1`; `Int32Mod` gives
`[0, r.max - 1]` when both sides are known non-negative.
`IR_LOAD_FIELD` and `IR_LOAD_ELEMENT` are explicitly set unbounded. A phi joins its inputs by
taking the minimum of the mins and the maximum of the maxes.

Everything about that list is ordinary except one thing: **it is a single forward pass over
`graph.blocks` in list order, with no fixpoint.** Each node is visited once. A phi at a loop
header therefore joins whatever its inputs happened to have when the walk reached it — and a
loop's back-edge input is computed from the phi, so on the visit that matters it is still
unset, which `getRange` answers as `[-Infinity, +Infinity]`. Every induction variable in every
loop in this engine is unbounded, permanently. Hold that; it is the chapter's ending.

## Per-branch edge narrowing, and the two range maps

A comparison is information. `if (i < n)` means that on the true edge, `i <= n.max - 1`. The
pass walks every block whose terminator is a branch on an `Int32Compare` or `Float64Compare`,
and for `<`, `<=`, `>`, `>=` calls `narrowRange` once for the true successor and once for the
false one.

Then it does something the reader should look at twice:

```typescript
  const narrowRange = (
    _block: IRBlockLike,
    leftId: number,
    newMin: number,
    newMax: number,
  ): void => {
    const cur = getRange(leftId);
    setRange(
      leftId,
      Math.max(newMin, cur.min),
      Math.min(newMax, cur.max === INF ? newMax : cur.max),
    );
  };
```
— `src/optimizing/passes/checks.ts:363-375`

The block parameter is named `_block` and is not read. There is one `ranges` map, and the
narrowing writes into it — so a fact that holds only on one edge is recorded for the whole
function, and then the *other* edge's narrowing is intersected into the same slot immediately
afterwards.

For the ordinary shape the two cancel. Given `i < 3` with `i` unbounded: the true edge sets
`i` to `[-inf, 2]`; the false edge then asks for `[3, leftRange.max]`, where `leftRange` was
captured before either narrowing and is still `+inf`, so the intersection is `min = 3`,
`max = 2` — inverted, so `setRange`'s guard turns it back into unbounded. The design is saved
by the sanity check rather than by the design.

> **Unfinished.** `narrowRange` takes a block and ignores it: the narrowing is global, not
> per-edge (`checks.ts:363-375`). Two consumers read the narrowed map — the `noOverflow`
> stamping loop at `:447-466` and the bounds-check gate at `:638` — so a fact proved on one
> branch could in principle license a stamp or a proof in a block that branch does not
> dominate. It has not been observed doing so, because the true and false narrowings of the
> same comparison intersect to an inverted interval and cancel to unbounded, and because the
> bounds-check path never gets far enough to read the map (below). Cost to finish: key the
> ranges by (block, node) and merge per predecessor, which is the same shape as
> [Ch 45 § a-snapshot-dataflow]'s meet — or delete the parameter and document that the
> narrowing is whole-function. **[unpinned]** — no test constructs a narrowing that survives
> into a non-dominated block.

Branch folding is where the design's own author clearly saw the problem. Before any
narrowing runs, the pass takes a complete copy of the map into `preNarrowRanges`, and the
always-true / always-false fold at `:468-530` reads `getPreNarrowRange`, never `getRange`.
The reason is exact: narrowing writes the assumption of a branch back into the same map, so
folding a comparison on the narrowed range would be folding it using the very fact the
comparison establishes. `i < 3` would narrow `i` to `[-inf, 2]` and then observe that
`i < 3` is always true.

That is the same failure mode as [Ch 49](49-speculative-types-are-not-facts.md)'s, in a
different currency: a fact that is true only downstream of a check, used to discharge the
check. The two range maps are the fix, and they are the only reason
[t: tests/optimizing/passes/checks.test.ts > "folds always-true branch comparison"] and
[t: tests/optimizing/passes/checks.test.ts > "folds always-false branch comparison"] mean
anything.

## Minus zero and noOverflow

The one output of range analysis that anything downstream actually consumes is a boolean
stamped on arithmetic nodes:

```typescript
        const r = getRange(node.id);
        if (
          r.min >= NEG_INF &&
          r.max <= INF &&
          withinInt32(r.min, r.max) &&
          !mayBeMinusZero(node)
        ) {
          if (!node.props) node.props = {};
          node.props.noOverflow = true;
        }
```
— `src/optimizing/passes/checks.ts:454-463`

`withinInt32` is the interval test. `mayBeMinusZero` is the IEEE-754 half: only an
`Int32Mul` can produce `-0`, and only when the operands are not both non-negative and not
both non-zero. `nonNegative(r)` is `r.min >= 0` and `nonZero(r)` is `r.min > 0 || r.max < 0`.
Negative zero matters because `-0 === 0` is true but `1/-0` is `-Infinity`, so an integer
representation that silently normalises `-0` to `0` changes an observable answer.
[t: tests/optimizing/passes/checks.test.ts > "marks noOverflow on add with small constant ranges"]
is the pin.

The flag has three consumers, and they make this the load-bearing product of the pass.
`strengthReduction` refuses to touch a multiply that is not stamped
([Ch 47 § strength-reduction-and-the-flag-it-will-not-move-without]); `SccpSolver`'s folded arithmetic wraps to int32 only with it
([Ch 43 § an-int32add-is-not-int32]); and `int32-overflow-widening` at ordinal #19 rewrites
every `Int32Add`/`Sub`/`Mul` still lacking it into the `Float64` form, which is how an
unproven int32 operation stops being an int32 operation
([Ch 48 § settle-int32] is the second producer of the same flag, from type narrowing rather
than from ranges).

So the pass is not idle. On the AOT compile of `stats.tera`, `bounds-check-elimination`
reports `changed` on zero of twenty-one graphs — but "changed" counts eliminations, and the
`noOverflow` stamping is a property write that the pass-manager's change accounting does not
see. The interval machinery pays for itself through a flag, and never through the
optimization it is named after.

## Bounds-check elimination

A `CheckBounds` node has two inputs, an index and an array, and it deoptimizes if the index
is out of range. Removing one is the single most valuable thing in this chapter, because it
is the only guard in the loop body of every array walk.

The pass has three independent routes to `bounded`, tried in order for each `CheckBounds`:

1. **A dominating comparison.** Walk the block's predecessors; if a predecessor's terminator
   is a branch on a `<` or `<=` comparison whose left operand *is this exact index node*, and
   this block is that branch's `trueBlock`, the index is bounded. This is the symbolic route:
   it proves nothing about numbers, it proves that control only reaches here when the
   comparison held.
2. **A guarded induction variable.** `detectInductionVariable(indexNode)` requires the node
   to be an `IR_PHI` with exactly two inputs, one of which is an `Int32Add` that takes the
   phi itself; it reads the initial value's range and the step's range and requires
   `initRange.min >= 0` and `stepRange.min > 0`. Then `findLoopGuard` looks the phi up in
   `loopGuardIndex` — a map built from every `<`/`<=` branch in the function, keyed by
   `cmp.inputs[0].id` — and accepts the guard either if its bound is a `LoadArrayLength` or
   if the bound has a finite maximum.
3. **A known length.** `arrayLengthNodes` maps an array node's id to the `LoadArrayLength`
   nodes taken from it; if any of those has a range whose minimum exceeds the index's
   maximum, the index is inside.

Each route has a `tracer.jitCompile` message written for it — `BCE-IV: index vN is
IV(init≥…, step≥…) guarded by … at B…` and `BCE-Range: index [a,b] < array.length [c,d]` —
and on success the node is replaced by its index, added to `boundsChecksToRemove`, and a
remark records *"dropped the bounds check: index v`N` is provably inside the array, range
…"*.

Note the two `"LoadArrayLength"` string literals at `checks.ts:592` and `:620`, used instead
of the exported `IR_LOAD_ARRAY_LENGTH` constant (`src/optimizing/ir/operations.ts`).

> **Unenforced.** Renaming the array-length opcode would silently disable routes 2 and 3 —
> the two bare string comparisons would stop matching, no type error would be raised, and the
> pass would go on reporting that it kept every bounds check. Cost to enforce: two identifier
> substitutions. **[unpinned]**.

## It has never removed one

Before all three routes, there is a gate:

```typescript
      if (!(indexRange.min >= 0 && indexRange.max >= 0 && indexRange.max < INF)) {
        remarks.missed(
          node,
          `kept the bounds check: index v${indexNode.id} has range ${rangeText(indexRange)}, which does not prove it is a non-negative number with a known upper bound`,
        );
        continue;
      }
```
— `src/optimizing/passes/checks.ts:638-644`

The index must have a *numeric* interval with a finite upper bound before the pass will
consider whether it is *symbolically* inside the array. Route 1 — the one route that does not
need numbers at all — is behind it.

Here is the actual graph. `docs/example/stats-deopt.tera` warms `total_of` two hundred times,
so it reaches the optimizing tier; `node dist/cli.js --print-ir --filter total_of
docs/example/stats-deopt.tera` prints the graph after the whole middle end. Its two loop
blocks, with the entry block `B0` and the exit block `B1` left out:

```
  B2 succs=B3 preds=B3:
    v14 = CheckArray v0 !fs
    v15 = CheckElementsKind v14 [elementsKind="PACKED_DOUBLE"] !fs
    v17 = CheckBounds v10, v15 !fs
    v18 = LoadElement v15, v10 [elementsKind="PACKED_DOUBLE", elementRep="float64", requiresBoundsCheck=true]
    v19 = CheckNumber v5 !fs
    v20 = CheckNumber v18 !fs
    v21 = Float64Add v19, v20
    v24 = CheckSmi v22 !fs
    v25 = Int32Add v10, v35 !fs
    v32 = Jump [targetBlock=3]
  B3 loop-header succs=B2,B1 preds=B0,B2:
    v5 = Phi v1, v21 [index=0]
    v6 = Phi v2, v25 [index=1]
    v7 = CheckArray v0 !fs
    v8 = CheckElementsKind v7 [elementsKind="PACKED_DOUBLE"] !fs
    v9 = LoadArrayLength v8
    v10 = CheckSmi v6 !fs
    v11 = CheckSmi v9 !fs
    v12 = Int32Compare v10, v11 [op="<"]
    v13 = Branch v12 [trueBlock=2, falseBlock=1]
```

`v17 = CheckBounds v10, v15` survives. Follow the three routes on this graph and every one of
them tells you something different about why:

- **Route 1 would succeed.** B2's only predecessor is B3, whose terminator is
  `v13 = Branch v12 [trueBlock=2]`, and `v12`'s left operand is `v10` — the same node
  `CheckBounds` uses as its index. The comparison dominates, its true edge is this block, and
  the index is the same SSA value. The proof is there and it is correct.
- **Route 2 cannot succeed, ever.** `detectInductionVariable` requires an `IR_PHI`, and the
  index handed to `CheckBounds` is never a phi. The IR builder wraps it:
  `const chkBounds = ir.irCheckBounds(chkSmi, chkKind)`
  (`src/optimizing/builder/ir-builder.ts:1342`, and the same shape at `:1422` and twice in
  `builder/inline.ts`). The index is always a `CheckSmi`. This is the "`CheckSmi` wrapper"
  the subsystem survey named, and for route 2 the survey is exactly right.
- **Route 3 cannot succeed here.** `arrayLengthNodes` is keyed by the id of `LoadArrayLength`'s
  input, which is `v8` — the header's `CheckElementsKind`. `CheckBounds`'s array input is
  `v15`, the *body's* `CheckElementsKind` of the same array. Two identity-forwarding guards on
  one array, in two blocks, do not compare equal by node id. (This is the same class of
  mistake [Ch 45 § one-key-cannot-answer-two-questions] closed, going the other way: there,
  two different cells shared a key; here, one cell has two.)
- **And none of them is reached.** `v10 = CheckSmi v6`; `v6 = Phi v2, v25` where `v2` is the
  constant `0` and `v25 = Int32Add v10, v35` is the increment. The range walk visits
  `graph.blocks` in list order, which puts the body B2 before the header B3, so `v25` is
  computed while `v10` is still unset and comes out `[-inf, +inf]`; the phi joins `[0,0]`
  with that and is unbounded; `v10` copies it. Nor can the guard narrowing rescue it:
  narrowing on `v10 < v11` requires `v11`'s range to have a finite end, and `v11 = CheckSmi
  v9` copies `v9 = LoadArrayLength`, which has no case in the walk at all and is therefore
  unbounded. The gate at `:638` rejects and prints the first of the pass's two `missed`
  remarks.

So the pass has a correct symbolic proof, and a numeric precondition in front of it that no
symbolic fact can satisfy. Even a fixpoint over the back edge would not fix it, and neither
would a range rule for `LoadArrayLength`: a length is `[0, +inf]`, and the whole point of
`i < a.length` is that the bound is a *name*, not a number. Interval analysis cannot express
`i < len(a)`. Route 1 can, and route 1 is unreachable.

> **Broken.** `rangeAnalysisAndBoundsCheckElimination`
> (`src/optimizing/passes/checks.ts:141-738`) does not remove a `CheckBounds` produced from
> tera source. Re-verified 2026-09-08: the optimizing tier's graph for `total_of` in
> `docs/example/stats-deopt.tera` still contains `v17 = CheckBounds v10, v15` after the full
> pipeline, and the four analysed reasons are above. Cost to fix: reorder the gate so a
> `bounded` proof from route 1 is tried before the numeric precondition, **plus** the
> soundness review that has been deferred since 2026-08-24 — `findLoopGuard` has never been
> audited for whether the guard it finds is against *that array's* length, and the pass
> removes a memory-safety check. This is a review, not a patch.

> **Never runs.** The `BCE-IV` (`checks.ts:679-682`) and `BCE-Range` (`checks.ts:693-696`)
> trace messages, and the `remarks.applied` sentence at `:715-718`, describe successes the
> pass cannot reach on any tera program in this tree.

> **Unenforced.** No test in `tests/` removes a `CheckBounds`. The two tests that exist for
> the pass's bounds path assert *refusals*:
> [t: tests/optimizing/infra/pass-remarks-from-passes.test.ts > "says the index range is unknown when the index is an opaque parameter"]
> and
> [t: tests/optimizing/infra/pass-remarks-from-passes.test.ts > "gives a different reason once the index has a known range but no known length"].
> `tests/optimizing/passes/checks.test.ts` contains the string `CheckBounds` zero times.
> The pass's success path has no coverage, so the day the gate is fixed there is nothing to
> tell you whether it was fixed correctly. **[unpinned]**.

There is one more thing worth saying about how hard this was to observe, because it explains
why the entry sat unconfirmed for weeks. The pass explains itself in English — the remark
above names the node, the range and the missing fact — but that sentence **cannot be printed
by any command in this tree**. Remarks are collected only when the pass manager has a tracer
installed ([Ch 41 § remarks-are-english-addressed-to-a-programmer]), which on the CLI means
`--print-after-all`; `--print-after-all` is a `compile` flag and is refused on the run path
with `tera: unknown option '--print-after-all' for 'run' (see 'tera help run')`; and the AOT
road emits no `CheckBounds` at all — a grep for it over the full `--print-after-all` dump of
both `stats.tera` and `stats-deopt.tera` returns zero. `CheckBounds` exists only on the road
that cannot print remarks, and remarks print only on the road that has no `CheckBounds`.

## What leaves

The same `CFGFunction`, with four changes and one conspicuous non-change.

Loop-invariant effect-free computations have been spliced into their loop's preheader —
in practice, on this program, almost entirely constants, because every generic operation the
front end emits carries a frame state and LICM will not move one. Each peelable guard whose
frame state is answerable one block earlier has been *copied* into the preheader, and the
in-loop original deleted immediately afterwards by `redundant-checks-after-peeling` at
ordinal #21, so what leaves is one guard in the preheader rather than one per iteration.
Every `Int32Add`, `Int32Sub` and `Int32Mul` whose interval fits int32 and cannot be `-0`
carries `props.noOverflow = true`, which is the fact `strength-reduction` at #18 and
`int32-overflow-widening` at #19 both read. Branches whose comparison is decided by the
pre-narrowing intervals have become jumps, and the blocks they cut off are unreachable and
waiting for `unreachable-block-elimination` at #30.

And every `CheckBounds` is exactly where it was.

On the JIT road, `loop-unswitching` did not run at all — budget forced to zero by
`pipeline.ts:110` — so the loops leaving that road still contain whatever invariant branches
they arrived with. On the AOT road it ran and found nothing to hoist.

[Ch 47 § strength-reduction-and-the-flag-it-will-not-move-without] takes the graph next:
`strength-reduction` at #18 is the first consumer of the `noOverflow` flag this chapter
produced, and the family of identity rewrites around it is where a "simplification" that is
not sound does its damage.

## Verify it yourself

```bash
# the bounds check that survives the whole optimizing pipeline
node dist/cli.js --print-ir --filter total_of docs/example/stats-deopt.tera \
  | grep -n "CheckBounds\|Int32Compare\|LoadArrayLength\|Phi"

# LICM and peeling, alone (37 tests)
npx vitest run --project unit tests/optimizing/passes/loop-opts.test.ts tests/optimizing/passes/checks.test.ts

# unswitching, and the three pipeline-level peeling tests (26 tests)
npx vitest run --project unit tests/optimizing/passes/unswitching.test.ts tests/optimizing/pipeline.test.ts

# what the four loop passes actually did to the running example:
# licm changed 9 of 21 graphs; peeling, unswitching and BCE changed none
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats-c 2>&1 \
  | grep '^\*\*\* IR after' | grep -E ' licm| loop-unswitching| loop-check-peeling| bounds-check-elimination' \
  | grep -c '\[changed'

# the AOT road emits no CheckBounds at all, which is why the pass has nothing to do there
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats-c 2>&1 \
  | grep -c CheckBounds

# the one line that turns unswitching off for the JIT, and the four budgets it overrides
grep -n "unswitchBudget" src/optimizing/pipeline.ts src/optimizing/options.ts

# the pass name this book's own conventions still call loopUnrolling
grep -rn "loopUnrolling" src/ tests/ tools/
```

Run on 2026-09-08: the fourth command prints `9`, the fifth prints `0`, and the last prints
nothing at all. `--print-after-all` and `--verify` are `compile`-only flags; on the run path
`--print-after-all` is refused with
`tera: unknown option '--print-after-all' for 'run' (see 'tera help run')`. Note also that
`-o` names a **directory** under `--emit source`.

## Tests that pin this

- `tests/optimizing/passes/loop-opts.test.ts` > `"does NOT hoist node with frameState"` — the first gate, and the whole safety argument.
- `tests/optimizing/passes/loop-opts.test.ts` > `"does NOT hoist LoadField that aliases a store in loop"` — the second gate.
- `tests/optimizing/passes/loop-opts.test.ts` > `"hoists LoadField with no aliasing store in loop body"` — its converse.
- `tests/optimizing/passes/loop-opts.test.ts` > `"hoists a field load when the loop only writes a different slot"` — `mayAlias` at field granularity.
- `tests/optimizing/passes/loop-opts.test.ts` > `"keeps a global load that the loop overwrites"` — a global is always visible.
- `tests/optimizing/passes/loop-opts.test.ts` > `"keeps a field load inside a loop that clobbers all memory"` — the `clobbersEverything` region summary.
- `tests/optimizing/passes/loop-opts.test.ts` > `"still hoists a pure call when the loop clobbers all memory"` — a pure call reads nothing, so a clobber invalidates nothing.
- `tests/optimizing/passes/loop-opts.test.ts` > `"keeps a builtin call that is not declared pure inside the loop"` — and one that is not declared pure stays.
- `tests/optimizing/passes/loop-opts.test.ts` > `"hoists a pure builtin call whose operands come from outside the loop"` — the declared-effects path.
- `tests/optimizing/passes/loop-opts.test.ts` > `"hoists chain of invariant nodes via worklist"` — transitivity, the shape `v262`/`v261` takes on the spine.
- `tests/optimizing/passes/loop-opts.test.ts` > `"never hoists a store out of the loop"` — falls out of `isMovable`.
- `tests/optimizing/passes/loop-opts.test.ts` > `"peels a body check into the pre-header when the loop fits the budget"` — the peel itself, and the test that passes with the "added one, removed zero" bug present.
- `tests/optimizing/passes/loop-opts.test.ts` > `"leaves the loop untouched when its node count exceeds the budget"` — `peelBudget`.
- `tests/optimizing/pipeline.test.ts` > `"leaves the guard checked once, in the pre-header"` — the regression test, at pipeline level because it has to be.
- `tests/optimizing/pipeline.test.ts` > `"keeps the guard inside the loop when the peel budget forbids peeling"` — the assertion is discriminating.
- `tests/optimizing/pipeline.test.ts` > `"keeps the guard inside the loop when the loop rewrites the field it guards"` — and so is `redundant-checks-after-peeling`.
- `tests/optimizing/pipeline-order.test.ts` > `"cannot hoist a value carried through an untouched loop-header phi"` — why `trivial-phi-elimination-early` is at #3.
- `tests/optimizing/pipeline-order.test.ts` > `"hoists that same value once trivial phis have been eliminated first"` — and LICM at #5.
- `tests/optimizing/analyses/loops.test.ts` > `"derives exiting blocks, exit blocks, and preheader"` — the strict preheader test both passes depend on.
- `tests/optimizing/passes/checks.test.ts` > `"removes duplicate CheckMap on same object with same map"` — the base case for `checkKey`.
- `tests/optimizing/passes/checks.test.ts` > `"does not remove CheckMap with different map ids"` — the key includes the map.
- `tests/optimizing/passes/checks.test.ts` > `"propagates checks through dominator tree"` — inheritance down the walk.
- `tests/optimizing/passes/checks.test.ts` > `"preserves CheckMap across StoreField on same object"` — a store can transition a hidden class.
- `tests/optimizing/passes/checks.test.ts` > `"eliminates CheckMap in dominated block across StoreField"` — and where it cannot.
- `tests/optimizing/passes/checks.test.ts` > `"marks noOverflow on add with small constant ranges"` — the pass's only consumed output.
- `tests/optimizing/passes/checks.test.ts` > `"folds always-true branch comparison"` — the fold that reads `preNarrowRanges`.
- `tests/optimizing/passes/checks.test.ts` > `"folds always-false branch comparison"` — its mirror.
- `tests/optimizing/passes/checks.test.ts` > `"bounds a parameter declared int by the int32 range"` — parameter seeding from the declared signature.
- `tests/optimizing/passes/checks.test.ts` > `"leaves a parameter with no declared type unbounded"` — and everything else.
- `tests/optimizing/passes/unswitching.test.ts` > `"clones the loop and tests the invariant condition once, in the preheader"` — the transform.
- `tests/optimizing/passes/unswitching.test.ts` > `"keeps the graph in SSA form"` — `routeEscapesThroughExit`.
- `tests/optimizing/passes/unswitching.test.ts` > `"hands the exit block one incoming value per copy"` — the exit phi.
- `tests/optimizing/passes/unswitching.test.ts` > `"leaves a loop whose condition changes with the induction variable alone"` — `definedOutside`.
- `tests/optimizing/passes/unswitching.test.ts` > `"does nothing when the budget is zero"` — the state every JIT compile is in.
- `tests/optimizing/infra/pass-remarks-from-passes.test.ts` > `"says the index range is unknown when the index is an opaque parameter"` — the gate this chapter ends on, asserted as a refusal.
- `tests/optimizing/infra/pass-remarks-from-passes.test.ts` > `"gives a different reason once the index has a known range but no known length"` — the second refusal.
- **No test removes a `CheckBounds`.** `[unpinned]` — the pass's success path has no coverage anywhere in `tests/`.
