# 9. Types are text   ⟨— · — · J · N⟩

> **Status:** outline

**Thesis.** Every type in this engine is a normalized string, from the annotation the user
wrote to the machine scalar the register allocator assigns, and the whole design rests on
one character of lookbehind.

**What arrived.** From ch 8: a `BoundProgram` whose `Signature`s, `Binding`s and
`ObjectShape`s already hold `TypeName` values, because `signatureFromParams` and
`bindNode` ran everything through `cleanType` on the way in.

**What leaves.** Canonical type text — the single interchange format for the whole stack.
Four consumers re-parse it: `declaredSignatureOf` (ch 20), `latticeFromDeclaredType`
(ch 48), `classSurfacesOf` → `buildClassTable` (ch 57), and `inferSymbolTypes` for the
REPL (ch 74).

**New ideas.** Canonical form and why string equality can mean type identity; a
depth-tracking split; structural vs. syntactic type identity.

**Length.** 12 pages

## Anchors

- `src/frontend/checker/type-system.ts` — `export type TypeName = string` (line 24) and
  everything built on it: `cleanType`, `withoutRedundantParens`,
  `parseFunctionTypeSource`, `matchingParen`, `parseTypeParams`, `parseFunctionType`,
  `parseFunctionParam`, `topLevelColon`, `signatureType`, `unionParts`, `unionType`,
  `arrayElementType`, `arrayOfType`, `isTupleType`, `tupleTypes`, `parseGenericType`,
  `baseTypeName`, `typeLiteralShape`, `shapeType`, `resolveType`, `substituteType`,
  `instantiateSignature`, `instantiateShapeForType`.
- `src/core/type-text.ts` — 42 lines, the whole file: `splitTopLevel` (depth over
  `( [ { <`, quote skipping, and the `->` exemption on line 16),
  `UNTYPED_NAMES`, `isUnwrittenType`, `isUntypedName`.
- `src/optimizing/types/declared.ts` — the far side: `latticeFromDeclaredType`,
  `classifyAtom`, `PRIMITIVE_TYPES` (`int`→`smiType`, `float`→`doubleType`, …),
  `builtinTypeEnv`, `declaredAcceptsNull`, `presentTypeName`, `nominalLatticeType`,
  `declaredNameOf` / `CHECKER_NAME_BY_KIND` (the lattice kind back to checker text),
  `builtinOwnerMember`, `builtinMemberType`, `DECLARED_INT`.
- `src/frontend/type-source.ts` — 24 lines: `typeSourceFromTokens` (the parser's own
  normalization, applied before `cleanType` ever sees the string), `restParameterType`,
  `restParameterSource` and the `...` marker they agree on.

## Worked example

`float[]` end to end, from `docs/example/stats.tera:2`:

1. the parser writes `"float[]"` into `_paramInfo` via `typeSourceFromTokens`;
2. `cleanType` normalizes (`Array<float>`, `float [ ]`, `boolean` → `bool` all collapse);
3. `arrayElementType("float[]")` answers `"float"`;
4. `latticeFromDeclaredType("float[]")` → `arrayType(elementsKindFor(doubleType()))`;
5. the JIT prints that kind by name when it compiles `total_of`.

```bash
node dist/cli.js --trace docs/example/stats-deopt.tera | grep PACKED
```

prints `LoadArrayLength (PACKED_DOUBLE)` and `LoadElement(PACKED_DOUBLE)`.

## Outline

- [ ] **The one-line decision.** Establish `export type TypeName = string` and what it
      buys immediately: a `Map<string, Binding>` keyed by type needs no hashing scheme, a
      module interface serializes as JSON with no encoder, and `actual === expected` is a
      legal fast path in `assignableUncached`.
- [ ] **Canonical form is what makes equality mean anything.** Establish `cleanType` as
      the canonicalizer, walking its rewrite chain in order: `boolean`→`bool`,
      `Array<T>`→`T[]`, whitespace inside brackets/braces/parens squeezed, `,` `:` `|` `&`
      spaced exactly one way, redundant parens removed, and finally a recursive rebuild of
      a function type as `(p, q) -> r`. State the invariant: two spellings of one type
      produce one string.
- [ ] **Invariant → enforcement → test.** The invariant is "`cleanType` is idempotent and
      surjective onto canonical form". Enforcement: every entry point calls it —
      `signatureFromParams`, `bindNode`, `interfaceNode`, `typeAliasNode`, `functionNode`,
      `paramBinding`, `signature`, `parseFunctionType`. Test: the `arrayOfType` and
      `compatible` blocks in `tests/frontend/checker/type-system.test.ts`.
- [ ] **New idea: splitting text you cannot lex.** Primer on why `,` inside `Map<A, B>`
      must not split a parameter list, and how a one-pass depth counter with quote
      skipping does it without a parser.
- [ ] **One character of lookbehind.** Establish `splitTopLevel`'s treatment of `>`:
      `else if (ch === ">" && source[i - 1] !== "-") depth = Math.max(0, depth - 1)`.
      Show the program that needs it: splitting the parameters of
      `(o: { run: (int) -> int, a: int }) -> int`. Without the exemption the `>` of `->`
      closes the brace's depth, the `,` is seen at top level, and one parameter becomes
      two. Note the `Math.max(0, …)` clamp as the second half of the same defence.
- [ ] **Where the `<` opens and nothing closes it.** Establish the asymmetry: `<`
      increments unconditionally, so a type containing a bare less-than would corrupt the
      depth. Types are not expressions here, so nothing in the tree can produce one — say
      so, and mark it as a constraint the format assumes rather than checks.
- [ ] **Consumer one: the bytecode compiler.** `declaredSignatureOf` reads `_paramInfo`
      and `_returnType` off the AST and hangs a `DeclaredSignature` on the
      `RegisterCompiledFunction`. Establish that this is the *only* road out of the
      checker into the compiled form, and that only the optimizing tier reads it —
      `--print-bytecode` shows identical instructions for `fn f(a: int)` and `fn g(a)`.
- [ ] **Consumer two: the middle end's lattice.** `latticeFromDeclaredType` re-parses the
      string: `unionParts` splits, `classifyAtom` maps a primitive by table, recurses
      through `arrayElementType` and `tupleTypes`, and asks `NominalTypes.shapeIdOf` for a
      class. Establish the memo keyed by `(TypeEnv, NominalTypes, cleaned string)`, and
      that `CHECKER_NAME_BY_KIND` runs the map backwards so `builtinMemberType` can ask
      the *checker* what a lattice value's members are.
- [ ] **Consumer three: the AOT class table.** `classSurfacesOf` publishes
      `ClassMemberSurface.declaredType` as text; ch 57 turns it into an offset. A method
      is `(a: T) -> R` text at this boundary, never a structure.
- [ ] **Consumer four: the symbol table.** `inferSymbolTypes` streams `SymbolType.type`
      strings out through `TypeChecker.onDeclare` for REPL completion (ch 74).
- [ ] **What it costs, honestly.** Establish two prices. First, every layer re-parses:
      `parseFunctionType` alone is called from `assignableUncached`, `memberSignature`,
      `functionSignatureForType`, `interfaceSurfaceOf` and `collectParamPolarity`, each
      time from scratch. Second, `substituteType` replaces by word-boundary regex over the
      whole string, which is not sound — a field named `T` inside `{ T: string }` is a
      substitution target.
- [ ] **What it buys.** Establish the payoff the design was chosen for: a module interface
      that is four arrays of plain objects (`moduleInterfaceOf`, ch 15), one format that
      crosses from checker to bytecode to lattice to class table with no adapters, and
      diagnostics that quote the canonical spelling so the reader sees what the compiler
      believes.
- [ ] **What leaves.** Hand `TypeName` to ch 10, which asks the only question that matters
      about two of them.

## Honesty items

> **Broken.** `substituteType` (`src/frontend/checker/type-system.ts:335-341`) substitutes
> a type parameter with `new RegExp("\\b" + name + "\\b", "g")` over the whole type
> string, so any *identifier* equal to the parameter name is rewritten — including a field
> name. Paired with `unifyTypeParams`'s final fallback (`infer.ts:375-377`, which sets a
> substitution whenever `\bT\b` merely *occurs* in the parameter type),
> `fn pick<T>(row: { T: string }, v: T) -> T` binds `T := {T: string}` and then rejects
> `pick({ T: "a" }, 1)` with `Type 'int' is not assignable to parameter 'v: {T: string}'`.
> Renaming the type parameter to `Elem` makes the same program legal. Cost of finishing: a
> structural substitution that walks the parsed type instead of the text — which is the
> parser this design exists to avoid.

> **Unenforced.** `splitTopLevel` increments depth on `<` with no matching guarantee and
> clamps the decrement with `Math.max(0, …)`. Nothing checks that a `TypeName` is
> balanced; a malformed annotation silently splits somewhere plausible instead of being
> rejected.

> **Unfinished.** `cleanType` normalizes `Array<T>` to `T[]` with
> `/\bArray\s*<\s*([^>]+)\s*>/g` — a non-greedy character class, not a depth walk — so a
> nested `Array<Array<int>>` is normalized by the outer match only. The rest of the file
> uses `splitTopLevel`; this one rewrite does not.

## Verify it yourself

```bash
node dist/cli.js check -e 'xs: Array<float> = [1.0, 2.0]
ys: float[] = xs
print(ys)'
node dist/cli.js check -e 'xs: Array<float> = [1.0]
n: int = xs
print(n)'
node dist/cli.js check -e 'fn pick<T>(row: { T: string }, v: T) -> T:
  return v
n: int = pick({ T: "a" }, 1)
print(n)'
node dist/cli.js check -e 'fn pick<Elem>(row: { T: string }, v: Elem) -> Elem:
  return v
n: int = pick({ T: "a" }, 1)
print(n)'
node dist/cli.js --trace docs/example/stats-deopt.tera | grep PACKED
npx vitest run --project unit tests/frontend/checker/type-system.test.ts
```

The second command reports `Type 'float[]' is not assignable to 'int'` — the user wrote
`Array<float>` and the compiler answers in canonical text. The third and fourth differ
only in the type parameter's *name*, and only the third is rejected.

## Tests that pin this

- `tests/frontend/checker/type-system.test.ts` > "keeps a comma inside a generic parameter type out of the parameter split"
- `tests/frontend/checker/type-system.test.ts` > "keeps an object type holding a function-typed field as one parameter"
- `tests/frontend/checker/type-system.test.ts` > "reads a parameter whose type is itself a function answering a function"
- `tests/frontend/checker/type-system.test.ts` > "names a parameter declared beside a function-typed one"
- `tests/frontend/checker/type-system.test.ts` > "gives a stand-in name to an undeclared function-typed parameter"
- `tests/frontend/checker/type-system.test.ts` > "suffixes a name that already reads as one element"
- `tests/frontend/checker/type-system.test.ts` > "parenthesises a union so the suffix binds to the whole of it"
- `tests/frontend/checker/type-system.test.ts` > "parenthesises a tuple and a function type the same way"
- `tests/frontend/checker/type-system.test.ts` > "keeps a compound element out of the bare Array name, which forgets it"
- `tests/frontend/checker/type-system.test.ts` > "reads a union as a set, so the order its members were written in does not matter"
- `tests/frontend/checker/symbols.test.ts` > "keeps a comma inside a generic field type out of the field split"
- `tests/frontend/checker/symbols.test.ts` > "reads the field that follows a function-typed one"
- `tests/e2e/frontend/checker.test.ts` > "normalizes fn-prefixed function return annotations"
- `tests/e2e/frontend/checker.test.ts` > "normalizes array suffixes in parameter diagnostics"
- `tests/e2e/frontend/checker.test.ts` > "binds a trailing [] to its own arm, not to the whole union"
- The `substituteType` word-boundary collision: **[unpinned]**
