# 7. The shape of the tree   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Sixty-one node types, spans that are invisible on purpose, and type
annotations that are never parsed at all — three decisions every later stage lives with.

**What arrived.** The `ASTNode` tree built by `[Ch 06 § what-leaves]`, still warm from
`parseProgram`.

**What leaves.** The same tree, plus two things the checker will consume that nothing in
Part I understands: the type-source strings on `declaredType` / `_paramInfo` /
`_returnType`, and the non-enumerable spans. This is the last artifact of Part I; Part II
receives exactly this object.

**New ideas.** Abstract syntax tree; a discriminated union and its `type` tag; a source
span; enumerable vs. non-enumerable properties as a design tool; desugaring; hygiene (and
what an *un*hygienic desugaring costs).

**Length.** 12 pages

## Anchors

- `src/frontend/ast/index.ts` — 645 lines. `NodeType` (61 keys), `NodeTypeName`,
  `ASTNode`, `ASTFieldValue`, `LiteralValue`; the binding types `BindingTarget`,
  `BindingIdentifier`, `ObjectBindingPattern`, `ArrayBindingPattern`, `BindingPattern`,
  `ParamNode`; the record types `ObjectPropertyNode`, `ClassMethodNode`, `ClassFieldNode`,
  `FunctionParamInfo`, `InterfaceFieldAstNode`, `InterfaceIndexAstNode`,
  `ModelFieldAstNode`, `ModelSectionNode`, `CatchHandlerNode`, `ImportSpecifierNode`;
  the walkers `nodesMatching`, `astChildren`, `memberName`, `dottedName`, `subjectName`;
  the parameter helpers `parameterName`, `isRestParameter`, `functionParameters`,
  `declaredParamInfo`; the mutator `adoptContextualSignature`; and 63 factories.
- `src/frontend/parser/index.ts` — the span machinery: `withSpan`, `withNameSpan`,
  `copySpan`, `withPropertySpan`, `bindingIdentifier` (lines 111-156); `parseTypeSource`,
  `skipTypeAnnotation`, `skipReturnType`, `skipType`, `skipTypePrimary`,
  `skipTypeArguments`, `parseGenericArguments`; `parseArrayComprehension` (line 2234);
  the label arm of `parseStatement` (lines 572-582).
- `src/frontend/ast-text.ts` — 75 lines. `printAst`, and the module-private `isNode`,
  `isBranch`, `formatScalar`, `inlineScalars`, `render` that decide what a *child* is.
- `src/frontend/type-source.ts` — 24 lines. `typeSourceFromTokens`, `restParameterType`,
  `restParameterSource`, `REST_MARKER`.
- `src/core/type-text.ts` — 42 lines. `splitTopLevel`, `UNTYPED_NAMES`,
  `isUnwrittenType`, `isUntypedName` — the four functions the checker uses to read what
  this chapter wrote.
- `tests/frontend/ast/index.test.ts` — 191 lines, 25 tests. `describe("adoptContextualSignature")`
  is 15 of them; `describe("astChildren")` is 5.

## Worked example

`stats.tera` through `printAst`:

```bash
node dist/cli.js --print-ast docs/example/stats.tera | head -20
```

The first 20 lines are a clean tree. Lines 25 and 26 are 1,820- and 910-character JSON blobs, because a
`ClassMethodNode` has no `type` field and `printAst` therefore prints it as a scalar —
the first of this chapter's two walkers disagreeing about what a child is.

Then the binding-pattern equality that only works because spans do not enumerate:
`expect(stmt.pattern.elements).toEqual([{kind:"id",name:"a"},{kind:"id",name:"b"}])`
from *"array destructuring"*. `bindingIdentifier` attaches `__line`/`__column` to every
one of those records; `toEqual` compares enumerable own properties, so it never sees them.
Make the two descriptors `enumerable: true` and that assertion, and every `toEqual` like
it, goes red.

## Outline

- [ ] **§ sixty-one-names-sixty-three-factories** — establish `NodeType` as a
      `const object` (not an `enum`), 61 keys, with `NodeTypeName` derived from it. Then
      establish that the "one factory per node" reading is not quite true, and say exactly
      how: `AsyncFunctionDeclaration` and `GeneratorFunctionDeclaration` both emit
      `NodeType.FunctionDeclaration` distinguished by the `async` / `generator` fields, and
      `IndexElement` is built by a factory called `IndexElementNode`. Establish why the
      collapse is right — every consumer that handles a function handles all three — and
      what it costs: a `switch` on `node.type` cannot tell a generator from a function.
      Give the `> **New idea.**` primer on an AST and its `type` tag here.
- [ ] **§ the-open-record** — establish `ASTNode` as
      `{ type: NodeTypeName; [key: string]: ASTFieldValue }`. An open index signature means
      the parser can bolt `declaredType`, `_paramInfo`, `_returnType`, `_typeParams`,
      `typeArgs`, `implements`, `visibility`, `abstract` onto nodes the factories never
      declared. Establish the trade honestly: this is what makes `adoptContextualSignature`
      and the plugin `transform` hook possible, and it is why `ASTFieldValue` is a
      29-arm union that no longer constrains anything.
- [ ] **§ binding-patterns-and-the-loose-param-node** — establish the four-shape
      `BindingPattern` (`string` | `BindingIdentifier` | object | array) and the
      five-shape `ParamNode`. Establish that `ParamNode` is *deliberately* loose: a plain
      parameter is the bare string `"a"`, a defaulted one is `{name, default}`, a rest one
      is `{name, rest: true}`, a destructured one is `{pattern}`. Establish the price and
      who pays it — `parameterName` and `isRestParameter` exist precisely because no
      consumer may `switch` on the shape, and both are pinned by name.
- [ ] **§ spans-that-do-not-enumerate** — establish the trick: `withSpan` calls
      `Object.defineProperties` with `{value, configurable: true}` and **no `enumerable`**,
      which defaults to `false`. Show the observable: on `parse("x = 1")`'s target,
      `Object.keys` is `["type","name"]`, `Object.getOwnPropertyNames` is
      `["type","name","__line","__column","__raw"]`, and `JSON.stringify` yields
      `{"type":"Identifier","name":"x"}`. Give the `> **New idea.**` primer on enumerable
      properties here.
- [ ] **§ three-places-it-is-load-bearing** — name them. (1) `printAst` walks
      `Object.entries`, so `--print-ast` output is the tree and not the tree plus three
      numbers per node. (2) `toEqual` in the parser tests compares enumerable own
      properties, so a whole family of structural assertions can be written literally.
      (3) `parseExpressionFrom`'s type-argument arm spreads a node —
      `{ ...left, typeArgs: this.parseGenericArguments() }` — and object spread copies only
      enumerable own properties, which is exactly why that line is wrapped in `copySpan`:
      `Object.getOwnPropertyNames({...n})` is `["type","name"]`. The trick and its
      workaround are the same fact.
- [ ] **§ where-spans-are-read** — establish that the spans have exactly four consumers,
      all downstream of Part I: `src/frontend/checker/semantic-lowering.ts` (two reads,
      with `__nameLine` preferred over `__line`), `src/frontend/checker/type-checker.ts`,
      `src/frontend/checker/symbols.ts`, and `src/bytecode/register/compiler/index.ts`
      (the line table). Establish the four flavours the parser writes — `__line`/`__column`
      (`withSpan`), `__nameLine`/`__nameColumn` (`withNameSpan`),
      `__propertyLine`/`__propertyColumn` (`withPropertySpan`), and `__raw` (only when the
      token value is a string) — and which diagnostic each one is for.
- [ ] **§ where-spans-are-lost** — establish the hole. `parsePrimary`'s template arm builds
      a fresh `Lexer` and a fresh `Parser` over the raw `${}` substring captured in
      `[Ch 04 § template-literals]`, so every node inside an interpolation restarts at
      line 1, column 1. In `` s = `v=${a + b}` `` the identifier `a` is at source column 8
      and reports `1:1`. Establish the consequence for Part II: a type error inside an
      interpolation is reported at the wrong place, in every tier.
- [ ] **§ types-are-never-parsed** — establish the largest decision in the front end.
      `skipTypeAnnotation` and `skipReturnType` call `parseTypeSource(stops)`, which
      accumulates *tokens* until a depth-zero stop and hands them to
      `typeSourceFromTokens`, which joins with spaces and then runs eight normalising
      `replace`s. `Map<string, int[]>` round-trips exactly. Establish that the result is a
      `string` on `declaredType` / `_paramInfo[].type` / `_returnType`, and that the type
      language is Part II's problem — no `TypeNode` exists anywhere in the tree.
- [ ] **§ the-shift-unbundling** — establish the sub-problem the lexer created: maximal
      munch (`[Ch 04 § maximal-munch]`) turns the three closers of
      `Map<string, Map<int, Array<int>>>` into one `>>>` token. `parseTypeSource` therefore
      subtracts 2 for `>>` and 3 for `>>>`, clamped at zero; `skipTypeArguments` does the
      same; `splitTopLevel` in `src/core/type-text.ts` does the character-level version
      (`ch === ">" && source[i-1] !== "-"`, so `->` is not a closer). Establish that this
      is the same problem solved three times in two files, and that only the third one has
      to worry about `->`.
- [ ] **§ the-tree-is-mutated-after-parsing** — establish `adoptContextualSignature` as the
      one sanctioned channel by which a later stage writes back into the AST. Walk its
      rules: match by position, skip rest parameters without consuming a slot, never
      overwrite an annotation the source spells out, refuse an uninformative contextual
      type (`UNTYPED_NAMES` = any/unknown/undefined/void/never), and commit
      `node._paramInfo` only if the adopted list is the same length. Establish the three
      call sites in `type-checker.ts` and why an arrow passed to `map` needs this at all.
- [ ] **§ the-comprehension-iife** — establish the one desugaring the parser performs:
      `[p for x of xs if c]` becomes
      `CallExpression(ArrowFunctionExpression([], BlockStatement([LetDeclaration("__comp$", []), ForOfStatement(...), ReturnStatement(...)]), false), [])`.
      Give the `> **New idea.**` primer on desugaring and hygiene here. Establish that the
      arrow's own scope contains the damage in the common case — a program that already
      binds `__comp$` at module level still prints the right answer — and then show the
      case it does not.
- [ ] **§ x-colon-int-is-a-label** — establish the sharp edge. `isTypedAssignmentStart`
      requires an `=` after the type, so `x: int` *without* an initialiser fails that
      predicate, falls through the ladder of `[Ch 06 § the-statement-switch-and-the-ladder]`,
      and matches the label arm instead: `LabeledStatement(label="x", body=ExpressionStatement(Identifier "int"))`.
      Establish that this is a consequence of two features sharing one punctuator, that
      nothing warns, and that the same colon is also `parseBodyStart`'s block opener.
- [ ] **§ what-leaves** — the object Part II receives, and the two questions Part I has
      deliberately refused to answer: what `"Map<string, int[]>"` means, and whether
      `q.shift() + q.shift()` is well-typed (`[Ch 13]`).

## Honesty items

- > **Broken.** `parseArrayComprehension` (`src/frontend/parser/index.ts:2248`) uses the
  fixed accumulator name `__comp$`, which is a legal tera identifier (`isIdentStart`
  accepts `_` and `$`). A projection that names it captures the accumulator:
  `node dist/cli.js -e 'xs = [1, 2]
  __comp$ = 99
  print([__comp$ for x of xs])'` prints `[[Circular], [Circular]]` instead of `[99, 99]`.
  Fixing it costs a counter on the `Parser` instance and a name the lexer cannot produce
  (a leading digit, say), plus one regression test.
- > **Unenforced.** `printAst`'s `isNode` and `astChildren`'s `hold` both decide "is this a
  node?" by testing for a string `type` field — and they disagree about plain records.
  `astChildren` descends into any typeless object and finds `ClassMethodNode` bodies;
  `printAst` prints the same object as one `JSON.stringify` scalar. `--print-ast` on
  `stats.tera` is a readable tree until line 24 and then two JSON blobs (1,820 and 910 characters) for the
  class body. Nothing asserts the two walkers agree.
- > **Broken.** The same `"type" in value` test mis-identifies `FunctionParamInfo`, whose
  `type` field holds a **type annotation**, not a node kind. On
  `fn add(a: int, b: int) -> int`, `astChildren` returns
  `["BlockStatement", "int", "int"]` and `nodesMatching([fn], () => true)` returns 8
  "nodes", one of whose `type` is `"int"` — a value that is not in `NodeType`. Harmless
  today only because every predicate in the tree compares against a `NodeType` constant
  and therefore never matches. Fixing it costs renaming `FunctionParamInfo.type` (reached
  through `declaredParamInfo` at 4 sites, but `_paramInfo` itself appears at 19 sites in
  `src/`) or giving `astChildren` an explicit skip list for `_paramInfo`.
- > **Never runs.** `ConstDeclaration` and `VarDeclaration`
  (`src/frontend/ast/index.ts:376` and `:380`) have **no caller in `src/`**. They cannot
  have one: `let`, `const` and `var` are in `RESERVED_KEYWORDS` and
  `rejectReservedKeyword` refuses them. Their only callers are
  `tests/bytecode/register/compiler.test.ts`, which means the
  `NodeType.ConstDeclaration` / `NodeType.VarDeclaration` arms in
  `src/bytecode/register/compiler/scope.ts`, `.../statements.ts`,
  `src/frontend/checker/semantic-lowering.ts` and `src/frontend/effects/index.ts` are
  reachable only from a hand-built AST. Removing them would delete two factories, three
  `NodeType` keys and roughly a dozen `case` arms across four files — worth doing only if
  no host is expected to build tera ASTs by hand.
- > **Never runs.** The `BreakStatement()` and `ContinueStatement()` factories
  (`src/frontend/ast/index.ts:496` and `:595`) are never called by the parser, which
  builds `{ type: NodeType.BreakStatement, label }` as an inline literal
  (`src/frontend/parser/index.ts:1790` and `:1811`). The factories produce a node with **no
  `label` field at all**, so the only nodes they can make are ones the parser cannot. This
  is the shape mismatch behind `[Ch 19]`'s labeled-`continue` bug. Reconciling costs one
  parameter on each factory and two call sites in the parser.
- > **Unfinished.** `typeSourceFromTokens` (`src/frontend/type-source.ts:13-24`) normalises
  `[]`, `<`, `>`, `,`, `|`, `&` and `->` but has no rule for parentheses, so
  `fn(int) -> bool` round-trips as `"fn ( int ) -> bool"`. The checker re-normalises, so
  nothing is wrong — but the string on `_paramInfo[].type` is not canonical and cannot be
  compared for equality. Finishing it costs two more `replace` calls and a round-trip test.

## Verify it yourself

```bash
node dist/cli.js --print-ast docs/example/stats.tera | head -20
node --input-type=module -e "import {parse} from './dist/index.frontend.js'; const n=parse('x = 1').body[0].expression.target; console.log(Object.keys(n), Object.getOwnPropertyNames(n), JSON.stringify(n), Object.getOwnPropertyNames({...n}))"
node --input-type=module -e "import {parse,astChildren} from './dist/index.frontend.js'; console.log(astChildren(parse('fn add(a: int, b: int) -> int:\n  return a + b').body[0]).map(c=>c.type))"
node --input-type=module -e "import {parse,printAst} from './dist/index.frontend.js'; console.log(printAst(parse('x: int'))); console.log(printAst(parse('x: int = 1')))"
node dist/cli.js -e 'xs = [1, 2]
__comp$ = 99
print([__comp$ for x of xs])'
npx vitest run --project unit tests/frontend/ast/index.test.ts tests/frontend/parser/language.test.ts
```

## Tests that pin this

- `tests/frontend/ast/index.test.ts` > `adoptContextualSignature` > *"keeps an annotation the source already spells out"*
- `tests/frontend/ast/index.test.ts` > `adoptContextualSignature` > *"fills only the parameters the source left open"*
- `tests/frontend/ast/index.test.ts` > `adoptContextualSignature` > *"does not type a gathering parameter from a positional slot"*
- `tests/frontend/ast/index.test.ts` > `adoptContextualSignature` > *"counts positions past a gathering parameter without consuming one"*
- `tests/frontend/ast/index.test.ts` > `adoptContextualSignature` > *"writes nothing when every contextual type is uninformative"*
- `tests/frontend/ast/index.test.ts` > `adoptContextualSignature` > *"leaves the return type open when the context is uninformative"*
- `tests/frontend/ast/index.test.ts` > `astChildren` > *"reads a node a class member holds inside a plain object"*
- `tests/frontend/ast/index.test.ts` > `astChildren` > *"holds nothing for a property that carries no node"*
- `tests/frontend/ast/index.test.ts` > `parameterName` > *"has no name for a destructuring pattern"*
- `tests/frontend/ast/index.test.ts` > `isRestParameter` > *"recognises a gathering parameter"*
- `tests/frontend/parser/language.test.ts` > `Parser > declarations` > *"array destructuring"* — the `toEqual` that spans must not break
- `tests/frontend/parser/language.test.ts` > `Parser > declarations` > *"array destructuring with holes"*
- `tests/frontend/parser/language.test.ts` > `Parser > declarations` > *"array destructuring with rest and defaults"*
- `tests/frontend/parser/language.test.ts` > `Parser > declarations` > *"annotated declaration"*
- `tests/frontend/parser/language.test.ts` > `Parser > type annotations` > *"skips nested generic type arguments"*
- `tests/frontend/parser/language.test.ts` > `Parser > type annotations` > *"skips a fn-prefixed function type in return position"*
- `tests/frontend/parser/language.test.ts` > `Parser > index access` > *"lowers a slice to an index expression with one slice dimension"*
- `tests/frontend/parser/import.test.ts` > `import spans` > *"records a span on each specifier"*
- No test pins `printAst`'s output, the `__comp$` capture, the `1:1` span reset inside
  `${}`, or the `x: int`-is-a-label behaviour. [unpinned]
