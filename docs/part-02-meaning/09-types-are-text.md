# 9. Types are text   ⟨— · — · J · N⟩

Most compilers build a type into a data structure. A `float[]` becomes an object with a tag
saying "array" and a pointer to another object tagged "double"; comparing two types means
walking two graphs; passing a type across a stage boundary means serializing it or sharing
the allocator that made it. tera does none of that. Line 24 of
`src/frontend/checker/type-system.ts` reads `export type TypeName = string`, and it means
exactly what it says: from the annotation the user wrote to the machine scalar the AOT
backend assigns, a type in this engine is a normalized string.

That decision costs re-parsing at every layer, and it buys something the engine could not
easily get any other way: a type is a *value*. It is a map key with no hashing scheme, a
JSON field with no encoder, a `===` comparison that means type identity, and a token that
crosses from the checker to the bytecode compiler to the middle end's lattice to the
ahead-of-time class table with no adapter in between. It is also why there is no
Hindley-Milner here — a unification algorithm needs a type it can destructure and rebuild,
and this one has to be re-read from characters every time.

The whole format rests on one character of lookbehind. `splitTopLevel` counts bracket depth
so that a comma inside `Map<A, B>` does not split a parameter list, and it treats `>` as a
closing bracket — except when the character before it is `-`, because `->` is how tera
spells a function type. Delete that exemption and a single parameter whose type contains an
arrow becomes two parameters. This chapter walks the format from the parser's first
normalization to the C prototype it eventually becomes, and is honest about the three places
it leaks: a canonicalizer that is not idempotent, a splitter nothing checks for balance, and
a generic substitution that rewrites field names.

**What arrived.** From `[Ch 8 § what-leaves]`: a `SemanticProgram` of thirteen node kinds
and a `BoundProgram` whose `Signature`s, `Binding`s and `ObjectShape`s already hold
`TypeName` values. They already hold them *canonicalized*, because `signatureFromParams`
runs `cleanType` over every parameter type and the return type
(`src/frontend/checker/binder.ts:93` and `:103`), `bindNode` runs it over alias bodies,
interface fields, interface parents and indexer key and value types, and
`semantic-lowering.ts` ran it once already on the way in. Nothing downstream of the binder
sees a type the user spelled; it sees the canonical spelling of that type.

## The one-line decision

```ts
export type TypeName = string;
```
— `src/frontend/checker/type-system.ts:24`

It is a type alias with no runtime existence at all. Every place the engine says `TypeName`
it could have said `string`, and the compiler would emit identical code. The alias is
documentation — in a codebase with 26 comment lines, a name is the only comment available.

Four consequences follow immediately, and each one is visible in the tree.

**A type is a map key.** The memo that stops assignability from recursing forever is keyed
by the pair of types, concatenated:

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

No hash function, no interning table, no identity map. A NUL separator and template
interpolation. (`memo.set(key, true)` *before* recursing is the coinductive assumption that
`[Ch 10 § why-the-obvious-design-fails-recursion]` is about; here only the key matters.)

**A type serializes for free.** `moduleInterfaceOf`
(`src/frontend/modules/interface.ts:158`) publishes a module's exported surface as four
arrays of plain objects — `builtins`, `values`, `aliases`, `interfaces` — in which every type
is a `type: string` field. That object is `JSON.stringify`-able as it stands, which is what
makes `[Ch 15 § one-file-one-record]`'s cross-module checking a matter of handing one plain
record to `bindProgram`'s `imports` option rather than of sharing a type factory across
files.

**`actual === expected` is a legal fast path.** The second rung of `assignableUncached` is a
string comparison, and `[Ch 10 § the-five-answers-before-any-structure-is-looked-at]` shows
why it is sound rather than merely convenient. The soundness is one-directional and worth
stating precisely: equal strings mean the same type, but the same type does not always mean
equal strings. `cleanType("int | undefined")` and `cleanType("undefined | int")` are two
different strings, because union member order is preserved rather than sorted. The ladder
recovers by splitting both sides and comparing member-wise, which is why
`[t: tests/frontend/checker/type-system.test.ts > "reads a union as a set, so the order its members were written in does not matter"]`
passes. `===` is a shortcut, not the definition.

**A diagnostic can quote the compiler's own belief.** When the checker refuses something it
prints the canonical spelling, not the user's:

```
$ node dist/cli.js check -e 'xs: Array<float> = [1.0]
n: int = xs
print(n)'
[eval]:2:10: error: Type 'float[]' is not assignable to 'int'
```

The user wrote `Array<float>` and the compiler answered `float[]`. That is either a feature
or a leak depending on how well the normalizer works, and this chapter reaches a case where
it is a leak.

## Canonical form is what makes equality mean anything

A string comparison decides nothing unless one type has exactly one spelling. `cleanType`
is what makes that true. It is a rewrite chain applied in a fixed order, then a recursive
rebuild if the result turns out to be a function type:

```ts
  const normalized = canonical
    .replace(/\bboolean\b/g, "bool")
    .replace(/\bArray\s*<\s*([^>]+)\s*>/g, "$1[]")
    .replace(/\s*\[\s*\]/g, "[]")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .replace(/\{\s+/g, "{")
    .replace(/\s+\}/g, "}")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ");
  const unwrapped = withoutRedundantParens(normalized);
  const fn = parseFunctionTypeSource(unwrapped);
  if (!fn) return unwrapped;
  const params = splitTopLevel(fn.params, ",").map((param) => param.trim()).filter(Boolean).map((param) => cleanType(param)).join(", ");
  return `(${params}) -> ${cleanType(fn.returns)}`;
```
— `src/frontend/checker/type-system.ts:155-174`

Read it as a sequence of decisions about what tera's canonical type language *is*. There is
one spelling of the boolean type, and it is `bool`. There is one spelling of an array, and
it is the suffix, not the generic. Whitespace immediately inside a bracket, brace or paren
is not significant. A comma and a colon are followed by exactly one space; `|` and `&` are
surrounded by exactly one. Redundant outer parentheses come off — `withoutRedundantParens`
(`:177-185`) strips them in a loop, using `matchingParen` (`:207-218`) so it only removes a
paren that really wraps the whole type. And a function type is rebuilt from its parts, so
`fn(a: int)->int` and `( a : int ) -> int` both become `(a: int) -> int`.

Measured on this tree, all of these are the same eight characters:

```
cleanType("float[]")                           "float[]"
cleanType("Array<float>")                      "float[]"
cleanType("float [ ]")                         "float[]"
cleanType("  float[]  ")                       "float[]"
cleanType("Array < float >")                   "float[]"
```

The parser normalizes once more, earlier and for a different reason. `parseTypeSource`
(`src/frontend/parser/index.ts:883`) does not parse an annotation into anything; it takes
the tokens it skipped over and joins them:

```ts
export function typeSourceFromTokens(tokens: readonly Token[]): string {
  return tokens.map((tok) => String(tok.value)).join(" ")
    .replace(/\s*\[\s*\]/g, "[]")
    .replace(/\s*<\s*/g, "<")
    .replace(/\s*>\s*/g, ">")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s*->\s*/g, " -> ")
    .replace(/\s+/g, " ")
    .trim();
}
```
— `src/frontend/type-source.ts:13-24`

Twenty-four lines is the whole of `src/frontend/type-source.ts`, and the rest of it is
`restParameterType` / `restParameterSource` and the `...` marker they agree on — a rest
parameter is spelled `...name: element` inside the type string, and read back by
`parseFunctionParam`. The token join has to exist because the lexer put a space between
every token; `cleanType` runs afterwards and would fix most of it anyway. What it really
buys is that `_paramInfo` holds something readable before the checker ever runs, which is
what `[Ch 3 § forms-4-and-5-the-second-tree]`'s AST dump shows.

## Invariant, enforcement, test

The invariant the whole design rests on is: **`cleanType` maps every spelling of a type onto
one canonical spelling, and applying it to a canonical spelling changes nothing.**

Enforcement is that every entry point calls it. `signatureFromParams` and `bindNode` in the
binder; `typeAliasNode`, `interfaceNode`, `functionNode` and `paramsFromInfo` in the semantic
lowering; `parseFunctionType`, `parseFunctionParam`, `unionParts`, `unionType`,
`arrayElementType`, `arrayOfType`, `tupleTypes`, `isTupleType` and `resolveType` inside the
type system itself. Several of those call it on input that has already been through it,
which is deliberate belt-and-braces — and, as the next paragraph shows, is also what saves
the engine from the one case where the invariant is false.

The tests are the `arrayOfType` and `compatible` blocks in
`tests/frontend/checker/type-system.test.ts`. `arrayOfType` is the inverse direction —
given an element type, name the array — and it is where canonical form is most visibly a
design rather than an accident:
`[t: tests/frontend/checker/type-system.test.ts > "suffixes a name that already reads as one element"]`
gives `int[]`;
`[t: tests/frontend/checker/type-system.test.ts > "parenthesises a union so the suffix binds to the whole of it"]`
gives `(int | null)[]` rather than the ambiguous `int | null[]`;
`[t: tests/frontend/checker/type-system.test.ts > "parenthesises a tuple and a function type the same way"]`
extends the rule; and
`[t: tests/frontend/checker/type-system.test.ts > "keeps a compound element out of the bare Array name, which forgets it"]`
asserts the negative — that the result is never the bare word `Array`, because `Array` is a
name from which no element can be recovered.

And the invariant does not hold. Measured on this tree:

```
cleanType("Array<Array<int>>")                          "Array<int[]>"
cleanType(cleanType("Array<Array<int>>"))               "int[][]"
cleanType(cleanType(cleanType("Array<Array<int>>")))    "int[][]"
```

> **Unfinished.** `cleanType` (`src/frontend/checker/type-system.ts:150-175`) normalizes
> `Array<T>` to `T[]` with `/\bArray\s*<\s*([^>]+)\s*>/g` — a negated character class that
> cannot cross a `>`, not a depth walk like the `splitTopLevel` every other part of the file
> uses. On `Array<Array<int>>` the capture group stops at the first `>`, so one pass produces
> the half-normalized `Array<int[]>` and a *second* pass is needed to reach `int[][]`.
> `cleanType` is therefore not idempotent, and the canonical-form invariant is false for
> nested generics. The engine survives because almost every consumer calls `cleanType` again:
> `resolveType` (`:354`) opens with `cleanType(type)`, and `latticeFromDeclaredType`
> (`src/optimizing/types/declared.ts:102`) does the same, so both the assignability ladder
> and the middle-end lattice see `int[][]` and answer correctly — `xs: Array<Array<int>>`
> assigns to `ys: int[][]` and exits 0. What does not get the second pass is the string the
> checker stored and prints:
>
> ```
> $ node dist/cli.js check -e 'xs: Array<Array<int>> = [[1], [2]]
> n: int = xs
> print(n)'
> [eval]:2:10: error: Type 'Array<int[]>' is not assignable to 'int'
> ```
>
> `Array<int[]>` is not a spelling the user wrote and not a spelling tera's canonical form
> admits. Cost of finishing: rewrite the one `Array<T>` replacement as a depth walk over
> `splitTopLevel`, the way the rest of the file already works, or apply the existing regex
> to a fixpoint.

## Splitting text you cannot lex

Every consumer of a `TypeName` eventually has to take it apart: separate the parameters of
`(a: int, b: string) -> bool`, separate the members of `int | undefined`, separate the fields
of `{ x: int, y: int }`. The obvious tool is a parser, and a parser is exactly what this
design exists to avoid — writing one would mean building the type objects that
`TypeName = string` was chosen to do without.

> **New idea. Splitting on a separator you cannot simply search for.** Suppose you want the
> parameters of `(m: Map<string, int>, n: int) -> int`. Splitting on `,` gives you three
> pieces, two of them nonsense, because one comma is *inside* a generic argument list. The
> minimal fix is not a parser: it is a single left-to-right pass with a counter. Increment on
> every opening bracket, decrement on every closing one, and only treat the separator as a
> separator when the counter is zero. Add a second piece of state for quote characters, so a
> comma inside a string literal in a type is skipped too, and you have a splitter that is
> correct for every nesting the format can produce, in one pass and constant space, with no
> grammar. The technique is worth knowing because it generalizes: CSV readers, shell word
> splitting and template engines all use the same counter.

`splitTopLevel` is the whole of it, and it is twenty-four lines:

```ts
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && i + 1 < source.length) i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ">" && source[i - 1] !== "-") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === separator) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out;
```
— `src/core/type-text.ts:6-23`

`src/core/type-text.ts` is forty-two lines and holds nothing else but `UNTYPED_NAMES`
(`any`, `unknown`, `undefined`, `void`, `never`) and the two predicates `isUnwrittenType` and
`isUntypedName` that `[Ch 11 § the-write-back]` uses to decide whether an annotation is worth
overwriting. Everything in the type system that takes a string apart calls into these
twenty-four lines: `unionParts`, `unionType`, `tupleTypes`, `parseFunctionType`,
`parseTypeParams`, `topLevelColon`, `resolveType`, and `symbols.ts`'s field splitter.

## One character of lookbehind

Line 16 is the one that carries the design:

```ts
    else if (ch === ">" && source[i - 1] !== "-") depth = Math.max(0, depth - 1);
```
— `src/core/type-text.ts:16`

`>` closes a bracket, unless the previous character was `-`, because `->` is not a closing
angle bracket — it is tera's function arrow.

The program that needs it is in the test corpus:

```
(o: { run: (int) -> int, a: int }) -> int
```

One parameter, named `o`, whose type is an object with a function-typed field. Split its
parameter list with `splitTopLevel` and you get one part
`[t: tests/frontend/checker/type-system.test.ts > "keeps an object type holding a function-typed field as one parameter"]`.
Now delete the exemption — treat every `>` as closing — and walk the characters. The `{`
takes depth to 1. The `(` of `(int)` takes it to 2 and the `)` returns it to 1. Then the `>`
of `->` is read as a close and takes depth to **0**, and the very next comma is seen at top
level. Simulated on this tree with the exemption removed, the same string splits as:

```
["o: { run: (int) -> int", " a: int }"]
```

One parameter has become two, the first with an unbalanced `{` and the second with an
unbalanced `}`. `parseFunctionParam` would then hand the signature a parameter named `o`
whose type is `{run: (int) -> int` and a second parameter named `a`. Nothing further down
would notice, because nothing further down validates that a `TypeName` is balanced.

The `Math.max(0, …)` clamp on the same line is the second half of the same defence, and it
protects the opposite mistake. A `>` that closes nothing — a stray one, or one produced by
the failure above — would otherwise take depth negative, and a negative depth never returns
to zero, so every remaining separator in the string would be swallowed. With the clamp, a
stray `>` costs nothing:

```
splitTopLevel("a > b, c: int", ",")   ->   ["a > b", " c: int"]
```

Two other tests pin the same machinery from the other side:
`[t: tests/frontend/checker/type-system.test.ts > "keeps a comma inside a generic parameter type out of the parameter split"]`
is the `Map<string, int>` case, and
`[t: tests/frontend/checker/type-system.test.ts > "reads a parameter whose type is itself a function answering a function"]`
nests arrows two deep. The same splitter runs over object-type *fields* in the symbol table
`[t: tests/frontend/checker/symbols.test.ts > "keeps a comma inside a generic field type out of the field split"]`.

## Where the `<` opens and nothing closes it

The two angle brackets are not treated symmetrically, and the asymmetry is worth naming
because it is the format's one unchecked assumption.

`>` is conditional and clamped. `<` is neither: it increments depth unconditionally, with no
exemption and no clamp. So a type string containing a bare less-than opens a bracket that
nothing closes, depth never returns to zero, and every remaining separator is swallowed:

```
splitTopLevel("a < b, c: int", ",")   ->   ["a < b, c: int"]
```

One part where there should be two, silently.

The reason this is not a live bug is that types are not expressions in tera. An annotation is
whatever tokens sit between a `:` and the end of the declaration, and nothing in the grammar
produces a comparison there — `<` in a type position is always a generic argument list. The
format assumes balance; it does not check it.

> **Unenforced.** `splitTopLevel` (`src/core/type-text.ts:1-24`) increments `depth` on `<`
> with no matching guarantee, and the `Math.max(0, …)` clamp defends only the `>` direction.
> Nothing anywhere in the tree checks that a `TypeName` is balanced — there is no validator,
> no `satisfies` constraint and no assertion — so a malformed annotation is split somewhere
> plausible rather than rejected, and the wrong split reaches `parseFunctionParam`, which
> will happily name a parameter after it. Confirmed by running the function directly:
> `splitTopLevel("a < b, c: int", ",")` answers one part. Cost of fixing: a `balanced(type)`
> predicate over the same loop, called once where an annotation enters the checker
> (`cleanType`), and a diagnostic for the failure.

## Consumer one: the bytecode compiler   ⟨I · B · J · N⟩

Four stages downstream read canonical type text. The first is the only road out of the
checker into the compiled form at all.

`declaredSignatureOf` (`src/bytecode/register/compiler/functions.ts:165-169`) reads
`_paramInfo` and `_returnType` straight off the AST node — the strings the parser wrote and
`[Ch 11 § the-write-back]` may have overwritten — and builds a
`bytecode.DeclaredSignature`, which is hung on the `RegisterCompiledFunction`. Its first
decision is to produce nothing at all when there is nothing to say:
`if (!hasInfo && !hasDefault && !variadic && typeof returns !== "string") return null`
(`:175`). An unannotated function with no defaults and no rest parameter carries no declared
signature.

The instruction stream does not change either way. Compile a function with and without
annotations and diff the printed bytecode:

```
$ node dist/cli.js --print-bytecode --filter f -e 'fn f(a: int) -> int:
  return a + 1
print(f(1))'
=== f (params=1, locals=1, registers=3, constants=1) ===
Constants:
  [0] 1
Locals: r0=a
Instructions:
     0  Ldar r0
     1  Star r1
     2  LdaConst [0] (1)
     3  Star r2
     4  Ldar r1
     5  Add r2 r0
     6  Return
```

The same program written `fn g(a):` produces a byte-for-byte identical listing, modulo the
name in the header. `Add` is `Add`; there is no typed opcode. The declared signature is
metadata travelling beside the instructions. `[Ch 20]` is where it is attached, at
`functions.ts:715`.

**This section's badge is wider than the chapter's, and the chapter's is wrong.** It is
tempting — and `docs/part-02-meaning/_part.md` says as much, as does
`[Ch 16 § what-the-checker-actually-hands-downstream]` — to conclude that `declaredSignature`
is read only by the optimizing road. It is not. `src/runtime/declared-int.ts` is twenty-nine
lines and its `declaredInt32Return(carrier)` asks one question: is
`carrier.declaredSignature?.returns` the string `"int"`? Six files import it, and two of them
are the interpreter (`src/bytecode/register/interpreter/index.ts:169`, used at `:2029-2030`)
and the baseline compiler (`src/optimizing/baseline/compiler.ts:11`, used at `:41`, which
emits `return $.declInt(…)` into the generated JavaScript). A seventh reader,
`src/api/engine.ts:486`, asks `declaredSignature?.variadic` outside any tier at all.

The consequence is observable with the compilers switched off entirely:

```
$ node dist/cli.js --no-opt -e 'fn wrap() -> int:
  return 2147483647 + 1
fn plain():
  return 2147483647 + 1
print(wrap())
print(plain())'
-2147483648
2147483648
```

Same body, same tier, two answers, because one of them wrote `-> int`. Three characters of
type text changed what the *interpreter* printed, and it is pinned
`[t: tests/e2e/optimizing/int32-semantics.test.ts > "wraps a declared int return in every interpreted tier too"]`,
with the negative case
`[t: tests/e2e/optimizing/int32-semantics.test.ts > "leaves an undeclared and a float return unwrapped in every tier"]`.
So the honest badge for this chapter is
`⟨I · B · J · N⟩`; the heading keeps `⟨— · — · J · N⟩` only because the part opener's table
still says so, and that table needs the correction more than this heading does.
`[Ch 48 § declared-int-wraps-everywhere]` is where the wrap itself belongs — the point here is
narrower and is this chapter's thesis at its sharpest: a type in this engine is a string, and
because it is a string it travels further than a design document would predict.

## Consumer two: the middle end's lattice

The optimizer does not want text; it wants a machine fact. `latticeFromDeclaredType`
(`src/optimizing/types/declared.ts:96-114`) is the converter, and it works by re-parsing the
string with the checker's own splitters — `unionParts` for the alternatives, then one atom at
a time:

```ts
function classifyAtom(resolved: string, env: TypeEnv, nominal: NominalTypes): LatticeType {
  const primitive = PRIMITIVE_TYPES.get(resolved);
  if (primitive !== undefined) return primitive;

  const element = arrayElementType(resolved);
  if (element !== null) {
    return arrayType(elementsKindFor(latticeFromDeclaredType(element, env, nominal)));
  }

  if (isTupleType(resolved)) {
    const items = tupleTypes(resolved).map((item) => latticeFromDeclaredType(item, env, nominal));
    return arrayType(elementsKindFor(joinAll(items)));
  }

  const shapeId = nominal.shapeIdOf(resolved);
  if (shapeId !== null) return objectType(shapeId);

  return anyType();
}
```
— `src/optimizing/types/declared.ts:60-78`

Four attempts in order: a primitive by table lookup, an array by suffix, a tuple by brackets,
a class by asking the graph's `NominalTypes` for a shape id. Anything else is `anyType()`,
and every `anyType()` here is a fact the backend will have to guess at
(`[Ch 16 § the-honest-inventory-any-is-a-hole-with-32-doors]`).

The table is eight entries:

```ts
const PRIMITIVE_TYPES = new Map<string, LatticeType>([
  [DECLARED_INT, smiType()],
  ["float", doubleType()],
  ["bool", booleanType()],
  ["boolean", booleanType()],
  ["string", stringType()],
  ["null", nullishType()],
  ["undefined", nullishType()],
  ["void", nullishType()],
]);
```
— `src/optimizing/types/declared.ts:36-45`

Note `bool` *and* `boolean`. `cleanType` is supposed to have eliminated the second spelling,
and `latticeFromDeclaredType` calls `cleanType` on its input before it gets here — so the
`boolean` row can never fire. It is the same canonicalization backstop
`[Ch 10 § numbers-are-a-rank-not-a-lattice]` finds in `boolAssignable`, appearing a second
time in a different file: a duplicate entry standing in for a guarantee nobody wanted to
depend on.

Because re-parsing is not free, the result is memoized, keyed by the *cleaned string* inside
a `WeakMap` on `(TypeEnv, NominalTypes)` (`:80-94`). The memo is possible precisely because
the type is a string: a structural type would need a hash.

Run the running example's own annotation through it and the chain from
`docs/example/stats.tera:2` closes:

```
latticeFromDeclaredType("float[]")   ->   { kind: "Array", elementsKind: "PACKED_DOUBLE" }
latticeFromDeclaredType("int")       ->   { kind: "Smi" }
latticeFromDeclaredType("string")    ->   { kind: "String" }
```

`PACKED_DOUBLE` is a name the JIT prints, and it is worth being exact about which road
prints it. `node dist/cli.js --trace docs/example/stats-deopt.tera | grep PACKED` emits
`LoadArrayLength (PACKED_DOUBLE)`, `LoadElement(PACKED_DOUBLE)` and
`Dependency registered: total_of -> elements-kind:PACKED_DOUBLE` — but `total_of`'s
parameter in that file is **undeclared** (`fn total_of(values) -> float`), and adding
`values: float[]` changes not one character of the trace. That kind came from *feedback*, and
the third line proves it: a registered dependency is a speculation the runtime will
deoptimize on, not a fact read out of an annotation. The text road and the feedback road
arrive at the same `elementsKind` name by different means, which is the point of having one
lattice, and `[Ch 33 § the-question-a-guess-answers]` owns the other one.

There is one more crossing, and it runs the map *backwards*:

```ts
const CHECKER_NAME_BY_KIND = new Map<string, string>([
  [TypeKind.String, "string"],
  [TypeKind.Smi, DECLARED_INT],
  [TypeKind.Double, "float"],
  [TypeKind.Number, "float"],
  [TypeKind.Boolean, "bool"],
  [TypeKind.Array, "Array"],
]);
```
— `src/optimizing/types/declared.ts:145-152`

`declaredNameOf(receiver)` converts a lattice value back into checker text so that
`builtinOwnerMember` can ask the *checker's* builtin tables what members that thing has, and
convert the answer forward again with `latticeFromDeclaredType`. The middle end uses it at
`src/optimizing/ir/operations.ts:559` to type a property access on a builtin receiver — an
SSA pass, mid-optimization, taking a round trip through type text because that is where the
member tables live. The map is not injective: `Double` and `Number` both answer `"float"`, so
the round trip loses the distinction, which is acceptable only because the forward direction
sends `"float"` to `Double` and the two are interchangeable at that boundary.

## Consumer three: the AOT class table

`classSurfacesOf` (`src/frontend/modules/interface.ts:142-156`) walks the bound program and
publishes one `ClassSurface` per class and per interface. A method's signature crosses that
boundary as `(a: T) -> R` *text*, in `ClassMemberSurface.declaredType`; a field crosses as
its annotation. Nothing structural is handed over. `interfaceSurfaceOf` (`:123`) even asks
`parseFunctionType(member.declaredType) === null` to decide whether an interface member is a
field or a method — a question answered by re-parsing the string.

`buildClassTable` (`src/optimizing/metadata/class-table.ts`) is on the other side, and it
calls `latticeFromDeclaredType` in five places (`:381`, `:387`, `:457`, `:471`, `:477`) to
turn each of those strings into an `AotScalar` and then into a byte offset.
`[Ch 57 § laying-a-class-out]` is where the offsets are computed; what matters here is that the
last representation of a type before it becomes an offset is a string.

The end of that road is visible from the command line, and it is the cleanest available proof
that this chapter's thesis is load-bearing. Emit C for `stats.tera` and read the header:

```
$ node dist/cli.js compile docs/example/stats.tera --target c --emit source -o stats-c
$ cat stats-c/stats.h
```
```c
const tera_char * report(unsigned char *p0);
unsigned char * Series(unsigned char *p0, const tera_char *p1, unsigned char *p2);
double Series_mean(unsigned char *p0);
const tera_char * Series_label(unsigned char *p0);
int32_t tera_program(void);
```

Every C type on the left came from a string on the right. `report(s: Series) -> string`
(line 17 of the example) became `const tera_char *`, because `string` classified to
`stringType()`. `mean() -> float` (line 6) became `double`. The constructor's
`name: string, values: float[]` (line 2) became `const tera_char *` and a pointer.
`Series` itself classified through `nominal.shapeIdOf` to an object, hence
`unsigned char *`. Note also that `--emit source -o PATH` writes a *directory* at `PATH`
containing `stats.c` and `stats.h`, not a single file.

## Consumer four: the symbol table   ⟨— · — · — · —⟩

The fourth consumer is not a tier at all — hence the empty badge. `inferSymbolTypes`
(`src/frontend/checker/index.ts:78-84`) lowers, binds and checks a source with a third
constructor argument to `TypeChecker` — an `onDeclare` callback — and collects every
`SymbolType { name, line, column, type }` the checker declares along the way. `type` is the
same canonical string. Six sites in `type-checker.ts` fire it — a catch variable at `:117`,
a loop variable at `:200`, an array-comprehension variable at `:353`, `checkVar` at `:553`, the destructuring
path at `:580`, and a parameter at `:845`.

That stream is what the REPL's completion uses to answer questions about names in text the
user has typed but not yet run, and what the editor's hover shows.
`[Ch 74 § one-spec-four-surfaces]` follows it. The reason it costs almost nothing to provide
is the chapter's thesis again: the checker already has the answer in the only form the
consumer needs, so there is no serialization step between "the checker knows" and "the
completion list shows".

## What it costs, honestly

Two prices, and the second one is a bug.

**Every layer re-parses.** `parseFunctionType` takes a `TypeName`, calls `cleanType` on it,
runs `parseFunctionTypeSource`, splits the parameter list with `splitTopLevel`, and builds a
fresh `Signature` with new `Map`s and `Set`s — every time, from characters, with no cache. It
is called from eleven sites across three files: `assignableUncached` twice (`:804`, `:805`),
`functionAssignable` (`:823`), `iteratorElementType` (`:605`), `collectParamPolarity`
(`:947`), `interfaceSurfaceOf` (`interface.ts:126`), `functionSignatureForType`
(`infer.ts:513`), `unifyTypeParams` twice (`infer.ts:352-353`), and two more in `infer.ts`
(`:166`, `:465`). A single `compatible` call on two function types re-parses both, and every
recursive step inside re-parses again. This book reports no cost figure for that, because
there is no benchmark harness in this tree (`docs/CONVENTIONS.md` rule 9); what can be said
is that it is unmeasured, and that the memo in `assignable` bounds the *number of distinct
pairs* rather than the parsing per pair.

**Substitution is textual, and text has no scope.** Instantiating a generic means replacing
a type parameter's name with a type, and the implementation does it with a regular
expression over the whole string:

```ts
export function substituteType(type: TypeName, substitutions: Map<string, TypeName>): TypeName {
  let next = String(type);
  for (const [name, value] of substitutions) {
    next = next.replace(new RegExp(`\\b${name}\\b`, "g"), value);
  }
  return cleanType(next);
}
```
— `src/frontend/checker/type-system.ts:335-341`

`\bT\b` matches any identifier equal to `T` anywhere in the string — including a *field*
name. `substituteType("{ T: string }", T := int)` answers `"{int: string}"`, an object type
with a field called `int`.

On its own that would be latent. It becomes reachable because `unifyTypeParams`'s final
fallback binds a type parameter whenever its name merely *occurs* in the parameter's type:

```ts
  for (const typeParam of typeParams) {
    if (!subs.has(typeParam) && new RegExp(`\\b${typeParam}\\b`).test(param)) subs.set(typeParam, actualType);
  }
```
— `src/frontend/checker/infer.ts:375-377`

> **Broken.** `substituteType` (`src/frontend/checker/type-system.ts:335-341`) substitutes by
> word-boundary regex over the whole type string, and `unifyTypeParams`'s fallback
> (`src/frontend/checker/infer.ts:375-377`) binds a type parameter on mere textual occurrence.
> Together they make a generic function's behaviour depend on the *name* of its type
> parameter. Measured on this tree, 2026-09-07:
>
> ```
> $ node dist/cli.js check -e 'fn pick<T>(row: { T: string }, v: T) -> T:
>   return v
> n: int = pick({ T: "a" }, 1)
> print(n)'
> [eval]:3:27: error: Type 'int' is not assignable to parameter 'v: {T: string}'
> ```
>
> The first parameter's type `{ T: string }` contains the identifier `T`, so the fallback
> binds `T := {T: string}` from that argument; the second parameter, genuinely `T`, is then
> checked against an object type. Rename the type parameter and the identical program is
> accepted:
>
> ```
> $ node dist/cli.js check -e 'fn pick<Elem>(row: { T: string }, v: Elem) -> Elem:
>   return v
> n: int = pick({ T: "a" }, 1)
> print(n)'
> $ echo $?
> 0
> ```
>
> Cost of finishing: a structural substitution that walks a parsed type and replaces only
> type *positions*, leaving field names alone — which means building the parsed type this
> whole design exists to avoid. The cheaper half-fix is to tighten the `unifyTypeParams`
> fallback so that occurrence inside a field-name position does not count, which requires the
> same parse. There is no test in `tests/` covering either half: **[unpinned]**.

## What it buys

Set against those two prices, four things the design gets for nothing.

**One format across four stages with no adapters.** The string that the parser wrote into
`_paramInfo` is the string the binder canonicalized, the string
`declaredSignatureOf` hangs on the compiled function, the string
`latticeFromDeclaredType` classifies, the string `classSurfacesOf` publishes, and the string
`inferSymbolTypes` streams to the REPL. At no boundary is there an encoder, a decoder, a
version number, or a shared allocator. The `stats.h` prototypes above are the far end of a
chain that never left `string`.

**A module interface that is plain data.** `moduleInterfaceOf` produces four arrays of
`{ name, type }`-shaped objects. Cross-module checking (`[Ch 15 § one-file-one-record]`) is
then a matter of handing that object to `bindProgram`'s `imports`, which is why the checker
can check a module graph without loading every module's checker state at once.

**Memoization and identity for free.** The `assignable` memo key, the
`latticeFromDeclaredType` cache, and the `VARIANCE_CACHE`
`[Ch 10 § the-set-piece-variance-nobody-wrote-down]` uses are all `Map`s keyed on type text.

**Diagnostics that show the compiler's belief.** `Type 'float[]' is not assignable to 'int'`
tells the reader what the compiler thinks their `Array<float>` *is*, not what they typed.
`[t: tests/e2e/frontend/checker.test.ts > "normalizes array suffixes in parameter diagnostics"]`
and
`[t: tests/e2e/frontend/checker.test.ts > "normalizes fn-prefixed function return annotations"]`
pin that behaviour, and
`[t: tests/e2e/frontend/checker.test.ts > "binds a trailing [] to its own arm, not to the whole union"]`
pins the parenthesization that keeps such a sentence unambiguous. It is also the mechanism by
which the `Array<int[]>` leak above became visible at all.

## What leaves

**Canonical type text.** Every type in the program — the annotations the user wrote, the ones
the parser normalized with `typeSourceFromTokens`, and the ones the checker manufactured
like `int | undefined` — is a `TypeName`: a `string` that has been through `cleanType`, so
that two spellings of one type are one string, with the one nested-generic exception named
above. With it go the functions that take that text apart again on demand — `unionParts`,
`arrayElementType`, `tupleTypes`, `parseFunctionType`, `parseGenericType`, `typeLiteralShape`
and `instantiateShapeForType` — all of them built on the twenty-four lines of
`splitTopLevel`, and all of them re-deriving structure from characters rather than being
handed it.

`[Ch 10 § a-lattice]` is the first consumer that does anything with those parsers beyond
storing their results. It asks the only two questions a type checker ever asks — does `a` fit
where `b` was wanted, and what single name covers both of these — and it answers them by
splitting strings, which is the whole reason this chapter comes first.

## Verify it yourself

```bash
# canonical form: the user's spelling, the compiler's answer
node dist/cli.js check -e 'xs: Array<float> = [1.0, 2.0]
ys: float[] = xs
print(ys)'; echo "exit=$?"

# the same canonicalisation, visible in a refusal
node dist/cli.js check -e 'xs: Array<float> = [1.0]
n: int = xs
print(n)'

# the Unfinished item: a half-normalised spelling reaching a diagnostic
node dist/cli.js check -e 'xs: Array<Array<int>> = [[1], [2]]
n: int = xs
print(n)'

# the Broken item: the same program twice, differing only in a type parameter's NAME
node dist/cli.js check -e 'fn pick<T>(row: { T: string }, v: T) -> T:
  return v
n: int = pick({ T: "a" }, 1)
print(n)'; echo "exit=$?"
node dist/cli.js check -e 'fn pick<Elem>(row: { T: string }, v: Elem) -> Elem:
  return v
n: int = pick({ T: "a" }, 1)
print(n)'; echo "exit=$?"

# consumer one: annotations change no instruction. Compare the two listings.
node dist/cli.js --print-bytecode --filter f -e 'fn f(a: int) -> int:
  return a + 1
print(f(1))'
node dist/cli.js --print-bytecode --filter g -e 'fn g(a):
  return a + 1
print(g(1))'

# ...but they do change the answer, in the INTERPRETER, with every compiler off
node dist/cli.js --no-opt -e 'fn wrap() -> int:
  return 2147483647 + 1
fn plain():
  return 2147483647 + 1
print(wrap())
print(plain())'

# consumer three: every C type in this header came from a string annotation.
# -o writes a DIRECTORY holding stats.c and stats.h.
node dist/cli.js compile docs/example/stats.tera --target c --emit source -o /tmp/stats-c
cat /tmp/stats-c/stats.h

# the splitter and the canonicaliser (15 tests)
npx vitest run --project unit tests/frontend/checker/type-system.test.ts
```

The second command reports `Type 'float[]' is not assignable to 'int'` — the user wrote
`Array<float>` and the compiler answered in canonical text. The third reports
`Type 'Array<int[]>' is not assignable to 'int'`, which is neither what the user wrote nor a
spelling the canonical form admits. The fourth and fifth differ only in the type parameter's
*name*, and only the fourth is rejected. The `--no-opt` run prints `-2147483648` then
`2147483648`: same arithmetic, same tier, and the only difference is three characters of
type text.

Several claims in this chapter are not reachable from the CLI, because there is no flag that
prints a `TypeName` in isolation. The `cleanType` table, the `splitTopLevel` results and the
`latticeFromDeclaredType` outputs quoted above were produced by importing
`src/frontend/checker/type-system.ts`, `src/core/type-text.ts` and
`src/optimizing/types/declared.ts` directly — for example with `npx tsx` — and printing the
return values. The exemption-removed split was produced by copying the twenty-four lines of
`splitTopLevel` and deleting the `source[i - 1] !== "-"` clause.

## Tests that pin this

- `tests/frontend/checker/type-system.test.ts` > `"keeps a comma inside a generic parameter type out of the parameter split"`
  — the depth counter: a comma inside `Map<string, int>` is not a separator.
- `tests/frontend/checker/type-system.test.ts` > `"keeps an object type holding a function-typed field as one parameter"`
  — the `->` exemption, on the exact string that breaks without it.
- `tests/frontend/checker/type-system.test.ts` > `"reads a parameter whose type is itself a function answering a function"`
  — arrows two deep, still one parameter.
- `tests/frontend/checker/type-system.test.ts` > `"names a parameter declared beside a function-typed one"`
  and > `"gives a stand-in name to an undeclared function-typed parameter"`
  — `parseFunctionParam` recovering names, and `arg0`/`arg1` when there are none.
- `tests/frontend/checker/type-system.test.ts` > `"suffixes a name that already reads as one element"`
  — `arrayOfType("int")` is `int[]`, the canonical array spelling.
- `tests/frontend/checker/type-system.test.ts` > `"parenthesises a union so the suffix binds to the whole of it"`
  and > `"parenthesises a tuple and a function type the same way"`
  — why the canonical form is unambiguous when read back.
- `tests/frontend/checker/type-system.test.ts` > `"keeps a compound element out of the bare Array name, which forgets it"`
  — the negative: the canonical name is never the bare word `Array`.
- `tests/frontend/checker/type-system.test.ts` > `"reads a union as a set, so the order its members were written in does not matter"`
  — why `actual === expected` is a fast path and not the definition of type identity.
- `tests/frontend/checker/symbols.test.ts` > `"keeps a comma inside a generic field type out of the field split"`
  and > `"reads the field that follows a function-typed one"`
  — the same splitter over object-type fields, for the symbol table.
- `tests/e2e/frontend/checker.test.ts` > `"normalizes fn-prefixed function return annotations"`
  — `fn(...) -> T` and `(...) -> T` reach a diagnostic as one spelling.
- `tests/e2e/frontend/checker.test.ts` > `"normalizes array suffixes in parameter diagnostics"`
  — the canonical spelling is what the user is shown.
- `tests/e2e/frontend/checker.test.ts` > `"binds a trailing [] to its own arm, not to the whole union"`
  — `arrayOfType`'s parenthesization, seen from the diagnostic end.
- `tests/e2e/optimizing/int32-semantics.test.ts` > `"wraps a declared int return in every interpreted tier too"`
  — the proof that `declaredSignature.returns` reaches the interpreter and the baseline
  compiler, contrary to this chapter's own heading badge.
- `tests/e2e/optimizing/int32-semantics.test.ts` > `"leaves an undeclared and a float return unwrapped in every tier"`
  — the negative half: no annotation, no wrap.
- The `substituteType` / `unifyTypeParams` word-boundary collision is **[unpinned]**. No test
  in `tests/` gives a generic function a field named after its own type parameter.
- `cleanType`'s non-idempotence on nested `Array<>` is **[unpinned]**. No test applies
  `cleanType` twice, and no test covers `Array<Array<T>>`.
