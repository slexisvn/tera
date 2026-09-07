# 61. The arena, the shadow stack, and why nothing moves   ⟨– · – · – · N⟩

> **Status:** outline

**Thesis.** One layout file feeds two entirely independent implementations of the same
collector, and the root slot is a *mirror* rather than a *handle* — which is the single
property that closes off every moving-collector design.

**What arrived.** A single entry module containing the user's program plus every generated
prelude class and function the program demanded, with call sites already rewritten. Those
generated classes are the reason `docs/example/stats.tera` — five floats and two objects —
allocates on the heap at all: `_FixedDigits.cells` is an `int[]` that `push`es inside a
loop, and `_FixedText.text` is a string field rebuilt on every digit.

**What leaves.** A program in which every function that holds a reference opens with a root
frame (`tera_enter_roots` on the native targets, four lines of C on the portable one),
stores every `SCALAR_POINTER` value into its slot as it is defined, and restores
`tera_context.root_count` on every exit path; plus a `tera_alloc` that bumps, falls back to
a free list, and collects. Every object in it is marked `TERA_OLD_FLAG` on the first sweep
that keeps it. Chapter 62 receives exactly that — a working non-moving mark-sweep collector
with two spare flag bits — and asks whether the young objects can be collected separately.

**New ideas.** The heap as a data structure (a program's objects are not "in RAM", they are
in a region the program itself manages); reserve-versus-commit address space; bump
allocation; a free list, first fit, splitting and coalescing; external fragmentation;
*precise* versus *conservative* rooting; a garbage collection *root*; a *safepoint* (any
call that can collect); mark-sweep; a work stack and what happens when it overflows; a
*shadow stack* versus *stack maps*, and the third option the C backend rules out; a
*handle* versus a *mirror*, which is this chapter's whole payload.

**Length.** 16 pages

## Anchors

- `src/optimizing/target/runtime-layout.ts` — 260 lines, the single source of truth.
  `declareRecord` (52-91) computes offsets from field widths and throws on a duplicate name;
  `declareArray`, `declareTable`. `TERA_CONTEXT` (119-148) — **twenty-eight fields**, from
  `arenaBase` to `pendingThrowValue`, each tagged `shared` or `perThread`. `TERA_CLASS_RECORD`
  (201-206) — `tailReferences`, `fieldStart`, `fieldCount`, `reserved`, 16 bytes.
  The five fixed arrays `TERA_ROOTS` / `TERA_MARKS` / `TERA_YOUNG` / `TERA_REMEMBERED` /
  `TERA_STATICS` with capacities `1<<14`, `1<<12`, `1<<13`, `1<<11`, `1<<12` bytes; the
  three tables `TERA_CLASS_FIELDS`, `TERA_STATIC_ROOTS`, `TERA_STATIC_ROOT_COUNT`. The
  arena constants `TERA_HEAP_RESERVE_BYTES = 1<<30`, `TERA_HEAP_COMMIT_BYTES = 1<<20`,
  `TERA_HEAP_MINIMUM_BYTES = 1<<16`. Every runtime symbol name (238-246). The flag bits
  (253-258): `TERA_FREE_SHAPE_ID = 0`, `TERA_MARK_FLAG = 1`, `TERA_OLD_FLAG = 2`,
  `TERA_REMEMBERED_FLAG = 4`, `TERA_BLOCK_FLAGS = 7`, `TERA_LINK_BYTES = 8`. And the
  derived shifts `TERA_ROOT_SLOT_SHIFT`, `TERA_CLASS_RECORD_SHIFT`, `TERA_COUNT_SHIFT` —
  logs of the widths, so an index becomes a shift with no second constant to keep in step.
- `src/optimizing/analyses/aot-legality.ts:846-862` — `isRootedPointer` (three lines: not
  `IR_RUNTIME_BASE`, has at least one use, scalar is `SCALAR_POINTER`) and `rootSlotsOf`,
  which hands out slot indices in iteration order and — the fix for a real
  use-after-free — skips a value it has already seen (`slots.has(value)`).
- `src/optimizing/backends/c/emit.ts` — the portable collector, emitted as C text.
  `CEmitter.rootStore` (1939) and `rootFrame` (2526); the `tera_context` struct fields
  table at 1275-1290; `tera_block_size` (1372); `tera_mark` (1417) with its
  `TERA_MARKS.capacity` work stack, `tera_mark_pending` (1437) the overflow rescan,
  `tera_mark_young` (1458), `tera_release` (1494) with the cursor rewind,
  `tera_sweep_young` (1507), `tera_sweep` (1532), `tera_collect` (1558),
  `tera_minor` (1578), `tera_reserve` (1609).
- `src/optimizing/backends/x64/heap.ts` — the same collector written a second time, as
  machine IR. `contextField(name)` (82) turning a `TeraContextField` into a memory operand;
  `markPass` (272) and `sweep` (350); `collect` (413), `markRoot` (437), `markRoots` (458);
  `markYoung` (204) and `markYoungPass` (301); `writeBarrier` (661); `take` (700) the free
  list, `bump` (748), `allocate` (776), `arrayReserve` (866); `reserve` (944) and `grow`
  (994), the two halves of reserve-then-commit; `probeStack` (1040); `enterRoots` (1061);
  `x64HeapRoutines` (1105) listing all fifteen. `ROOT_FRAME_REGISTER = "r10"`,
  `ROOT_COUNT_REGISTER = "r11"`.
- `src/optimizing/machine/select.ts:128-140` — `reserveRoots`: allocates one
  `TERA_ROOT_ENTRY_BYTES` frame slot, sets `fn.roots`, and forces `fn.hasCalls = true`
  (a function with roots always has a frame). `emitRoot` (142) is called after every
  selected node, every phi copy and every parameter bind, and does nothing when the value
  has no slot.
- `src/optimizing/machine/heap-data.ts` — `classData` (45) rendering `TERA_CLASS_RECORD`
  as machine data, `contextDatum` (85), `heapImageOf` (106), `heapData` (113). This is the
  file that makes the "two implementations, one layout" claim checkable: `classData` writes
  `["tailReferences", …], ["fieldStart", …], ["fieldCount", …]` in the record's own field
  order rather than in a hand-written order.
- `src/optimizing/metadata/class-table.ts` — the object model the collector walks.
  `CLASS_SHAPE_ID_OFFSET = 0`, `CLASS_FLAGS_OFFSET = 4`, `CLASS_HEADER_BYTES = 8`,
  `CLASS_ALIGNMENT_BYTES = 8` (50-53) — the eight-byte alignment is *why* flag bits 1 and 2
  are free, which chapter 62 spends. `ARRAY_LENGTH_OFFSET` / `ARRAY_CAPACITY_OFFSET` /
  `ARRAY_ELEMENTS_OFFSET` (72-74), `FREE_BLOCK_BYTES` (79),
  `CLEAR_MARK = -1 - TERA_MARK_FLAG` (80) — written as a signed constant so the assembler
  picks the same `imm8` form the encoder does. `ClassShape.tailReferences` (272) and
  `ClassTable.shapes()` / `shapeById`.
- `src/optimizing/target/capabilities.ts` — 17 lines; the whole capability vocabulary. This
  chapter needs none of them, which is the point: *every* native target has a collector.
- `tests/e2e/optimizing/aot/arena-collector.test.ts` — `CELL`, `HOLDER`, `CHURN`, `RETAIN`,
  `GROWN`, `REPLACES` (the allocation-heavy programs the running example cannot supply) and
  `ROUNDS_PAST_THE_ARENA`, computed from `TERA_HEAP_COMMIT_BYTES` so the test still
  overflows the arena if the constant changes.

## Worked example

The stale-local proof comes out of the running example itself, by way of chapter 60's
prelude. `_FixedDigits.put` contains `this.cells.push(0)` inside a `while`:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
grep -n "tera_array_reserve" -A 3 /tmp/stats-c/stats.c
```

which prints, inside `_FixedDigits_put`:

```c
  unsigned char *v27 = (*(unsigned char * *)(p0 + 8));
  tera_context.roots_base[roots + 4] = (unsigned char *)v27;
  unsigned char *v28 = tera_array_reserve(v27, 7, 4);
  tera_context.roots_base[roots + 5] = (unsigned char *)v28;
  const int32_t v29 = (*(int32_t *)(v27 + 8));
  ((int32_t *)(v28 + 8))[v29] = v0;
```
— generated `stats.c:1503-1508`

`tera_array_reserve` can collect. `v27` is rooted at slot 4, so the *object* survives.
The very next line reads `v27` — the C local, never reloaded from the slot. If the collector
had moved that object, `v27` and `v28` would both dangle. That is the whole chapter in six
lines, and it is produced by a 24-line program.

The collector actually *collecting* is out of the running example's reach — five floats
never fill a 1 GB arena — so the running-out beats use `CHURN`, `RETAIN` and `GROWN` from
`tests/e2e/optimizing/aot/arena-collector.test.ts`, whose round counts are computed from
`TERA_HEAP_COMMIT_BYTES` rather than hard-coded.

## Outline

- [ ] **§ what-a-heap-is** — `> **New idea.**` Establish that a compiled tera program owns
      its heap outright: there is no `malloc` in the hot path, no OS allocator, no VM. One
      reservation, a cursor, and a free list. State the size numbers from
      `runtime-layout.ts` and where `--heap-size` changes them.
- [ ] **§ one-file-two-implementations** — Establish the drift problem before the solution:
      `tera_context.rootCount` is read by C source that a system compiler will compile, and
      by x64 machine IR that this compiler will assemble. If those two disagree about an
      offset the program is silently wrong. Then `declareRecord`: offsets are *computed*
      from a field-order list, `bytes` and `alignment` fall out, `field(name)` throws on a
      name that is not there, and a duplicate name throws at module load. Show the two
      readers side by side — `cContextField("freeHead")` producing `tera_context.free_head`
      and `contextField("freeHead")` producing a `MemoryOperand` at
      `TERA_CONTEXT.offsetOf("freeHead")`. Name the invariant, the enforcement (a computed
      table with one writer), and the test.
- [ ] **§ the-block-header** — Fixed-width ASCII table of the eight-byte object header:
      shape id at 0 (`u32`), flags at 4 (`u32`). Establish the two overloads that make the
      whole design work: **shape id 0 means "this block is free"** (`TERA_FREE_SHAPE_ID`),
      and in a free block the flags word holds the block's *size in bytes* instead of
      flags. `CLASS_ALIGNMENT_BYTES = 8` means bits 0-2 of every size are zero, which is
      where the mark bit lives — and where chapter 62's two generation bits will live.
- [ ] **§ reserve-then-commit** — Establish the distinction between address space and
      memory. `tera_reserve` maps `TERA_HEAP_RESERVE_BYTES` (1 GB) with no backing, commits
      the first `TERA_HEAP_COMMIT_BYTES` (1 MB), and `tera_grow` commits more on demand;
      `arenaReserved`, `arenaCommitted` and `arenaCursor` are three different numbers and
      the chapter must keep them apart. Why this shape: a program that allocates once
      should not touch a gigabyte of pages, and a program that allocates forever should not
      have to relocate its heap — which it *cannot*, per § nothing-moves.
- [ ] **§ allocation-in-three-steps** — Read `tera_alloc` (C) and `allocate` (x64) as the
      same routine written twice. Bump the cursor if it fits (`bump`); otherwise take a
      first fit from the free list, splitting the remainder (`take`); otherwise collect and
      retry; otherwise `exit(TERA_EXIT_HEAP_EXHAUSTED)`. Establish first-fit and external
      fragmentation as concepts here, and state honestly what is *not* implemented: no size
      classes, no segregated lists, no best fit — one singly-linked list threaded through
      the free blocks themselves at offset `CLASS_HEADER_BYTES`, which is why
      `FREE_BLOCK_BYTES` is the minimum a released block must be to join the list at all
      (a smaller hole is simply abandoned).
- [ ] **§ roots-and-safepoints** — `> **New idea.**` A root; a safepoint. Establish that the
      collector needs to know every live reference at the moment it runs, and that "live"
      means "the program will read it again". Then the three ways a compiler can answer:
      *conservative* scanning (read the machine stack, treat anything that looks like a
      pointer as one), *stack maps* (a side table saying which frame slots hold references
      at each call site), and a *shadow stack* (the program maintains an explicit array).
- [ ] **§ why-not-stack-maps** — *Why the obvious design fails.* Stack maps are what a
      production runtime uses, and they are strictly better for the two native backends.
      They are impossible for `cBackend`: the C backend emits *C source*, a system compiler
      allocates its registers and lays out its frame, and nothing in the emitted program can
      walk its own frames or know where a `unsigned char *v27` ended up. Establish the
      consequence: one mechanism for three backends beats two mechanisms for two, so the
      shadow stack wins by portability, not by merit. Note the cost in the same breath —
      a store per rooted definition, and roots that live for the whole activation (which
      over-retains but is never wrong).
- [ ] **§ the-root-frame** — Read `rootFrame` (C) and `enterRoots` (x64) together. The
      protocol is four steps: read `rootCount` into a local named `roots`; check
      `roots + N <= TERA_ROOT_CAPACITY` or exit; publish `rootCount = roots + N`; zero the
      N new slots — *before* any of them is stored, because a collection can happen between
      the frame opening and the first store. Then the epilogue restores `rootCount = roots`
      on **every** exit path, and § honesty-items names what checks that. Quote the real
      frame from `report` in generated `stats.c:1226-1233`.
- [ ] **§ one-slot-one-value** — Invariant → enforcement → test, and the bug that produced
      it. `rootSlotsOf` numbers values by iteration order into a `Map`. The bug: both
      callers walked `[...block.phis, ...block.nodes]`, and `addPhi` puts a phi in **both**
      lists, so the second visit re-assigned the phi a later index — and `Map.set` on an
      existing key does not grow `size`, so the *next* value got that same index. Measured:
      eight rooted values sharing six slots in a loop that carries a reference across the
      back edge. Whichever wrote last won; the other object was unrooted while still live —
      a use-after-free that only appears once the arena fills. The fix is `slots.has(value)`
      in `rootSlotsOf` (`aot-legality.ts:858`). The regression test reads the emitted C:
      every `roots_base[roots + N]` index inside one function must be written by exactly one
      variable name.
- [ ] **§ nothing-moves** — The chapter's thesis, stated as a distinction.
      `> **New idea.**` A *handle* is a slot that is the only way to reach the object: every
      use goes `*handle`, so a collector may rewrite the slot and move the object. A
      *mirror* is a slot that holds a copy: the value also lives in a register or a C local,
      and every use reads *that*. tera's root slots are mirrors — read the six lines of
      `_FixedDigits_put` and point at `v27` being read after `tera_array_reserve` returned.
      `isRootedPointer` roots every `SCALAR_POINTER` value, so the shadow stack *does*
      enumerate every live reference, which is what makes this look like enough for a moving
      collector. It is not. State the cost of the conversion precisely, because that is what
      makes this an engineering judgement rather than an excuse: every pointer *use* would
      have to reload from its slot in the C emitter, and every live pointer register would
      have to be reloaded after every call in the x64 and riscv64 lowerings — three
      backends, and it defeats the register allocator by turning every reference into a
      memory operand. Then the compensations that come free from *not* moving: an interior
      `char *` into an object's inline text stays valid ([Ch 59 § object-owned-text]), and a
      pointer cached in a callee-saved register survives a collection untouched.
- [ ] **§ marking** — Establish tri-colour marking informally, then read both
      implementations. C: `tera_mark` is a depth-first walk over an explicit work stack in
      `tera_marks`, `TERA_MARK_CAPACITY = 4096` entries; when it fills, it sets
      `overflowed` and `tera_collect` loops `while (overflowed) overflowed =
      tera_mark_pending()`, a full-arena rescan that finds every marked block with an
      unmarked child. x64: there is **no work stack in the major collector at all** —
      `markPass` *is* the rescan, driven to a fixpoint by `collect`. State why the two
      differ: the rescan is far less assembly and needs no overflow handling, and the C
      version keeps both because it can. Then the reference walk itself — `tera_classes[id]`
      gives `fieldStart`/`fieldCount` into `tera_class_fields`, plus `tailReferences` for an
      array of pointers — and note that the table is flat, 16 bytes a shape plus one `u32`
      array, so it needs no relocations.
- [ ] **§ the-five-list-heads** — Establish a root set that is not the shadow stack.
      `tera_collect` also marks `waitHead`, `sweepHead`, `queueHead`, `rejectedHead` and
      `rejectedText` out of `tera_context`, plus every static-root offset in
      `tera_static_roots`. These are the event loop's own data structures [Ch 63] — a
      suspended coroutine frame is reachable from *nothing else*, exactly as it was in the
      interpreter. Name the invariant: **a runtime list head is a root, and adding a sixth
      list without adding a sixth mark is a silent use-after-free**, then earn the
      `> **Unenforced.**` callout in § honesty-items.
- [ ] **§ sweeping** — Read `tera_sweep`. Walk the arena linearly by block size; a marked
      block has its flags reset to `TERA_OLD_FLAG` (that single line is chapter 62's seam);
      an unmarked run is *coalesced* — the loop keeps extending `bytes` across consecutive
      dead blocks before releasing once — and handed to `tera_release`. Then the two things
      `tera_release` does that matter: if the block ends exactly at
      `arenaBase + arenaCursor` it **rewinds the cursor** instead of freeing (so a
      pure-churn program's arena never grows), and it joins the free list only when the hole
      is at least `FREE_BLOCK_BYTES`. Note that `tera_sweep` clears `freeHead` first and
      rebuilds the whole list, which is why fragmentation is bounded by coalescing rather
      than by compaction.
- [ ] **§ what-was-tried-and-rejected** — Two recorded items, both about symbol and layout
      discipline rather than algorithms, both of which cost real debugging.
      (1) The `statics` *routine* was once named `tera_statics` and collided with the
      `tera_statics` *data* symbol once the arena data moved to module level;
      `IR_STATICS_BASE` now materialises the address inline (`leaq` / `lla`) and the routine
      is gone. (2) Runtime data must be emitted **after** the functions in the assembly-text
      path, or every function's `.LC*`/`.LB*` constant shifts and the byte-for-byte gas
      comparison tests diverge on relocation addends. Plus the encoding footnote:
      `movq mem(symbol), imm` encodes the RIP displacement differently from gas, so the
      routines zero a register instead.
- [ ] **§ what-leaves** — Close on the two facts chapter 62 needs: every surviving object is
      now stamped `TERA_OLD_FLAG` by the sweep, and bits 1 and 2 of the flags word are free
      because objects are 8-aligned. The next chapter spends both.

## Honesty items

- > **Unenforced.** The root-frame protocol — publish `rootCount`, zero the new slots,
  restore `rootCount` on *every* exit path — is emitted by hand in two places
  (`CEmitter.rootFrame` / the `return` path in `emit.ts`, and `enterRoots` plus the epilogue
  in the x64 lowering) and checked by nothing. `validateMachineFunction` has no
  root-balance rule, and the C output is not parsed. A function with an exit path that
  forgets the restore leaks root slots until `TERA_ROOT_CAPACITY` is hit, which reports as
  heap exhaustion at an unrelated place. Cost of enforcing: a machine-IR verifier rule
  pairing `tera_enter_roots` with the epilogue store, ≈20 lines, plus the equivalent
  assertion in the C emitter.
- > **Unenforced.** The five runtime list heads marked by `tera_collect` and `tera_minor`
  (`waitHead`, `sweepHead`, `queueHead`, `rejectedHead`, `rejectedText`) are written out by
  hand, twice per backend — four hand-written lists in total. `TERA_CONTEXT` knows those
  fields exist but does not mark them as roots, so adding a sixth runtime list and
  forgetting one of the four sites is a use-after-free with no compile error. Cost of
  enforcing: an `ownership`-style tag on the field spec (`root: true`) and a generated loop,
  perhaps 30 lines across `runtime-layout.ts` and both emitters.
- > **Unfinished.** `TERA_ROOT_CAPACITY` (16384), `TERA_MARK_CAPACITY` (4096),
  `TERA_YOUNG_CAPACITY` (8192) and `TERA_REMEMBERED_CAPACITY` (2048) are compile-time
  constants with no `--flag`, while the arena itself is sized by `--heap-size`. A deeply
  recursive program exits with `TERA_EXIT_HEAP_EXHAUSTED` from `enterRoots` rather than
  from allocation, and the message does not distinguish the two. Cost of finishing: thread
  the four capacities through `AotCompileOptions` the way `heapBytes` already is, and give
  the root overflow its own exit code and sentence.
- > **Measured worse.** *(Forward reference, paid off in [Ch 62 § address-range-nursery].)*
  The obvious way to make this collector generational — an address-range nursery — was
  built, measured at 400 ms → 630 ms, and removed. It is named here only so the reader does
  not spend the next chapter waiting for it.
- > **Unenforced.** `contextStorageFault` and `threadEntryPointFault`
  (`runtime-layout.ts:176-199`) exist to refuse a second thread, and `perThreadContextFields`
  computes the twenty-five `perThread` fields that would need duplicating. They *do* throw —
  `withoutThreadEntryPoints` is real — but nothing checks that a newly added `tera_context`
  field is tagged with the right ownership. A shared-tagged field that is actually
  per-thread would be invisible until threads existed, and threads are refused, so the tag
  is presently documentation. See [Ch 81 § no-concurrency].

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
grep -n "tera_array_reserve" -A 3 /tmp/stats-c/stats.c
sed -n '1226,1233p' /tmp/stats-c/stats.c
grep -o "roots_base\[roots + [0-9]*\]" /tmp/stats-c/stats.c | sort | uniq -c
npx vitest run --project e2e tests/e2e/optimizing/aot/arena-collector.test.ts
```

The second command is § nothing-moves: `v27` is read on the line *after* a call that can
collect. The third is the root frame from `report`. The fourth is the one-slot-one-value
invariant — every index except slot 0, which many separate functions each use once, appears
exactly once. The last runs the collector's e2e suite; on a machine without a PE runner
eleven of the nineteen cases skip and the report says so.

## Tests that pin this

- The class table the collector walks:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"describes every class the collector has to sweep"`.
- The shadow stack: `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"gives every function that holds a reference a root frame"`.
- One slot, one value — the use-after-free regression:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"gives a loop-carried reference a root slot of its own"`.
- The collector actually reclaiming, run as a native binary:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"keeps allocating past the size of the arena"`,
  `"keeps a graph reachable only through a field alive across collections"`,
  `"keeps the elements of a grown array alive across collections"`,
  `"still reclaims when the roots live in a class the program keeps"`.
- Array growth staying valid across a reserve that collects — the `kept.push(fresh)` shape
  the worked example reads: `tests/e2e/optimizing/aot/heap-arrays.test.ts` >
  `"allocates the array on the heap rather than in the frame"`,
  `"grows an array past the length it was created with"`,
  `"grows an array reachable through a field without losing the holder"`,
  `"keeps every batch a loop refilled and handed over"`.
- Layout agreement between the two implementations has **no direct unit test**
  ([unpinned] — there is no `tests/optimizing/machine/heap-data.test.ts`). It is pinned
  only indirectly, by every byte-for-byte gas comparison in
  `tests/optimizing/backends/x64/assembly.test.ts`, which fails if a `tera_context`
  displacement moves. Say so rather than implying a checker exists.
