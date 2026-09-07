# 5. The Program That Indents But Does Not Nest   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** tera's layout pass is not Python's, and the single asymmetry — `Indent` only
after a colon-terminated line — is what buys fluent method chains and multi-line argument
lists for free.

**What arrived.** The flat `Token[]` of `[Ch 04 § what-leaves]` — or rather, one such array
per source line, because this pass never lexes the whole file at once.

**What leaves.** One `Token[]` with `Indent`, `Dedent` and `Newline` woven in, every
`Indent` matched by a `Dedent`, terminated by a single `EOF` on the line after the last
non-blank one. `docs/example/stats.tera` produces 188 tokens: 6 `Indent`, 6 `Dedent`,
19 `Newline`.

**New ideas.** The off-side rule; layout tokens as a way to give a whitespace-sensitive
language a whitespace-insensitive grammar; an indent stack; the difference between a
*continuation line* and a *nested block*.

**Length.** 12 pages

## Anchors

- `src/frontend/lexer/offside.ts` — 111 lines, the whole pass. Exported `leadingSpaces`
  and `tokenize`; module-private `token`, `layout`, `isBlankOrComment`,
  `continuesMemberChain`, `delimiterDelta`, `tokenizeFragment`. The state is five locals
  in `tokenize`: `indents`, `delimiterDepth`, `pendingBlock`, `lastLine`, `baseIndentSet`.
- `src/frontend/parser/language.ts` — 12 lines. `parse()` calls `tokenize` from
  `../lexer/offside.js`, not `Lexer.tokenize`. This is the file that makes the off-side
  pass the real entry point for every tera program in every tier.
- `src/cli/repl/multiline.ts` — 125 lines, the *second* implementation. `assess`,
  `nextIndent`, `lineContinuation`, `stripLineContinuation`; module-private
  `tokenizeSafely`, `collectLines`, `isContinuation`, `endsBlock`, `trackBlocks`, plus
  `OPENERS` / `CLOSERS` / `CONTINUATION_PUNCT` / `CONTINUATION_KEYWORD`. It imports
  exactly one symbol from `offside.ts`: `leadingSpaces`.
- `tests/frontend/lexer.test.ts` — the `describe("offside indentation")` block at line 432
  and `describe("layout")` at line 28.
- `tests/cli/repl.test.ts` — `describe("multiline.assess")`, the only spec for the second
  implementation.

## Worked example

`docs/example/stats.tera` with its layout tokens made visible, then the same file with one
character deleted:

```bash
node --input-type=module -e "import {tokenize} from './dist/index.frontend.js'; import fs from 'node:fs'; const t=tokenize(fs.readFileSync('docs/example/stats.tera','utf8')); console.log(t.length, JSON.stringify(t.filter(x=>['Indent','Dedent','Newline'].includes(x.type)).reduce((a,x)=>(a[x.type]=(a[x.type]||0)+1,a),{})))"
```

- Delete the `:` after `class Series` and the six-token layout skeleton of the class body
  disappears: with the colon, `class Series:` / `  a = 1` yields
  `Keyword Identifier Punctuator Newline Indent Identifier … Newline Dedent EOF`; without
  it, `Keyword Identifier Newline Identifier … Newline EOF` — **no `Indent`, no `Dedent`**.
  The indented line simply became more top-level tokens.
- On the real 24-line file the deletion surfaces four lines later, as
  `[Lexer] unindent does not match any outer indentation level at 6:3`, because `mean()`
  at indent 2 has nothing at indent 2 to return to.

## Outline

- [ ] **§ tokenize-is-the-entry-point** — establish that `parse()` in
      `src/frontend/parser/language.ts` calls `tokenize` from `offside.ts`, and that
      `Lexer.tokenize` is reached only through `tokenizeFragment` (one line at a time),
      through `parsePrimary`'s template sub-parse, and through the REPL. Establish that
      this makes the off-side pass, not the character scanner, the thing every tier
      actually runs. Give the `> **New idea.**` primer on the off-side rule here.
- [ ] **§ the-indent-stack** — establish `indents = [0]` and the `baseIndentSet` seeding:
      the *first non-blank line* overwrites `indents[0]` with its own indent, so a whole
      program indented six spaces is legal. Give the `> **New idea.**` primer on an indent
      stack: push on deepening, pop-until-match on shallowing, and the invariant that the
      stack is strictly increasing.
- [ ] **§ pending-block-and-the-colon-gate** — establish the asymmetry that names the
      chapter. `endsBlock` is true only when `delimiterDepth === 0` **and** the line's last
      token is the punctuator `:`. Only then is `pendingBlock` set; and only when
      `pendingBlock` is set can the *next* line push an `Indent`. Establish that
      `pendingBlock` holds the colon token but is read only for truthiness — it is a
      one-line memory, not a value.
- [ ] **§ why-the-obvious-design-fails** — stage the obvious design: *indent increases ⇒
      `INDENT`*, Python's rule. Show two programs it breaks, both of which run today:
      (a) a fluent chain, `xs` / `  .map(v => v * 2)` / `  .join("-")`, which under the
      obvious rule opens a block after `xs` and never closes it; (b) a multi-line
      named-argument call, `box(` / `  width = 3,` / `  height = 4,` / `)`, which under the
      obvious rule opens a block inside a parenthesis. Establish that the colon gate is
      what makes both *continuation lines* rather than nested blocks, at the cost of one
      required character.
- [ ] **§ delimiter-delta** — establish `delimiterDelta(lineTokens)` as a running
      `(`/`[`/`{` minus `)`/`]`/`}` count over the *punctuators of one line*, accumulated
      into `delimiterDepth`. Establish the three things a non-zero depth suspends: the
      dedent check, the `endsBlock` test, and the `Newline` emission. Establish the
      `if (delimiterDepth < 0) delimiterDepth = 0` clamp on line 102 and what it is
      protecting against — an unbalanced closer must not make the rest of the file
      layout-free.
- [ ] **§ continues-member-chain** — establish `continuesMemberChain(lines, i)` as a
      forward scan past blanks and comments to the next real line, matched against
      `/^(\?\.|\.)\s*[A-Za-z_$]/`. Establish that a match *suppresses the `Newline`*, which
      is the entire mechanism behind fluent chains, and that the `[A-Za-z_$]` tail is what
      stops a line beginning `.5` from being read as a continuation.
- [ ] **§ dedent-alignment** — establish the pop-until-not-deeper loop, the `dedented`
      flag, and the one error this pass raises:
      `[Lexer] unindent does not match any outer indentation level at <line>:<col>`, with
      the column reported as `indent + 1`. Quote it verbatim and show the pinned 4:5 case.
      Establish why the check must be *after* the loop and not inside it.
- [ ] **§ the-flush** — establish the tail of `tokenize`: pop the remaining stack emitting
      `Dedent` at `lastLine`, then a single `EOF` at `lastLine + 1, column 1`. Establish
      the invariant this guarantees the parser — `Indent` and `Dedent` counts are equal in
      any accepted program — and name its enforcement (the loop itself) and its test.
- [ ] **§ what-it-costs-one-line-at-a-time** — establish that `tokenizeFragment` builds a
      **new `Lexer` per line** and re-bases its spans, and walk the three consequences:
      (a) a multi-line block comment is not a comment; (b) a multi-line template literal is
      a lexer error; (c) `Lexer.lastToken` resets at every line start, so the
      regex-versus-division decision of `[Ch 04 § regex-or-division]` is re-made from
      *nothing* on each line, and a line beginning with `/` is always a regex.
- [ ] **§ the-second-implementation** — establish that `src/cli/repl/multiline.ts`
      re-implements this rule for "is the buffer finished?", sharing only `leadingSpaces`.
      Put the two side by side: `offside.ts`'s `endsBlock` is an inline expression on line
      92; `multiline.ts`'s is a named function on line 55 with the same two clauses.
      `offside.ts` tracks `pendingBlock` as a token; `multiline.ts` tracks
      `pendingHeader` + `pendingIndent`. Establish the divergence that matters: `assess`
      lexes the **whole buffer** with one `Lexer`, so it accepts multi-line templates that
      `tokenize` then refuses.
- [ ] **§ what-leaves** — the layout-bearing `Token[]` handed to `[Ch 06]`, and the two
      token kinds the parser will treat as brackets: `Indent` and `Dedent`.

## Honesty items

- > **Broken.** `tokenizeFragment` (`src/frontend/lexer/offside.ts:40-44`) lexes one line
  at a time, so `/* … */` spanning lines is not a comment. `/*` opens a comment that ends
  with the line; the middle lines lex as code; the closing `*/` lexes as `*` followed by a
  `/` that `canStartRegex` accepts, swallowing the rest of the line as a regex. The
  program is refused with `[Parser] Unexpected token '*' (Punctuator) at 3:1`. The raw
  `Lexer` handles the same input correctly and
  *"skips block comments without confusing them for regex"* in
  `tests/frontend/lexer.test.ts` pins the raw behaviour — so the test passes while the
  real entry point cannot. Fixing it costs a comment-state carry across lines (a sixth
  local in `tokenize`) plus the same for template state.
- > **Broken.** The same line-at-a-time split makes a multi-line template literal a lexer
  error: `s = ` backtick `one` / `two` backtick is refused with
  `[Lexer] Unterminated template literal at 1:5`. Same fix, same file.
- > **Unenforced.** Nothing checks that `src/cli/repl/multiline.ts` and
  `src/frontend/lexer/offside.ts` agree about where a block starts. They share only
  `leadingSpaces`; `endsBlock` and the indent-stack walk are written twice. A test that
  fed the same source to both and compared "does a block open here" would close it — there
  is none today.
- > **Unfinished.** `pendingBlock` (`src/frontend/lexer/offside.ts:51`) is typed
  `Token | null` and assigned the colon token, but every read is a truthiness test. It
  carries a token's worth of information nothing uses. Either narrow it to `boolean` (one
  line) or use it to report *which* colon opened an un-indented block, which would turn
  the missing-body case from a downstream parser error into a layout diagnostic.
- > **Unenforced.** No test asserts the `EOF` position contract (`lastLine + 1`, column 1)
  or the "one `EOF` only" property for the layout pass; `tests/frontend/lexer.test.ts` >
  *"EOF is sole token for empty input and last token otherwise"* pins it for the raw
  `Lexer` only.

## Verify it yourself

```bash
node --input-type=module -e "import {tokenize} from './dist/index.frontend.js'; import fs from 'node:fs'; const t=tokenize(fs.readFileSync('docs/example/stats.tera','utf8')); console.log(t.length, JSON.stringify(t.filter(x=>['Indent','Dedent','Newline'].includes(x.type)).reduce((a,x)=>(a[x.type]=(a[x.type]||0)+1,a),{})))"
node --input-type=module -e "import {tokenize} from './dist/index.frontend.js'; const s=x=>tokenize(x).map(t=>t.type).join(' '); console.log('with   :', s('class Series:\n  a = 1')); console.log('without:', s('class Series\n  a = 1'))"
node dist/cli.js -e 'xs = [1, 2, 3]
print(xs
  .map(v => v * 2)
  .join("-"))'
node dist/cli.js -e 'fn f(n):
  while n:
      a = 1
    b = 2'
npx vitest run --project unit tests/frontend/lexer.test.ts
npx vitest run --project unit tests/cli/repl.test.ts
```

## Tests that pin this

- `tests/frontend/lexer.test.ts` > `offside indentation` > *"rejects a dedent that matches no enclosing block"*
- `tests/frontend/lexer.test.ts` > `offside indentation` > *"reports the line and column of the offending dedent"*
- `tests/frontend/lexer.test.ts` > `offside indentation` > *"accepts a dedent that returns to an enclosing level"*
- `tests/frontend/lexer.test.ts` > `offside indentation` > *"accepts a whole program indented from a common base"*
- `tests/frontend/lexer.test.ts` > `offside indentation` > *"balances indent and dedent tokens across nested blocks"*
- `tests/frontend/lexer.test.ts` > `Lexer > layout` > *"emits layout tokens for indentation blocks"*
- `tests/frontend/lexer.test.ts` > `Lexer > comments` > *"skips block comments without confusing them for regex"* — pins the **raw** `Lexer`, not `tokenize`
- `tests/cli/repl.test.ts` > `multiline.assess` > *"waits for a block body after a colon header"*
- `tests/cli/repl.test.ts` > `multiline.assess` > *"keeps reading while brackets are open"*
- `tests/cli/repl.test.ts` > `multiline.assess` > *"keeps reading an open block until a blank line"*
- `tests/cli/repl.test.ts` > `multiline.assess` > *"handles nested control flow blocks"*
- No test pins `continuesMemberChain`, the multi-line block comment, the multi-line
  template, or the per-line `lastToken` reset. [unpinned]
