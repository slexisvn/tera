# 10. The lattice   ⟨— · — · J · N⟩

A type checker only ever answers two questions. *Does this value fit where that type was
asked for?* — and, when control flow rejoins after a branch, *what single type covers both
of these?* Everything else a checker does is bookkeeping around those two answers. In tera
they are two exported functions in one file, `compatible` and `leastUpperBound`, and they
are built out of the string comparisons `[Ch 9 § the-one-line-decision]` left behind.

Neither answer is what a textbook would predict. `compatible` is **structural**: two classes
that never mention each other are mutually assignable if their members line up, which is why
`[Ch 12 § new-idea-a-shape]` exists. It handles **recursive** types by assuming
the answer is yes and then trying to refute it, because the honest recursion does not
terminate. And it enforces **variance** — the rule that decides whether a `Promise<int>` may
stand in for a `Promise<float>` — even though the word *variance* appears nowhere in the
language, nowhere in the spec data, and nowhere a user could write it. The checker derives
it, per generic, by reading that generic's own method table and counting which side of the
arrow its type parameter lands on.

This is also the first chapter in this book that `stats.tera` cannot carry. The running
example touches exactly two rungs of the ladder below: the identity rung (`report(latency)`
passes a `Series` where `Series` was asked for, and the two strings are equal) and the
numeric rank (`total / this.values.length` on line 12 divides a `float` by an `int`, which
is legal only because `int` widens to `float`). Unions, tuples, recursive interfaces,
structural class comparison and generic variance are all out of its reach, and per
`docs/CONVENTIONS.md` rule 2 this chapter says so rather than inventing a ninth variation
file. The evidence here is one-line programs run through `tera check`, and the checker's own
test corpus — 113 cases in `tests/e2e/frontend/checker.test.ts` alone.

**What arrived.** From `[Ch 9 § what-leaves]`: canonical type text. Every type in the
program — the annotations the user wrote, the ones the parser normalized, the ones the
checker manufactured — is now a `TypeName`, which is a `string` that has been through
`cleanType`, so that two spellings of one type are one string. With it came the parsers that
take that text apart again on demand: `unionParts`, `arrayElementType`, `tupleTypes`,
`parseFunctionType`, `parseGenericType`, `typeLiteralShape` and `instantiateShapeForType`.
This chapter is the first consumer that does anything with them beyond storing them.

## A lattice

> **New idea. Partial order, join, meet, lattice.** A **partial order** is a set with a
> "≤" relation that is reflexive, transitive, and antisymmetric — but where two elements are
> allowed to be *incomparable*. Numbers are totally ordered: for any two, one is smaller.
> Types are not. `int` is not below `string`, and `string` is not below `int`; they simply
> do not compare. Draw the order as a graph with arrows pointing up from smaller to larger
> and you get a lattice diagram rather than a line.
>
> The **join** of two elements (written `a ⊔ b`, or "least upper bound") is the *smallest*
> element that is above both. The **meet** (`a ⊓ b`, "greatest lower bound") is the largest
> element below both. A **lattice** is a partial order in which every pair has both. If it
> also has a single element above everything (a **top**) and one below everything (a
> **bottom**), it is a *bounded* lattice.
>
> Compilers use lattices constantly, and for one reason: an analysis that merges facts by
> taking joins, over a lattice of finite height, is guaranteed to terminate. That guarantee
> is what makes dataflow analysis possible at all, and `[Ch 45 § a-snapshot-dataflow]` uses
> it for exactly that. Here the lattice is doing something simpler — it is the type system's
> notion of "fits".

In tera's checker the order is `compatible(a, b, env)`: read it as *`a` fits where `b` was
asked for*, so `compatible(a, b)` means `a ≤ b`. The join is `leastUpperBound(types, env)`.
Both live in `src/frontend/checker/type-system.ts`, and both are ordinary exported functions
with no infrastructure around them — no worklist, no iteration, no convergence check.

The order has a top and a bottom. `unknown` is the top: everything is assignable to it, and
nothing but `any` is assignable *from* it. `never` is the bottom: it is assignable to
everything, and only `Promise.reject` and an empty union produce one. `any` is neither — it
sits outside the order entirely, accepted in both directions, which is what makes it an
escape hatch rather than a type.

It is worth being blunt about the gap between the name of this chapter and the mathematics.
**tera's assignability order is not a complete lattice.** `leastUpperBound` returns
`TypeName | null`, and `null` means *there is no single name for this*. There is no meet at
all: intersection types spelled `&` are *checked* (`assignableUncached` line 812 asks that
every arm accept), but nothing in the tree ever *computes* the intersection of two types the
way `leastUpperBound` computes their union. And the glossary's `lattice` entry points at
`src/optimizing/types/lattice.ts`, a different structure in a different stage — the middle
end's `LatticeType` over abstract machine values. This chapter's order is over type *text*.
Two orders, two stages, one word; `docs/GLOSSARY.md` keeps them apart by file path, and so
does this book.

## The five answers before any structure is looked at

`compatible` does nothing but hand a fresh memo to `assignable`, which resolves aliases,
consults the memo, and calls the real function. That real function is a ladder of `if`s, and
the order of the rungs is the specification:

```ts
function assignableUncached(actual: TypeName, expected: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  if (actual === "error" || expected === "any" || actual === "any") return true;
  if (actual === expected) return true;
  if (actual === "never") return true;
  if (expected === "unknown") return true;
  if (actual === "unknown") return false;
  if (expected === "void") return actual === "undefined";
  if (expected === "Function") return actual === "Function" || parseFunctionType(actual) !== null;
  const expectedFn = parseFunctionType(expected);
  if (expectedFn) return functionAssignable(actual, expectedFn, env, memo);
  const actualUnion = splitTopLevel(actual, "|");
  if (actualUnion.length > 1) return actualUnion.every((part) => assignable(part.trim(), expected, env, memo));
  const expectedUnion = splitTopLevel(expected, "|");
  if (expectedUnion.length > 1) return expectedUnion.some((part) => assignable(actual, part.trim(), env, memo));
  const expectedIntersection = splitTopLevel(expected, "&");
  if (expectedIntersection.length > 1) return expectedIntersection.every((part) => assignable(actual, part.trim(), env, memo));
```
— `src/frontend/checker/type-system.ts:797-812`

Five of those rungs decide the answer before any structure is examined, and each exists for
a stated reason.

`actual === "error"` accepts. `error` is the type the checker assigns to an expression it
has already complained about. Accepting it everywhere stops a **cascade**: one bad
annotation should produce one diagnostic, not one per downstream use. This is the same
discipline `[Ch 16 § one-field-one-word]` depends on, because a compile that refuses on a
non-empty diagnostic array must not have that array inflated by consequences of its own
first entry.

`any` accepts in both directions. It is the deliberate hole in the type system, and it is
worth noticing how thoroughly this one line disables everything after it — an `any` on
either side means no union split, no variance, no structural comparison, and no diagnostic.
`[Ch 16 § the-honest-inventory-any-is-a-hole-with-32-doors]` counts where `any` enters a program that was compiled ahead of
time, because every one of those is a place the native backend must guess at.

`actual === expected` accepts. This is the payoff of `[Ch 9 § canonical-form-is-what-makes-equality-mean-anything]`: because
`cleanType` collapses every spelling of a type to one string, string equality is a *sound*
fast path for type identity, not merely a heuristic. `Array<float>`, `float [ ]` and
`float[]` all arrive here as the same eight characters. This is the rung `stats.tera` runs
on: `report(s: Series)` receives a value whose type is the string `Series`.

`never` is assignable to everything, and everything is assignable to `unknown` — the top and
the bottom. And then the asymmetry that makes `unknown` worth having: `actual === "unknown"`
returns **false** immediately. `unknown` accepts anything and gives nothing back. That is
the whole difference between it and `any`, and it is one line.

```
$ node dist/cli.js check -e 'x: int = 1
y: unknown = x
print(y)'
$ echo $?
0
$ node dist/cli.js check -e 'x: unknown = 1
y: int = x
print(y)'
[eval]:2:10: error: Type 'unknown' is not assignable to 'int'
$ echo $?
1
```

Then two special targets. `void` accepts only `undefined` — so a function declared to return
nothing cannot be assigned a value-producing one, but *can* be handed a callback that
returns `undefined`. And `Function` is the bare top of the function types: anything that
`parseFunctionType` can parse fits it, which is how a signature can ask for "some callable"
without naming its shape.

## Functions, and the direction that surprises people

If the expected type parses as a function, the whole comparison is delegated:

```ts
function functionAssignable(actual: TypeName, expectedFn: Signature, env: TypeEnv, memo: Map<string, boolean>): boolean {
  const actualFn = parseFunctionType(actual);
  if (!actualFn) return actual === "Function";
  if (actualFn.positional.length > expectedFn.positional.length) return false;
  for (let i = 0; i < actualFn.positional.length; i++) {
    const expectedParam = expectedFn.params.get(expectedFn.positional[i])!;
    const actualParam = actualFn.params.get(actualFn.positional[i])!;
    if (!assignable(expectedParam.type, actualParam.type, env, memo)) return false;
  }
  return assignable(actualFn.returns, expectedFn.returns, env, memo);
}
```
— `src/frontend/checker/type-system.ts:822-832`

Three things happen here, and the middle one is the one that trips people.

**Arity may be shorter, never longer.** A callback that ignores arguments it was offered is
fine; a callback that demands arguments nobody will pass is not. This is not a convenience —
it is the rule that makes `values.map(f)` work when `f` takes one parameter and `map` offers
two.

**The return is compared forwards**: `assignable(actualFn.returns, expectedFn.returns)`. If
you asked for something returning a `float`, a function returning an `int` will do, because
the value comes *out* toward you.

**The parameters are compared backwards.** Look at the argument order on line 829:
`assignable(expectedParam.type, actualParam.type)` — expected first, actual second, the
reverse of every other call in the file. That is deliberate, and it is called
contravariance.

> **New idea. Covariance and contravariance.** A type constructor is **covariant** in a
> position if a subtype there makes the whole thing a subtype — the ordinary direction.
> Function *returns* are covariant: `() -> int` fits where `() -> float` is wanted, because
> whatever comes back is a `float`. A position is **contravariant** if a subtype there makes
> the whole thing a *super*type — the direction flips. Function *parameters* are
> contravariant, and the reason is that you are on the receiving end of them. Promising to
> handle *every* `float` is a stronger promise than promising to handle only the `int`s. So
> a function that accepts `float` may be used where one accepting `int` was asked for, and
> not the other way round. A position that is both — because a value flows in and out
> through it — is **invariant**, and only an exact match will do.

`Array.map` on a `float[]` is manufactured by `arrayMethodSignature` as
`(float, int) -> U` with `U` a type parameter (`src/frontend/checker/infer.ts:676`). All
three rules are visible at once against that one expected signature:

```
$ node dist/cli.js check -e 'fn wide(x: float) -> float:
  return x
values: float[] = [1.0]
n: int = values.map(wide)
print(n)'
[eval]:4:10: error: Type 'float[]' is not assignable to 'int'
```

`wide` takes one parameter where two are offered — accepted, because the arity rule allows
shorter. The refusal is about `n: int`, and it names the answer: `map` produced `float[]`.
Now change nothing but the callback's parameter type:

```
$ node dist/cli.js check -e 'fn narrow(x: int) -> int:
  return x
values: float[] = [1.0]
n: int = values.map(narrow)
print(n)'
[eval]:4:21: error: Type '(int) -> int' is not assignable to parameter 'fn: (float, int) -> int'
```

A callback that only handles `int` cannot be given `float`s. The comparison that fails is
`assignable("float", "int")` — expected parameter into actual parameter, backwards — and the
column moves from 10 to 21 because the refusal is now about the argument, not the result.
And a callback demanding more than it will be given is refused on arity:

```
$ node dist/cli.js check -e 'fn three(a: float, b: int, c: float) -> float:
  return a
values: float[] = [1.0]
n: int = values.map(three)
print(n)'
[eval]:4:21: error: Type '(float, int, float) -> float' is not assignable to parameter 'fn: (float, int) -> float'
```

## Unions: forall on the left, exists on the right

After functions come the union clauses, and the *order* of those two clauses is load-bearing
for a diagnostic this book has already quoted.

The actual side is checked first (`assignableUncached:807-808`), with `every`: **for a union
to fit somewhere, all of its arms must fit.** Then the expected side (`:809-810`), with
`some`: **to fit into a union, a value need match only one arm.** Both are the obvious
reading of what a union means, but the sequencing matters. Consider the refusal from
`[Ch 1 § the-cold-open]`:

```
6:18 Operator '+' cannot be applied to 'int' and 'int | undefined' (the value may be absent: guard it before use, or spell a fallback with ??)
```

That comes from `binaryOperatorSemantics` asking `compatible("int | undefined", "float")`.
The actual-side clause fires first, splits into `int` and `undefined`, and requires *both* to
be assignable to `float`. `int` is, by the numeric rank. `undefined` is not. The whole answer
is false, and the diagnostic can therefore name the absence specifically rather than saying
"these types are different". If the clauses were reversed — if the expected side were tested
first — the expected type here is not a union, so nothing would change for this program; but
for a target that *is* a union, `int | undefined` into `int | string` would be decided by
"does the whole left string match some right arm", which it does not, and the useful arm-wise
report would be gone. `[Ch 13 § new-idea-refinement]` is entirely about removing the
`undefined` arm before this comparison happens.

Intersections are the third clause and the shallowest: `expectedIntersection.every`. An
`A & B` target requires the actual to satisfy `A` and to satisfy `B`, separately. There is no
clause for an intersection on the *actual* side, and no operation anywhere in the tree that
constructs one. tera has a join and no meet.

## Tuples, arrays, and the bare Array

Below the unions, the ladder stops short-circuiting and starts trying structures in a fixed
order — tuple, array, numeric, bool, nominal, object — returning `true` on the first that
succeeds and `false` only when all six have declined.

`tupleAssignable` requires the expected type to be a tuple, then demands the same length and
compares pointwise. A tuple is a fixed-length heterogeneous list, spelled `[int, string]`,
and its length is part of its identity.

`arrayAssignable` is more interesting, because it has to handle the flow between the two:

```ts
function arrayAssignable(actual: TypeName, expected: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  if (expected === "Array") return actual === "Array" || !!arrayElementType(actual) || isTupleType(actual);
  const expectedElement = arrayElementType(expected);
  if (!expectedElement) return false;
  const actualElement = arrayElementType(actual);
  if (actualElement) return assignable(actualElement, expectedElement, env, memo);
  if (isTupleType(actual)) return tupleTypes(actual).every((item) => assignable(item, expectedElement, env, memo));
  return actual === "Array";
}
```
— `src/frontend/checker/type-system.ts:845-853`

Arrays are compared **element-wise and covariantly**: `int[]` fits `float[]` because `int`
fits `float`. That is unsound in the general case — the classic counterexample is writing a
`float` into an array someone else reads as `int[]` — and tera accepts it anyway, in company
with most mainstream languages. Nothing in the tree enforces the sound rule.

> **Unenforced.** Array element assignability at
> `src/frontend/checker/type-system.ts:850` is covariant, so `int[]` is accepted where
> `float[]` is expected even though arrays are mutable and a store through the wider alias
> would break the narrower one. Making it invariant would require a read-only array spelling
> the language does not have; making it sound without one would refuse programs like
> `values.map` chains that the test corpus expects to pass.

A tuple flows into an array if every item fits the element type — line 851, and this is why
`[1, 2]` typed `[int, int]` can be assigned to an `int[]`. The reverse does not hold: an
array has no length, and `tupleAssignable` will not accept one.

Finally, the bare name `Array` is the top of the array types, and it **forgets its element**:

```
$ node dist/cli.js check -e 'x: int[] = [1, 2]
y: Array = x
z: int = y
print(z)'
[eval]:3:10: error: Type 'Array' is not assignable to 'int'
```

Once a value is `Array`, no element type can be recovered from it. The same forgetting
happens at `tupleAccessType` (`type-system.ts:577`), where slicing a tuple whose items have
no common bound answers `"Array"` rather than a union of anything.

## Numbers are a rank, not a lattice

The numeric rule is five lines and one two-entry map:

```ts
const NUMERIC_RANK = new Map<TypeName, number>([["int", 0], ["float", 1]]);
```
— `src/frontend/checker/type-system.ts:96`

```ts
function numericAssignable(actual: TypeName, expected: TypeName): boolean {
  const actualRank = NUMERIC_RANK.get(actual);
  const expectedRank = NUMERIC_RANK.get(expected);
  return actualRank !== undefined && expectedRank !== undefined && actualRank <= expectedRank;
}
```
— `src/frontend/checker/type-system.ts:855-859`

Two members, one direction. `int` widens to `float`; `float` never narrows to `int`. There
is no ranking of bit widths, no `i8`/`i16`/`i32` ladder, and no unsigned family — the
scalar zoo appears later, in the backend's `AotScalar`
(`[Ch 9 § consumer-two-the-middle-ends-lattice]`), and does not exist at this layer.

```
$ node dist/cli.js check -e 'n: int = 1
f: float = n
back: int = f
print(back)'
[eval]:3:13: error: Type 'float' is not assignable to 'int'
```

Line 2 is silent; line 3 is refused. That is the whole numeric type system
`[t: tests/frontend/type-accepts.test.ts > "accepts a widening but not the narrowing back"]`.

`boolAssignable` sits directly beneath it and exists for a duller reason: it accepts `bool`
and `boolean` in all four combinations. `cleanType` is supposed to rewrite `boolean` to
`bool` — `BOOLEAN_ALIASES` at `type-system.ts:95` is exactly that rewrite — but not every
type string in the engine has been through `cleanType` on every path, so the comparison
tolerates both spellings. It is a canonicalization backstop wearing the shape of a typing
rule.

**The operator layer is built on the same call.** `src/frontend/checker/operator-types.ts`
is eighty lines and holds five operator sets — `EQUALITY_OPERATORS`, `ORDERED_OPERATORS`,
`NUMERIC_OPERATORS`, `BITWISE_OPERATORS`, `TENSOR_OPERATORS` — and one entry point,
`binaryOperatorSemantics(op, left, right, env)`, which answers a result type and a validity
flag. It decides nothing itself. Ordered comparison is legal when both sides are
`compatible` with `float` or both with `string`. Equality is legal when any arm of the left
union is `compatible` with any arm of the right, in either direction, or when either side is
nullish. Arithmetic is legal when both sides are `compatible` with `float`, and its result
is `int` only when both operands are literally `int` **and the operator is not `/`**.

That last clause is the rule `stats.tera` runs into on line 12:

```
$ node dist/cli.js check -e 'a: int = 1
b: int = 2
c: int = a / b
print(c)'
[eval]:3:10: error: Type 'float' is not assignable to 'int'
```

Integer division does not exist in this language. `total / this.values.length` is a `float`
divided by an `int`, both `compatible` with `float`, so the division is legal and answers
`float`, which is what `mean()` is declared to return. And the ordered and equality operators
are where a mismatch surfaces as an operator diagnostic rather than an assignment one:

```
$ node dist/cli.js check -e 'x: int = 1
y: string = "a"
print(x < y)'
[eval]:3:11: error: Operator '<' cannot be applied to 'int' and 'string'
```

## The nominal walk, and what it is for

Only now, four structural rungs deep, does the checker consider what a type is *named*.

```ts
function nominalAssignable(actual: TypeName, expected: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  const expectedGeneric = parseGenericType(expected);
  const expectedBase = expectedGeneric?.name ?? baseTypeName(expected);
  const actualGeneric = parseGenericType(actual);
  let currentBase: string | null = actualGeneric?.name ?? baseTypeName(actual);
  let currentArgs = actualGeneric?.args ?? [];
  const seen = new Set<TypeName>();
  while (currentBase && !seen.has(currentBase)) {
    if (currentBase === expectedBase) return genericArgsAssignable(currentBase, currentArgs, expectedGeneric?.args ?? [], env, memo);
    seen.add(currentBase);
    const family = nominalFamily(currentBase, env);
    currentBase = family ? baseTypeName(family) : null;
    currentArgs = [];
  }
  return false;
}
```
— `src/frontend/checker/type-system.ts:998-1013`

Strip the generic arguments off both sides, then walk the actual type's ancestry upward
looking for the expected base name. If it is found, the *arguments* are compared through
`genericArgsAssignable`, which is where variance lives. The `seen` set makes a cyclic
`extends` chain terminate rather than hang.

The ancestry itself is a single map, `env.nominalFamilies`, and it is written in exactly two
places in the whole engine:

- `src/frontend/checker/binder.ts:244` — `if (node.parent) bound.env.nominalFamilies.set(node.name, node.parent);`, the `Class` branch, recording an `extends`.
- `src/frontend/checker/binder.ts:207` — the `Model` branch, which files every model under `"Module"`.

Everything else comes from `BUILTIN_FAMILIES` (`type-system.ts:119`), which starts with one
static entry — `IndexTensor` under `Tensor` — and is then filled at module load from the
`kind` field of each builtin spec, plus two hand-written special cases at `:299-300`
(`Sequential` is a `Module`; anything whose name ends in `Dataset` and is not `Dataset`
itself is a `Dataset`). So lineage exists for user classes that wrote `extends`, for models,
and for spec types with a declared kind. It exists nowhere else — and in particular, an
`interface` that a class `implements` produces no lineage at all. That relationship is
decided one rung further down, structurally
`[t: tests/e2e/frontend/checker.test.ts > "treats an implemented class as assignable to the interface"]`.

Two limits in this walk are worth naming as they stand.

> **Unfinished.** `genericArgsAssignable` (`src/frontend/checker/type-system.ts:981-982`)
> returns `true` immediately when either argument list is empty, and otherwise compares only
> `Math.min(actualArgs.length, expectedArgs.length)` positions. A bare `Promise` is therefore
> assignable to `Promise<int>` *and* `Promise<int>` to a bare `Promise` — both directions,
> verified by running each through `tera check`, exit 0 — while `Promise<string>` into
> `Promise<int>` is correctly refused. Cost of finishing: deciding what a missing type
> argument means. Treating it as `unknown` would refuse existing programs; treating it as
> `any` is what happens today, implicitly, by skipping the comparison.

> **Unfinished.** `nominalAssignable` clears `currentArgs = []` on every step up the lineage
> (`type-system.ts:1011`), so a parent's type arguments are never substituted through an
> `extends`. A class extending a generic parent loses that parent's argument at the first
> hop; the comparison then falls into the empty-list case above and accepts. Cost of
> finishing: threading a substitution map through the walk, which needs the parent clause to
> record its arguments — and `binder.ts:244` stores the parent as a bare name.

## And then structure decides

`objectAssignable` is the last rung, and the one that gives this chapter its consequence.

```ts
  if (!expectedShape) return false;
  if (!actualShape) return false;
  for (const [name, expectedField] of expectedShape.fields) {
    const actualField = actualShape.fields.get(name);
    if (!actualField) {
      if (!expectedField.optional) return false;
      continue;
    }
    if (actualField.optional && !expectedField.optional) return false;
    if (!assignable(actualField.type, expectedField.type, env, memo)) return false;
  }
```
— `src/frontend/checker/type-system.ts:1019-1029`

Both sides are turned into an `ObjectShape` by `instantiateShapeForType`, which is where a
class name, an interface name, a generic instantiation and an inline `{ a: int }` literal all
converge on one representation. Then: every **required** field of the expected shape must
exist in the actual with an assignable type; an **optional** actual field cannot fill a
required expected slot; extra fields in the actual are ignored. Index signatures get a second
loop (`:1030-1038`) which checks the actual's own indexers *and* every excess field of the
actual against the expected indexer's value type — so a shape with an index signature
constrains the fields the first loop did not look at.

Nothing here consults a name. That is the point, and the consequence is immediate:

```
$ node dist/cli.js check -e 'class A:
  public constructor():
    this.n = 1
class B:
  public constructor():
    this.n = 2
a: A = B()
print(a)'
$ echo $?
0
```

`A` and `B` were declared separately, share no ancestor, and never mention each other. They
are mutually assignable because they have the same member. A tera class is a shape, not a
name, and `[Ch 12 § new-idea-a-shape]` spends a chapter on what that costs the
backend — a compiler that assigns structurally cannot build a dispatch cone out of names,
which is why `[Ch 57 § structural-not-nominal]` builds one out of shapes instead.

## Why the obvious design fails: recursion

Here is the comparison a first implementation reaches for, and the program that kills it.

```
interface Node:
  next: Node | null
interface Link:
  next: Link | null
```

Ask whether a `Node` fits where a `Link` is wanted. The naive `objectAssignable` compares the
`next` fields: is `Node | null` assignable to `Link | null`? The union clauses split, and the
question becomes whether `Node` is assignable to `Link` — which is the question we started
with. There is no base case. The recursion does not terminate, and no amount of care in the
field loop fixes it, because the loop is not where the problem is: the *question* is
circular.

The fix is nine lines up the file, in the wrapper:

```ts
function assignable(actualRaw: TypeName, expectedRaw: TypeName, env: TypeEnv, memo: Map<string, boolean>): boolean {
  const actual = resolveType(actualRaw, env);
  const expected = resolveType(expectedRaw, env);
  const key = `${actual}\u0000${expected}`;
  const previous = memo.get(key);
  if (previous !== undefined) return previous;
  memo.set(key, true);
  const result = assignableUncached(actual, expected, env, memo);
  memo.set(key, result);
  return result;
}
```
— `src/frontend/checker/type-system.ts:785-795`

Line 791 is the whole trick. **Before** calling the real comparison, write `true` into the
memo for the question being asked. The recursive re-entry finds that `true` and returns
immediately. When the real answer comes back, line 793 overwrites the assumption with it.
The `\u0000` separator is there because no type text can contain a NUL byte, so no
pair of types can forge a key belonging to a different pair. A space would not have done:
canonical type text is full of spaces.

> **New idea. Fixpoint, and why assuming the answer is legitimate.** A **fixpoint** of a
> function is an input it maps to itself: `f(x) = x`. An analysis defined by a recursive
> equation usually has several, and which one you compute is a choice. Start from "nothing
> is true" and add facts until nothing changes and you get the **least** fixpoint: a fact
> survives only if some finite chain of reasoning *proves* it. Start from "everything is
> true" and remove facts until nothing changes and you get the **greatest** fixpoint: a fact
> survives unless some finite chain of reasoning *refutes* it. The second style is called
> **coinduction**, and it is the right one for questions about infinite or circular
> structures, where "I never finished proving it" and "it is false" are different things.
>
> `memo.set(key, true)` before recursing is a greatest-fixpoint seed. The claim it encodes
> is: *`Node` fits `Link` unless some finite path through the two shapes shows a field where
> it does not*. Any real mismatch — a missing field, a wrong scalar type, a field that is
> optional on one side and required on the other — is reached in finitely many steps and
> flips the answer to `false`, which line 793 then writes over the seed. Only a comparison
> that recurses forever without ever disagreeing keeps the assumption, and for that
> comparison "yes" is the correct answer.

```
$ node dist/cli.js check -e 'interface Node:
  next: Node | null
interface Link:
  next: Link | null
fn make() -> Node:
  return { next: null }
a: Link = make()
print(a)'
$ echo $?
0
```

Terminates, and accepts — two recursive interfaces the user never related are recognized as
the same shape.

The soundness of the seed depends on one thing: **the assumption must not outlive the
question that made it.** That is why `compatible` (`:781-783`) allocates `new Map()` on
every call rather than sharing a module-level cache. A memo carried across unrelated queries
would let a `true` written on behalf of one comparison satisfy another that had never earned
it. `leastUpperBound` is stricter still — it builds a fresh `Map` for each of its two
directional probes (`:467` and `:468`).

> **Unenforced.** The memo key is built from `resolveType(actualRaw, env)`, and `resolveType`
> carries a `seen` set that returns the *unresolved* name when it detects an alias cycle
> (`src/frontend/checker/type-system.ts:353-355`). Two distinct cyclic aliases that bottom
> out on the same name therefore produce the same memo key inside one `compatible` call, and
> the assumption written for one is read by the other. Nothing detects it. Cost of finishing:
> keying the memo on resolution *identity* rather than resolved text, which means giving
> aliases identities — and `[Ch 9 § the-one-line-decision]` is the decision not to.

## The join, and the two fallbacks

The other exported answer is the join. It is a left fold with three cases per step:

```ts
export function leastUpperBound(types: TypeName[], env: TypeEnv): TypeName | null {
  const items = types.map((type) => cleanType(type)).filter(Boolean);
  if (!items.length) return null;
  let current = items[0];
  for (let i = 1; i < items.length; i++) {
    const next = items[i];
    if (assignable(next, current, env, new Map())) continue;
    if (assignable(current, next, env, new Map())) {
      current = next;
      continue;
    }
    const nominal = commonNominalAncestor(current, next, env);
    if (nominal) {
      current = nominal;
      continue;
    }
    return null;
  }
  return current;
}
```
— `src/frontend/checker/type-system.ts:461-480`

If one side already subsumes the other, keep the wider one. Otherwise ask
`commonNominalAncestor`, which builds both lineages with `nominalLineage` — the same upward
walk `nominalAssignable` uses — and takes the first name they share. Otherwise return `null`.

This is not a true join. It is order-dependent (it folds left, so `[A, B, C]` and `[C, B, A]`
can differ when the middle step's answer is not unique), and it has no answer at all for
incomparable types. The `null` is honest about that, and every caller has to decide what to
do with it.

```
$ node dist/cli.js check -e 'class Shape:
  public constructor(name: string):
    this.name = name
class Circle extends Shape:
  public constructor(r: float):
    super(name="circle")
    this.r = r
class Rectangle extends Shape:
  public constructor(w: float, h: float):
    super(name="rectangle")
    this.w = w
    this.h = h
shapes = [Circle(2.0), Rectangle(3.0, 4.0)]
n: int = shapes
print(n)'
[eval]:14:10: error: Type 'Shape[]' is not assignable to 'int'
```

The refusal is the report. `Circle` and `Rectangle` are incomparable structurally — each has
a field the other lacks — so both `assignable` probes fail, `commonNominalAncestor` walks
`Circle → Shape` and `Rectangle → Shape`, finds `Shape`, and the array literal answers
`Shape[]`. That is the join doing the only work in this chapter that a user can feel without
writing an annotation, and it is pinned by
`[t: tests/e2e/frontend/checker.test.ts > "uses nominal least-upper-bound for arrays of subclass instances"]`.

**The fallback is not in this function.** `leastUpperBound` returns `null` and stops; what to
do about it is decided at each call site, and there are seven, with three different policies.

Five spell `leastUpperBound(pool, env) ?? unionType(pool)` — fall back to a bare union.
Those are `memberReturnType` (`type-checker.ts:375`), `fillOpenElements` (`:471`),
`widenedField` (`:479`), `inferReturnType` (`:490`) and `widenType` (`:1354`). `widenType` is
the one a reader meets first: it is what merges the types a variable holds on two sides of a
branch, so `held = null` followed by a conditional `held = Box(3)` produces `Box | null`
rather than an error
`[t: tests/frontend/checker/type-checker.test.ts > "joins what the branches leave behind"]`.

The sixth is `inferArray` (`src/frontend/checker/infer.ts:149`), and it does **not** fall
back to a union. It falls back to a **tuple**:

```
$ node dist/cli.js check -e 'xs = [1, 2.5]
n: int = xs
print(n)'
[eval]:2:10: error: Type 'float[]' is not assignable to 'int'
$ node dist/cli.js check -e 'xs = [1, "a"]
n: int = xs
print(n)'
[eval]:2:10: error: Type '[int, string]' is not assignable to 'int'
```

`[1, 2.5]` has a join — `float`, by the numeric rank — so it is an array. `[1, "a"]` does
not, so it stays a fixed-length tuple that remembers each position separately, which is
strictly more information than `(int | string)[]` would carry
`[t: tests/e2e/frontend/checker.test.ts > "keeps heterogeneous array literals as tuples and context-checks tuple targets"]`.
The seventh, `tupleAccessType` (`type-system.ts:577`), falls back to the bare `Array` — it is
slicing, so it cannot keep positions, and it has no union to offer either.

## The set piece: variance nobody wrote down

Return to `genericArgsAssignable`, the function `nominalAssignable` calls once the base names
match. Its first line asks `constructorVariance(owner)` for an array of `"co" | "contra" |
"inv" | "bi"`, one per type parameter, and then compares each argument in the direction that
answer names — forwards for `co`, backwards for `contra`, both for `inv`, either for `bi`,
and `inv` as the default when the array is short (`type-system.ts:985`).

Now search the tree for where a user, or the language spec, or a builtin declaration says
that `Promise<T>` is covariant. There is nothing. `data/tera-language-spec.ts` has no
variance field, tera's grammar has no `out T` or `in T`, and `PSEUDO_TYPE_PARAMS`
(`type-system.ts:105`) records only the *names* of the parameters. The answer is computed,
and the input it is computed from is the generic's own method table.

```ts
function inferParamVariance(owner: string, param: string): Variance {
  let positive = false;
  let negative = false;
  const record = (polarity: Polarity): void => {
    if (polarity === 1) positive = true;
    else negative = true;
  };
  for (const method of METHOD_SPECS.get(owner)?.values() ?? []) {
    if (method.typeParams?.includes(param)) continue;
    collectParamPolarity(cleanType(method.returns ?? "any"), 1, owner, param, record);
    for (const methodParam of method.params ?? []) {
      collectParamPolarity(cleanType(methodParam.type ?? "any"), -1, owner, param, record);
    }
  }
  if (positive && negative) return "inv";
  if (positive) return "co";
  if (negative) return "contra";
  return "bi";
}
```
— `src/frontend/checker/type-system.ts:918-936`

Every method's **return type is visited at polarity `+1`** and every method's **parameter
types at `-1`**, because that is where values flow out of and into the object. A method's own
type parameters are skipped (line 926), so `then<U>` does not confuse `U` with `T`. Two
booleans accumulate. Both set means the parameter appears on both sides: invariant. Only
positive: covariant. Only negative: contravariant. Neither — the parameter is declared and
never mentioned — is `"bi"`, bivariant, and `genericArgsAssignable` treats that as "either
direction will do".

The recursion that visits a type is `collectParamPolarity`, and it is a small structural
walk with one flip in it:

- a union or intersection distributes the current polarity to every arm;
- a **function type** visits its return at the current polarity and each of its **parameters
  at the flipped polarity** (`:950`) — this is the same contravariance rule as
  `functionAssignable`, appearing a second time because polarity is what that rule *is*;
- an array visits its element, a tuple visits each item, both unchanged;
- a **generic** visits each argument through *that other generic's* variance
  (`:962-971`), so polarity composes across nesting;
- an object literal visits each field type and each indexer's value type;
- and when the walk finally reaches a bare name equal to the parameter, it records
  (`:977`).

Work `Promise<T>` by hand. Its three methods are declared at
`data/tera-language-spec.ts:4916-4918`:

| method | position | text | how `T` is reached | polarity |
| --- | --- | --- | --- | --- |
| `then<U>` | param | `(T) -> U` | function at `-1`, parameter flips | `+1` |
| `catch<U>` | return | `Promise<T \| U>` | own generic, `co`; union arm | `+1` |
| `finally` | return | `Promise<T>` | own generic, `co` | `+1` |

Positive only. `Promise<T>` is **covariant**, and nobody wrote that down.

Now `ReactiveSignal<T>`, whose six methods are at `data/tera-language-spec.ts:245-250`:

| method | position | text | polarity for `T` |
| --- | --- | --- | --- |
| `value` (getter) | return | `T` | `+1` |
| `peek` | return | `T` | `+1` |
| `set` | param | `T` | `-1` |
| `set` | return | `ReactiveSignal<T>` | `+1` |
| `update` | param | `(T) -> T` | return arm `-1`, param arm `+1` |
| `subscribe` | param | `(T) -> void` | param arm `+1` |

Positive **and** negative. `ReactiveSignal<T>` is **invariant** — because it has a setter,
and a setter is what makes a container invariant. The checker worked that out from the same
table a user reads as documentation.

## Breaking the self-reference

There is a problem hiding in that table. `ReactiveSignal.set` returns `ReactiveSignal<T>`.
Computing the variance of `ReactiveSignal` requires visiting `ReactiveSignal<T>`, which under
the generic rule requires the variance of `ReactiveSignal`. That is the same circularity the
recursive-interface comparison had, and it gets the same shape of answer:

```ts
  VARIANCE_CACHE.set(owner, params.map(() => "co"));
  const result = params.map((param) => inferParamVariance(owner, param));
  VARIANCE_CACHE.set(owner, result);
```
— `src/frontend/checker/type-system.ts:912-914`

Seed the cache with an assumption, compute, overwrite. Same greatest-fixpoint move as the
assignability memo, one iteration deep, with no convergence check — the computed result is
written once and never recomputed.

There is a second guard for the direct case, inside the walk:

```ts
    const variances = generic.name === owner ? null : constructorVariance(generic.name);
```
— `src/frontend/checker/type-system.ts:964`

When the generic being visited *is* the owner, the recursive call is skipped entirely and
`polaritiesUnderVariance(variances?.[i] ?? "co", polarity)` uses `"co"` — so
`ReactiveSignal<T>` in return position contributes `T` at `+1` without re-entering. That is
belt and braces: the seed would have produced the same answer.

The seed is `"co"`, not `"bi"`, and that biases the result. `"co"` under
`polaritiesUnderVariance` yields the polarity unchanged; `"bi"` yields the empty list and
records nothing. Seeding `"co"` therefore *adds* a positive observation for any occurrence
reached through the owner's own name, where seeding `"bi"` would have added none. For
`ReactiveSignal` this changes nothing — `value` and `peek` already made it positive. For a
hypothetical generic whose type parameter appears *only* inside its own constructor, the
seeded `co` is the answer, and no fixpoint iteration ever revisits it.

> **Unenforced.** `constructorVariance` caches per owner name in a module-level
> `VARIANCE_CACHE` (`src/frontend/checker/type-system.ts:891`), writes a `"co"` seed before
> recursing (`:912`), and never invalidates or re-runs. Nothing asserts that the result is a
> fixpoint of `inferParamVariance`, and for a type parameter reachable only through its own
> constructor the seed *is* the published answer. In practice it cannot go stale:
> `PSEUDO_TYPE_PARAMS` and `METHOD_SPECS` are built once at module load from
> `data/tera-language-spec.ts` and are never mutated afterwards. Cost of finishing: iterating
> `inferParamVariance` to convergence and asserting the second pass agrees with the first —
> a few lines, on a table with a few dozen entries.

## The answers it produces, and how to see them

Three generics, one widening, three different outcomes. `int` to `float` is the same step in
all three; the only thing that changes is whose method table is consulted.

```
$ node dist/cli.js check -e 'p: Promise<float> = Promise.resolve(1)
print(p)'
$ echo $?
0
$ node dist/cli.js check -e 'c: ReactiveComputed<float> = computed(() => 1)
print(c)'
$ echo $?
0
$ node dist/cli.js check -e 's: ReactiveSignal<float> = signal(1)
print(s)'
[eval]:1:28: error: Type 'ReactiveSignal<int>' is not assignable to 'ReactiveSignal<float>'
$ echo $?
1
```

`ReactiveComputed<T>` is the control that makes the point sharp. It is the *same shape of
thing* as `ReactiveSignal<T>` — a reactive cell holding a `T` — declared two lines further
down the same spec file. Its methods are `value`, `peek`, `subscribe` and `dispose`
(`data/tera-language-spec.ts:254-257`). `value` and `peek` return `T`, positive. `subscribe`
takes `(T) -> void`, whose parameter flips a `-1` to `+1`, positive. There is no setter, so
nothing is ever negative, and `ReactiveComputed<T>` comes out **covariant**. It accepts the
widening its sibling refuses, and the entire difference is that one of them can be written
to.

The covariant answers are checkable in the other direction too — a covariant container must
refuse *narrowing*:

```
$ node dist/cli.js check -e 'p: Promise<int> = Promise.resolve(1.5)
print(p)'
[eval]:1:19: error: Type 'Promise<float>' is not assignable to 'Promise<int>'
$ node dist/cli.js check -e 'c: ReactiveComputed<int> = computed(() => 1.5)
print(c)'
[eval]:1:28: error: Type 'ReactiveComputed<float>' is not assignable to 'ReactiveComputed<int>'
```

Promise's covariance is pinned
`[t: tests/e2e/frontend/checker.test.ts > "respects generic variance when comparing Promise<T> (covariant)"]`,
including the argument-position form where an `async fn` returning `int` is passed to a
parameter declared `Promise<string>`. The `ReactiveSignal<T>` invariance result is
**[unpinned]** — `grep -rn ReactiveSignal tests/` finds nine hits, all in
`tests/e2e/reactive/syntax.test.ts` and `tests/e2e/api/engine-plugins.test.ts`, and none of
them compares two instantiations. The two commands above are, today, the only check that the
polarity walk produces `inv` for it.

## What leaves

Three answers, and one of them is new to the reader.

`compatible(actual, expected, env)` — the order. A fresh memo per call, a ladder of
seventeen tests, structural at the bottom, coinductive on cycles. `[Ch 11 § where-a-context-comes-from]`
uses it to decide whether an inferred expression fits the type its context asked for, and
`[Ch 16 § one-field-one-word]` turns a `false` from it into a refused native compile.

`leastUpperBound(types, env)` — the join, returning `TypeName | null`, with the fallback
policy left to each of its seven callers. `[Ch 11 § what-that-costs]` shows it giving an
unannotated function a return type — in source order, which is the cost — and
`[Ch 12 § building-a-class-out-of-nothing]` uses it to widen a field that `this.x = ...`
assigns more than once.

`constructorVariance(owner)` — the derived direction for each type parameter of each generic,
computed once at first use from the spec's own method tables and cached forever. It is
consumed only by `genericArgsAssignable`, and therefore only reachable through
`nominalAssignable`, but it is the reason two structurally identical reactive cells answer
differently.

Also leaving, and easy to miss: the vocabulary. **Partial order**, **join**, **meet**,
**lattice**, **fixpoint**, **coinduction**, **covariant**, **contravariant**, **invariant**.
Four later parts of this book use all of them —
`[Ch 33 § the-lattice]` for the four-state feedback lattice,
`[Ch 48 § flow-sensitivity-and-the-price-of-it]` for the middle end's abstract types,
`[Ch 23 § elements-kinds-six-points-and-a-one-way-join]` for the array-storage lattice that only ever widens, and
`[Ch 45 § a-snapshot-dataflow]` for the pass that iterates a transfer function to a fixpoint over
a control-flow graph. This chapter is where each of those words is defined; none of them is
re-taught.

`[Ch 11 § two-directions]` picks up `compatible` and `leastUpperBound` and asks the question
they cannot answer on their own: given an expression with no annotation anywhere near it,
what type does it have?

## Verify it yourself

```bash
# the top of the order: unknown accepts everything and gives nothing back
node dist/cli.js check -e 'x: int = 1
y: unknown = x
print(y)'
node dist/cli.js check -e 'x: unknown = 1
y: int = x
print(y)'

# the numeric rank: one direction, two members
node dist/cli.js check -e 'n: int = 1
f: float = n
back: int = f
print(back)'

# a callback's parameters are compared backwards; (int) -> int cannot take a float
node dist/cli.js check -e 'fn narrow(x: int) -> int:
  return x
values: float[] = [1.0]
n: int = values.map(narrow)
print(n)'

# assignability is structural: two unrelated classes with one matching member
node dist/cli.js check -e 'class A:
  public constructor():
    this.n = 1
class B:
  public constructor():
    this.n = 2
a: A = B()
print(a)'

# two mutually recursive interfaces terminate, and agree
node dist/cli.js check -e 'interface Node:
  next: Node | null
interface Link:
  next: Link | null
fn make() -> Node:
  return { next: null }
a: Link = make()
print(a)'

# the join: two subclasses fold to their common ancestor, and the error reports it
node dist/cli.js check -e 'class Shape:
  public constructor(name: string):
    this.name = name
class Circle extends Shape:
  public constructor(r: float):
    super(name="circle")
    this.r = r
class Rectangle extends Shape:
  public constructor(w: float, h: float):
    super(name="rectangle")
    this.w = w
    this.h = h
shapes = [Circle(2.0), Rectangle(3.0, 4.0)]
n: int = shapes
print(n)'

# no join, so the array literal stays a tuple
node dist/cli.js check -e 'xs = [1, "a"]
n: int = xs
print(n)'

# variance nobody declared: same int->float widening, three generics, two answers
node dist/cli.js check -e 'p: Promise<float> = Promise.resolve(1)
print(p)'
node dist/cli.js check -e 'c: ReactiveComputed<float> = computed(() => 1)
print(c)'
node dist/cli.js check -e 's: ReactiveSignal<float> = signal(1)
print(s)'

npx vitest run --project unit tests/frontend/checker/type-system.test.ts tests/frontend/type-accepts.test.ts
npx vitest run --project e2e tests/e2e/frontend/checker.test.ts
```

The first eight blocks were run to produce the output quoted above; the last two pass with
21 and 113 tests respectively.

## Tests that pin this

- `tests/e2e/frontend/checker.test.ts` > `"respects generic variance when comparing Promise<T> (covariant)"`
  — the derived `co` for `Promise<T>`, in both the annotation and the argument position.
- `tests/e2e/frontend/checker.test.ts` > `"checks structural interface assignability by required fields"`
  and > `"treats an implemented class as assignable to the interface"` — `objectAssignable`'s
  required-field loop, and the fact that `implements` records no lineage and does not need to.
- `tests/e2e/frontend/checker.test.ts` > `"instantiates generic interfaces through inherited parents"`
  — `instantiateShapeForType` reaching a parent's shape before `objectAssignable` compares it.
- `tests/e2e/frontend/checker.test.ts` > `"accepts int and float numeric compatibility"` and
  > `"accepts numeric widening but rejects narrowing"` — `NUMERIC_RANK`, both directions.
- `tests/frontend/type-accepts.test.ts` > `"accepts a widening but not the narrowing back"`
  and > `"rejects unrelated named types and accepts a name for itself"` — the same rank, and
  the identity rung, at the unit tier.
- `tests/e2e/frontend/checker.test.ts` > `"uses nominal least-upper-bound for arrays of subclass instances"`
  — `commonNominalAncestor` folding `Circle` and `Rectangle` to `Shape`.
- `tests/frontend/checker/type-checker.test.ts` > `"joins what the branches leave behind"` —
  `widenType`, the call site a user meets first.
- `tests/e2e/frontend/checker.test.ts` > `"accepts each member of a declared union"`,
  > `"rejects a value outside the union"` and
  > `"accepts an array member of a union whose last arm is an array"` — the
  `expectedUnion.some` clause, including an arm that is itself structured.
- `tests/frontend/checker/type-system.test.ts` > `"accepts a union whose every member the target admits, however the target is spelled"`,
  > `"still refuses a union carrying a member the target has no place for"` and
  > `"keeps one member assignable into a union that lists it"` — the `actualUnion.every`
  clause and its interaction with canonical spelling.
- `tests/e2e/frontend/checker.test.ts` > `"collapses homogeneous array literals to element arrays"`
  and > `"keeps heterogeneous array literals as tuples and context-checks tuple targets"` —
  `inferArray`'s two outcomes: a join, or a tuple.
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` > `"keeps assignment compatibility stable across scalar, union, and array types"`,
  > `"fuzzes the operator type matrix including equality, bitwise, membership, and tensor matmul"`
  and > `"fuzzes function type spellings, nesting, and variance"` — the ladder, the operator
  layer and `functionAssignable` against generated inputs rather than chosen ones.
- The `inv` result for `ReactiveSignal<T>`: **[unpinned]**. No test in the tree compares two
  instantiations of it.
