# 14. Async, and the await you never wrote   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Two separate mechanisms answer "does this suspend?" — the checker's Promise
model, which trusts the `async` keyword, and `analyzeEffects`, a monovariant closure
analysis that infers suspension from the call graph for code that never wrote one — and the
seam between them is where both a wrong answer and an honest refusal live.

**What arrived.** From [Ch 13 § what-leaves]: a `BoundProgram` carrying `provenTakes`, and
`Signature` objects built by `signatureFromParams` (`binder.ts:87`) that already record
`async: node.async` and `generator: node.generator` from the parser. From [Ch 11]:
`inferCall`, which is about to gain one more rule.

**What leaves.** The *same AST*, mutated in place: `node.async = true` stamped on every
function unit the analysis reached, and `call.implicitAwait = true` on every call site that
must suspend. `analyzeEffects` returns its argument (`effects/index.ts:344-347`), so the
handover is a side effect, not a value. Ch 15 receives the module graph question; [Ch 18]
receives `implicitAwait` and turns each flag into one byte: `ROP_AWAIT` (`0x60`).

**New ideas.** A promise and suspension, described only as far as the checker needs it (the
runtime story is [Ch 30]); a *call graph*; *0-CFA* / monovariant closure analysis and why
"monovariant" means one summary per name rather than one per call; a *worklist* and a
*fixpoint*; sound over-approximation — when a static analysis must guess, which way it must
guess.

**Length.** 12 pages

## Anchors

- `src/frontend/checker/type-system.ts` — `Signature` (line 66) with optional `async` and
  `generator` at 77-78; `PROMISE_TYPE = "Promise"` (line 617); `awaitedType(type, env, seen)`
  (line 630) mapping over `unionParts`; `awaitedPart` (line 634) resolving, parsing the
  generic, recursing on the argument, and using the `seen` set to stop on a cycle;
  `promiseType(resolved, env)` (line 644) — note it awaits *first*, so `Promise<Promise<T>>`
  cannot be spelled.
- `src/frontend/checker/binder.ts` — `signatureFromParams` (line 87) and the `Function` case
  at 192-200, where `returns` is the declared text and `async: node.async` rides alongside
  it. This is the whole enforcement of the model's invariant.
- `src/frontend/checker/infer.ts` — `inferCall`'s three-line tail (403-405):
  `if (instantiated.async) return promiseType(instantiated.returns, bound.env)`, then the
  generator case, then [Ch 13]'s `provenTakes` narrowing. Line 108: `AwaitExpression`
  answers `awaitedType(...)`.
- `src/frontend/checker/type-checker.ts` — `checkReturn` (584-599): `resolved`,
  `expectedType = unionType([resolved, promiseType(sig.returns)])`, and `actualResolved`,
  the three lines that let an async body return either shape.
- `src/frontend/effects/index.ts` — 347 lines, the whole pass. Module level:
  `ASYNC_DOMAIN_TYPES` from `TERA_ASYNC_DOMAIN_TYPES` (`DataFrame`, `Trainer`),
  `domainBuiltins` via `runtimeBuiltinMetadataFromSpec`, `RESULT_FIELD_TYPES`,
  `FUNCTION_TYPES`, `BINDING_TYPES`, `namespaceAsyncMethods` /
  `ASYNC_NAMESPACE_METHODS` / `isAsyncNamespaceCall`, and the helpers `calleeName`,
  `bindingName`, `bindingValue`, `paramNames`. The `Unit` type (line 15) and `Resolution`
  with its two singletons `UNRESOLVED` and `NOT_A_CLOSURE`. The `EffectAnalyzer` class:
  `analyze`, `iterate`, `unit`, `index`, `raise`, `walkBody`, `walk`, `closuresOf`,
  `unitFor`, `bindClosure`, `union`, `bindArguments`, `resolveCallee`, `domainType`,
  `memberType`, `isAsyncOrigin`, `propagate`, `mark`. Exported entry `analyzeEffects`
  (line 344).
- `src/api/engine.ts:1210` and `:1253` — the two call sites,
  `this.runCompilerPasses("semantic", analyzeEffects(parsed), compilerExtensions)`. The pass
  runs *before* the semantic phase, on the raw AST, with no scopes and no types.
- `src/bytecode/register/compiler/expressions.ts` — the `CallExpression` case at 241-245:
  compile the call, then `if (node.implicitAwait) this.func.emit(bytecode.ROP_AWAIT)`.
  Compare `compileAwaitExpression` (line 958): the same opcode, from a keyword.
- `src/bytecode/register/ops/bytecode.ts:78` — `ROP_AWAIT = 0x60`; `:255` names it `Await`.
  `src/bytecode/register/ops/register-effects.ts:174` classifies it `ACCUMULATOR_ONLY`.
  `src/bytecode/register/interpreter/helpers.ts:68` and
  `src/optimizing/builder/ir-builder.ts:69,106` both list it among the suspending opcodes.
- `src/optimizing/drivers/aot.ts` — `misusedPromise` (343-360), the refusal quoted below.

## Worked example

Two programs, because the two mechanisms are separate.

**One.** `docs/example/stats-async.tera` writes `await` three times, and the checker's
Promise model is what handles them:

```bash
node dist/cli.js docs/example/stats-async.tera
node dist/cli.js --print-bytecode docs/example/stats-async.tera | grep -n 'Await\|==='
```
→ `Await` at offset 5 in `mean_of`, offsets 5 and 12 in `main`. Three keywords, three
opcodes. `main()` at the bottom of the file has no `await` and gets no `Await`.

**Two.** A file with no `await` anywhere and no `async` keyword either:

```
fn rows():
  return DataFrame(a=[1, 2]).collect()

print(rows())
```

```bash
node dist/cli.js --print-bytecode --filter rows /tmp/eff.tera
```

```
    13  CallMethod r0 r0 r0 r2
    14  Await
    15  Return
```

`Await` at 14, in a function whose source never mentions it — and a second one in
`<script>`, at offset 7, on the call to `rows`. `DataFrame.collect` is async; `rows` returns
its result; `print(rows())` therefore awaits too. Nothing in the source said so.

## Outline

- [ ] **Two mechanisms, one word.** Establish the split up front, because the chapter is
      otherwise confusing: the *checker* handles `async fn` — a keyword the parser already
      recorded — while `analyzeEffects` handles code that has no keyword at all. They do not
      talk to each other. Establish the boundary that follows: `analyzeEffects` runs on the
      raw AST at `engine.ts:1210`, before scopes exist; the checker runs after. Neither can
      read the other's answer.
- [ ] **New idea: a promise.** Primer, minimal — a value that stands for an answer that has
      not arrived, `await` being the operator that trades one for the other. Defer the
      machinery to [Ch 30].
- [ ] **The invariant: `returns` is always resolved.** Establish it precisely.
      `signatureFromParams` (`binder.ts:192-196`) stores exactly the text after `->`, so
      `async fn load(name: string) -> float[]` has `returns === "float[]"`, *not*
      `Promise<float[]>`, and carries `async: true` beside it. Establish the single place
      the wrapper is applied: `inferCall` (`infer.ts:405`). Establish why this shape and not
      the other: the body is checked against `float[]`, the call site sees
      `Promise<float[]>`, and neither has to unwrap what the other wrapped. **Why the obvious
      design fails** goes here — storing `Promise<float[]>` in the signature means
      `checkReturn` must strip it on every return statement and `declaredSignatureOf`
      ([Ch 20]) hands the optimizing tiers a return type no machine register can hold.
- [ ] **`awaitedType`, three properties.** Establish each from the four lines at
      `type-system.ts:630-642`. It **distributes over unions**, because it is
      `unionType(unionParts(type).map(awaitedPart))` — so `Promise<int> | string` awaits to
      `int | string`. It **recurses**, so a nested promise collapses. It is **cycle-guarded**
      by the `seen` set, which returns the inner type rather than looping — the guard exists
      because `resolveType` consults `env.aliases` and an alias may name itself. Establish
      `promiseType` calling `awaitedType` on the way *in*, which is what makes
      `Promise<Promise<T>>` unrepresentable rather than merely unusual.
- [ ] **`checkReturn` accepts both shapes.** Establish the three lines at
      `type-checker.ts:587-593`: `resolved` for the compatibility test, `expectedType` as
      `unionType([resolved, promiseType(sig.returns)])` for contextual typing of the
      expression, `actualResolved` awaiting whatever the body produced. The consequence, and
      it is deliberate: inside `async fn f() -> int`, both `return 1` and
      `return some_promise_of_int` type-check. Pin with *"checks async return bodies against
      the resolved type, not the Promise"* and *"accepts a Promise of the resolved type
      returned from an async function"*.
- [ ] **What the model catches on its own.** Establish the failure mode: call an `async fn`
      without `await` and the binding's type is `Promise<float[]>`, so the very next use
      fails. Demonstrate — `values = load(name); return values[0] + values[1]` reports
      `Type 'Promise<float[]>' is not indexable` twice, at the two subscripts. Establish the
      three-tier consequence: the interpreter runs it anyway and prints `NaN`; `tera check`
      reports it as advice; `tera compile` refuses ([Ch 16]). The keyword half of async needs
      no inference because the keyword is the declaration.
- [ ] **New idea: the call graph, and why a name is not a function.** Primer — the graph
      whose nodes are functions and whose edges are "may call". Then the problem that makes
      it hard: `fn apply(f): return f()` has an edge to whatever `f` is, and `f` is a
      parameter. Establish the analysis that answers it and the name for it — 0-CFA,
      monovariant: one set of possible values per *name*, merged across every call site, not
      one per call site. Establish what monovariance costs, using the tree's own test —
      *"merges every function that flows into one parameter"*: one sync and one async
      function passed to the same `apply` makes `apply` async, permanently, for both callers.
- [ ] **The `Unit`, and what is in it.** Establish the record (`effects/index.ts:15-22`):
      `node` (null for the implicit top-level unit), `calls`, `callees`, `params`, `async`,
      `returns`. Establish `seen: Map<FunctionNode, Unit>` as the identity that survives
      re-walking, `byName: Map<string, Unit[]>` as the *declaration* index, and
      `flow: Map<string, Set<Unit>>` as the *value* index — the actual points-to relation.
      Establish `opaque: Set<string>` and `tracked: Set<string>` as the two ignorance flags,
      and why there are two: `tracked` means "this name has held a function", `opaque` means
      "something flowed into it that I could not identify".
- [ ] **Where a closure flows.** Establish the three transfer rules in `walk`
      (`:152-201`). A binding (`BINDING_TYPES`: let/const/var/assignment) calls
      `bindClosure(name, value)`. A call calls `bindArguments`, which resolves the callee and
      binds each argument to the corresponding *parameter name* — that is how `apply(load)`
      teaches `f` about `load`. A function node creates its unit and registers its parameter
      names as `tracked`. Establish `union` (`:222-233`) as the only widening, and that it
      sets `changed = true` whenever it adds anything: the flow sets are what the fixpoint
      is over.
- [ ] **Ignorance points one way.** Establish `resolveCallee` (`:249-262`) as a three-answer
      function: resolved units, `NOT_A_CLOSURE` (a member expression, or a name that never
      held a function — this is why `print(1)` is not awaited), and `UNRESOLVED` (a tracked
      name with nothing known). Establish the rule in `isAsyncOrigin` (`:295`):
      `if (resolved.unknown) return true` — an unresolvable callee is *assumed* async.
      Establish why that direction and not the other: a missing `await` gives a `Promise`
      where a value was wanted, which is silently wrong; a spurious `ROP_AWAIT` on a
      non-promise is a no-op at run time. Pin with *"awaits a parameter call when nothing
      ever flows in"*, *"awaits a call through a binding it cannot resolve"*, and its
      counterweight *"does not treat an unknown global as an unresolved closure"*.
- [ ] **Where async comes from at all.** Establish the four seeds in `isAsyncOrigin`
      (`:294-303`), and be exact, because this is the surprising part: a builtin whose spec
      entry has `effect: "async"`; a namespace method from `ASYNC_NAMESPACE_METHODS`
      (built by `namespaceAsyncMethods` from `TERA_CHART_METHODS`, keyed by the
      `"method of X"` prefix); a call whose receiver has a *domain type* —
      `domainType`/`memberType` threading `DataFrame` and `Trainer` through bindings,
      returns, and `RESULT_FIELD_TYPES` records with their `@` prefix; and a resolved callee
      that is already async. Establish what is **not** on that list: the `async` keyword.
      `unit.async` starts `false` and is only ever raised by `raise`; nothing reads
      `node.async` as an input. See the honesty item.
- [ ] **New idea: a worklist reaching a fixpoint.** Primer — a queue of facts, each of which
      may create more facts, run until nothing changes. Then `propagate` (`:317-332`): build
      the reverse edge map `callers` by resolving every call in every unit, seed the worklist
      with every already-async unit, and walk *backwards* — a caller of an async unit is
      async. Establish the two nested loops that make the whole pass a fixpoint: `iterate`
      re-walks the entire body while `changed`, and `analyze` runs `iterate` **twice** — once
      with `effects = false` to settle the flow sets, then once with `effects = true` to let
      asyncness ride on top of them. Establish why the first pass must not mark: a call whose
      callee is only learned on iteration three would otherwise have been marked, or not,
      depending on walk order. Pin with *"propagates async through mutual recursion"* and
      *"reaches a fixpoint on a self-recursive sync function"*.
- [ ] **`mark`, the only mutation.** Establish `mark` (`:335-343`): for each unit, stamp
      `node.async = true`; for each call, set `implicitAwait` when the callee is unknown or
      any resolved callee is async. Establish that this is a *separate* pass from `walk`'s
      inline `call.implicitAwait = true` (`:195`) and that the flags are never cleared —
      `analyzeEffects` is not idempotent-safe against an AST that was already analyzed.
- [ ] **One flag, one byte.** Establish the handover to [Ch 18]: `expressions.ts:241-245`
      compiles the call, then emits `ROP_AWAIT` if the flag is set — the *same* opcode
      `compileAwaitExpression` (`:958`) emits for a written keyword, so nothing downstream
      can tell them apart. Establish who else reads `ROP_AWAIT`: the interpreter's suspending
      set (`interpreter/helpers.ts:68`), and `ir-builder.ts:69,106` where it becomes
      `SUSPENDING_AWAIT_REASON` and, on the AOT road, an `IR_AWAIT` ([Ch 63]).
- [ ] **The refusal that admits the gap.** Establish `misusedPromise`
      (`drivers/aot.ts:343-360`): the AOT driver walks every call to a suspending function
      and checks `node.uses.every(use => use.type === IR_AWAIT)`. When one is not awaited it
      declines the function with `the promise <name> returns is used as a plain value here;
      await it before using it, or keep this part interpreted`. Establish what this sentence
      really reports: `analyzeEffects` failed to mark that call site, and rather than
      miscompile, the fourth tier hands the function back to the first. Close the loop with
      the `NaN` from earlier in the chapter — that is the same hole, seen from tier zero,
      with nobody to refuse.
- [ ] **What leaves.** Restate: an AST with two boolean fields set on it, and no new data
      structure. Ch 15 takes the same tree and asks a question that has nothing to do with
      types — what order do the *files* run in.

## Honesty items

> **Unfinished.** `EffectAnalyzer` never reads the parser's `async` flag. A `Unit` is created
> with `async: false` (`effects/index.ts:126`) and raised only by `raise` from
> `isAsyncOrigin`, whose seeds are async *builtins*, async namespace methods, and domain
> types — never the keyword. So `async fn load()` followed by an unawaited `load()` gets no
> `implicitAwait`, no `ROP_AWAIT`, and — in the interpreter — a `Promise` where a `float[]`
> was expected. The checker catches this case independently, which is why it has not bitten:
> `Type 'Promise<float[]>' is not indexable`. It bites when the checker is silent, e.g. when
> the promise is passed straight to a function typed `any`. Cost of fixing: one line
> (`inner.async = node.async === true` in `walk`), plus deciding what happens to explicit
> `await`s that would then become double awaits — `awaitedType`'s recursion makes that safe
> for types, but `ROP_AWAIT` twice on one value is a question for [Ch 30].

> **Unfinished.** `closuresOf` (`:180-190`) merges `byName` (declarations) with `flow`
> (values) by *bare name*, with no scope. Two local functions called `handler` in different
> functions are one entry, and one being async makes every `handler()` call in the program
> await. The pass runs before binding (`engine.ts:1210`), so no scope information exists to
> use. Cost: running the analysis after `bindProgram` and keying units by `Scope` identity —
> which reverses the phase order the engine currently has.

> **Unfinished.** `resolveCallee` answers `NOT_A_CLOSURE` for **every** `MemberExpression`
> (`:251`), so `obj.method()` is never resolved to a unit. Async-ness of a method call is
> recovered only through `isAsyncNamespaceCall` and the `domainType` receiver test — that
> is, only for the builtin domain surface. A user class with an `async` method is invisible
> to this pass in both directions.

> **Unenforced.** `analyzeEffects` mutates the AST and returns it; nothing marks the tree as
> analyzed. `engine.ts` calls it at two sites (1210, 1253) and both re-run the whole
> fixpoint. `mark` only ever *sets* flags, so a second run on an already-marked tree cannot
> clear a flag that a changed program no longer justifies. No test covers analyzing the same
> AST twice.

> **Unenforced.** The relationship between `TERA_ASYNC_DOMAIN_TYPES` and the sibling packages
> is checked, but only for two names.
> `tests/e2e/language/effects.test.ts` > "keeps the declared async domain types in sync with
> the native classes" asserts `DataFrame` and `Trainer` have async methods and that `Linear`
> and `DataLoader` do not. Nothing enumerates the sibling surface, so a new async class in
> `query_engine` or `mlfw` is silently not a seed.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats-async.tera
node dist/cli.js --print-bytecode docs/example/stats-async.tera | grep -n 'Await\|==='
printf 'fn rows():\n  return DataFrame(a=[1, 2]).collect()\n\nprint(rows())\n' > /tmp/eff.tera
node dist/cli.js --print-bytecode --filter rows /tmp/eff.tera
node dist/cli.js check -e 'async fn load(n: string) -> float[]:
  return [1.0, 2.0]
fn total(n: string) -> float:
  values = load(n)
  return values[0] + values[1]
print(total("x"))'
npx vitest run --project unit tests/frontend/effects.test.ts
```

The second shows three `Await`s for three written `await`s and none for the unawaited
`main()`. The fourth shows one `Await` in a function whose source has no keyword. The fifth
reports `Type 'Promise<float[]>' is not indexable` twice — the checker's half doing the work
the effect analysis did not. The suite is 14 tests.

## Tests that pin this

`tests/frontend/effects.test.ts` > `describe("effect analysis")` — the analysis in isolation,
seeded by `DataFrame(a=[1]).collect()`:

- > "marks a function that awaits a domain method as async"
- > "propagates async to a direct caller and awaits the call"
- > "leaves a purely synchronous function alone"
- > "resolves a callee bound to a parameter and awaits it"
- > "keeps a parameter call synchronous when only sync functions flow in"
- > "resolves a callee bound to a variable"
- > "threads a callee through two levels of parameter passing"
- > "merges every function that flows into one parameter"
- > "stays synchronous when only sync functions are merged"
- > "awaits a call through a binding it cannot resolve"
- > "awaits a parameter call when nothing ever flows in"
- > "does not treat an unknown global as an unresolved closure"
- > "reaches a fixpoint on a self-recursive sync function"
- > "propagates async through mutual recursion"

`tests/e2e/language/effects.test.ts` > `describe("effect analysis and implicit await")` — the
same rules, run:

- > "keeps the declared async domain types in sync with the native classes"
- > "awaits a domain method without an await keyword"
- > "propagates the effect through user functions"
- > "still honours an explicit await"
- > "leaves synchronous code untouched"

`tests/e2e/frontend/checker.test.ts` — the Promise model:

- > "types async function calls as Promise and unwraps them with await"
- > "checks async return bodies against the resolved type, not the Promise"
- > "accepts a Promise of the resolved type returned from an async function"
- > "propagates Promise value types through chained callbacks"
- > "respects generic variance when comparing Promise<T> (covariant)"

`tests/e2e/docs/book-examples.test.ts`:

- > "stats-async.tera prints what the book says it prints"

That `unit.async` is never seeded from the `async` keyword: **[unpinned]** — no test
exercises `analyzeEffects` on a declared `async fn`.
