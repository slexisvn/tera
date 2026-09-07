# Appendix B — IR operations

> **Status:** stub. To be filled when Part VII is written.

The optimizing IR has **98 operations** (`IR_*`). The body of the book explains roughly
thirty-five of them — the ones the running example produces. This appendix is the complete
reference.

## Source of truth

`src/optimizing/ir/operations.ts` holds `OPERATIONS`, the single table that gives every
opcode its arity, effects, result class and type transfer function. Every pass reads this
table rather than switching on opcode names, so it is the closest thing the middle end has
to a specification.

## Columns this table must carry

| Column | Source |
| --- | --- |
| Operation | `IR_*` name |
| Arity | `OPERATIONS` entry |
| Effects | reads/writes memory, can deoptimize, can throw |
| Result class | value, control, effect |
| Type transfer | the lattice function used by `analyses/type-inference.ts` |
| Targets | which backends can emit it, and which legalize it away |

## The two things to get right

1. **Effects drive correctness, not performance.** A wrong effect annotation lets load
   elimination delete a load it must keep. Chapter 45 depends on this table being right.
2. **Not every target can emit every operation.** `IR_SELECT` is the standing example:
   x64 has `cmov`, riscv64 does not, so the operation legalizer rewrites it into a
   branch diamond rather than refusing the program. Chapter 51 tells that story; this
   appendix records which operations are in that position.

## Regenerating it by hand

```bash
node dist/cli.js --print-ir docs/example/stats.tera
node dist/cli.js --print-after-all docs/example/stats.tera
grep -oE '\bIR_[A-Z0-9_]+' src/optimizing/ir/operations.ts | sort -u
```
