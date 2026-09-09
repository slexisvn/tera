# 49. Speculative Types Are Not Facts   ⟨J · N⟩

Two functions can arrive at the middle end with the identical lattice element attached to the
identical value, and one of them may be folded and the other may not. The difference is not
in the type. It is in *how the compiler came to believe it* — and in what the target is about
to do with the thing that established it.

A type derived from a guard is only true where the guard survives. The JIT keeps its guards:
a `CheckSmi` in a wasm module is a real instruction with a real failure edge, so a value that
reaches the code after it has passed the check or control never got there, and reasoning from
the narrowed type is sound. The native compiler *deletes* its guards, because there is nothing
underneath a native binary to bail out into. The same graph, the same lattice element, and one
of the two roads out of Part VII is about to throw away the evidence. A pass that reads the
type without asking where it came from is correct on one road and produces a wrong answer on
the other.

This chapter is the sharpest instance of the asymmetry chapter 1 opened the book on — *the
JIT may guess, because a wrong guess can be undone; the native compiler may not, because there
is nothing underneath it* — and the place where that asymmetry first has a concrete wrong
answer attached to it. It also has a live one. The bug this chapter documents as fixed for
`int | null` parameters is still open for `string | null` parameters, and it reproduces on
this tree today.

`stats.tera` cannot reach any of this. It has no nullable parameter, no comparison against
`null`, and no guard node at all — the running example's narrowing in
[Ch 48 § settle-int32](48-types-and-representations-in-the-middle-end.md) came entirely from
the flow-insensitive type solver. So the programs below appear as commands under "Verify it
yourself" and never as listings beside the running example
([Conventions § 2](../CONVENTIONS.md)).

**What arrived.** From [Ch 48](48-types-and-representations-in-the-middle-end.md): the graph
after `type-narrowing` at ordinal 8, plus the thing that pass consulted and the graph does not
hold — the cached `TypeInference` result, stored under `typeInferenceAnalysisId`. It answers
two questions per node, not one:

```ts
export interface TypeInference {
  typeOf(value: ir.CFGInstruction): LatticeType;
  isSpeculative(value: ir.CFGInstruction): boolean;
}
```
— `src/optimizing/analyses/type-inference.ts:25-28`

Chapter 48 used only the first. This chapter is about the second, and about why an interface
with two methods on it is the closest thing in the tree to an enforcement mechanism.

## Provenance: two ways to know the same thing

Hold two functions in mind at once.

```
fn f(n: int) -> bool:
  return n == null
```

`n` is not null. It cannot be, because the *source* says `int`, and the checker of
[Ch 11 § the-write-back] rejects any call that would pass something else. Folding `n == null` to
`false` here is correct on every tier, at every optimization level, forever.

Now the same body where `n`'s only claim to being a number is a `CheckSmi` some pass inserted
because the parameter was declared `int | null` and a guard is how a compiler narrows a union.
The check succeeded, so at the point of the comparison `n` really is a small integer, and
`n == null` really is `false` — *in the code where the check is still executing*.

The lattice answers both with the identical element, `{kind: "Smi"}`. That is not a defect of
the lattice. Look at what a lattice element is:

```ts
export type SingletonType = Readonly<{
  kind: SingletonKind;
  nullable?: boolean;
}>;

export type ObjectType = Readonly<{
  kind: typeof TypeKind.Object;
  map: IRMetadataValue | null;
  nullable: boolean;
}>;

export type ArrayType = Readonly<{
  kind: typeof TypeKind.Array;
  elementsKind: IRMetadataValue | null;
}>;
```
— `src/optimizing/types/lattice.ts:35-49`

Three shapes, and nowhere in any of them to record where the fact came from. That is correct
by construction, because a lattice element denotes a **set of values** ([Ch 10 § a-lattice]),
and "where I learned this" is not a set of values. It is a property of the *path*, not of the
*value*.

> **New idea. Provenance.** Two analyses can agree on a value's type and disagree completely
> about what you may do with it, because a type carries no record of its evidence.
> *Provenance* is that record: the difference between "this value is a number" and "this value
> is a number **because** a check said so". It matters exactly when something downstream may
> remove the evidence. In a compiler with one back end, provenance is a curiosity — the guard
> is always there, so the fact is always true. In a compiler with two back ends, one of which
> discharges guards and one of which executes them, provenance is a soundness property, and
> it needs its own channel because the type system has nowhere to put it.

## The taint set

The second channel is one `Set`, and it is filled by the same worklist that computes the
types. Membership starts at seven opcodes:

```ts
const SPECULATIVE_SOURCES = new Set<string>([
  ir.IR_CHECK_SMI,
  ir.IR_CHECK_NUMBER,
  ir.IR_CHECK_MAP,
  ir.IR_CHECK_ARRAY,
  ir.IR_CHECK_ELEMENTS_KIND,
  ir.IR_CHECK_BOUNDS,
  ir.IR_CHECK_CALL_TARGET,
]);
```
— `src/optimizing/analyses/type-inference.ts:30-38`

and spreads by one function:

```ts
  private propagateSpeculation(node: ir.CFGInstruction): boolean {
    if (this.speculative.has(node)) return false;
    const tainted =
      SPECULATIVE_SOURCES.has(node.type) ||
      node.inputs.some((input) => this.speculative.has(input));
    if (!tainted) return false;
    this.speculative.add(node);
    return true;
  }
```
— `src/optimizing/analyses/type-inference.ts:120-128`

Three properties carry that. It is **monotone** — a node is only ever
added, never removed, so it cannot oscillate and it terminates. It is **transitive through
inputs** — anything computed from a guarded value inherits the taint, which is exactly the
propagation rule you want, because a sum of a guarded number is only a number for the same
reason the operand was. And it **rides the type worklist**, so it costs one extra `Set` and
one extra pass over `node.inputs` per visit rather than an analysis of its own.

Riding the type worklist is where the subtlety is. A worklist algorithm normally stops
pushing a node's observers once the node's answer has stopped changing, because there is
nothing new to tell them. Here there are two answers changing independently:

```ts
    while (this.worklist.length > 0) {
      const node = this.worklist.pop()!;
      this.queued.delete(node);
      const previous = this.typeOf(node);
      const next = joinTypes(previous, this.evaluate(node));
      const grew = !typeEquals(previous, next);
      if (grew) this.types.set(node, next);
      if (!this.propagateSpeculation(node) && !grew) continue;
      for (const observer of this.observersOf(node)) this.enqueue(observer);
    }
```
— `src/optimizing/analyses/type-inference.ts:96-105`

The line that matters is the second-to-last. `continue` — stop, tell nobody — happens only
when the taint did **not** spread *and* the type did not grow. Drop the first conjunct and
taint stops dead at the first node whose type had already converged, which in a loop is
almost immediately: a phi reaches its final type on an early iteration and then never
re-notifies its users, so a guard discovered later never reaches them. The two facts have
different convergence times and one worklist has to serve both.

> **New idea. A fixpoint with two lattices.** A dataflow solver iterates until nothing
> changes. When it is tracking two properties at once, "nothing changes" means *neither*
> changed — and the cheapest way to get that wrong is to write the termination test for the
> property you were thinking about. Both properties here are monotone and both are bounded,
> so the combined solver still terminates; it is only the *notification* rule that has to
> mention both.

`observersOf` (`:108-118`) is the notification set: every use, plus, for a store into an
array element, the array itself — so a taint that enters an element reaches the array.

## Why the JIT would have been fine

Here is the asymmetry stated as a soundness argument rather than a capability one.

In the JIT, `CheckSmi v0` is still in the emitted code. It compiles to a wasm tag test with a
branch to a deoptimization stub ([Ch 54 § deoptimizing-out-of-wasm]). Control reaches the
instruction after it only if the test passed. So at the point where a pass folds
`n == null` to `false`, `n` genuinely is a small integer at every execution that gets there,
and the fold is correct. Not "usually correct", not "correct because the feedback said so" —
correct, because the check is a real instruction and the alternative path leaves.

In the native compiler the check is **gone by the time the code is emitted**. The graph the
fold ran on still contained it; the binary does not. So the fold is a claim about a value
nothing ever tested, and if the caller passes `null` the binary answers as though it had not.

This is not "AOT is more conservative". Conservatism is a choice about how much to attempt.
This is the *same graph meaning two different things* depending on what happens to the guards
afterwards, which is a fact about the compiler's structure, not a tuning knob. The middle end
runs the same passes for both roads by design ([Ch 41 § step-order]); the divergence is
entirely downstream, and it reaches backwards to invalidate a rewrite the middle end already
performed.

## Where the guards go: speculationLowering

The whole target-side vocabulary is sixteen lines:

```ts
export type SpeculationKind =
  | "deopt-to-interpreter"
  | "guard-with-slowpath"
  | "prove-or-generic";

export interface SpeculationStrategy {
  readonly kind: SpeculationKind;
}

export const deoptToInterpreter: SpeculationStrategy = {
  kind: "deopt-to-interpreter",
};

export const proveOrGeneric: SpeculationStrategy = {
  kind: "prove-or-generic",
};
```
— `src/optimizing/target/speculation.ts:1-16`

Three kinds, two exported strategies. The wasm target selects `deoptToInterpreter`, whose
implementation is `["deopt-to-interpreter", () => 0]` — a no-op that changes nothing and
returns zero (`speculation-lowering.ts:173`). The C, x64 and riscv64 targets select
`proveOrGeneric`. `speculation-lowering` runs as legalization ordinal 13, after the shared
middle end has finished ([Ch 51 § the-second-pipeline]).

`proveOrGeneric` classifies every node by its speculation role:

```ts
      const role = speculationRoleOf(node.type);
      if (role === SPECULATION_BASE_GUARD || (lowerGenerics && role === SPECULATION_NATIVE_GUARD)) {
        passthrough.push(node);
      } else if (DESPECIALIZE.has(node.type) && !isProven(node)) specialized.push(node);
```
— `src/optimizing/passes/speculation-lowering.ts:122-125`

and then deletes everything in `passthrough`:

```ts
  for (const node of passthrough) {
    editor.replaceAllUses(node, node.inputs[0]!);
    editor.remove(node);
    changed++;
  }
```
— `src/optimizing/passes/speculation-lowering.ts:141-145`

Every use of the guard is redirected to the guard's own input, and the guard is removed.
`lowerGenerics` is `true` for `prove-or-generic`, so under that strategy **seven of the eight
guard opcodes** are deleted: the three `SPECULATION_BASE_GUARD`s (`CheckSmi`, `CheckNumber`,
`CheckPrimitive`) and the four `SPECULATION_NATIVE_GUARD`s (`CheckCallTarget`, `CheckArray`,
`CheckElementsKind`, `CheckBounds`).

The eighth is `IR_CHECK_MAP`, which carries `SPECULATION_NONE`
(`src/optimizing/ir/operations.ts:839-845`) and is therefore not touched by this pass at all.
That looks like an omission and is not. `irCheckMap` is constructed in exactly four places,
in two files: `src/optimizing/builder/ir-builder.ts:1103` and `:1219`, and the JIT inliner
`src/optimizing/builder/inline.ts:546` and `:602` — all of them reading an inline cache's
recorded map out of a feedback vector. The AOT road has no feedback vector, so a `CheckMap`
never enters an AOT graph in the first place. Compile `stats.tera` with `--print-after-all`
and `CheckMap` appears zero times in the entire dump. The one guard that carries no
speculation role is the one guard only the speculating tier can produce.

The other half of the pass is what makes deletion safe rather than merely possible. An
`Int32Add` without `noOverflow` — one the settle of
[Ch 48 § settle-int32](48-types-and-representations-in-the-middle-end.md) declined to prove —
is *despecialized* to `Float64Add` (`DESPECIALIZE`, `:61-70`, gated on `isProven`, `:102-104`)
rather than left to wrap silently. And a `GenericAdd` whose operands may be numeric is lowered
to a concrete arithmetic node (`GENERIC_LOWERINGS`, `:74-94`). Removing a guard is only
legitimate when the code that depended on it has been rewritten into something that does not.
[Ch 55 § no-way-out] and [Ch 56 § refusing-well] are where that principle becomes a refusal
rather than a rewrite.

## The single consumer

`isSpeculative` has exactly **one** call site in `src/`:

```
$ grep -rn "isSpeculative" src/ | grep -v "analyses/type-inference.ts"
src/optimizing/passes/type-narrowing.ts:255:    if (this.types.isSpeculative(value)) return null;
```

It is inside `definedComparison`, the helper that decides whether an `x == null` can be folded
to a constant. The last five lines of that function are the chapter's rule made executable,
and the order is the whole content:

```ts
    if (value === null) return null;
    if (this.types.isSpeculative(value)) return null;
    const type = this.typeAt(value);
    if (acceptsNull(type)) return null;
    return DEFINED_KINDS.has(type.kind) ? result : null;
```
— `src/optimizing/passes/type-narrowing.ts:254-258`

Provenance first, then nullability, then kind. The order is not cosmetic. `acceptsNull` reads
`this.typeAt(value)`, and `typeAt` prefers the narrower's *own refinement map* over the
solver's answer ([Ch 48 § flow-sensitivity-and-the-price-of-it]) — and that refinement map is
precisely where `applyGuardFact` just wrote the guard's narrowing. Asking `acceptsNull` first
would answer the question using the very fact whose provenance you were about to check, and
answer it "no, this cannot be null", and fold. The `isSpeculative` test has to come before
anything that reads the type, because everything that reads the type reads the tainted answer.

`NULLISH_COMPARISONS` (`:78-83`) is the four operators this applies to — `==`, `loose==`,
`!=`, `loose!=`, mapped to the constant each would produce — and `DEFINED_KINDS` (`:85-93`) is
the seven lattice kinds that are definitely not nullish. `foldDefinedComparison` (`:261-274`)
does the replacement: stamp a fresh `Constant`, swap it into the block in place, redirect
every use, detach the old node.

## The three tests that draw the line

The tree's own unit tests are one experiment with one variable. All three build the same
graph through a shared helper:

```ts
    function comparing(declared: string, guard: boolean) {
      const graph = new CFGFunction("test");
      graph.declaredSignature = { params: [declared], returns: "bool" };
      const block = graph.addBlock();
      const p0 = graph.addParameter(0);
      const value = guard ? checkSmi(p0) : p0;
      if (guard) block.addNode(value);
```
— `tests/optimizing/passes/type-narrowing.test.ts:403-409`

Only the declared type and the presence of a `checkSmi` change.

- `[t: tests/optimizing/passes/type-narrowing.test.ts > "folds it away when the value is declared as one that cannot be null"]`
  — declared `int`, no guard. The type is a *fact from the source*, so `isSpeculative` is
  false, `acceptsNull` is false, and the comparison is folded away: `compare.block` becomes
  `null`.
- `[t: … > "keeps it when the value is declared as one that can be null"]` — declared
  `int | null`, no guard. `acceptsNull` is true, so it is kept. This is the ordinary case and
  needs no provenance at all.
- `[t: … > "keeps it when only a speculation says the value cannot be null"]` — declared
  `int | null`, **wrapped in `checkSmi`**. `acceptsNull` would now answer false, because the
  guard narrowed it. It is kept anyway, because `isSpeculative` answered first.

The third test is the entire chapter in nine lines, and it fails — by folding — the moment
line 255 is deleted.

## The bug, told as engineering

*(Bug as engineering.)*

**Symptom.** A three-line function answered differently from a native binary than from the
interpreter, with no diagnostic anywhere and exit code 0 on both. The program needs three
ingredients, and they are the three the regression test
`[t: tests/e2e/optimizing/aot/null.test.ts > "answers a nullable parameter compared against null, beside a null store"]`
assembles: a nullable declared parameter, a comparison of it against `null`, and a second
null store into a reference field — without which the whole thing is simplified away before
it becomes interesting.

**Mechanism.** Four passes in a row, each behaving correctly on its own terms.
`parameter-type-guards` at ordinal 0 turned the declared union into a guard, because a guard
is how a union is narrowed:

```ts
const GUARD_BY_KIND = new Map<string, GuardBuilder>([
  [TypeKind.Smi, (param) => ir.irCheckSmi(param)],
  [TypeKind.Double, (param) => ir.irCheckNumber(param)],
  [TypeKind.Number, (param) => ir.irCheckNumber(param)],
  [TypeKind.String, (param) => ir.irCheckPrimitive(param, "string")],
  [TypeKind.Boolean, (param) => ir.irCheckPrimitive(param, "boolean")],
]);
```
— `src/optimizing/passes/parameter-guards.ts:8-14`

`type-narrowing` at ordinal 8 read the narrowed type as a fact and folded the comparison to a
constant. `speculation-lowering` at legalization ordinal 13 deleted the guard. The C backend
emitted the constant.

**Fix.** `SPECULATIVE_SOURCES`, plus the one line at `type-narrowing.ts:255`.

**Regression test.** The three `comparing against null` unit tests above, plus three e2e ones:
`[t: tests/e2e/optimizing/aot/null.test.ts > "answers a nullable parameter compared against null, beside a null store"]`,
`[t: … > "answers it the same way through the C backend"]` and
`[t: … > "branches on a nullable parameter beside a null store"]`.

Today an `int | null` parameter is handled correctly, and the C the backend emits is a real
runtime comparison:

```c
int32_t probe(double p0, unsigned char *p1) {
  void *v0 = 0;
  double v1 = tera_f64_of_bits(9221120237041090561ull);
  ...
  const int32_t v3 = tera_f64_absent(p0) == tera_f64_absent(v1);
  ...
  return v3;
}
```

Substitute `string | null` for `int | null` and the bug is still there. This is the same
program, the same three ingredients, one word changed:

```c
int32_t probe(const tera_char *p0, unsigned char *p1) {
  void *v0 = 0;
  const int32_t v1 = 0;
  ...
  (void)p0;
  ...
  return v1;
}
```

`(void)p0;` — the parameter is not used. `return v1;` where `v1` is the compile-time constant
`0`. This is what "a speculative type treated as a fact" looks like after it has passed
through every downstream pass and a code generator: not a crash, not a warning, a *cast to
void* and a literal.

> **Broken.** `IR_CHECK_PRIMITIVE` is the eighth guard opcode and it is **not** in
> `SPECULATIVE_SOURCES` (`src/optimizing/analyses/type-inference.ts:30-38`), so the bug this
> chapter documents as fixed is still live for `string` parameters.
> `GUARD_BY_KIND` (`src/optimizing/passes/parameter-guards.ts:8-14`) maps `TypeKind.String`
> and `TypeKind.Boolean` to exactly that opcode, so a declared `string | null` parameter
> reaches `definedComparison` carrying a speculative type the analysis reports as clean.
> **Measured 2026-09-08**, three ingredients as above: the interpreter prints `true` then
> `false`; the PE binary prints `false` twice. `--print-after-all` names the pass and the
> node — `*** IR after #8 type-narrowing [changed, nodes 8 -> 8 (+0), invalidated
> type-inference points-to mod-ref] ***` turns
> `v5 = GenericCompare v7, v4 [op="loose=="]`, where
> `v7 = CheckPrimitive v0 [primitive="string"]`, into `v9 = Constant [value=false]`.
> Substituting `int | null` — a `CheckSmi`, which *is* in the set — leaves
> `v5 = GenericCompare v7, v4` untouched at the same pass, which isolates the taint set as
> the difference. `bool | null` does **not** reproduce, for a second and unrelated reason:
> `joinTypes` has cases for numeric, `String` and `Object` joined with `Nullish` but none for
> `Boolean` (`src/optimizing/types/lattice.ts:232-249`), so `bool | null` falls through to
> `taggedType()` at `:262`, whose kind is not in `GUARD_BY_KIND`, and no guard is inserted at
> all — `parameter-type-guards` reports `[unchanged]`. Cost of fixing: one entry in
> `SPECULATIVE_SOURCES`. Cost of fixing it so it cannot recur:
> [Ch 49 § what-the-taint-set-does-not-cover].
> No test covers a nullable `string` or `boolean` parameter compared against `null`;
> `tests/e2e/optimizing/aot/null.test.ts` tests `int | null` only. **[unpinned]**

## Speculative taint

**The general rule, and the reason this chapter exists:** *any* fold, guard elimination or
branch removal that reads a type must ask `isSpeculative` first. A type is only usable as a
fact if the target keeps the thing that established it.

Three properties of that rule are worth separating, because they are usually run together and
they are not the same claim.

It is **not** a rule about AOT being weaker. The narrowed type is genuinely true on the JIT
road, and the JIT is entitled to fold. The rule says the *middle end*, which serves both
roads, may not.

It is **not** subsumed by "don't optimize what you can't prove". The compiler *can* prove it —
on one target. The property being violated is that the proof's supporting evidence has a
lifetime, and the pass that consumes it runs before the pass that ends that lifetime.

And it is the **same sentence** as
[Ch 48 § the-soundness-rule](48-types-and-representations-in-the-middle-end.md), stated about
a different currency. There the rule was *demand is not proof*: a representation narrowed
because no consumer asked for the wide one is narrowed on no evidence. Here it is
*speculation is not proof*: a type narrowed because a guard said so is narrowed on evidence
that one of the two targets is about to delete. Two chapters, two mechanisms, one shape.

## Why the obvious design fails

*(Why the obvious design fails.)*

The obvious design is to put the bit where the fact is. Add `speculative?: boolean` to
`SingletonType`, let `narrowType` set it when the narrowing came from a guard, and every
consumer of a type gets the provenance for free — no second data structure, no second
question, no interface to remember to call.

It fails on three properties of the lattice that are load-bearing elsewhere.

**Lattice elements are interned frozen singletons.** `SINGLETONS`
(`src/optimizing/types/lattice.ts:54-64`) holds exactly one `Object.freeze`d value per
singleton kind, handed out by `singleton()` (`:66-68`), and every constructor —
`smiType()`, `numberType()`, `anyType()` — returns the same object every time. A provenance
bit would double that table, or force allocation where there is currently none.

**Elements are compared with `typeEquals` and used as map keys.** The solver's termination
test is `const grew = !typeEquals(previous, next)` (`type-inference.ts:101`). Make
`typeEquals` provenance-sensitive and the solver starts reporting "the type grew" for changes
that are not type changes — which is the *opposite* of the problem the `!grew` conjunct was
added to solve, and considerably harder to reason about. Make it provenance-insensitive and
the bit is silently lost at every join.

**`joinTypes` is a pure function of two elements** (`:217-263`). Provenance is a property of a
*path*, and there is no correct rule for joining two paths into one element: a value that is
guarded on one incoming edge and declared on the other is speculative, but the join of the two
types has to be a single interned element that cannot say so.

A separate `Set` keyed by node identity has none of those problems. It is the smaller
structure and it is also the more honest one: it puts a path property in a path-shaped place.

## What the taint set does not cover

The gap has a shape, and the shape is that `SPECULATIVE_SOURCES` is a **hand-written list of
opcode names** while the property it is trying to name is already a derived fact of the
operation table — spelled two other ways, in the same file, neither of which agrees with it.

Every guard entry in `src/optimizing/ir/operations.ts` carries a transfer function and a
speculation role. `guardTransfer` is what makes an opcode a narrowing one:

```ts
function guardTransfer(fact: (node: TransferNode) => LatticeType): Transfer {
  return (node, context) => narrowType(inputType(node, 0, context), fact(node));
}
```
— `src/optimizing/ir/operations.ts:383-385`

Here is what the eight guard entries actually say, read out of the table:

```
opcode                   line  transfer               speculation role        in the set?
IR_CHECK_MAP             839   guardTransfer          SPECULATION_NONE        yes
IR_CHECK_SMI             846   guardTransfer          SPECULATION_BASE_GUARD  yes
IR_CHECK_NUMBER          852   guardTransfer          SPECULATION_BASE_GUARD  yes
IR_CHECK_CALL_TARGET     858   constant(boolean)      SPECULATION_NATIVE_GUARD yes
IR_CHECK_ARRAY           864   guardTransfer          SPECULATION_NATIVE_GUARD yes
IR_CHECK_ELEMENTS_KIND   871   guardTransfer          SPECULATION_NATIVE_GUARD yes
IR_CHECK_PRIMITIVE       878   guardTransfer          SPECULATION_BASE_GUARD  NO
IR_CHECK_BOUNDS          884   passthroughTransfer    SPECULATION_NATIVE_GUARD yes
```

Three spellings of one idea, and all three partition the eight opcodes differently. The
hand-written set omits `IR_CHECK_PRIMITIVE`, which is the live bug. Deriving the set from
"has a `guardTransfer`" would fix that but would *drop* `IR_CHECK_CALL_TARGET` and
`IR_CHECK_BOUNDS`, both of which are speculations whose failure the JIT deoptimizes on.
Deriving it from "speculation role is not `SPECULATION_NONE`" — the fix that looks obvious
from the role field's name — would drop `IR_CHECK_MAP`, and `CheckMap` is the JIT's single
most important guard.

So the honest statement is not "derive it from the table"; it is that the table does not
currently contain the property, and one of the three near-misses would have to be made exact
first. The model for doing that is in the same file:
`[t: tests/optimizing/ir/operations.test.ts > "declares an entry for every exported opcode constant"]`
is the tree's one existing table-completeness check, and a fourth field — or a derivation
from the third with `IR_CHECK_MAP`'s role corrected — plus a test of that shape is what would
make the eighth guard impossible to forget again.

> **Unenforced.** `SPECULATIVE_SOURCES` is a hand-maintained `Set<string>`. Nothing checks it
> against the guard entries in the operation table, and the two have already drifted by one
> entry. Cost of closing it: making one of `guardTransfer`-ness or `speculationRoleOf` an
> exact statement of "this opcode narrows its input on evidence a target may delete", and a
> test that asserts the set equals the derived answer.

> **Unfinished.** `guard-with-slowpath` is one of the three `SpeculationKind`s
> (`src/optimizing/target/speculation.ts:1-4`) and no target in the tree selects it: the wasm
> target uses `deoptToInterpreter`, and the C, x64 and riscv64 targets use `proveOrGeneric`.
> The branch it would take — `proveOrGeneric(…, lowerGenerics = false)`, which deletes only
> the three base guards and leaves the native ones standing
> (`speculation-lowering.ts:174`) — is reachable only from a hand-built `TargetModel`.
> Finishing it means a backend that keeps the guard and emits a generic slow path beside the
> fast one: a third answer to this chapter's question, in which the native compiler neither
> proves nor refuses but branches. Cost: a slow-path lowering for every guard opcode and a
> capability on `TargetModel`.

## Invariant, enforcement, test

**The invariant.** A value in the speculative set may not have its type used to remove code.

**The enforcement** is one `if` in one pass — `type-narrowing.ts:255` — and that is the whole
of it.

**The test** is the three `comparing against null` titles above, plus the three e2e tests
under `describe("AOT null comparison soundness")` in `tests/e2e/optimizing/aot/null.test.ts`
that check the same behaviour through a linked binary.

> **Unenforced.** Nothing prevents a new pass from calling `types.typeOf`, reading a narrowed
> answer, and folding on it. There is no lint, no wrapper type, no assertion, and no verifier
> that could detect it — the wrong code is indistinguishable from the right code until you run
> the binary. `typeOf` has many call sites across the pass directory; `isSpeculative` has one.
> The rule is carried by this chapter and three unit tests.
>
> The one structural mitigation that does exist is small and worth naming: `TypeInference` is
> an *interface with two methods* (`type-inference.ts:25-28`), not a bare function. Every pass
> that declares `typeInferenceId` in its `requires:` and receives the analysis has
> `isSpeculative` in scope whether or not it calls it, and a reader who opens the interface
> sees both questions side by side. That is a documentation mechanism dressed as a type, and
> in a codebase with 26 comment lines it is not nothing — but it is not enforcement.

## This is the hinge, in miniature

**One** builder emits `CheckSmi`. The JIT treats that node as a **bailout point** and keeps
it. The native compiler treats it as an **assertion to be discharged** and deletes it.

Every difference between the two roads out of the middle end is a consequence of that one
sentence. The JIT can speculate on feedback because the guard it inserts has somewhere to go
when the guess is wrong; the native compiler must prove the fact statically or refuse to
compile the function at all ([Ch 56 § refusing-well]). Representation selection exists on one
road and not the other for a related reason — a tagged value is a runtime question, and a road
with no runtime under it answers it at compile time instead
([Ch 48 § where-this-leaves-the-two-roads](48-types-and-representations-in-the-middle-end.md)).
[Ch 55 § no-way-out] is where the sentence becomes the organizing principle of an entire
compiler, and [Ch 83 § agreement] is where the book audits how well it was kept.

This chapter is where it first has a wrong answer attached to it, and — because
`IR_CHECK_PRIMITIVE` is still missing from a seven-element set — where it still has one.

## What leaves

The same graph and the same cached analysis, with one new obligation established about every
fold, guard removal and branch rewrite still to come: **ask `isSpeculative` before you ask
anything else.**

Nothing in the graph records that obligation, which is the point of the `> **Unenforced.**`
above. What leaves is a rule and the three tests that hold it.

The first pass downstream that runs straight into it is chapter 50's inliner. Inlining copies
a callee's nodes — guards included — into a caller where the guard's dominance relationship
was established somewhere else entirely, and then hands the result to the same middle end for
a second run. What that does to frame states, to a callee's declared `-> int` promise, and to
the pass ordinals in a `--print-after-all` dump is
[Ch 50 § inlining](50-inlining-and-tail-calls.md).

## Verify it yourself

```bash
# the taint set: seven opcodes, and which one is missing
grep -n "SPECULATIVE_SOURCES" -A 10 src/optimizing/analyses/type-inference.ts
grep -n "]: guard(" src/optimizing/ir/operations.ts

# isSpeculative has exactly one call site outside its own file
grep -rn "isSpeculative" src/ | grep -v "analyses/type-inference.ts"

# the live bug: interpreter true/false, native binary false/false
printf 'class Box:\n  public link: Box | null = null\n  public constructor(v: int):\n    this.v = v\n\nfn probe(s: string | null, b: Box) -> bool:\n  b.link = null\n  return s == null\n\nb = Box(1)\nprint(probe(null, b))\nprint(probe("hi", b))\n' > /tmp/strnull.tera
node dist/cli.js /tmp/strnull.tera
node dist/cli.js compile /tmp/strnull.tera -o /tmp/strnull.exe && /tmp/strnull.exe

# the control: the same program with int | null agrees on both tiers
printf 'class Box:\n  public link: Box | null = null\n  public constructor(v: int):\n    this.v = v\n\nfn probe(n: int | null, b: Box) -> bool:\n  b.link = null\n  return n == null\n\nb = Box(1)\nprint(probe(null, b))\nprint(probe(7, b))\n' > /tmp/intnull.tera
node dist/cli.js /tmp/intnull.tera
node dist/cli.js compile /tmp/intnull.tera -o /tmp/intnull.exe && /tmp/intnull.exe

# the pass and the node: #8 replaces the compare with a constant for string, not for int
node dist/cli.js compile /tmp/strnull.tera --emit source --target c --print-after-all -o /tmp/strc 2>&1 \
  | awk '/^\*\*\* IR after/{pass=$0} /^fn probe/{if (pass ~ /#8 type-narrowing/) {show=1; print pass} else show=0} show{print}'
node dist/cli.js compile /tmp/intnull.tera --emit source --target c --print-after-all -o /tmp/intc 2>&1 \
  | awk '/^\*\*\* IR after/{pass=$0} /^fn probe/{if (pass ~ /#8 type-narrowing/) {show=1; print pass} else show=0} show{print}'

# CheckMap never reaches an AOT graph, which is why it needs no speculation role
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 | grep -c CheckMap

npx vitest run --project unit tests/optimizing/passes/type-narrowing.test.ts
```

The two `#8 type-narrowing` dumps differ in exactly one node. For `string | null`:

```
*** IR after #8 type-narrowing [changed, nodes 8 -> 8 (+0), invalidated type-inference points-to mod-ref] ***
fn probe params=2 {
  graph [declaredSignature={params: ["string | null", "Box"], names: ["s", "b"], defaults: [undefined, undefined], variadic: false, rest: null, returns: "bool"}, classes=<opaque:Table>]
  v0 = Parameter [index=0]
  v1 = Parameter [index=1]
  B0 succs= preds=:
    v7 = CheckPrimitive v0 [primitive="string"] !fs
    v2 = Constant [value=null]
    v3 = GenericSetProp v1, v2 [propName="link"] !fs
    v4 = Constant [value=null]
    v9 = Constant [value=false]
    v6 = Return v9
}
```

and for `int | null`, the same eight nodes with `v5` still standing:

```
*** IR after #8 type-narrowing [unchanged, nodes 8 -> 8 (+0), invalidated nothing] ***
    v7 = CheckSmi v0 !fs
    ...
    v5 = GenericCompare v7, v4 [op="loose=="]
    v6 = Return v5
```

One is `[changed]` and the other is `[unchanged]`, and the only difference between the two
programs is the word `string`. The two binaries print `false false` and `true false`.

## Tests that pin this

- `tests/optimizing/passes/type-narrowing.test.ts` > `"folds it away when the value is declared as one that cannot be null"` — a declared non-nullable type is a fact and may be folded on.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"keeps it when the value is declared as one that can be null"` — the ordinary `acceptsNull` refusal, no provenance needed.
- `tests/optimizing/passes/type-narrowing.test.ts` > `"keeps it when only a speculation says the value cannot be null"` — the whole chapter; fails by folding the moment `type-narrowing.ts:255` is deleted.
- `tests/e2e/optimizing/aot/null.test.ts` > `"answers a nullable parameter compared against null, beside a null store"` — the three ingredients, through a linked binary.
- `tests/e2e/optimizing/aot/null.test.ts` > `"answers it the same way through the C backend"` — the same program on the second AOT backend.
- `tests/e2e/optimizing/aot/null.test.ts` > `"branches on a nullable parameter beside a null store"` — the branch form as well as the return form.
- `tests/e2e/optimizing/aot/null.test.ts` > `"refuses returning null where a number is declared"` — the refusal that keeps the absence representable.
- `tests/e2e/optimizing/aot/null.test.ts` > `"still refuses a reference whose type admits both absences, since they share one pointer"` — the second absence value, [Ch 56 § two-absence-values].
- `tests/optimizing/ir/operations.test.ts` > `"keeps the effect classifications mutually exclusive"` — the operation table's one existing internal-consistency check.
- `tests/optimizing/ir/operations.test.ts` > `"declares an entry for every exported opcode constant"` — the completeness check, and the model for the fix the taint set needs.
- **No test covers a nullable `string` or `boolean` parameter compared against `null`.**
  `[unpinned]` — that gap is exactly the shape of the live bug above.
