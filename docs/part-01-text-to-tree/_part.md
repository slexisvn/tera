# Part I — Text becomes a tree   ⟨I · B · J · N⟩

> **Status:** outline

**Length.** 2 pages

## What this stage owes everything downstream

- **One front end, four machines.** There is no second parser. The register bytecode
  interpreter, the JavaScript-emitting baseline, the wasm-emitting JIT and the
  ELF/PE-emitting native compiler all receive the tree this part produces, unchanged.
  Every chapter here therefore carries the full badge ⟨I · B · J · N⟩ — a mistake made in
  four lines of `src/frontend/lexer/offside.ts` is a mistake in all four engines at once.
- **The only artifact is an `ASTNode`.** `src/frontend/parser/language.ts` exports one
  function, `parse(source, options)`. Everything after this part is a function of its
  return value plus the module graph. Nothing downstream re-reads the source text except
  to print a diagnostic, and the diagnostic machinery reads it through the spans this part
  attaches (`[Ch 07 § spans-that-do-not-enumerate]`).
- **Refusals start here.** Three of the book's running programs are refused, and two of
  the three refusals are decided by code in this part: `let x = 1` is rejected by
  `rejectReservedKeyword` in the parser, and a mis-aligned dedent is rejected by
  `tokenize` in the lexer. The third — `queue.tera`, the cold open of `[Ch 01]` — parses
  cleanly here and is refused two parts later, which is exactly the point of separating
  the stages.
- **What this part does *not* decide.** Types are collected as *text*, never parsed.
  `x: Map<string, int[]> = m` reaches the checker as the nine-character-plus string
  `"Map<string, int[]>"`, produced by `typeSourceFromTokens`. The whole type language is
  Part II's problem. This is the single largest design decision in the front end and it
  is the subject of `[Ch 07 § types-are-never-parsed]`.

## The chapters

| # | Title | Pages | Hands on |
| --- | --- | --- | --- |
| 04 | Characters to tokens | 14 | a flat `Token[]` with no layout in it |
| 05 | The Program That Indents But Does Not Nest | 12 | the same array with `Indent` / `Dedent` / `Newline` woven in |
| 06 | `if (x) (y)(z)` Parses Wrong, and a Bigger Parser Will Not Save You | 18 | an `ASTNode` tree, spans attached |
| 07 | The shape of the tree | 12 | the same tree, plus the type-source strings the checker will read |

- 04 and 05 are two halves of one pass and are split because they fail differently: 04's
  failures are local to a character, 05's are local to a line.
- 06 and 07 are two halves of one pass and are split because 06 is about *control* — who
  decides where an expression ends — and 07 is about *shape* — what the decision is
  recorded as.

## Which of the four tiers this part constrains

- **All four, identically.** The badge on every chapter in this part is ⟨I · B · J · N⟩.
- The one asymmetry worth flagging now: the native compiler runs the checker in strict
  mode unconditionally, so a program the interpreter accepts can still be refused later
  on the strength of a *type annotation this part only copied as text*. Part I never
  refuses a program for a type reason.

## Reading order

- A reader who wants the engine and not the language can read 04 § derived-punctuator-table,
  05 § why-the-obvious-design-fails and 06 § two-set-pieces, then jump to Part II.
- A reader following the running program end to end reads all four in order; `stats.tera`
  appears in every one of them.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats.tera
node dist/cli.js --print-ast docs/example/stats.tera | head -20
node dist/cli.js docs/example/queue.tera
node dist/cli.js compile docs/example/queue.tera -o /tmp/queue.exe
npx vitest run --project unit tests/frontend/lexer.test.ts tests/frontend/operators.test.ts
```
