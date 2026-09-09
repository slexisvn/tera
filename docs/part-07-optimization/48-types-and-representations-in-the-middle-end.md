# 48. Types and representations in the middle end   ⟨J · N⟩ narrowing · ⟨J⟩ representation selection

Two of the four arithmetic nodes in `Series.mean` become integer operations at pass ordinal
8, and one of those two becomes a floating-point operation again at ordinal 19. Nothing
about the program changed in between. What changed is that the compiler asked a second
question — not *what values can this hold*, but *can anybody tell the difference if I hold
it narrowly* — and got "yes" for one node and "no" for the other.

That second question runs through this whole chapter, in two different currencies. The first
half is about **types**: `type-narrowing` rewrites `GenericAdd` into `Int32Add` or
`Float64Add` when something has proved the operands numeric, and then decides, by a backward
walk over the uses, whether the integer version is allowed to wrap. The second half is about
**representations**: how a value is physically held in a machine — a raw 32-bit integer, a
raw double, a tagged number, an index into a side table. Those are two axes, not one, and
the rule that keeps them honest is the same in both halves: *a value may be narrowed by a
proof about the value, never by the absence of a demand.* A narrowing done because nobody
asked for the wide thing is a narrowing done on no evidence. There is a measured wrong
answer in this chapter to show what that costs.

`stats.tera` reaches the first half in full — the narrowing figures below are its own
`Series.mean`, dumped from a real compile. It cannot reach the second half at all.
Representation selection is spliced into the pipeline only for a target that has the
`tagged-values` capability, which today means WebAssembly and nothing else
([Ch 51 § capabilities-decide-which-passes-exist]); `stats.tera` compiled ahead of time never
runs the pass, and `stats.tera` run normally never tiers up to the JIT. So the representation sections are
grounded on a nine-line probe that appears only as a command under "Verify it yourself",
never as a listing beside the running example ([Conventions § 2](../CONVENTIONS.md)).

**What arrived.** The smallest graph the middle end will produce: no unreachable block, no
trivial phi, no phi nothing reads, no node whose value nothing observes, `Int32Mul` by a
small constant rewritten into a shift and at most one add, and every
`Int32Add`/`Sub`/`Mul` either stamped `noOverflow` or already widened to `Float64*`
([Ch 47 § what-leaves](47-simplification-dead-code-and-the-identities-that.md)). What it
does *not* carry is any statement about how each surviving value is held in a machine. It
also arrives with a cached analysis it does not own: the `TypeInference` result, one lattice
element per node, computed by the worklist of [Ch 42 § type-inference].

## Flow sensitivity and the price of it

The type inference of [Ch 42 § type-inference] answers one question per node, for the whole
function: *what can this value hold, anywhere?* That is exactly the right shape for an
analysis you want to cache, because it does not depend on where you ask. It is also too
coarse to specialize arithmetic with, because the interesting facts in an optimizing
compiler are all local. Inside the true arm of `if typeof x == "number"`, `x` is a number.
Three lines later, outside the `if`, it is whatever it was before.

> **New idea. Flow sensitivity.** An analysis is *flow-insensitive* when it computes one
> answer per value and that answer is valid everywhere the value is. It is *flow-sensitive*
> when the answer depends on the program point you ask about. Flow sensitivity is strictly
> more informative and strictly more expensive: the analysis now has to carry a separate
> answer for every point, and the number of points is the number of instructions rather
> than the number of values. Compilers buy some of it back cheaply by noticing that the
> facts they care about are *scoped by dominance*. A fact established by `CheckSmi v6` is
> true in every block that `CheckSmi` dominates — every block you can only reach by going
> through it — and false everywhere else. So instead of a map per program point, you keep
> one map, walk the dominator tree, and put facts in and take them back out as you go.
> Dominance is the primer in [Ch 42 § dominance]; what it buys here is that a scoped fact
> needs no storage of its own beyond the record of how to undo it.

`Narrower` (`src/optimizing/passes/type-narrowing.ts:122-291`) is that walk. It holds a
single `refinements: Map<number, LatticeType>` keyed by node id, and one method that decides
which answer wins:

```ts
  private typeAt(value: ir.CFGInstruction): LatticeType {
    return this.refinements.get(value.id) ?? this.types.typeOf(value);
  }
```
— `src/optimizing/passes/type-narrowing.ts:145-147`

A local refinement if there is one; otherwise the flow-insensitive answer from the cached
solver. Two levels, one lookup, and the whole of the pass's type knowledge behind it.

## The undo trail is the whole mechanism

The scoping is not enforced by a data structure. It is enforced by remembering what to put
back.

```ts
  private walk(block: ir.CFGBlock): void {
    const trail: Trail = [];
    for (const node of [...block.nodes]) {
      this.applyGuardFact(node, trail);
      if (this.foldDefinedComparison(node)) continue;
      this.specialize(node);
    }
    for (const child of this.dominance.childrenOf(block) as readonly ir.CFGBlock[]) {
      const edgeTrail: Trail = [];
      this.applyEdgeFacts(block, child, edgeTrail);
      this.walk(child);
      this.undo(edgeTrail);
    }
    this.undo(trail);
  }
```
— `src/optimizing/passes/type-narrowing.ts:276-290`

`Trail` is `Array<readonly [number, LatticeType | undefined]>` (`:102`) — a node id and the
refinement that was there *before*, which is `undefined` when there was none. `refine`
pushes the old value and writes the new one (`:149-152`); `undo` replays the trail
**backwards**, deleting where the previous value was `undefined` and restoring it otherwise
(`:154-160`). Replaying backwards is what makes nesting work without any nesting machinery:
if two guards in the same block both refine `v6`, the second push records what the first
wrote, and unwinding in reverse restores the first and then removes it.

There are two trails per block, and the order they are unwound in is the point. The `trail`
declared at the top collects facts the block's own guard nodes establish — those hold for
the block and for everything it dominates, so they must survive the recursion into children.
The `edgeTrail`, one per outgoing dominator edge, collects the fact that a branch condition
establishes *on that edge only* — true on the true edge, excluded on the false edge — so it
must be undone immediately after that child's subtree is finished and before the next
child's begins. Unwinding the block trail first would drop facts the children still need;
sharing one trail across children would leak the true edge's fact into the false edge's
subtree. The inner trail is undone in the loop, the outer trail after it.
`[t: tests/optimizing/passes/type-narrowing.test.ts > "propagates type facts to dominated blocks"]`
is the positive half of that pin.

## Two sources of facts: a guard node, and a branch edge

The pass learns from exactly two things, and they are different in kind.

A **node fact** comes from a guard, and merely reaching the guard is enough. `GUARD_FACTS`
is three entries long:

```ts
const GUARD_FACTS = new Map<string, (node: ir.CFGInstruction) => LatticeType>([
  [ir.IR_CHECK_SMI, () => smiType()],
  [ir.IR_CHECK_NUMBER, () => numberType()],
  [ir.IR_CHECK_MAP, (node) => objectType(node.props.expectedMapId ?? null)],
]);
```
— `src/optimizing/passes/type-narrowing.ts:64-68`

`applyGuardFact` (`:181-186`) takes the guard's first input and refines it to
`narrowType(currentType, fact)` — intersecting with what is already known rather than
replacing it. Three of the eight guard opcodes in the operation table appear here; the
consequences of the other five being absent belong to
[Ch 49 § the-taint-set](49-speculative-types-are-not-facts.md).

An **edge fact** comes from a branch, and it is true only on one of the two outgoing edges.
`applyEdgeFacts` (`:162-179`) is narrow by construction: it fires only when the block's
terminator is an `IR_BRANCH` whose condition is an `Int32Compare` with `==` or `===` between
an `IR_TYPEOF` node and a string constant (`typeofComparison`, `:108-120`). Given that
shape, it applies `narrowType(current, fact)` when the child is the true block and
`excludeType(current, fact)` when the child is the false block.

The asymmetry is real and worth stating, because a reader will assume the two edges are
mirror images. They are not. Narrowing `Any` by `Number` on the true edge gives you
`Number`. *Excluding* `Number` from `Any` on the false edge gives you `Any` again — the
lattice of [Ch 10 § a-lattice] has no "everything except numbers" element to move to, and
`excludeType` has nowhere to go. So the true arm of a `typeof` test specializes and the
false arm does not:
`[t: tests/optimizing/passes/type-narrowing.test.ts > "does not narrow false branch to the same type as true"]`.
The positive cases are pinned by
`[t: tests/optimizing/passes/type-narrowing.test.ts > "narrows true branch of typeof == 'number' to float64 arithmetic"]`
and
`[t: tests/optimizing/passes/type-narrowing.test.ts > "narrows true branch with === operator"]`.

## Specialization is a two-tier ladder, and it fails closed

With a type in hand, the rewrite is a table lookup with two rungs.

```ts
  private specialize(node: ir.CFGInstruction): void {
    const left = node.inputs[0];
    const right = node.inputs[1];
    if (left === undefined || right === undefined) return;
    const leftType = this.typeAt(left);
    const rightType = this.typeAt(right);

    const specialized =
      leftType.kind === TypeKind.Smi && rightType.kind === TypeKind.Smi
        ? GENERIC_TO_INT32.get(node.type)
        : isNumeric(leftType) && isNumeric(rightType)
          ? GENERIC_TO_FLOAT64.get(node.type)
          : undefined;
    if (specialized === undefined) return;

    node.type = specialized;
    if (INT32_TO_FLOAT64.has(specialized)) this.widened.push(node);
    else node.props.noOverflow = true;
    this.count++;
  }
```
— `src/optimizing/passes/type-narrowing.ts:188-207`

Both operands `Smi` gets you `GENERIC_TO_INT32` (`:22-28`, five entries: add, sub, mul, mod,
compare). Otherwise both operands merely *numeric* — `Smi`, `Double` or `Number`, per
`NUMERIC_KINDS` at `:72-76` — gets you `GENERIC_TO_FLOAT64` (`:56-62`, five entries: add,
sub, mul, div, compare). Otherwise nothing happens and the generic node survives, to be
lowered by the target instead ([Ch 51 § speculation-lowering-three-strategies]).

Three properties of that ladder are worth naming. It **fails closed**: one unproven operand
is enough to abandon the rewrite entirely, pinned by
`[t: tests/optimizing/passes/type-narrowing.test.ts > "does NOT specialize when only one input has type facts"]`
beside
`[t: tests/optimizing/passes/type-narrowing.test.ts > "does NOT specialize when inputs have no type checks"]`.
A **mix lands on the wider rung**: a `Smi` and a `Number` are both numeric but not both
`Smi`, so the pair becomes float64, not int32 —
`[t: tests/optimizing/passes/type-narrowing.test.ts > "specializes to float64 when one input is smi and other is number (both numeric)"]`.
And the four base cases are pinned one apiece:
`[t: tests/optimizing/passes/type-narrowing.test.ts > "specializes GenericAdd to Int32Add when both inputs pass CheckSmi"]`,
`[t: … > "specializes GenericSub to Int32Sub when both inputs are smi-narrowed"]`,
`[t: … > "specializes GenericCompare to Int32Compare when both inputs are smi"]`,
`[t: … > "specializes GenericAdd to Float64Add when both inputs pass CheckNumber (not smi)"]`.

The last three lines are the hinge into the next section. A node that became `Int32Add`,
`Int32Sub` or `Int32Mul` — the three keys of `INT32_TO_FLOAT64` (`:30-34`) — is *not*
declared safe; it is pushed onto `this.widened`, a list of candidates to be adjudicated
later. Everything else is stamped `noOverflow = true` immediately. That "everything else"
includes `Float64Add` and `Float64Div`, which cannot overflow in the sense the flag means;
the stamp is harmless there, because the only reader that matters gates on the opcode being
one that can deoptimize on overflow (`operations.ts:1171`), but it does appear in dumps and
it will make a reader stop.

Here is what the pass does to the running example. `Series.mean` is `total += this.values[i]`
inside `while i < this.values.length`, and it reaches ordinal 8 with four generic arithmetic
nodes. Neither `CheckSmi` nor `CheckMap` appears in this graph, so every fact here comes
from the flow-insensitive fallback in `typeAt` — the type solver already knows `total` is a
double, `i` is a small integer, and `.length` is a number.

```
*** IR after #7 redundant-checks [unchanged, nodes 26 -> 26 (+0), invalidated nothing] ***
    v24 = GenericDiv v4, v23
    v12 = GenericAdd v4, v11
    v14 = GenericAdd v5, v13
    v8 = GenericCompare v5, v7 [op="<"]

*** IR after #8 type-narrowing [changed, nodes 26 -> 26 (+0), invalidated type-inference] ***
    v24 = Float64Div v4, v23 [noOverflow=true]
    v12 = Float64Add v4, v11 [noOverflow=true]
    v14 = Int32Add v5, v13
    v8 = Int32Compare v5, v7 [op="<", noOverflow=true]
```

Four rewrites, from the two `Series.mean` dumps that `--print-after-all` emits either side of
pass 8; the command that extracts exactly these lines is in "Verify it yourself". `v24` is
`total / this.values.length`, `v12` is `total +=`, `v8` is the loop condition, and `v14` is
`i += 1`. `v14` is the only one of the four that came out unstamped, because it is the only
one that landed on the int32 rung. What happens to it next is the rest of this half of the
chapter.

## Settle int32

An `Int32Add` in a language whose numbers are IEEE doubles is a lie unless nobody can catch
it. `i + 1` where `i` is 2147483647 is 2147483648 in tera, and an int32 addition answers
-2147483648. Keeping the int32 version is only legal when every reader of the sum would have
thrown away the difference anyway.

`settleInt32Arithmetic` decides that with a backward fixpoint that starts optimistic:

```ts
  private settleInt32Arithmetic(): void {
    if (this.widened.length === 0) return;
    const wrapping = new Set([...this.widened, ...this.carriers()]);
    const pending = [...wrapping];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (!wrapping.has(node)) continue;
      if (node.uses.every((use) => this.truncates(use, wrapping))) continue;
      wrapping.delete(node);
      for (const input of node.inputs) if (wrapping.has(input)) pending.push(input);
    }
```
— `src/optimizing/passes/type-narrowing.ts:218-228`

`wrapping` starts as every candidate the specializer produced plus every phi and every
`IR_SELECT` in the graph (`carriers()`, `:209-216` — `CARRIES_ITS_INPUTS` at `:46`). The
carriers are in the set because a value that reaches a truncating reader *through* a phi is
still truncated; leaving them out would break every loop-carried counter. Then the worklist
removes anything that has a reader which does not truncate, and pushes that node's inputs
back on, because losing a carrier can un-truncate the things flowing into it. It converges
because nodes are only ever removed.

The specification of "truncates" is six lines:

```ts
  private truncates(use: ir.CFGInstruction, wrapping: ReadonlySet<ir.CFGInstruction>): boolean {
    if (TRUNCATES_ITS_INPUTS.has(use.type)) return true;
    if (wrapping.has(use)) return true;
    if (countsInInt32(use)) return true;
    return use.type === ir.IR_RETURN && this.answersDeclaredInt;
  }
```
— `src/optimizing/passes/type-narrowing.ts:240-245`

Four demands. A bitwise operation (`TRUNCATES_ITS_INPUTS`, `:36-44`: and, or, xor, not,
shl, shr, ushr) truncates by definition. A node still in `wrapping` truncates, which is the
transitive case. `countsInInt32` (`:50-54`) recognises a `GenericCall` to `range` — the
loop-bound builtin, `COUNTS_IN_INT32` at `:48` — because the iterator lowering that consumes
a range requires int32 bounds and will refuse the sequence if it gets a double. And a
`Return` truncates when the function declared `-> int`.

> **Unenforced.** `truncates` *is* the demand table, and nothing derives it or checks it
> against the passes that read int32 operands. The `range` entry is there because it was
> missing: `for i of range(1, n + 1)` widened `n + 1` to a double, the iterator lowering
> then refused the sequence, the `IteratorInit` node survived, and the AOT backend declined
> the whole function with `unsupported opcode IteratorInit` — a message naming a symptom
> five passes downstream of the cause. Any future pass that starts requiring an int32
> operand and does not add itself to `TRUNCATES_ITS_INPUTS` or `COUNTS_IN_INT32` gets the
> same failure. Cost of closing it: a single table that both the demand set and the
> requiring passes read, which does not exist.

Two outcomes, in the tail of the same function (`:230-237`). A node still in `wrapping` gets
`noOverflow = true` and stays int32. A node that was removed has the flag **deleted** and is
given a frame state grafted from whichever input already had one (`frameStateFromInputs`,
`:293-298`) — so a tier that can deoptimize is able to bail out on overflow rather than
answer wrongly. That graft is why the two sides of the book need the third outcome, which
arrives eleven passes later:

```ts
export function widenUnprovenInt32Arithmetic(graph: ir.CFGFunction): number {
  let widened = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      const float64 = INT32_TO_FLOAT64.get(node.type);
      if (float64 === undefined || node.props.noOverflow === true) continue;
      if (node.frameState !== null) continue;
      node.type = float64;
      widened++;
    }
  }
```
— `src/optimizing/passes/type-narrowing.ts:300-310`

Registered as `int32-overflow-widening` at `src/optimizing/pipeline.ts:218-220`, ordinal 19.
Anything still unproven **and without a frame state** — nothing can catch it wrapping, and
nothing can undo the guess if it does — becomes `Float64*`. The four-way split is pinned
one test per outcome:
`[t: tests/optimizing/passes/type-narrowing.test.ts > "wraps in int32 when every reader of the sum truncates it"]`,
`[t: … > "settles a sum a range counts with, whatever the function answers"]`,
`[t: … > "leaves the sum unproven when its reader keeps the whole number"]`,
`[t: … > "answers a double for an unproven sum nothing can deoptimize"]`,
`[t: … > "keeps a sum a bounds proof settled"]`.

`Series.mean`'s `v14` takes the third road and then the fourth. Its only reader is the loop
phi `v5`; `v5`'s readers include `GenericGetIndex v10, v5`, which keeps the whole number, so
`v5` leaves `wrapping`, so `v14` leaves it too. `v14` has no input carrying a frame state, so
the graft produces `null`. At ordinal 19 it is therefore widened, and the pipeline records
the change:

```
*** IR after #19 int32-overflow-widening [changed, nodes 26 -> 26 (+0), invalidated dominance loops points-to mod-ref] ***
    v24 = Float64Div v4, v23 [noOverflow=true]
    v12 = Float64Add v4, v11 [noOverflow=true]
    v14 = Float64Add v5, v13
    v8 = Int32Compare v5, v7 [op="<", noOverflow=true]
```

`v8` survives as an `Int32Compare` because it was never a widening candidate — comparisons are
not keys of `INT32_TO_FLOAT64`, so `specialize` stamped it `noOverflow` on the spot. The loop
counter in the book's running example is a double. That is not a defect: nothing in
`Series.mean` truncates `i`, so nothing can observe the difference, and the compiler declined
to claim otherwise.

## Declared int wraps everywhere

The fourth clause of `truncates` — `use.type === ir.IR_RETURN && this.answersDeclaredInt` —
is the middle end's half of a rule the runtime enforces on its own. `answersDeclaredInt` is
computed once in the constructor as `graph.declaredSignature?.returns === DECLARED_INT`
(`:135`), where `DECLARED_INT` is the three-character string `"int"`
(`src/optimizing/types/declared.ts:34`).

In tera, `int` means int32, and the coercion is a **boundary** coercion, not typed
arithmetic. A function declared `-> int` truncates its answer on the way out; the arithmetic
inside it is not otherwise constrained. The truncation is `asDeclaredInt32`, six lines in
`src/runtime/declared-int.ts:24-29`, and it applies `| 0` only to values that are already
integral — a `-> int` function answering `4.5` or `NaN` is left alone.

The important word is **callee**. The wrap belongs to the function that declared the type,
and it is applied at one site per tier: the interpreter's `ROP_RETURN`
(`src/bytecode/register/interpreter/index.ts:2029-2030`), the baseline compiler's
`returnExpression` (`src/optimizing/baseline/compiler.ts:41`), and the wasm→JS boundary in
`WasmCodegen.createWrapper` (`src/optimizing/backends/wasm/codegen.ts:4828-4839`). An earlier
version put the wrap on the *caller*, inside the interpreter's `callFunction`. That was a
bug, and it is the cleanest illustration in this part of why "which side of a boundary owns
a rule" is a real question: baseline and JIT-compiled code call each other directly and never
enter `callFunction`, so the wrap vanished the moment the caller was compiled, and one
program answered three different numbers on three tiers. The caller-side wrap was deleted.

Two tests pin the surviving behaviour from the outside:
`[t: tests/e2e/optimizing/int32-semantics.test.ts > "wraps a declared int return in every interpreted tier too"]`
and
`[t: tests/e2e/optimizing/int32-semantics.test.ts > "leaves an undeclared and a float return unwrapped in every tier"]`.
[Ch 50 § needsdeclaredintwrap-the-callees-promise-becomes-the-callers-problem](50-inlining-and-tail-calls.md)
is where the same rule turns into a problem, because inlining deletes the boundary the wrap
lives on.

> **Unfinished.** The boundary coercion is not typed arithmetic, so an *intermediate*
> overflow flowing into a float context still disagrees across tiers:
> `fn f(n: int) -> float: return n * 2 + 0.5` wraps `n * 2` natively and does not in the
> interpreter. Cost of finishing: typed int32 arithmetic through the whole expression rather
> than a coercion at the return, which is a different design, not a patch.

## Representation

Everything so far has been about *types*: which values a node can hold. Nothing so far says
anything about how the machine holds them, and the two are independent.

> **New idea. Representation, as an axis separate from type.** A value whose type is `Smi`
> can be held as a raw 32-bit integer in a register, as a raw IEEE double, as a *tagged*
> number that carries its own kind bits, or as a *handle* — an index into a side table where
> the real object lives ([Ch 22 § four-bits-inside-a-double] for the tagged word,
> [GLOSSARY § handle](../GLOSSARY.md) for the three different things the word means in this
> engine). The type does not decide which; the machine, the calling convention and the
> consumers do. Moving a value from a narrow representation to a wider one is **boxing**;
> the reverse is **unboxing**. Boxing is not free — in the wasm backend it is a call out to
> a runtime stub — and neither is being wrong about it, because reading a handle index as
> if it were a number silently produces a plausible-looking integer.

The vocabulary is forty lines, `src/optimizing/types/representation.ts`. Six constants —
`REP_INT32`, `REP_FLOAT64`, `REP_TAGGED_NUMBER`, `REP_HANDLE`, `REP_TAGGED`, `REP_BOOL` —
plus `representationFrom`, a total function that answers `REP_HANDLE` for anything it does
not recognise, which is the file's one design decision: an unknown representation is the
widest one, never a narrow guess.

There is an informal order underneath the numeric four, `int32 < float64 < tagged-number <
handle`, and `joinDemand` (`repr-selection.ts:77-85`) is where it is written down: handle
beats everything, tagged-number beats the two raw kinds, and two disagreeing raw kinds join
to float64. `REP_BOOL` is deliberately not on that ladder.

Three of the six can cross a call boundary:

```ts
export type AbiRepresentation =
  | typeof REP_HANDLE
  | typeof REP_BOOL
  | typeof REP_TAGGED_NUMBER;

export function abiRepresentationOf(rep: Representation): AbiRepresentation {
  if (rep === REP_HANDLE) return REP_HANDLE;
  if (rep === REP_BOOL) return REP_BOOL;
  return REP_TAGGED_NUMBER;
}
```
— `src/optimizing/types/representation.ts:31-40`

> **New idea. An ABI.** An *application binary interface* is the set of conventions two
> separately-compiled pieces of code agree on so that one can call the other: which register
> or stack slot holds which argument, who cleans up, and — the part that matters here — what
> a returned value *means* bit for bit. `abiRepresentationOf` is the narrowest possible
> version of that idea. It says that when a value leaves a function, the caller is only
> allowed to be told one of three things about it, and `REP_INT32` and `REP_FLOAT64` both
> collapse into `REP_TAGGED_NUMBER` on the way out. The full calling convention, with
> registers and stack slots in it, is [Ch 68 § what-a-convention-is].

> **Unfinished.** `REP_TAGGED` is the sixth name and `representationSelection` never assigns
> it — `grep -n "REP_TAGGED\b" src/optimizing/passes/repr-selection.ts` returns nothing, and
> `abiRepresentationOf` folds it into `REP_TAGGED_NUMBER` by falling through the two `if`s.
> It is not dead, though: the wasm code generator assigns it in its *own* map for a
> different purpose, marking an in-place object parameter and its map checks
> (`src/optimizing/backends/wasm/codegen.ts:1096` and `:1099`), and
> `src/optimizing/target/model.ts:29` maps it to the machine representation `"tagged"`.
> So one enum serves two vocabularies: five names the middle end assigns, and a sixth that
> only a backend introduces. Cost of separating them: a distinct `WasmValueRep` name for the
> backend's case, and a check that no parsed IR fixture stamps the literal string
> `"tagged"`.

## Repr selection

`representationSelection` (`src/optimizing/passes/repr-selection.ts:63-631`) is **not a
middle-end pass**. It is registered in the target legalization pipeline, as a pair with its
own verifier:

```ts
const representationSelectionPass: TransformPass<CFGFunction> = {
  name: "representation-selection",
  preserves: preservesControlFlow,
  run: (graph) => ({ changed: representationSelection(graph) > 0 }),
};
```
— `src/optimizing/target/legalization.ts:93-97`

and spliced into the pipeline conditionally:

```ts
    ...(tagged ? [representationSelectionPass, representationCheckPass] : []),
```
— `src/optimizing/target/legalization.ts:400`

where `tagged` is `target.capabilities.has("tagged-values")` (`:112`). That is the whole of
the ⟨J⟩ badge on the rest of this chapter. Compile `stats.tera` ahead of time with
`--print-after-all` and neither pass name appears in the 72 names printed, and the string
`_rep` appears nowhere in the dump.

The pass runs in five phases, in this order: demand computed backwards over uses; assignment
computed forwards over producers; a phi reflow; the return join; and conversion insertion,
followed by one loop that stamps every decision onto `props._rep`. The next five sections
take them in that order.

## Phase one: demand, computed backwards

Demand is the answer to "what is the *weakest* representation that every consumer of this
value can live with?" It is computed by a worklist over `node.uses`, seeded with every
parameter and every node in the graph (`:105-108`), and joined with `joinDemand`:

```ts
  while (demandWorklist.length > 0) {
    const node = demandWorklist.pop()!;
    demandQueued.delete(node.id);

    let demand: Demand = null;
    for (const use of node.uses) {
      demand = joinDemand(
        demand,
        use.type === ir.IR_PHI
          ? (nodeDemand.get(use.id) ?? null)
          : demandOfUse(use),
      );
      if (demand === REP_HANDLE) break;
    }
```
— `src/optimizing/passes/repr-selection.ts:110-123`

Two details make that a fixpoint rather than a single backward pass. A phi's contribution is
read from `nodeDemand` — the phi's *own* demand, which may not be known yet — instead of from
`demandOfUse`; and only a phi re-enqueues its inputs when its answer changes (`:127-129`).
Everything else is a single visit. The `break` at `REP_HANDLE` is the top of the lattice:
once one consumer wants a handle, no other consumer can lower the answer.

And here is the table that decides what a consumer wants. It is the chapter's central
listing, and it is five lines and a default:

```ts
  const demandOfUse = (use: ReprNode): Demand => {
    if (use.type === ir.IR_CHECK_SMI) return REP_INT32;
    if (use.type === ir.IR_CHECK_NUMBER) return REP_FLOAT64;
    if (use.type === ir.IR_GENERIC_MOD || use.type === ir.IR_GENERIC_COMPARE)
      return REP_TAGGED_NUMBER;
    return REP_HANDLE;
  };
```
— `src/optimizing/passes/repr-selection.ts:87-93`

Note which opcodes are named. `CheckSmi` and `CheckNumber` are *guards*: a consumer that
demands a narrow representation is a consumer that has proved the value numeric. Everything
else falls to `REP_HANDLE`.

## The soundness rule

`IR_RETURN` is not in that table. It has no case, it falls to the default, and the absence is
load-bearing.

Because a return demands a handle, a value that flows into a return is demanded as a handle,
and an unguarded `LoadField` feeding a return therefore stays a handle. The forward
assignment phase asks `acceptsUnboxedNumber(node)` — literally "is this node's demand
something other than `REP_HANDLE`?" (`:132-133`) — before it will give a `LoadField` a
numeric representation, so the demand answer decides.

Two functions with the same shape and different answers make the rule visible. `return g.x`,
where `g` is a global object holding a string, is a `LoadField` with nothing proving it
numeric; its demand comes back `REP_HANDLE` and it is held as a handle. `return g.x + a`
gets `REP_TAGGED_NUMBER` — legitimately, because a `CheckSmi` sits on the path and something
*proved* the value numeric. The two look like the same situation and are not.

This is exactly the shape of a "pessimization" a later reader will want to remove. Relaxing
`demandOfUse` so that `IR_RETURN` demands less than `REP_HANDLE` collapses the two cases: the
first `LoadField` becomes `tagged-number`, and the JavaScript wrapper on the other side of
the wasm boundary reads the raw scalar as a number. **Measured 2026-08-18**: the program
above printed `"56"` — the string's index in the handle table — instead of `"hello"`.

**The general rule: demand is not proof.** A representation narrowed because nothing asked
for the wide one is a representation narrowed on no evidence at all. The only sound narrowing
is type-driven: something proved the value numeric. That sentence is the same sentence
[Ch 49 § speculative-taint](49-speculative-types-are-not-facts.md) states about a different
currency, and it is the reason this chapter and the next are adjacent.

Today the program prints `hello` on all four tiers, pinned by
`[t: tests/e2e/optimizing/representation.test.ts > "keeps an unguarded field return a handle"]`
with three siblings that come at the same failure from the other direction:
`[t: … > "does not read a numeric result as a constant-pool handle"]`,
`[t: … > "does not read a numeric result as an object handle"]`,
`[t: … > "does not read a numeric result as an array handle"]`.

> **Unenforced.** Nothing in the tree states or checks the rule this section is about.
> `demandOfUse` encodes it by *omission* — no assertion, no `satisfies` constraint, no
> comment, and in a codebase with 26 comment lines there will not be one. Between the tree
> and the `"56"` bug there stands one e2e test and this chapter. A future reader who reads
> those seven lines as a performance table rather than as a soundness table will delete the
> default and reintroduce the bug, and the failure will surface as a wrong *string*, not as
> a compiler error.

## Phase two: assignment, computed forwards

The forward loop (`repr-selection.ts:223-319`) is one long `else if` chain over every node in
every block. It is nearly a hundred lines and reproducing it would teach nothing; what
matters is that its clauses fall into exactly three kinds, and only one of them can violate
the rule above.

**The opcode decides.** `isInt32Producer`, `isBoolProducer`, `isFloat64Producer` and
`isTaggedNumberProducer` (`:20-27`) each consult `resultClassOf` from the operation table,
and a node whose result class is `RESULT_INT32` gets `REP_INT32` outright. Constants go
through `constantRep` (`:170-183`), which reads the JavaScript type of `props.value`. Pinned
by
`[t: tests/optimizing/passes/repr-selection.test.ts > "assigns REP_INT32 to int32 arithmetic producers"]`,
`[t: … > "assigns REP_FLOAT64 to float64 arithmetic producers"]`,
`[t: … > "assigns REP_BOOL to comparison producers"]`,
`[t: … > "assigns REP_TAGGED_NUMBER to generic sub/mul/div/mod producers"]`,
`[t: … > "infers constant rep from value type (int→INT32, float→FLOAT64, bool→BOOL, string→HANDLE)"]`
and
`[t: … > "assigns REP_HANDLE to NewObject"]`.

**The input decides.** `CheckMap`, `CheckArray`, `CheckElementsKind` and `CheckBounds` are
pass-through guards, so they inherit their operand's representation (`:278-285`). `Neg` maps
an int32 or bool input to int32 and everything else to float64 (`:286-293`). `CheckSmi` is
always `REP_INT32`; `CheckNumber` is the interesting one, because it looks at both its input
and its consumers before choosing between float64 and int32 (`:235-244`), pinned by
`[t: tests/optimizing/passes/repr-selection.test.ts > "assigns REP_INT32 to CheckSmi"]` and
`[t: … > "assigns CheckNumber rep based on consumer: FLOAT64 if consumed by float64 op, else INT32"]`.

**The demand decides.** This is the third kind and the only one where phase one feeds phase
two. `LoadField` and `PolymorphicLoad` ask `acceptsUnboxedNumber` (`:270-277`);
`GenericCall` and `CallKnownFunction` ask `unboxedRepForDemand` (`:300-304`); and the
overloadable arithmetic that can be either a number operation or a string concatenation asks
`unboxedRepForDemand` *only if* every operand is provably numeric (`:307-314`). Those are the
clauses where a relaxed `demandOfUse` becomes a wrong answer, and they are the reason the
previous section is a soundness section rather than a tuning note. Two of the specific
outcomes here are pinned:
`[t: tests/optimizing/passes/repr-selection.test.ts > "unboxes bitwise or, xor and not to int32"]`
and
`[t: … > "keeps unsigned shift as a tagged number because it can exceed int32"]` — an
unsigned shift answers values above 2^31, so it may not be held as a signed int32 however
convenient that would be. `[t: … > "unboxes float power to float64"]` is the third.

Parameters get their own pass afterwards (`:321-338`), walking their uses: any `CheckMap`,
`CheckArray` or `CheckElementsKind` forces `REP_HANDLE` and stops the loop; otherwise a
`CheckNumber` or float64 consumer wins over a `CheckSmi` or int32 one.

> **Unfinished.** `producesNumber` (`:41-61`) and `isProvablyNumericOperand` (`:149-168`) are
> two overlapping answers to "is this numeric", and the second calls the first as one of its
> four clauses. Neither consults `TypeInference` — the component that actually knows. A value
> the type solver has proved `Smi` reads as non-numeric here unless it happens to carry a
> `CheckSmi` use or a numeric result class. Cost of fixing: threading the cached analysis
> into the pass, which is one `requires:` entry and one parameter, and then re-measuring,
> because widening what counts as numeric changes what gets unboxed.

## Phase three: the phi reflow

A loop-header phi has one input from the preheader and one from the back edge, and the back
edge's producer is *after* the phi in every block order. The forward pass therefore reaches
the phi with one input unknown, and `mergePhiRep` (`:220-221`) calls
`joinIncomingReps(inputs, true)`, where the `true` means "treat an undecided input as a
handle". Every loop counter would come out `REP_HANDLE` and be boxed once per iteration.

`reflowPhiRepresentations` (`:340-375`) undoes exactly that. It collects every phi,
**deletes** each one's representation, and re-derives it with `joinIncomingReps(inputs,
false)` — where `unknownIsHandle: false` means an undecided input is *skipped* rather than
counted as a handle — re-enqueueing the users of any phi whose answer changed. Only after the
worklist drains does anything still unknown fall back to `REP_HANDLE` (`:372-374`). The
result is
`[t: tests/optimizing/passes/repr-selection.test.ts > "keeps loop-carried int32 phis unboxed after backedge reps are known"]`.

`joinIncomingReps` has two give-up rules, both at the bottom of the function:

```ts
    if (!known) return unknownIsHandle ? REP_HANDLE : null;
    if (hasHandle) return REP_HANDLE;
    if (hasBool && (hasTaggedNumber || hasFloat64 || hasInt32))
      return REP_HANDLE;
    if (hasTaggedNumber) return REP_TAGGED_NUMBER;
    if (hasFloat64) return REP_FLOAT64;
    if (hasInt32) return REP_INT32;
    if (hasBool) return REP_BOOL;
```
— `src/optimizing/passes/repr-selection.ts:209-216`

Any handle among the inputs wins, and a bool mixed with any numeric kind gives a handle
rather than a number — because `REP_BOOL` is not on the numeric ladder and there is no
representation that is honestly both.
`[t: tests/e2e/optimizing/representation.test.ts > "keeps a boolean merged across an if/else a boolean"]`
pins the case where every input is a bool and the join stays narrow, and
`[t: tests/e2e/optimizing/representation.test.ts > "keeps a number flowing out of a logical operator away from the handle table"]`
pins the one next door.

## The return join

The wasm calling convention returns **one** scalar with **one** interpretation. A function
with a `return "x"` in one arm and a `return a + 1` in the other has no legal signature until
those two are reconciled, and neither arm knows about the other.

The fix is the phi rule applied to a merge point that does not exist in the graph — a virtual
phi at the unique exit:

```ts
  const returnedValues: ReprNode[] = [];
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type === ir.IR_RETURN && node.inputs[0])
        returnedValues.push(node.inputs[0]);
    }
  }
  graph.returnRepresentation = joinIncomingReps(
    returnedValues,
    true,
  ) as Representation;
```
— `src/optimizing/passes/repr-selection.ts:379-389`

`returnRepresentation` is a field on the graph itself (`src/optimizing/ir/index.ts:262`,
initialised `null` at `:297`), and it is the only whole-function answer in the pass.
`getExpectedInputRep` then answers it for every return — `if (consumer.type === ir.IR_RETURN)
return graph.returnRepresentation;` (`:400`) — so the conversion-insertion phase compares each
return's operand against the joined answer and calls `makeConversion` (`:474-545`) where they
differ, inserting a `Box` or `Unbox` node in front of the return. The wasm code generator
reads the same field on the way out: `abiRepresentationOf(graph.returnRepresentation ??
REP_HANDLE)` at `src/optimizing/backends/wasm/codegen.ts:1448`.

That the opcode table permits this at all is one declaration:

```
  [IR_RETURN]: terminator(ONE_INPUT, RESULT_CONTEXTUAL),
```
— `src/optimizing/ir/operations.ts:991`

`RESULT_CONTEXTUAL` (`:164`) says a return's operand class is decided *per graph*, not per
opcode — the one place in the operation table where an opcode declines to answer and defers
to whatever the compile works out.

Pinned by
`[t: tests/optimizing/passes/repr-selection.test.ts > "boxes an int32 return so every return of a function shares one representation"]`,
`[t: … > "leaves returns alone when they already share one representation"]`,
`[t: tests/e2e/optimizing/representation.test.ts > "does not truncate a float return when another return is an integer"]`
and
`[t: … > "keeps mixed integer and float returns exact"]`.

> **Unfinished.** `makeConversion` returns `null` for bool↔int32 in both directions
> (`:494-499`) and for every pair it does not list, and both call sites `continue` silently
> on `null` (`:567`, `:601`). A disagreement the pass cannot bridge therefore does not fail
> here; it fails one pass later in `representation-check`, as an internal compiler error
> naming a node and two ABI names. The fail-fast is real, but the diagnostic names the
> symptom rather than the missing conversion. Cost of fixing: two conversion cases, or an
> error at the `null` that says which pair was unbridgeable.

## Why the obvious design fails

*(Why the obvious design fails.)*

The obvious design is to let `IR_RETURN` echo its producer's own representation. Each return
then needs no conversion, the pass gets simpler, and every function trivially type-checks
against itself.

It fails at the backend. With every return keeping its own representation, a function mixing
a handle return with a numeric one produced a graph the wasm code generator could not give a
signature to, and it bailed out with the rejection `returns disagree on value representation
(X vs Y)`. A bailout is not an error — the function simply stayed at the baseline tier
forever, silently, with no diagnostic a user would ever see. **Measured 2026-08-18**: 61 of
144 mixed-return shapes compiled before the join landed; 144 of 144 after, with zero
differential mismatches.

That rejection message is **no longer in the tree** — `grep -rn "returns disagree" src/
tests/` finds nothing. The backend check was deleted when the join was added, and the failure
mode it guarded became the fail-fast validator error in the next section. Quote it as
history; there is no command that reproduces it.

## Invariant, enforcement, test

**The invariant.** Every node with a result carries a representation, and every return's ABI
representation equals the one the graph declares.

**The enforcement** is `validateRepresentations` (`src/optimizing/validation/graph-validator.ts:51-77`),
run as the `representation-check` pass immediately after `representation-selection`
(`legalization.ts:99-106`, spliced at `:400`). It collects two kinds of error and throws a
`GraphValidationError` naming all of them. The first:

```ts
function validateStamp(
  node: ValidationNode,
  block: ValidationBlock | null,
  errors: string[],
): void {
  if (resultClassOf(node.type) === RESULT_NONE) return;
  if (typeof node.props._rep === "string") return;
  const where = block === null ? "parameter" : `B${block.id}`;
  errors.push(`${where} v${node.id} ${node.type} has no representation`);
}
```
— `src/optimizing/validation/graph-validator.ts:79-88`

The second compares each return against the declared answer and reports
`B<n> v<id> returns <abi> but the graph declares <abi>` (`:69-71`). Note that both sides go
through `abiRepresentationOf`, so an int32 return and a float64 return are *not* an error —
they agree as `tagged-number`, which is the whole point of collapsing six names into three at
a boundary.

**The tests** are ordering tests rather than pass tests, because what they check is that the
pipeline puts the pass in a position where the invariant can hold:
`[t: tests/optimizing/pipeline-order.test.ts > "never grows the graph after representation selection"]`,
`[t: tests/optimizing/pipeline-order.test.ts > "gives every surviving node a representation once wasm lowering finishes"]`,
`[t: tests/optimizing/pipeline-order.test.ts > "selects representations only for targets that have tagged values"]`,
`[t: tests/optimizing/pipeline-order.test.ts > "leaves no boxing ceremony for an untagged target to strip"]`.
The first is the sharpest: a pass that adds a node after `representation-selection` adds a
node with no `_rep`, and there is no second stamping loop to catch it.

The general shape here is worth keeping. A *silent backend rejection* — correct, safe, and
invisible — was replaced by a *loud internal error* one pass after the mistake. The engine
got noisier and the failures got findable.

## The cost the fix created, and the one decline that pays for it

Boxing a numeric return costs one wasm→JS runtime-stub call per return
([Ch 53 § the-boundary-is-the-wall] for why that particular call is the expensive one). So
the return join makes strictly more functions compile, and makes some of them slower than
the baseline tier they used to fall back to.

> **Measured worse.** On the adversarial shape — a loop of 800,000 iterations over a function
> whose cold arm is `return "x"` and whose hot arm is `return a + 1` — the newly-compiled
> version measured **5.8–13.8s against 2.2s** for the baseline tier it previously fell back
> to. Min-of-five, one case per fresh process, measured
> 2026-08-18 and not re-measured for this chapter. There is no benchmark harness in this
> tree; these numbers are a record of one investigation, not a standing measurement.

The recovery is `hotBoxedReturnRejection`
(`src/optimizing/backends/wasm/graph-support.ts:788-804`), called from
`WasmCodegen.compileRejection` (`codegen.ts:510`) as the last thing it checks. It declines the
whole compile when three things are true at once: some return's operand is an inserted `Box`
whose result is a handle over a value that was not one (`boxedNumericReturns`, `:759-772`);
some branch in the graph carries a recorded bias, `props.hotSuccessor`
(`hotBlocks`, `:774-786`, and [Ch 39 § branch-bias-steers-block-order] for where that
property comes from); and the boxed return sits in a block *dominated by* that hot successor.
The message is `boxes a numeric return into a handle on a hot path`.

The design rule the tree's own tests state is **decline only on positive evidence**. No
recorded bias means no decline, and the function compiles. That is why
`[t: tests/e2e/optimizing/representation.test.ts > "still optimizes when the boxed numeric return is the cold path"]`
sits beside
`[t: … > "declines a hot numeric return that a string return forces into a handle"]`,
`[t: … > "declines a hot numeric return that an object return forces into a handle"]` and
`[t: … > "declines a hot numeric return that a boolean return forces into a handle"]`.
`[t: … > "still optimizes a function whose returns share one representation"]` is the fourth
corner: no `Box` was inserted, so there is nothing to decline.

Two properties make this safe to add. A single-return function never gets a `Box` at its
return, so the rule can only fire on graphs the return join itself created — it cannot
regress anything that compiled before the join existed. And where no bias has been recorded,
the slow compile stands; the recovery is partial, and the honest statement is that it fixes
the case the engine has evidence about and leaves the rest.

## Where this leaves the two roads

Narrowing runs for both compiling tiers. It is ordinal 8 of the shared middle end, and every
`Int32*`/`Float64*` node in this book, on either road, was created there or at ordinal 19.

Representation selection runs for neither road by default and for exactly one by capability.
`legalization.ts:400` splices it in only when the target declares `tagged-values`, which today
is the wasm target alone. The native backends never see a `_rep`, never see a `Box`, and never
consult `graph.returnRepresentation`; they reach the same questions through MachineIR's own
value types instead ([Ch 51 § capabilities-decide-which-passes-exist],
[Ch 64 § one-instruction-type]). A reader who greps a
`tera compile --print-after-all` dump for `rep=` and finds nothing has not found a bug.

The other thing you will not find in a dump is a `_rep` on the JIT road either, even though
the pass runs there. `--print-ir` fires from `onOptimize` (`src/cli/main.ts:93-96`), which is
called when the middle end finishes, and legalization runs afterwards. The representation
stamps exist; they are simply added after the only hook that prints the graph.

## What leaves

Two artifacts, produced at opposite ends of the compile.

From `type-narrowing` at ordinal 8, on both roads: the same graph with `GenericAdd`, `Sub`,
`Mul`, `Mod` and `Compare` rewritten to `Int32*` or `Float64*` wherever a guard, a `typeof`
edge or the cached type solver proved the operands numeric; `noOverflow` stamped on every
int32 arithmetic node whose every reader truncates, deleted (with a frame state grafted from
an input) where one does not; every surviving unproven `Int32Add`/`Sub`/`Mul` without a frame
state turned into `Float64*` by `int32-overflow-widening` at ordinal 19; and every `x == null`
that a *declared*, non-speculative type settles folded to a constant.

From `representation-selection`, on the wasm road only: every node carrying `props._rep`,
`Box`/`Unbox` conversions on the edges where producer and consumer disagree,
`graph.returnRepresentation` set to the join over every `IR_RETURN` operand, and a
`representation-check` pass immediately behind it that throws rather than letting a missing
stamp reach a code generator.

Plus one thing the graph does not hold and the next chapter opens on: the cached
`TypeInference` result. It answers two questions per node, not one — `typeOf(value)` and
`isSpeculative(value)` — and this chapter has used only the first.
[Ch 49 § provenance-two-ways-to-know-the-same-thing](49-speculative-types-are-not-facts.md)
is about the second, and about the wrong answer that comes out of a native binary when a pass
forgets to ask it.

## Verify it yourself

```bash
# Series.mean's four arithmetic nodes at ordinals 7, 8 and 19 — the two figures in this chapter
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | awk '/^\*\*\* IR after/{pass=$0; show=0}
         /^fn Series.mean/{if (pass ~ /#7 redundant-checks|#8 type-narrowing|#19 int32-overflow/)
                            {show=1; print ""; print pass}}
         show && /Generic(Add|Div|Compare)|Int32(Add|Compare)|Float64(Add|Div)/{print}'

# the AOT road never runs representation selection: both counts are 0
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep -c 'representation-selection'
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep -o '_rep' | wc -l

# the "56" probe: an unguarded field return stays a handle, and prints hello
printf 'g = {x: "hello"}\nfn step(i):\n  return g.x\nfn run(n):\n  last = 0\n  i = 0\n  while i < n:\n    last = step(i)\n    i = i + 1\n  return "" + last\nprint(run(200))\n' > /tmp/rep56.tera
node dist/cli.js --opt-threshold 10 --baseline-threshold 5 --print-ir --filter step /tmp/rep56.tera

# IR_RETURN has no case in demandOfUse: the only two hits are the join and getExpectedInputRep
grep -n "IR_RETURN" src/optimizing/passes/repr-selection.ts
grep -n "RESULT_CONTEXTUAL" src/optimizing/ir/operations.ts | head -3
grep -n "representation-selection\|representation-check\|tagged-values" src/optimizing/target/legalization.ts

# the rejection the return join retired is gone from the tree
grep -rn "returns disagree" src/ tests/

npx vitest run --project unit tests/optimizing/passes/repr-selection.test.ts tests/optimizing/passes/type-narrowing.test.ts
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts
```

The `--print-ir` run prints, verbatim:

```
fn step params=1 {
  graph [declaredSignature={params: ["any"], names: ["i"], defaults: [undefined], variadic: false, rest: null, returns: "any"}]
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = LoadGlobal [name="g"]
    v2 = CheckMap v1 [expectedMapId=85, expectedMapVersion=0] !fs
    v3 = LoadField v2 [offset=0]
    v4 = Return v3
}

hello
```

No `rep=` on any node and no `returnRepresentation` on the graph line, for the reason given
in [§ where-this-leaves-the-two-roads](#where-this-leaves-the-two-roads). `rep56.tera` is a
probe, not a listing: `stats.tera` has no polymorphic return and cannot reach this shape, so
per [Conventions § 2](../CONVENTIONS.md) it appears as a command and nowhere else. The
`run(n)` driver is there only to make the function hot enough to tier up;
`--opt-threshold 10` is what forces the compile, since `--always-opt` maps to a `jitThreshold`
of 3 (`buildTiering`, `src/cli/main.ts:54-57`) and would not fire for a function called a
handful of times ([Ch 35 § the-two-policies]).

## Tests that pin this

- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes GenericAdd to Int32Add when both inputs pass CheckSmi"` — the int32 rung.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes GenericSub to Int32Sub when both inputs are smi-narrowed"` — same rung, second opcode.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes GenericCompare to Int32Compare when both inputs are smi"` — a comparison is on the rewrite tables too.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes GenericAdd to Float64Add when both inputs pass CheckNumber (not smi)"` — the float64 rung.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"does NOT specialize when inputs have no type checks"` — fails closed with no facts.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"does NOT specialize when only one input has type facts"` — fails closed with half the facts.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes to float64 when one input is smi and other is number (both numeric)"` — a mix lands on the wider rung.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"narrows integer constant + CheckSmi parameter to int32 arithmetic"` — a constant counts as a proven operand.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"propagates type facts to dominated blocks"` — the dominator walk's scope.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"narrows true branch of typeof == 'number' to float64 arithmetic"` — the edge fact, positive.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"narrows true branch with === operator"` — both equality spellings.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"does not narrow false branch to the same type as true"` — `excludeType` is not the inverse of `narrowType`.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"wraps in int32 when every reader of the sum truncates it"` — outcome one of the settle.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"settles a sum a range counts with, whatever the function answers"` — the `COUNTS_IN_INT32` demand.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"leaves the sum unproven when its reader keeps the whole number"` — outcome two.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"answers a double for an unproven sum nothing can deoptimize"` — outcome three, ordinal 19.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"keeps a sum a bounds proof settled"` — a proof from elsewhere survives the settle.
- `tests/e2e/optimizing/int32-semantics.test.ts` > `"wraps a declared int return in every interpreted tier too"` — the callee owns the `-> int` wrap.
- `tests/e2e/optimizing/int32-semantics.test.ts` > `"leaves an undeclared and a float return unwrapped in every tier"` — and only where it was declared.
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_INT32 to int32 arithmetic producers"` — the opcode decides.
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_FLOAT64 to float64 arithmetic producers"` — the opcode decides.
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_BOOL to comparison producers"` — the opcode decides.
- `tests/optimizing/passes/repr-selection.test.ts` > `"infers constant rep from value type (int→INT32, float→FLOAT64, bool→BOOL, string→HANDLE)"` — `constantRep`'s four cases.
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_HANDLE to NewObject"` — an allocation is always a handle.
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_INT32 to CheckSmi"` — a guard's own result.
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns CheckNumber rep based on consumer: FLOAT64 if consumed by float64 op, else INT32"` — the one clause that reads both directions.
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_TAGGED_NUMBER to generic sub/mul/div/mod producers"` — generic arithmetic is tagged.
- `tests/optimizing/passes/repr-selection.test.ts` > `"inserts Box when int32 producer feeds tagged-number consumer"` — `makeConversion`, positive.
- `tests/optimizing/passes/repr-selection.test.ts` > `"does not insert box/unbox when reps already match"` — and it inserts nothing otherwise.
- `tests/optimizing/passes/repr-selection.test.ts` > `"keeps loop-carried int32 phis unboxed after backedge reps are known"` — the reflow.
- `tests/optimizing/passes/repr-selection.test.ts` > `"hoists constant phi input boxes to the constant block"` — where a phi's conversion is placed.
- `tests/optimizing/passes/repr-selection.test.ts` > `"boxes an int32 return so every return of a function shares one representation"` — the return join.
- `tests/optimizing/passes/repr-selection.test.ts` > `"leaves returns alone when they already share one representation"` — and does nothing when they agree.
- `tests/optimizing/passes/repr-selection.test.ts` > `"unboxes bitwise or, xor and not to int32"` — demand-driven, on a proof.
- `tests/optimizing/passes/repr-selection.test.ts` > `"keeps unsigned shift as a tagged number because it can exceed int32"` — the one bitwise op that may not be int32.
- `tests/optimizing/passes/repr-selection.test.ts` > `"unboxes float power to float64"` — `pow` on the numeric ladder.
- `tests/e2e/optimizing/representation.test.ts` > `"keeps an unguarded field return a handle"` — the `"56"` regression; the only thing standing between the tree and that bug.
- `tests/e2e/optimizing/representation.test.ts` > `"does not read a numeric result as a constant-pool handle"` — the same failure from the other side.
- `tests/e2e/optimizing/representation.test.ts` > `"does not read a numeric result as an object handle"` — same, object table.
- `tests/e2e/optimizing/representation.test.ts` > `"does not read a numeric result as an array handle"` — same, array table.
- `tests/e2e/optimizing/representation.test.ts` > `"does not truncate a float return when another return is an integer"` — the join must widen, not narrow.
- `tests/e2e/optimizing/representation.test.ts` > `"keeps mixed integer and float returns exact"` — end to end.
- `tests/e2e/optimizing/representation.test.ts` > `"still optimizes a function whose returns share one representation"` — nothing to decline.
- `tests/e2e/optimizing/representation.test.ts` > `"declines a hot numeric return that a string return forces into a handle"` — `hotBoxedReturnRejection`.
- `tests/e2e/optimizing/representation.test.ts` > `"declines a hot numeric return that an object return forces into a handle"` — same, object arm.
- `tests/e2e/optimizing/representation.test.ts` > `"declines a hot numeric return that a boolean return forces into a handle"` — same, bool arm.
- `tests/e2e/optimizing/representation.test.ts` > `"still optimizes when the boxed numeric return is the cold path"` — decline only on positive evidence.
- `tests/e2e/optimizing/representation.test.ts` > `"keeps a boolean merged across an if/else a boolean"` — `joinIncomingReps`'s bool rule.
- `tests/e2e/optimizing/representation.test.ts` > `"keeps a number flowing out of a logical operator away from the handle table"` — the same rule, numeric side.
- `tests/optimizing/pipeline-order.test.ts` > `"never grows the graph after representation selection"` — the stamping loop runs once.
- `tests/optimizing/pipeline-order.test.ts` > `"gives every surviving node a representation once wasm lowering finishes"` — the invariant, end to end.
- `tests/optimizing/pipeline-order.test.ts` > `"selects representations only for targets that have tagged values"` — the capability gate.
- `tests/optimizing/pipeline-order.test.ts` > `"leaves no boxing ceremony for an untagged target to strip"` — and the native road sees none of it.
- `tests/optimizing/ir/operations.test.ts` > `"separates machine representation from lattice type for instanceof and in"` — the two axes, pinned in the table itself.
