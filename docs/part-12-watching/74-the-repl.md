# 74. The REPL   ⟨**I** · B · J · N⟩

> **Status:** outline

**Thesis.** An indentation-sensitive language turns "is this statement finished?" from a
counting problem into a state problem, and completion has to answer questions about values
that do not exist yet.

**What arrived.** `dist/cli.js` with eight commands over one `CommandSpec` table, and an
`EngineOptions` object built by `buildEngineOptions` — the same object for `run`, `repl` and
`debug`, so a REPL started with `--no-opt` really has tiering off ([Ch 73 §
buildengineoptions-is-a-layering]).

**What leaves.** One `Engine` driven a statement at a time by `runSession`, plus the two
ways to ask it what a name means: `Engine.introspectMembers`, which walks the *live*
prototype chain of a value that exists, and a `SourceSymbolTable` from
`buildSourceSymbolTable`, which answers from *text* for values that do not. Chapter 75 stops
the same engine mid-instruction and asks the first of those questions of a frame instead of
a global.

**New ideas.** A read–eval–print loop as a state machine over a *buffer*, not a line; a
"forced" continuation as an escape hatch a parser cannot supply; a completion *provider
chain*; a symbol table built from source text rather than from a running program; error
recovery by rewriting the source before parsing it; edit distance (Levenshtein) and why it
must be bounded; one data file as the single source for four tools.

**Length.** 12 pages

## Anchors

- `src/cli/repl/multiline.ts` — `Completeness` (`{complete, indent}`), `assess` (80-108),
  `tokenizeSafely` (19-26), `collectLines` (28-46), `isContinuation` (48-53), `endsBlock`
  (55-57), `BlockState` and `trackBlocks` (59-78), `lineContinuation` (110-114),
  `stripLineContinuation`, `nextIndent` (120-125), and the two token sets
  `CONTINUATION_PUNCT` (10-14) and `CONTINUATION_KEYWORD` (15).
- `src/cli/repl/session.ts` — `SessionDeps` (15-28), `settlePromise` (37-44), `runSession`
  (46-138), `replModules` (30-35). The loop body: `publishPending`, the
  `COMMAND_PREFIX`/`HELP_PREFIX` dispatch guarded by `!inBlock` (100-113), `lineContinuation`
  then `result.forceContinue` (117-124), then `assess` (126-130).
- `src/cli/repl/index.ts` — `startREPL` (28-76), `engineGlobalNames` (17-20), the `pending`
  variable and `liveSource = () => joinSource(state.source(), pending)` (42-43), and the
  `publishPending` closure that writes it (71).
- `src/cli/repl/completion.ts` — `CompleterDeps` (14-21), `createCompleter` (99-119),
  `buildProviders` (61-77) with its four providers in order, `memberCandidates` (33-49),
  `identifierCandidates` (51-59), `scopeNames` (23-31), `rank` (79-97), the two line
  patterns `META_LINE` / `HELP_LINE` (11-12).
- `src/cli/repl/analysis.ts` — `createAnalyzer` (16-53), `combine` (11-14), `inferSafely`
  (28-34), the one-entry `cacheKey`/`cached` pair (25-26), and the
  `recoverMemberCompletionSource` → `inferSymbolTypes` → `buildSourceSymbolTable` chain
  (40-42).
- `src/frontend/editor-analysis.ts` — `recoverMemberCompletionSource` (3-5),
  `positionAt`/`offsetAt` (7-37), `stringLiteralTextRanges` (115-187),
  `stringLiteralTextPredicate` (99-113, a binary search), `isStringLiteralTextOffset` (90-92),
  `resolveMemberReceiverType` (194-208), `extractReceiverExpression` (210-228),
  `leadingDotReceiverExpression` (230-243), `resolveExpressionType` (245-270),
  `returnTypeAfterArrow`, `skipBalancedParens`.
- `src/cli/repl/signature.ts` — `openCallParen` (18-33), `calleeAt` (35-37),
  `resolveSignature` (44-58), `computeSignature` (60-69), `attachSignatureHint` (71-126).
- `src/cli/repl/suggest.ts` — `boundedDistance` (3-20) and `suggestNames` (22-33), with
  `MAX_SUGGEST_DISTANCE = 2` / `MAX_SUGGESTIONS = 3` from `src/cli/repl/config.ts`.
- `src/cli/repl/display.ts` — `createPrinter`, `IDENTIFIER_PATTERNS` (6-11),
  `extractIdentifier`, and the `did you mean:` line (47-54).
- `src/cli/repl/text.ts` — `splitTrailingWord`, `nonSpaceBefore`, `isMemberAccess`,
  `ownerExpression`, `joinSource`, `indentString`, `increaseIndent`, `lastNonBlankLine`.
- `src/cli/repl/input.ts` — `createInput`, `KEY_BINDINGS` (17-41) mapping `ALT_ENTER` to
  `submit`, `CONTINUE_KEYS` (53), `AUTO_CLOSE_PAIRS` (8-15), `reserveLineBelow` (55-61).
- `src/cli/repl/session-state.ts` — `createSessionState`: `source()`, `append`, `reset`.
  `append` is called only after a successful `evaluate`.
- `src/runtime/introspect.ts` — `introspectReceiverMembers` (35-38), `parseReceiverPath`
  (18-22), `resolveReceiverValue` (24-33), `objectMembers` (52-62) walking
  `level.prototype`, `functionMembers` (64-72) walking `staticBase`, `classifyOwnMember`
  (98-103), `isVisible` (118-122).
- `src/api/engine.ts:1514` — `Engine.introspectMembers`, wrapping
  `introspectReceiverMembers` in `runInRuntime`.
- `src/cli/repl/language.ts` — `createLanguage`, `Language.signatureOf`, `describe`,
  `globalNamespaces`, all built by `buildLanguageDataFromSpec`.
- `src/frontend/language-data.ts` — `LanguageData`, `Builtin`, `Method`, `Signature`,
  `collectLanguageDataSource` (148), `buildLanguageData` (162),
  `buildLanguageDataFromSpec` (175-176), `parseParams` (356).
- `src/cli/repl/highlight.ts` — `TERA_TOKEN_REGEXP` (20), `classify` (22-36),
  `createTokenHook`; the REPL highlighter reads `Language`, not the lexer.
- `tools/editor/src/language-data.ts` — the CodeMirror editor calling the same
  `buildLanguageDataFromSpec` on the same `data/tera-language-spec.ts` tables.
- `vscode-ext/scripts/generate.ts` — `generate()` calling `collectLanguageDataSource` +
  `buildLanguageData`, then `buildGrammar` and `buildSnippets`, writing
  `syntaxes/tera.tmLanguage.json`, `language-data.json` and `snippets/tera.json`.

## Worked example

`a = Map()` submitted with **Alt+Enter** — so it is *never evaluated* — and then `a.g`
completing to `a.get` on the next line. This is the static path: no `Map` exists in the
engine, so `introspect("a")` returns `null` and the answer comes from a symbol table built
over the pending buffer. Beside it, `bag.` completing to `alpha`/`beta` from a live object
whose keys were added by assignment and appear in no declaration at all — the live path.

```bash
npx vitest run --project e2e tests/e2e/cli/repl/session.test.ts -t "unevaluated multiline buffer"
npx vitest run --project e2e tests/e2e/cli/repl/introspect.test.ts
```

The first is `tests/e2e/cli/repl/session.test.ts` >
`"lets completion see a name declared earlier in the unevaluated multiline buffer"`, which
drives `runSession` with a scripted `readLine` returning
`{ text: "a = Map()", forceContinue: true }` and asserts `complete("a.g") === "a.get"`.

## Outline

- [ ] **The loop is over a buffer, not a line.** Establish `runSession`'s two pieces of
      state — `buffer` and `indentHint` — and that everything else in the loop decides which
      of them to write. Establish the prompt swap (`PRIMARY_PROMPT` `tera> ` vs
      `CONTINUATION_PROMPT` `...   `) as the only user-visible signal of that state, and
      `readLine(prompt, inBlock ? indentHint : "")` as how the computed indent is *pre-typed*
      into the next line rather than merely suggested. Pin with
      `"accumulates an indented block until a blank line then evaluates it"`.
- [ ] **`assess` answers two questions at once.** Establish `Completeness = {complete,
      indent}` and why they are one function: the same scan that decides whether to keep
      reading is the only thing that knows how far to indent. **New idea:** in a
      brace language "finished?" is a counter reaching zero; under the offside rule it is a
      *state* — a block stays open across blank-looking text, and the answer depends on the
      indentation of lines already typed.
- [ ] **Five ways to say "keep reading".** Walk `assess` in order and establish that it
      returns `complete: false` from five distinct places, each with a *different* indent:
      an unterminated string (`tokenizeSafely` catching, `/Unterminated/` on the message —
      indent unchanged); `endDepth > 0` from `collectLines` counting `OPENERS`/`CLOSERS`
      (indent one unit deeper); `blocks.pendingHeader` from `endsBlock`, a line whose last
      token at depth zero is `:` (indent = header indent + `INDENT_UNIT`); a trailing token
      in `CONTINUATION_PUNCT` or `CONTINUATION_KEYWORD` (indent unchanged); and
      `insideBlock && !lastBlank`, which is the rule that a body ends at a blank line.
      Land the honest correction to the tidy story: three of these are structural, one is a
      lexer failure, and one is a *user-interface* rule with no counterpart in the grammar.
      Pin with `"waits for a block body after a colon header"`,
      `"keeps reading while brackets are open"`, `"keeps reading after a trailing operator"`
      and `"handles nested control flow blocks"`.
- [ ] **`trackBlocks` is a miniature offside stack.** Establish `BlockState.indents`
      starting at `[0]`, pushing on the line *after* a header when it is deeper, popping
      while the current line is shallower, and skipping any line whose `startDepth !== 0`
      because a continued bracket expression has no indentation meaning. Establish that it
      re-derives indentation with `leadingSpaces` imported from
      `src/frontend/lexer/offside.ts` — the one thing it shares with the real lexer.
      **Why the obvious design fails:** running the offside lexer and asking "did it parse?"
      cannot distinguish *not yet* from *wrong*, and a REPL must tell those apart on every
      keystroke; `tokenizeSafely` therefore treats a lexer throw as `complete: true` unless
      the word `Unterminated` appears in the message, so a genuinely broken line is handed
      to the engine to produce a real diagnostic rather than trapping the user in a
      continuation prompt.
- [ ] **Two escapes the analysis cannot supply.** Establish the trailing backslash
      (`lineContinuation` counting backslashes and taking the parity, so `\\` at end of line
      is a literal, not a continuation) and `forceContinue`, set by `createInput` when the
      keypress that submitted was `ALT_ENTER`/`ALT_KP_ENTER` — bound to `submit` in
      `KEY_BINDINGS` and detected by a separate `key` listener. Establish the ordering in
      `runSession`: both are checked *before* `assess`, so a forced continuation keeps a
      buffer open that `assess` would call complete. Pin with
      `"treats a single trailing backslash as a continuation"`,
      `"ignores an escaped (even) trailing backslash"`,
      `"keeps typing on a new line when a line ends with a backslash"` and
      `"keeps reading after a forced continuation even when the buffer is complete"`.
- [ ] **`runSession` never touches a terminal.** Establish `SessionDeps` as eleven injected
      capabilities — `readLine`, `printer`, `clearScreen`, `publishPending` — and that this
      is what makes the loop testable: `tests/e2e/cli/repl/session.test.ts` supplies a
      scripted `readLine` and a `Terminal` that is the empty function. Establish
      `startREPL` in `index.ts` as the only place terminal-kit appears, and the honest
      consequence in *Honesty items*.
- [ ] **`.` and `?` are only prefixes at the top of a buffer.** Establish the
      `COMMAND_PREFIX` (`.`) and `HELP_PREFIX` (`?`) dispatch sitting inside `if (!inBlock)`,
      so `.5` on a continuation line is a number and `.exit` inside an open block is source.
      Establish `showDocumentation` reading `Language.describe`, and that the same two
      prefixes reappear in completion as `META_LINE` and `HELP_LINE` regexes. Pin with
      `"runs meta commands and lists help"`, `"stops the loop on .exit"`,
      `"shows documentation for a builtin via ?name"` and
      `"completes command names after a dot"`.
- [ ] **`settlePromise`: the REPL is where the microtask queue becomes visible.** Establish
      that `engine.run` returns a `TaggedValue` which may be a promise, that
      `settlePromise` calls `engine.drainMicrotasks?.()` and then reads
      `PromisePayload.state`, unwrapping `fulfilled` to `payload.result` and re-throwing
      `rejected` through `toDisplayString`. Establish the honest third case: `pending`
      falls through and the promise itself is printed. Cross-reference [Ch 30 §
      microtasks] and [Ch 73 § exit-statuses] for `reportUnhandledRejections`.
- [ ] **Completion, layer one: ask the live object.** Establish
      `Engine.introspectMembers` → `introspectReceiverMembers`: `parseReceiverPath` splitting
      on `.` and rejecting anything that is not a chain of identifiers (so `shape.area()`
      returns `null`), `resolveReceiverValue` reading `globalCells` then walking data
      properties, `objectMembers` walking `level.prototype` to the end of the chain,
      `functionMembers` walking `staticBase`, `classifyOwnMember` distinguishing
      `method`/`field`/`property` from the descriptor, and `isVisible` dropping `constructor`
      and anything the class declared non-`public`. Land why this layer must come first: it
      is the *only* layer that can see a key added by `bag.alpha = 1`, which appears in no
      declaration. Pin with `"enumerates keys added dynamically after construction"`,
      `"reflects the live value after reassignment"`,
      `"enumerates instance fields, methods, getters, and inherited members"`,
      `"hides private members and the constructor"`,
      `"enumerates builtin prototype methods for Map instances"` and
      `"returns null for primitives and unresolved receivers"`.
- [ ] **Completion, layer two: ask the text — including text that never ran.** Establish
      `liveSource() = joinSource(state.source(), pending)` in `startREPL`: `state.source()`
      is every *evaluated* statement, `pending` is the buffer `runSession` republishes on
      every iteration through `publishPending`. Establish `createAnalyzer.analyze` gluing
      the session source to the fragment being typed and returning a `positionOf` that maps
      a fragment offset into the combined text. Land the payoff: `a = Map()` held in
      `pending` is real to the symbol table and invisible to the engine, which is exactly the
      worked example. Pin with
      `"suggests keys of an object literal declared earlier in the block"` and
      `"suggests methods of a builtin constructed earlier in the block"`.
- [ ] **`recoverMemberCompletionSource`: repairing the dot you are still typing.** Establish
      that `a.` is not a parseable expression, so the analyzer rewrites every dot followed by
      end-of-input, a closer, or `for`/`in`/`if`/`of` into `.__tera_completion__` before
      parsing. **New idea:** *error recovery* — a tool that must answer about incomplete text
      edits the text into something the real parser accepts rather than building a second,
      forgiving parser. Establish `resolveMemberReceiverType` then walking backwards from the
      cursor with `extractReceiverExpression`, `leadingDotReceiverExpression` for a
      method chain broken across lines, and `resolveExpressionType` stepping through
      `symbols.resolveField` with `returnTypeAfterArrow` for calls. Name what this is
      honestly: a string walker, not the checker.
- [ ] **The provider chain and what `rank` throws away.** Establish `buildProviders`
      returning four providers tried in order — meta line, help line, `ctx.isMember`,
      everything — with `providers.find` taking the first match, so a member context can
      never fall through to identifiers. Establish `memberCandidates`' cascade: the `chart`
      special case, then live introspection, then the typed symbol table, then
      `language.pseudoMethods` as a last resort. Establish `rank` dropping `constructor`
      unconditionally, dropping `_`-prefixed labels unless the typed word starts with `_`,
      sorting exact match first, and silently truncating at `MAX_MENU_ITEMS = 40`.
      Pin with `"completes tera builtins"`, `"completes members of an inferred string
      value"`, `"completes a uniquely matching member from its typed prefix"` and
      `"offers no member noise for a resolved empty object"`.
- [ ] **The signature hint scans backwards past strings.** Establish `openCallParen`
      walking left from the cursor with a bracket-depth counter, returning `-1` when it meets
      an unbalanced `[` or `{` first, and — the point of the section — calling
      `isStringLiteralTextOffset(text, i)` to skip any offset inside string text, so a
      `"("` in a literal does not open a call. Establish `stringLiteralTextRanges` as the
      machine underneath: a context stack over `single`/`double`/`template`/
      `templateExpression` that reopens the template's text range after each `${…}`, closed
      with a binary search in `stringLiteralTextPredicate`. Establish `resolveSignature`
      splitting on the last dot and probing `owner.` through the same analyzer, and
      `attachSignatureHint` drawing one line below the input via `saveCursor`/`down(1)`/
      `restoreCursor`, every terminal call wrapped in `try {} catch {}`.
- [ ] **Did-you-mean is a bounded edit distance, and the bound is the point.** Establish
      `extractIdentifier`'s four `IDENTIFIER_PATTERNS` pulling a name out of a diagnostic,
      `knownNames()` in `startREPL` unioning engine globals, keywords and builtins, and
      `boundedDistance`'s two early exits: the length-difference test, and the per-row
      `rowMin > max` bail. **New idea:** edit distance is O(len(a)·len(b)) per candidate, so
      an unbounded scan over every builtin is quadratic work per keystroke of a typo;
      `MAX_SUGGEST_DISTANCE = 2` turns it into a bounded band. Pin with
      `"suggests near matches within the distance bound"` and
      `"reports errors and offers a suggestion for an unknown name"`.
- [ ] **One spec, four surfaces.** Close on `data/tera-language-spec.ts` reaching four
      consumers through `src/frontend/language-data.ts`: `createLanguage` in
      `src/cli/repl/language.ts` (the REPL's highlighter, docs and signatures),
      `tools/editor/src/language-data.ts` (CodeMirror), `vscode-ext/scripts/generate.ts`
      (which *writes* `tera.tmLanguage.json`, `language-data.json` and `snippets/tera.json`
      at build time), and the checker's builtin table. Establish that the VS Code grammar is
      generated, never edited, so a builtin added to the spec is highlighted everywhere by
      construction — the same structural argument [Ch 73 § one-table-three-readers] makes
      about flags. Pin with `"sources builtins from the language spec rather than a static
      javascript list"` and the grammar suite's
      `"scopes keyword-named methods after a dot as members, not keywords"`.

## Honesty items

> **Unfinished.** `startREPL` in `src/cli/repl/index.ts` requires a TTY. `createInput`
> builds a terminal-kit `inputField` and `startREPL` calls `term.grabInput(true)` through
> `createStdinInput`'s `resume`; with stdin piped, keystrokes echo one character at a time
> and the session never evaluates a line. Observed with
> `printf 'a = Map()\n.exit\n' | node dist/cli.js repl`, which echoes
> `aa a =a = a = Ma = Ma...` and then prints part of the bundle. `runSession` itself is
> terminal-free and fully tested; only the entry point is TTY-only. Cost: a non-interactive
> `ReadLine` built on `src/cli/stdin.ts`'s `createLineReader`, selected in `startREPL` when
> `process.stdin.isTTY` is false — roughly one function and one branch.

> **Unenforced.** `assess` re-implements the offside rule over `Lexer` tokens and shares
> exactly one function with the real thing: `leadingSpaces` from
> `src/frontend/lexer/offside.ts`. Nothing checks that `assess(buffer).complete === true`
> implies the buffer parses, or that the indent it computes matches the one the layout
> algorithm would insert. The five `complete: false` sites in `multiline.ts` and the layout
> rules in `offside.ts` are two independent statements of the same grammar. Cost: a
> property test generating buffers and asserting `assess`-complete ⇒ `parse` succeeds; there
> is no such test today. Cross-reference [Ch 5 § the-offside-rule].

> **Unfinished.** `createAnalyzer`'s `inferSafely` (`src/cli/repl/analysis.ts:28-34`)
> catches *every* error from `inferSymbolTypes` and returns `[]`. One type error anywhere in
> the accumulated session source silently downgrades every later completion from typed
> members to bare scope names, with no signal to the user. Cost: keep the last successful
> inference and mark the result stale, rather than discarding it.

> **Unfinished.** The analyzer caches exactly one result, keyed on the whole combined text
> (`cacheKey`, `cached`). Completion and the signature hint call `analyze` with *different*
> fragments — `analyze(source, input)` and `analyze(source, "owner.")` — so on every
> keystroke inside a call they evict each other and both rebuild the symbol table over the
> entire session source. Cost: a small keyed map instead of one slot.

> **Unfinished.** `settlePromise` returns a still-pending promise unchanged, so
> `printer.result` prints the promise object. Only microtasks are drained; a promise waiting
> on a macrotask or on host I/O can never settle inside the REPL's synchronous evaluate.

> **Dead.** `memberCandidates` in `src/cli/repl/completion.ts:35-37` special-cases the
> literal receiver name `chart` before any other lookup, returning
> `language.chartMethods`. It is the only builtin namespace with a hard-coded branch;
> `TERA_GLOBAL_NAMESPACES` exists and `resolveMemberReceiverType` already consults it. Not a
> defect, but the branch is unreachable for any variable *named* `chart` that holds
> something else.

> **Unenforced.** `rank` truncates the candidate list at `MAX_MENU_ITEMS = 40` with no
> indication that it did, and drops `constructor` from every result unconditionally —
> including from an object where the user genuinely wants it.

## Verify it yourself

```bash
npx vitest run --project unit tests/cli/repl.test.ts
npx vitest run --project e2e tests/e2e/cli/repl/introspect.test.ts tests/e2e/cli/repl/session.test.ts
npx tsx -e "import {assess} from './src/cli/repl/multiline.ts'; for (const s of ['mean(a)','if x > 1:','q = [1,','total = 1 +','class A:\n  x = 1']) console.log(JSON.stringify(s), '->', JSON.stringify(assess(s)));"
npx tsx -e "import {recoverMemberCompletionSource} from './src/frontend/editor-analysis.ts'; console.log(JSON.stringify(recoverMemberCompletionSource('a = Map()\na.')));"
npx vitest run --project unit tests/frontend/checker/symbols.test.ts
node dist/cli.js help repl
```

The third command prints, in order,
`{"complete":true,"indent":""}`, `{"complete":false,"indent":"  "}` (pending header),
`{"complete":false,"indent":"  "}` (bracket depth), `{"complete":false,"indent":""}`
(trailing operator) and `{"complete":false,"indent":"  "}` (open block) — the five
`assess` outcomes on five inputs. The fourth prints
`"a = Map()\na.__tera_completion__"`.

## Tests that pin this

- `tests/cli/repl.test.ts` > `"treats a balanced single statement as complete"`
- `tests/cli/repl.test.ts` > `"waits for a block body after a colon header"`
- `tests/cli/repl.test.ts` > `"keeps reading an open block until a blank line"`
- `tests/cli/repl.test.ts` > `"keeps reading while brackets are open"`
- `tests/cli/repl.test.ts` > `"keeps reading after a trailing operator"`
- `tests/cli/repl.test.ts` > `"handles nested control flow blocks"`
- `tests/cli/repl.test.ts` > `"treats a single trailing backslash as a continuation"`
- `tests/cli/repl.test.ts` > `"ignores an escaped (even) trailing backslash"`
- `tests/cli/repl.test.ts` > `"strips only the final backslash"`
- `tests/cli/repl.test.ts` > `"exposes tera builtins, keywords and types from the spec"`
- `tests/cli/repl.test.ts` > `"sources builtins from the language spec rather than a static javascript list"`
- `tests/cli/repl.test.ts` > `"provides signatures and docs"`
- `tests/cli/repl.test.ts` > `"completes tera builtins"`
- `tests/cli/repl.test.ts` > `"completes command names after a dot"`
- `tests/cli/repl.test.ts` > `"completes members of an inferred string value"`
- `tests/cli/repl.test.ts` > `"tokenizes tera source"`
- `tests/cli/repl.test.ts` > `"styles keywords and builtins but not plain identifiers"`
- `tests/cli/repl.test.ts` > `"suggests near matches within the distance bound"`
- `tests/e2e/cli/repl/session.test.ts` > `"evaluates an expression and prints its value"`
- `tests/e2e/cli/repl/session.test.ts` > `"keeps variable state across inputs"`
- `tests/e2e/cli/repl/session.test.ts` > `"accumulates an indented block until a blank line then evaluates it"`
- `tests/e2e/cli/repl/session.test.ts` > `"runs meta commands and lists help"`
- `tests/e2e/cli/repl/session.test.ts` > `"stops the loop on .exit"`
- `tests/e2e/cli/repl/session.test.ts` > `"shows documentation for a builtin via ?name"`
- `tests/e2e/cli/repl/session.test.ts` > `"reports errors and offers a suggestion for an unknown name"`
- `tests/e2e/cli/repl/session.test.ts` > `"displays an uncaught thrown string instead of [object Object]"`
- `tests/e2e/cli/repl/session.test.ts` > `"displays an uncaught thrown Error with its message"`
- `tests/e2e/cli/repl/session.test.ts` > `"lets completion see a name declared earlier in the unevaluated multiline buffer"`
- `tests/e2e/cli/repl/session.test.ts` > `"keeps typing on a new line when a line ends with a backslash"`
- `tests/e2e/cli/repl/session.test.ts` > `"keeps reading after a forced continuation even when the buffer is complete"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"enumerates literal object keys"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"enumerates keys added dynamically after construction"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"reflects the live value after reassignment"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"resolves a chained property path to the live nested value"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"enumerates instance fields, methods, getters, and inherited members"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"hides private members and the constructor"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"classifies method, field, and getter kinds"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"enumerates builtin prototype methods for Map instances"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"returns null for primitives and unresolved receivers"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"returns an empty list for a resolved object with no members"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"suggests dynamically added object keys behind a dot"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"completes a uniquely matching member from its typed prefix"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"offers no member noise for a resolved empty object"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"suggests keys of an object literal declared earlier in the block"`
- `tests/e2e/cli/repl/introspect.test.ts` > `"suggests methods of a builtin constructed earlier in the block"`
- `tests/e2e/cli/repl/module-import.test.ts` > `"imports a name and calls it on the next line"`
- `tests/e2e/cli/repl/module-import.test.ts` > `"runs an imported module body only once"`
- `tests/e2e/cli/repl/module-import.test.ts` > `"picks up an edit to an imported module"`
- `tests/e2e/cli/repl/module-import.test.ts` > `"refuses to reload the entry module"`
- `tests/frontend/checker/symbols.test.ts` > `"stays inside a body on a blank line so completion keeps its locals"`
- `tests/frontend/checker/symbols.test.ts` > `"ends a class scope at its last indented line"`
- `tests/frontend/checker/symbols.test.ts` > `"hides a private member from outside the class"`
- `tests/frontend/checker/symbols.test.ts` > `"offers a private member inside its own class"`
- `vscode-ext/tests/grammar.test.ts` > `"scopes keyword-named methods after a dot as members, not keywords"`
- `vscode-ext/tests/grammar.test.ts` > `"scopes word operators the lexer defines"`
- `recoverMemberCompletionSource` has no unit test of its own; it is covered only through
  the two completion suites above. `[unpinned]`
