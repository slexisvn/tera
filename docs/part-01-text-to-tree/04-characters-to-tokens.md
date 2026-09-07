# 4. Characters to tokens   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** A lexer is a table plus a scan, and the interesting engineering is making the
table's invariants impossible to break rather than in the scan.

**What arrived.** A `string` — the bytes of `docs/example/stats.tera`, read by
`src/cli/main.ts` and handed to the engine untouched.

**What leaves.** A flat `Token[]`, terminated by exactly one `EOF`, with **no layout
tokens in it**. `Indent`, `Dedent` and `Newline` are declared in `TokenType` but the
`Lexer` class never produces one; that is `[Ch 05]`'s job.

**New ideas.** token vs. lexeme; lookahead; maximal munch; a *derived* table as a way of
making an invariant unbreakable rather than merely tested.

**Length.** 14 pages

## Anchors

- `src/frontend/lexer/index.ts` — the whole lexer, 529 lines. `TokenType` (11 kinds),
  the `Token` record type, `RESERVED_KEYWORDS`, `KEYWORDS`, `decodeEscape`, and class
  `Lexer` with `peek` / `peekAhead` / `advance` / `match` / `isAtEnd`,
  `skipWhitespaceAndComments`, `scanNumber`, `scanQuotedString`, `scanTemplateLiteral`,
  `scanIdentifier`, `canStartRegex`, `scanRegex`, `scanPunctuator`, `nextToken`,
  `tokenize`, `error`; module-private `isDigit`, `isHexDigit`, `isIdentStart`,
  `isIdentChar`.
- `src/frontend/operators.ts` — 86 lines, the whole table. `COMPOUND_ASSIGN_OPERATORS`,
  `BINARY_OPERATORS`, module-private `LOGICAL_OPERATORS` / `UPDATE_OPERATORS` /
  `STRUCTURAL_PUNCTUATORS`, `SINGLE_CHAR_PUNCTUATORS` (25 entries),
  `PUNCTUATOR_SPELLINGS`, and the derived `MULTI_CHAR_PUNCTUATORS` (31 entries).
- `src/core/class-visibility.ts` — `CLASS_VISIBILITIES` and `CLASS_ABSTRACT_MODIFIER`,
  spread into `KEYWORDS` so the keyword list cannot drift from the class-modifier list.
- `tests/frontend/lexer.test.ts` — 469 lines; the `describe("Lexer")` block is the
  behavioural spec for every scanner above.
- `tests/frontend/operators.test.ts` — 76 lines, 8 tests; two of them assert an *ordering
  property* of `MULTI_CHAR_PUNCTUATORS` rather than its contents.

## Worked example

`stats.tera`, tokenized by the raw `Lexer` (no layout). Then the extend-it exercise:

```bash
node dist/cli.js --print-ast -e 'print((15.7).to_fixed(2))'
```

- **Extend it.** `>>>=` already lives in `COMPOUND_ASSIGN_OPERATORS` and is already the
  sole four-character entry at the head of the derived table — proof the mechanism works.
  The genuinely-new addition is `??=`, which JavaScript has and tera does not. Add the
  single string `"??="` to `COMPOUND_ASSIGN_OPERATORS`; edit no other file; run
  `tests/frontend/operators.test.ts`. It passes, because
  *"carries every compound assignment operator through to the lexer"* re-derives its own
  expectation from the table it is testing.
- **Then break it deliberately.** Flip the comparator in `MULTI_CHAR_PUNCTUATORS` from
  `right.length - left.length` to `left.length - right.length`. Five of the eight tests go
  red, and the two that name the invariant rather than an answer go red *first*:
  *"orders multi-character punctuators longest first so maximal munch holds"* and
  *"never lists a punctuator after one it is a prefix of"*.

## Outline

- [ ] **§ eleven-kinds-and-four-fields** — establish that `TokenType` is a `const object`,
      not a TS `enum`, so its values are plain strings and `TokenTypeName` is derived from
      it; that a `Token` is exactly `{type, value, line, column}` with no `end` and no
      length; and that `TokenValue` is a three-way union — `string`, `{pattern, flags}`,
      `{parts, expressions}` — which is why every consumer calls `tokenString(tok, ctx)`
      before treating a value as text. Name the three layout kinds the `Lexer` declares
      and never emits, and forward-reference `[Ch 05 § tokenize-is-the-entry-point]`.
- [ ] **§ forty-seven-words** — establish that `KEYWORDS` has exactly 47 members and that
      three of them (`let`, `const`, `var`) exist **only to be refused**: they lex as
      `Keyword`, and `Parser.rejectReservedKeyword` turns them into the sentence
      `'let' is not a tera keyword; declare a variable as 'name: type = value' or 'name = value'`.
      Establish why refusing beats not-knowing: an identifier named `lets` still works.
      Establish that `CLASS_VISIBILITIES` and `CLASS_ABSTRACT_MODIFIER` are *spread in*
      from `src/core/class-visibility.ts` rather than retyped, and that `void` is
      deliberately **not** a keyword.
- [ ] **§ numbers** — establish the four scanning shapes in `scanNumber`: radix prefixes
      (`0x`/`0X`, `0b`/`0B`, `0o`/`0O`, each with its own digit predicate), `_` separators
      stripped from the *value* but counted in the *column*, the fraction, and the
      exponent. Establish the dot-versus-dot-dot lookahead
      (`this.peek() === "." && this.peekAhead() !== "."`) and show what it actually buys:
      `1..2` scans as `Number("1") Punctuator(".") Number(".2")`, three tokens the parser
      then refuses. `..` is not in either punctuator table and no tera rule accepts it.
- [ ] **§ strings-and-the-silent-deletion** — establish that `decodeEscape` is a five-arm
      switch (`n`, `t`, `r`, `\`, default→identity) and that the identity arm is what makes
      `\"` and `\'` work. Establish the cost: `"a\u0041b"` yields `au0041b`, `"\x41"` yields
      `ax41`, `"\0"` yields `0`, `\v` and `\f` lose their backslash — silently, in every
      tier. Establish *why* it is stuck: `decodeEscape(esc: string)` receives one character
      and has no access to the cursor, so a multi-character escape cannot be read without
      changing its signature.
- [ ] **§ template-literals** — establish that `scanTemplateLiteral` produces
      `{parts, expressions}` where `parts.length === expressions.length + 1`, and that
      `expressions` are **raw substrings**, captured by counting `{`/`}` to depth zero, not
      by recursive lexing. Establish the consequence the parser inherits: `parsePrimary`
      constructs a fresh `Lexer` and a fresh `Parser` per expression, which is why the
      nodes inside `${}` restart at line 1 column 1 — carried forward to
      `[Ch 07 § where-spans-are-lost]`.
- [ ] **§ regex-or-division** — establish that `canStartRegex()` reads `this.lastToken`
      and nothing else, and walk its four arms. Then show three places one token is not
      enough: `if (x) /re/.test(s)` (after `)` the lexer commits to division, so the regex
      cannot be written), `m = {} / 2 /` (after `}` it commits to regex), and `x++ / 2`
      (after `++` it commits to regex, and the program is refused). Establish the general
      rule: a scanner that guesses from one token buys a one-field state machine and pays
      in un-writable programs.
- [ ] **§ maximal-munch** — establish `scanPunctuator` as a linear scan of
      `MULTI_CHAR_PUNCTUATORS` with `String.prototype.startsWith`, falling back to
      `SINGLE_CHAR_PUNCTUATORS`, then `this.error`. Establish the invariant this scan
      depends on and cannot itself check: **a spelling must never appear after one it is a
      prefix of.** Give the `> **New idea.**` primer on maximal munch here, with
      `>>>=` / `>>>` / `>>` / `>` as the worked ladder.
- [ ] **§ why-the-obvious-design-fails** — stage the obvious design: a hand-written
      `MULTI_CHAR_PUNCTUATORS` array. Show that it must be kept in three-way agreement
      with `COMPOUND_ASSIGN_OPERATORS`, `BINARY_OPERATORS` and the parser's `PRECEDENCE`
      table, and that the failure mode is silent — a mis-ordered entry does not crash, it
      quietly re-splits a program's operators. Establish that a *test* of the array's
      contents does not help, because the same hand that adds the entry writes the test.
- [ ] **§ derived-punctuator-table** — establish the four-step derivation, quoting
      `operators.ts:82-86` in full (5 lines): union the five spelling groups, dedupe with
      `new Set`, drop the single characters, drop the word-shaped ones with
      `/^[^\w\s]+$/` (this is what removes `instanceof` and `in`), then sort by descending
      length. Establish that the sort is the enforcement, and that within one length band
      no prefix relation can exist, so descending length is *sufficient* and not merely
      heuristic. Establish the resulting shape: 31 entries, one four-character, then the
      three-character band, then two.
- [ ] **§ invariant-enforcement-test** — state it in the book's order. *Invariant:* longest
      match wins. *Enforcement:* the `.sort()` on `operators.ts:86`, plus the `/^[^\w\s]+$/`
      filter that keeps word operators out of a character scan. *Test:* the two ordering
      tests, which assert a property of any table rather than the contents of this one —
      which is why adding `??=` needs no test edit and mis-sorting is caught immediately.
- [ ] **§ what-leaves** — the `Token[]` handed to `[Ch 05]`, and the one thing it is
      missing: any notion of a line being a unit.

## Honesty items

- > **Unfinished.** `Lexer.scanNumber` (`src/frontend/lexer/index.ts:212-247`) accepts a
  radix prefix with **zero digits**. `0x` scans as `Number("0x")`, `parsePrimary` turns it
  into `Literal(Number("0x"))` = `NaN`, and `node dist/cli.js -e 'print(0x)'` prints `NaN`
  with no lexer, parser or checker diagnostic in any of the four tiers. Finishing it costs
  three `this.error(...)` calls (one per radix arm, guarded on "no digit consumed") and
  three cases in `tests/frontend/lexer.test.ts`.
- > **Unfinished.** `decodeEscape` (`src/frontend/lexer/index.ts:93-106`) implements four
  escapes. `\uXXXX`, `\u{...}`, `\xXX` and `\0` are not decoded and the backslash is
  silently dropped: `node dist/cli.js -e 'print("A: \u0041")'` prints `A: u0041`.
  Finishing it costs a signature change — `decodeEscape` takes a single character and
  would need the scanner cursor to consume a code-point count — plus the same change in
  `scanQuotedString` and `scanTemplateLiteral`, which both call it.
- > **Broken.** `Lexer.canStartRegex` (`src/frontend/lexer/index.ts:370-396`) excludes only
  `)` and `]` among punctuators, so a division after a postfix `++`/`--` is scanned as a
  regex. `node dist/cli.js -e 'x = 8
  print(x++ / 2)'` is refused with
  `[Parser] Expected ')', got '[object Object]' (RegExp) at 2:11`. Two defects in one
  line: the wrong branch, and `Parser.expect` rendering a non-string token value as
  `[object Object]`. Fixing the first costs one added condition and one test; the second
  costs a token-value formatter in `Parser.error`.
- > **Dead.** `tests/frontend/operators.test.ts:72` — inside
  *"keeps single-character punctuators reachable when no longer match applies"*, the guard
  `if (spelling === "@") continue;` skips a case that passes: `a @ b` scans as the single
  punctuator `@`, and *"tokenizes tensor matmul"* in `tests/frontend/lexer.test.ts` already
  pins it. Removing the guard costs one line.
- > **Unenforced.** Nothing checks that `PUNCTUATOR_SPELLINGS` and the parser's
  `PRECEDENCE` table (`src/frontend/parser/index.ts:158-187`) agree. A spelling can be
  added to `BINARY_OPERATORS`, scan correctly, and then be dropped on the floor by
  `parseExpressionFrom` because `PRECEDENCE[tok.value]` is `undefined`. A test asserting
  that every symbolic entry of `BINARY_OPERATORS` has a precedence would close it.

## Verify it yourself

```bash
npx vitest run --project unit tests/frontend/lexer.test.ts tests/frontend/operators.test.ts
node --input-type=module -e "import {KEYWORDS,TokenType} from './dist/index.frontend.js'; console.log(KEYWORDS.size, Object.keys(TokenType).length)"
node --input-type=module -e "import {Lexer} from './dist/index.frontend.js'; console.log(new Lexer('a >>>= b').tokenize().map(t=>String(t.value)).join(' | '))"
node dist/cli.js -e 'print(0x)'
node dist/cli.js -e 'print("A: \u0041")'
node dist/cli.js --print-ast -e 'print((15.7).to_fixed(2))'
```

## Tests that pin this

- `tests/frontend/operators.test.ts` > `operator table` > *"orders multi-character punctuators longest first so maximal munch holds"*
- `tests/frontend/operators.test.ts` > `operator table` > *"never lists a punctuator after one it is a prefix of"*
- `tests/frontend/operators.test.ts` > `operator table` > *"carries every compound assignment operator through to the lexer"*
- `tests/frontend/operators.test.ts` > `operator table` > *"keeps word-shaped binary operators out of the punctuator table"*
- `tests/frontend/operators.test.ts` > `operator table` > *"scans the longest operator when a shorter one is a prefix"*
- `tests/frontend/operators.test.ts` > `operator table` > *"keeps single-character punctuators reachable when no longer match applies"*
- `tests/frontend/lexer.test.ts` > `Lexer > numbers` > *"all numeric formats tokenize correctly"*
- `tests/frontend/lexer.test.ts` > `Lexer > numbers` > *"leading-dot, trailing-dot and numeric separators"*
- `tests/frontend/lexer.test.ts` > `Lexer > strings` > *"escape sequences across quote styles"*
- `tests/frontend/lexer.test.ts` > `Lexer > template literals` > *"template with nested braces"*
- `tests/frontend/lexer.test.ts` > `Lexer > identifiers and keywords` > *"treats void as a type identifier, not an operator keyword"*
- `tests/frontend/lexer.test.ts` > `Lexer > regex` > *"division not regex after identifier"*
- `tests/frontend/lexer.test.ts` > `Lexer > comments` > *"still distinguishes division and regex after comments"*
- `tests/frontend/lexer.test.ts` > `Lexer > EOF` > *"EOF is sole token for empty input and last token otherwise"*
- `tests/frontend/lexer.test.ts` > `Lexer > Tera operators` > *"tokenizes tensor matmul"*
- No test pins the `0x`-with-no-digits case, the missing `\u` escape, or the `x++ / 2`
  mis-scan. [unpinned]
