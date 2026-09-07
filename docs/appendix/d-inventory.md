# Appendix D — Inventory: dead, broken, unfinished, measured worse, never runs

> **Status:** stub. This appendix is assembled by hand from the honesty callouts every
> chapter raises. It must never contain an item no chapter raised, and no chapter may raise
> an item that is missing here.

This is the book's best credential. A book that only describes what works is describing
something other than the software.

## The five markers

| Marker | Means |
| --- | --- |
| `> **Dead.**` | Present in the tree, unreachable |
| `> **Never runs.**` | Reachable, but nothing calls it |
| `> **Broken.**` | Present, and produces a wrong answer |
| `> **Measured worse.**` | Complete, correct, tested, and switched off because the numbers said so |
| `> **Unfinished.**` | Present, incomplete |

A sixth, `> **Unenforced.**`, marks an invariant the book states that nothing in the code
checks. Those belong here too — an unenforced invariant is a bug that has not happened yet.

Each entry must name a file and a symbol, and say what finishing it would cost.

## Confirmed while building this scaffold

These were verified directly and are already anchored to chapters.

> **Unfinished.** riscv64 cannot encode instructions. Its machine-code target throws
> `UnsupportedInstructionError` for every opcode —
> `src/optimizing/backends/riscv64/mc/target.ts:24` — so riscv64 reaches a binary only
> through the C backend. Cost to finish: a full RV64 encoder. Raised by [Ch 72].

> **Unfinished.** There is no Mach-O container. `CONTAINERS.macho` is `null` in
> `src/optimizing/backends/x64/backend.ts:57`, so macOS is not a target even though x64 is.
> Cost to finish: a Mach-O object and executable writer beside the existing ELF and PE
> ones. Raised by [Ch 70], [Ch 72].

> **Unfinished.** The same source, the same architecture, two different answers about
> timers. `x64Target` only claims the `timers` capability when its `PlatformIo` supplies
> both `now` and `wait` — `src/optimizing/backends/x64/target.ts:81-83`. `sysvIo`
> (`src/optimizing/backends/x64/runtime.ts:490`) supplies `write` and `exit` and neither of
> those two, so **`x64-linux` has no timers while `x64-windows` does**: `await sleep(1)`
> compiles on Windows and is refused on Linux from identical source. Cost to finish: two
> syscalls (`clock_gettime`, `nanosleep`) in `sysvIo`. Raised by [Ch 72].

> **Never runs.** `isMachineTarget` (`src/optimizing/target/model.ts:57`) is exported and
> unit-tested, and called from nowhere in `src/`. Cost to remove: delete it and its test, or
> find the caller it was written for. Raised by [Ch 72].

> **Unenforced.** The `generational-heap` capability is declared by two `capabilitySet(...)`
> calls and read by no pass, analysis or emitter. Its correspondence to
> `tera_write_barrier` is held only by one e2e test, so a backend could claim the capability
> without emitting a barrier and nothing in the compiler would object. Raised by [Ch 62],
> [Ch 72].

## Carried from the subsystem survey, to confirm when each chapter is written

Each of these was reported by a reader of that subsystem and must be re-verified by the
chapter that raises it before it appears in prose.

- **Never fires.** Bounds-check elimination cannot fire on any tera source — the builder's
  `CheckSmi` wrapper defeats all three of its bounded paths.
  `src/optimizing/passes/checks.ts`. [Ch 46]
- **Misleading name.** `loopUnrolling` never unrolls; it peels guards.
  `src/optimizing/passes/loop-opts.ts`. [Ch 46]
- **Measured worse.** Live-range splitting is implemented, tested and off by default: two
  of the three Wimmer split rules measured as regressions.
  `src/optimizing/machine/linear-scan.ts`, `src/optimizing/options.ts`. [Ch 67]
- **Measured worse.** An address-range nursery was built and reverted; the young-list
  design shipped instead. [Ch 62]
- **Misleading name.** `EphemeronHashTable` implements no ephemeron algorithm — the
  weakness is by omission. `src/objects/heap/js-collections.ts`. [Ch 31]
- **Never runs.** Tri-colour incremental marking exists but is never stepped.
  `src/gc/incremental-marker.ts`. [Ch 31]

## Closed

Items that have left the two lists above. They are recorded, not deleted: the five markers
describe the tree as it is, and this section is how an entry stops being one of them without
the history going with it.

**Labeled `continue` never terminated.** Fixed. `continue outer` re-entered the inner loop
instead of the outer one, so `docs/example/labeled.tera` printed `1 2` forever; `break outer`
was correct throughout. The mechanism was ownership, not a missing line:
`compileLabeledStatement` in `src/bytecode/register/compiler/statements.ts` held the label's
continue jumps but had no target to patch them to, because the loop compiler swaps
`_continueJumps` in and out around the body and restores it before returning. The fix hands
the label to the loop instead. A labelled statement now only declares the label pending —
`_pendingLoopLabels` (`src/bytecode/register/compiler/helpers.ts:128`) — and the next
`enterLoop` (`:131`) claims it, aliasing `_labeledContinues[label]` to the loop's own
`continueJumps` (`:140-143`) so that `exitLoop` (`:147`) patches labelled and unlabelled
continues together at the latch (`:153-154`). A label that no loop claims is now rejected
outright. Pinned by `tests/bytecode/register/compiler.test.ts` >
`"backpatches labeled continue in a while loop to the outer loop latch"`,
`"backpatches labeled continue in a for loop to the outer loop latch"`,
`"sends labeled continue past the inner loop rather than to the inner latch"`,
`"rejects a labeled continue whose label does not name a loop"`, and by
`tests/e2e/docs/book-examples.test.ts` >
`"labeled.tera resumes the outer loop instead of restarting the program"`, which runs the
file and expects `1 2 3 5 6 7`. The general rule it produced: **a jump can only be patched by
the construct that owns its target.** Raised by [Ch 19], closed there and in [Ch 82].

## Rule

An item leaves the lists above only when it is fixed **and** the chapter that raised it is
updated; it then moves to § Closed with its fix and the tests that pin it. Deleting an entry
because it is embarrassing is the one edit this book does not allow.
