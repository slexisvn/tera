# 11. Inference without Hindley-Milner   ⟨— · — · J · N⟩

> **Status:** outline

**Thesis.** Contextual typing plus two-pass matching, deliberately not unification — and
the inferred answers are written back onto the AST as a compiler output, not merely
reported.

**What arrived.** From ch 10: `compatible`, `leastUpperBound`, and the type-text parsers.
From ch 8: the `Scope` chain and every declared `Signature`.

**What leaves.** Two things. A type for every expression (`inferExpression`), which the
checker compares and ch 12 harvests into class shapes. And a mutation of the input tree:
`adoptContextualSignature` stamps `_paramInfo` and `_returnType` onto arrow and function
nodes, which `declaredSignatureOf` (ch 20) reads on its way into
`RegisterCompiledFunction.declaredSignature` — the only channel from the checker to the
optimizing tier.

**New ideas.** Contextual (bidirectional) typing — an expected type pushed *down* rather
than a type inferred *up*; matching vs. unification; monomorphisation as the alternative
to polymorphism.

**Length.** 14 pages

## Anchors

- `src/frontend/checker/infer.ts` — `inferExpression` (the syntax-directed switch, with
  `expected: Signature | null` and `expectedType: TypeName | null` threaded down),
  `literalType`, `inferArray` / `arrayElementTypes`, `inferBinary`, `inferUnary`,
  `inferCompound`, `inferMember` / `declaredMemberType`, `inferIndexExpression`,
  `inferCall`, `inferNew`, `inferArrow`, `arrowParameterTypes`, `writtenType`,
  `instantiateForCall`, `unifyTypeParams`, `functionSignatureForType`,
  `callSignatureForCallee`, `arrowSignature`, `memberSignature`, `arrayMethodSignature`,
  `typedArrayElement`, `narrowScope`, `childScope`, `objectLiteralShape`,
  `objectLiteralFields`, `comprehensionOf` / `comprehensionArrayType`, `typeArgsOf`.
- `src/frontend/ast/index.ts` — `adoptContextualSignature` (lines 300-324),
  `declaredParamInfo`, `functionParameters`, `parameterName`, `isRestParameter`,
  `FunctionParamInfo`, and the `_paramInfo` / `_returnType` fields it writes.
- `src/frontend/checker/type-checker.ts` — the callers that decide *when* to stamp:
  `checkArrow` (`adoptContextualSignature(node, positionalTypesOf(expected), null)` then a
  second call with the inferred return), `checkFunctionExpression`, `checkComprehension`,
  `checkVar` / `checkReturn` / `checkAssignableValue` building the `expected` /
  `expectedType` pair, `isContextualExpression`.
- `src/frontend/checker/type-system.ts` — `instantiateSignature`, `substituteType`,
  `parseFunctionType`, `signatureType`, `arrayOfType`, `unionType`.

## Worked example

`docs/example/stats-closure.tera:9` — `scaled: float[] = values.map(double)`.

`memberSignature` produces `Array.map` as `(fn: (float, int) -> U) -> U[]` with
`typeParams: ["U"]`. `instantiateForCall` makes two passes over the one argument; the
argument's type *is* a function type, so pass one skips it and pass two runs
`inferExpression` with the substituted expected signature in hand. `unifyTypeParams`
matches `(float, int) -> U` against `double`'s `(float) -> float`, pairs the first
parameter, then the returns, and binds `U := float`. `map` answers `float[]`.

The arrow-shaped variant of the same call shows the write-back: in
`values.map(x => x.to_fixed(2))`, `x` has no annotation, `checkArrow` stamps
`_paramInfo[0].type = "float"`, and `to_fixed` resolves — answering `string[]`.

## Outline

- [ ] **New idea: two directions.** Primer — inference *up* (a literal `1` is `int`) and
      checking *down* (this lambda is being passed where `(float) -> bool` was asked for,
      so its parameter is `float`). Establish that `inferExpression`'s signature carries
      both directions in one call: the node goes up, `expected`/`expectedType` come down.
- [ ] **The syntax-directed skeleton.** Establish `inferExpression` as a switch over
      `NodeType` with no worklist, no constraint store and no second visit — one recursive
      descent, one answer per node. Name the three nodes that pass context on unchanged
      (`SequenceExpression`, `YieldExpression`, `ConditionalExpression`) and the two that
      *are* the context (`ArrowFunctionExpression`, `FunctionExpression`).
- [ ] **Where a context comes from.** Establish the four sources, each a call site in
      `type-checker.ts`: a declared variable type (`checkVar` builds
      `functionSignatureForType(node.name, declared)`), a parameter type
      (`instantiateForCall`'s `functionSignatureForType(pair.name, resolved)`), an array
      element type (`arrayElementTypes` passes `expectedElement` down), and a return type
      (`checkReturn`'s `functionSignatureForType("<return>", resolved)`).
- [ ] **How a lambda reads its context.** Establish `inferArrow`: build a child scope,
      then for each parameter take `writtenType(expected?.params.get(...)?.type,
      declared?.[i]?.type) ?? "any"` — the *contextual* type wins over the written one, and
      `isUnwrittenType` (`"any"` or absent) is what makes a slot available. Then the
      return: an expression body is inferred inside the child scope; a block body takes
      the contextual return or `"any"`.
- [ ] **Why the obvious design fails: one pass over the arguments.** Stage the naive
      loop — walk arguments left to right, unify each, build each lambda's context from
      whatever substitutions exist so far. Show what breaks: in
      `reduce(fn, initial)` the lambda comes *first*, so its `U` is still unbound when its
      body is checked, and the body's inferred type is what should have bound `U`.
- [ ] **The fix: two passes filtered on shape.** Establish `instantiateForCall`'s
      `for (const pass of [false, true])` with the guard
      `if ((parseFunctionType(pair.type) !== null) !== pass) continue` — every
      non-function argument is matched first, then every function-typed one, with the
      substitutions from pass one already applied via
      `substituteType(pair.type, substitutions)`. State the invariant plainly: a lambda's
      contextual signature is never built from an unresolved type parameter that an
      ordinary argument could have fixed.
- [ ] **Matching, not unification.** Establish `unifyTypeParams` as one-directional
      structural matching: if the parameter type *is* a type parameter, bind it (first
      binding wins, `if (!subs.has(param))`); else recurse pairwise through function
      types, array elements, and same-named generics. Then name everything it is not —
      no constraint store, no occurs check, no generalization, no substitution
      composition, no unbound-variable propagation. Unfilled parameters are simply set to
      `"unknown"` at the end.
- [ ] **The fallback that is not matching at all.** Establish the last loop
      (`infer.ts:375-377`): for any still-unbound type parameter whose *name occurs* in
      the parameter type as a word, bind it to the whole actual type. Show the program it
      exists for and the program it breaks (ch 9's `{ T: string }` collision).
- [ ] **The write-back.** Establish `adoptContextualSignature` as a compiler *output*, not
      a diagnostic: it merges `positionalTypes` into `_paramInfo` only where the existing
      entry `isUnwrittenType` and the contextual one is not `isUntypedName`, requires the
      adopted list to have the same length before committing, and writes `_returnType`
      only if the node does not already have one. Note the two-call pattern in
      `checkArrow`: parameters from the expected signature, return from what the body
      actually inferred.
- [ ] **Who reads it.** Establish the chain: `_paramInfo`/`_returnType` →
      `declaredSignatureOf` (`bytecode/register/compiler/functions.ts:165`) →
      `innerFunc.declaredSignature` → `aot-legality.ts`, `type-inference.ts`, and the x64
      and riscv64 lowerings. A lambda that never got a contextual type is a lambda the
      AOT compiler must refuse to type (ch 56).
- [ ] **What was tried and rejected: type variables.** Establish the judgement recorded in
      the tree's shape: for a monomorphic ahead-of-time compiler whose entry function
      takes no parameters, a Hindley-Milner solver would infer principal types that the
      backend must then *discard* — every call site is known, so the general answer is
      strictly less useful than the specific one. Name what landed instead:
      monomorphisation on argument types (ch 58), where a higher-order callee is compiled
      once per function argument and no code pointer is ever taken.
- [ ] **What that costs.** Establish the price honestly: no principal types, so
      declaration order matters (ch 16); no generalization, so a local helper cannot be
      used at two types; first-binding-wins, so argument order can change an answer.
- [ ] **What leaves.** Hand the inferred expression types to ch 12, which reads them off
      `this.x = ...` assignments to build a class out of nothing.

## Honesty items

> **Broken.** `unifyTypeParams`'s final fallback (`src/frontend/checker/infer.ts:375-377`)
> binds a type parameter whenever `new RegExp("\\b" + typeParam + "\\b").test(param)`
> matches anywhere in the parameter's type text — including a *field name*. With
> `substituteType`'s matching regex (ch 9) this makes
> `fn pick<T>(row: { T: string }, v: T) -> T` reject `pick({ T: "a" }, 1)`, while the same
> function with the parameter renamed `Elem` accepts it. Cost of finishing: structural
> matching over parsed types instead of text, i.e. the parser ch 9 exists to avoid.

> **Unfinished.** `inferArrow` gives a *block-bodied* lambda the contextual return type or
> `"any"` — it never walks the block's `return` statements the way `inferReturnType` does
> for a declared function. `values.map(x => { return x * 2 })` therefore answers
> `any[]` where the expression form answers `float[]`.
> Test: `tests/frontend/checker/type-checker.test.ts` >
> "types the parameter even when the body is a block" pins the *parameter* half only.

> **Unfinished.** `arrowSignature` (used when an arrow is called directly) types every
> parameter `"any"` and never consults a context, so an immediately-invoked lambda gets
> none of this chapter's machinery.

> **Unenforced.** `adoptContextualSignature` mutates a shared AST node and there is no
> assertion that it runs at most once per node, nor that a second, weaker context cannot
> overwrite a stronger one — the only guard is `isUnwrittenType` on the *existing* entry,
> which a prior stamp already satisfies. In the single-pass checker this cannot fire; it
> is a property of the walk order, not of the function.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats-closure.tera
node dist/cli.js check -e 'fn scaler(factor: float) -> fn(float) -> float:
  fn scale(x: float) -> float:
    return x * factor
  return scale
values: float[] = [12.5, 9.0]
double = scaler(2.0)
n: int = values.map(double)
print(n)'
node dist/cli.js check -e 'values: float[] = [1.0]
n: int = values.map(x => x.to_fixed(2))
print(n)'
node dist/cli.js -e 'values: float[] = [1.5]
print(values.map(x => x.to_fixed(2)))'
npx vitest run --project unit tests/frontend/checker/type-checker.test.ts -t "contextual lambda signatures"
```

The second reports `Type 'float[]' is not assignable to 'int'` — `U` was matched to
`float` through a function-typed argument. The third reports
`Type 'string[]' is not assignable to 'int'`: the unannotated `x` took `float` from its
context (that is how `to_fixed` resolved) and `U` took `string` from the body.

## Tests that pin this

- `tests/frontend/checker/type-checker.test.ts` > "types a lambda parameter from the declared variable type"
- `tests/frontend/checker/type-checker.test.ts` > "types a lambda parameter from the parameter it is passed to"
- `tests/frontend/checker/type-checker.test.ts` > "types a returned lambda from the declared return type"
- `tests/frontend/checker/type-checker.test.ts` > "accepts a returned lambda that matches the declared return type"
- `tests/frontend/checker/type-checker.test.ts` > "reports a returned lambda whose result does not match"
- `tests/frontend/checker/type-checker.test.ts` > "keeps the annotation the lambda spells out itself"
- `tests/frontend/checker/type-checker.test.ts` > "types nested lambdas through a curried return type"
- `tests/frontend/checker/type-checker.test.ts` > "accepts a curried lambda that matches the declared return type"
- `tests/frontend/checker/type-checker.test.ts` > "accepts a curried lambda that spells its own parameter types out"
- `tests/frontend/checker/type-checker.test.ts` > "types a lambda inside an array literal from the declared element type"
- `tests/frontend/checker/type-checker.test.ts` > "points at the lambda in an array literal whose result does not match"
- `tests/frontend/checker/type-checker.test.ts` > "lets a lambda with a declared function type call itself"
- `tests/frontend/checker/type-checker.test.ts` > "records nothing when the lambda has no contextual type"
- `tests/frontend/checker/type-checker.test.ts` > "leaves the return type open when the context returns nothing useful"
- `tests/frontend/checker/type-checker.test.ts` > "types the parameter even when the body is a block"
- `tests/e2e/frontend/checker.test.ts` > "checks generic function calls and return statements from bound signatures"
- `tests/e2e/frontend/checker.test.ts` > "context-checks fn-prefixed function variable annotations"
- `tests/e2e/frontend/checker.test.ts` > "propagates Promise value types through chained callbacks"
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` > "fuzzes contextual arrow bodies from annotations and callback parameters"
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` > "fuzzes explicit generic type arguments against argument and return checking"
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` > "does not duplicate diagnostics while propagating expected types"
- The `unifyTypeParams` name-occurrence fallback: **[unpinned]**
