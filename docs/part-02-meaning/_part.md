<title>Part II — The tree acquires meaning</title>
# Part II — The tree acquires meaning

> **Status:** written

**Chapters 8–16.** Between the parser (Part I) and the bytecode compiler (Part III) sits
the only stage in this engine that ever answers a question about a program instead of
translating it.

## What this stage owes everything downstream

Part I hands over an `ASTNode` tree: sixty-one `NodeType` names, positions in `__line` /
`__column`, and type annotations carried as raw source text on `_paramInfo` and
`_returnType`. Nothing in that tree knows where a name lives or what a value is.

Five artifacts leave this stage, and every later part reads at least one of them:

| Artifact | Produced by | Read by |
| --- | --- | --- |
| `SemanticProgram` — 13 node kinds | `astToSemanticProgram` (`semantic-lowering.ts`) | the checker only; the bytecode compiler still walks the raw AST |
| `BoundProgram` — scopes, signatures, `reserved`, `provenTakes` | `bindProgram` (`binder.ts`) | the checker; `provenTakes` reaches `inferCall` |
| Canonical type text — `TypeName = string` | `cleanType` (`type-system.ts`) | `declaredSignatureOf` (ch 20), `latticeFromDeclaredType` (ch 48), `buildClassTable` (ch 57), the symbol table (ch 74) |
| `_paramInfo` / `_returnType` written back onto the AST | `adoptContextualSignature` (`ast/index.ts`) | `declaredSignatureOf` → `RegisterCompiledFunction.declaredSignature` → JIT and AOT only |
| `ClassSurface[]` | `classSurfacesOf` (`modules/interface.ts`) | `buildClassTable`, and only when `aot` is true |
| `Diagnostic[]` | `TypeChecker.check` (`type-checker.ts`) | `engine.ts`, which decides whether they are advice or a refusal (ch 16) |

The hinge is the last row. `TypeChecker.strict` has exactly one use — it picks
`"error"` or `"warning"` in `diagnostic()` — and `engine.ts` forces it on for every
ahead-of-time compile and then throws on a non-empty array. The checker is optional
for three tiers and load-bearing for the fourth.

## Which of the four tiers each chapter constrains

Badges read `⟨I · B · J · N⟩` for interpreter, baseline, JIT, native; `—` marks a tier
the chapter does not bind.

| Ch | Title | Badge | Why |
| --- | --- | --- | --- |
| 8 | Thirteen node kinds and one boundary flag | `⟨I · B · J · N⟩` | the scope-boundary rule is mirrored in the bytecode every tier runs |
| 9 | Types are text | `⟨— · — · J · N⟩` | type strings reach only `declaredSignature`, which only the optimizing tier reads |
| 10 | The lattice | `⟨— · — · J · N⟩` | assignability shapes the class table and gates the AOT refusal |
| 11 | Inference without Hindley-Milner | `⟨— · — · J · N⟩` | the write-back feeds `declaredSignatureOf` |
| 12 | Classes without nominality | `⟨— · — · J · N⟩` | `ClassSurface` becomes an AOT header and field offsets |
| 13 | `q.shift()` under a guard | `⟨— · — · J · N⟩` | `provenCount` is shared with `passes/array-methods.ts` |
| 14 | Async, and the await you never wrote | `⟨I · B · J · N⟩` | `implicitAwait` becomes a real `Await` opcode |
| 15 | Modules: two graphs, not one | `⟨I · B · J · N⟩` | `initOrder` runs module top levels in every tier |
| 16 | Warnings as errors | `⟨— · — · — · N⟩` | the gate fires only for `tera compile` |

## The through-line

The part is arranged so that each chapter's failure mode is the next chapter's subject:

- Ch 8 decides **where a name lives**, and gets it wrong for one shape of program.
- Ch 9 decides **what a type is** — a normalized string — and pays for it in ch 11.
- Ch 10 decides **when one type stands for another**, without anyone declaring variance.
- Ch 11 decides **what an unannotated expression is**, deliberately without unification.
- Ch 12 decides **what a class is**: a shape, not a name.
- Ch 13 decides **what a guard proves** about the operation inside it.
- Ch 14 decides **which calls suspend**, from the call graph rather than the keyword.
- Ch 15 decides **what order modules run and check in** — two different orders.
- Ch 16 decides **who has to care**, and that is the whole ahead-of-time contract.

## What leaves Part II

A `BoundProgram` whose scopes are settled, an AST carrying inferred parameter and
return types, a list of class surfaces, canonical type text for every annotation the
program wrote, and a diagnostics array whose emptiness one caller treats as a licence
to emit a native binary. Part III (ch 17) picks up the raw AST — *not* the semantic
one — and turns it into register bytecode.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats.tera
node dist/cli.js check docs/example/queue.tera
node dist/cli.js --typecheck strict docs/example/queue.tera
npx vitest run --project unit tests/frontend/checker/ tests/frontend/modules/ tests/frontend/effects.test.ts
npx vitest run --project e2e tests/e2e/frontend/checker.test.ts
```
