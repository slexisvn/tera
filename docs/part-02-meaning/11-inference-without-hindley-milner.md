# 11. Inference without Hindley-Milner   ⟨— · — · J · N⟩

Line 8 of `docs/example/stats-closure.tera` reads `scaled: float[] = values.map(double)`.
Nothing in that line says what `map` returns. `Array.map` is generic; its answer depends on
what the callback answers, and the callback is a variable holding a function that was built
by another function two lines earlier. The checker has to work it out, and it does — it
answers `float[]`, and it would have answered `string[]` if the callback had returned text.

Almost every book about type inference would tell you how that works: introduce a type
variable for the unknown, walk the program collecting equality constraints, solve them with
unification, and generalize the solution at each `let`. That algorithm is Hindley-Milner,
it is fifty years old, it is beautiful, and **tera does not use it**. Not a partial version,
not a simplified version — there is no type variable, no constraint store, no occurs check,
no substitution composition and no generalization anywhere in this engine.

That is a decision, not an omission, and this chapter argues it. Two facts about tera make
unification the wrong instrument. The first is `[Ch 9 § the-one-line-decision]`: a type here
is a **string**. A Hindley-Milner type variable is a mutable cell that other types point at,
so that binding one place updates every place at once; you cannot point at a substring. The
second is that tera has **no polymorphic `let`**. A type parameter can be introduced in
exactly one place — written by hand, in a `<T>` list on a declaration — and there is nowhere
in the grammar for the checker to invent one. Generalization has no site to happen at. What
replaced unification is *contextual typing*: instead of inventing an unknown and solving for
it later, the checker pushes the type it already expects **down** into the expression, and
the expression reads it. Where a general answer is genuinely needed, tera does not compute
one; it compiles a specialized copy instead — `[Ch 58 § a-parameter-that-is-only-ever-called]`.

There is a second half to this chapter that has nothing to do with typing theory. The types
`inferExpression` works out are not only reported — some of them are **written back onto the
parser's AST**. `adoptContextualSignature` stamps `_paramInfo` and `_returnType` onto arrow
and function nodes, and that stamp is the only channel by which anything the checker learned
reaches a compiled tier. The checker is optional for three of the four machines. For the
fourth it is a compiler pass, and this is the pass.

**What arrived.** From `[Ch 10 § what-leaves]`: `compatible(actual, expected, env)`, the
assignability order; `leastUpperBound(types, env)`, the join, which answers `TypeName | null`;
and `constructorVariance(owner)`, consulted only through the nominal walk. All three are
called here without being re-derived. From `[Ch 8 § one-scope-per-declaration-and-who-owns-this]`:
the `Scope` chain, with one scope per declaration, `this` bound where a class member owns it,
and every declared `Signature` — name, positional parameter list, `params` map, `returns`,
`typeParams` — already carrying canonical type text in every slot.

## Two directions

> **New idea. Bidirectional typing, or: inference up, checking down.** There are two ways to
> learn the type of an expression, and a real checker uses both.
>
> **Synthesis** goes *up*. You look at the expression and its parts and produce an answer
> from nothing: the literal `1` is an `int`, `a + b` is whatever the operator rule says about
> the types of `a` and `b`, `f(x)` is `f`'s return type. Nothing outside the expression is
> consulted. This is "inference" in the ordinary sense.
>
> **Checking** goes *down*. You already know what type is wanted here — because a variable
> was declared, or a parameter was declared, or a `return` is inside a function with a
> declared return type — and you push that expectation into the expression. Some expressions
> can only be typed this way. `x => x * 2` has no type of its own: `x` has no annotation, so
> there is no answer until something says what `x` is. Hand that same lambda to a slot
> declared `(float) -> float` and the answer is immediate.
>
> A checker that does both is **bidirectional**. The practical payoff is that annotations
> pay for themselves at a distance: one annotation on a variable can type a lambda, its
> parameter, the method calls in its body, and the type of the whole call it sits inside.

tera threads both directions through one function. `inferExpression` (`infer.ts:52-58`) takes
the node — which goes up — and two optional parameters that come down:

```ts
export function inferExpression(
  node: ASTNode | undefined,
  bound: BoundProgram,
  scope: Scope,
  expected?: Signature | null,
  expectedType?: TypeName | null,
): TypeName {
```
— `src/frontend/checker/infer.ts:52-58`

Two context parameters, not one, and the difference matters. `expectedType` is the expected
type as **text** — `"float[]"`, `"(float) -> string"` — used by array literals, ternaries and
the final `compatible` comparison. `expected` is the same information already **parsed into a
`Signature`**, which is what a lambda needs: a lambda has to look up parameter *i* by
position and read its type, and it cannot do that from a string. Callers build the second
from the first with `functionSignatureForType(name, type)` (`infer.ts:512-515`), which is
`parseFunctionType` with a name attached and answers `null` when the expected type is not a
function type at all.

## The syntax-directed skeleton

`inferExpression` is a `switch` over `NodeType` with twenty-two cases and a `default` that
answers `"unknown"` (`infer.ts:60-121`). That is the entire structure. There is no worklist,
no constraint store, no fixpoint iteration and no second pass over the tree: one recursive
descent, one answer per node, and the recursion bottoms out at literals and identifiers.

```ts
    case NodeType.Literal:
      return literalType(node);
    case NodeType.Identifier: {
      const name = String(node.name);
      const sig = lookupSignature(scope, name);
      return lookup(scope, name)?.type ?? (sig ? signatureType(sig) : "unknown");
    }
```
— `src/frontend/checker/infer.ts:61-67`

`literalType` (`:124-134`) is where the language's one number-literal subtlety lives: a
numeric literal is `float` if its **raw source text** contains `.`, `e` or `E`, and otherwise
`int` if the value is an integer. `1.0` is a `float` even though its value is a whole number,
because `node.__raw` — the characters the lexer saw — is consulted, not the double. `12.5`
and `9.0` in `stats.tera:20` are both `float` for the same reason, and that is why the array
literal joins to `float[]` rather than to something mixed.

Most cases synthesize and discard the context. Only a few forward it, and the list is short
enough to give in full:

| Node | What it does with `expected` / `expectedType` |
| --- | --- |
| `ArrayExpression` | forwards `expectedType` to `inferArray`, which extracts the element type and pushes that down per element |
| `SequenceExpression` | forwards **both**, unchanged, to the last expression |
| `YieldExpression` | forwards **both**, unchanged, to the operand |
| `ConditionalExpression` | forwards `expectedType` to each arm and passes `null` for `expected` |
| `ArrowFunctionExpression` | *consumes* `expected` — this is the context's destination |
| `FunctionExpression` | *consumes* `expected`, and answers `signatureType(expected)` or `"Function"` |

Everything else — assignment, member access, index, call, `new`, binary, unary, template,
`await` — drops both. That is not an oversight in most cases: a call's type comes from its
callee's signature, and no expectation can change it.

It **is** an oversight in one case, and it is visible from the command line.

> **Broken.** `inferExpression`'s `ConditionalExpression` case
> (`src/frontend/checker/infer.ts:115-116`) passes `null` where `expected` should be
> forwarded, although it forwards `expectedType`. A lambda written directly into a declared
> function-typed slot gets its context; the same lambda inside a ternary arm does not, and is
> typed `(any) -> unknown`:
>
> ```
> $ node dist/cli.js check -e 'f: (float) -> string = x => x.to_fixed(2)
> print(f(1.0))'
> $ echo $?
> 0
> $ node dist/cli.js check -e 'f: (float) -> string = true ? x => x.to_fixed(2) : x => x.to_fixed(1)
> print(f(1.0))'
> [eval]:1:24: error: Type '(any) -> unknown' is not assignable to '(float) -> string'
> $ echo $?
> 1
> ```
>
> The *diagnostic* path does not have this hole: `checkConditional`
> (`src/frontend/checker/type-checker.ts:740-760`) forwards `expected` into both arms through
> `checkExpectedExpression`, which routes an arrow to `checkArrow` with the context intact
> (`:801-803`). So the parameters are stamped correctly and the arm bodies are checked
> correctly; only the *answer* `inferExpression` computes for the whole ternary is wrong, and
> that answer is what `checkVar` compares. Cost of fixing: forwarding one argument, exactly
> as `SequenceExpression` and `YieldExpression` already do at `:106` and `:110`.

## Where a context comes from

A context is not ambient. Someone builds it, at a call site, from something the user wrote.
There are four such sites, and each corresponds to a place a tera program can put an
annotation.

**A declared variable type.** `checkVar` (`type-checker.ts:516-526`) cleans the annotation,
and if it is anything but `"any"` builds a signature from it:

```ts
    const expectedType = node.declaredType ? declared : previous?.type ?? null;
    const expected = expectedType && expectedType !== "any" ? functionSignatureForType(node.name, expectedType) : null;
    if (node.declaredType && expected) this.bindDeclared(scope, node.name, declared, expected);
    const actual = inferExpression(node.value, this.bound, scope, expected, expectedType);
```
— `src/frontend/checker/type-checker.ts:523-526`

Line 525 is worth a second look. Before inferring the value, the *name being declared* is
bound to its declared signature. That is why
`[t: tests/frontend/checker/type-checker.test.ts > "lets a lambda with a declared function type call itself"]`
passes: `fact: (int) -> int = n => n < 2 ? 1 : n * fact(n - 1)` can see `fact` inside its own
initializer, because the annotation was installed first.

**A parameter type.** Inside `instantiateForCall` (`infer.ts:335`), each argument is inferred
with the *parameter's* declared type as its context. This is the source that types the
callback in `values.map(...)`.

**An array element type.** `inferArray` (`:138-140`) resolves the expected type, and if it is
an ordinary array rather than a tuple, takes `arrayElementType` of it and hands that to every
element through `arrayElementTypes` (`:152-169`). One annotation on the array types every
lambda inside it
`[t: tests/frontend/checker/type-checker.test.ts > "types a lambda inside an array literal from the declared element type"]`.

**A return type.** `checkReturn` (`type-checker.ts:589`) builds
`functionSignatureForType("<return>", resolved)` from the enclosing function's declared
return, so a returned lambda is checked against it. For an `async` function the context is
the *awaited* type, and the comparison is against a union of that and the promise form
(`:587-588`) — which is `[Ch 14 § checkreturn-accepts-both-shapes]`'s subject and not
re-derived here.

A fifth site is internal rather than user-facing: `checkArrow` (`:851-853`) builds a
`<return>` context out of the expected signature's own return type and hands it to the
lambda's body, which is how currying works —
`[t: tests/frontend/checker/type-checker.test.ts > "types nested lambdas through a curried return type"]`
types both parameters of `f: (int) -> (int) -> int = a => b => a + b` from one annotation.

## How a lambda reads its context

`inferArrow` is the consumer, and it is twenty-five lines:

```ts
function inferArrow(node: ASTNode, bound: BoundProgram, scope: Scope, expected: Signature | null): TypeName {
  const child: Scope = { parent: scope, locals: new Map(), signatures: new Map(), signature: expected ?? undefined };
  const params = node.params as Array<string | { name?: string }>;
  const paramTypes = arrowParameterTypes(node, expected);
  for (let i = 0; i < params.length; i++) {
    const paramName = typeof params[i] === "string" ? params[i] as string : String((params[i] as { name?: string }).name ?? `arg${i}`);
    child.locals.set(paramName, { type: paramTypes[i]!, optional: false });
  }
```
— `src/frontend/checker/infer.ts:445-452`

A child scope is created, the parameters are entered into it with their types, and the body
is inferred inside it. Where those types come from is one line:

```ts
function arrowParameterTypes(node: ASTNode, expected: Signature | null): TypeName[] {
  const declared = declaredParamInfo(node);
  return (node.params as Array<string | { name?: string }>).map(
    (_, i) =>
      writtenType(expected?.params.get(expected.positional[i])?.type, declared?.[i]?.type) ?? "any",
  );
}
```
— `src/frontend/checker/infer.ts:437-443`

`writtenType` (`:430-435`) returns the first of its candidates that is not "unwritten", where
`isUnwrittenType` (`src/core/type-text.ts`) means absent or `"any"`. The **contextual type is
offered first** and the lambda's own annotation second. That ordering looks backwards — you
would expect what the user wrote to win — and it is not, because of what
`adoptContextualSignature` does with the result: a lambda that spells out its own parameter
type has that type already in `_paramInfo`, and the write-back's guard refuses to overwrite a
written entry. The precedence in `arrowParameterTypes` therefore only ever fires where the
declared entry is missing or `"any"`
`[t: tests/frontend/checker/type-checker.test.ts > "keeps the annotation the lambda spells out itself"]`.

Then the return, at `:453-467`. The contextual return type is `writtenType(expected?.returns,
node._returnType)`. If the body is an expression, it is inferred inside the child scope with
that contextual return pushed down one more level. If the body is a block, the contextual
return is used as-is, or `"any"`.

That second branch is worth being precise about, because the outline this chapter was drafted
from described it as a live gap and it is not one.

> **Dead.** `inferArrow`'s block-body branch (`src/frontend/checker/infer.ts:459-460`) cannot
> be reached from tera source. `parseArrowFunction`
> (`src/frontend/parser/index.ts:2139-2158`) ends with `this.parseExpression()` — there is no
> block-bodied `=>` in the grammar, and `values.map(x => { return x * 2 })` is a parse error
> (`Expected ',', got 'x'`). The only `ArrowFunctionExpression` in the tree carrying a
> `BlockStatement` body is the list-comprehension desugaring at
> `src/frontend/parser/index.ts:2256-2262`, and that node is intercepted by
> `arrayComprehensionType` (`infer.ts:400-401`) and `comprehensionOf`
> (`type-checker.ts:602-606`) before `inferArrow` sees it. Cost of removing: two lines, plus
> deciding whether a block-bodied lambda is a language feature anyone wants. Cost of
> *keeping* it correct if the grammar ever grows one: walking the block's `return`
> statements the way `inferReturnType` (`type-checker.ts:482-491`) already does for declared
> functions.

The related test title is misleading and worth flagging once, per `docs/CONVENTIONS.md` rule
4: `tests/frontend/checker/type-checker.test.ts:142` is called
`"types the parameter even when the body is a block"`, but its fixture is `apply(n => n * 2, 4)`
— an expression body. What it actually pins is that a lambda passed as an argument gets its
parameter type stamped from the parameter it is passed to.

## Why the obvious design fails: one pass over the arguments

Here is the argument loop a first implementation writes. Walk the arguments left to right.
For each one, build its context from the parameter type with whatever substitutions are known
so far, infer it, and unify the result back into the substitution map. One pass, in source
order, which is how a reader expects arguments to be processed.

Now run it on `reduce`. `arrayMethodSignature` manufactures it as
`(fn: (U, float, int) -> U, initial: U) -> U` for a `float[]` (`infer.ts:690-692`), and a
call looks like `xs.reduce((acc, x) => acc + x, 0.0)`. The **lambda comes first**. On the
first iteration `U` is unbound, so the lambda's contextual signature is `(U, float, int) -> U`
with `U` still a bare name; `acc` is typed `"U"`, which is not a type any operator knows; the
body's answer is garbage. The thing that *would* have bound `U` — the second argument, `0.0`,
a plain `float` — has not been looked at yet.

The failure is not an edge case. It is structural: in every callback-taking signature the
callback is the argument whose type most depends on the others, and it is conventionally
written first.

## The fix: two passes filtered on shape

```ts
  for (const pass of [false, true]) {
    for (const pair of pairs) {
      if ((parseFunctionType(pair.type) !== null) !== pass) continue;
      const resolved = substituteType(pair.type, substitutions);
      const expectedSig = functionSignatureForType(pair.name, resolved);
      const actual = inferExpression(pair.value, bound, scope, expectedSig, resolved);
      unifyTypeParams(pair.type, actual, sig.typeParams, substitutions);
    }
  }
  for (const typeParam of sig.typeParams) {
    if (!substitutions.has(typeParam)) substitutions.set(typeParam, "unknown");
  }
  return instantiateSignature(sig, substitutions);
```
— `src/frontend/checker/infer.ts:331-343`

Two passes over the same argument list. The filter on line 333 is the whole idea, and it is
worth reading carefully: it tests `pair.type`, the **declared parameter type**, not the
argument. Pass one (`pass === false`) runs every parameter whose declared type is *not* a
function type; pass two runs every parameter whose declared type *is* one. So ordinary
arguments are matched first and their type parameters bound, and only then is any lambda's
contextual signature built — line 334 applies the substitutions accumulated so far before
line 335 parses the context. `reduce`'s `initial: U` is an ordinary parameter, so `U := float`
is settled in pass one, and the lambda in pass two is checked against `(float, float, int) -> float`.

The invariant, stated plainly: **a lambda's contextual signature is never built from a type
parameter that an ordinary argument could have fixed.** Nothing asserts it, but it is
enforced structurally — the filter cannot be satisfied out of order — and it is fuzzed
`[t: tests/e2e/frontend/checker-spec-fuzz.test.ts > "fuzzes contextual arrow bodies from annotations and callback parameters"]`.

Line 341 is the closing rule. Any type parameter still unbound after both passes is set to
`"unknown"`, not left free. There is no such thing as an unresolved type variable escaping
this function; `instantiateSignature` gets a total substitution every time.

Now `stats-closure.tera:8`, all the way through. `values` is `float[]`, so
`arrayMethodSignature` builds `Array.map` as `(fn: (float, int) -> U) -> U[]` with
`typeParams: ["U"]` (`infer.ts:676`). There is one argument, and the parameter's declared type
is a function type, so pass one skips it and pass two runs it. `double` is a plain identifier
whose binding type is `(float) -> float` — `scaler`'s declared return, normalized by
`cleanType`. `unifyTypeParams` is handed the parameter type `(float, int) -> U` and the actual
`(float) -> float`; both parse as function types, so it walks positionally as far as the
shorter list allows (one parameter, `float` against `float`, no binding), then the returns:
`U` against `float`, and `U` is in `typeParams`, so `U := float`. `map` answers `float[]`, and
the declared `scaled: float[]` accepts it. Change the annotation and the checker names the
answer it computed:

```
$ node dist/cli.js check -e 'fn scaler(factor: float) -> fn(float) -> float:
  fn scale(x: float) -> float:
    return x * factor
  return scale
values: float[] = [12.5, 9.0]
double = scaler(2.0)
n: int = values.map(double)
print(n)'
[eval]:7:10: error: Type 'float[]' is not assignable to 'int'
```

The lambda form of the same call shows the other half — the context flowing *into* an
unannotated parameter:

```
$ node dist/cli.js check -e 'values: float[] = [1.0]
n: int = values.map(x => x.to_fixed(2))
print(n)'
[eval]:2:10: error: Type 'string[]' is not assignable to 'int'
```

`to_fixed` is a `float` member. For it to resolve at all, `x` must have been typed `float`,
and the only place that could come from is `map`'s parameter type pushed down. Then `U` took
`string` from the body, so the call answers `string[]`. Two facts, one diagnostic.

## Matching, not unification

`unifyTypeParams` is the closest thing in this engine to a unifier, and reading it beside a
real one is the fastest way to see how much is missing.

```ts
function unifyTypeParams(paramType: TypeName, actualType: TypeName, typeParams: string[], subs: Map<string, TypeName>): void {
  const param = cleanType(paramType);
  if (typeParams.includes(param)) {
    if (!subs.has(param)) subs.set(param, actualType);
    return;
  }
  const paramFn = parseFunctionType(param);
  const actualFn = parseFunctionType(actualType);
  if (paramFn && actualFn) {
    for (let i = 0; i < paramFn.positional.length && i < actualFn.positional.length; i++) {
      unifyTypeParams(paramFn.params.get(paramFn.positional[i])!.type, actualFn.params.get(actualFn.positional[i])!.type, typeParams, subs);
    }
    unifyTypeParams(paramFn.returns, actualFn.returns, typeParams, subs);
    return;
  }
```
— `src/frontend/checker/infer.ts:346-360`

It is **one-directional structural matching**. The first argument is a pattern; the second is
a value. If the pattern *is* a type parameter, bind it — and `if (!subs.has(param))` means
**first binding wins**, so a later, different observation is discarded rather than reconciled.
Otherwise recurse pairwise through the three shapes that can hold a parameter: function types
(`:352-360`), array elements (`:361-366`), and same-named generics (`:367-373`). Position
mismatches are tolerated everywhere by looping to the *shorter* of the two lists.

Now the list of things it is not.

- **No type variables.** A type parameter is a name that appears in a string. There is no
  cell to point at, no union-find, and no way for two occurrences to become the same object.
- **No constraint store.** Bindings go straight into a `Map<string, TypeName>` as they are
  discovered. Nothing is deferred, so nothing has to be solved.
- **No occurs check.** An occurs check exists to reject `T := List<T>`, which can only arise
  when a variable is bound to a term containing itself. Since bindings are immediate and
  one-directional, the situation does not arise, so the check is not needed and is not there.
- **No substitution composition.** Substituting into an existing binding never happens.
  `substituteType` is applied to *parameter types* (`:334`) before they are used as context;
  the substitution map itself is never rewritten.
- **No generalization.** Nowhere does a type become "∀T. …". `typeParams` arrives already
  written on the signature and is consumed; it is never produced.
- **No unbound propagation.** Line 341 fills every leftover with `"unknown"`.
- **Not symmetric.** A unifier treats its two arguments alike. This does not, and the
  asymmetry is observable.

```
$ node dist/cli.js check -e 'fn pair<T>(a: T, b: T) -> T:
  return a
n: int = pair(1, "x")
print(n)'
[eval]:3:18: error: Type 'string' is not assignable to parameter 'b: int'
$ node dist/cli.js check -e 'fn pair<T>(a: T, b: T) -> T:
  return a
n: int = pair("x", 1)
print(n)'
[eval]:3:20: error: Type 'int' is not assignable to parameter 'b: string'
```

The same conflict, blamed on a different argument depending on which one came first. A
unifier would report one failure to unify `int` with `string`, symmetrically, at neither
site in particular. Which of those two diagnostics is better is a real question, and the
answer here is not obvious: "the second argument does not match the first" is a sentence a
programmer can act on, and "cannot unify `int` with `string`" is not, unless you know where
each came from.

Note also that the declared `n: int` had no effect. `T` is decided entirely by the arguments;
the expected type of the whole call never reaches `instantiateForCall`. tera's contextual
typing flows into *callbacks*, not into type-parameter solving.

## The fallback that is not matching at all

The last three lines of `unifyTypeParams` are not structural matching, and they are the
source of one of this book's more instructive bugs:

```ts
  for (const typeParam of typeParams) {
    if (!subs.has(typeParam) && new RegExp(`\\b${typeParam}\\b`).test(param)) subs.set(typeParam, actualType);
  }
```
— `src/frontend/checker/infer.ts:375-377`

If none of the structural cases matched, and a type parameter's *name occurs as a word
anywhere in the parameter's type text*, bind it to the **whole** actual type. This exists
because the structural cases cover only three shapes: a parameter buried in a tuple, an
object literal, a union or an intersection would otherwise never be bound at all, and would
end up `"unknown"`. The fallback catches those, crudely, and in practice usually right —
because the crude answer is only reached when the precise one was unavailable.

The failure mode is that "occurs as a word" is a property of *text*, and type text contains
words that are not types.

> **Broken.** `unifyTypeParams`'s name-occurrence fallback
> (`src/frontend/checker/infer.ts:375-377`) tests
> `new RegExp("\\b" + typeParam + "\\b").test(param)` against the parameter type's whole
> string, which matches a **field name**. Paired with `substituteType`
> (`src/frontend/checker/type-system.ts:335-341`), which replaces by the same kind of
> word-boundary regex, a type parameter named `T` collides with a field named `T`:
>
> ```
> $ node dist/cli.js check -e 'fn pick<T>(row: { T: string }, v: T) -> T:
>   return v
> print(pick({ T: "a" }, 1))'
> [eval]:3:24: error: Type 'int' is not assignable to parameter 'v: {T: string}'
> $ node dist/cli.js check -e 'fn pick<Elem>(row: { T: string }, v: Elem) -> Elem:
>   return v
> print(pick({ T: "a" }, 1))'
> $ echo $?
> 0
> ```
>
> The mechanism: `row`'s declared type `{T: string}` is not a function, array or generic, so
> the structural cases decline; `\bT\b` matches the field name; `T := {T: string}` is
> recorded; `substituteType` then rewrites `v`'s type from `T` to `{T: string}`, and `1`
> does not fit. Renaming the type parameter makes the identical program legal. Cost of
> finishing: structural substitution over parsed types instead of text — which is exactly
> the type parser `[Ch 9 § the-one-line-decision]` was chosen to avoid, so the fix is not
> local. **[unpinned]**: no test in `tests/` covers this interaction.

The general rule this produces is worth stating once, because it recurs: **a textual
representation is sound only while every name in it belongs to one namespace.** Type text
here mixes type names and field names in one string, and every operation defined by regex
over that string inherits the collision. `[Ch 9 § what-it-costs-honestly]` records the same
defect on the substitution side.

## The write-back

Everything so far produces answers. This function produces a **compiler output**.

```ts
  for (const param of functionParameters(node)) {
    const name = parameterName(param);
    if (name === null) continue;
    const existing = known.get(name) ?? { name };
    const contextual = isRestParameter(param) ? undefined : positionalTypes[positional++];
    if (!isUnwrittenType(existing.type) || isUntypedName(contextual)) {
      adopted.push(existing);
      continue;
    }
    adopted.push({ ...existing, type: contextual });
    changed = true;
  }
  if (changed && adopted.length === (declared ?? adopted).length) node._paramInfo = adopted;
  if (!isUntypedName(returns) && typeof node._returnType !== "string") node._returnType = returns!;
```
— `src/frontend/ast/index.ts:310-323`

Four rules, all of them conservative.

**A written entry is never overwritten.** `!isUnwrittenType(existing.type)` keeps whatever the
user spelled.

**An unhelpful context is never adopted.** `isUntypedName(contextual)` rejects `"any"` and
absent, so a context that knows nothing writes nothing
`[t: tests/frontend/checker/type-checker.test.ts > "records nothing when the lambda has no contextual type"]`.

**Rest parameters are skipped** and do not consume a positional slot (`:314`), so a lambda
with a rest parameter cannot shift the remaining types by one.

**The commit is all-or-nothing.** Line 322 writes `_paramInfo` only if something changed
*and* the rebuilt list is the same length as the one that was there. A partial adoption is
discarded rather than stored.

The return is written only when the node does not already have one (`:323`), and it is
written from a *different* call than the parameters. `checkArrow` stamps twice, deliberately:

```ts
    if (expected) adoptContextualSignature(node, positionalTypesOf(expected), null);
```
— `src/frontend/checker/type-checker.ts:847`

```ts
    adoptContextualSignature(node, [], returns);
```
— `src/frontend/checker/type-checker.ts:860`

The first call happens before the body is looked at: parameters come from the expected
signature, and `null` is passed for the return because it is not known yet. The second happens
only after the body has been inferred *and* found compatible with the declared return
(`:855-859`) — so a lambda whose body does not match its context is reported and **not**
stamped. `checkComprehension` (`:364`) makes a third kind of call, stamping only the return
type of the arrow the comprehension desugaring produced.

> **Unenforced.** `adoptContextualSignature` mutates a shared AST node, and nothing asserts
> that it runs at most once per node or that a second context cannot be weaker than the
> first. The only guard is `isUnwrittenType` on the *existing* entry — which a prior stamp
> already satisfies, so a first stamp does block a second, but nothing establishes that the
> first one to arrive is the best one available. In the single-pass checker the walk order
> makes this unreachable; it is a property of the traversal, not of the function. Cost of
> finishing: recording provenance on `_paramInfo` entries, or asserting idempotence in a
> test.

## Who reads it

`_paramInfo` and `_returnType` live on the parser's AST, which the bytecode compiler walks —
`[Ch 8 § the-collapse]` established that the semantic tree is the *checker's* tree and that
the compiler keeps using the parser's. `declaredSignatureOf`
(`src/bytecode/register/compiler/functions.ts:165-175`) reads both off the node and, if
either is present, builds a `DeclaredSignature` that is hung on the compiled function at
`functions.ts:715`. From there it reaches exactly four consumers, all of them in the
optimizing half of the engine: `src/optimizing/analyses/aot-legality.ts` (nine sites),
`src/optimizing/analyses/type-inference.ts:46-47` and `:76`, and the two native lowerings at
`src/optimizing/backends/x64/lowering.ts:369-370` and
`src/optimizing/backends/riscv64/lowering.ts:255-256`.

Nothing in the interpreter or the baseline compiler reads it. That is the concrete meaning of
this chapter's tier badge, and it makes the consequence sharp: **a lambda that never got a
contextual type is a lambda the ahead-of-time compiler cannot type.** The two halves of that
sentence can be run side by side.

```
$ cat hof.tera
fn apply(f: (int) -> int, x: int) -> int:
  return f(x)

print(apply(n => n * 2, 21))
$ node dist/cli.js compile hof.tera -o hof.exe
tera compile: wrote ...\hof.exe
$ ./hof.exe
42
```

Now delete one annotation — `f`'s — and nothing else:

```
$ node dist/cli.js compile hof2.tera -o hof2.exe
tera compile: note: '<arrow>' is not in the binary, and nothing the program runs calls it (x64-windows backend cannot emit: parameter #1 has no declared type; declare it, or keep this part interpreted)
tera compile: wrote ...\hof2.exe
$ ./hof2.exe
42
```

The binary still prints `42`, because monomorphisation
(`[Ch 58 § a-parameter-that-is-only-ever-called]`) specialized `apply` on its one function
argument and inlined the lambda, so the lambda's own signature was never needed. But the
*note* names the machinery exactly: with `f: (int) -> int` present, `instantiateForCall`
built a context, `checkArrow` stamped `n: int` into `_paramInfo`, `declaredSignatureOf` found
it, and the arrow was typable. Without it, the arrow has parameter #1 with no declared type,
and the backend says so. `[Ch 56 § the-shape-of-a-refusal]` is where that sentence's grammar
is designed.

## What was tried and rejected: type variables

A Hindley-Milner front end for tera is not hard to picture. Give every unannotated binding a
fresh type variable, walk the program emitting equality constraints, solve by unification,
generalize at each binding site, instantiate at each use. It would infer principal types —
the most general type any correct implementation could have — for functions nobody annotated.
Four things make that the wrong instrument here, and none of them is "it was too hard".

**A type is a string.** Unification's central operation is binding a variable so that every
type mentioning it changes at once, which requires the variable to be a shared, mutable
node in a graph of types. `TypeName = string` gives you the opposite: an immutable value in
which a "variable" is a substring, and updating it means rewriting the text — which is
`substituteType`, and which is exactly the operation this chapter's `> **Broken.**` item is
about. Adding unification means first adding a parsed type representation with identity,
which is the design `[Ch 9 § the-one-line-decision]` deliberately declined, and which would
have to be threaded through every consumer of type text: the bytecode compiler's declared
signatures, the middle end's lattice, the class table, the module interface, the REPL symbol
stream. Unification is not a front-end change; it is a change to the interchange format of
the whole stack.

**There is no polymorphic `let`.** Generalization is the interesting half of Hindley-Milner,
and it happens at `let`. tera has no `let`
(`[Ch 8 § three-lines-that-decide-what-a-bare-x-means]` — a binding is `name = value` or
`name: type = value`), and more importantly it has no site where a *new* type parameter could
be introduced by the checker. Type parameters come from a written `<T>` list and nowhere else;
`parseTypeParams` reads them, `instantiateForCall` consumes them, and no function in the tree
produces one. Without a generalization site, unification's output is a solved substitution
that is thrown away at the end of each call. That is precisely what `instantiateForCall`
already computes, with a `Map` and two loops.

**Every call site is known.** The ahead-of-time compiler's entry function takes no parameters,
and the whole program is compiled together. A principal type answers "what is the most general
type this function could be used at" — a question worth asking when the callers are unknown,
because a library must serve callers that do not exist yet. Here the callers all exist, in the
same graph, and the backend's next move is to *discard* the general answer and specialize:
`[Ch 58 § a-parameter-that-is-only-ever-called]` compiles one copy of a higher-order callee
per function argument, precisely so that no code pointer is ever taken. Inferring a general
type in order to specialize it away is work the compiler pays for twice.

**Diagnostics get worse.** A unifier reports a failure where the constraint that happened to
be inconsistent was solved, which is often far from where a human would say the mistake is,
and phrases it in terms of two type expressions that may both be inferred. Contextual typing
always has the expected type in hand at the site, which is why the messages in this chapter
read as they do: `Type 'string[]' is not assignable to 'int'` names the annotation the user
wrote and the answer the checker computed, at the column of the value.

What landed instead is the machinery this chapter describes — contextual typing to push
annotations down, two-pass matching to resolve written type parameters, and monomorphisation
in the backend to handle the cases a polymorphic type would have covered. The judgement is
recorded nowhere in the tree except in its shape; this section is the record.

## What that costs

The bill is real and worth reading in full.

**No principal types, so an unannotated lambda has no type at all.** Hindley-Milner would give
`inc = n => n + 1` the type `(int) -> int` from its body. tera records nothing —
`signatures(src("inc = n => n + 1"))` yields `{ params: [], returns: undefined }`
`[t: tests/frontend/checker/type-checker.test.ts > "records nothing when the lambda has no contextual type"]`.
The value still runs, because the interpreter does not need a type. It just cannot be
compiled ahead of time, and it cannot be checked.

**Declaration order is semantics.** `inferReturnType` (`type-checker.ts:482-491`) fills in a
function's return type when the checker walks that function's body, and the checker walks the
program in source order. So the same two statements, in two orders, give two answers:

```
$ node dist/cli.js check -e 'fn later():
  return "x"
n: int = later()
print(n)'
[eval]:3:10: error: Type 'string' is not assignable to 'int'
$ node dist/cli.js check -e 'n: int = later()
fn later():
  return "x"
print(n)'
$ echo $?
0
```

A constraint solver would have collected both facts before solving either, and order would not
have mattered. This is one of the entries `[Ch 16 § single-pass-and-why-source-order-is-semantics]`
inventories, and this is its mechanism.

**First binding wins, so argument order can change an answer.** Shown above with `pair<T>`;
`unifyTypeParams:349` is the line.

**An immediately-invoked lambda gets none of this.** When an arrow is the callee of a call
rather than an argument to one, `callSignatureForCallee` (`:518`) routes to `arrowSignature`
(`:539-553`), which types **every parameter `"any"`** and consults no context whatever.

> **Unfinished.** `arrowSignature` (`src/frontend/checker/infer.ts:539-553`) gives every
> parameter of a directly-called arrow the type `"any"` and infers the return from the body
> in the *outer* scope. So an IIFE is unchecked end to end:
>
> ```
> $ node dist/cli.js check -e 's: string = ((x) => x * 2)(3)
> print(s)'
> $ echo $?
> 0
> ```
>
> `x` is `any`, `x * 2` is `any`, and `any` satisfies `string`. Cost of finishing: building a
> contextual signature from the call's own arguments — a third direction (arguments up into
> the callee's parameters) that this checker does not currently have.

**No generalization means a written `<T>` is the only polymorphism.** That is not much of a
loss in practice, because tera programs that need it write it; but it does mean a helper
cannot be *discovered* to be generic, only declared to be.

## What leaves

A type for every expression, and a mutation of the input tree.

The types are what `inferExpression` answers, node by node, for every expression the checker
visits — literals, identifiers, members, calls, lambdas, array and object literals,
comprehensions, awaits. They are consumed immediately by `compatible` for every diagnostic in
Part II, and they are harvested by the next chapter: `[Ch 12 § building-a-class-out-of-nothing]`
reads the inferred type of the right-hand side of every `this.x = ...` and turns a class body
that declares no fields into an `ObjectShape` with a type per field, joining repeated
assignments with `leastUpperBound` at `[Ch 12 § disagreement-widens-by-lub]`.

The mutation is `_paramInfo` and `_returnType`, stamped by `adoptContextualSignature` onto
arrow and function-expression nodes wherever a context supplied something the source did not.
That is the only artifact of the checker that survives into a compiled tier. Its route is
fixed and short: `declaredSignatureOf` (`bytecode/register/compiler/functions.ts:165`) →
`RegisterCompiledFunction.declaredSignature` → `aot-legality.ts`, `type-inference.ts`, and the
x64 and riscv64 lowerings. Nothing else in the engine reads a type the checker computed.

`[Ch 12 § new-idea-a-shape]` picks both of those up and asks what a `class` is, given that
nothing in `class Series` on line 1 of `stats.tera` declares a single field.

## Verify it yourself

```bash
# the running variation: map over a function value, answering float[]
node dist/cli.js docs/example/stats-closure.tera

# what map answered, named by a deliberate mismatch: U was matched to float
# through the function-typed argument in pass two
node dist/cli.js check -e 'fn scaler(factor: float) -> fn(float) -> float:
  fn scale(x: float) -> float:
    return x * factor
  return scale
values: float[] = [12.5, 9.0]
double = scaler(2.0)
n: int = values.map(double)
print(n)'

# the context flowing the other way: x took float from map's parameter type,
# which is the only reason to_fixed resolved; then U took string from the body
node dist/cli.js check -e 'values: float[] = [1.0]
n: int = values.map(x => x.to_fixed(2))
print(n)'
node dist/cli.js -e 'values: float[] = [1.5]
print(values.map(x => x.to_fixed(2)))'

# first binding wins: the same conflict, blamed on whichever argument came second
node dist/cli.js check -e 'fn pair<T>(a: T, b: T) -> T:
  return a
n: int = pair(1, "x")
print(n)'
node dist/cli.js check -e 'fn pair<T>(a: T, b: T) -> T:
  return a
n: int = pair("x", 1)
print(n)'

# the name-occurrence fallback: renaming the type parameter changes the answer
node dist/cli.js check -e 'fn pick<T>(row: { T: string }, v: T) -> T:
  return v
print(pick({ T: "a" }, 1))'
node dist/cli.js check -e 'fn pick<Elem>(row: { T: string }, v: Elem) -> Elem:
  return v
print(pick({ T: "a" }, 1))'

# the ternary drops the expected signature; the same lambda alone does not
node dist/cli.js check -e 'f: (float) -> string = x => x.to_fixed(2)
print(f(1.0))'
node dist/cli.js check -e 'f: (float) -> string = true ? x => x.to_fixed(2) : x => x.to_fixed(1)
print(f(1.0))'

# an immediately-invoked lambda is unchecked: x is any, so anything fits
node dist/cli.js check -e 's: string = ((x) => x * 2)(3)
print(s)'

# declaration order is semantics
node dist/cli.js check -e 'fn later():
  return "x"
n: int = later()
print(n)'
node dist/cli.js check -e 'n: int = later()
fn later():
  return "x"
print(n)'

npx vitest run --project unit tests/frontend/checker/type-checker.test.ts -t "contextual lambda signatures"
npx vitest run --project e2e tests/e2e/frontend/checker.test.ts
```

Every block above was run to produce the output this chapter quotes. The last two pass with
16 and 113 tests respectively. The `hof.tera` / `hof2.tera` pair in
`§ who-reads-it` is two four-line files that differ only in whether `apply`'s first parameter
carries `: (int) -> int`; both compile and both print `42`, and only the second emits the
note.

## Tests that pin this

- `tests/frontend/checker/type-checker.test.ts` > `"types a lambda parameter from the declared variable type"`
  and > `"types a lambda parameter from the parameter it is passed to"` — the first two of the
  four context sources, asserted on the stamped `_paramInfo` rather than on a diagnostic.
- `tests/frontend/checker/type-checker.test.ts` > `"types a lambda inside an array literal from the declared element type"`
  and > `"points at the lambda in an array literal whose result does not match"` — the third
  source, and that the diagnostic points at the lambda rather than at the array.
- `tests/frontend/checker/type-checker.test.ts` > `"types a returned lambda from the declared return type"`,
  > `"accepts a returned lambda that matches the declared return type"` and
  > `"reports a returned lambda whose result does not match"` — the fourth source, both
  outcomes.
- `tests/frontend/checker/type-checker.test.ts` > `"types nested lambdas through a curried return type"`,
  > `"accepts a curried lambda that matches the declared return type"` and
  > `"accepts a curried lambda that spells its own parameter types out"` — `checkArrow`'s
  internal `<return>` context, and that a lambda's own annotations survive it.
- `tests/frontend/checker/type-checker.test.ts` > `"keeps the annotation the lambda spells out itself"`
  — the write-back's first rule: a written entry is never overwritten.
- `tests/frontend/checker/type-checker.test.ts` > `"records nothing when the lambda has no contextual type"`
  and > `"leaves the return type open when the context returns nothing useful"` — the second
  rule: `isUntypedName` blocks an unhelpful context, and `void` counts as unhelpful.
- `tests/frontend/checker/type-checker.test.ts` > `"lets a lambda with a declared function type call itself"`
  — `checkVar:525` binding the declared name before inferring its own initializer.
- `tests/frontend/checker/type-checker.test.ts` > `"types the parameter even when the body is a block"`
  — pins that an argument lambda's parameter is stamped. The title says "block"; the fixture's
  body is an expression, and tera has no block-bodied arrow.
- `tests/e2e/frontend/checker.test.ts` > `"checks generic function calls and return statements from bound signatures"`
  and > `"context-checks fn-prefixed function variable annotations"` — `instantiateForCall`
  end to end, and that an `fn(...)`-spelled annotation normalizes into the same context a bare
  `(...) -> ...` would.
- `tests/e2e/frontend/checker.test.ts` > `"propagates Promise value types through chained callbacks"`
  — two passes and `unifyTypeParams` composing across a `.then(...).then(...)` chain.
- `tests/e2e/frontend/checker-spec-fuzz.test.ts` > `"fuzzes contextual arrow bodies from annotations and callback parameters"`,
  > `"fuzzes explicit generic type arguments against argument and return checking"` and
  > `"does not duplicate diagnostics while propagating expected types"` — the two-pass
  invariant, the explicit `<T>` path at `instantiateForCall:318-320`, and that pushing a
  context down does not report the same problem twice.
- The `unifyTypeParams` name-occurrence fallback and its collision with a field named `T`:
  **[unpinned]**.
- The dropped `expected` in `inferExpression`'s `ConditionalExpression` case: **[unpinned]**.
