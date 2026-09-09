# 44. GVN-PRE   ⟨J · N⟩

[Ch 43] asked what a value *is*. This chapter asks a different question about the same
graph: is this computation the same as that one? The answer turns out to have two halves
that look alike and are not.

The first half is easy and mostly bookkeeping. If a computation already happened on every
path that reaches this point, do not do it again — redirect the uses at the earlier one and
drop the later. That is **full redundancy elimination**, and it needs two things: a way to
decide that two nodes compute the same thing, and a way to decide that one of them always
runs before the other. The first is a hash key. The second is dominance, which
[Ch 42 § dominance] already built.

The second half is where the difficulty lives. A computation that happened on *some* paths
into a merge, and is recomputed at the merge, is not fully redundant — the earlier copy does
not dominate — but it is **partially** redundant, and it can be made fully redundant by
inserting a copy on the paths that lacked it and merging the results with a phi. The
computation then happens exactly once per path instead of twice on some. Doing that requires
translating the expression through the phis at the merge, asking per predecessor whether
every operand is available there, and — when the edge you want to insert on leads to a block
with more than one predecessor from a block with more than one successor — **splitting that
edge first**, because there is nowhere on it to put anything.

Every step of that second half can also make the program slower if you get a condition
wrong. Insert into a loop and a once-per-loop computation becomes once-per-iteration. Insert
onto a critical edge and the copy runs on a path that never wanted it. Insert an expression
no predecessor already had and you have added work rather than moved it. `gvn.ts` is one
class, `Redundancy`, and roughly half of it is the refusals.

`stats.tera` reaches the first half and never reaches the second. Across the whole native
compile the pass runs twenty-one times, reports `changed` twice, and both times the change is
`nodes N -> N-1`: one node forwarded onto a dominating leader, no copy materialized, no phi
created, no edge split. Per [CONVENTIONS § 2](../CONVENTIONS.md) this chapter says so rather
than manufacturing a ninth variation file. The full-redundancy walk is shown on the running
example, out of `--print-after-all`; partial redundancy is shown through the pass's own
twenty-two unit-test graphs, which are real artifacts in `tests/optimizing/passes/gvn.test.ts`.

**What arrived.** The graph after `intrinsic-cse` (ordinal 15): constants folded and branches
on proved conditions rewritten by the two SCCP runs ([Ch 43 § what-leaves]), loads forwarded
past stores that cannot have clobbered them, non-escaping objects replaced by scalars, and
intrinsic reads with equal effect domains already shared. What has *not* happened is any
motion. Every effect-free computation is still sitting exactly where the builder put it, and
a dominator tree is warm in the analysis cache — GVN declares `requires: [dominanceId]` and
nothing else (`src/optimizing/pipeline.ts:201-206`).

## Value numbering

> **New idea. Value numbering and congruence.** Two computations are **congruent** when they
> compute the same thing from the same things. That is not the same as being structurally
> identical: `add(a, b)` and `add(b, a)` are congruent because addition commutes, and
> `add(a, 5)` and `add(a, 5)` written by two different parts of the compiler are congruent
> even though they are two objects. A **value number** is an integer standing for one
> congruence class. Give every node a value number, and "are these two the same computation?"
> becomes "are these two integers equal?".
>
> The number is *derived*, never assigned. You build a string key out of the node — its
> opcode, the value numbers of its operands, and whatever properties distinguish it — and
> **intern** the key: look it up in a table, and if it is new, hand out the next integer.
> Because operands contribute their *numbers* rather than their identities, the recursion
> composes: two multiplies are congruent when their operand pairs are congruent, however
> those operands were built.

Some IRs get congruence for free by making the representation itself hash-consed: you cannot
build two structurally identical nodes because the constructor returns the existing one.
tera's does not. `CFGInstruction` is a mutable object with an id, a block, a props bag and a
use list ([Ch 38 § three-classes-and-nothing-else]); two adds over the same operands are two
distinct objects that a pass is free to mutate independently. So congruence has to be
*computed*, and the computation has to be re-done whenever anything about a node changes —
which is exactly why the numbering is built fresh at the start of each GVN run and thrown
away at the end.

`ValueNumbering` holds three maps and a counter. `byKey` interns strings to numbers, `byNode`
memoizes each node's number, `byReference` hands out identity numbers for objects that cannot
be compared structurally. `numberOf(node)` consults `byNode` first, then builds a key, then
interns — and when `keyOf` answers `null`, it burns a fresh number instead
(`gvn.ts:87-94`). A `null` key means *this node is its own value*, and three kinds of node
get it:

```ts
function isCongruenceCandidate(node: GvnNode): boolean {
  if (IDENTITY_VALUED.has(node.type)) return false;
  if (node.type === ir.IR_CONSTANT) return false;
  if (!ir.isEffectFree(node)) return false;
  return node.inputs.length > 0;
}
```
— src/optimizing/passes/gvn.ts:66-71

`IDENTITY_VALUED` is `{ IR_PARAMETER, IR_PHI }` (`:16`). A parameter is whatever the caller
passed, and two phis with identical input lists are deliberately *not* congruent — GVN does
no phi congruence at all, and nothing else in the pipeline covers the gap:
`trivial-phi-elimination` collapses a phi whose non-self inputs are all the *same node*
(`src/optimizing/passes/dce.ts:81-91`), which is a different shape from two phis merging the
same two different values along the same two edges.

`IR_CONSTANT` is excluded from *candidacy* but not from *numbering*: `keyOf` admits it
explicitly (`:105`), so two separately-built `Constant(7)` nodes intern to one value number
even though neither is ever forwarded onto the other. That is what makes the adds above them
congruent
`[t: tests/optimizing/passes/gvn.test.ts > "numbers equal constants written by different nodes as one value"]`.
Both constants survive; the second *add* is the node that goes.

And the gate that keeps the whole pass sound is `isEffectFree`:

```ts
export function isEffectFree(node: CFGInstruction): boolean {
  const spec = operationOf(node.type);
  if (spec.terminator) return false;
  const current = effectsOf(node);
  return (
    current.reads === MEMORY_NONE &&
    current.writes === MEMORY_NONE &&
    !current.allocates &&
    current.deopt !== DEOPT_ALWAYS
  );
}
```
— src/optimizing/ir/operations.ts:1178-1188

No reads, no writes, no allocation, not a terminator, and not a node that always deopts.
Reads are excluded as well as writes because forwarding a `LoadField` onto an earlier one is
a *memory* question — whether anything wrote to that location in between — and that is
`load-elimination`'s job with the mod-ref oracle behind it ([Ch 45 § available-expressions]),
not a syntactic one
`[t: tests/optimizing/passes/gvn.test.ts > "does not eliminate nodes with side effects"]`.

Note what `isEffectFree` does *not* exclude: `DEOPT_ON_OVERFLOW`. An `Int32Add` whose
`noOverflow` was never proved can bail out, carries a frame state, and is still a congruence
candidate. That asymmetry is the whole reason there are two predicates in this file rather
than one, and § anticipate-the-refusals-in-order is where the second one appears.

Two of the exclusions above are wider than they need to be, and both fail silently.

> **Unfinished.** `isCongruenceCandidate` requires `node.inputs.length > 0`
> (`src/optimizing/passes/gvn.ts:70`), so a zero-operand effect-free node is never numbered
> and never forwarded. Today that excludes nothing that matters — `IR_CONSTANT` is handled
> separately and `IR_PARAMETER` is in `IDENTITY_VALUED` — but it means any future nullary pure
> opcode is silently outside GVN, with no diagnostic and no test that would notice. Cost to
> finish: delete the clause and confirm the two existing exclusions still fire, which they do,
> since both are tested earlier in the same function.

> **Unfinished.** GVN does no phi congruence. `IR_PHI` is in `IDENTITY_VALUED`
> (`src/optimizing/passes/gvn.ts:16`), so two phis in the same block merging the same values
> along the same edges receive different value numbers and neither is forwarded onto the
> other. Loop headers in this engine routinely carry many phis, one per live bytecode register
> — `_FixedDigits.format` records nineteen in each of its six OSR candidates — and duplicates
> among them are plausible. Cost to finish: give a phi a key built from its block and its
> inputs' value numbers, which is safe only once you decide what a phi whose inputs are not
> yet numbered does — the same optimistic-versus-pessimistic question [Ch 43] answers for
> SCCP, and GVN's single reverse-postorder sweep is not set up to answer it.

## Building the key

The key is three pieces concatenated, and each piece is a decision:

```ts
  private keyFor(node: GvnNode, operands: readonly number[]): string {
    return node.type + this.operandToken(operands, node.type) + this.propsToken(node);
  }

  private operandToken(operands: readonly number[], type: string): string {
    const ordered = [...operands];
    if (COMMUTATIVE_OPS.has(type) && ordered.length === BINARY) ordered.sort(ascending);
    return ordered.map((value) => FIELD + value).join("");
  }
```
— src/optimizing/passes/gvn.ts:109-117

**The opcode**, verbatim — `"Int32Mul"`, `"GenericAdd"`. Two different operations on the same
operands are never congruent
`[t: tests/optimizing/passes/gvn.test.ts > "does not eliminate different operations on same inputs"]`.

**The operands, as value numbers**, each prefixed by `|` so that operand `1` followed by
operand `2` cannot be confused with operand `12`. `keyOf` obtains them by
`node.inputs.map((input) => this.numberOf(input))` (`:106`), which recurses — so the key of a
node is built out of its whole operand subtree's congruence classes rather than out of node
ids.

**Commutative operands sorted.** `COMMUTATIVE_OPS` is seven opcodes — `IR_INT32_ADD`, `MUL`,
`AND`, `OR`, `XOR`, `IR_FLOAT64_ADD` and `MUL` (`:18-26`) — and for exactly two operands the
numbers are sorted ascending before joining. `add(a, b)` and `add(b, a)` therefore intern to
one key
`[t: tests/optimizing/passes/gvn.test.ts > "handles commutative ops: add(a,b) == add(b,a)"]`.
The arity test is not decoration: sorting a variadic node's operands would lose their order,
and the only reason it is safe here is that the two-input case is the only one where the
opcode's own semantics say order does not matter.

**The props, in sorted key order:**

```ts
  private propsToken(node: GvnNode): string {
    let token = "";
    for (const key of Object.keys(node.props).sort()) {
      const value = node.props[key];
      const encoded =
        key === LITERAL_PROP ? this.literalToken(value) : this.shapeToken(value, new Set());
      token += FIELD + key + ASSIGN + encoded;
    }
    return token;
  }
```
— src/optimizing/passes/gvn.ts:119-128

`Object.keys(...).sort()` is what makes the key stable: two nodes whose props were assigned in
different orders produce the same string. This is the piece that connects back to
[Ch 43 § why-the-opcode-name-lies-on-purpose]. Because the semantics of an opcode live in its
props, congruence *must* include them, and the test that pins it is exactly the case that
would otherwise be a miscompile: two `Int32Add` nodes over the same operands, one with
`noOverflow: true`, are **not** congruent, because one wraps and one deoptimizes
`[t: tests/optimizing/passes/gvn.test.ts > "keeps expressions apart when a distinguishing property differs"]`.

## Encoding metadata into a string, and the three traps

Props are not all scalars. An `elementsKind` is a string, an `argCount` is a number — but a
`declaredEffects` is an array, a `target` is a record, and some props hold objects with real
prototypes that the compiler built for other reasons. All of it has to become one string,
and there are three places where the obvious encoding is wrong.

> **New idea. When a hash key is a string, every value must have exactly one spelling.** Two
> things that are the same must produce the same characters, and — the half that is easier to
> get wrong — two things that are *different* must never produce the same characters. A string
> key is a hash function you wrote by hand, and a collision in it is not a slow lookup, it is
> a miscompile: two computations declared congruent that are not.

**Trap one: negative zero.** `String(-0)` is `"0"`. Encoding a numeric prop with `String`
alone would give `-0` and `0` one spelling, and a compiler that cannot tell them apart is
wrong about `1 / x`:

```ts
function scalarToken(value: unknown): string | null {
  if (value === null) return NULL_TOKEN;
  if (value === undefined) return UNDEFINED_TOKEN;
  const kind = typeof value;
  if (kind === "number") {
    return kind + FIELD + (Object.is(value, -0) ? NEGATIVE_ZERO : String(value));
  }
  if (kind === "string" || kind === "boolean" || kind === "bigint") {
    return kind + FIELD + String(value);
  }
  return null;
}
```
— src/optimizing/passes/gvn.ts:47-58

The `Object.is` test on line 52 is the same defence [Ch 43 § the-flat-lattice] needed one
pass earlier, for the same reason and in a different data structure. Note also that the
`typeof` is part of the token, so the number `7` and the string `"7"` cannot collide; and
that `null` and `undefined` get their own words rather than being lumped with each other
`[t: tests/optimizing/passes/gvn.test.ts > "separates positive and negative zero constants"]`.

**Trap two: structure versus identity.** `scalarToken` answers `null` for anything that is not
a primitive, and `shapeToken` decides what to do next:

```ts
  private shapeToken(value: unknown, open: Set<unknown>): string {
    const scalar = scalarToken(value);
    if (scalar !== null) return scalar;
    if (open.has(value) || !(Array.isArray(value) || isPlainData(value))) {
      return REFERENCE + this.referenceOf(value);
    }
    open.add(value);
    const token = Array.isArray(value)
      ? OPEN_LIST + value.map((item) => this.shapeToken(item, open)).join(FIELD) + CLOSE_LIST
      : this.recordToken(value as Record<string, unknown>, open);
    open.delete(value);
    return token;
  }
```
— src/optimizing/passes/gvn.ts:134-146

Arrays and *plain data* — `isPlainData` accepts only a prototype of `Object.prototype` or
`null` (`:60-64`) — are encoded structurally, recursively, with record fields sorted by
`recordToken` (`:148-153`). Two nodes carrying `{ kind: "range", bounds: [0, 4] }` are
congruent; change one bound to `5` and they are not
`[t: tests/optimizing/passes/gvn.test.ts > "treats equal metadata records on two nodes as the same value"]`,
`[t: tests/optimizing/passes/gvn.test.ts > "keeps nodes apart when their metadata records differ"]`.

Anything else — a class instance, a `Map`, a compiler-internal table — is compared by
**identity**, through `referenceOf`, an insertion-ordered `Map<unknown, number>` that hands
out a fresh integer per distinct object (`:155-161`). That is the conservative answer: two
objects that are not `===` get different tokens, so they are never merged, even if they would
have compared equal field by field. Under-merging costs an optimization; over-merging costs
correctness.

**Trap three: a record that refers to itself.** The `open: Set<unknown>` is a cycle guard,
and its handling is the interesting part. A value already `open` is not an error and does not
throw — it falls back to `REFERENCE + referenceOf(value)`, an identity token. So a cyclic
metadata record still produces a finite key, and two nodes carrying *the same* cyclic object
still produce the same key, because identity tokens are stable
`[t: tests/optimizing/passes/gvn.test.ts > "terminates on a metadata record that refers to itself"]`.
Two structurally-equal but distinct cycles would produce different keys, which is again the
safe direction.

One prop is special-cased out of all this. The key `"value"` — the payload of an
`IR_CONSTANT` — goes through `literalToken` instead, which is `scalarToken` or an identity
token and **never** a structural encoding (`:130-132`). A constant holding an object is
therefore compared by identity, so two `Constant({})` nodes stay apart
`[t: tests/optimizing/passes/gvn.test.ts > "compares constants that hold objects by identity"]`.
The reasoning is that a constant's payload is a *runtime value*, and two structurally equal
runtime objects are two objects; merging them would change what the program observes.

## Full redundancy: the leader table in reverse postorder

The transform is a single walk:

```ts
  run(): number {
    for (const parameter of this.graph.parameters) {
      this.leaders.define(this.values.numberOf(parameter), parameter);
    }
    for (const block of this.dominance.reversePostorder()) {
      for (const node of [...block.nodes]) this.visit(node, block);
    }
    if (this.removed === 0 && this.inserted === 0) return 0;
    for (const [block, nodes] of this.dropped) retainNodes(block, nodes);
    this.graph.rebuildUses();
    return this.removed + this.inserted;
  }
```
— src/optimizing/passes/gvn.ts:228-239

Reverse postorder is the order [Ch 42 § dominance] established: every block appears after all
of its dominators, so by the time a node is visited, every definition that could dominate it
has already been recorded. Parameters are seeded first with `block === null`, which makes them
unconditionally available everywhere.

`visit` is the whole decision:

```ts
  private visit(node: GvnNode, block: GvnBlock): void {
    const value = this.values.numberOf(node);
    if (!isCongruenceCandidate(node)) {
      this.leaders.define(value, node);
      return;
    }
    const dominating = this.leaders.reaching(value, block);
    if (dominating !== null && dominating !== node) {
      this.forward(node, dominating, block);
      this.removed++;
      return;
    }
    if (this.anticipate(node, block, value)) return;
    this.leaders.define(value, node);
  }
```
— src/optimizing/passes/gvn.ts:241-255

Non-candidates are still numbered and still recorded as leaders — that is how a `Constant` or
a `Phi` becomes findable as an *operand* later, which `project` needs. Candidates ask the
table, and only if the table has nothing do they try the harder half.

```ts
  reaching(value: number, block: GvnBlock): GvnNode | null {
    for (const node of this.defs.get(value) ?? []) {
      const home = node.block;
      if (home === null) return node;
      if (this.dominance.dominates(home, this.originOf(block))) return node;
    }
    return null;
  }
```
— src/optimizing/passes/gvn.ts:189-196

A linear scan of the definitions recorded for that value number, returning the first whose
home block dominates the asking block. `home === null` short-circuits to *available* — a
parameter, or a value floating outside any block. There is no "closest dominator" search: the
first match in insertion order wins, and because insertion follows reverse postorder, the
first match is the earliest one recorded, which is what you want.

Forwarding is four operations and one deferral:

```ts
  private forward(node: GvnNode, replacement: GvnNode, block: GvnBlock): void {
    if (node.frameState !== null && replacement.frameState === null) {
      replacement.frameState = node.frameState;
    }
    replaceValueUses(this.graph, node, replacement);
    detachNode(node);
    node.block = null;
    let nodes = this.dropped.get(block);
    if (nodes === undefined) {
      nodes = new Set<GvnNode>();
      this.dropped.set(block, nodes);
    }
    nodes.add(node);
  }
```
— src/optimizing/passes/gvn.ts:257-270

`replaceValueUses` is the one that makes this legal at all under [Ch 40 § the-second-use-graph]:
it rewrites the value graph *and* calls `replaceGraphFrameStateValue`, so every frame-state
slot naming the dead node now names the leader. A version of `forward` that only walked
`node.uses` would leave frame states pointing at a node no longer in any block — the exact
use-after-free that chapter is about.

The frame-state adoption on the first two lines is the mirror image: the dead node may itself
have carried a frame state, and if the leader has none it takes it over. Because props are
part of the congruence key, a leader congruent to a `DEOPT_ON_OVERFLOW` node has the same
`noOverflow` prop and therefore the same obligation, so the two nodes are never in disagreement
about *whether* a frame state is required — only about which one they hold.

The splice out of `block.nodes` is deferred to `retainNodes` at the end of the run, one filter
per block rather than one splice per removal, and the walk iterates a copy (`[...block.nodes]`)
so a node dropped mid-walk cannot disturb it. `rebuildUses()` runs once, and only when
something actually changed — the early `return 0` on line 235 is what keeps a no-op run from
invalidating the analysis cache through the pass manager's `changed` boolean
([Ch 41 § changed]).

**On `stats.tera` this is the entire story.** `_FixedDigits.shrink` computes `GenericAdd
v16, v4` in its loop header `B5`, and again in the loop body `B4`, whose only predecessor is
`B5`:

```
  B4 succs=B5 preds=B5:
    v44 = GenericGetProp v0 [propName="cells"] !fs
    v45 = GenericAdd v16, v4
    v46 = GenericGetIndex v44, v45 !fs
  B5 loop-header succs=B4,B3 preds=B1,B4:
    v16 = Phi v12, v49 [index=0]
    v24 = Phi v3, v45 [index=4]
    v39 = GenericAdd v16, v4
```
— `fn _FixedDigits.shrink` after `#15 intrinsic-cse`, in the `--print-after-all` trace, with
the surrounding phis and nodes elided

`v45` and `v39` intern to one key: same opcode, same operand numbers (`v16` and `v4` are the
same nodes), no distinguishing props. `B5` dominates `B4`, so `reaching` finds `v39`, and
after `#16 gvn` the body reads `v46 = GenericGetIndex v44, v39` and `v45` is gone — including
from `v24`'s phi input list, which `replaceValueUses` rewrote. One node removed; the header's
`GenericAdd` now serves both. The other changed run, in `_FixedDigits.format`, is the same
shape on an `Int32Add` feeding a loop phi.

## Anticipability, and why it is the harder half

> **New idea. Partial redundancy, and anticipability.** A computation at point *p* is
> **fully redundant** if it has already been computed on *every* path reaching *p* — which,
> in SSA over a dominator tree, is what "some definition dominates *p*" means. It is
> **partially redundant** if it has been computed on *some* of them. The classic picture is a
> diamond: one arm computes `a + b`, the other does not, and the merge below computes `a + b`
> again. Take the left path and you do the addition twice; take the right path and you do it
> once. Nothing dominates, so full redundancy elimination declines.
>
> The fix is to make partial redundancy *total*, and then eliminate it. Insert a copy of the
> expression at the end of every predecessor that lacked it, add a phi at the merge over one
> value per predecessor, and forward the merge's computation onto the phi. Now the addition
> happens exactly once on every path instead of twice on one, and the phi costs nothing at
> run time — a phi is a name for "whichever arrived", not an instruction.
>
> The dual of *available* (has already been computed on all paths **into** here) is
> **anticipable** (will be computed on all paths **out of** here). PRE is classically stated
> as inserting where an expression is anticipable and not available. tera does not compute an
> anticipability dataflow: `Redundancy.anticipate` works backwards from a single recomputation
> site, projecting it into each predecessor, which reaches the same insertions for the merge
> shapes it handles without a second fixpoint.

The reason this half is harder is that it *creates* code. Full redundancy elimination can
only remove nodes; every refusal costs an optimization and nothing else. Partial redundancy
elimination inserts, and every one of its conditions is load-bearing for whether the program
gets faster or slower.

## `project`: phi translation, per predecessor

Before deciding anything, `anticipate` asks what the expression would *be* in each
predecessor. That is not the same expression: if one of its operands is a phi in the merge
block, the value flowing along a given edge is that phi's input for that edge, not the phi.

```ts
  private project(node: GvnNode, block: GvnBlock, pred: GvnBlock): Projection | null {
    const operands: GvnNode[] = [];
    const values: number[] = [];
    let complete = true;
    for (const input of node.inputs) {
      if (input.type === ir.IR_PHI && input.block === block) {
        const incoming = phiInputFor(input, pred);
        if (incoming === undefined) return null;
        operands.push(incoming);
        values.push(this.values.numberOf(incoming));
        continue;
      }
      const carried = this.values.numberOf(input);
      const available = this.leaders.reaching(carried, pred);
      if (available === null) complete = false;
      else operands.push(available);
      values.push(carried);
    }
```
— src/optimizing/passes/gvn.ts:298-315

Two cases per operand. An operand that is **a phi in this very block** is translated:
`phiInputFor` finds `pred`'s index in `block.predecessors` and returns the phi's input at
that index (`src/optimizing/ir/cfg-edit.ts:116-124`) — the same positional parallelism
[Ch 38 § canonical-phi-ssa] fixes and [Ch 43 § the-executable-edge-set-is-what-makes-a-phi-tighten]
also leans on. Any **other** operand is looked up by value number in the predecessor, through
the same `leaders.reaching`; if nothing reaches, `complete` goes false.

Notice that `values` receives an entry for every operand but `operands` does not: an operand
with no available leader contributes its number to the key and no node to the copy. That is
deliberate, because the projected number is needed even when the insertion is impossible —
the expression may already exist in the predecessor under that number.

```ts
    const value = this.values.projectedValue(node, values);
    const leader = this.leaders.reaching(value, pred);
    if (leader !== null) return { kind: AVAILABLE, leader };
    return complete ? { kind: INSERTABLE, pred, value, operands } : null;
```
— src/optimizing/passes/gvn.ts:316-319

`projectedValue` is `intern(keyFor(node, values))` — the *same* key function that numbered the
original node, fed translated operand numbers instead of the node's own. That reuse is what
makes the projection trustworthy: an expression's identity in a predecessor is computed by
exactly the machinery that computed it at the merge, so a props difference or a commutative
reordering cannot make the two disagree. (`projectedValue` is public on `ValueNumbering` and
has exactly one caller, this line; the class reads like a reusable component and is not one.)

Three outcomes. **`AVAILABLE`** — a leader for the projected number already reaches this
predecessor, so nothing needs inserting there. **`INSERTABLE`** — nothing reaches, but every
operand does, so a copy can be built. **`null`** — nothing reaches and some operand is
missing, so this predecessor cannot be served at all, and `anticipate` gives up on the whole
node
`[t: tests/optimizing/passes/gvn.test.ts > "refuses to move an expression whose operand is not available in a predecessor"]`.
The phi-translation path is pinned by
`[t: tests/optimizing/passes/gvn.test.ts > "translates a phi operand to its incoming value in each predecessor"]`,
which builds a diamond where the merge computes `mul(phi, left)` and asserts that the copy
inserted in the arm that lacked it has inputs `[fromOther, left]` — the phi replaced by *that
arm's* incoming value.

## `anticipate`: the refusals, in order

```ts
  private anticipate(node: GvnNode, block: GvnBlock, value: number): boolean {
    if (!isMotionCandidate(node)) return false;
    if (block.predecessors.length < MERGE_ARITY) return false;
    const projected: Projection[] = [];
    let reached = 0;
    for (const pred of [...block.predecessors]) {
      if (this.dominance.dominates(block, this.originOf(pred))) return false;
      const projection = this.project(node, block, pred);
      if (projection === null) return false;
      projected.push(projection);
      if (projection.kind === AVAILABLE) reached++;
    }
    if (reached === 0) return false;
```
— src/optimizing/passes/gvn.ts:272-284

Five `return false`s, and each is a different kind of impossible. Read as a specification:

**1. `!isMotionCandidate(node)`** — `isCongruenceCandidate(node) && node.frameState === null`
(`:73-75`). This is the second predicate the file needs. Being congruent is enough to *merge*
a node with one that already dominates it; it is not enough to *move* it. A node that can
deoptimize carries a frame state describing the program point it is at, and moving it into a
predecessor puts it at a different program point, where that description is a lie. So a
`DEOPT_ON_OVERFLOW` arithmetic node with no proof of `noOverflow` can be forwarded and can
never be materialized. `isCongruenceCandidate`'s `isEffectFree` requirement is inherited too,
which is why a `LoadField` — congruent or not — is never placed on a predecessor
`[t: tests/optimizing/passes/gvn.test.ts > "refuses to move a memory read onto a predecessor"]`.

**2. `block.predecessors.length < MERGE_ARITY`** — fewer than two predecessors is not a merge,
so there is nothing to merge and nothing partial about the redundancy.

**3. The back edge.** `if (this.dominance.dominates(block, this.originOf(pred))) return false;`
A predecessor that the block itself dominates is reached from inside — the edge from `pred` to
`block` is a back edge ([Ch 42 § loops]), and `block` is a loop header.
This one line is the difference between PRE and pessimization. Without it, `anticipate` at a
loop header would find two or more predecessors, project the expression through each, fail to
find a leader on the latch side, and **materialize a copy inside the loop** — turning a
computation that ran once per entry into one that runs once per iteration. The test that pins
it does not merely assert that nothing moved:

```ts
    expect(runGvn(graph)).toBe(0);
    expect(latch.nodes).toHaveLength(1);
```
— tests/optimizing/passes/gvn.test.ts:396-397

The latch still holds exactly one node — its `Jump` — and the block on the other entry arm
still holds exactly one, and the graph has no phis at all
`[t: tests/optimizing/passes/gvn.test.ts > "does not hoist into a loop across a back edge"]`.
Hoisting *out* of loops is a different pass with different gates
([Ch 46 § licms-first-gate-is-a-frame-state]); GVN's job here is only not to make things worse.

**4. `project` answered `null`** — an operand is unavailable in some predecessor, as above.

**5. `reached === 0`** — no predecessor already had the value. This is the arithmetic
condition on whether the transform is a win. If every predecessor needs an insertion, then
after the transform the expression is computed once on every path instead of once at the
merge on every path: the same work, plus a phi, plus more code. The pass declines
`[t: tests/optimizing/passes/gvn.test.ts > "leaves an expression alone when no predecessor already has it"]`.

## A critical edge, and why you cannot insert on one

> **New idea. A critical edge.** An edge from block *P* to block *S* is **critical** when *P*
> has more than one successor and *S* has more than one predecessor. It is the one edge shape
> on which you cannot place code. "At the end of *P*" is wrong, because *P*'s other successor
> is reached through the same instructions — anything you put there runs on that path too,
> where it may be unwanted, wasted, or faulting. "At the start of *S*" is wrong, because *S*
> is reached from other predecessors as well, which is exactly the paths you were trying to
> avoid.
>
> The fix is to make the edge into a place: **split** it by inserting a new block that has *P*
> as its only predecessor and *S* as its only successor, containing nothing but a jump. Now
> "on the edge" is a real location. Splitting is not free — it is a block and a branch — but
> the alternative is either an incorrect insertion or no insertion at all.

The test is three tokens, and it is the definition:

```ts
function isCriticalEdge(pred: GvnBlock, succ: GvnBlock): boolean {
  return pred.successors.length > SINGLE_SUCCESSOR && succ.predecessors.length >= MERGE_ARITY;
}
```
— src/optimizing/passes/gvn.ts:77-79

The split itself is shared infrastructure, not GVN-local:

```ts
export function splitEdge(
  graph: CFGFunction,
  pred: CFGBlock,
  succ: CFGBlock,
  stamp: Stamp,
): CFGBlock {
  const middle = graph.addBlock();
  succ.predecessors[succ.predecessors.indexOf(pred)] = middle;
  pred.successors[pred.successors.indexOf(succ)] = middle;
  middle.predecessors.push(pred);
  middle.successors.push(succ);
  retargetTerminator(pred, succ, middle);
  middle.addNode(stamp(irJump(succ)));
  return middle;
}
```
— src/optimizing/ir/cfg-edit.ts:70-84

Four things happen and all four are necessary. The new block replaces `pred` **in place** in
`succ.predecessors` — assigning at the found index rather than pushing — because every phi in
`succ` has an input at that index and the parallelism must survive. `pred.successors` is
patched at its index for the same reason. `retargetTerminator` rewrites whichever of
`targetBlock`, `trueBlock` or `falseBlock` on `pred`'s terminator held `succ.id`
(`cfg-edit.ts:58-68`), so the props agree with the CFG. And the jump is **stamped** — the
stamp is a parameter of `splitEdge` precisely so the caller's node-id discipline reaches
inside.

The shape is pinned exactly
`[t: tests/optimizing/passes/gvn.test.ts > "splits a critical edge so the insertion stays off the other successor"]`:
one new block, `split.predecessors` is `[entry]`, `split.successors` is `[join]`,
`entry.successors` is `[guarded, split]`, the copy is in the split block, and — the assertion
that names the point — `addsIn(entry)` is empty. Nothing was left on the path that did not
want it.

## The origin map

Splitting an edge creates a block the cached `DominatorTree` has never heard of. That matters
more than it sounds, because of how `dominates` is implemented:

```ts
  dominates(ancestor: CFGBlock, descendant: CFGBlock): boolean {
    const enterA = this.enter.get(ancestor);
    const exitA = this.exit.get(ancestor);
    const enterB = this.enter.get(descendant);
    const exitB = this.exit.get(descendant);
    if (enterA === undefined || exitA === undefined) return false;
    if (enterB === undefined || exitB === undefined) return false;
    return enterA <= enterB && exitB <= exitA;
  }
```
— src/optimizing/analyses/dominance.ts:27-35

Two Euler numbers per block, computed once at construction ([Ch 42 § euler-numbering-makes-dominates-two-comparisons]), and a
block with no numbers answers **false** — not "throw", not "recompute". Ask whether anything
dominates a freshly split block and the answer is a confident, wrong no.

GVN's response is a one-entry-per-split map:

```ts
  private splitCriticalEdge(pred: GvnBlock, succ: GvnBlock): GvnBlock {
    const middle = splitEdge(this.graph, pred, succ, this.stamp);
    this.origin.set(middle, this.originOf(pred));
    return middle;
  }

  private originOf(block: GvnBlock): GvnBlock {
    return this.origin.get(block) ?? block;
  }
```
— src/optimizing/passes/gvn.ts:337-345

A split block *inherits its predecessor's identity* for dominance questions. `originOf(pred)`
rather than `pred` on the right-hand side makes it transitive, so splitting an edge out of an
already-split block still resolves to a block the tree knows. Both places that ask a dominance
question about a block — `LeaderTable.reaching` and the back-edge test in `anticipate` — route
their argument through it.

This is the price of `requires: [dominanceId]` plus mutation. GVN edits the CFG underneath an
analysis it declared it needs, and patches the hole by hand rather than rebuilding the tree.
It is also why the pass declares `{kind:"none"}`: by the time it returns, the cached dominator
tree and everything derived from it really are wrong, and the honest declaration is to throw
the whole cache away ([Ch 41 § preserves]).

> **Unenforced.** `originOf` (`src/optimizing/passes/gvn.ts:343-345`) silently returns the
> block itself for any block not in the map, so a future edit that creates a block without
> recording an origin gets *wrong dominance answers* rather than an error — `dominates` on an
> unnumbered block is `false`, which reads as "not dominated" and could admit a forwarding
> that is not legal. Nothing checks that every block created during the run is in the map.
> Cost to enforce: record the graph's block count on entry and assert that every block beyond
> it has an origin, or route creation through one helper.
>
> The map also only fixes the *asking* side. `LeaderTable.reaching` passes
> `this.originOf(block)` as the descendant but uses `node.block` raw as the ancestor
> (`gvn.ts:193`), so a leader `materialize` defined *inside* a split block is never found by a
> later query — `dominates(splitBlock, …)` is unconditionally false. That direction fails
> conservatively, costing a missed reuse rather than a wrong one, which is presumably why it
> has never been noticed.

## `materialize` and the join

With every predecessor classified, the transform is mechanical:

```ts
  private materialize(node: GvnNode, block: GvnBlock, insertion: Insertion): GvnNode {
    const pred = insertion.pred;
    const target = isCriticalEdge(pred, block) ? this.splitCriticalEdge(pred, block) : pred;
    const copy = this.stamp(new ir.CFGInstruction(node.type, { ...node.props }));
    for (const operand of insertion.operands) copy.addInput(operand);
    copy.block = target;
    const terminator = target.getTerminator();
    const at = terminator === null ? target.nodes.length : target.nodes.indexOf(terminator);
    target.nodes.splice(at, 0, copy);
    this.values.adopt(copy, insertion.value);
    this.leaders.define(insertion.value, copy);
    this.inserted++;
    return copy;
  }
```
— src/optimizing/passes/gvn.ts:322-335

The copy is the same opcode with a **shallow copy of the props** — `{ ...node.props }`, which
is right because the props were part of the congruence key, so the copy must carry them to be
the same value — and the *translated* operands, not the original ones. It is spliced in before
the target block's terminator, or appended if the block has none. Then two bookkeeping calls
that are easy to skip and would quietly break the rest of the run: `adopt` tells the numbering
that this new node already has a value number rather than letting `numberOf` derive a fresh
one, and `define` makes it findable by the next predecessor's `project` and by any later
block.

Then the merge:

```ts
    const merged = projected.map((projection) =>
      projection.kind === AVAILABLE
        ? projection.leader
        : this.materialize(node, block, projection),
    );
    const phi = this.stamp(addPhi(block, merged));
    this.values.adopt(phi, value);
    this.leaders.define(value, phi);
    this.forward(node, phi, block);
    this.removed++;
    return true;
```
— src/optimizing/passes/gvn.ts:285-295

One value per predecessor, in predecessor order — either the leader that was already there or
the copy just made — handed to `addPhi`, which pushes onto `block.phis` and splices into
`block.nodes` at the phi block's front (`cfg-edit.ts:91-101`). The phi is adopted under the
*original* value number, defined as a leader, and the original node is forwarded onto it by
the same `forward` full redundancy uses — so the frame-state relation is maintained here too.

Two shapes, two tests. When one arm has the expression and the other does not, one copy is
inserted and the phi merges the two
`[t: tests/optimizing/passes/gvn.test.ts > "inserts on the edge that lacks the expression and merges with a phi"]` —
and that test also asserts `phis[0].inputs` is `[early, addsIn(other)[0]]`, in predecessor
order. When *every* predecessor already has the value, nothing is materialized at all and the
phi alone does the work
`[t: tests/optimizing/passes/gvn.test.ts > "merges with a phi and inserts nothing when every predecessor has the value"]`.

Both of those transforms create exactly the conditions the pass looks for, and the pass never
looks again.

> **Unfinished.** GVN-PRE runs once, at ordinal 16, and nothing re-runs it.
> `materialize` creates new leaders, so an expression that had no reaching definition on the
> first sweep may have one on a second; `anticipate` creates new phis, which are new merge
> points; and the reverse-postorder walk has already passed the blocks where either could be
> used. Compare `string-split-lowering`, which wraps its lowerings in `untilStable`
> (`src/optimizing/target/legalization.ts:67-83`) — an unbounded `for (;;)` that re-runs until
> a round moves nothing — and is pinned as reaching a fixpoint by
> `tests/optimizing/pipeline-order.test.ts` > `"runs the split lowering to a fixpoint rather than once"`,
> which runs the pass twice and asserts the node count does not move the second time. Cost to
> finish: the same wrapper plus an iteration bound, and a measurement that does not exist in
> this tree — there is no benchmark harness here, so *would a second sweep pay for itself* is
> currently unanswerable rather than answered no.

## Stamping, again

GVN creates three kinds of node — a phi, a materialized copy, and the `Jump` inside a split
block — and every one of them goes through `this.stamp`, a single `nodeIdStamper(graph)`
created in the constructor (`gvn.ts:225`). `splitEdge` takes the stamp as a parameter for
exactly this reason: the block it builds is GVN's, so its jump must be numbered on GVN's
terms.

[Ch 43 § node-id-stamping] is where this discipline comes from and
[Ch 39 § one-counter-over-one-id-space] is where its general rule lives; the point here is
that GVN gets right what SCCP gets wrong. Everything GVN puts in the graph is immediately
told to the two structures the rest of the run will query it through — `values.adopt` and
`leaders.define` — so no node it created is ever invisible to a later step of the same run.
That is the same obligation as stamping, one level up: a new node needs an identity *and* a
place in whatever indices the pass is carrying.

The invariant is pinned directly
`[t: tests/optimizing/passes/gvn.test.ts > "gives every node it creates an unused identifier"]`,
and more strongly than that: `runGvn`, the helper every one of the file's twenty-two tests
goes through, calls `validateGraphInvariants(graph)` after the pass
(`tests/optimizing/passes/gvn.test.ts:31-35`). So *every* GVN test also asserts that the pass
left a well-formed graph — node ids unique, phi arity matching predecessor count, use lists
consistent, definitions dominating their uses ([Ch 38 § what-actually-checks-any-of-this]).
That is worth copying: a pass that edits the CFG should have its test helper validate, not its
tests.

## What leaves

The same `CFGFunction`, with congruent computations collapsed onto one leader each, and — on
graph shapes the running example does not contain — partially redundant ones replaced by a
phi at the merge with a materialized copy on each predecessor that lacked the value, and
possibly one or more new blocks holding nothing but a `Jump`, created by splitting critical
edges.

Three properties the next pass may assume, and one it may not.

It **may** assume that every node GVN created carries an id no other node holds, and that the
graph passes `validateGraphInvariants` — the pass's own test helper checks this on all
twenty-two of its cases, and `tera compile --verify` checks it on every function of a real
compile. It **may** assume frame states are answerable: `forward` goes through
`replaceValueUses`, which rewrites the frame-state relation as well as the value graph, so no
frame-state slot names a node GVN dropped. It **may** assume that nothing moved into a loop.

It **may not** assume the analysis cache. GVN declares `{kind:"none"}`, and on `stats.tera`
the two runs that change anything report `invalidated dominance loops points-to mod-ref` and
`invalidated points-to mod-ref dominance` — the same set, in the order those analyses happened
to be cached. Even the run that removes exactly one node throws away the dominator tree,
because a run that removed one node might equally have split three edges, and the declaration
is per pass, not per run.

Next is `bounds-check-elimination` at ordinal 17, and then the rest of the loop machinery:
[Ch 46] takes the graph GVN leaves and asks what can be moved *out* of a loop rather than what
can be shared inside one — starting from the observation that the frame states GVN refuses to
move are the same ones LICM refuses to hoist, for the same reason.

## Verify it yourself

```bash
# the whole pass: 22 tests, each of which also validates the graph afterwards
npx vitest run --project unit tests/optimizing/passes/gvn.test.ts

# twenty-one GVN runs over stats.tera's twenty-one functions...
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c \
  | grep '^\*\*\* IR after' | grep -c ' gvn '

# ...and the two that change anything both remove exactly one node
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c \
  | grep '^\*\*\* IR after' | grep ' gvn ' | grep '\[changed'

# the forwarding itself, before and after
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c \
  | grep -E '^\*\*\* IR after #1[56] (intrinsic-cse|gvn) |GenericAdd v16, v4|= GenericGetIndex v44,' \
  | grep -A 2 'nodes 120' | head -7

# the pass in this tree that DOES iterate to a fixpoint, which the last honesty item
# above is drawn against (11 tests; none of them is about gvn)
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts

# and the graph GVN leaves still passes every invariant, on every function
node dist/cli.js compile docs/example/stats.tera --emit source --verify -o /tmp/statsv
```

The second command prints `21`; the third prints exactly two lines,
`[changed, nodes 120 -> 119 (-1)]` and `[changed, nodes 206 -> 205 (-1)]`. The fourth prints
the before-and-after quoted in § full-redundancy-the-leader-table-in-reverse-postorder:
`v45 = GenericAdd v16, v4` and `v46 = GenericGetIndex v44, v45 !fs` after `#15 intrinsic-cse`,
then after `#16 gvn` only `v46 = GenericGetIndex v44, v39 !fs` and the header's
`v39 = GenericAdd v16, v4`. There is no command here that shows an insertion, a phi or a split
block, because on `stats.tera` there are none — that half of the pass is reachable only from
the unit-test graphs.

## Tests that pin this

- `tests/optimizing/passes/gvn.test.ts` > `"eliminates redundant computation with same inputs"`
  and > `"propagates through dominated blocks"` — the leader table, within one block and
  across the dominator tree.
- `tests/optimizing/passes/gvn.test.ts` > `"does not eliminate different operations on same inputs"`
  and > `"handles commutative ops: add(a,b) == add(b,a)"` — the opcode and the sorted operand
  token, the two halves of the key that are not props.
- `tests/optimizing/passes/gvn.test.ts` > `"does not eliminate nodes with side effects"` —
  the `isEffectFree` gate, which is also why a load is a different pass's problem.
- `tests/optimizing/passes/gvn.test.ts` > `"numbers equal constants written by different nodes as one value"`
  — `IR_CONSTANT` is keyed but not a candidate: the constants stay, the adds merge.
- `tests/optimizing/passes/gvn.test.ts` > `"keeps expressions apart when a distinguishing property differs"`
  — `noOverflow` in the props token; the test that stands between GVN and a miscompile.
- `tests/optimizing/passes/gvn.test.ts` > `"treats equal metadata records on two nodes as the same value"`,
  > `"keeps nodes apart when their metadata records differ"` and
  > `"terminates on a metadata record that refers to itself"` — `shapeToken`'s structural
  encoding and its cycle guard, which degrades to an identity token rather than throwing.
- `tests/optimizing/passes/gvn.test.ts` > `"compares constants that hold objects by identity"`
  and > `"separates positive and negative zero constants"` — `literalToken` never encoding a
  constant's payload structurally, and `scalarToken`'s explicit `-0` case.
- `tests/optimizing/passes/gvn.test.ts` > `"inserts on the edge that lacks the expression and merges with a phi"`
  and > `"merges with a phi and inserts nothing when every predecessor has the value"` — the
  two shapes `materialize` and the join produce, including phi input order.
- `tests/optimizing/passes/gvn.test.ts` > `"splits a critical edge so the insertion stays off the other successor"`
  — one new block, and `addsIn(entry)` empty: the assertion that names the whole reason edge
  splitting exists.
- `tests/optimizing/passes/gvn.test.ts` > `"does not hoist into a loop across a back edge"` —
  and it asserts the latch still holds exactly one node, which is what makes it a test of
  *not pessimizing* rather than a test of not changing anything.
- `tests/optimizing/passes/gvn.test.ts` > `"leaves an expression alone when no predecessor already has it"`,
  > `"refuses to move a memory read onto a predecessor"` and
  > `"refuses to move an expression whose operand is not available in a predecessor"` — three
  of the five refusals in `anticipate`, each with its own graph.
- `tests/optimizing/passes/gvn.test.ts` > `"translates a phi operand to its incoming value in each predecessor"`
  — `project`'s phi translation, asserted on the inserted copy's operand list.
- `tests/optimizing/passes/gvn.test.ts` > `"gives every node it creates an unused identifier"`
  — the stamping invariant, on top of the `validateGraphInvariants` call that `runGvn` makes
  on every case in the file.
- `tests/optimizing/pipeline-order.test.ts` > `"runs the split lowering to a fixpoint rather than once"`
  — the comparison the `> **Unfinished.**` above is drawn against: a pass in this tree that
  *does* iterate, and how it is proved.
- `tests/optimizing/pipeline.test.ts` > `"attributes each change and invalidation to the pass that caused it"`
  — asserts `gvn [unchanged, nodes 4 -> 4 (+0), invalidated nothing]` on the miniature graph,
  which is the other half of the `{kind:"none"}` declaration: an unchanged run invalidates
  nothing at all.
- That the two changed GVN runs on `stats.tera` are both full redundancy and never partial —
  no insertion, no phi, no split block anywhere in the compile — is observed from
  `--print-after-all`, not from a test: **[unpinned]**.
- The `origin` map's transitivity, for an edge split out of an already-split block, is
  **[unpinned]**: no test builds two splits in one run.
