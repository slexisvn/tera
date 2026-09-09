# 14. Async, and the await you never wrote   ⟨I · B · J · N⟩

Two entirely separate mechanisms in this engine answer the question "does this call suspend?"
One of them trusts the `async` keyword the parser recorded, wraps a return type in
`Promise<…>`, and reports it when you index a promise as if it were an array. The other never
looks at the keyword at all: it reads the call graph, decides which functions must suspend
because of what they *reach*, and writes an `await` into the bytecode that nobody typed. They
run at different times, over different trees, and neither can read the other's answer.

That seam is the chapter. It is where a wrong answer lives — a function that spuriously loses
three of the four tiers because two unrelated parameters share a name — and where an honest
one lives too: the ahead-of-time driver walks every call to a suspending function, checks that
every use of its result is an `await`, and when one is not, declines the function with a
sentence naming the promise. That refusal is the effect analysis admitting, at the last
possible moment, that it missed a call site.

Two warnings about the material. First, the running example only covers half of it.
`docs/example/stats-async.tera` is `stats.tera` written with `async fn` and three explicit
`await`s, and it exercises the checker's Promise model completely — but implicit await is
seeded by exactly two domain type names, `DataFrame` and `Trainer`, and no file in
`docs/example/` mentions either. Convention 2 applies: rather than contriving a ninth
variation, the two implicit-await programs in this chapter are named as scratch files, kept
out of `docs/example/`, and reproduced in full in "Verify it yourself". Second, one of them
exists to produce a *wrong* answer, which is the same reason `[Ch 1 § two-answers-then-and-now]`
keeps its `splice` reproducer out of the tree: a program whose whole purpose is to disagree
cannot be pinned to one expected output.

**What arrived.** From [Ch 13 § what-leaves]: a `BoundProgram` whose `provenTakes` field is a
`ReadonlySet<ASTNode>` of callee nodes, computed by `provenTakes(program.body)` inside
`bindProgram` (`src/frontend/checker/binder.ts:323`) and consulted by a single ternary at the
tail of `inferCall`. Alongside it, from the same binder, a `Signature` per function built by
`signatureFromParams` (`binder.ts:87`) that already carries `async: node.async` and
`generator: node.generator` straight from the parser. Ch 13 said this chapter "adds the effect
analysis on top of" that `BoundProgram`. It does not, and the correction is the first thing
this chapter has to establish: the effect analysis never sees a `BoundProgram` at all.

## Two mechanisms, one word

Open `src/api/engine.ts` at `compileInRuntime` and read the order in which things happen to a
source file. The parser produces an `ASTNode` tree. If the mode is anything but `off` — or if
this is an ahead-of-time compile, which forces strict — the checker runs at `:1194`, over
`astToSemanticProgram(parsedSource)`: a *different* tree, the thirteen-kind `SemanticProgram`
of [Ch 8]. Its output is a diagnostics array and, for AOT, a class table. Sixteen lines later:

```ts
    const parsed = this.runCompilerPasses("ast", parsedSource, compilerExtensions);
    const ast = this.runCompilerPasses("semantic", analyzeEffects(parsed), compilerExtensions) as ASTNode;
```
— `src/api/engine.ts:1209-1210`

`analyzeEffects` is handed `parsed` — the raw AST — not `checked.bound`. The `BoundProgram`
the checker built is still in scope on the line above and is not passed. So the two halves of
"async" in this engine are related only by the fact that both eventually mutate or describe
the same program:

| | the checker's half | `analyzeEffects` |
| --- | --- | --- |
| input | `SemanticProgram` → `BoundProgram` | the raw `ASTNode` tree |
| reads the `async` keyword | yes, via `Signature.async` | **no** |
| answers | a type, `Promise<T>` | two boolean fields on AST nodes |
| runs when mode is `off` | no | **yes, always** |
| what a mistake costs | a diagnostic | a missing or spurious `ROP_AWAIT` |

The last two rows are checkable in one command each. With the checker switched off entirely,
the effect analysis still stamps its opcode:

```
$ node dist/cli.js --typecheck off --print-bytecode --filter rows eff.tera | grep -c Await
1
$ node dist/cli.js --typecheck off promise-index.tera
NaN
```

The first program has no `async` and no `await` in its source and gets an `Await` anyway. The
second calls an `async fn` without awaiting it, indexes the promise twice, and — with the
checker silent — prints `NaN`. Both files are listed under "Verify it yourself".

Notice also what the ordering claim in [Ch 13 § what-leaves] gets wrong and why it matters.
Binding *has* already happened by the time `analyzeEffects` runs; the scopes exist. They are
simply built over the semantic tree and keyed to semantic nodes, while the effect analyzer
walks the raw AST. That is a stronger constraint than "the pass runs too early", because it
cannot be fixed by moving one call: the two trees have different node identities.

## New idea: a promise

> **New idea. A promise, and suspension.** A **promise** is a value that stands for an answer
> that has not arrived yet. A function that might have to wait for something — a file, a
> query, a model finishing a step — cannot return the answer, because it does not have it, so
> it returns a promise instead and the caller decides what to do about that. **`await`** is
> the operator that trades one for the other: it stops the function it appears in, lets other
> work run, and resumes with the answer once the promise has one. Stopping and resuming a
> function part-way through is called **suspension**, and it is why a function containing an
> `await` is itself asynchronous — its caller has the same problem all over again. For this
> chapter that is the whole model: a promise is a wrapper around a type, `await` unwraps it,
> and suspension is contagious upward through callers. How the runtime actually parks and
> resumes a frame — the microtask queue, the coroutine machinery, the state machine a
> generator compiles into — is `[Ch 30 § runasyncwithsuspension]`.

## The invariant: returns is always resolved

The checker's half rests on one invariant, and it is worth stating before anything else
because everything downstream is arranged around it. **A `Signature`'s `returns` field is
always the resolved type — never the promise.**

`signatureFromParams` stores exactly the text that followed `->`, run through `cleanType`, and
the binder attaches the two parser flags beside it:

```ts
  if (node.kind === "Function") {
    const sig = signatureFromParams(node.name, node.typeParams, node.params, node.returns, {
      async: node.async,
      generator: node.generator,
    });
```
— `src/frontend/checker/binder.ts:192-196`

So for `async fn load(name: string) -> float[]` — the first line of
`docs/example/stats-async.tera` — the signature has `returns === "float[]"` and
`async === true`. It does *not* have `returns === "Promise<float[]>"`. The `Signature` type
itself says so structurally: `returns: TypeName` is required, `async?: boolean` and
`generator?: boolean` are optional flags sitting beside it
(`src/frontend/checker/type-system.ts:66-79`).

The wrapper is applied in exactly one place, at a call site:

```ts
  if (instantiated.async) return promiseType(instantiated.returns, bound.env);
  if (instantiated.generator) return yieldedType(instantiated.returns);
```
— `src/frontend/checker/infer.ts:405-406`

Those two lines sit immediately above [Ch 13]'s `provenTakes` ternary in the same function,
and they return before it — so an async call is never narrowed by a length guard, which is
correct, because what it answers is a promise and not an element.

The invariant is that `Signature.returns` holds the resolved type of an async function. What
enforces it is arithmetic on call sites rather than an assertion: the single assignment in
`signatureFromParams` (`binder.ts:87`, called at `:193`) is the only thing that writes the
field for a declared function, and the single wrap in `inferCall` (`infer.ts:405`) is the only
thing in `src/frontend/checker/` that constructs a `Promise<…>` string from it. Nothing checks
the pair, so the invariant holds by there being exactly one writer and exactly one wrapper. It
is pinned behaviourally by
`[t: tests/e2e/frontend/checker.test.ts > "types async function calls as Promise and unwraps them with await"]`.

### Why the obvious design fails

*(Why the obvious design fails.)*

The design a reader reaches for first is the other one: store the promise. `async fn load()
-> float[]` obviously "returns" a `Promise<float[]>` to anybody who calls it, so put that in
the signature and be done. It even reads better at the call site, because `inferCall` then has
nothing special to do.

It fails at both ends at once.

At the body end, `checkReturn` type-checks `return [1.0, 2.0]` against the signature's
`returns`. If that field said `Promise<float[]>`, every `return` statement inside every async
function would have to strip the wrapper before comparing — so the unwrap would move from one
line in `inferCall` to one line in `checkReturn`, plus one in the contextual-typing path, plus
one wherever else a declared return type is consumed as a value type. Nothing is saved; the
special case is only relocated, and multiplied.

At the other end it does real damage. `declaredSignatureOf` ([Ch 20]) reads the same
`Signature.returns` text and hands it to `RegisterCompiledFunction.declaredSignature`, which is
the optimizing tiers' only view of what a function was declared to answer. A JIT or AOT
compiler asked to represent a return type of `Promise<float[]>` has nothing to do with it: it
is not a machine word, not a float, not an array — it is a runtime object the backend has no
layout for. Storing the promise in the signature would push a type no register can hold into
the exact field the register allocator consults. Keeping `returns` resolved means the body is
checked against `float[]`, the call site sees `Promise<float[]>`, the backends see `float[]`,
and no stage has to unwrap what another stage wrapped.

## awaitedType, three properties

The unwrap is four lines, and it has three properties worth naming separately because each one
is doing work the shape of the code hides:

```ts
export function awaitedType(type: TypeName, env: TypeEnv, seen = new Set<string>()): TypeName {
  return unionType(unionParts(type, env).map((part) => awaitedPart(part, env, seen)));
}

function awaitedPart(type: TypeName, env: TypeEnv, seen: Set<string>): TypeName {
  const resolved = resolveType(type, env);
  const generic = parseGenericType(resolved);
  if (generic?.name !== PROMISE_TYPE) return resolved;
  const inner = generic.args[0] ?? "unknown";
  if (seen.has(resolved)) return inner;
  seen.add(resolved);
  return awaitedType(inner, env, seen);
}

export function promiseType(resolved: TypeName, env: TypeEnv): TypeName {
  return `${PROMISE_TYPE}<${awaitedType(resolved, env)}>`;
}
```
— `src/frontend/checker/type-system.ts:630-645`

**It distributes over unions.** `awaitedType` is `unionType(unionParts(type).map(awaitedPart))`
— split the union, await each part, rebuild. So `Promise<int> | string` awaits to `int |
string`, which is the answer you want when a value came out of a conditional with a promise in
one arm. Awaiting a non-promise part is the identity: `awaitedPart` resolves it, fails the
`PROMISE_TYPE` test, and hands it straight back.

**It recurses.** The last line of `awaitedPart` calls `awaitedType` again on the argument, so a
nested `Promise<Promise<int>>` collapses to `int` in one call rather than needing two `await`s.
This mirrors the runtime, where awaiting a promise of a promise gives you the inner value.

**It is cycle-guarded.** The `seen` set exists because `resolveType` consults `env.aliases`, and
an alias is allowed to mention itself — `type Later = Promise<Later>` is a string the alias
table will happily hold. Without the guard the recursion would not terminate. With it, the
second sighting of the same resolved text returns `inner` rather than descending again: not an
error, not a diagnostic, just a stop.

The fourth property is in `promiseType`, and it is the one that determines the invariant's
shape. `promiseType` awaits its argument *on the way in*. Wrapping is therefore idempotent:
`promiseType(promiseType(T))` is `Promise<T>`, not `Promise<Promise<T>>`. In this checker
`Promise<Promise<T>>` is not merely unusual — it cannot be spelled by any code path that goes
through `promiseType`, which is every code path that produces one.

## checkReturn accepts both shapes

Inside an async function, both `return 1` and `return some_promise_of_int` are legal. That is
deliberate, it is three lines, and it costs nothing anywhere else:

```ts
    const resolved = sig.async ? awaitedType(sig.returns, this.bound.env) : sig.returns;
    const expectedType = sig.async ? unionType([resolved, promiseType(sig.returns, this.bound.env)]) : sig.returns;
    const expected = functionSignatureForType("<return>", resolved);
    const before = this.diagnostics.length;
    if (node.value) this.checkExpression(node.value, scope, node.span.line, node.span.column, expected, expectedType);
    const actual = inferExpression(node.value, this.bound, scope, expected, expectedType);
    const actualResolved = sig.async ? awaitedType(actual, this.bound.env) : actual;
```
— `src/frontend/checker/type-checker.ts:587-593`

Three names, three jobs. `resolved` is what the body is *compared against* — for
`async fn mean_of(name: string) -> float` that is `float`, so `return total / values.length`
is checked as a float and not as a promise. `expectedType` is what the body is *contextually
typed with*, and it is the union `float | Promise<float>`, so an expression whose shape depends
on its expected type — an array literal, an arrow, an empty collection — can be either.
`actualResolved` awaits whatever the body actually produced before the comparison, which is
what lets a `return` of a promise through.

Two tests pin the two halves:
`[t: tests/e2e/frontend/checker.test.ts > "checks async return bodies against the resolved type, not the Promise"]`
and
`[t: tests/e2e/frontend/checker.test.ts > "accepts a Promise of the resolved type returned from an async function"]`.

## What the model catches on its own

Now the failure the keyword half is *for*. Call an `async fn` and forget the `await`, and the
binding's type is the promise, so the next use of it fails — not at the call, at the use:

```
$ node dist/cli.js check promise-index.tera
…\promise-index.tera:6:17: error: Type 'Promise<float[]>' is not indexable
…\promise-index.tera:6:29: error: Type 'Promise<float[]>' is not indexable
```

Two diagnostics for two subscripts on line 6, columns 17 and 29 — `values[0]` and
`values[1]`. The call on line 5 is fine; a promise is a perfectly good value to bind to a
name. It is indexing one that has no meaning.

The same program takes all three roads out of [Ch 1 § the-gate] and gets three different
treatments of the same sentence:

```
$ node dist/cli.js promise-index.tera
NaN
$ node dist/cli.js compile promise-index.tera -o pi.exe
tera compile: 6:17 Type 'Promise<float[]>' is not indexable
6:29 Type 'Promise<float[]>' is not indexable
```

The interpreter runs it, indexes a promise, gets `undefined` twice, adds them, and prints
`NaN` with exit 0 — it never asks a type question. `tera check` reports both diagnostics with
an absolute-path prefix and exits 1. `tera compile` refuses, prints both under the
`tera compile:` prefix, and writes no binary. Three prefixes, one diagnosis, exactly as
[Ch 16 § severity-is-policy] describes the general rule.

The point for this chapter is what the keyword half does *not* have to do to get here. It runs
no analysis. It infers no effects. It asks the parser what the source said, and the source said
`async`. The keyword *is* the declaration, so there is nothing to infer — which is precisely
why the other half of the system exists, for the code where nobody wrote one.

## New idea: the call graph, and why a name is not a function

> **New idea. A call graph.** A **call graph** is the graph whose nodes are the functions in a
> program and whose edges mean "this one may call that one". Many questions that look local —
> does this function allocate, can it throw, must it suspend — are really reachability
> questions on that graph: the answer for a caller is some combination of the answers for
> everything it reaches. Building the graph is trivial when every call names its target
> literally. It stops being trivial the moment a function is a *value*.

Here is the whole difficulty in three lines:

```
fn apply(f):
  return f()
```

There is an edge from `apply` to whatever `f` is, and `f` is a parameter. To draw the edge you
have to know what flows into that parameter, at every call to `apply`, anywhere in the program
— and those calls might themselves pass a parameter of some other function. The graph you need
in order to find the values is the graph you were trying to build.

> **New idea. 0-CFA, and what "monovariant" costs.** The standard way out is to solve both at
> once: start with an empty map from names to possible function values, walk the program adding
> what you learn, and repeat until the map stops changing. The cheapest useful version of this
> is called **0-CFA** — control-flow analysis with zero context — and its defining property is
> that it is **monovariant**: it keeps *one* set of possible values per name, merged across
> every call site, rather than one set per call site. `apply(load)` on one line and
> `apply(pure)` on another do not produce two answers for `f`; they produce one answer
> containing both. That is what makes the analysis terminate quickly and what makes it
> imprecise, and the imprecision is not a corner case — it is the ordinary behaviour on any
> function used twice.

The tree tests exactly that behaviour and names it:
`[t: tests/frontend/effects.test.ts > "merges every function that flows into one parameter"]`
passes one async function and one sync function to the same `apply`, and asserts that `apply`
is async and its `f()` call is awaited. The counterweight is
`[t: tests/frontend/effects.test.ts > "stays synchronous when only sync functions are merged"]`
— merging is not a synonym for giving up.

## The Unit, and what is in it

`src/frontend/effects/index.ts` is 347 lines and holds the entire analysis. Its central record
is one function's summary:

```ts
type Unit = {
  node: FunctionNode | null;
  calls: CallNode[];
  callees: Set<string>;
  params: string[];
  async: boolean;
  returns: string | null;
};
```
— `src/frontend/effects/index.ts:15-22`

`node` is `null` for exactly one unit: the implicit top-level one, held in `this.top`, that
owns every call written at module scope. `calls` is every `CallExpression` lexically inside
this function, which is what `mark` will later walk. `params` is the parameter names, needed to
bind arguments to them. `async` starts `false` and is only ever raised. `returns` holds a
*domain type name*, not a general type — this is not the checker's type system, it is a
three-value guess about whether something is a `DataFrame`.

Around the `Unit` the analyzer keeps five maps and sets, and the difference between them is
the analysis:

- `seen: Map<FunctionNode, Unit>` — identity. `iterate` re-walks the whole body on every round,
  and `unit()` looks the node up here first, clearing `calls` and `callees` but keeping the
  `async` flag and the object identity. Without this, each round would build fresh units and
  the fixpoint would never converge.
- `byName: Map<string, Unit[]>` — the **declaration** index, keyed by `unit.node?.name`. An
  array, not a single unit, because two functions may share a name.
- `flow: Map<string, Set<Unit>>` — the **value** index. This is the actual points-to relation:
  which function values may reach this name.
- `tracked: Set<string>` — "this name has, at some point, held a function." Every parameter
  name and every binding target goes in.
- `opaque: Set<string>` — "something flowed into this name that I could not identify."

Two ignorance flags, because they mean opposite things. `tracked` without `opaque` is a name
the analysis is following and currently knows nothing about — a parameter nothing has been
passed to yet. `opaque` is a name it has watched receive a value it could not resolve to a
function. Both lead to over-approximation; they are separated because `resolveCallee` reports
them differently.

## Where a closure flows

`walk` (`src/frontend/effects/index.ts:159-201`) is one recursive descent with three transfer
rules, and every fact the analysis ever learns comes from one of them.

**A function node makes a unit.** `walk` sees a `FunctionDeclaration`, `FunctionExpression` or
`ArrowFunctionExpression`, calls `this.unit(node)`, records `paramNames(node)` on it, adds
every parameter name to `tracked`, and descends into the body with that unit as the current
one. Note the descent copies the domain-type map (`new Map(types)`) but shares `tracked`,
`flow` and `opaque` globally — the first of two places where scope is discarded.

**A binding binds a closure.** For the four `BINDING_TYPES` — `let`, `const`, `var` and a plain
`AssignmentExpression` — `walk` extracts the target name and the value, records the value's
domain type if it has one, and calls `bindClosure(name, value)`. That is how
`[t: tests/frontend/effects.test.ts > "resolves a callee bound to a variable"]` works:
`g = load` puts `load`'s unit into `flow["g"]`, and `g()` afterwards resolves.

**A call binds arguments to parameter names.** This is the rule that makes 0-CFA work.
`bindArguments` resolves the callee, and for each resolved unit binds argument *i* to that
unit's parameter name *i*:

```ts
  private bindArguments(call: CallNode): void {
    const resolved = this.resolveCallee(call.callee);
    for (const callee of resolved.units) {
      for (let i = 0; i < callee.params.length; i++) {
        const name = callee.params[i];
        if (!name) continue;
        const arg = call.args[i];
        if (!arg) continue;
        this.bindClosure(name, arg);
      }
    }
  }
```
— `src/frontend/effects/index.ts:249-260`

So `apply(load)` teaches `f` about `load`, by name. And because binding is by name, threading
works transitively without any extra machinery:
`[t: tests/frontend/effects.test.ts > "threads a callee through two levels of parameter passing"]`
passes `load` to `outer(g)`, which passes `g` to `apply(f)`, and asserts all three become
async — the argument `g` on the inner call resolves through `flow["g"]` on a later round.

All of that widening funnels through one method:

```ts
  private union(name: string, closures: Set<Unit>): void {
    let target = this.flow.get(name);
    if (!target) {
      target = new Set();
      this.flow.set(name, target);
    }
    for (const unit of closures) {
      if (target.has(unit)) continue;
      target.add(unit);
      this.changed = true;
    }
  }
```
— `src/frontend/effects/index.ts:236-247`

`union` only ever adds, and it sets `changed = true` whenever it adds anything. The flow sets
are what the outer loop is a fixpoint over, and `changed` is the only thing that keeps it
running.

## Ignorance points one way

`resolveCallee` is the analysis's single source of edges, and it has three possible answers, not
two:

```ts
  private resolveCallee(callee: ASTNode): Resolution {
    if (isFunctionNode(callee)) return { units: [this.unitFor(callee)], unknown: false };
    if (callee.type === NodeType.MemberExpression) return NOT_A_CLOSURE;
    if (callee.type !== NodeType.Identifier) return UNRESOLVED;

    const name = String(callee.name);
    const closures = this.closuresOf(callee);
    if (closures && closures.size > 0) {
      return { units: [...closures], unknown: this.opaque.has(name) };
    }
    if (this.tracked.has(name)) return UNRESOLVED;
    return NOT_A_CLOSURE;
  }
```
— `src/frontend/effects/index.ts:262-274`

`NOT_A_CLOSURE` — `{ units: [], unknown: false }` — means "I know this is not a user function I
am tracking." It is the answer for every member expression, and for any identifier that has
never held a function. That second case is what keeps `print(1)` from being awaited: `print` is
a global the analysis has never seen assigned, so it is not in `tracked`, so it is confidently
not a closure. `[t: tests/frontend/effects.test.ts > "does not treat an unknown global as an unresolved closure"]`
is the pin.

`UNRESOLVED` — `{ units: [], unknown: true }` — means "this name is one I am following, and I
cannot tell you what is in it." A parameter nothing has flowed into yet, or a computed callee.

And then the rule that decides which way the whole analysis leans:

```ts
  private isAsyncOrigin(call: CallNode, types: Types): boolean {
    const resolved = this.resolveCallee(call.callee);
    if (resolved.unknown) return true;
    if (resolved.units.length > 0) return resolved.units.some((unit) => unit.async);

    const name = calleeName(call.callee);
    if (name) return domainBuiltins[name]?.effect === "async";
    if (call.callee.type !== NodeType.MemberExpression) return false;
    if (isAsyncNamespaceCall(call.callee)) return true;
    return this.domainType(call.callee.object as ASTNode, types) !== null;
  }
```
— `src/frontend/effects/index.ts:300-310`

Line two: **an unresolvable callee is assumed async.**

> **New idea. Sound over-approximation, and which way to guess.** A static analysis that cannot
> decide must guess, and the direction is not a matter of taste — it follows from what each
> kind of mistake costs. Here the two mistakes are: mark a call that did not need it, or fail
> to mark one that did. A missing `await` hands a `Promise` object to code that wanted the
> value inside it; nothing complains, arithmetic on it produces `NaN`, and the program is
> silently wrong. A spurious `await` on something that is not a promise is, at run time, a
> no-op — awaiting a plain value gives you the value. So the analysis guesses "async", and its
> errors land on the side that still computes the right answer. An analysis whose
> over-approximations are all harmless is called **sound** for the property it is checking. The
> price is never zero, and this chapter's honesty items are the bill.

Two tests pin the direction:
`[t: tests/frontend/effects.test.ts > "awaits a call through a binding it cannot resolve"]` and
`[t: tests/frontend/effects.test.ts > "awaits a parameter call when nothing ever flows in"]`.

## Where async comes from at all

Read `isAsyncOrigin` again and ask what can make a *first* function async — not by inheriting
it from a callee, but from nothing. There are four seeds, and the surprising part is what is
missing from the list.

**An async builtin.** `domainBuiltins[name]?.effect === "async"`, where `domainBuiltins` is
`runtimeBuiltinMetadataFromSpec(TERA_BUILTINS)`. Grepping `data/tera-language-spec.ts`, exactly
five builtin functions carry `"effect": "async"`: `backtest`, `walk_forward`, `risk_parity`,
`hrp` and `mean_variance` — the quantitative surface that crosses into the `quantc` sibling
([Conventions § 19]).

**An async namespace method.** `ASYNC_NAMESPACE_METHODS` is built by `namespaceAsyncMethods`
from `TERA_CHART_METHODS`, keyed by stripping the `"method of "` prefix off each entry's `kind`
field. Every one of the seventeen async entries in that table has `"kind": "method of chart"`,
so the map has a single key. `isAsyncNamespaceCall` matches only an uncomputed member
expression whose object is a bare identifier — `chart.show(…)`, not `c["show"](…)`.

**A receiver with a domain type.** This is the `DataFrame` and `Trainer` path, and it is the
one the chapter's second program uses. `domainType` threads a small map of name → domain type
through bindings and returns: a call to a builtin whose spec `returns` is in
`ASYNC_DOMAIN_TYPES` yields that name; a call to a *user* function yields whatever domain type
that function was seen returning (`unit.returns`); and a call to a name in
`TERA_RESULT_FIELD_TYPES` yields a record marker with an `@` prefix. That last one is small and
concrete: `TERA_RESULT_FIELD_TYPES` (`data/tera-language-spec.ts:843-852`) has two entries,
`backtest` and `walk_forward`, each publishing `equity` and `port_returns` as `DataFrame`. So
`bt = backtest(…)` gives `bt` the type `@backtest`, `memberType` turns `bt.equity` into
`DataFrame`, and a method call on *that* is a seed.

**A resolved callee that is already async.** `resolved.units.some((unit) => unit.async)` — the
propagation step, expressed as a seed test so that a caller walked after its callee picks the
fact up immediately rather than waiting for `propagate`.

What is not on the list is the `async` keyword.

> **Unfinished.** `EffectAnalyzer` never reads the parser's `async` flag. A `Unit` is
> constructed with `async: false` (`src/frontend/effects/index.ts:133`, and again at `:218` in
> `unitFor`), and the only thing that ever changes it is `raise`, called from the
> `isAsyncOrigin` test in `walk` (`:196`) and from `propagate` (`:327`). The `FunctionNode`
> type declares `async?: boolean` (`:11`), and the field is *written* at `:335` in `mark` — it
> is never read as an input. The consequence is directly observable: `async fn load()` followed
> by an unawaited `load()` inside a plain `fn` gets no `implicitAwait`, no `ROP_AWAIT`, and, in
> the interpreter, a promise where a value was wanted. Verified on this tree, 2026-09-07:
> `node dist/cli.js --print-bytecode --filter total kw.tera` emits five instructions and no
> `Await`. This has not bitten in practice only because the checker catches the same case
> independently — `Type 'Promise<float[]>' is not indexable` — so it bites where the checker is
> silent, which is anywhere the promise is passed to something typed `any` rather than used.
> Cost of fixing: one line in `walk` (`inner.async = node.async === true`), plus a decision
> about what then happens to an explicit `await` on such a call, which would become a second
> `ROP_AWAIT` on one value. `awaitedType`'s recursion makes the double await harmless for
> *types*; whether it is harmless at run time is a question for [Ch 30]. That the keyword is
> never a seed is **[unpinned]** — no test in `tests/frontend/effects.test.ts` analyzes a
> declared `async fn` at all.

> **Unfinished.** `closuresOf` (`:203-213`) merges `byName` (declarations) with `flow` (values)
> by **bare name**, with no scope of any kind, and `tracked`, `flow` and `opaque` are single
> analyzer-wide maps. Two different functions with a parameter named `f` are one entry, and one
> async function flowing into either makes every `f()` call in the program await. Measured on
> this tree, 2026-09-07, with a controlled A/B: a program in which `apply_a(loader)` and
> `apply_b(plain)` both take a parameter named `f` compiles `apply_b`'s call site to `Call`
> followed by `Await`, and `node dist/cli.js --trace-opt` emits **no** `[JIT] Compiling
> "apply_b"` line at all. Delete the two unrelated lines mentioning `apply_a` and `loader` and
> the same `apply_b` is baseline-compiled and installed as 267 bytes of wasm. The cost of the
> imprecision is therefore not a wasted opcode — it is three tiers, because `ROP_AWAIT` is in
> `INTERPRETER_ONLY_OPS` (`src/bytecode/register/interpreter/helpers.ts:67-80`) and
> `requiresInterpreterOnly` (`:82-89`) gates baseline compilation, JIT compilation and OSR
> alike. Cost of fixing: the analysis would have to be keyed by scope identity rather than by
> name — but the scopes that exist are built over the `SemanticProgram`, and this pass walks the
> raw AST, so it is not a reordering, it is a change of input tree. **[unpinned]** — no test
> covers a name collision across two functions.

> **Unfinished.** `resolveCallee` answers `NOT_A_CLOSURE` for **every** `MemberExpression`
> (`:264`), so `obj.method()` is never resolved to a `Unit`. Async-ness of a method call is
> recovered only through `isAsyncNamespaceCall` and the `domainType` receiver test — that is,
> only for the builtin domain surface. A user class with an `async` method is invisible to this
> pass in both directions: calling it does not make the caller async, and it never propagates.
> Cost: member resolution needs a receiver type, which is the checker's job, which this pass
> does not have access to.

## New idea: a worklist reaching a fixpoint

> **New idea. A worklist reaching a fixpoint.** When a fact about one node implies facts about
> its neighbours, the way to compute all of them is a **worklist**: a queue seeded with the
> nodes you already know something about. Pop one, look at what its knowledge implies for its
> neighbours, and for each neighbour whose answer *changed*, push that neighbour. When the
> queue empties, nothing further can change — the analysis has reached a **fixpoint**. The
> loop terminates as long as facts only ever move one way (here, `false` → `true`, never back),
> because a value that can only be raised can only be raised finitely often.

`propagate` runs that loop backwards over the call graph, because "async" travels from callee
to caller:

```ts
  private propagate(): void {
    for (const unit of this.units) {
      for (const call of unit.calls) {
        for (const callee of this.resolveCallee(call.callee).units) {
          const bucket = this.callers.get(callee);
          if (bucket) bucket.add(unit);
          else this.callers.set(callee, new Set([unit]));
        }
      }
    }

    const worklist = this.units.filter((unit) => unit.async);
    while (worklist.length > 0) {
      for (const caller of this.callers.get(worklist.pop()!) ?? []) {
        if (caller.async) continue;
        this.raise(caller, "async", true);
        worklist.push(caller);
      }
    }
  }
```
— `src/frontend/effects/index.ts:312-331`

The first half builds `callers`, the reverse edge map, by resolving every call in every unit —
which is why it has to be rebuilt each round, since resolution improves as `flow` fills in. The
second half is the worklist proper: seed with every already-async unit, and raise every caller
of anything in it. `if (caller.async) continue` is what makes it terminate; `raise` sets
`changed` only when the flag actually moves.

Around that sit two nested loops that make the whole pass a fixpoint rather than a walk:

```ts
  analyze(program: ASTNode): void {
    const body = (program as { body?: ASTNode | ASTNode[] }).body ?? program;
    this.iterate(body);
    this.effects = true;
    this.iterate(body);
    this.mark();
  }
```
— `src/frontend/effects/index.ts:106-112`

`iterate` re-walks the entire body while `changed` is set, clearing `units`, `byName` and
`callers` each round but keeping `seen`, `flow`, `tracked` and `opaque` — the accumulated
knowledge survives, the derived indexes are rebuilt. And `analyze` runs `iterate` *twice*: once
with `effects === false`, then once with `effects === true`.

The reason for two passes is in `walk`. The `isAsyncOrigin` test and the inline
`call.implicitAwait = true` are both guarded by `if (this.effects && …)` (`:194-197`), and
`propagate` is guarded the same way inside `iterate` (`:121`). So the first pass does nothing
but settle the flow sets: it binds closures, records domain types and grows `flow` until
nothing changes. Only then does the second pass let asyncness ride on top of a points-to
relation that has stopped moving. If marking happened during the first pass, a call whose
callee is only discovered on round three would have been marked, or not, depending on the order
`walk` happened to reach things — and since flags are only ever set and never cleared, an early
wrong guess would be permanent.

Two tests pin the loop itself:
`[t: tests/frontend/effects.test.ts > "reaches a fixpoint on a self-recursive sync function"]`
— a function that calls itself must not spin, and must not become async by doing so — and
`[t: tests/frontend/effects.test.ts > "propagates async through mutual recursion"]`, where
neither function can be resolved before the other.

## mark, the only mutation

Everything above computes; `mark` is where the program changes:

```ts
  private mark(): void {
    for (const unit of this.units) {
      if (unit.node && unit.async) unit.node.async = true;
      for (const call of unit.calls) {
        const resolved = this.resolveCallee(call.callee);
        if (resolved.unknown || resolved.units.some((callee) => callee.async)) call.implicitAwait = true;
      }
    }
  }
```
— `src/frontend/effects/index.ts:333-341`

Two fields, both booleans, both only ever set to `true`. `node.async = true` on every function
unit the analysis decided must suspend — which is how a function that never wrote the keyword
acquires it, and how the bytecode compiler later knows to compile it as a coroutine.
`call.implicitAwait = true` on every call whose callee is unknown or whose resolved callees
include an async one.

This is a *second* place `implicitAwait` is written. `walk` already sets it inline at `:195`
during the effects pass. The two are not redundant: `walk` sets it at the moment the seed test
fires, while `mark` sets it after `propagate` has finished raising callers, so a call to a
function that only became async transitively is caught here and not there.

> **Unenforced.** `analyzeEffects` mutates its argument and returns it
> (`src/frontend/effects/index.ts:344-347`), and nothing marks the tree as analyzed.
> `src/api/engine.ts` calls it at two sites — `:1210` in `compileInRuntime` and `:1253` in the
> module path — and each runs the whole two-phase fixpoint from scratch. Because `mark` only
> ever *sets* flags, a second run over an already-marked tree cannot clear a flag that a
> changed program no longer justifies; it can only add. No test analyzes the same AST twice, so
> nothing would notice if a caller began to.

> **Unenforced.** The relationship between `TERA_ASYNC_DOMAIN_TYPES` and the sibling packages
> is checked, but only for two names.
> `[t: tests/e2e/language/effects.test.ts > "keeps the declared async domain types in sync with the native classes"]`
> asserts that `DataFrame` and `Trainer` are in the set and really do have async methods, and
> that `mlfw`'s `Linear` and `DataLoader` are in neither category. Nothing enumerates the
> sibling surface, so a new async class in `query_engine` or `mlfw` is silently not a seed —
> the analysis will not know to await it and nothing will fail.

## One flag, one byte

The handover to [Ch 18] is one field read in one place:

```ts
        case NodeType.CallExpression: {
          const emitted = this.compileCallExpression(node);
          if (node.implicitAwait) this.func.emit(bytecode.ROP_AWAIT);
          return emitted;
        }
```
— `src/bytecode/register/compiler/expressions.ts:241-245`

Compile the call, then emit one byte if the flag is set. That byte is `ROP_AWAIT = 0x60`
(`src/bytecode/register/ops/bytecode.ts:78`), named `Await` in the disassembler (`:255`) and
classified `ACCUMULATOR_ONLY` in the register-effects table
(`src/bytecode/register/ops/register-effects.ts:174`).

It is the *same* byte `compileAwaitExpression` emits for a written keyword:

```ts
  compileAwaitExpression(node: CompilerNode) {
    this.compileExpression(requireExpressionNode(node.argument, "await"));
    this.func.emit(bytecode.ROP_AWAIT);
  },
```
— `src/bytecode/register/compiler/expressions.ts:958-961`

Nothing downstream can tell them apart, which is the design: the effect analysis's entire
output is indistinguishable from source the user could have written. Run the two side by side.
`docs/example/stats-async.tera` writes `await` three times and gets three opcodes — offset 5 in
`mean_of`, offsets 5 and 12 in `main` — and the bare `main()` on the last line gets none. The
scratch file `eff.tera`, which writes neither `async` nor `await` anywhere, gets two:

```
    13  CallMethod r0 r0 r0 r2
    14  Await
    15  Return
```

`Await` at 14, inside `rows`, because `DataFrame(a=[1, 2]).collect()` is a method call on a
domain-typed receiver. And a second at offset 7 of `<script>`, on the call to `rows` itself,
because `rows` was raised async by `propagate` and its caller therefore awaits it. Nothing in
that four-line program said so.

Three consumers read the byte, and they do three different things with it. The interpreter
executes it. `INTERPRETER_ONLY_OPS`
(`src/bytecode/register/interpreter/helpers.ts:67-80`) lists it, and
`requiresInterpreterOnly` (`:82-89`) — which also returns true for any `compiledFn.isAsync` —
is consulted before baseline compilation, before JIT compilation and before OSR
(`src/runtime/tiering/osr.ts:41`), so a function containing one stays at tier 0. And the IR
builder handles it twice over: `UNSUPPORTED_REASONS` maps it to `SUSPENDING_AWAIT_REASON`
(`src/optimizing/builder/ir-builder.ts:106`) for the cases it cannot lower, while the
`ROP_AWAIT` case at `:2213` builds an `irAwait` node and, when the preceding instruction was a
call, stamps `AWAITED_CALL_PROP` on it — the mark the AOT coroutine machinery of [Ch 63] reads.

## The refusal that admits the gap

That last property is what makes the final refusal possible. Because an awaited call is marked
in the IR, the ahead-of-time driver can ask the opposite question — which calls to a suspending
function are *not* awaited:

```ts
      const name = calleeNameOf(node);
      if (name === null || !suspending.has(name)) continue;
      if (node.uses.every((use) => use.type === IR_AWAIT)) continue;
      return {
        name: graph.name,
        reason:
          `the promise ${name} returns is used as a plain value here; ` +
          `await it before using it, or keep this part interpreted`,
      };
```
— `src/optimizing/drivers/aot.ts:349-358`

`misusedPromise` (`aot.ts:343-361`, called at `:419`) walks every node of every block, and for
a call to a known suspending function checks that **every** use of its result is an `IR_AWAIT`.
One use that is not, and the function is declined. Verified on this tree, 2026-09-07, on the
three-line shape the tree's own decline test uses:

```
$ node dist/cli.js compile misuse2.tera -o misuse2.exe
tera compile: note: 'mid' is not in the binary, and nothing the program runs calls it (the promise g returns is used as a plain value here; await it before using it, or keep this part interpreted)
tera compile: wrote …\misuse2.exe
```

Read what that sentence actually reports. It is phrased as advice to the programmer — await it,
or keep this part interpreted — and for the case above that is fair, because `mid` really does
return a promise on purpose. But the same check fires whenever `analyzeEffects` failed to mark
a call site that needed marking, and in that case the sentence is the effect analysis reporting
its own miss, one stage too late to fix it, in the only vocabulary the backend has. The fourth
tier, having no interpreter underneath it, does the only safe thing: it hands the function back
to the first.

Which closes the loop with the `NaN` at the top of this chapter. `promise-index.tera` is the
same hole seen from tier zero — a promise used as a plain value, arithmetic performed on it,
`undefined` in and `NaN` out — except that at tier zero there is nobody to refuse. The
interpreter is the tier that finds out. The native compiler is the tier that has to know in
advance, and when it does not, it says so.

The decline is pinned by a template-generated title,
`[t: tests/e2e/optimizing/aot/async-suspend.test.ts > "declines a promise used as a plain value rather than reordering it"]`,
whose expectation is a substring match on `used as a plain value`.

## What leaves

Nothing new. That is the point worth carrying forward: this chapter produces no data structure
at all. `analyzeEffects` takes an `ASTNode`, mutates it, and returns the same object
(`src/frontend/effects/index.ts:344-347`), so the entire handover is a side effect on a tree
that already existed.

What is on that tree that was not there before is two boolean fields. `node.async = true` on
every function unit the fixpoint decided must suspend, whether or not its source says `async`.
`call.implicitAwait = true` on every call site that must await, whether or not its source says
`await`. Both are only ever set, never cleared, and no marker records that the pass has run.

Alongside it, unchanged and still separate, the checker's contribution: `Signature.async` beside
a `returns` field that is always the resolved type, one `promiseType` wrap at `infer.ts:405`,
and the diagnostics any unawaited use of the result produced.

[Ch 15 § new-idea-a-module] takes the same tree and asks a question with nothing to do with types or
effects: which *files* are in this program, what order do their top levels run in, and — the
part that turns out to be a different question — what order must they be checked in.
[Ch 18 § the-six-call-forms] takes `implicitAwait` and turns each flag into `ROP_AWAIT`, `0x60`,
one byte, indistinguishable from the one a keyword would have produced.

## Verify it yourself

Two of the five commands need files that are deliberately not in `docs/example/`, for the
reason given in the opener. Save them with your editor — not with a shell heredoc, which eats
backslashes — anywhere outside the repository.

`eff.tera`, four lines, no `async` and no `await`:

```
fn rows():
  return DataFrame(a=[1, 2]).collect()

print(rows())
```

`promise-index.tera`, eight lines, an `async fn` called without one:

```
async fn load(n: string) -> float[]:
  return [1.0, 2.0]

fn total(n: string) -> float:
  values = load(n)
  return values[0] + values[1]

print(total("x"))
```

```bash
# the keyword half: three written awaits, three opcodes, and none for the bare main()
node dist/cli.js docs/example/stats-async.tera
node dist/cli.js --print-bytecode docs/example/stats-async.tera | grep -n 'Await\|==='

# the inferred half: one Await inside rows, a second in <script>, from a source with neither keyword
node dist/cli.js --print-bytecode eff.tera

# the two halves are independent: with the checker off, the effect analysis still fires
node dist/cli.js --typecheck off --print-bytecode --filter rows eff.tera | grep -c Await
node dist/cli.js --typecheck off promise-index.tera

# the checker half doing the work the effect analysis did not, on all three roads
node dist/cli.js promise-index.tera
node dist/cli.js check promise-index.tera; echo "exit=$?"
node dist/cli.js compile promise-index.tera -o pi.exe; echo "exit=$?"

# the analysis in isolation (14 tests)
npx vitest run --project unit tests/frontend/effects.test.ts
```

The second command prints `Await` at offset 5 in `mean_of` and at offsets 5 and 12 in `main`,
and nothing in `<script>`. The third prints `Await` at offset 14 of `rows` and offset 7 of
`<script>`, and the program answers `[{ a: 1 }, { a: 2 }]`. The fourth pair prints `1` and
`NaN`. The fifth prints `NaN` and exits 0, then two `Type 'Promise<float[]>' is not indexable`
diagnostics at 6:17 and 6:29 and exits 1, then the same two under the `tera compile:` prefix
with no binary written.

The two honesty items measured in this chapter need two more scratch files. `kw.tera` — the
same `async fn load` and a `total` that binds `load(n)` and never uses it — run through
`node dist/cli.js --print-bytecode --filter total kw.tera` emits no `Await` at all, which is the
missing seed. And the name-collision A/B: a program with `apply_a(f)` fed `loader` and
`apply_b(f)` fed `plain`, run under `node dist/cli.js --trace-opt`, emits no
`[JIT] Compiling "apply_b"` line; delete the two lines mentioning `apply_a` and `loader` and the
same function reaches wasm.

## Tests that pin this

- `tests/frontend/effects.test.ts` > `"marks a function that awaits a domain method as async"`,
  > `"propagates async to a direct caller and awaits the call"`,
  > `"leaves a purely synchronous function alone"` — first-order propagation; the exact
  boundary of implicit await, and the same three [Ch 2 § async] cites.
- `tests/frontend/effects.test.ts` > `"resolves a callee bound to a parameter and awaits it"`,
  > `"keeps a parameter call synchronous when only sync functions flow in"`,
  > `"resolves a callee bound to a variable"`,
  > `"threads a callee through two levels of parameter passing"` — the 0-CFA callee resolution:
  `bindArguments`, `bindClosure` and the transitive case.
- `tests/frontend/effects.test.ts` > `"merges every function that flows into one parameter"`
  and > `"stays synchronous when only sync functions are merged"` — what monovariance costs,
  and that merging is not the same as giving up.
- `tests/frontend/effects.test.ts` > `"awaits a call through a binding it cannot resolve"`,
  > `"awaits a parameter call when nothing ever flows in"`,
  > `"does not treat an unknown global as an unresolved closure"` — the direction of the
  over-approximation, and its limit.
- `tests/frontend/effects.test.ts` > `"reaches a fixpoint on a self-recursive sync function"`
  and > `"propagates async through mutual recursion"` — the worklist terminates, and reaches
  facts no single walk order could.
- `tests/e2e/language/effects.test.ts` > `"keeps the declared async domain types in sync with the native classes"`
  — `DataFrame` and `Trainer` really do have async methods; `Linear` and `DataLoader` do not.
- `tests/e2e/language/effects.test.ts` > `"awaits a domain method without an await keyword"`,
  > `"propagates the effect through user functions"`, > `"still honours an explicit await"`,
  > `"leaves synchronous code untouched"` — the same rules, run rather than inspected.
- `tests/e2e/frontend/checker.test.ts` > `"types async function calls as Promise and unwraps them with await"`
  — the one wrap at `infer.ts:405` and the one unwrap at `infer.ts:106-107`.
- `tests/e2e/frontend/checker.test.ts` > `"checks async return bodies against the resolved type, not the Promise"`
  and > `"accepts a Promise of the resolved type returned from an async function"` — the two
  halves of `checkReturn`'s union.
- `tests/e2e/frontend/checker.test.ts` > `"propagates Promise value types through chained callbacks"`
  and > `"respects generic variance when comparing Promise<T> (covariant)"` — `awaitedType`
  distributing and `Promise<T>` under [Ch 10]'s assignability.
- `tests/e2e/optimizing/aot/async-suspend.test.ts` > `"declines a promise used as a plain value rather than reordering it"`
  — `misusedPromise`, asserted by substring on `used as a plain value`. The title is generated
  from the table at `tests/e2e/optimizing/aot/async-suspend.test.ts:1203-1209`.
- `tests/e2e/docs/book-examples.test.ts` > `"stats-async.tera prints what the book says it prints"`
  — the running example's async variation answers `latency mean=15.70` and
  `throughput mean=898.19`, the same two lines as the spine. One default-configuration run.
- That `unit.async` is never seeded from the `async` keyword: **[unpinned]**.
- That a name collision across two functions merges their flow sets: **[unpinned]**.
- That `stats-async.tera` agrees across tiers: **[unpinned]**. It is worth naming precisely,
  because this is the one example file that *could* be pinned. `differential()`
  (`tests/helpers/tiers.ts:44-52`) refuses any source whose last non-blank line begins with
  `print(`, and seven of the eight files in `docs/example/` end that way —
  `stats-async.tera`, whose last line is `main()`, is the exception. No test passes it to
  `differential()`.
