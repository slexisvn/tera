# Appendix A — The opcode table

> **Status:** stub. To be filled when Part III is written.

The register bytecode has **90 opcodes** (`ROP_*`). The body of the book explains roughly
the thirty that the running example and its variations actually produce; this appendix is
the complete reference.

## Source of truth

- `src/bytecode/register/ops/bytecode.ts` — the `ROP_*` constants and their operand shapes.
- `src/bytecode/register/ops/register-effects.ts` — which registers each opcode reads and
  writes. This is the table the SSA builder trusts, so an error here is a miscompile, not a
  cosmetic bug.
- `src/bytecode/register/interpreter/handlers.ts` — the tier-0 implementation of each.
- `src/optimizing/baseline/compiler.ts` — the tier-1 JavaScript emitted for each.
- `src/optimizing/builder/ir-builder.ts` — the SSA nodes each becomes for tiers 2 and 3.

## Columns this table must carry

| Column | Why it matters |
| --- | --- |
| Opcode | `ROP_*` name |
| Operands | count and kinds |
| Reads / writes | from `register-effects.ts`; the accumulator is implicit |
| Tier 0 | handler function |
| Tier 1 | whether baseline emits it inline or calls a runtime stub |
| Tiers 2–3 | the IR node it builds, or **pins to tier 0** |

## The one thing to get right

Eleven opcodes **pin a function to tier zero** — if a function contains one, it is never
compiled past the interpreter. Chapter 27 explains why each is there. This appendix must
mark them, because "why is my function never optimized?" is the question it exists to
answer.

## Regenerating it by hand

```bash
node dist/cli.js --print-bytecode docs/example/stats.tera
grep -oE '\bROP_[A-Z0-9_]+' src/bytecode/register/ops/bytecode.ts | sort -u
```

There is no generator. When the opcode set changes, this table is updated by hand and the
count above is re-checked — see [Conventions](../CONVENTIONS.md) on why this book has no
build step.
