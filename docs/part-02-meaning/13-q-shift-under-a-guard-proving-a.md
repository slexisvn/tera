# 13. `q.shift()` Under a Guard: Proving a Partial Operation Total   ⟨— · — · J · N⟩

`[Ch 1 § what-a-guard-proves]` showed you the answer: the checker does not track a boolean
saying "this array is non-empty", it tracks a number saying how many elements the guard
proved were there, and every take spends one. That is the shape of the fact. This chapter
is the mechanism — all two hundred and ninety lines of it — and the reason the shape had to
be that and not something simpler.

The question the mechanism answers is narrower than "what type does this expression have".
It is: *given that control flow reached this exact call, is `q.shift()` total here?* A
refinement like that is easy to establish and hard to retire. Establishing it is a table
lookup on the operator in the guard. Retiring it means knowing every operation that could
falsify it, and that is where a boolean fails: `shift()` does not make a guard false, it
makes it *less true*, and a boolean has no room to record a degree. So the guard has to
hand over a quantity, and every take has to spend one, and the analysis has to be able to
say — at each of a dozen places where control flow does something it cannot follow —
"I no longer know."

The general rule this chapter is built to earn is one sentence: **a refinement about mutable
state must name what falsifies it, and where the state is quantitative the refinement must
be quantitative too.** `[Ch 1 § why-the-obvious-design-fails]` tells the story of the
five-day-old boolean that did not, and of commit `11021f9` that deleted it. This chapter
does not retell that story. It reads the replacement.

**What arrived.** From [Ch 12 § what-leaves-and-where-it-lands]: an `ObjectShape` per class
in `env.interfaces`, so a field written `this.items = []` has a real array type and
`arrayMethodSignature` can answer for `.shift()` on it at all. From [Ch 11 § the-write-back]:
a type for every expression. And from [Ch 8 § testrole-is-the-only-thing-four-constructs-disagree-about]:
a `SemanticProgram` whose `Block` nodes carry `testRole` — `"guard"` for an `if`, `"loop"`
for a `while` or a `for` — and `otherwise`, the list of tests that had to fail for this arm
to be reached. Those two fields are what this whole chapter reads. Nothing else about the
semantic tree matters here, and in particular no scope has been built yet: the analysis runs
before binding.

## New idea: a partial operation

> **New idea. A partial operation, and proving one total.** An operation is **total** on a
> type when it has an answer for every value of that type, and **partial** when it does not.
> `q.length` is total on any array. `q.shift()` is not: an empty array has no first element.
> `[Ch 1 § what-shift-answers]` covers the three things a language can do about that; tera
> widens the answer's type to `element | undefined` and makes the caller deal with it. What
> this chapter adds is the other half. A partial operation can be *proved total at a
> particular place*, by an analysis that establishes the precondition holds there. When the
> proof succeeds the widened type is stripped and the caller deals with nothing. When it
> fails, the type stands and the program is refused. There is no third outcome — the checker
> never inserts a run-time check.

The widened type is not in the language specification. `data/tera-language-spec.ts:6627-6633`
declares `shift` with no parameters and `"returns": "any"` at `:6630`; `pop` immediately
above it (`:6620-6626`) is identical. The `element | undefined` shape is manufactured by the
checker, from the array's element type, in the same two-line neighbourhood that types the
opposite pair:

```ts
  if (property === "push" || property === "unshift") return signature(`${owner}.${property}`, [["x", element]], "int");
  if (property === "pop" || property === "shift") return signature(`${owner}.${property}`, [], unionType([element, "undefined"]));
```
— `src/frontend/checker/infer.ts:668-669`

Two lines, four members, and the asymmetry between them is the entire subject. Putting an
element in answers an `int` — a length, always available. Taking one out answers a union,
because it might not be there. The four names in those two lines are exactly the four names
in `TAKES_ONE_ELEMENT` and `ADDS_ONE_ELEMENT` (`src/core/indexing.ts:61-62`), which is not a
coincidence and is also not enforced by anything.

The stakes differ per tier, and that is why this chapter carries a `⟨— · — · J · N⟩` badge.
The interpreter never asks: it hands back the host's `undefined`, and `2 + undefined` is
`NaN`, printed without complaint. The native compiler has no `undefined` for an `int` to
degrade into — a native `int` is a machine word ([Ch 55 § the-same-graph-with-no-way-out]) —
so it must either be told the value is present or refuse the program. This analysis is
where it is told, or is not.

## New idea: refinement

> **New idea. A refinement.** A **refinement** is a place where a name's type is narrower
> than its declaration, because control flow got you here. After `if x != null:`, inside
> that branch, `x` is not null. The declaration did not change; the *place* did. Two things
> make refinements hard. The first is scope — the fact is true inside the branch and not
> outside it, so it has to live somewhere that ends. The second is invalidation — anything
> that can change what the fact is about must be able to retire it. A checker that gets the
> first right and the second wrong is worse than one with no refinements at all, because it
> is confidently wrong rather than merely conservative.

There are two refinement mechanisms in this checker, they are shaped differently, and the
difference is the point of the chapter. The simpler one is `narrowScope`, and it handles
`null` and `undefined`:

```ts
  const child = childScope(parent, target);
  if (!test) return child;
  if (test.type === NodeType.BinaryExpression && ["!=", "==", "!==", "==="].includes(String(test.op))) {
    const left = test.left as ASTNode;
    const right = test.right as ASTNode;
    const subject = nullishComparisonSubject(left, right);
    if (subject) {
      const binding = lookup(parent, subject.name) ?? { type: inferExpression(subject.node, bound, parent), optional: false };
      if (binding) {
        const nonNullish = (test.op === "!=" || test.op === "!==") !== negated;
        const next = nonNullish ? removeNullish(binding.type, bound.env) : unionType(unionParts(binding.type, bound.env).filter((part) => part === "null" || part === "undefined"));
        child.locals.set(subject.name, { ...binding, type: next, widens: binding.widens ?? binding.type });
      }
    }
  }
  return child;
```
— `src/frontend/checker/infer.ts:482-497`

Four things are worth naming in those sixteen lines.

`nullishComparisonSubject` (`infer.ts:500-510`) accepts the literal on **either** side, so
`x != null` and `null != x` are the same test. It returns a name, and the name comes from
`subjectName` (`src/frontend/ast/index.ts:258-261`), which answers for an identifier *or* a
dotted name — so `this.items != null` narrows too.

The `negated` parameter flips polarity with one exclusive-or:
`(op === "!=" || op === "!==") !== negated`. One function serves both the taken arm and the
refuted one; there is no second implementation for `else`.

When the guard does *not* hold, the refinement is not "nothing" — it is the complement.
`next` becomes the nullish parts alone, so inside `else` the name is `null`, and reading a
member off it is reported
`[t: tests/frontend/checker/type-checker.test.ts > "still reports a member read inside the branch where the value is null"]`.

And the write goes into a **child** scope, not the current one. The refinement's lifetime is
the child scope's lifetime. That is the whole invalidation story for `narrowScope`: nothing
retires the fact, because the fact cannot outlive the block.

## The widens field

A refinement narrows what a *read* sees. It must not narrow what an *assignment* is checked
against, or a narrowed name could never be assigned back to its declared type. That is what
`Binding.widens` is for.

`widens` is written by the last line of the excerpt above, and read by `assignableType`
(`src/frontend/checker/type-system.ts:40-43`), quoted in
[Ch 12 § the-open-field]: an open field answers `"any"`, and otherwise the answer is
`binding.widens ?? binding.type`. So a binding carries two types at once — the narrowed one
in `type` for reads, and the pre-narrowing one in `widens` for the assignability question
that a write asks.

The idiom `widens: binding.widens ?? binding.type` appears at both writers, and the `??` is
load-bearing. Narrow a name twice and the second narrowing must not record the *first*
narrowing as the original; it must carry the true declaration forward. The second writer is
`joinBranches` (`src/frontend/checker/type-checker.ts:109`), doing the same thing when it
recombines the arms of an if-else chain.

The reader that closes the loop is on the assignment path:

```ts
  const widest = target.type === NodeType.Identifier ? lookup(scope, String(target.name))?.widens : undefined;
  return widest ?? inferExpression(target, bound, scope);
```
— `src/frontend/checker/type-checker.ts:1471-1472`

`declaredTargetType` asks "what may be stored here?" and answers with `widens` when there is
one. So inside `if x != null:`, reading `x` gives the non-null type, and `x = null` is still
legal
`[t: tests/frontend/checker/type-checker.test.ts > "lets an assignment widen a narrowed binding back to its declared type"]`.
`checkVar` writes the same field for a declaration whose stored type differs from what was
assigned (`type-checker.ts:549`), which is how the mechanism reaches ordinary `name: T = v`
bindings and not only guarded ones.

Note what `widens` is *not*. It is not a count, it is not per-site, and it says nothing about
arrays. It is a two-valued undo button for one binding. Everything from here on is about the
question it cannot answer.

## Where a refinement is applied, three times

`narrowScope` builds a scope. Three call sites in `type-checker.ts` decide *which* scope gets
the refinement, and they are three genuinely different answers:

```ts
  refuteGuard(node: SemanticNode, scope: Scope): void {
    if (node.kind !== "Block" || node.testRole !== "guard" || !alwaysExits(node.body)) return;
    this.refine(scope, node.test, true);
  }

  refine(scope: Scope, test: ASTNode | undefined, negated: boolean): void {
    if (!test) return;
    const narrowed = narrowScope(test, this.bound, scope, undefined, negated);
    for (const [name, binding] of narrowed.locals) scope.locals.set(name, binding);
  }

  blockScope(node: Extract<SemanticNode, { kind: "Block" }>, scope: Scope): Scope {
    const child = childScope(scope, this.bound.scopes.get(node));
    for (const refuted of node.otherwise ?? []) this.refine(child, refuted, true);
    this.refine(child, node.test, false);
    return child;
  }
```
— `src/frontend/checker/type-checker.ts:127-143`

**`blockScope` refines the child, on entry.** It refutes every test in `otherwise` first,
then asserts the block's own test. The order matters for an else-if chain: the third arm of
`if a: … elif b: … elif c:` knows `not a`, `not b`, *and* `c`
`[t: tests/frontend/checker/type-checker.test.ts > "hands the last arm of an else-if chain every earlier refutation"]`.
The `otherwise` list is built by [Ch 8 § rebuilding-an-else-if-chain-from-a-flat-list];
this chapter is its only consumer besides `Bounds`.

**`refuteGuard` refines the enclosing scope, after the fact.** If a guard's body always
exits, then the statements *after* the guard are only reached when the guard was false, so
the refutation is true from there on. This is what makes the early-return idiom work at any
nesting depth
`[t: tests/frontend/checker/type-checker.test.ts > "keeps narrowing for the statements after a guard at the top level"]`.
It is called from two places in `checkStatements` (`:72` for a plain statement, `:82` for
every arm of a chain).

**`joinBranches` recombines what the arms left.** After a chain, each arm that did not exit
contributes its narrowed binding, plus — when the last arm has a test — the refuted scope
for the implicit fall-through. Their types are folded with `widenType` and written back with
the `widens` idiom
`[t: tests/frontend/checker/type-checker.test.ts > "joins what the branches leave behind"]`.
An arm that exits contributes nothing, which is why a chain where one arm assigns and the
other returns leaves the name narrowed
`[t: tests/frontend/checker/type-checker.test.ts > "reads a member after a branch that assigns and one that returns"]`.

There is a fourth, in the inference walk rather than the check walk. A conditional expression
narrows both arms independently before joining them:

```ts
    case NodeType.ConditionalExpression: {
      const test = node.test as ASTNode;
      const taken = narrowScope(test, bound, scope);
      const untaken = narrowScope(test, bound, scope, undefined, true);
      const a = inferExpression(node.consequent as ASTNode, bound, taken, null, expectedType);
      const b = inferExpression(node.alternate as ASTNode, bound, untaken, null, expectedType);
      return a === b ? a : unionType([a, b]);
    }
```
— `src/frontend/checker/infer.ts:111-118`

`x != null ? x.n : 0` works for the same reason `if x != null:` does, through the same
function called twice with opposite polarity.

One thing is deliberately *not* refined: a loop condition. `refuteGuard` requires
`testRole === "guard"`, and a `while`'s block carries `"loop"`. The reason is in the test
title: a `break` can leave the condition true when the loop ends, so the refutation is not
sound after it
`[t: tests/frontend/checker/type-checker.test.ts > "leaves a loop condition alone, since a break can leave it true"]`.

## Shallow on purpose

*(Why the obvious design fails.)*

`refuteGuard` turns on `alwaysExits`, and `alwaysExits` is two lines:

```ts
const LEAVES_THE_BODY: ReadonlySet<SemanticNode["kind"]> = new Set<SemanticNode["kind"]>([
  "Return",
  "Jump",
]);

export function alwaysExits(body: readonly SemanticNode[]): boolean {
  return body.some((node) => LEAVES_THE_BODY.has(node.kind));
}
```
— `src/frontend/checker/semantic-ast.ts:223-230`

A `some` over one statement list. No recursion into nested blocks, no reachability, no
notion of a statement being unreachable after another. If any *top-level* statement of the
body is a `Return` or a `Jump`, the body always exits.

The obvious design is a real reachability analysis. Build a control-flow graph for the
function; a block always exits if every path from its entry reaches a terminator; ask that.
It is the correct answer and it is standard machinery — [Ch 38 § three-classes-and-nothing-else] builds
exactly that graph for the middle end. It fails *here* for a structural reason: the checker
walks a statement list in source order, one pass, with no graph and no second visit
([Ch 16 § single-pass-and-why-source-order-is-semantics]). Building a CFG in the checker
would mean either a second tree representation or a second traversal framework, for a
predicate that is consulted at one call site.

What the shallow version buys is that three quite different guards are one rule.
`Jump` is [Ch 8 § the-collapse]'s single node kind for `break`, `continue` *and* `throw`, so
after lowering there is nothing to distinguish them, and all three read as "the body left":

- `if x == null: return` — pinned by
  `[t: tests/frontend/checker/type-checker.test.ts > "reads a member after a guard that returns"]`
- `if x == null: throw Error("no")` — pinned by
  `[t: tests/frontend/checker/type-checker.test.ts > "reads a member after a guard that throws"]`
- `if x == null: continue` — pinned by
  `[t: tests/frontend/checker/type-checker.test.ts > "reads a member after a guard that continues"]`

Three test titles, one `Set` with two entries in it. That is the trade the shallowness buys.

What it costs is a guard whose exit is nested. `if x == null: if noisy: return` does not
exit at the top level of the guard's body — the top-level statement is a `Block` — so
`alwaysExits` answers `false` and the refutation is not applied. The checker then reports
the member read after the guard. The failure direction is the safe one: the checker refuses
a program that would have run, rather than accepting one that would not.

## What `narrowScope` deliberately does not do

The list is short and each item is a real gap.

It matches only `BinaryExpression` with one of `!=`, `==`, `!==`, `===`, against a `null` or
`undefined` **literal** (`infer.ts:484`). A `typeof` test, a truthiness test, a call to an
`is_present`-style helper: none of them narrow.

It does not recurse through `and` / `or`. The test node must itself be the comparison. So a
guard that checks two things narrows neither:

```
$ node dist/cli.js check -e 'class P:
  public constructor():
    this.n = 1
a: P | null = P()
b: P | null = P()
if a != null and b != null:
  print(a.n)'
[eval]:7:9: error: Cannot access member 'n' on nullable type 'P | null'
```

The diagnostic lands on the *use*, at 7:9, which is `a` — the left operand of the very
conjunction that was supposed to prove it.

It does not look at `.length` at all, and it does not refine a member expression whose object
is itself narrowed.

> **Unfinished.** `narrowScope` (`src/frontend/checker/infer.ts:484`) tests
> `test.type === NodeType.BinaryExpression` and stops. It never inspects a
> `LogicalExpression`, so `if a != null and b != null:` narrows neither operand — reproduced
> above and in "Verify it yourself". The gap is unusually visible because the table it needs
> already exists twelve lines into another file in the same directory: `KEPT_WHEN`
> (`src/frontend/checker/length-bounds.ts:28-33`) and the recursion in `countedSubjects`
> (`:98-108`) are exactly the shape `narrowScope` is missing. Two refinements in one checker,
> one of which learned De Morgan and one of which did not. Finishing it costs lifting that
> recursion into `narrowScope`, plus a decision about what an `||` arm may assume — the
> length analysis answers *nothing*, and a nullability analysis probably should too.

That contrast is the hinge of the chapter. The two refinements answer different questions,
and the question about array lengths turns out to need machinery the question about `null`
never needed: a table of what a comparison proves, a rule for which operands of a compound
test survive, an arithmetic for spending and repaying, and an explicit set of places where
the answer must be thrown away. What follows is that machinery, in that order.

## New idea: proven false is not the same as not proven

> **New idea. Three states, not two.** A static analysis that reasons about a fact has three
> possible positions, not two: the fact is **proven**, the fact is **proven false**, or the
> analysis **does not know**. Collapsing the last two is the classic soundness bug — treating
> "I could not establish it" as "it is false" is safe for a fact you need to be true, and
> catastrophic for a fact you need to be false. The rule that keeps this analysis honest is
> that an unrecognised construct contributes *nothing to the count* rather than contributing
> a claim about it, and that every place the analysis loses track deletes the count outright
> instead of leaving a stale one behind.

The first place that rule is visible is compound tests. A guard is often not one comparison:

```ts
const MIRRORED: ReadonlyMap<string, string> = new Map([
  [">", "<"],
  [">=", "<="],
  ["<", ">"],
  ["<=", ">="],
]);

const KEPT_WHEN: ReadonlyMap<string, boolean> = new Map([
  ["&&", false],
  ["and", false],
  ["||", true],
  ["or", true],
]);
```
— `src/frontend/checker/length-bounds.ts:21-33`

`KEPT_WHEN` is De Morgan written as a two-row map. Read it as: *an operand's fact survives
an `and` when you took the branch, and survives an `or` when you refuted it.* Taking
`A and B` means both held, so anything either proves is available. Refuting `A or B` means
neither held, so anything either operand's *negation* proves is available. Taking `A or B`
proves nothing about `A` specifically — the `or` may have been satisfied by `B` — and
refuting `A and B` proves nothing either.

The recursion reads the table against the polarity it was called with:

```ts
function countedSubjects(test: ASTNode, negated: boolean): Counted[] {
  if (test.type === NodeType.LogicalExpression && KEPT_WHEN.get(String(test.op)) === negated) {
    return [
      ...countedSubjects(test.left as ASTNode, negated),
      ...countedSubjects(test.right as ASTNode, negated),
    ];
  }
  if (test.type !== NodeType.BinaryExpression) return [];
  const subject = countedSubject(test, negated);
  return subject === null ? [] : [subject];
}
```
— `src/frontend/checker/length-bounds.ts:98-108`

`KEPT_WHEN.get(op) === negated` is the whole decision. When it does not match — an `or` you
took, an `and` you refuted, an operator not in the table — the function falls through to the
`BinaryExpression` test, fails it, and returns the empty array. Not `null`, not a marker
saying "unknown": an empty list of facts. The analysis learns nothing and carries on with
what it already had.

You can watch both halves from the command line. This is silent, because `and` was taken:

```
$ node dist/cli.js check -e 'q: int[] = [1,2]
f = true
if q.length > 0 and f:
  a: int = q.shift()
  print(a)'
$ echo $?
0
```

`[t: tests/frontend/checker/type-checker.test.ts > "takes one under a guard that also checks something else"]`.
Change one word and the proof evaporates, because an `or` you took proves nothing:

```
$ node dist/cli.js check -e 'q: int[] = [1,2]
f = true
if q.length > 0 or f:
  a: int = q.shift()
  print(a)'
[eval]:4:12: error: Type 'int | undefined' is not assignable to 'int' (the value may be absent: guard it before use, or spell a fallback with ??)
```

## The boolean the guard threw away

`q.length > 0` does not mean "non-empty". It means "at least one". `q.length >= 3` means
"at least three". A boolean loses the difference, and the difference is what a second take
needs.

The arithmetic is `provenCount` in `src/core/indexing.ts:55-59`, quoted in full at
`[Ch 1 § what-a-guard-proves]`. Three things about it deserve stating precisely here, because
the rest of the chapter depends on them.

**`COMPLEMENT` is applied first, when `negated`.** The map at `:28-39` has ten entries and
covers both the strict and the loose comparison spellings the parser can produce
(`loose==` and `loose!=` sit alongside `==` and `===`). So the refuted arm of
`if q.length > 0:` is read as `<=`, which proves nothing, and the refuted arm of
`if q.length == 0:` is read as `!=` against a bound of zero, which proves one
`[t: tests/core/indexing.test.ts > "reads a negated test as its complement"]`.

**`PROVEN_COUNT` turns each surviving operator into a number** (`:44-53`). `>` gives
`bound + 1`; `>=` and the three equality spellings give `bound` itself; the three
inequality spellings give `1` when the bound is `0` and `0` otherwise — because
`length != 0` proves one element and `length != 7` proves nothing
`[t: tests/core/indexing.test.ts > "counts one only from a count that differs from zero"]`.

**Everything else answers zero, not `null`.** An operator the table does not know produces
`NO_COUNT` (`:57`), and `Math.max(NO_COUNT, proven)` (`:58`) clamps a nonsense bound like
`q.length >= -4` back to nothing
`[t: tests/core/indexing.test.ts > "counts nothing from an operator it does not know"]`.
Absence of proof is not proof, and it is not disproof either — it is simply no contribution.

The same function is called from the middle end. `src/optimizing/passes/array-methods.ts:678-679`
asks `provenCount(operator, bound)` and `provenCount(operator, bound, true)` about an SSA
comparison, to decide whether a branch guarantees an array holds some. One table, two
consumers, no second spelling of "greater than zero" anywhere in the tree
([Ch 26 § provencount-the-same-file-a-compile-time-question]).

## Both operand orders, one function

A guard can be written either way round, and one function normalises it:

```ts
function countedSubject(test: ASTNode, negated: boolean): Counted | null {
  const left = test.left as ASTNode;
  const right = test.right as ASTNode;
  const counted = countedName(left);
  const name = counted ?? countedName(right);
  if (name === null) return null;
  const bound = literalCount(counted === null ? left : right);
  if (bound === null) return null;
  const op = String(test.op);
  const read = counted === null ? (MIRRORED.get(op) ?? op) : op;
  const proven = provenCount(read, bound, negated);
  return proven === NOTHING ? null : { name, proven };
}
```
— `src/frontend/checker/length-bounds.ts:84-96`

`countedName` (`:73-77`) demands a member expression whose member is literally `length`
(the constant `COUNT_MEMBER` at `:18`) and whose object has a `subjectName` — an identifier
or a dotted name. It is tried on the left first; if that fails it is tried on the right.
`literalCount` (`:79-82`) then reads whichever side is left over.

`MIRRORED` is applied exactly when the count was found on the *right*, so `0 < q.length` is
read as `q.length > 0`
`[t: tests/frontend/checker/type-checker.test.ts > "takes one under a guard written the other way round"]`,
and `2 <= q.length` as `q.length >= 2`. The `?? op` fallback leaves a symmetric operator
like `==` alone.

Because the subject may be a dotted name, a method guarding its own field works with no
special case at all:
`if this.items.length > 0:` proves one for the key `"this.items"`, and
`this.items.shift()` inside spends it
`[t: tests/frontend/checker/type-checker.test.ts > "takes one off a field the method guarded"]`.

> **Unfinished.** `literalCount` (`src/frontend/checker/length-bounds.ts:79-82`) requires a
> `Literal` node of kind `number`. A guard written against a variable proves nothing, even
> when the variable is obviously constant. Measured on this tree, 2026-09-07:
> `n: int = 1` followed by `if q.length >= n:` and one `q.shift()` reports
> `Type 'int | undefined' is not assignable to 'int' (the value may be absent: …)`, while the
> identical program with `>= 1` written out is silent. The middle-end twin has the same
> restriction — `boundOf` (`src/optimizing/passes/array-methods.ts:665-666`) demands an
> `IR_CONSTANT`. Finishing it in the checker costs a constant-folding pass over the semantic
> tree, which is the same missing machinery the `alwaysExits` gap above needs and the
> single-pass checker does not have.

## New idea: a transfer function

> **New idea. A transfer function.** An analysis that reasons about a program at a point
> needs two things: a **state**, which is what it knows there, and a **transfer function**,
> which says how each construct changes that state. Walk the program in order, apply the
> transfer function to each construct, and the state at any point is what you know there.
> The state must be something that can be joined when two paths meet — `[Ch 10 § a-lattice]`'s
> subject — and every construct must have an entry, including the ones the analysis does not
> understand, whose entry is usually "discard everything relevant".

`Bounds` is a transfer function with exactly one piece of state that matters:

- `counts: Map<string, number>` — from an array's **name text** to how many elements are
  still provably in it.

The other three fields (`trail`, `undoable`, `taken`) are bookkeeping for undo and for
scoping, and are the subject of two sections below. The whole analysis is: put numbers into
`counts` when you see a guard, take them out when you see a take, delete them when you see
something you cannot follow.

Guards write into it:

```ts
  private guarded(test: ASTNode | undefined, negated: boolean): void {
    if (!test) return;
    for (const counted of countedSubjects(test, negated)) {
      const held = this.counts.get(counted.name);
      if (held !== undefined && held >= counted.proven) continue;
      this.write(counted.name, counted.proven);
    }
  }
```
— `src/frontend/checker/length-bounds.ts:200-207`

One comparison decides two behaviours that would otherwise be separate rules. A guard only
writes when it proves *more* than is already held. So a stronger guard followed by a weaker
one keeps the stronger count
`[t: tests/frontend/checker/length-bounds.test.ts > "keeps a count already proven when a weaker guard follows"]`,
and a single test that names the same array twice — `q.length > 0 and q.length >= 3` —
keeps three, because `countedSubjects` returns both facts and the second one wins the
comparison
`[t: tests/frontend/checker/length-bounds.test.ts > "keeps the larger count when one test names the array twice"]`.
Neither case needs a rule of its own.

Note that this is a *maximum*, not a join. Two guards on the same path both hold, so the
larger is correct. Two guards on *different* paths do not both hold, and that case is
handled somewhere else, by `merge`, with the opposite arithmetic.

## Spending and refunding

`expression` classifies an expression node after walking its children, and routes the two
kinds of length-changing call:

```ts
  private expression(node: ASTNode): void {
    const walk = (): void => {
      for (const child of astChildren(node)) this.expression(child);
    };
    if (RUNS_LATER.has(String(node.type))) return this.forget(this.apart(walk));
    walk();
    const call = memberCall(node);
    if (call === null) return;
    if (TAKES_ONE_ELEMENT.has(call.member)) return this.takes(node.callee as ASTNode, call.held);
    if (ADDS_ONE_ELEMENT.has(call.member)) this.adds(call.held);
  }
```
— `src/frontend/checker/length-bounds.ts:209-219`

Children first, then the node itself. That order is what makes `total += q.shift() + q.shift()`
spend two rather than one, and what makes a take inside a bigger expression count at all
`[t: tests/frontend/checker/length-bounds.test.ts > "counts a take that a larger expression encloses"]`.
`memberCall` (`:110-116`) is the recogniser: a call whose callee is a member expression whose
object has a `subjectName`.

`takes` and `adds` (`:221-233`) are quoted at `[Ch 1 § what-a-guard-proves]`. Three details
in them decide the chapter's downstream behaviour.

**`takes` records the name in `taken` before anything else** (`:222`), unconditionally —
before it checks whether there is a count at all. `taken` is not the count; it is the set of
arrays this region *touched*, and it is what `apart` propagates outward. A take against an
array with no count still poisons that array for any enclosing region.

**What goes into `proven` is `node.callee`, not the call** (`:217`, `:225`). The callee is
the `q.shift` member expression. That is the node `inferCall` has in hand when it needs to
decide, so the set is keyed on the thing the consumer can look up.

**`adds` refunds only if there is already a count** (`:230-231`). A `push` on an array nobody
guarded returns immediately and proves nothing, which is
`[t: tests/frontend/checker/length-bounds.test.ts > "never lets put backs alone prove a take"]`.
This is the asymmetry that keeps the analysis sound: a count is a *lower bound established by
a guard*, and an operation that increases a length cannot manufacture a lower bound where
there was none. It can only repay one that exists
`[t: tests/frontend/checker/length-bounds.test.ts > "counts a put back towards the take that follows it"]`.

## Arms are alternatives, not a sequence

An if-else chain is not a sequence of statements — the arms are mutually exclusive — so
`statements` (`:126-136`) detects a chain with `branchChain` (`semantic-ast.ts:208-221`) and
hands it to a different method:

```ts
  private chain(nodes: readonly BlockNode[]): void {
    for (const node of nodes) if (node.test) this.expression(node.test);
    const reached: Changed[] = [];
    for (const node of nodes) {
      const mark = this.mark();
      this.entered(node);
      if (!alwaysExits(node.body)) reached.push(this.changedSince(mark));
      this.rollBack(mark);
    }
    const last = nodes[nodes.length - ONE_ELEMENT]!;
    if (last.test !== undefined) {
      const mark = this.mark();
      for (const refuted of [...(last.otherwise ?? []), last.test]) this.guarded(refuted, true);
      reached.push(this.changedSince(mark));
      this.rollBack(mark);
    }
    this.merge(reached);
  }
```
— `src/frontend/checker/length-bounds.ts:160-177`

The first line walks every arm's test as an *expression* before any arm is entered, because
a test can itself take an element — `if q.shift() != 0:` spends one on every path, whether
the arm is taken or not
`[t: tests/frontend/checker/length-bounds.test.ts > "proves nothing after a loop whose own test took an element"]`
is the loop version of the same care.

Then each arm runs between a `mark()` and a `rollBack(mark)`, so every arm starts from the
same `counts`
`[t: tests/frontend/checker/length-bounds.test.ts > "starts each arm from the same count"]`.
What survives an arm is not the map, it is `changedSince(mark)` — a record of which names
that arm touched, and what they ended at. An arm whose body `alwaysExits` never joins
`reached`, because control does not continue from it.

The block after the loop is the else path, and it is a source of counts in its own right.
When the last arm carries a test, the *refuted* form of that test plus every earlier
`otherwise` is applied. `if q.length == 0: return` leaves at least one element behind on the
path that continues, which is how a program written as an emptiness guard proves exactly as
much as one written the other way round
`[t: tests/frontend/checker/length-bounds.test.ts > "proves what the refuted guard leaves when every arm exits"]`
and
`[t: tests/frontend/checker/type-checker.test.ts > "takes one in the arm where an emptiness guard did not hold"]`.

The join is a minimum, absorbing on the unknown:

```ts
function leastRemaining(left: Remaining, right: Remaining): Remaining {
  return left === undefined || right === undefined ? undefined : Math.min(left, right);
}
```
— `src/frontend/checker/length-bounds.ts:69-71`

```ts
  private merge(reached: readonly Changed[]): void {
    if (reached.length === NOTHING) return;
    const touched = new Set<string>();
    for (const path of reached) for (const name of path.keys()) touched.add(name);
    for (const name of touched) {
      const along = reached.map((path) => (path.has(name) ? path.get(name) : this.counts.get(name)));
      this.write(name, along.reduce(leastRemaining));
    }
  }
```
— `src/frontend/checker/length-bounds.ts:179-187`

`Remaining` is `number | undefined`, and `undefined` means "not known", not "zero". Making
it absorbing in `leastRemaining` is the three-state rule from two sections ago, spelled as
arithmetic: if any surviving path does not know, the merge does not know. `Math.min`
otherwise, because the count is a lower bound — one arm leaving two and another leaving one
means one is what is proven after the branch
`[t: tests/frontend/checker/length-bounds.test.ts > "carries the worst arm into what follows the branch"]`.
A name a path did not touch reads its value from the current `counts`, so an arm that takes
nothing does not weaken anything
`[t: tests/frontend/checker/length-bounds.test.ts > "keeps the count across a branch that takes nothing"]`.

## The trail

`chain` needs to run each arm, capture its effect, and put the map back. The obvious way is
to copy the map before each arm. That is not what happens, and the reason is that `chain`
nests: an arm can contain a chain, which contains a chain. Copying the whole map at every
level is one copy per nesting level per arm, and only the touched names are ever needed.

So `Bounds` keeps an undo log instead:

```ts
  private write(name: string, count: Remaining): void {
    if (this.undoable > NOTHING) this.trail.push({ name, had: this.counts.get(name) });
    if (count === undefined) this.counts.delete(name);
    else this.counts.set(name, count);
  }

  private mark(): number {
    this.undoable += ONE_ELEMENT;
    return this.trail.length;
  }
```
— `src/frontend/checker/length-bounds.ts:258-267`

Every write goes through `write`, and `write` records the *previous* value on the trail —
but only while `undoable > 0`, so a walk that nobody intends to undo pays nothing. `mark`
increments the depth and returns the trail length, which is the token everything else takes.

```ts
  private changedSince(mark: number): Changed {
    const changed: Changed = new Map();
    for (let at = mark; at < this.trail.length; at++) changed.set(this.trail[at]!.name, undefined);
    for (const name of changed.keys()) changed.set(name, this.counts.get(name));
    return changed;
  }

  private rollBack(mark: number): void {
    while (this.trail.length > mark) {
      const { name, had } = this.trail.pop()!;
      if (had === undefined) this.counts.delete(name);
      else this.counts.set(name, had);
    }
    this.undoable -= ONE_ELEMENT;
  }
```
— `src/frontend/checker/length-bounds.ts:269-283`

`changedSince` is two loops on purpose. The first collects the *names* touched since the
mark, deduplicated by the map. The second then reads each name's **current** value, not the
value recorded on the trail — because a name written three times inside one arm should be
reported once, at the value it ended on. `rollBack` pops in reverse, which restores the
oldest recorded value last, and decrements the depth. There is no snapshot anywhere in the
file.

The one thing to notice is that `undoable` is a depth counter and `write` consults it before
touching the trail, which means the trail is only ever populated inside a `mark`/`rollBack`
pair. Outside one — at the top level of a function body, say — writes are permanent and free.

## Three ways to lose a count

`apart` is the analysis's honesty mechanism. It swaps in empty state, runs a region, restores
the real state, and reports which arrays the region took from:

```ts
  private apart(walk: () => void): ReadonlySet<string> {
    const counts = this.counts;
    const trail = this.trail;
    const undoable = this.undoable;
    const taken = this.taken;
    this.counts = new Map();
    this.trail = [];
    this.undoable = NOTHING;
    this.taken = new Set();
    walk();
    const consumed = this.taken;
    this.counts = counts;
    this.trail = trail;
    this.undoable = undoable;
    this.taken = taken;
    for (const name of consumed) this.taken.add(name);
    return consumed;
  }
```
— `src/frontend/checker/length-bounds.ts:235-252`

Four fields saved, four fields replaced with empties, walk, four fields restored — and then
one asymmetry, at the second-to-last line: the names consumed inside are added to the
*outer* `taken` set, so the poison propagates outward through any number of nesting levels.
Callers then pass the returned set to `forget` (`:254-256`), which writes `undefined` for
each name — deleting the count rather than lowering it.

There are three callers, and they are three genuinely different reasons control flow cannot
be followed.

**A function value may run at any time.** `RUNS_LATER` (`:35-38`) is arrow and function
expressions, and `expression` checks it *before* walking children (`:213`). So
`names.map(n => q.shift())` isolates the lambda's body, sees the take, and forgets `q`
`[t: tests/frontend/checker/length-bounds.test.ts > "proves nothing about a take inside a lambda the count encloses"]`.

**A declaration carries its own scope.** `CARRIES_ITS_OWN_SCOPE` (`:42-46`) maps `Function`
to its body, `Model` to its body, and `Class` to *every member's* body. `deferred`
(`:189-198`) runs each of those bodies inside its own `apart` and forgets the union
`[t: tests/frontend/checker/length-bounds.test.ts > "forgets the count once a nested function may have taken from it"]`.
Because a class contributes every member, a method that guards and takes on its own field is
analysed correctly in isolation
`[t: tests/frontend/checker/length-bounds.test.ts > "counts a method's own guard against its own takes"]`
while contributing nothing to the enclosing program
`[t: tests/frontend/checker/length-bounds.test.ts > "sees a take inside a class member the same way"]`.

**A loop body may run any number of times.** `RUNS_REPEATEDLY` (`:55-61`) maps `For` to its
body and `Block` to its body *only when* `testRole` is `"loop"`. `statement` (`:138-152`),
quoted at `[Ch 1 § what-a-guard-proves]`, runs the loop's test and body inside an `apart` and
forgets the result. So whatever a loop took is unknown after it
`[t: tests/frontend/checker/length-bounds.test.ts > "proves nothing about a take that follows a loop which took one"]`,
and a `for` behaves identically to a `while`
`[t: tests/frontend/checker/length-bounds.test.ts > "counts a for loop the same way as a while loop"]`.

The loop case has a subtlety that makes it exact rather than merely conservative, and it is
the line that makes `queue.tera` behave the way `[Ch 1 § the-cold-open]` describes.
`statement` re-applies the loop's own test *inside* the `apart`: `if (repeated.test)
this.expression(repeated.test); this.guarded(repeated.test, false);` (`:145-146`). The
isolated region therefore starts empty and immediately learns what the loop condition proves.
That is why `while q.length > 0:` proves the first `shift()` on every round
`[t: tests/frontend/checker/length-bounds.test.ts > "proves a take under the loop's own count on every round"]`
while proving nothing about the take once the loop has finished, and nothing about a take the
loop repeats
`[t: tests/frontend/checker/length-bounds.test.ts > "a take a loop may repeat" > "proves nothing about the take itself"]`.

The `For` entry also walks `ownExpressions(node)` *outside* the `apart` first (`:143`) — the
iterable of a `for x of ys:` is evaluated once, before the body, so a take in it should spend
from the outer count normally.

## A push inside a closure does not repay

`apart` propagates `taken`. It does not propagate `counts`. That is one line's worth of
asymmetry and it is deliberate.

A take inside an isolated region destroys the count outside it, because a take is a fact
about the array: if that code runs, the element is gone, and the analysis cannot prove it
does not run. A put back inside an isolated region repays nothing outside it, because a put
back is a fact about a *code path*, and the analysis cannot prove that path runs either. The
two directions are not symmetric because the consequences of being wrong are not symmetric:
over-counting a take is safe, over-counting a refund is a wrong answer in a binary.

Four test titles hold the four shapes it takes:

- `[t: tests/frontend/checker/length-bounds.test.ts > "does not let a put back inside a nested function repay a take"]`
- `[t: tests/frontend/checker/length-bounds.test.ts > "does not let a put back inside a loop repay a take that follows"]`
- `[t: tests/frontend/checker/length-bounds.test.ts > "does not let a put back inside a lambda repay a take"]`
- `[t: tests/frontend/checker/length-bounds.test.ts > "leaves the count alone across a loop that only puts back"]`

The last of those is the sharp one. A loop containing only a `push` touches nothing —
`taken` stays empty, so `forget` is handed an empty set — and the count *outside* the loop
survives untouched. The loop neither helped nor hurt. That is the correct answer, and it
falls out of `apart` propagating the take set rather than the count map.

## Handing the answer to the checker

The analysis runs once, over the whole program body, at bind time — and before any binding
exists:

```ts
  const bound: BoundProgram = {
    program,
    env: createTypeEnv(),
    root,
    scopes: new WeakMap(),
    reserved,
    provenTakes: provenTakes(program.body),
  };
  bindExternalTypes(bound, options);
  if (options.imports !== undefined) bindImportedSurface(bound, options.imports);
  for (const node of program.body) bindNode(node, bound, root);
  return bound;
```
— `src/frontend/checker/binder.ts:317-328`

`provenTakes` is computed on line 323 and `bindNode` does not run until line 327. The
analysis therefore never sees a `Scope`, never resolves a name, and never asks what type
anything has. It is a fact about the *shape of the source*: which member calls appear under
which tests, in which order, inside which regions. That is also why it keys on name text —
there is no other identity available to it, which is the subject of this chapter's first
honesty item.

The consumer is one ternary at the tail of `inferCall` (`src/frontend/checker/infer.ts:399-411`),
quoted at `[Ch 1 § what-a-guard-proves]`:
`bound.provenTakes.has(node.callee as ASTNode) ? removeNullish(answered, bound.env) : answered`
at `:408-410`. That is the entire narrowing. There is no second reader anywhere in `src/`.

Two properties of that one line are worth stating on their own.

**The set holds nodes, not names.** The two `q.shift()` calls in `queue.tera` are the same
text, the same receiver, the same member, and the same inferred signature. Nothing about
either of them differs except which node it is. Membership has to be per call site or the
chapter's central example cannot be expressed
`[t: tests/frontend/checker/length-bounds.test.ts > "proves the first take and refuses the next"]`.

**The narrowing is `removeNullish` applied to the already-instantiated return type**, not a
different signature. `arrayMethodSignature` still returns `int | undefined`; generic
instantiation still runs; the union is stripped at the very last moment. So nothing upstream
has to know about the analysis, and a `shift()` on a `(int | null)[]` keeps its `null`
element type while losing the absence — `removeNullish` (`type-system.ts:482-484`) filters
both `null` and `undefined` out of the *union parts*, which for that array is
`int | null | undefined` becoming `int | null`.

> **Unenforced.** `provenTakes` is computed once over `program.body` and stored on
> `BoundProgram` as a `ReadonlySet<ASTNode>` keyed on object identity. Nothing prevents a
> later phase from replacing an AST node between binding and inference; a node that is
> *mutated* keeps its proof, a node that is *replaced* silently loses it, and the failure mode
> is a program that was accepted becoming refused with no explanation of what changed. The
> engine does run user-supplied AST passes (`runCompilerPasses("ast", …)`,
> `src/api/engine.ts:1209`), though they run after checking on the same road. No test in
> `tests/` covers a rewrite between binding and inference. Enforcing it would cost either a
> stable node identifier — `[Ch 44 § stamping-again]` is what the IR does for the
> same reason — or a re-run of the analysis after any tree edit.

## The sentence at the end

The refusal names two ways out, and the naming is conditional:

```ts
  remedyFor(actual: TypeName, expected: TypeName): string {
    const parts = unionParts(actual, this.bound.env);
    const present = removeNullish(actual, this.bound.env);
    if (parts.length < NAMES_BOTH || present === actual) return "";
    return this.adviceWhen(compatible(present, expected, this.bound.env));
  }

  operandRemedyFor(op: string, left: TypeName, right: TypeName): string {
    const present = removeNullish(left, this.bound.env);
    const other = removeNullish(right, this.bound.env);
    if (present === left && other === right) return "";
    return this.adviceWhen(binaryOperatorSemantics(op, present, other, this.bound.env).valid);
  }

  private adviceWhen(remedied: boolean): string {
    return remedied ? ` (${ABSENCE_ADVICE})` : "";
  }
```
— `src/frontend/checker/type-checker.ts:1256-1272`

`ABSENCE_ADVICE` (`:1402`) is the string
`the value may be absent: guard it before use, or spell a fallback with ??`, and it is
appended **only when removing the nullish part would have made the program legal**.
`remedyFor` asks that of an assignment: strip the absence, is the remainder `compatible`
with what was expected? `operandRemedyFor` asks it of a binary operator: strip the absence
from both sides, does `binaryOperatorSemantics` call the result valid? Only then is the
parenthetical added.

That is why `queue.tera`'s message reads the way it does. `int` and `int | undefined` have no
`+`; `int` and `int` do; so the advice is earned. A `string` where an `int` was wanted gets
the bare mismatch and no advice at all
`[t: tests/frontend/checker/type-checker.test.ts > "leaves a mismatch that absence does not explain without the advice"]`.
The two exits the sentence names are each pinned:
`[t: tests/frontend/checker/type-checker.test.ts > "stays quiet once a length test has ruled the absence out"]`
covers the guard, and
`[t: tests/frontend/checker/type-checker.test.ts > "stays quiet once a fallback spells what an empty collection answers"]`
covers `?? 0`. In a codebase with 26 comment lines, a diagnostic that only appears when it is
actionable is doing the work a comment would.

## What this analysis is not sound against

Two divergences reproduce on this tree today, and they are the same bug wearing two hats: the
analysis reasons about a *name*, and there are two ways for the array behind that name to
change without the name being involved.

> **Broken.** `Bounds` keys `counts` on name text (`subjectName`, so an identifier or a dotted
> name) and has no aliasing story at all. Measured on this tree, 2026-09-07: a function
> guarded by `if q.length >= 2:` that binds `alias = q`, calls `alias.shift()`, and then takes
> twice from `q` is accepted by `tera check` in silence with exit 0 — because `takes` recorded
> `alias` in `this.taken` (`length-bounds.ts:222`) and nothing connects the two names. The
> interpreter prints `NaN`; the compiled PE binary prints `0`. Fixing it costs either a
> may-alias analysis over the semantic tree, which the single-pass checker has no framework
> for, or the blunt version — forget every count whenever any array-typed name is assigned
> from another. The blunt version is a dozen lines and would refuse programs that are fine
> today.

> **Broken.** `TAKES_ONE_ELEMENT` and `ADDS_ONE_ELEMENT` (`src/core/indexing.ts:61-62`) name
> four members. `splice` is declared in the same array surface at
> `data/tera-language-spec.ts:6650`, changes a length, is fully lowered by the optimizer, and
> is in neither set. Measured on this tree, 2026-09-07: `if q.length > 0:` followed by
> `q.splice(0, 1)` and then `q.shift()` is accepted in silence, prints `NaN` from the
> interpreter and `0` from the binary. `[Ch 1 § two-answers-then-and-now]` carries the same
> item with its reproducer, because it is the book's live replacement for the closed
> `Binding.filled` divergence. Fixing it costs a `provenCount`-style rule for `splice` — the
> net change is `items.length - count` — plus a decision about a non-literal argument, which
> should almost certainly prove nothing.

> **Unfinished.** Beyond `splice`, `concat`, an assignment to `length`, a subscript store past
> the end, and every collection method in [Ch 60 § prelude-one-collections] change a length
> and are invisible to `Bounds`. Only the take-shaped ones are unsound; the add-shaped ones
> merely make the analysis pessimistic, because a missing refund only loses proofs.

> **Unenforced.** Nothing checks that `TAKES_ONE_ELEMENT ∪ ADDS_ONE_ELEMENT` is the complete
> set of length-changing array members, and the analysis's soundness rests entirely on that
> closure. The two constants are imported by exactly three files —
> `src/frontend/checker/length-bounds.ts:2`, `src/optimizing/passes/array-shapes.ts:67` and
> `src/optimizing/passes/class-member-lowering.ts:69` (used at `:296` and `:272`
> respectively) — and by no test at all: `tests/core/indexing.test.ts` imports only
> `normalizeIndex`, `provenCount` and `resolveSlice`. There is no `satisfies` constraint
> tying either set to the array surface in `data/tera-language-spec.ts`.

## What leaves

One field on `BoundProgram`, and one set of nodes in it.

`provenTakes: ReadonlySet<ASTNode>` (`src/frontend/checker/binder.ts:34`, computed at `:323`)
holds the **callee** nodes — the `q.shift` member expressions, not the calls — of every take
the analysis proved total. It is consumed by exactly one ternary, at
`src/frontend/checker/infer.ts:408-410`, which strips the `undefined` from that call's
already-instantiated return type. Nothing else in `src/` reads it. That is the entire
interface between two hundred and ninety lines of analysis and the rest of the engine.

What the set means for each tier is what the chapter's badge says. The interpreter and the
baseline compiler never consult it — they run the program and find out. The JIT and the
native compiler consume it indirectly: the diagnostics it suppresses are the ones that would
otherwise become the strict-mode throw of [Ch 16 § one-field-one-word], and the types it
narrows are the ones `declaredSignatureOf` carries into
`RegisterCompiledFunction.declaredSignature` for both compiling tiers.

The other half of what leaves is not a value but a table. `provenCount` and its `COMPLEMENT`
and `PROVEN_COUNT` maps live in `src/core/indexing.ts`, outside the front end, precisely so
that [Ch 26 § provencount-the-same-file-a-compile-time-question] can do the same arithmetic on an SSA
comparison instead of on syntax — `src/optimizing/passes/array-methods.ts:678-679` calls the
same function with a bound recovered from an `IR_CONSTANT`. The syntactic analysis proves
what it can before the graph exists; the graph-level one proves the rest afterwards; and the
fact that they agree by construction rather than by convention is why there is no second
spelling of "greater than zero" in the tree.

The `BoundProgram` itself continues to [Ch 14 § two-mechanisms-one-word], along with the
`Signature` per function that `signatureFromParams` (`binder.ts:87`) built with
`async: node.async` and `generator: node.generator` already on it. One caution, because it is
easy to assume otherwise: the effect analysis of the next chapter does **not** run on this
`BoundProgram`. `analyzeEffects` runs over the raw `ASTNode` tree, after checking, on a
different traversal (`src/api/engine.ts:1210`). The two analyses share a source file and
nothing else.

## Verify it yourself

```bash
# the cold open: the interpreter answers, the checker refuses
node dist/cli.js docs/example/queue.tera
node dist/cli.js check docs/example/queue.tera; echo "exit=$?"

# one changed operator, and the same two takes are legal
node dist/cli.js check -e 'q: int[] = [1,2,3,4]
if q.length >= 2:
  a: int = q.shift()
  b: int = q.shift()
  print(a + b)'; echo "exit=$?"

# KEPT_WHEN: an `and` you took proves; an `or` you took does not
node dist/cli.js check -e 'q: int[] = [1,2]
f = true
if q.length > 0 and f:
  a: int = q.shift()
  print(a)'; echo "exit=$?"
node dist/cli.js check -e 'q: int[] = [1,2]
f = true
if q.length > 0 or f:
  a: int = q.shift()
  print(a)'; echo "exit=$?"

# MIRRORED: the same guard written the other way round
node dist/cli.js check -e 'q: int[] = [1,2]
if 0 < q.length:
  a: int = q.shift()
  print(a)'; echo "exit=$?"

# literalCount: a variable bound proves nothing, a literal one does
node dist/cli.js check -e 'q: int[] = [1,2,3,4]
n: int = 1
if q.length >= n:
  a: int = q.shift()
  print(a)'; echo "exit=$?"

# the && gap in narrowScope, reported at the use
node dist/cli.js check -e 'class P:
  public constructor():
    this.n = 1
a: P | null = P()
b: P | null = P()
if a != null and b != null:
  print(a.n)'; echo "exit=$?"

# the transfer function in isolation (30 tests) and the operator table (20)
npx vitest run --project unit tests/frontend/checker/length-bounds.test.ts
npx vitest run --project unit tests/core/indexing.test.ts
```

The first prints `10`; the second reports
`6:18 Operator '+' cannot be applied to 'int' and 'int | undefined' …` and exits 1. The third
is silent. The fourth pair is silent then refused. The fifth is silent. The sixth is refused
with `Type 'int | undefined' is not assignable to 'int' (the value may be absent: …)` at
`4:12`. The seventh reports `Cannot access member 'n' on nullable type 'P | null'` at `7:9` —
the `&&` gap, landing on the operand the conjunction was supposed to prove.

The two `> **Broken.**` items need files that are deliberately not in the tree, for the reason
`[Ch 1 § two-answers-then-and-now]` gives: a program whose whole purpose is to produce two
answers cannot be pinned to one expected output. Save each with your editor — not with a
shell heredoc, which eats backslashes — somewhere outside the repository.

```
fn drain(q: int[]) -> int:
  if q.length >= 2:
    alias = q
    alias.shift()
    a: int = q.shift()
    b: int = q.shift()
    return a + b
  return 0

print(drain([1, 2]))
```

```bash
node dist/cli.js alias.tera                                          # NaN, exit 0
node dist/cli.js check alias.tera                                    # silent, exit 0
node dist/cli.js compile alias.tera -o alias.exe && ./alias.exe      # 0, exit 0
```

The `splice` reproducer is the eight lines in `[Ch 1 § verify-it-yourself]`, and behaves the
same way: `NaN` from the interpreter, `0` from the binary, silence from the checker.

## Tests that pin this

`tests/frontend/checker/length-bounds.test.ts` — 30 tests in five describes, calling
`provenTakes` directly and asserting which source lines end up in the proven set:

*`"what a take spends of a proven count"`* —
> `"proves the first take and refuses the next"` (the `queue.tera` shape, and the regression
> test for the deleted `Binding.filled` design) ·
> `"counts a put back towards the take that follows it"` ·
> `"never lets put backs alone prove a take"` ·
> `"leaves a take on another array out of the count"` ·
> `"counts both members that take one"` (`pop` and `shift`) ·
> `"counts a take that a larger expression encloses"` ·
> `"keeps the larger count when one test names the array twice"` ·
> `"keeps a count already proven when a weaker guard follows"` ·
> `"proves as many takes as the guard counted"`

*`"where the count starts"`* —
> `"starts the count over at the guard, forgetting earlier takes"` ·
> `"proves nothing about a take that came before the guard"` ·
> `"re-proves a count that a loop had made unknown"`

*`"a take a loop may repeat"`* —
> `"proves nothing about the take itself"` ·
> `"proves nothing about a take that follows a loop which took one"` ·
> `"leaves the count alone across a loop that only puts back"` ·
> `"counts a for loop the same way as a while loop"` ·
> `"proves nothing after a loop whose own test took an element"` ·
> `"proves a take under the loop's own count on every round"`

*`"takes on separate arms of a branch"`* —
> `"starts each arm from the same count"` ·
> `"carries the worst arm into what follows the branch"` ·
> `"keeps the count across a branch that takes nothing"` ·
> `"proves what the refuted guard leaves when every arm exits"`

*`"a take a scope of its own encloses"`* —
> `"proves nothing about a take inside a nested function"` ·
> `"does not let a put back inside a nested function repay a take"` ·
> `"does not let a put back inside a loop repay a take that follows"` ·
> `"forgets the count once a nested function may have taken from it"` ·
> `"sees a take inside a class member the same way"` ·
> `"counts a method's own guard against its own takes"` ·
> `"proves nothing about a take inside a lambda the count encloses"` ·
> `"does not let a put back inside a lambda repay a take"`

`tests/core/indexing.test.ts` > `"provenCount"` — the operator table, 7 of the file's 20
tests:

> `"counts one more than a bound the count must exceed"` ·
> `"counts the bound itself when the count may equal it"` ·
> `"counts the bound a count is equal to"` ·
> `"counts one only from a count that differs from zero"` ·
> `"reads a negated test as its complement"` ·
> `"counts nothing from a negated test that leaves the count at zero"` ·
> `"counts nothing from an operator it does not know"`

`tests/frontend/checker/type-checker.test.ts` >
`"taking one element after a guard that the array holds some"` — the diagnostics the analysis
produces or suppresses, 28 tests:

> `"takes the front of a queue a while loop guards"` ·
> `"takes the back of a stack a while loop guards"` ·
> `"takes one under a guard written the other way round"` ·
> `"takes one under a guard that asks for at least one"` ·
> `"takes one under a guard that asks for more than one"` ·
> `"takes one in the arm where an emptiness guard did not hold"` ·
> `"takes one under a guard that also checks something else"` ·
> `"takes one off a field the method guarded"` ·
> `"takes one under a guard that asks for an exact count"` ·
> `"takes one under an exact-count guard written the other way round"` ·
> `"takes one after a guard that throws unless the count is exact"` ·
> `"takes one after a guard that throws unless the count is some other exact one"` ·
> `"still refuses to take one after a guard that throws unless the array is empty"` ·
> `"still refuses to take one in the arm where an exact-count guard did not hold"` ·
> `"still refuses to take one after a guard that throws when the array holds some"` ·
> `"still refuses to take one with nothing guarding the array"` ·
> `"still refuses to take one when the guard counts another array"` ·
> `"still refuses to take one when the guard says the array is empty"` ·
> `"takes as many as the guard counted"` ·
> `"keeps the largest count when one test names the array twice"` ·
> `"counts a take back off the guard's count"` ·
> `"counts what a take put back"` ·
> `"counts takes on separate arms apart, not one after the other"` ·
> `"counts the worst arm against a take that follows the branch"` ·
> `"proves nothing about a take a nested loop repeats"` ·
> `"proves nothing about a take inside a function the guard encloses"` ·
> `"does not let a put back inside a nested function pay for another take"` ·
> `"says how to mend an operand a take may not have filled"`

`tests/frontend/checker/type-checker.test.ts` > `"nullable narrowing"` — the `narrowScope`
and `widens` half, 17 tests:

> `"reads a member after a guard that returns"` ·
> `"reads a member after a guard that throws"` ·
> `"reads a member after a guard that continues"` ·
> `"reads a member in the else branch of a null check"` ·
> `"reads a member in an else branch that no arm exits through"` ·
> `"hands the last arm of an else-if chain every earlier refutation"` ·
> `"carries narrowing through a run of guards"` ·
> `"narrows a nullable string the same way it narrows a class"` ·
> `"keeps narrowing for the statements after a guard at the top level"` ·
> `"lets an assignment widen a narrowed binding back to its declared type"` ·
> `"narrows a binding to what the assignment just gave it"` ·
> `"joins what the branches leave behind"` ·
> `"reads a member after a branch that assigns and one that returns"` ·
> `"still refuses a member the branches leave nullable"` ·
> `"still reports a member read when the guard does not exit"` ·
> `"still reports a member read inside the branch where the value is null"` ·
> `"leaves a loop condition alone, since a break can leave it true"`

`tests/frontend/checker/type-checker.test.ts` > `"advice on a value that may be absent"` —
the conditional advice, 5 tests:

> `"says how to answer for a take that a return type has no room for"` ·
> `"says how to answer for a take a declared binding has no room for"` ·
> `"stays quiet once a length test has ruled the absence out"` ·
> `"stays quiet once a fallback spells what an empty collection answers"` ·
> `"leaves a mismatch that absence does not explain without the advice"`

Not pinned:

- The aliasing unsoundness in the first `> **Broken.**` item: **[unpinned]**.
- The `splice` unsoundness in the second: **[unpinned]**. No test in the tree covers a
  length-changing member outside `TAKES_ONE_ELEMENT` and `ADDS_ONE_ELEMENT`.
- The exhaustiveness of those two sets over the array surface: **[unpinned]**, and nothing
  enforces it either.
- A rewrite of an AST node between binding and inference: **[unpinned]**.
