# 44. GVN-PRE   ⟨J · N⟩

> **Status:** outline

**Thesis.** Full redundancy is a leader table plus dominance; partial redundancy is phi
translation, per-predecessor availability, and a critical edge you have to split before you
can use it.

**What arrived.** The graph after `intrinsic-cse`: constants folded, loads forwarded,
non-escaping objects scalar-replaced, and every effect-free computation still sitting exactly
where the builder put it.

**What leaves.** Congruent computations collapsed onto one leader; partially redundant ones
turned into a phi at the merge, with a materialized copy inserted on each predecessor that
lacked the value — and possibly one or more new blocks created by splitting critical edges.
GVN declares `{kind:"none"}`, so the whole analysis cache goes with it.

**New ideas.** Value numbering and congruence; leader; availability vs anticipability;
partial redundancy elimination; critical edge and edge splitting; phi translation.

**Length.** 14 pages

## Anchors

- `src/optimizing/passes/gvn.ts` — `globalValueNumbering`, `ValueNumbering` (`numberOf`,
  `adopt`, `projectedValue`, `keyOf`, `keyFor`, `operandToken`, `propsToken`, `literalToken`,
  `shapeToken`, `recordToken`, `referenceOf`, `intern`), `LeaderTable` (`define`, `reaching`),
  `Redundancy` (`run`, `visit`, `forward`, `anticipate`, `project`, `materialize`,
  `splitCriticalEdge`, `originOf`), `Projection` / `Insertion` / `AVAILABLE` / `INSERTABLE`,
  `isCongruenceCandidate`, `isMotionCandidate`, `isCriticalEdge`, `scalarToken`,
  `isPlainData`, `IDENTITY_VALUED`, `COMMUTATIVE_OPS`, and the token alphabet
  (`FIELD`, `ASSIGN`, `REFERENCE`, `OPEN_LIST`, `NEGATIVE_ZERO`, …).
- `src/optimizing/ir/cfg-edit.ts` — `splitEdge` (creates a block, rewires one predecessor
  slot and one successor slot, calls `retargetTerminator`, adds a stamped `Jump`),
  `retargetTerminator`, `BLOCK_TARGET_PROPS`, `addPhi`, `phiInputFor`, `link`, `connect`,
  `predecessorIndex`.
- `src/optimizing/analyses/dominance.ts` — `DominatorTree.dominates`, `.reversePostorder()`.
- `src/optimizing/ir/graph-edit.ts` — `nodeIdStamper`, `Stamp`, `replaceValueUses`,
  `detachNode`, `retainNodes`.
- `src/optimizing/ir/operations.ts` — `isEffectFree` (the gate: no reads, no writes, no
  allocation, `deopt !== DEOPT_ALWAYS`, not a terminator).
- `src/optimizing/pipeline.ts` — `step("gvn", invalidatesAnalyses, …, [dominanceId])`,
  ordinal 16, `requires` dominance only.

## Worked example

`tests/optimizing/passes/gvn.test.ts` > `"does not hoist into a loop across a back edge"`.
The graph is a diamond feeding a loop: one arm computes `Int32Mul(left, right)`, the other
does not, and the *loop header* computes it again. Two of its three assertions are the point:

```ts
expect(runGvn(graph)).toBe(0);
expect(latch.nodes).toHaveLength(1);
```
— tests/optimizing/passes/gvn.test.ts:395-396

Establish that the test does not merely assert "nothing moved" — it asserts the **latch still
holds exactly one node** (its `Jump`). If the back-edge refusal were removed, `anticipate`
would find the header has two predecessors, project the expression through each, fail to find
a leader on the latch side, and *materialize a copy inside the loop* — a computation moved
from once-per-loop to once-per-iteration. That single line is the difference between PRE and
pessimization:

```ts
if (this.dominance.dominates(block, this.originOf(pred))) return false;
```
— src/optimizing/passes/gvn.ts:278

## Outline

- [ ] **`> **New idea.**` Value numbering.** Establish congruence: two nodes get the same
      number when they compute the same thing from the same things. Establish that the number
      is derived, not assigned — `intern(key)` on a string key. Contrast with a hash-consing
      IR where equality is structural by construction (this one is not; `CFGInstruction` has
      an id and identity).
- [ ] **Building the key.** Establish `keyFor(node, operands)` = opcode + operand token +
      props token. Walk each piece:
      - operands are *value numbers*, not node ids, so `numberOf` recurses through inputs;
      - `COMMUTATIVE_OPS` with exactly two operands are sorted ascending, so `add(a,b)` and
        `add(b,a)` intern to one key;
      - props are visited in `Object.keys(...).sort()` order, so key order is stable;
      - `IDENTITY_VALUED` (`Parameter`, `Phi`) and `Constant` are *not* congruence
        candidates, but `Constant` still gets a key — which is how two separately-built
        `Constant(5)` nodes number as one value.
- [ ] **`> **New idea.**` Encoding metadata into a string, and the three traps.** Establish
      `scalarToken`'s explicit `-0` case (`Object.is(value, -0) ? "-0" : String(value)`) — the
      reason positive and negative zero constants stay apart. Establish `shapeToken`'s split:
      arrays and plain-`Object.prototype` records are encoded structurally; **anything else is
      compared by identity** via `referenceOf`, an insertion-ordered `Map<unknown, number>`.
      Establish the `open: Set<unknown>` cycle guard that terminates a metadata record
      referring to itself by falling back to a reference token. Establish that `literalToken`
      (used only for the `"value"` prop) always compares objects by identity, never
      structurally — so `Constant` nodes holding two structurally-equal objects stay apart.
- [ ] **Full redundancy: the leader table in reverse postorder.** Establish
      `Redundancy.run()`: seed the table with parameters, then walk
      `dominance.reversePostorder()` visiting each node. Establish `LeaderTable.reaching`:
      scan the definitions recorded for that value number and return the first whose home
      block dominates *the origin of* the asking block (a definition with `block === null`
      is unconditionally available). Establish `forward`: redirect uses, adopt the dead node's
      frame state onto the replacement if the replacement had none, detach, and defer the
      block splice to `retainNodes` at the end of the run.
- [ ] **`> **New idea.**` Anticipability, and why it is the harder half.** Establish the
      shape: a value computed on *some* paths into a merge and recomputed at the merge is
      *partially* redundant. Establish the fix: make it available on *every* path, then merge
      with a phi, so it is computed exactly once per path instead of twice on some.
- [ ] **`project`: phi translation, per-predecessor.** Establish the loop in `project`:
      - an input that is a **phi in this very block** is translated to `phiInputFor(input, pred)`
        — the incoming value on that edge;
      - any other input is looked up by its value number in `pred` via `leaders.reaching`;
        if no leader reaches, `complete = false`;
      - the projected value number is then `projectedValue(node, values)` — the *same* key
        function, fed translated operand numbers;
      - if a leader for that projected number already reaches `pred`, the projection is
        `AVAILABLE`; otherwise it is `INSERTABLE` only if every operand was available.
      Pin with `"translates a phi operand to its incoming value in each predecessor"` and
      `"refuses to move an expression whose operand is not available in a predecessor"`.
- [ ] **`anticipate`: the four refusals, in order.** Establish them as a specification:
      1. `!isMotionCandidate(node)` — congruence candidate **and** `frameState === null`.
         A node that can deopt cannot be moved to a predecessor, because its frame state
         describes a program point it would no longer be at.
      2. `block.predecessors.length < MERGE_ARITY` — nothing to merge.
      3. the back-edge line above.
      4. `reached === 0` — no predecessor already had it, so inserting everywhere would add
         work rather than move it. Pin with `"leaves an expression alone when no predecessor already has it"`.
      Also establish that `isCongruenceCandidate` requires `isEffectFree`, which is why a
      `LoadField` is never moved onto a predecessor
      (`"refuses to move a memory read onto a predecessor"`).
- [ ] **`> **New idea.**` A critical edge, and why you cannot insert on one.** Establish the
      definition (`pred.successors.length > 1 && succ.predecessors.length >= 2`) and the
      failure: inserting the copy at the end of `pred` puts it on the *other* successor's path
      too, where it may be dead, may fault, or may simply be wasted. Establish `splitEdge`
      creating a one-`Jump` block between them. Pin with
      `"splits a critical edge so the insertion stays off the other successor"`.
- [ ] **The origin map.** Establish `Redundancy.origin` and `originOf`: a block created by
      `splitCriticalEdge` inherits its predecessor's identity for dominance questions, because
      the cached `DominatorTree` does not know the new block exists. Establish that this is
      the price of `requires: [dominanceId]` plus mutation — GVN edits the CFG under an
      analysis it declared it needs, and patches the gap by hand rather than recomputing.
      Note that this is also why GVN declares `{kind:"none"}`.
- [ ] **`materialize` and the join.** Establish: clone the node type and a shallow copy of its
      props, add the translated operands, splice it before the target block's terminator,
      `adopt` it into the value numbering and `define` it as a leader — then `addPhi(block,
      merged)` over one value per predecessor, stamp it, adopt the same value number, define it
      as a leader, and `forward` the original onto it. Pin the two shapes:
      `"inserts on the edge that lacks the expression and merges with a phi"` and
      `"merges with a phi and inserts nothing when every predecessor has the value"`.
- [ ] **Stamping, again.** Establish that every node GVN creates goes through
      `this.stamp` — the phi, the materialized copy, and the `Jump` inside `splitEdge` (which
      takes the stamp as a parameter for exactly this reason). Pin with
      `"gives every node it creates an unused identifier"` and cross-reference
      [Ch 43 § node-id-stamping].

## Honesty items

> **Unfinished.** GVN-PRE runs once, at ordinal 16, and nothing re-runs it. Because
> `materialize` creates new leaders and `anticipate` creates new phis, a second run can
> expose redundancy the first created; the pipeline does not take it. Compare
> `string-split-lowering`, which `tests/optimizing/pipeline-order.test.ts` >
> `"runs the split lowering to a fixpoint rather than once"` explicitly pins as iterated.
> Cost: a fixpoint loop plus a bound, and a measurement that does not exist in this tree.

> **Unenforced.** The `origin` map keeps dominance questions answerable for blocks GVN itself
> created, but nothing checks it stays consistent — `originOf` silently returns the block
> itself for any block not in the map. A future pass that splits an edge without recording an
> origin would get silently wrong dominance answers rather than an error.

> **Unfinished.** `isCongruenceCandidate` requires `node.inputs.length > 0`, so a
> zero-operand effect-free node is never numbered. Today that only excludes `Constant`
> (handled separately) and `Parameter` (in `IDENTITY_VALUED`), but it means any future
> nullary pure opcode is silently outside GVN.

> **Never runs.** `ValueNumbering.projectedValue` is public on the class but has exactly one
> caller, `Redundancy.project`. Not a defect; noted because the class reads as a reusable
> component and is not one.

## Verify it yourself

```bash
npx vitest run --project unit tests/optimizing/passes/gvn.test.ts
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | grep ' gvn '
node dist/cli.js compile docs/example/stats.tera --emit source --verify -o /tmp/stats.c
node dist/cli.js --print-ir --filter total_of docs/example/stats-deopt.tera
```

## Tests that pin this

- `tests/optimizing/passes/gvn.test.ts` > `"eliminates redundant computation with same inputs"`
- `tests/optimizing/passes/gvn.test.ts` > `"does not eliminate different operations on same inputs"`
- `tests/optimizing/passes/gvn.test.ts` > `"handles commutative ops: add(a,b) == add(b,a)"`
- `tests/optimizing/passes/gvn.test.ts` > `"propagates through dominated blocks"`
- `tests/optimizing/passes/gvn.test.ts` > `"does not eliminate nodes with side effects"`
- `tests/optimizing/passes/gvn.test.ts` > `"numbers equal constants written by different nodes as one value"`
- `tests/optimizing/passes/gvn.test.ts` > `"keeps expressions apart when a distinguishing property differs"`
- `tests/optimizing/passes/gvn.test.ts` > `"treats equal metadata records on two nodes as the same value"`
- `tests/optimizing/passes/gvn.test.ts` > `"keeps nodes apart when their metadata records differ"`
- `tests/optimizing/passes/gvn.test.ts` > `"terminates on a metadata record that refers to itself"`
- `tests/optimizing/passes/gvn.test.ts` > `"compares constants that hold objects by identity"`
- `tests/optimizing/passes/gvn.test.ts` > `"separates positive and negative zero constants"`
- `tests/optimizing/passes/gvn.test.ts` > `"inserts on the edge that lacks the expression and merges with a phi"`
- `tests/optimizing/passes/gvn.test.ts` > `"leaves an expression alone when no predecessor already has it"`
- `tests/optimizing/passes/gvn.test.ts` > `"splits a critical edge so the insertion stays off the other successor"`
- `tests/optimizing/passes/gvn.test.ts` > `"merges with a phi and inserts nothing when every predecessor has the value"`
- `tests/optimizing/passes/gvn.test.ts` > `"does not hoist into a loop across a back edge"`
- `tests/optimizing/passes/gvn.test.ts` > `"refuses to move a memory read onto a predecessor"`
- `tests/optimizing/passes/gvn.test.ts` > `"refuses to move an expression whose operand is not available in a predecessor"`
- `tests/optimizing/passes/gvn.test.ts` > `"translates a phi operand to its incoming value in each predecessor"`
- `tests/optimizing/passes/gvn.test.ts` > `"gives every node it creates an unused identifier"`
- `tests/optimizing/pipeline.test.ts` > `"attributes each change and invalidation to the pass that caused it"`
