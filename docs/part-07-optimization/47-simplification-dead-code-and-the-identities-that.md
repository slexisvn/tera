# 47. Simplification, dead code, and the identities that are wrong   ⟨J · N⟩

Every compiler textbook has the list. `x + 0 → x`, `x * 1 → x`, `x * 0 → 0`,
`x / 2 → x >> 1`, `x % 8 → x & 7`, `!!b → b`, `-(-x) → x`. They are the first optimizations
anyone writes and they look like arithmetic, which is the problem: they are theorems about
the integers, and a language whose numbers are IEEE doubles is not the integers. Three of
the seven above are unsound here. One of the remaining four is unsound here too, is shipped,
and produces a live four-tier disagreement that this chapter reproduces.

`src/optimizing/passes/simplify.ts` is 217 lines and ships exactly **four** identity rules.
That restraint is the interesting thing about it, and where the reasoning behind each
omission is written down is the second interesting thing: not in a comment — there are 26
comment lines in 120,822 — but in the titles of the tests that assert the rewrite does *not*
happen. `it("does NOT reduce x * 0 to 0 (unsound: negative x yields -0, NaN and Infinity
yield NaN)")` is the derivation. In a zero-comment codebase a test title is the design
document ([CONVENTIONS § 8](../CONVENTIONS.md)), and this file is the clearest case of it in
the tree.

The chapter's second half is the four functions in `src/optimizing/passes/dce.ts` that
between them account for ten of the thirty-three middle-end passes. They are the cleanup
crew, and the only thing subtle about them is what they are forbidden to remove.

**The running example does not exercise algebraic simplification at all.** Neither
`algebraic-simplification` (#10) nor `algebraic-simplification-after-escape` (#14) reports a
single change on any of the twenty-one graphs a `docs/example/stats.tera` compile produces;
the program simply contains no `+ 0`, `* 1`, `- -x` or `!!b`. `strength-reduction` at #18
fires exactly once, and the chapter walks that one. The signed-zero bug needs a shape the
example set cannot reach, so it appears here as a **command** under "Verify it yourself" and
not as a book listing ([CONVENTIONS § 1-2](../CONVENTIONS.md)).

**What arrived.** The graph at ordinal #10, immediately after `sccp` at #9: constants
folded, constant branches already turned into jumps by `rewriteBranchAsJump` with their dead
edges dropped, and the now-unreachable blocks still sitting in `graph.blocks`
([Ch 43 § folding-a-branch-and-who-cleans-up]). For `strength-reduction` at #18: that graph
after `bounds-check-elimination` at #17, carrying whatever `noOverflow` could be proved
([Ch 46 § minus-zero-and-nooverflow]). For the DCE family at #22 through #32: the graph
after `loop-check-peeling` has duplicated guards into preheaders and
`redundant-checks-after-peeling` has taken the originals back out.

## An algebraic identity is a rewrite rule, and a rewrite rule is a claim about every input

> **New idea.** *A rewrite rule.* An optimizer's "identity" is not an equation; it is a
> licence to replace one subgraph with another everywhere the pattern matches. It is correct
> only if the replacement is indistinguishable from the original **for every value the input
> can hold** — including the values a reader never thinks about while writing the rule down.
> There is no "usually". A rule that holds for 2^64 − 3 of the inputs is a bug that fires
> three times.

The shape in this file is small. `simplified(node)` returns a *replacement node* or `null`,
and the driver does the graph surgery:

```typescript
      for (const node of block.nodes) {
        const replacement = simplified(node);
        if (replacement === null) continue;
        replaceValueUses(graph, node, replacement);
        detachInputs(node);
        node.block = null;
        dead.add(node);
        count++;
        changed = true;
      }
      retainNodes(block, dead);
```
— `src/optimizing/passes/simplify.ts:63-73`

`replaceValueUses` rewrites every input edge naming the old node *and* calls
`replaceGraphFrameStateValue`, so a frame state that captured the sum now names the operand
([Ch 40 § who-must-own-one]). `detachInputs` removes the dead node from its inputs' use
lists. `retainNodes` drops it from the block. Those three are the only sanctioned ways to
unhook a node; a pass that edits `inputs` or `uses` by hand corrupts def-use, which is a
failure mode with its own war story in [Ch 38 § the-def-use-multiset].

## The four identities that ship

The complete shipped list is fourteen lines:

```typescript
function simplified(node: SimplifyNode): SimplifyNode | null {
  if (node.type === ir.IR_INT32_ADD || node.type === ir.IR_FLOAT64_ADD) {
    return identityOperand(node, 0);
  }
  if (node.type === ir.IR_INT32_MUL || node.type === ir.IR_FLOAT64_MUL) {
    return identityOperand(node, 1);
  }
  if (node.type === ir.IR_NEG) return involution(node, ir.IR_NEG);
  if (node.type === ir.IR_NOT) {
    const inner = involution(node, ir.IR_NOT);
    return inner !== null && producesBoolean(inner) ? inner : null;
  }
  return null;
}
```
— `src/optimizing/passes/simplify.ts:40-53`

`identityOperand(node, neutral)` requires exactly two inputs and checks operand 1 first, then
operand 0, so `0 + x` folds as well as `x + 0`
[t: tests/optimizing/passes/simplify.test.ts > "x + 0 => x"],
[t: tests/optimizing/passes/simplify.test.ts > "0 + x => x"],
[t: tests/optimizing/passes/simplify.test.ts > "x * 1 => x"].
The comparison is `constantInput(node, 1) === neutral` — a strict `===` against a JavaScript
`number`, so the operand must be an `IR_CONSTANT` holding an actual number, not a string that
looks like one.

`involution(node, opcode)` is the double-application rule: one input, whose type is the same
opcode, answer *its* input. `Neg(Neg(x))` collapses to `x`
[t: tests/optimizing/passes/simplify.test.ts > "cancels double negation"].

Four rules. Then the guard on the fourth, which is where the file starts telling you what it
knows.

## IEEE-754 has two zeros and a value that is not equal to itself

> **New idea.** *Signed zero and NaN.* An IEEE-754 double has a sign bit that is independent
> of the magnitude, so `0.0` and `-0.0` are two distinct bit patterns. They compare equal —
> `-0 === 0` is `true` — and they are not interchangeable: `1 / 0` is `+Infinity` and
> `1 / -0` is `-Infinity`. The format also has NaN, which is not equal to anything including
> itself, so `NaN !== NaN` is `true`. And `Infinity * 0` is `NaN`, not `0`. tera's `float` is
> a double and the interpreter's numbers are JavaScript numbers, so every one of those values
> is reachable from a tera source file. This is the first place in the book that needs the
> *consequences* rather than the name; [Ch 22 § negative-zero-comes-first] introduced the bits.

Hold those three facts. Every refusal in the rest of this section is one of them.

## `!` is guarded on a derived set, and `-` is not guarded at all

Look again at the asymmetry inside `simplified`. `Neg(Neg(x))` folds unconditionally.
`Not(Not(x))` folds only when `producesBoolean(inner)`.

The reason is that `!` is not an involution on non-booleans. `!!5` is `true`, not `5`; the
outer `!` coerces. Folding `Not(Not(x))` to `x` would replace a boolean with whatever `x` is,
which is a type change, not a simplification.
[t: tests/optimizing/passes/simplify.test.ts > "cancels double not over a boolean-producing value"]
and
[t: tests/optimizing/passes/simplify.test.ts > "keeps double not over a non-boolean value (it coerces to boolean)"]
are the two halves.

What makes this worth a section is *how* `producesBoolean` decides. It does not consult a
hand-written list of opcodes:

```typescript
const ALWAYS_BOOLEAN: ReadonlySet<string> = new Set(
  ALL_OPCODES.filter(
    (opcode) =>
      transferOf(opcode)(probeOf(opcode), UNCONSTRAINED_CONTEXT).kind === TypeKind.Boolean,
  ),
);
```
— `src/optimizing/ir/operations.ts:1080-1085`

The set is *computed at module load* by running every opcode's own type-transfer function on
a bare probe node under the unconstrained context, and keeping the ones that answer
`TypeKind.Boolean`.

**Invariant → enforcement → test.** The invariant is that the boolean set tracks the transfer
functions — an opcode whose transfer says "boolean" must be in the set, and one whose transfer
changes must leave it. The enforcement is that the set is *derived* rather than declared:
there is no second place to update, so the two cannot drift. The test is
[t: tests/optimizing/ir/operations.test.ts > "derives the boolean-producing operations from their type transfers"].
This is the pattern [Ch 38 § the-operation-table] argues for throughout, and it is why
`producesBoolean`'s only special case is the one the table cannot answer: an `IR_CONSTANT`,
whose booleanness is a property of its `props.value` and not of its opcode.

## The identities that are deliberately absent, read off their own test titles

Three rules from the textbook list are not here, and each one's absence is documented by a
test that asserts the absence, with the reason in the title.

**`x * 0 → 0`** —
[t: tests/optimizing/passes/simplify.test.ts > "does NOT reduce x * 0 to 0 (unsound: negative x yields -0, NaN and Infinity yield NaN)"].
Three counterexamples in one title. `-3 * 0` is `-0`, not `0`, and the two are
distinguishable by division. `NaN * 0` is `NaN`. `Infinity * 0` is `NaN`. The rule is a
theorem about a ring; doubles are not one.

**`x / 2^k → x >> k`** —
[t: tests/optimizing/passes/simplify.test.ts > "does NOT reduce divide by power of 2 to shift (unsound for negative dividends)"].
An arithmetic right shift rounds toward −∞; integer division truncates toward zero. `-1 / 2`
is `-0.5`, which truncates to `-0`; `-1 >> 1` is `-1`. They agree on every non-negative
input and disagree on every negative one.

**`x % 2^k → x & (2^k − 1)`** —
[t: tests/optimizing/passes/simplify.test.ts > "does NOT reduce mod by power of 2 to bitwise-and (unsound for negative dividends)"].
`-3 % 8` is `-3`, because the remainder takes the sign of the dividend. `-3 & 7` is `5`,
because two's-complement `-3` is `…11111101` and masking the low three bits gives `101`.

The three share one general rule: **every deleted identity is a theorem about the integers
that stops being true about IEEE doubles or about two's-complement negatives.** The two
failure modes are the same shape — a rule proved on a subset of the domain, applied to the
whole domain — and both subsets are the ones a person writing the rule tests by hand.

There is a fourth entry in the same family, and it is the one that is *not* absent.
[t: tests/optimizing/passes/simplify.test.ts > "still reduces x * 1 to x"] sits immediately
after the `x * 0` refusal, and its point is that multiplication by one is genuinely safe on
doubles: `-0 * 1` is `-0`, `NaN * 1` is `NaN`, `Infinity * 1` is `Infinity`. The author of
that test file was reasoning about signed zero, one identity at a time, and got three of four
right.

> **Broken.** `x + 0 → x` is unsound for `IR_FLOAT64_ADD` when `x` is `-0`, and the
> disagreement is observable in three of the four tiers. `simplified`
> (`src/optimizing/passes/simplify.ts:41-43`) applies `identityOperand(node, 0)` to
> `IR_FLOAT64_ADD` as well as `IR_INT32_ADD`, but IEEE addition is not the identity on signed
> zero: `(-0) + (+0)` is `+0`, so replacing the sum with its left operand hands back `-0`
> where the program computed `+0`. **Reproduced 2026-09-08**, one run per fresh process, on
> the five-line probe in "Verify it yourself": the interpreter and `--no-opt` both print
> `Infinity`; `--opt-threshold 1 --baseline-threshold 1` prints `-Infinity`; and the native
> binary prints `-Infinity`. `--print-after-all` names the pass —
> `*** IR after #10 algebraic-simplification [changed, nodes 4 -> 3 (-1), invalidated nothing] ***` — and the C
> backend emits `double f(double p0) { return (double)p0; }`. Cost to fix: one condition.
> Restrict the `0` identity to `IR_INT32_ADD`, or require the surviving operand to be proved
> not-`-0` the way `mayBeMinusZero` already does for `noOverflow`
> (`src/optimizing/passes/checks.ts:435-445`). The `-0` reasoning is already written down in
> this same test file, for `x * 0`; nobody applied it to `x + 0`. **[unpinned]** — no test
> covers the `Float64Add` zero identity in either direction.

> **Unenforced.** Nothing in the tree states, checks or tests the invariant that an entry in
> `simplified` must be sound over IEEE doubles. The three refusals above exist only as
> `it("does NOT …")` titles in `tests/optimizing/passes/simplify.test.ts`; a fifth rule added
> to `simplified` tomorrow would be pinned by whatever test its author happened to write and
> by nothing else. The `Float64Add` bug is what that costs, and it is the reason this chapter
> exists as an argument rather than a tour.

## Why the obvious design fails: an identity table

The design a reader reaches for after seeing four rules in a 217-line file is a table: a
`Map<opcode, (node) => node | null>` with forty canonical rewrites ported from a textbook,
each a few lines, driven by one loop. It would be shorter per rule, easier to extend, and
easy to test.

It cannot be built here, and the reason is not effort. Every entry needs a per-opcode proof
obligation — what happens at `-0`, at `NaN`, at `±Infinity`, at negative dividends, at
int32 overflow — and `simplified`'s signature has nowhere to *put* one. It returns a node or
`null` and carries no witness: no statement of what it assumed, no place for the type
narrowing or range analysis of [Ch 46 § minus-zero-and-nooverflow] to be consulted, no way for
a reviewer to see which of the five hazards an entry considered. A table of forty such
functions is forty unstated proofs in one file, and the first one that is wrong is
indistinguishable from the thirty-nine that are right.

The tree's answer is to ship four rules whose proofs are short enough to hold in your head,
and to write the proofs of the omitted ones into the names of tests that assert the omission.
It is a worse design in every respect except the one that matters, and the `Float64Add` bug
above shows the cost of the one rule that got in without its proof being written down
anywhere.

## Strength reduction, and the flag it will not move without

`strengthReduction` replaces a multiply by a constant with shifts and adds. Its gate is three
conditions deep:

```typescript
      if (
        node.type === ir.IR_INT32_MUL &&
        node.inputs.length === 2 &&
        node.props.noOverflow === true
      ) {
```
— `src/optimizing/passes/simplify.ts:149-153`

The third is the interesting one. `Int32Shl` in this IR wraps at 32 bits unconditionally; an
`Int32Mul` without `noOverflow` does not, because the pipeline is going to widen it to
`Float64Mul` at ordinal #19 ([Ch 46 § minus-zero-and-nooverflow]). So `x * 4 → x << 2` is
value-preserving only where overflow has already been excluded. The two tests that isolate
exactly this build a graph identical to the passing case except for the missing flag:
[t: tests/optimizing/passes/simplify.test.ts > "does NOT reduce multiply by power of 2 to shift when overflow is possible"]
and
[t: tests/optimizing/passes/simplify.test.ts > "does NOT decompose multiply by 3 when overflow is possible"].
Their positives are
[t: tests/optimizing/passes/simplify.test.ts > "reduces multiply by power of 2 to shift"],
[t: tests/optimizing/passes/simplify.test.ts > "reduces multiply by 2 to shift left 1"] and
[t: tests/optimizing/passes/simplify.test.ts > "handles constant on left side of multiply"].

Here is the one place on the running example where all of it lines up. `_FixedDigits.width`
is a prelude class that `.to_fixed(2)` pulls in ([Ch 60 § prelude-three-fixed-text]), and it
multiplies a count by four. Here are the blocks that change, out of the graph's nine:

```
*** IR after #17 bounds-check-elimination [unchanged, nodes 38 -> 38 (+0), invalidated nothing] ***
  B5 succs= preds=B4,B7,B6,B8:
    v28 = Phi v16, v21, v24, v26 [index=0]
    v29 = Phi v16, v21, v12, v26 [index=1]
    v30 = Phi v13, v18, v23, v23 [index=2]
    v31 = GenericGetProp v0 [propName="count"] !fs
    v32 = Constant [value=1]
    v33 = Int32Sub v31, v32 [noOverflow=true]
    v34 = Constant [value=4]
    v35 = Int32Mul v33, v34 [noOverflow=true]
    v36 = Int32Add v35, v29 [noOverflow=true]
    v37 = Return v36

*** IR after #18 strength-reduction [changed, nodes 38 -> 39 (+1), invalidated points-to mod-ref] ***
  B0 succs=B2,B1 preds=:
    v38 = Constant [value=2]
  B5 succs= preds=B4,B7,B6,B8:
    v28 = Phi v16, v21, v24, v26 [index=0]
    v29 = Phi v16, v21, v12, v26 [index=1]
    v30 = Phi v13, v18, v23, v23 [index=2]
    v31 = GenericGetProp v0 [propName="count"] !fs
    v32 = Constant [value=1]
    v33 = Int32Sub v31, v32 [noOverflow=true]
    v34 = Constant [value=4]
    v39 = Int32Shl v33, v38
    v36 = Int32Add v39, v29 [noOverflow=true]
    v37 = Return v36
```

Two things to take from that. The node count goes **up**: `v38 = Constant 2` is a new node
and `v34 = Constant 4` is still there, now used by nothing, waiting for the dead-code sweep.
A "strength reduction" that grows the graph is normal — the pass trades a multiply for a
shift and leaves the litter for someone else.

The second thing corrects an easy assumption. The `noOverflow` on `v35` was **not** stamped by
range analysis at ordinal #17, even though range analysis is the pass that stamps
`noOverflow` and even though it runs immediately before strength reduction. Tracking `v35`
through every per-pass dump shows the flag present from ordinal **#8**, `type-narrowing`:
`settleInt32Arithmetic` (`src/optimizing/passes/type-narrowing.ts:218-238`) proved it,
because every use of `v35` chains into a `Return` in a function whose
`declaredSignature.returns` is `int`, and a declared-int return truncates
(`type-narrowing.ts:244`, [Ch 48 § settle-int32]). Range analysis is *a* producer of the
flag; on the book's own program it is not the one that paid.

## `decomposeMultiplier`, and the two shapes it knows

A constant that is not a power of two can still be reduced if it is one away from one. For a
constant `c > 1` that is not itself a power of two: if `c − 1` is a power of two, answer
`(x << log2(c−1)) + x`; if `c + 1` is, answer `(x << log2(c+1)) − x`. So 3, 5, 9, 17, 33 …
and 7, 15, 31, 63 … reduce, and 6, 11, 13 do not.
[t: tests/optimizing/passes/simplify.test.ts > "decomposes multiply by 3 to (x << 1) + x"]
and
[t: tests/optimizing/passes/simplify.test.ts > "decomposes multiply by 7 to (x << 3) - x"]
are the two shapes.

Both cases pass through a legality guard: `shift > 0 && shift < INT32_SHIFT_MASK`, where
`INT32_SHIFT_MASK` is `INT32_BITS - 1` = 31 (`src/optimizing/target/integer.ts:5`). A shift
of zero is not a simplification, and a shift of 31 or more is not a legal `Int32Shl` amount.
That is why `c = 2` reduces and a hypothetical `c = 2^31` would not.

`replaceWithSequence` (`simplify.ts:132-143`) is the part that differs from every other
rewrite in this file: it splices **two** nodes where one stood, points every use at the last
of them, and sets `block` on both. And the synthesized `Int32Add`/`Int32Sub` gets two
properties written onto it by hand:

```typescript
            result.props.noOverflow = true;
            result.frameState = node.frameState;
```
— `src/optimizing/passes/simplify.ts:191-192`

The first is the pass asserting what it just proved: it only got here because the original
multiply was stamped `noOverflow`, so the add that reconstructs it cannot overflow either.
The second is the rule this whole part of the book runs on — the rewrite must not lose the
deopt point. Drop `frameState` here and a node that can bail out has nowhere to bail out to
([Ch 40 § who-must-own-one]). The single-node path does the same at `simplify.ts:171`.

## Bookkeeping is a separate correctness problem from the rewrite

`tests/optimizing/passes/simplify.test.ts` has four `describe` blocks, and the fourth is
called `strengthReduction def-use bookkeeping`. It contains three tests, and none of them
checks what value the rewritten graph computes. They check whether the replaced node left its
inputs' `uses` arrays:
[t: tests/optimizing/passes/simplify.test.ts > "drops the replaced multiply from the use lists of its inputs"],
[t: tests/optimizing/passes/simplify.test.ts > "drops the replaced multiply when it decomposes into a shift and an add"],
and
[t: tests/optimizing/passes/simplify.test.ts > "drops a subtraction of a value from itself from that value's use list"].

Those are the pass's three exit paths — `replaceInPlace` from the shift branch,
`replaceWithSequence` from the decomposition branch, and `replaceInPlace` again from the
`x - x → 0` rule at `simplify.ts:204-212`
[t: tests/optimizing/passes/simplify.test.ts > "reduces x - x to 0"] — and each one calls
`detachUsesOf` separately. A test that only checked the resulting arithmetic would pass with
any of the three `detachUsesOf` calls deleted, and the graph would then carry a use list
naming a node that is no longer in any block. **The general rule: in a graph IR, "did the
rewrite produce the right value" and "did the rewrite leave the graph consistent" are two
tests, not one.** Half the bugs in [Ch 38 § the-def-use-multiset] are the second question
answered by nobody.

## Dead code elimination is a mark-and-sweep over the def-use graph

> **New idea.** *Mark and sweep.* Start from the things that must survive, follow every
> reference outward marking what you reach, then delete everything unmarked. It is the same
> shape as a tracing garbage collector ([Ch 31 § marking]), applied to a graph of
> instructions instead of a heap of objects. The roots here are the nodes whose execution is
> observable.

`deadCodeElimination` seeds a worklist from every node for which `isRequiredEffect` holds,
pulls inputs transitively, marks parameters live unconditionally, then sweeps every unmarked
phi and node from every block. Two things in the marking loop are worth stopping on.

The first is in the root predicate:

```typescript
export function hasObservableEffect(node: CFGInstruction): boolean {
  const spec = operationOf(node.type);
  if (spec.terminator || !spec.removableWhenUnused) return true;
  const current = effectsOf(node);
  return current.writes !== MEMORY_NONE || current.allocates;
}
```
— `src/optimizing/ir/operations.ts:1208-1213`

The first clause answers `true` *before* it looks at effects at all. A terminator is always
live, so **DCE never removes a branch or a jump**, no matter what its condition says.
Removing control flow is ordinal #30's job, not this pass's, and the split is what keeps
`deadCodeElimination` a pure value-graph operation that never has to think about phis in
successor blocks. Contrast `isMovable` at `:1215-1220`, which asks the *opposite* first
question — `spec.pinned || spec.terminator` disqualifies — because LICM wants to move things
and DCE wants to keep them.
[t: tests/optimizing/ir/operations.test.ts > "drives dead code elimination: stores survive, unused loads and arithmetic do not"]
and
[t: tests/optimizing/ir/operations.test.ts > "keeps an unused call that declares unknown effects but drops a pure one"]
pin the effect half.

The second is three lines in the worklist:

```typescript
    if (node.frameState) {
      markFrameStateValues(node.frameState, liveNodes, worklist);
    }
```
— `src/optimizing/passes/dce.ts:33-35`

A value that is used only by a deopt snapshot has an empty `uses` array and looks exactly
like garbage. Deleting it leaves a hole in the interpreter frame that a bailout will rebuild
from, and the failure appears much later as a local with the wrong value in an entirely
different function. `uses.length === 0` is not death ([Ch 40 § who-must-own-one]); the second
use graph has to be walked too, and `markFrameStateValues` is how this pass walks it. Where
the hole would surface is [Ch 54 § materialization].

## A trivial phi, and Braun's re-enqueue

> **New idea.** *A trivial phi.* A phi merges one value per predecessor. If, ignoring `null`
> inputs and inputs that are the phi itself, every input is the *same* node, the phi merges
> nothing: whichever way control arrived, the value is that node. Such a phi is **trivial**
> and can be replaced by its unique input. The definition and the algorithm are Braun et
> al.'s, and [Ch 39 § the-problem-a-loop-header-has] is where these phis get created.

`eliminateTrivialPhis` seeds a worklist with every phi in the graph and drains it. The line
that makes it an algorithm rather than a scan is this one:

```typescript
    const phiUses = phi.uses.filter((use) => use.type === ir.IR_PHI && use !== phi);
    replaceValueUses(graph, phi, unique);
    folds.set(phi, unique);
    for (const use of phiUses) enqueue(use);
```
— `src/optimizing/passes/dce.ts:93-96`

The phi's *phi users* are collected **before** `replaceValueUses` rewrites them, because
afterwards those edges name `unique` and the phi's use list is empty. Then they are
re-enqueued, because folding one phi can make its consumers trivial: a phi merging `p` and
`p` where `p` itself just collapsed to `x` is now a phi merging `x` and `x`. Without the
re-enqueue the pass would need to be run to a fixpoint from outside; with it, one call
suffices.

Removal is deferred to a second sweep over `block.phis` after the worklist drains, so the
phi lists stay stable while the algorithm runs, and the pass ends with `graph.rebuildUses()`.
[t: tests/optimizing/passes/dce.test.ts > "removes unused phis and their inputs"] and
[t: tests/optimizing/passes/dce.test.ts > "keeps phis that a live node uses"] are the pins
on the phi half of the family.

## Why it runs at ordinal 3, before LICM

`trivial-phi-elimination-early` is ordinal #3 and LICM is #5, and the gap between them is not
stylistic.

LICM's invariance worklist demands that every input of a candidate be defined outside the
loop. A value that enters through a loop-header phi is, by that test, defined *inside*: the
phi is a node, and the header is in `loop.blocks`. If the phi is trivial — every input naming
the same outside value — then semantically the value *is* from outside, but LICM has no way
to see that, because it reasons about nodes and this node is in the loop.

Delete the trivial phi first and the chain behind it becomes visible. The pair
[t: tests/optimizing/pipeline-order.test.ts > "cannot hoist a value carried through an untouched loop-header phi"]
and
[t: tests/optimizing/pipeline-order.test.ts > "hoists that same value once trivial phis have been eliminated first"]
runs the same graph twice with only the ordering changed, which is the only way to write this
test: neither pass alone says anything ([Ch 46 § the-worklist-and-why-the-pipeline-order-matters]).

**The general rule: a canonicalization pass earns its place in the pipeline by what it
unblocks, not by what it removes.** On `stats.tera`, `trivial-phi-elimination-early` reports
`changed` on eight of twenty-one graphs and the node count barely moves; what it is for is
the nine LICM changes two ordinals later.

## The other two sweepers

`eliminateDeadPhis` removes a phi with no uses **and not named by any frame state** — the
same rule as DCE's, arranged differently. Because a phi has no `frameState` of its own to
walk, the pass first builds a `frameStateReferenced` set by running `visitFrameStateValues`
over every frame state in the graph, then filters against it (`dce.ts:110-118`, the test at
`:127`). It loops `while (changed)` because removing one phi can drop the last use of
another.

`eliminateUnreachableBlocks` is a BFS from `graph.entry` with an early `return 0` when every
block is reachable — worth having, because it runs three times in the pipeline and usually
finds nothing
[t: tests/optimizing/passes/dce.test.ts > "returns 0 when all blocks are reachable"],
[t: tests/optimizing/passes/dce.test.ts > "returns 0 for graph without entry"]. When it does
find something, the order of the two cleanups matters: `detachUsesOfAll` on every node in
every dead block first, then `disconnect(dead, succ)` on every edge from a dead block into a
*live* one. The `disconnect` is what makes the live successor's phis drop the input for that
predecessor; skip it and a surviving phi has more inputs than the block has predecessors,
which is exactly the canonical-phi invariant [Ch 38 § canonical-phi-ssa] rests on.
[t: tests/optimizing/passes/dce.test.ts > "removes blocks not reachable from entry"] and
[t: tests/optimizing/passes/dce.test.ts > "disconnects unreachable block from successors"]
are the two halves.

The pairing worth naming is with SCCP. Nothing in this file ever makes a block unreachable;
`sccp.ts:341`'s `rewriteBranchAsJump` does, when it proves a branch condition constant and
drops the dead edge
[t: tests/optimizing/passes/sccp.test.ts > "rewrites the constant branch to a jump and drops the dead edge"].
That happens at ordinal #9 and the stranded block sits in `graph.blocks` until ordinal #30 —
twenty-one passes later, every one of which walks `graph.blocks` and visits it.

## The DCE family is ten of the thirty-three passes

Four functions, ten registrations: ordinals 3, 22, 23, 25, 26, 27, 29, 30, 31 and 32. That is
just under a third of the middle end, and the reason is that every one of them follows a pass
that is allowed to leave litter. `escape-analysis` deletes an allocation and leaves the phis
that merged it. `loop-check-peeling` duplicates a guard. `loop-unswitching` duplicates a whole
loop and calls `eliminateUnreachableBlocks` itself before it returns. `sccp` strands blocks.
`strength-reduction` leaves `v34 = Constant 4` behind, as we watched it do. Each of those
passes is simpler for not having to clean up after itself, and the price is a sweep.

The cost side, stated honestly: these are whole-graph sweeps, they are re-run
unconditionally, and none of them is measured — there is no benchmark harness in this tree
([CONVENTIONS § 9](../CONVENTIONS.md)). The only lever for skipping one is the pass manager's
`optional` flag and the opt-bisect driver ([Ch 41 § opt-bisect]), which exists to find
miscompiles, not to tune.

> **Unfinished.** `algebraicSimplification` (`simplify.ts:55-78`) re-scans **every block and
> every node** on each iteration of its outer `while (changed)` loop, and sets `changed` from
> any single rewrite anywhere in the graph. On a graph where each fold exposes the next this
> is quadratic in the number of folds. It is not measured, and on `stats.tera` it never fires
> at all, so nothing in this tree has ever paid for it. Cost to finish: a worklist seeded
> from the uses of each rewritten node, which is the shape `eliminateTrivialPhis` already
> uses forty lines away.

> **Unfinished.** `strengthReduction` handles only `IR_INT32_MUL`. `Int32Div` and `Int32Mod`
> are excluded on purpose and correctly — the two `does NOT` titles above are the reason —
> but the *sound* versions are not implemented either: a power-of-two divide guarded by a
> proved-non-negative range is safe, and `checks.ts`'s `nonNegative` already computes exactly
> that predicate one ordinal earlier. Cost to finish: thread the `Range` map out of
> `rangeAnalysisAndBoundsCheckElimination` (#17) into `strengthReduction` (#18); today the two
> adjacent passes share nothing but the graph. **[unpinned]**.

> **Fires nowhere on the spine** — and none of the five honesty markers applies, because the
> pass is reached, called and correct. `algebraic-simplification` (#10) and
> `algebraic-simplification-after-escape` (#14) report `unchanged` for **all twenty-one**
> functions a `docs/example/stats.tera` compile produces — the `Series` constructor and its
> two methods, `report`, the sixteen `_FixedDigits` / `_FixedText` / `_fixed_text` prelude
> functions, and `tera_program`. The pass is live, tested and shipped; the running example
> contains nothing for it to fold. That is convention 2's limit, stated in the chapter opener
> rather than implied away.

## What leaves

The smallest graph the middle end will produce. No block unreachable from the entry, no
trivial phi, no phi nothing reads and no frame state names, no node whose value nothing
observes and no deopt snapshot mentions. `Int32Mul` by a small constant has become a shift, or
a shift and one add, with `noOverflow` carried onto the synthesized node and the original's
frame state carried with it. Every `Int32Add`, `Int32Sub` and `Int32Mul` is either stamped
`noOverflow` or was already widened to its `Float64` form at ordinal #19, so nothing
downstream has to ask whether an int32 operation might not be one.

What this graph does **not** carry is any statement about how each surviving value is *held*
in a machine — whether a number lives as a tagged pointer, an unboxed 32-bit integer or a
64-bit double, and where a conversion has to be inserted between them. That is the last thing
the middle end decides, it is decided for the wasm target only, and it is
[Ch 48 § representation]'s subject.

## Verify it yourself

```bash
# which middle-end passes change anything on the running example
# (two pipelines share ordinals; #27 appears twice for that reason)
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats-c 2>&1 \
  | grep '^\*\*\* IR after' | grep '\[changed' | sed 's/, nodes.*//' | sort | uniq -c | sort -rn

# the one strength reduction in the whole program: _FixedDigits.width, x*4 -> x<<2
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats-c 2>&1 \
  | grep -n "Int32Mul v33\|Int32Shl v33"

# the signed-zero divergence: three tiers disagree with the interpreter
printf 'fn f(x: float) -> float:\n  return x + 0.0\n\nprint(1.0 / f(-0.0))\n' > /tmp/negzero.tera
node dist/cli.js /tmp/negzero.tera
node dist/cli.js --no-opt /tmp/negzero.tera
node dist/cli.js --opt-threshold 1 --baseline-threshold 1 /tmp/negzero.tera
node dist/cli.js compile /tmp/negzero.tera -o /tmp/negzero.exe && /tmp/negzero.exe

# and the pass that did it
node dist/cli.js compile /tmp/negzero.tera --emit source --target c --print-after-all -o /tmp/nz 2>&1 \
  | grep '^\*\*\* IR after' | grep '\[changed' | grep -i simplif

# the four identities, the three refusals, the bookkeeping block, and the sweepers (31 tests)
npx vitest run --project unit tests/optimizing/passes/simplify.test.ts tests/optimizing/passes/dce.test.ts

# pass order as a correctness property (11 tests)
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts
```

Run on 2026-09-08: the first command lists `#18 strength-reduction` with a count of `1` and
does not list `algebraic-simplification` at all. The signed-zero probe prints `Infinity`,
`Infinity`, `-Infinity`, `-Infinity` in that order. The fifth command prints
`*** IR after #10 algebraic-simplification [changed, nodes 4 -> 3 (-1), invalidated nothing] ***`.
Note that `--print-after-all` is a `compile`-only flag, and that `-o` names a **directory**
under `--emit source`.

## Tests that pin this

- `tests/optimizing/passes/simplify.test.ts` > `"x + 0 => x"` — the shipped rule, and the one the honesty item above says is wrong on doubles.
- `tests/optimizing/passes/simplify.test.ts` > `"0 + x => x"` — `identityOperand` checks both operands.
- `tests/optimizing/passes/simplify.test.ts` > `"x * 1 => x"` — the second shipped rule.
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT reduce x * 0 to 0 (unsound: negative x yields -0, NaN and Infinity yield NaN)"` — three counterexamples in a title.
- `tests/optimizing/passes/simplify.test.ts` > `"still reduces x * 1 to x"` — and why `* 1` is safe where `* 0` is not.
- `tests/optimizing/passes/simplify.test.ts` > `"cancels double negation"` — `Neg` is an involution.
- `tests/optimizing/passes/simplify.test.ts` > `"cancels double not over a boolean-producing value"` — `Not` is one only on booleans.
- `tests/optimizing/passes/simplify.test.ts` > `"keeps double not over a non-boolean value (it coerces to boolean)"` — the guard.
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT reduce divide by power of 2 to shift (unsound for negative dividends)"` — shift rounds to −∞, division truncates to zero.
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT reduce mod by power of 2 to bitwise-and (unsound for negative dividends)"` — the remainder takes the dividend's sign.
- `tests/optimizing/passes/simplify.test.ts` > `"reduces multiply by power of 2 to shift"` — the transform.
- `tests/optimizing/passes/simplify.test.ts` > `"reduces multiply by 2 to shift left 1"` — the smallest legal shift.
- `tests/optimizing/passes/simplify.test.ts` > `"handles constant on left side of multiply"` — either operand may be the constant.
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT reduce multiply by power of 2 to shift when overflow is possible"` — the `noOverflow` gate, isolated.
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT decompose multiply by 3 when overflow is possible"` — the same gate on the decomposition path.
- `tests/optimizing/passes/simplify.test.ts` > `"decomposes multiply by 3 to (x << 1) + x"` — `c − 1` is a power of two.
- `tests/optimizing/passes/simplify.test.ts` > `"decomposes multiply by 7 to (x << 3) - x"` — `c + 1` is.
- `tests/optimizing/passes/simplify.test.ts` > `"reduces x - x to 0"` — the pass's third rewrite.
- `tests/optimizing/passes/simplify.test.ts` > `"drops the replaced multiply from the use lists of its inputs"` — bookkeeping, exit path one.
- `tests/optimizing/passes/simplify.test.ts` > `"drops the replaced multiply when it decomposes into a shift and an add"` — exit path two.
- `tests/optimizing/passes/simplify.test.ts` > `"drops a subtraction of a value from itself from that value's use list"` — exit path three.
- `tests/optimizing/passes/dce.test.ts` > `"removes unused pure computation"` — the base case.
- `tests/optimizing/passes/dce.test.ts` > `"keeps used computation"` — its converse.
- `tests/optimizing/passes/dce.test.ts` > `"keeps side-effecting nodes even without uses"` — `hasObservableEffect` as the root set.
- `tests/optimizing/passes/dce.test.ts` > `"removes chains of dead nodes"` — the sweep is transitive because the marking is.
- `tests/optimizing/passes/dce.test.ts` > `"removes unused phis and their inputs"` — phis are swept in the same pass.
- `tests/optimizing/passes/dce.test.ts` > `"keeps phis that a live node uses"` — and kept when reached.
- `tests/optimizing/passes/dce.test.ts` > `"removes blocks not reachable from entry"` — the BFS.
- `tests/optimizing/passes/dce.test.ts` > `"returns 0 when all blocks are reachable"` — the early exit that makes three registrations affordable.
- `tests/optimizing/passes/dce.test.ts` > `"disconnects unreachable block from successors"` — why the live successor's phis stay canonical.
- `tests/optimizing/passes/dce.test.ts` > `"returns 0 for graph without entry"` — the degenerate graph.
- `tests/optimizing/ir/operations.test.ts` > `"drives dead code elimination: stores survive, unused loads and arithmetic do not"` — the effect half of `hasObservableEffect`.
- `tests/optimizing/ir/operations.test.ts` > `"keeps an unused call that declares unknown effects but drops a pure one"` — declared effects decide, not the opcode name.
- `tests/optimizing/ir/operations.test.ts` > `"derives the boolean-producing operations from their type transfers"` — the enforcement for `producesBoolean`.
- `tests/optimizing/ir/operations.test.ts` > `"stops requiring a frame state once overflow is proven impossible"` — the other side of the `noOverflow` flag this chapter consumes.
- `tests/optimizing/pipeline-order.test.ts` > `"cannot hoist a value carried through an untouched loop-header phi"` — why ordinal #3 exists.
- `tests/optimizing/pipeline-order.test.ts` > `"hoists that same value once trivial phis have been eliminated first"` — what it unblocks at #5.
- `tests/optimizing/passes/sccp.test.ts` > `"rewrites the constant branch to a jump and drops the dead edge"` — what strands the blocks that ordinal #30 collects.
- **No test pins the `Float64Add` zero identity in either direction.** `[unpinned]` — the `> **Broken.**` item above is a measurement, not a regression test.
