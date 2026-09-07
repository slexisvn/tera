# 10. The lattice   ⟨— · — · J · N⟩

> **Status:** outline

**Thesis.** Assignability is structural, recursion is handled by assuming the answer, and
variance nobody declared is inferred from the method tables.

**What arrived.** From ch 9: canonical `TypeName` text, and the parsers that take it apart
— `unionParts`, `arrayElementType`, `tupleTypes`, `parseFunctionType`, `parseGenericType`,
`typeLiteralShape`, `instantiateShapeForType`.

**What leaves.** Three answers the rest of Part II is built on: `compatible(a, b, env)`
(does `a` fit where `b` was asked for), `leastUpperBound(types, env)` (what one name
covers all of these), and `constructorVariance(owner)` (how a generic's argument moves).

**New ideas.** A lattice — a set with a "least thing above both" operation; a partial
order; covariance and contravariance; a coinductive assumption (seeding a memo `true`);
why a comparison over a cyclic type must not recurse forever.

**Length.** 14 pages

## Anchors

- `src/frontend/checker/type-system.ts` — the whole answer machinery:
  `compatible` (the only exported entry), `assignable` (memo + resolve),
  `assignableUncached` (the case ladder), `functionAssignable`, `tupleAssignable`,
  `arrayAssignable`, `numericAssignable` + `NUMERIC_RANK`, `boolAssignable`,
  `nominalAssignable`, `objectAssignable`, `leastUpperBound`, `commonNominalAncestor`,
  `nominalLineage`, `nominalFamily`, `unionType`, `removeNullish`, `indexedAccessType`,
  `isIndexableType`, `indexKeyAssignable`, `iterableBindingType`, `awaitedType`,
  `promiseType`.
- `src/frontend/checker/type-system.ts` (variance half) — `Polarity`, `Variance`,
  `VARIANCE_CACHE`, `flipPolarity`, `polaritiesUnderVariance`, `constructorVariance`,
  `inferParamVariance`, `collectParamPolarity`, `genericArgsAssignable`,
  `PSEUDO_TYPE_PARAMS`, `METHOD_SPECS`.
- `src/frontend/checker/operator-types.ts` — 80 lines, the operator side of the same
  question: `binaryOperatorSemantics`, `acceptsEquality`, `acceptsOrderedComparison`,
  `isNumericScalar`, `tensorArithmeticResult`, and the five operator sets
  (`EQUALITY_OPERATORS`, `ORDERED_OPERATORS`, `NUMERIC_OPERATORS`, `BITWISE_OPERATORS`,
  `TENSOR_OPERATORS`).
- `tests/frontend/checker/type-checker.test.ts` — the narrowing and join behaviour that
  `leastUpperBound` produces (the `nullable narrowing` block).
- `tests/e2e/frontend/checker.test.ts` — the variance, union and numeric-rank blocks.

## Worked example

Two one-line programs whose only difference is which generic they name:

```
p: Promise<float> = one()          accepted   — Promise<T> came out "co"
s: ReactiveSignal<float> = signal(1)  refused  — ReactiveSignal<T> came out "inv"
```

Neither variance appears anywhere in the source tree. `Promise`'s method table mentions
`T` only in return position (`then`'s `(T) -> U` parameter flips to positive);
`ReactiveSignal` has both a `value` getter returning `T` and `set(value: T)`.

## Outline

- [ ] **New idea: a lattice.** Primer — a set of types, an order ("fits where this was
      asked for"), and a join ("the least type above both"). Name the two operations this
      chapter builds: `compatible` for the order, `leastUpperBound` for the join. State
      plainly that tera's is not a mathematically complete lattice — `leastUpperBound`
      can answer `null`, and callers fall back to a bare union.
- [ ] **The five answers before any structure is looked at.** Establish the top of
      `assignableUncached`: `error` and `any` on either side accept, identical strings
      accept, `never` is assignable to everything, everything is assignable to `unknown`,
      and nothing but `any` is assignable *from* `unknown`. Give the reason each exists —
      `error` stops cascades, `any` is the escape hatch ch 16 inventories, `unknown` is
      the one direction that must not be free.
- [ ] **Functions, and the direction that surprises people.** Establish
      `functionAssignable`: arity may be *shorter* (a callback that ignores arguments is
      fine), each parameter is compared *backwards*
      (`assignable(expectedParam, actualParam)`), and the return forwards. Primer on
      contravariance using a concrete pair from `arrayMethodSignature` — `map` asks for
      `(float, int) -> U` and `x => x` supplies `(float) -> float`.
- [ ] **Unions: forall on the left, exists on the right.** Establish the two clauses at
      `assignableUncached` lines 807-810 — `actualUnion.every` versus
      `expectedUnion.some` — and why the order matters (the actual union is checked first,
      so `int | undefined` into `int` fails on the `undefined` arm and produces the
      absence advice ch 13 depends on). Then intersections: `expectedIntersection.every`.
- [ ] **Tuples, arrays, and the bare `Array`.** Establish `tupleAssignable` (same length,
      pointwise), `arrayAssignable` (element-wise; a tuple flows into an array if every
      item does; `Array` is the top array type and forgets its element).
- [ ] **Numbers are a rank, not a lattice.** Establish `NUMERIC_RANK` (`int` 0, `float` 1)
      and `actualRank <= expectedRank`: widening only, one direction, two members. Contrast
      with `boolAssignable`, which exists only because `bool` and `boolean` both survive
      `cleanType` in some paths.
- [ ] **The nominal walk, and what it is for.** Establish `nominalAssignable`: parse both
      as generics, walk the actual's `nominalFamilies` chain upward looking for the
      expected base, and when it matches, compare arguments through
      `genericArgsAssignable`. Establish that `nominalFamilies` is written in exactly two
      places (`bindNode`'s `Class` branch for `extends`, and its `Model` branch) plus the
      built-in `BUILTIN_FAMILIES` table — so lineage exists for user classes and for spec
      types, and nowhere else.
- [ ] **And then structure decides.** Establish `objectAssignable` as the last resort:
      every required field of the expected shape must exist in the actual with an
      assignable type, an optional actual field cannot fill a required expected one, and
      index signatures are checked against both the actual's indexers and its excess
      fields. Name the consequence that ch 12 spends a chapter on: a class is a shape, so
      two unrelated classes with the same members are mutually assignable.
- [ ] **Why the obvious design fails: recursion.** Stage the naive comparison on
      `interface Node: next: Node | null` — it recurses forever. Then establish the fix in
      `assignable`: build the key `actual\0expected`, `memo.set(key, true)` *before*
      calling `assignableUncached`, then overwrite with the real answer. Primer on why
      assuming the answer is sound here (a coinductive proof: the comparison succeeds
      unless some finite path refutes it) and where it is not (a memo shared across
      unrelated queries would leak the assumption — hence `new Map()` per `compatible`).
- [ ] **The join, and the two fallbacks.** Establish `leastUpperBound`: fold left, keep
      whichever side subsumes the other, else `commonNominalAncestor` via
      `nominalLineage`; else `null`. Establish that the *bare union* fallback lives at the
      call sites, not here — `widenedField`, `memberReturnType`, `inferReturnType`,
      `fillOpenElements` all spell `leastUpperBound(pool, env) ?? unionType(pool)`.
- [ ] **The set piece: variance nobody wrote down.** Establish `constructorVariance`.
      For each type parameter of a pseudo-type, `inferParamVariance` walks that owner's
      whole `METHOD_SPECS` table: every return type is visited at polarity `+1`, every
      parameter type at `-1`. `collectParamPolarity` recurses through unions,
      intersections, function types (flipping polarity on the parameters), array elements,
      tuple items, generic arguments (through the *other* constructor's variance), and
      object-literal fields, and records a polarity when it finally reaches the bare
      parameter name. Positive and negative together → `inv`; positive → `co`; negative →
      `contra`; neither → `bi`.
- [ ] **Breaking the self-reference.** Establish the seeding: `VARIANCE_CACHE.set(owner,
      params.map(() => "co"))` before computing, so a method whose return type mentions
      its own owner (`ReactiveSignal.set` returns `ReactiveSignal<T>`) reads the seeded
      answer instead of re-entering. Then `collectParamPolarity` guards the direct case
      too, with `generic.name === owner ? null : constructorVariance(generic.name)`.
      Note that the seed is `"co"`, not `"bi"`, and say what that biases.
- [ ] **The answers it produces, and how to see them.** Walk `Promise<T>` (three methods,
      `T` positive in all three ⇒ `co`) and `ReactiveSignal<T>` (`value` getter positive,
      `set` parameter negative ⇒ `inv`), then `ReactiveComputed<T>` (`value`, `peek`, and
      `subscribe`'s `(T) -> void` all positive ⇒ `co`) as the control. Two CLI commands
      show the difference without reading any code.
- [ ] **What leaves.** Hand `compatible` and `leastUpperBound` to ch 11, which needs them
      to decide what an unannotated expression is.

## Honesty items

> **Unenforced.** `constructorVariance` caches per owner name in a module-level
> `VARIANCE_CACHE`, and the seed it writes before recursing (`params.map(() => "co")`) is
> observable: a type parameter whose only occurrence is inside its own constructor keeps
> the seeded `co` rather than being computed. Nothing asserts that the fixpoint has
> converged, and the cache is never invalidated — but `PSEUDO_TYPE_PARAMS` and
> `METHOD_SPECS` are built once from the language spec at module load, so it cannot go
> stale in practice.

> **Unfinished.** `genericArgsAssignable` compares only `Math.min(actualArgs.length,
> expectedArgs.length)` positions and returns `true` when either list is empty — so a bare
> `Promise` is assignable to `Promise<int>` and back. Cost of finishing: deciding what a
> missing type argument means, which the tree currently declines to.

> **Unfinished.** `nominalAssignable` clears `currentArgs = []` on every step up the
> lineage, so a generic parent's arguments are not substituted through an `extends`. A
> user class extending a generic spec type loses its argument at the first hop.

> **Unenforced.** `assignable`'s memo is keyed on `${actual} ${expected}` after
> `resolveType`, and `resolveType` uses a `seen` set that returns the *unresolved* name on
> a cycle. Two distinct cyclic aliases that resolve to the same name share a memo entry;
> nothing detects it.

## Verify it yourself

```bash
node dist/cli.js check -e 'fn one() -> Promise<int>:
  return Promise.resolve(1)
p: Promise<float> = one()
print(p)'
node dist/cli.js check -e 's: ReactiveSignal<float> = signal(1)
print(s)'
node dist/cli.js check -e 'class A:
  public constructor():
    this.n = 1
class B:
  public constructor():
    this.n = 2
a: A = B()
print(a)'
node dist/cli.js check -e 'n: int = 1
f: float = n
back: int = f
print(back)'
npx vitest run --project unit tests/frontend/checker/type-system.test.ts tests/frontend/type-accepts.test.ts
npx vitest run --project e2e tests/e2e/frontend/checker.test.ts
```

The first is accepted and the second reports
`Type 'ReactiveSignal<int>' is not assignable to 'ReactiveSignal<float>'` — same
`int`→`float` widening, opposite answers, because two method tables disagree about where
`T` appears. The third is accepted: assignability is structural. The fourth shows the
numeric rank is one-directional.

## Tests that pin this

- `tests/e2e/frontend/checker.test.ts` > "respects generic variance when comparing Promise<T> (covariant)"
- `tests/e2e/frontend/checker.test.ts` > "checks structural interface assignability by required fields"
- `tests/e2e/frontend/checker.test.ts` > "instantiates generic interfaces through inherited parents"
- `tests/e2e/frontend/checker.test.ts` > "accepts int and float numeric compatibility"
- `tests/e2e/frontend/checker.test.ts` > "accepts numeric widening but rejects narrowing"
- `tests/e2e/frontend/checker.test.ts` > "uses nominal least-upper-bound for arrays of subclass instances"
- `tests/e2e/frontend/checker.test.ts` > "accepts each member of a declared union"
- `tests/e2e/frontend/checker.test.ts` > "rejects a value outside the union"
- `tests/e2e/frontend/checker.test.ts` > "accepts an array member of a union whose last arm is an array"
- `tests/e2e/frontend/checker.test.ts` > "collapses homogeneous array literals to element arrays"
- `tests/e2e/frontend/checker.test.ts` > "keeps heterogeneous array literals as tuples and context-checks tuple targets"
- `tests/e2e/frontend/checker.test.ts` > "treats an implemented class as assignable to the interface"
- `tests/frontend/checker/type-system.test.ts` > "accepts a union whose every member the target admits, however the target is spelled"
- `tests/frontend/checker/type-system.test.ts` > "still refuses a union carrying a member the target has no place for"
- `tests/frontend/checker/type-system.test.ts` > "keeps one member assignable into a union that lists it"
- `tests/frontend/type-accepts.test.ts` > "accepts a widening but not the narrowing back"
- `tests/frontend/type-accepts.test.ts` > "rejects unrelated named types and accepts a name for itself"
- `tests/frontend/checker/type-checker.test.ts` > "joins what the branches leave behind"
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` > "keeps assignment compatibility stable across scalar, union, and array types"
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` > "fuzzes the operator type matrix including equality, bitwise, membership, and tensor matmul"
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` > "fuzzes function type spellings, nesting, and variance"
- `ReactiveSignal<T>` inferred invariant: **[unpinned]**
