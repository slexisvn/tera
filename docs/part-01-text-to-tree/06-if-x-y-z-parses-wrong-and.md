# 6. `if (x) (y)(z)` Parses Wrong, and a Bigger Parser Will Not Save You   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** A hand-written precedence-climbing parser can afford bounded backtracking, and
tera spends it on exactly two ambiguities a grammar generator would have solved
differently.

> The title names the failure of the design a reader would reach for first, not the
> failure of this parser. `if (x) (y)(z)` parses *correctly* in the tree today — that is
> what `parseControlCondition` is for, and it is pinned by
> *"a group condition still ends before a braceless body"*. The chapter earns the title by
> building the obvious parser first and watching it eat the body.

**What arrived.** The layout-bearing `Token[]` of `[Ch 05 § what-leaves]`.

**What leaves.** An `ASTNode` whose `type` is `Program`, with a `body` array and
non-enumerable `__line` / `__column` / `__raw` properties on most nodes. Shape is
`[Ch 07]`'s subject; this chapter is about who decided where each node ended.

**New ideas.** Recursive descent; precedence climbing (and why it is not the shunting-yard
algorithm); associativity; a parser checkpoint and bounded backtracking; automatic
semicolon insertion; syntactic ambiguity as a property of a *token stream*, not of a
language.

**Length.** 18 pages

## Anchors

- `src/frontend/parser/language.ts` — 12 lines: `tokenize`, `new Parser`, `parser.parse()`,
  `applySyntaxTransforms`. This is the whole public surface.
- `src/frontend/parser/index.ts` — 2264 lines. Tables: `PRECEDENCE` (11 levels),
  `POSTFIX_PRECEDENCE` (computed), `LOGICAL_OPS`, `CONDITION_CONTINUATION_OPERATORS`,
  `PROPERTY_NAME_TOKENS`, `TYPE_ARGUMENT_PUNCTUATORS`, `BINARY_OPS`, `COMPOUND_ASSIGN_OPS`;
  helpers `canonicalOperator`, `namesProperty`. Class `Parser`: `current` / `peek` /
  `advance` / `check` / `match` / `expect` / `consumeSemicolon` / `error`;
  `checkpoint` / `restore`; `isBodyStart` / `isBodyEnd` / `parseBodyStart` /
  `parseBodyEnd`; `parse` / `parseProgram` / `parseStatement` / `parseBlock` /
  `parseStatementBody`; `parseExpression` / `parseExpressionFrom` / `parsePrimary`;
  `parseControlCondition` / `continuesControlCondition`; `isGenericCallAhead`;
  `isTypedAssignmentStart` / `isDestructuringAssignmentStart` /
  `isBareTupleDestructuringStart`; `_isArrowFunction`; `rejectReservedKeyword`;
  `parseExtensionStatement` / `parseExtensionPrefix` / `parseExtensionInfix`.
- `src/frontend/parser/extensions.ts` — 142 lines, the plugin contract. `SyntaxPlugin`,
  `ParserContext`, `ParserCheckpoint`, `SyntaxPluginIndex`, `ParserSyntaxOptions`,
  `SyntaxTransformContext`; `normalizeSyntaxPlugins`, `buildSyntaxPluginIndex`,
  `syntaxPluginsFor`, `applySyntaxTransforms`; validators `assertPluginName`,
  `assertStarts`, `assertHookStarts`.
- `tests/frontend/parser/language.test.ts` — 1179 lines, 156 tests. The two set pieces
  live in `describe("parenthesised control conditions")` (line 580) and
  `describe("generic call disambiguation")` (line 1075).
- `tests/frontend/parser/extensions.test.ts` — 7 tests, the whole spec for the plugin
  contract.

## Worked example

`s.mean().to_fixed(2)` — one `parsePrimary` and three postfix rounds of the single loop in
`parseExpressionFrom`:

```bash
node dist/cli.js --print-ast -e 'print((15.7).to_fixed(2))'
```

Then the three pinned spellings of a group condition that must produce byte-identical
trees (`tree(src)` in the test is `JSON.stringify(condition(src))`):

```
if (c >= 48 and c <= 57) or c == 45:
if c >= 48 and c <= 57 or c == 45:
if ((c >= 48 and c <= 57) or c == 45):
```

## Outline

- [ ] **§ parse-is-twelve-lines** — establish the entry point: `parse()` is a 12-line
      file that tokenizes, constructs a `Parser`, calls `parse()`, and runs plugin
      transforms. Establish that everything else in this chapter is reached from
      `parseProgram`'s three-line loop, and give the `> **New idea.**` primer on recursive
      descent here — one function per grammar shape, the call stack *is* the parse stack.
- [ ] **§ the-precedence-table** — establish `PRECEDENCE` as a flat
      `Record<string, number>` with 11 levels, `??`/`||`/`or` sharing level 1 and `**`
      alone at 11, and that it is keyed by *token value* so `or` and `||` are two keys with
      one meaning. Establish `POSTFIX_PRECEDENCE = Math.max(...Object.values(PRECEDENCE)) + 1`
      as a computed sentinel — a derived table again, in the manner of
      `[Ch 04 § derived-punctuator-table]` — and that every postfix arm is guarded by
      `minPrec <= POSTFIX_PRECEDENCE`, which is true for every real caller. Give the
      `> **New idea.**` primer on precedence climbing here, and say why it is not
      shunting-yard: there is no operator stack, the recursion is the stack.
- [ ] **§ parse-primary** — establish `parsePrimary` as the leaf dispatcher: plugin prefix
      hook, then `Number` / `String` / `RegExp` / `TemplateLiteral`, then a keyword switch
      (`true`/`false`/`null`/`undefined`/`this`/`new`/`typeof`/`not`/`await`/`yield`/
      `function`/`super`), then `Identifier` (with a one-token `=>` lookahead), then
      `(`/`{`/`[`, then the prefix unaries, and finally `rejectReservedKeyword` or
      `Unexpected token`. Establish that `typeof`, `not`, `await`, `!`, `-`, `+`, `~`,
      `++`, `--` all recurse at `parseExpression(11)` — the hard-coded twin of
      `PRECEDENCE["**"]`.
- [ ] **§ parse-expression-from** — establish the single `while (true)` loop: infix plugin
      hook, then the postfix arms in order (`<` type-args, `.`, `?.`, `(`, `[`, `++`/`--`),
      then the assignment arms guarded by `minPrec <= 0`, then `?:`, then the precedence
      test `prec > minPrec`. Walk `s.mean().to_fixed(2)` through it. Establish that the
      loop `continue`s rather than recurses for postfix, which is why an arbitrarily long
      chain costs no stack.
- [ ] **§ associativity-and-canonical-operators** — establish right associativity as one
      line: `const rightPrec = op === "**" ? prec - 1 : prec`. Give the
      `> **New idea.**` primer on associativity here with `2 ** 3 ** 4`. Then establish
      `canonicalOperator`: `and`→`&&`, `or`→`||` **at parse time**, so no later stage ever
      sees the word spellings — the tree is the normalisation point.
- [ ] **§ the-statement-switch-and-the-ladder** — establish `parseStatement` as two layers:
      a `switch` on `tok.value` for the 16 keyword-led statements, then a *predicate ladder*
      for the shapes a keyword cannot announce — `isTypeDeclarationStart`,
      `isTypedAssignmentStart`, `isDestructuringAssignmentStart`,
      `isBareTupleDestructuringStart`, the label test, `isBodyStart`, and finally an
      expression statement. Establish that three of those predicates are **bounded
      backtracking**: `isTypedAssignmentStart` saves `this.pos`, runs `skipType()`, tests
      for `=`, and restores; the two destructuring predicates scan forward to depth-zero
      `=` without consuming. Give the `> **New idea.**` primer on backtracking here, and
      the rule this file follows: *look ahead freely, but restore exactly.*
- [ ] **§ the-parsers-only-contact-with-layout** — establish that `Indent`/`Dedent` are
      handled in exactly four small methods: `isBodyStart` (`:`), `isBodyEnd` (`Dedent`),
      `parseBodyStart` (`:` then skip `Newline`s then `Indent`), `parseBodyEnd` (`Dedent`).
      Establish the payoff: every other one of the 2264 lines is written as if the language
      were brace-delimited, which is why `[Ch 05]`'s rule can change without touching the
      grammar. Note the deliberate consequence pinned by
      *"rejects method shorthand with a brace body (blocks are offside-only)"* — a `{`
      after a parameter list is an object literal, never a body.
- [ ] **§ consume-semicolon-and-two-token-streams** — establish the four arms of
      `consumeSemicolon`: `;`, `Newline`+, the `}`/`Dedent`/EOF terminators, and the
      line-difference fallback. Establish that the fallback is not dead and not legacy: it
      is the **only** statement separator on the raw-token path, because
      `parsePrimary`'s template sub-parse and `Engine`'s lazy-body parse construct a
      `Parser` over `Lexer.tokenize()` output, which contains no `Newline` at all.
      `new Parser(new Lexer("x = 1\ny = 2").tokenize()).parse()` yields two statements;
      the same tokens on one line are refused. Give the `> **New idea.**` primer on ASI
      here and note that tera's version reads token *lines*, never inserts a token.
- [ ] **§ set-piece-one-parse-control-condition** — establish the problem: after
      `if (` … `)` the parser cannot tell a finished condition from a left operand, because
      a braceless body may itself begin with `(`. Establish the mechanism:
      `parseControlCondition` calls `parsePrimary` (not `parseExpression`) for the group,
      then consults `continuesControlCondition`, which accepts a token only if it is in
      `PRECEDENCE` **or** in the three-element whitelist
      `CONDITION_CONTINUATION_OPERATORS = { ".", "?.", "?" }`. Establish why the whitelist
      is three entries and not "everything": `(`, `[` and `{` are exactly the tokens a
      braceless body can start with.
- [ ] **§ why-the-obvious-design-fails** — build the obvious parser and run it. On the
      tokens of `(x) (y)(z)`, plain `parseExpression` returns
      `CallExpression(CallExpression(x, [y]), [z])` — the body has been eaten by the
      condition. Establish that this is not fixable by "a bigger parser": an LR generator
      resolves it by grammar stratification (a separate non-terminal for a condition), a
      PEG by ordered choice; both are decisions about the *grammar*, and this parser makes
      the same decision as a three-element set. Then show the price: `while` and `switch`
      route through the same method, the four pinned body shapes (`y`, `{ y }`, `(y)(z)`,
      `[y].len()`) must all end the condition, and the three pinned spellings of a grouped
      `or` must still produce byte-identical trees.
- [ ] **§ set-piece-two-is-generic-call-ahead** — establish the second ambiguity: `f<T>(x)`
      versus `(a < b) > (c)`. Establish the mechanism: `isGenericCallAhead` scans forward
      from `<`, counting `<`/`>` depth, bailing out the moment it meets a punctuator not in
      `TYPE_ARGUMENT_PUNCTUATORS = { <, >, ,, ., [, ] }`, and succeeding only if the token
      *after* the balancing `>` is `(`. Establish that the scan never consumes — it reads
      `this.tokens` by index — and that it is unbounded in the worst case but terminates on
      the first non-type punctuator, which is why `((i < 9) ? ((i) > (acc)) : 1)` costs one
      token of lookahead and not a full scan.
- [ ] **§ the-syntax-plugin-contract** — establish the three-part contract in
      `extensions.ts`. (1) *Start-token indexing*: a plugin declares `statementStarts` /
      `expressionPrefixStarts` / `expressionInfixStarts`; `buildSyntaxPluginIndex` buckets
      them by token value and `syntaxPluginsFor` returns only the bucket plus the
      undeclared fallbacks, so a plugin that declares its keywords costs nothing on every
      other token. (2) *A restricted `ParserContext`*: 15 methods, not the `Parser`, so a
      plugin cannot reach `this.tokens` or `this.pos` — the only cursor control is
      `checkpoint()` / `restore()`. (3) *The bidirectional consumed-tokens assertion*: each
      of `parseExtensionStatement` / `parseExtensionPrefix` / `parseExtensionInfix` records
      `this.pos` before the call and errors **both** ways — a result with no tokens
      consumed, and tokens consumed with no result. Establish who this is for: no plugin
      ships in this tree; the real consumer is the sibling `reactive` package's
      `reactiveSyntaxPlugin`, reached through `Engine`'s `syntaxPlugins` option.
- [ ] **§ what-leaves** — the `ASTNode` handed to `[Ch 07]`, and the one thing this chapter
      deliberately did not do: it never looked at a type annotation.

## Honesty items

- > **Never runs.** No `SyntaxPlugin` is implemented anywhere in `src/`. `extensions.ts`
  defines the contract and `Parser` calls the three hooks on every statement and every
  expression, but in a default `node dist/cli.js <file>` run `this.syntaxPlugins` is empty
  and all three hooks return `null` immediately. The only in-tree implementations are
  fixtures in `tests/frontend/parser/extensions.test.ts`; the only real one is
  `reactiveSyntaxPlugin` from `@slexisvn/reactive/tera`, exercised by
  `tests/e2e/reactive/syntax.test.ts`. Nothing is broken — the cost note is that the
  contract's cost is paid on every token of every program for a feature no shipped program
  uses.
- > **Unenforced.** `ParserContext` hands a plugin `parseExpression`, `parseBlock`,
  `parseStatement` and `parseStatementBody`, so a plugin can recurse into the core grammar
  — but nothing bounds that recursion or the `depth` counter, and
  `assertHookStarts` validates only that declared starts have a matching hook. A plugin
  whose `parseStatement` calls `context.parseStatement()` without advancing recurses until
  the stack overflows; the consumed-tokens assertion fires only *after* the call returns.
- > **Unenforced.** `POSTFIX_PRECEDENCE` is derived from `PRECEDENCE`, but the unary arms
  of `parsePrimary` recurse at the **literal** `11` (nine call sites:
  `typeof`, `not`, `await`, `!`, `-`, `+`, `~`, prefix `++`/`--`, `delete`). Raising `**`
  above 11 in `PRECEDENCE` would silently change unary binding without touching those
  lines. A `UNARY_PRECEDENCE` derived the same way as `POSTFIX_PRECEDENCE` would close it.
- > **Unfinished.** `Parser.expect` (`src/frontend/parser/index.ts:305-312`) interpolates
  `tok.value` directly, so a `RegExp` or `TemplateLiteral` token renders as
  `[object Object]`:
  `node dist/cli.js -e 'x = 8
  print(x++ / 2)'` reports `Expected ')', got '[object Object]' (RegExp) at 2:11`.
  Finishing it costs a token-value formatter shared by `expect` and `error`.
- > **Never runs.** `Parser.skipBalancedBlock` and `Parser.skipGenericParameters`
  (`src/frontend/parser/index.ts:756` and `:976`) are public methods on an exported class
  with **no caller anywhere in `src/`, `tests/` or `tools/`**;
  `skipGenericParameters` is a one-line alias for `parseGenericArguments`, and
  `skipBalancedBlock` is the last survivor of a brace-delimited body grammar the language
  no longer has. Deleting both costs eleven lines and no behaviour.

## Verify it yourself

```bash
npx vitest run --project unit tests/frontend/parser/language.test.ts
npx vitest run --project unit tests/frontend/parser/extensions.test.ts
node dist/cli.js --print-ast -e 'print((15.7).to_fixed(2))'
node --input-type=module -e "import {parse} from './dist/index.frontend.js'; console.log(JSON.stringify(parse('if (x) (y)(z)').body[0].test))"
node --input-type=module -e "import {Lexer,Parser} from './dist/index.frontend.js'; const e=new Parser(new Lexer('(x) (y)(z)').tokenize()).parseExpression(); console.log(e.type, '->', e.callee.type)"
node --input-type=module -e "import {Lexer,Parser} from './dist/index.frontend.js'; console.log(new Parser(new Lexer('x = 1\ny = 2').tokenize()).parse().body.length)"
```

## Tests that pin this

- `tests/frontend/parser/language.test.ts` > `Parser > parenthesised control conditions` > *"a group condition still ends before a braceless body"* — the four spellings including `if (x) (y)(z)`
- `tests/frontend/parser/language.test.ts` > `Parser > parenthesised control conditions` > *"a leading group parses the same as the bare and the fully wrapped spellings"*
- `tests/frontend/parser/language.test.ts` > `Parser > parenthesised control conditions` > *"a leading group continues into any infix operator, not just and/or"*
- `tests/frontend/parser/language.test.ts` > `Parser > parenthesised control conditions` > *"while and switch take a leading group the same way"*
- `tests/frontend/parser/language.test.ts` > `Parser > parenthesised control conditions` > *"a parenthesised condition may be a sequence"*
- `tests/frontend/parser/language.test.ts` > `Parser > generic call disambiguation` > *"parses a comparison chain that ends in a parenthesised operand"*
- `tests/frontend/parser/language.test.ts` > `Parser > generic call disambiguation` > *"still treats an identifier followed by type arguments as a call"*
- `tests/frontend/parser/language.test.ts` > `Parser > generic call disambiguation` > *"parses a conditional whose branch compares parenthesised operands"*
- `tests/frontend/parser/language.test.ts` > `Parser > binary expressions` > *"exponentiation right associative"*
- `tests/frontend/parser/language.test.ts` > `Parser > logical expressions` > *"word logical operators normalize to logical nodes"*
- `tests/frontend/parser/language.test.ts` > `Parser > object expression` > *"rejects method shorthand with a brace body (blocks are offside-only)"*
- `tests/frontend/parser/language.test.ts` > `Parser > arrow functions` > *"rejects a brace block body (arrows take an expression body)"*
- `tests/frontend/parser/language.test.ts` > `Parser > reserved declaration keywords` > *"leaves an identifier that merely starts with a reserved word alone"*
- `tests/frontend/parser/extensions.test.ts` > `parser syntax extensions` > *"requires explicit opt-in for contextual syntax"*
- `tests/frontend/parser/extensions.test.ts` > `parser syntax extensions` > *"uses statement start keys to avoid unrelated parser calls"*
- `tests/frontend/parser/extensions.test.ts` > `parser syntax extensions` > *"lets plugins checkpoint and restore speculative parses"*
- `tests/frontend/parser/extensions.test.ts` > `parser syntax extensions` > *"rejects extension statements that do not advance the token stream"*
- `tests/e2e/reactive/syntax.test.ts` > `Tera reactive syntax` > *"lowers signal declarations to Signal calls"* — the only plugin that is not a fixture
- No test pins `consumeSemicolon`'s line-difference fallback directly. [unpinned]
