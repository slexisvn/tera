# Appendix F — Reading this repo

> **Status:** stub.

For someone who has finished the book, or who needs to change something before finishing it.

## The tree, by size

| Directory | Files | Lines | Book part |
| --- | --- | --- | --- |
| `src/optimizing/` | 282 | 73,008 | VI–XI |
| `src/frontend/` | 34 | 12,012 | I–II |
| `src/bytecode/` | 16 | 9,489 | III–IV |
| `src/runtime/` | 58 | 8,260 | IV |
| `src/objects/` | 11 | 3,733 | IV |
| `src/cli/` | 30 | 3,518 | XII |
| `src/feedback/` | 4 | 2,948 | V |
| `src/api/` | 2 | 2,242 | IV |
| `src/core/` | 8 | 1,759 | IV |
| `src/deopt/` | 7 | 1,597 | V–VI |
| `src/gc/` | 8 | 1,353 | IV |
| `src/debugger/` | 2 | 616 | XII |

## Where a change belongs

Because the book is ordered by pipeline stage, "which chapter covers this?" and "what will
my change break downstream?" have the same answer. Each chapter's **What arrived** and
**What leaves** sections are the handover map: a change to one stage can only break things
downstream of it.

## The four test tiers

```bash
npm test
npm run test:e2e
npm run test:native
npm run test:full
```

Pick the cheapest tier that can prove the change. `tests/e2e/` is for anything that runs a
tera program end to end; everything else is a unit test beside the code it covers.

## Instruments

```bash
node dist/cli.js --print-ast <file>
node dist/cli.js --print-bytecode <file>
node dist/cli.js --print-ir <file>
node dist/cli.js --print-after-all <file>
node dist/cli.js --trace <file>
node dist/cli.js --no-opt <file>
node dist/cli.js --always-opt <file>
node dist/cli.js compile <file> --verify
node dist/cli.js repl
node dist/cli.js debug <file>
node dist/cli.js targets
```

Chapters 73–79 are about these. If something is wrong and you do not know where, chapter 77
(bisecting your own compiler) is the one to read first.

## House rules that will surprise you

- **No comments.** 26 lines in 120,822. The tests carry the intent instead; a test title is
  a design statement.
- **The AOT compiler always typechecks in strict mode.** A checker bug is a miscompile, not
  a false warning.
- **A refusal is a legitimate outcome.** The native compiler declining a function is a
  designed behaviour with a message, not a failure to be worked around.
