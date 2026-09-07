# Appendix E — File map

> **Status:** stub. Filled in as parts are written.

Every source file mapped to the chapter that covers it, so a maintainer can go from a file
they are about to change to the prose that explains it — and so the book's coverage gaps
stay visible instead of quietly closing.

## Scale

| | |
| --- | --- |
| TypeScript files under `src/` | 468 |
| Lines | 120,822 |
| Comment lines | 26 |
| Test files | 408 |

## Shape of the table

| Path | Chapter | Depth |
| --- | --- | --- |
| `src/frontend/lexer/offside.ts` | [Ch 5] | derived in full |
| `src/optimizing/passes/gvn.ts` | [Ch 44] | derived in full |
| `src/runtime/domain/chart/` | [Ch 28] | named only |
| `src/csv-core.ts` | — | **uncovered** |

"Depth" is the honest column. Three values:

- **derived in full** — the chapter explains how it works.
- **named only** — the chapter says what it does and where the boundary is, without
  deriving it.
- **uncovered** — no chapter mentions it.

## Known uncovered

`src/csv-core.ts`, `src/types/` and `src/utils/` are incidental to every chapter's
argument. They are listed as uncovered rather than given a home they do not need. If that
list grows, that is information about the book, not about the code.

## Rebuilding the raw list

```bash
find src -name '*.ts' | sort
find src -name '*.ts' -exec wc -l {} + | sort -rn | head -30
```
