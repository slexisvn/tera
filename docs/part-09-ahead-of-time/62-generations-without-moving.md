# 62. Generations Without Moving   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** An address-range nursery is the textbook shape, it was built, and it measured
worse — because a collector that cannot move an object cannot compact survivors out of a
nursery, so the nursery grows until it is the whole arena.

**What arrived.** A working non-moving mark-sweep collector: a reserve-then-commit arena, a
coalescing first-fit free list keyed on shape id 0, a shadow stack whose slots are mirrors
rather than handles, and a sweep that stamps `TERA_OLD_FLAG` on every block it keeps. Two
independent implementations of it — C text and x64 machine IR — both reading offsets out of
`src/optimizing/target/runtime-layout.ts`. And two unused flag bits, free because every
block is 8-aligned.

**What leaves.** The same collector with a second, cheaper entry point. `tera_minor` marks
only young objects, from the shadow stack plus a remembered set; `tera_alloc` calls it when
the young list fills and only falls back to `tera_collect` when that is not enough; every
reference store into a non-runtime object goes through `tera_write_barrier`. On C and x64
only — riscv64 declares no `generational-heap` capability and gets neither the barrier nor
the minor collector. Chapter 63 receives a heap that can be collected without stopping the
world for a full arena walk, which matters because its coroutine frames and promise chains
are long-lived old objects with young payloads hanging off them.

**New ideas.** The generational hypothesis (most objects die young) and the fact that it is
a *hypothesis*, measured per program, not a law; a nursery; promotion; a remembered set and
why an old→young reference is the only edge a minor collection can miss; a write barrier and
its cost model (it is on the mutator's hot path, so it must be four instructions, not forty);
card marking versus object granularity; the difference between a *measured* regression and a
*reasoned* one.

**Length.** 14 pages

## Anchors

- `src/optimizing/target/runtime-layout.ts:253-258` — the three flag bits, and the fact that
  the two new ones cost zero bytes: `TERA_MARK_FLAG = 1`, `TERA_OLD_FLAG = 2`,
  `TERA_REMEMBERED_FLAG = 4`, `TERA_BLOCK_FLAGS = 7`. Then `TERA_YOUNG` (capacity `1<<13`),
  `TERA_REMEMBERED` (capacity `1<<11`), and the six `tera_context` fields the generational
  half adds: `nurseryLimit`, `youngBase`, `youngCount`, `rememberedBase`, `rememberedCount`
  (lines 128-132), reading `TERA_MINOR_SYMBOL` and `TERA_BARRIER_SYMBOL` at 241-242.
- `src/optimizing/metadata/class-table.ts:50-53, 80-82` — `CLASS_ALIGNMENT_BYTES = 8`, which
  is *why* bits 1 and 2 are free, and `CLEAR_MARK` / `CLEAR_BLOCK_FLAGS` /
  `CLEAR_REMEMBERED`, each written as `-1 - FLAG` so the assembler picks the same `imm8`
  form the encoder does.
- `src/optimizing/backends/c/emit.ts` — the C half. `tera_block_size` (1372) masking
  `TERA_BLOCK_FLAGS` out of the size word; `tera_nursery_reset` (1376) computing
  `min(arenaCursor + (YOUNG_CAPACITY - youngCount) * CLASS_HEADER_BYTES, arenaCommitted)`;
  `tera_is_young` (1383) — one bit test, `(flags & TERA_OLD_FLAG) == 0`;
  `tera_note_young` (1387); `tera_remember` (1391) and `tera_write_barrier` (1397), nine
  lines together; `tera_mark_young` (1458) and `tera_mark_young_pending`;
  `tera_sweep_young` (1507) with its run-coalescing; `tera_minor` (1578);
  `tera_alloc` guarding on the young **count** and calling `tera_minor` before
  `tera_collect`; `CEmitter.emitBarrier` (2295) with its two early returns; the
  `tera_array_reserve` barrier at 1704.
- `src/optimizing/backends/x64/heap.ts` — the machine-IR half. `markYoung` (204) — a real
  work-stack DFS over `marksBase`, unlike the major collector's `markPass` (272), which is a
  rescan; `markYoungPass` (301) walking the remembered set first, then the young list;
  `nurseryReset` (505); `sweepYoung` (549); `minor` (597); `writeBarrier` (661).
- `src/optimizing/backends/x64/lowering.ts` — where the barrier is *decided*.
  `rememberStore` (1309-1319): two lines of policy, `scalar !== SCALAR_POINTER` returns and
  `ctx.node.inputs[0]!.type === IR_RUNTIME_BASE` returns. `selectNewObject` (1196) —
  the inline allocation fast path: `leaq size(cursor), next`,
  `cmpq nurseryLimit, next`, `ja` to the slow path, then bump, stamp the header, and append
  to `youngBase[youngCount]` inline. `nurseryLimit` is read *only* here.
- `src/optimizing/backends/riscv64/target.ts:42` —
  `capabilitySet("terminating-throw", "float-text")`. No `generational-heap`, and therefore
  no barrier anywhere in the riscv64 output. This is the chapter's honesty anchor.
- `src/optimizing/target/capabilities.ts` — the `Capability` union;
  `src/optimizing/backends/c/target.ts:12` and `src/optimizing/backends/x64/target.ts:79`
  declaring `"generational-heap"`.
- `tests/e2e/optimizing/aot/arena-collector.test.ts:280-360` — the `generational collector`
  describe block, `REPLACES` (an old object whose field is replaced with a young one, then
  churned past a whole nursery), and `SURVIVES_A_NURSERY = TERA_YOUNG_CAPACITY * 2`, derived
  from the layout constant so the test still crosses a nursery boundary if the capacity
  changes.

## Worked example

The chapter's *measurement* cannot be reproduced from this tree — the address-range nursery
was deleted when it lost, so the middle column below is a recorded number, not a runnable
one. Say that in the opening sentence rather than in a footnote.

What *is* runnable is the code the measurement produced. `docs/example/stats.tera` reaches
the whole generational path through chapter 60's prelude, because `_FixedDigits` allocates
and `_FixedText` stores a reference:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --target c   -o /tmp/stats-c
node dist/cli.js compile docs/example/stats.tera --emit source --target x64 -o /tmp/stats-x64
node dist/cli.js compile docs/example/stats.tera --emit source --target riscv64 -o /tmp/stats-rv
grep -c tera_write_barrier /tmp/stats-c/stats.c /tmp/stats-x64/stats.s /tmp/stats-rv/stats.s
```

which answers 12, 19, and 0 — the capability table made visible in three files. And the
inline fast path, from `/tmp/stats-x64/stats.s:2390-2402`:

```
	leaq 24(%rax), %rcx
	cmpq tera_context+64(%rip), %rcx
	ja .L_fixed_text_0_alloc_0
	movq %rcx, tera_context+8(%rip)
```
— `tera_context+64` is `nurseryLimit`, `+8` is `arenaCursor`

Three instructions decide "is there nursery room", and the `ja` is a fork inside a block
whose terminator is somewhere else — the shape [Ch 64 § guard-fork] describes.

The allocation-heavy programs are `CHURN` / `RETAIN` / `GROWN` / `REPLACES` in
`tests/e2e/optimizing/aot/arena-collector.test.ts`, per [Conventions § 2](../CONVENTIONS.md).

## Outline

- [ ] **§ the-hypothesis** — `> **New idea.**` Establish the generational hypothesis and the
      shape of the win: if most objects die young, a collection that only looks at young
      objects costs O(live young) rather than O(heap). Then immediately establish what makes
      it *sound*: a minor collection that ignores old objects will miss an old object
      pointing at a young one, so something must record those edges. Name the two jobs — a
      young set and a remembered set — before naming any implementation.
- [ ] **§ two-free-bits** — Establish that the generation state costs nothing per object.
      `CLASS_ALIGNMENT_BYTES = 8`, so every block's size has its low three bits clear, so
      the flags word can carry `TERA_MARK_FLAG`, `TERA_OLD_FLAG` and `TERA_REMEMBERED_FLAG`
      inside the size itself; `tera_block_size` masks them off. Fixed-width ASCII table of
      the flags word. Note `tera_is_young` is then a single bit test, which matters because
      the barrier runs on the mutator's hot path.
- [ ] **§ address-range-nursery** — *Why the obvious design fails*, and the chapter's
      centre. Stage the textbook design honestly first: reserve the top of the arena as a
      nursery, allocate into it by bumping, and on a minor collection evacuate the survivors
      down into the old region and reset the bump cursor. Then the sentence that kills it:
      **this collector cannot move an object** [Ch 61 § nothing-moves], so a survivor is
      *pinned* where it was allocated. Follow the consequence step by step — a pinned
      survivor sits inside the nursery range, so the range's lower bound cannot rise past
      it, so the bump cursor climbs, so the nursery grows toward the arena top, so every
      allocation eventually triggers a minor collection that reclaims almost nothing.
      Measured: **400 ms → 630 ms** on the C backend, an allocation-heavy program with a
      live old set, taken one case per fresh process. State the general rule the failure
      produced: *do not retry this shape*; a non-moving collector cannot keep a nursery
      contiguous, so its young set has to be a list of objects, not a range of addresses.
- [ ] **§ explicit-young-list** — The replacement. `tera_young` is a fixed
      `TERA_YOUNG_CAPACITY` array of pointers; `tera_note_young` appends on every
      allocation; `tera_sweep_young` walks that list rather than the arena, releases the
      unmarked ones (coalescing adjacent dead runs the same way `tera_sweep` does), and
      **promotes** the marked ones by clearing `TERA_BLOCK_FLAGS` and setting
      `TERA_OLD_FLAG`. Promotion here is a bit flip, not a copy — which is exactly what
      makes it work without moving. Establish where the young list is emptied
      (`youngCount = 0` at the end of both `tera_minor` and `tera_collect`) and what
      `nurseryReset` recomputes afterwards.
- [ ] **§ the-remembered-set** — Establish object granularity: `tera_remembered` holds
      *objects*, not cards and not slots, so a minor collection scans every reference field
      of a remembered object rather than one address. Then the deduplication that makes that
      affordable — `TERA_REMEMBERED_FLAG` on the object itself, so a field written in a
      loop is remembered once. Then the overflow policy, which is the honest bit:
      `tera_remember` silently *drops* the entry when `rememberedCount` hits capacity, and
      `tera_minor` opens by checking `rememberedCount == TERA_REMEMBERED_CAPACITY` and
      escalating to a full `tera_collect`. Read those two together and establish why the
      combination is sound and why either alone would not be.
- [ ] **§ the-barrier** — Read `tera_write_barrier`, all five lines, and establish the cost
      model: it is on the mutator's path, so every condition is a bit test and the common
      case (`value` is old, or null) returns after one compare. The rule it implements —
      remember **only** when the stored value is young and the target is old — with both
      halves justified: a young target will be scanned anyway because it is in the young
      list; an old value cannot be missed because it is not what a minor collection is
      looking for. Then the two places it is *called*: `emitBarrier` in the C emitter and
      `rememberStore` in the x64 lowering, both eight lines, both with the same two early
      returns. Note that `tera_array_reserve` calls it by hand when it swaps in a grown
      buffer — a runtime routine writing a reference field is still a reference store.
- [ ] **§ the-barrier-bug** — The chapter's war story, told as engineering. **Symptom:**
      nothing, for weeks. **Mechanism:** `IR_STORE_FIELD` also carries stores into
      `tera_context` and into `tera_statics`, both of which reach memory through
      `IR_RUNTIME_BASE`. The first barrier fired on those, so the *target* was an address in
      the program image — a static array in BSS — and it went into the remembered set. The
      next minor collection read that address as a block header, took `shape_id` from
      whatever bytes were there, indexed `tera_classes` with it, and walked "reference
      fields" that were not references. **Why it hid:** a static array is surrounded by
      mapped memory, so a wild pointer near it does not fault; it silently marks or misses
      the wrong blocks. **Fix:** two lines, one per backend — skip the barrier when
      `inputs[0].type === IR_RUNTIME_BASE` — sound because both regions are scanned as roots
      on *every* collection anyway (`tera_static_roots`, and the five `tera_context` list
      heads [Ch 61 § the-five-list-heads]). **Regression tests:** two, one per region, both
      reading the emitted C for the *absence* of a call. **General rule:** a write barrier's
      guard is a statement about which *memory region* is being written, not about the IR
      opcode; an opcode that reaches two regions needs the region in its condition.
- [ ] **§ nursery-limit-is-one-backend** — Establish the split honestly. `nurseryLimit` is
      computed by both backends (`tera_nursery_reset` / `nurseryReset`) and read by exactly
      one: the x64 inline allocation fast path, which compares the prospective cursor
      against it and jumps to the slow path when it exceeds. The C backend's `tera_alloc`
      never reads it — it guards on the young **count**
      (`youngCount == TERA_YOUNG_CAPACITY`) instead. Then the reason, which is a real bug
      that was fixed: bounding `tera_alloc` by *bytes* broke a single allocation larger than
      the whole nursery, because the limit is derived from free young *slots* times the
      header size and has nothing to do with how big one object may be. State the invariant:
      **`nurseryLimit` is a heuristic for the inline path only; the count is the truth.**
- [ ] **§ mark-shape-matters** — *What was tried and rejected*, second item. The x64 major
      collector's `markPass` is a rescan driven to a fixpoint, not a work stack, because
      that is far less assembly and needs no overflow handling [Ch 61 § marking]. Porting
      that same shape to the *minor* collector made it **1.3× slower**, because each rescan
      pass walks the entire young list. `markYoung` is therefore a real worklist over
      `tera_marks`, and `markYoungPass` survives only as the stack-overflow path. General
      rule: the right marking shape depends on what the pass iterates over, not on which
      collector it belongs to — a rescan is cheap when a pass is rare and the set is the
      arena you were going to walk anyway, and expensive when the pass is frequent.
- [ ] **§ the-numbers** — The three regimes side by side, with every caveat rule 9 requires:
      no benchmark harness exists in this tree, each figure was taken one case per fresh
      process, the program was allocation-heavy with a live old set, and the C figures are
      through `gcc -O2`.

      | Regime | C backend | x64 backend |
      | --- | --- | --- |
      | non-generational mark-sweep | 400 ms | 500 ms |
      | address-range nursery | 630 ms | *not built* |
      | explicit young list | 244 ms | 196 ms |

      State plainly what the table does and does not support: it supports "the young list
      beat both", it does not support any claim about tera versus another language, and the
      middle row is unreproducible because the code was deleted.
- [ ] **§ riscv-is-excluded-on-purpose** — Establish the capability as a *refusal* rather
      than a gap. `riscv64Target` declares `capabilitySet("terminating-throw",
      "float-text")` and nothing else, so it gets no barrier and no `tera_minor` — and the
      reason is that riscv64 has no runner in this tree (assembly-text tests only), so a
      generational collector there would be unexecutable code that nobody could prove
      correct. An unexecutable collector is worse than none. The rule is enforced from the
      capability set rather than by a per-backend flag, and pinned by a test that asserts the
      barrier appears in exactly the backends declaring `generational-heap`.
- [ ] **§ what-leaves** — Close on the seam chapter 63 needs. The five runtime list heads
      are marked by `tera_minor` as well as `tera_collect`, and a promise whose waiter frame
      is old but whose resolved value is young is precisely the old→young edge this chapter
      built the barrier for.

## Honesty items

- > **Measured worse.** The address-range nursery, C backend, 400 ms → 630 ms. It is not in
  the tree — it was removed when it lost — so this is a recorded measurement, not a
  reproducible one. Cost of "finishing" it: it cannot be finished without a moving
  collector, and [Ch 61 § nothing-moves] prices that at three backends plus the register
  allocator.
- > **Measured worse.** A fixpoint-rescan minor mark (the shape x64's major `markPass`
  uses), 1.3× slower than the work-stack `markYoung` in
  `src/optimizing/backends/x64/heap.ts:204`. Also not in the tree.
- > **Unfinished.** `src/optimizing/backends/riscv64/target.ts:42` declares no
  `generational-heap`, so riscv64 keeps only the full collector. Cost of finishing: port
  `markYoung`, `markYoungPass`, `sweepYoung`, `minor` and `writeBarrier` from
  `backends/x64/heap.ts` to riscv machine IR (five routines, ≈450 lines of builder code) —
  and, first, a riscv64 runner, because [Ch 72 § riscv-encode] records that
  `McTarget.encode()` throws, so nothing riscv64 emits has ever been executed.
- > **Unenforced.** `tera_remember` drops an entry when `tera_remembered` is full and
  returns silently; soundness then rests entirely on `tera_minor`'s opening
  `if (rememberedCount == TERA_REMEMBERED_CAPACITY) { tera_collect(); return; }`. Those two
  facts are 190 lines apart in `backends/c/emit.ts`, are written twice more in
  `backends/x64/heap.ts`, and nothing ties them together. Change either half alone and the
  collector loses objects silently. Cost of enforcing: make the drop impossible instead —
  have `tera_remember` set a `rememberedOverflow` flag that `tera_minor` checks, so the
  invariant is one variable rather than one equality repeated in four places.
- > **Unenforced.** The barrier's region guard — `inputs[0].type === IR_RUNTIME_BASE` — is
  written independently in `backends/c/emit.ts:2302` (`emitBarrier`) and
  `backends/x64/lowering.ts:1317` (`rememberStore`). Nothing checks the two agree, and the
  bug § the-barrier-bug describes is exactly what disagreement looks like: silent, for
  weeks. The three e2e tests assert the *absence* of a barrier in emitted C only; the x64
  half is unpinned. Cost of enforcing: lift the predicate into one shared
  `remembersStore(node, scalar)` in `src/optimizing/analyses/`, ≈10 lines, and have both
  backends call it.
- > **Unfinished.** `TERA_YOUNG_CAPACITY` (8192 objects) and `TERA_REMEMBERED_CAPACITY`
  (2048 objects) are compile-time constants with no flag, so the nursery size is not tunable
  per program the way `--heap-size` tunes the arena. A program whose live young set exceeds
  8192 objects promotes everything on its first minor collection and gets no generational
  benefit at all, silently. Cost of finishing: thread both through `AotCompileOptions`
  beside `heapBytes`, and add a `--stats`-style line reporting minor-versus-major counts so
  the degenerate case is visible.

## Verify it yourself

```bash
node dist/cli.js targets
node dist/cli.js compile docs/example/stats.tera --emit source --target c   -o /tmp/stats-c
node dist/cli.js compile docs/example/stats.tera --emit source --target x64 -o /tmp/stats-x64
node dist/cli.js compile docs/example/stats.tera --emit source --target riscv64 -o /tmp/stats-rv
grep -c tera_write_barrier /tmp/stats-c/stats.c /tmp/stats-x64/stats.s /tmp/stats-rv/stats.s
grep -n "cmpq tera_context+64(%rip)" -A 2 /tmp/stats-x64/stats.s
npx vitest run --project e2e tests/e2e/optimizing/aot/arena-collector.test.ts
```

The `grep -c` answers `12`, `19`, `0`: the `generational-heap` capability, visible as a
count of a symbol. The next command is the inline nursery check — `tera_context+64` is
`nurseryLimit`, and the `ja` goes to `.L_fixed_text_0_alloc_0`, the slow path for the
prelude's own allocation. No timing command is offered because § the-numbers is a recorded
measurement and the losing implementation no longer exists.

## Tests that pin this

- The barrier fires where it must: `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"takes the write barrier on a reference store and leaves a number store alone"`,
  `"leaves a purely numeric store without a barrier"`.
- The barrier bug, one test per region:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"leaves a store into static memory without a barrier"`,
  `"leaves a store into the runtime context without a barrier"`.
  (The second compiles an `async` program, because `queue_head` is the runtime-context store
  that a real program actually produces — chapter 63's data structure, tested here.)
- The capability is the enforcement:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"emits the barrier from exactly the backends that declare a generational heap"`. Read
  this one closely in the prose: it asserts equality against
  `model.capabilities.has("generational-heap")` rather than against a hard-coded list, so
  adding the capability to riscv64 without porting the routines fails the test.
- Old→young survival, run as a real program on two backends:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"keeps a young object stored into a promoted one alive"` (appears twice — once under
  `itNative` through the C toolchain, once under `itRunsPe` as a PE binary).
- The major collector still working underneath:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"keeps allocating past the size of the arena"`,
  `"still reclaims when the roots live in a class the program keeps"`,
  `"keeps a graph reachable only through a field alive across collections"`.
