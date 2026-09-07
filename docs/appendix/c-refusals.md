# Appendix C — Refusals

> **Status:** stub. Grows as chapters raise refusals.

Every sentence the engine prints when it declines to compile something, with the file that
raises it and a program that triggers it.

This appendix exists because in this engine **the user-facing sentence is the most accurate
available specification of a limit.** There is no design document that says what AOT
supports; there is a legality analysis and the messages it produces.

## Format

Each entry carries: the verbatim message, the file and symbol that raises it, a minimal
program that triggers it, and — where they differ — both the message the user sees first
and the underlying cause.

That last column matters. A recurring pattern here is that the first message names a
downstream symptom rather than the real cause. `stats-refused.tera` is the standing
example: three messages, in this order, for one problem.

```
warning: skipped 'describe' (x64-windows backend cannot emit: function returns a string
  but its return type is not a string)
warning: skipped 'tera_program' (calls unavailable function describe)
x64-windows backend cannot emit: entry function tera_program could not be lowered to
  native code: it calls describe, skipped because ...
```

The reader who only sees the third message learns that the entry failed. Only the first
says why.

## The same refusal is worded differently per target

Verified while building this scaffold, and a trap for anyone quoting a message: the wording
depends on which backend declined. `stats-refused.tera`, same source, same machine:

```
$ node dist/cli.js compile docs/example/stats-refused.tera -o out.exe
tera compile: warning: skipped 'describe' (x64-windows backend cannot emit: ...)

$ node dist/cli.js compile docs/example/stats-refused.tera --emit source --target c -o out.c
tera compile: note: 'describe' is not in the binary, and nothing the program runs calls it (C backend cannot emit: ...)
```

`warning:` versus `note:`, and a different sentence — and the C target still produces
output while x64 stops. Every entry in this appendix must therefore name the target it was
captured on.

## Two kinds of refusal

Refusals are not all the same, and the distinction is the subject of [Ch 81].

- **A hard refusal** stops the compile. `queue.tera` gets one: the checker will not accept
  `int + (int | undefined)`, so no binary is produced.
- **A decline** is data, not an exception. `compileAotModule` returns an `AotProgram` whose
  `skipped` array names each function it could not emit and why. A binary is still produced
  if nothing reachable needed them. This is why the book's own test asserts on
  `program.skipped`, not on a thrown error.

## Sites that raise them

- `src/optimizing/analyses/aot-legality.ts` — the legality analysis proper
- `src/optimizing/drivers/aot.ts` — the driver that collects skips and decides the outcome
- `src/optimizing/machine/backend.ts`, `src/optimizing/backends/c/backend.ts` — per-target
- `src/optimizing/backends/wasm/codegen.ts` — the JIT's own declines
- `src/optimizing/target/runtime-layout.ts` — the refused import surface, including
  `TERA_THREAD_ENTRY_POINTS`

## Reproducing

```bash
node dist/cli.js compile docs/example/queue.tera -o /tmp/queue.exe
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe
npx vitest run --project unit tests/optimizing/analyses/aot-legality.test.ts
```
