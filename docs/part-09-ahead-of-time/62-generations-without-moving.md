# 62. Generations Without Moving   ⟨– · – · – · N⟩

The obvious way to make a collector generational is to reserve one end of the heap as a
nursery, allocate into it by bumping a cursor, and on a minor collection copy the survivors
out and reset the cursor to the bottom. That is the shape almost every production
generational collector has. It was built here, it was measured, and it lost — 400 ms became
630 ms — for one reason that has nothing to do with tuning: a collector that cannot move an
object cannot get survivors *out* of a nursery, so the nursery's floor can never rise, so the
nursery grows until it is the whole arena and every allocation triggers a collection that
frees almost nothing.

What shipped instead keeps the generational idea and throws away the geometry. The young set
is an explicit array of pointers rather than a range of addresses; promotion is a bit flip
rather than a copy; and a minor collection walks that array instead of a region. Two flag
bits pay for all of it, and they cost nothing, because every block is eight-byte aligned and
its size therefore has three spare bits at the bottom.

One caution before anything else. The measurement that decides this chapter cannot be
reproduced from this tree, because the losing implementation was deleted when it lost. The
numbers in § the-numbers are recorded, not runnable, and the chapter says so where they
appear rather than in a footnote. Everything else here — the barrier, the young list, the
remembered set, the promotion, the capability split — is in the tree and is read out of what
`docs/example/stats.tera` actually compiles to.

**What arrived.** From [Ch 61 § what-leaves](61-the-arena-the-shadow-stack-and-why.md): a
working non-moving mark-sweep collector. A reserve-then-commit arena addressed by
`arenaBase`/`arenaCursor`/`arenaCommitted`; a first-fit free list keyed on shape id 0 and
threaded through the holes themselves; a shadow stack whose slots are *mirrors* rather than
handles, which is precisely why nothing may move; and a sweep that stamps `TERA_OLD_FLAG` on
every block it keeps. Two independent implementations — C source text and x64 machine IR —
both taking their `tera_context` offsets from `src/optimizing/target/runtime-layout.ts`. And
two flag bits that nothing yet reads.

## The hypothesis

> **New idea.** The *generational hypothesis* is the observation that in most programs most
> objects die very young: a temporary built inside a loop body, a string produced and
> immediately consumed, an intermediate object in an expression. If that holds, a collection
> that examines only recently allocated objects costs O(live young) rather than O(heap), and
> the ratio between those two is the whole win. It is a *hypothesis*, not a law. It is a
> statement about programs, it is measured per program, and a program that allocates a large
> long-lived structure and then does nothing gets no benefit from it at all.

Say what makes the idea *sound*, though, because that is where all the machinery goes. A
minor collection starts from the roots, walks only young objects, and treats every old object
as live without examining it. That is correct except for exactly one kind of edge: an **old
object holding a reference to a young one**. The minor collection will not reach that young
object from the roots — the path goes through an old object it deliberately did not walk — so
it will conclude the young object is garbage and free it while the old object still points at
it.

Young→old edges are harmless: the old object was never a candidate for collection.
Young→young edges are found by the normal walk. Old→old edges are irrelevant. Only old→young
is missed, and *only when the edge was created after the last collection*, because a
collection promotes everything it keeps.

So a generational collector needs two things beside the collector it already has: a **young
set**, so it knows what to walk and what to sweep, and a **remembered set**, so it knows
which old objects have acquired a young reference since the last collection. Everything in
this chapter is one of those two, or the barrier that populates the second, or a consequence
of tera not being allowed to move anything.

## Two free bits

The generation state costs zero bytes per object, by the mechanism
[Ch 57 § eight-bytes-and-three-spare-bits](57-objects-without-a-runtime-type.md) named: tag
bits stolen from an aligned value. `CLASS_ALIGNMENT_BYTES = 8`
(`src/optimizing/metadata/class-table.ts:53`), so every block's size in bytes is a multiple of
eight, so the low three bits of every size are zero. The header's second word stores the size
*and* the flags in the same `u32`:

```
        31                                        3    2    1    0
        +-----------------------------------------+----+----+----+
 live   | block size in bytes (a multiple of 8)   | R  | O  | M  |
        +-----------------------------------------+----+----+----+

        31                                        3    2    1    0
        +-----------------------------------------+----+----+----+
 free   | block size in bytes                     | 0  | 0  | 0  |
        +-----------------------------------------+----+----+----+

 M = TERA_MARK_FLAG        1   reached by this collection
 O = TERA_OLD_FLAG         2   survived at least one collection
 R = TERA_REMEMBERED_FLAG  4   already in the remembered set
```
— `src/optimizing/target/runtime-layout.ts:253-257`

Chapter 61 spent bit 0. This chapter spends bits 1 and 2, and it spends them without
enlarging any object, adding any side table, or changing any offset. `tera_block_size` reads
the size back by masking `TERA_BLOCK_FLAGS` — the same three-bit mask, whichever bits happen
to be set:

```c
static uint32_t tera_block_size(const unsigned char *block) {
  return *(const uint32_t *)(block + 4) & ~(uint32_t)7u;
}
```
— generated `stats.c:180-182`

The masks that clear those bits are written as signed constants —
`CLEAR_MARK = -1 - TERA_MARK_FLAG`, `CLEAR_BLOCK_FLAGS = -1 - TERA_BLOCK_FLAGS`,
`CLEAR_REMEMBERED = -1 - TERA_REMEMBERED_FLAG` (`class-table.ts:80-82`) — rather than as
`0xFFFFFFF8`-style unsigned literals, so that this compiler's encoder and `gas` choose the
same sign-extended `imm8` encoding and the byte-for-byte assembly comparison tests of
[Ch 69](../part-10-bytes/69-the-assembler.md) still pass.

The consequence that matters is that "is this object young?" is one bit test:

```c
static inline int32_t tera_is_young(const unsigned char *block) {
  return (*(const uint32_t *)(block + 4) & 2u) == 0u;
}
```
— generated `stats.c:191-193`

*Young* is defined negatively — not old — so a freshly allocated object, whose flags word was
just set to its size with no flags at all, is young for free. Nothing has to stamp it.

That one-instruction test is what makes the write barrier affordable, and the barrier is the
only part of this machinery that runs on the mutator's own path.

## Why the obvious design fails: the address-range nursery

Stage the textbook design honestly, because it is genuinely the right answer almost
everywhere else.

Reserve the top slice of the arena as the nursery. Allocate into it by bumping a cursor.
When the cursor reaches the top, run a minor collection: trace from the roots and the
remembered set, and **evacuate** — copy — every survivor down into the old region below.
Then reset the nursery cursor to the nursery's floor. The nursery is now entirely empty,
allocation is a pointer bump with a single compare, and the survivors have been compacted
into the old region as a side effect, so the design defragments while it collects.

Every step of that depends on the copy. And tera cannot copy, for the reason
[Ch 61 § nothing-moves](61-the-arena-the-shadow-stack-and-why.md) gives at length: the root
slots are mirrors, not handles, so the collector can reach one copy of a pointer and the
program reads another. A survivor is therefore *pinned* at the address it was allocated at.

Follow that through:

1. A minor collection finds a survivor. It cannot move it, so the survivor stays inside the
   nursery's address range.
2. The nursery's floor cannot rise past a pinned survivor — the survivor's address is below
   any new floor you would like to set.
3. So the bump cursor cannot be reset to the floor. The best it can do is continue upward
   from wherever the survivors end.
4. The nursery therefore creeps toward the top of the arena, and the fraction of it that is
   pinned old data grows monotonically.
5. Eventually the nursery is nearly all survivors. Every allocation reaches the limit, runs a
   minor collection, walks a young "set" that is mostly old objects, and reclaims almost
   nothing.

That is not a tuning failure. There is no nursery size, promotion age or survivor-space ratio
that fixes it, because the defect is that promotion is supposed to *remove* an object from
the nursery and here promotion cannot move anything anywhere.

> **Measured worse.** The address-range nursery. C backend, `gcc -O2`, an allocation-heavy
> program with a live old set, one case per fresh process: **400 ms → 630 ms**. It is not in
> this tree — it was removed when it lost — so this is a recorded measurement and not a
> reproducible one. Cost of "finishing" it: it cannot be finished without a moving collector,
> and [Ch 61 § nothing-moves] prices that at three backends' code generators plus the
> register allocator of [Ch 66](../part-10-bytes/66-linear-scan-register-allocation.md).

The general rule the failure produced, stated so nobody retries it: **a non-moving collector
cannot keep a nursery contiguous, so its young set must be a list of objects, not a range of
addresses.**

## The explicit young list

The replacement is the smallest thing that satisfies the rule. `tera_young` is a fixed array
of `TERA_YOUNG_CAPACITY` = 8192 pointers (`runtime-layout.ts:108, 210`), and every allocation
appends to it:

```c
static void tera_note_young(unsigned char *block) {
  tera_context.young_base[tera_context.young_count++] = block;
}
```
— generated `stats.c:195-197`

There is no bound check there, and there does not need to be one: `tera_alloc` refuses to
reach this line with a full list, because its second statement is
`if (tera_context.young_count == 8192u) tera_minor();` (generated `stats.c:475`). The x64
allocator does the same thing in the same place, comparing `youngCount` against
`TERA_YOUNG_CAPACITY` and calling `tera_minor` when it is not below
(`src/optimizing/backends/x64/heap.ts:790-794`).

A minor collection sweeps that list rather than the arena:

```c
static void tera_sweep_young(void) {
  size_t at = 0;
  while (at < tera_context.young_count) {
    unsigned char *block = tera_context.young_base[at];
    uint32_t *flags = (uint32_t *)(block + 4);
    if ((*flags & 1u) != 0u) {
      *flags = (*flags & ~(uint32_t)7u) | 2u;
      at++;
      continue;
    }
```
— generated `stats.c:315-324`

That single line — `*flags = (*flags & ~7u) | 2u;` — is **promotion**. Clear the mark bit,
clear the remembered bit, set `TERA_OLD_FLAG`. The object does not move, does not get copied,
does not change address, and nothing that points at it needs to be told. Promotion in a
non-moving collector is a bit flip, and that is the entire reason the design works.

It is the same line the major sweep uses (generated `stats.c:347`), which is the seam chapter
61 pointed at: a full collection promotes everything it keeps, so after a major collection
the young list is empty and every live object is old.

The unmarked half of the loop coalesces exactly the way `tera_sweep` does, but with one extra
condition. Because the young list is in allocation order rather than address order, a run of
consecutive dead young objects is only contiguous in memory if each block's end is the next
block's start, so the loop tests `block + bytes != next` and stops when the run breaks
(generated `stats.c:326-334`). Then `tera_release` — the same routine from
[Ch 61 § sweeping] — either rewinds the arena cursor or links the hole into the free list.
Finally `young_count = 0`: sweeping the young list always empties it, whether the objects
were freed or promoted.

Afterwards both `tera_minor` and `tera_collect` call `tera_nursery_reset`, which recomputes a
number the next section is about.

## The remembered set

`tera_remembered` holds **objects**, not cards and not slots
(`runtime-layout.ts:211-215`, capacity 2048). That is object granularity: when a minor
collection processes a remembered entry, it scans *every* reference field of that object, not
the one field that was written. The alternative — remembering the address of the written slot
— is more precise per entry and needs more bytes per entry and cannot be deduplicated by a
flag on the object.

Deduplication is what makes object granularity affordable, and it is the third flag bit:

```c
static void tera_remember(unsigned char *target) {
  if (tera_context.remembered_count == 2048u) return;
  *(uint32_t *)(target + 4) |= 4u;
  tera_context.remembered_base[tera_context.remembered_count++] = target;
}
```
— generated `stats.c:199-203`

An object written a thousand times in a loop enters the set once, because the barrier checks
`TERA_REMEMBERED_FLAG` before calling this and `tera_remember` sets it on the way in. The bit
is cleared when the entry is consumed — `*(uint32_t *)(block + 4) &= ~(uint32_t)4u;` inside
`tera_minor`'s scan loop, generated `stats.c:409` — so the object can be remembered again if
it is written again.

Now the honest part. Look at the first line: when the set is full, `tera_remember` **drops the
entry and returns**. That is a silently lost old→young edge, which is exactly the unsound
thing this whole section exists to prevent. What makes it sound is a check 187 lines away, at
the top of the routine that would have consumed the entry:

```c
static void tera_minor(void) {
  if (tera_context.remembered_count == 2048u) {
    tera_collect();
    return;
  }
```
— generated `stats.c:386-390`

If the set is full, do not do a minor collection at all — do a full one, which starts from
the roots and walks everything and does not need a remembered set. The two halves fit: an
entry can only be dropped when `rememberedCount` has reached capacity, and `rememberedCount`
never falls below capacity except by being reset to 0 inside a collection, so any collection
that runs while entries have been dropped is a full one. Neither half is sound alone. Dropping
without escalating loses objects; escalating without dropping would need an unbounded set.

> **Unenforced.** The soundness of the remembered set is a coincidence of two constants being
> equal in two places. `tera_remember` drops on `rememberedCount == TERA_REMEMBERED_CAPACITY`
> (`src/optimizing/backends/c/emit.ts:1392`) and `tera_minor` escalates on the same equality
> (`:1579`), 187 lines apart in one file — and the same pair is written twice more in
> `src/optimizing/backends/x64/heap.ts`, at `:679-681` inside `writeBarrier` and at `:608-612`
> inside `minor`. Nothing relates the four sites. Change any one of them — to `>=`, to a
> different constant, to a growable buffer — and the collector silently frees live objects, in
> the one configuration nothing tests. Cost of enforcing: make the drop impossible to
> misread — have the barrier set a `rememberedOverflow` flag in `tera_context` that
> `tera_minor` checks, so the invariant is one variable rather than one equality repeated in
> four places.

## The barrier

The write barrier is the only piece of this machinery that runs on the program's own path
rather than the collector's, so it is written to leave as early as it can.

```c
static inline void tera_write_barrier(unsigned char *target, const unsigned char *value) {
  if (value == 0 || !tera_is_young(value) || tera_is_young(target)) return;
  if ((*(const uint32_t *)(target + 4) & 4u) != 0u) return;
  tera_remember(target);
}
```
— generated `stats.c:205-209`

Three conditions on one line, and each is a bit test or a null test. Remember only when the
stored value is young **and** the target is old. Both halves have a reason:

- If the *value* is old, a minor collection was never going to free it, so the edge does not
  need recording.
- If the *target* is young, the target is already in the young list and will be scanned by the
  minor collection on its own account, so the edge will be found without help.
- A null value points at nothing.

The common case in an allocation-heavy program — storing into an object that was itself just
allocated — exits on the third test, having read two words. The x64 version
(`src/optimizing/backends/x64/heap.ts:661-699`) is the same predicate written as a chain of
`testl`/`to` pairs, with `tera_remember` inlined into its tail rather than called, and with
the capacity drop expressed as one more early exit.

Two places decide to emit a call to it, and they must agree.
`CEmitter.emitBarrier` (`src/optimizing/backends/c/emit.ts:2295-2303`) is called from
`emitStoreField` (`:2289`) and `emitStoreElement` (`:2361`); `rememberStore`
(`src/optimizing/backends/x64/lowering.ts:1309-1319`) is called from the equivalent selection
handlers. Both are the same eight lines with the same two early returns, and the second of
those returns is the subject of the next section.

There is a third caller, and it is not a compiled store at all.
`tera_array_reserve` swaps a grown element buffer into an array header, which *is* a
reference store, so it calls the barrier by hand:

```c
  *(int32_t *)(array + 12) = grown;
  tera_write_barrier(array, fresh);
  *(unsigned char **)(array + 16) = fresh;
  if (length > 0 && tera_classes[shape_id].tail != 0u && !tera_is_young(fresh)) {
    tera_remember(fresh);
  }
```
— generated `stats.c:512-516`

The last three lines are a second, subtler obligation. `memcpy` has just copied the old
buffer's contents into `fresh` without going through any barrier. If those contents are
references, and `fresh` came back from the allocator already old — which happens when a
collection during the allocation promoted it — then `fresh` is an old object full of
references that were never barriered. Remembering it outright is the fix. A runtime routine
that writes reference fields owes the same debt a compiled store does, and it has to pay it
by hand because no pass looked at it.

You can count the barrier in the running example's own output. `grep -c tera_write_barrier`
answers `12` for the C source: one definition, one call inside `tera_array_reserve`, and ten
compiled reference stores. One of the ten is `stats.tera`'s own constructor:

```c
  tera_str_set((tera_char *)(p0 + 8), 512, p1);
  tera_write_barrier(p0, p2);
  (*(unsigned char * *)(p0 + 1032)) = p2;
```
— generated `stats.c:1274-1276`

`p0` is the fresh `Series`, `p2` is the `float[]` it was handed, and offset 1032 is
`this.values` — the name field's 512 UTF-16 code units sit between them. The barrier fires,
looks, and returns immediately, because `p0` was allocated a few instructions ago and is
therefore young. That is the common case, and it is why the barrier's first line tests three
things and its second line is rarely reached.

## The barrier that fired on the program image

*Symptom.* Nothing, for weeks. No crash, no wrong answer, no failing test — occasionally an
object that should have been freed was not, or, much more rarely, one that should have lived
was collected, on programs long enough for a minor collection to happen at an unlucky moment.

*Mechanism.* `IR_STORE_FIELD` is not only used for stores into heap objects. It also carries
stores into `tera_context` — the coroutine machinery writing `queueHead`, for instance — and
stores into `tera_statics`, the block that holds module-level variables and static class
fields. Both of those reach memory through an `IR_RUNTIME_BASE` node naming a data symbol
([Ch 61 § roots-and-safepoints]). The first version of the barrier fired on them like any
other field store. So `target` was an address inside the program image — a static array in
BSS, not a heap block — and it went into the remembered set.

The next minor collection then read those bytes as a block header. It took a `shape_id` from
whatever happened to be at offset 0, indexed `tera_classes` with it, read a field count and a
list of offsets that described a class the address was not an instance of, and followed
"reference fields" that were arbitrary bytes.

*Why it hid.* A static array in BSS is surrounded by mapped, writable memory. A pointer
computed from garbage near it does not fault; it lands on something readable, is tested for a
mark bit, and either marks a block that should have been swept or is dismissed as already
marked. The failure mode of this bug is *retention* and occasional loss, both of which look
like ordinary collector behaviour until you are counting.

*Fix.* Two lines, one per backend — refuse the barrier when the store's target is a runtime
base:

```ts
    if (scalar !== SCALAR_POINTER) return;
    if (ctx.node.inputs[0]!.type === IR_RUNTIME_BASE) return;
```
— `src/optimizing/backends/x64/lowering.ts:1315-1316`, and the same pair at
`src/optimizing/backends/c/emit.ts:2301-2302`

It is sound because both of those regions are already scanned as roots on *every* collection,
minor and major alike: `tera_statics` through `tera_static_roots`
([Ch 61 § the-five-list-heads]), and `tera_context`'s five list heads by name. A region that
is unconditionally a root has no old→young problem, because there is no "old" version of it
to skip.

*Regression tests.* Two, one per region, both reading the emitted C for the **absence** of a
call: `tests/e2e/optimizing/aot/arena-collector.test.ts` >
`"leaves a store into static memory without a barrier"` slices `swap`'s body out and asserts
it contains `&tera_statics` and not `tera_write_barrier(`; and
`"leaves a store into the runtime context without a barrier"` compiles an `async` program and
checks the statement that assigns `tera_context.queue_head`. The second is chapter 63's data
structure appearing here as a test fixture, because the microtask queue is the runtime-context
store a real program actually produces.

*General rule.* A write barrier's guard is a statement about which **memory region** is being
written, not about which IR opcode is doing the writing. An opcode that can reach two regions
needs the region in its condition — and if the region is decided by the operand's node type,
that predicate belongs somewhere both backends can call.

> **Unenforced.** They cannot call it, because it does not exist. The region guard is written
> independently in `src/optimizing/backends/c/emit.ts:2302` and
> `src/optimizing/backends/x64/lowering.ts:1316`, and nothing checks that the two agree. The
> two regression tests above both compile with `backend: "c"`, so the x64 half of the guard is
> **[unpinned]** — the only x64 assertion in the suite is that a barrier appears *somewhere*
> in the output, which a wrongly-fired barrier also satisfies. Cost of enforcing: lift the
> predicate into one shared `remembersStore(node, scalar)` under `src/optimizing/analyses/`,
> roughly ten lines, and have both backends call it.

## `nurseryLimit` is one backend's heuristic

`nurseryLimit` is computed by both backends and read by exactly one of them.

Both compute it the same way, after every allocation and every collection:

```c
static void tera_nursery_reset(void) {
  size_t room = (8192u - tera_context.young_count) * 8u;
  size_t reach = tera_context.arena_cursor + room;
  tera_context.nursery_limit =
    reach < tera_context.arena_committed ? reach : tera_context.arena_committed;
}
```
— generated `stats.c:184-189`

Free young slots, times the header size, added to the cursor, clamped to the committed arena.
It is an *address* that stands in for a *count*: "if every remaining young slot were filled by
the smallest possible object, the cursor would get about this far."

The x64 backend inline-allocates. Rather than calling `tera_alloc` for an object whose size
and shape are known at compile time, `selectNewObject`
(`src/optimizing/backends/x64/lowering.ts:1196-1255`) emits the fast path directly into the
compiled function, and that fast path is the only reader of `nurseryLimit` in the program.
Here it is in the running example's own assembly, allocating one 24-byte object of shape 3
inside the prelude's `_fixed_text`:

```
	movq tera_context+8(%rip), %rax
	leaq 24(%rax), %rcx
	movsd %xmm0, %xmm6
	movl %edx, %ebx
	movl $24, %edx
	movl $3, %r8d
	cmpq tera_context+64(%rip), %rcx
	ja .L_fixed_text_0_alloc_0
	movq %rcx, tera_context+8(%rip)
	movq tera_context(%rip), %rsi
	addq %rax, %rsi
	movl $3, 0(%rsi)
	movl $24, 4(%rsi)
	movq tera_context+80(%rip), %rax
	movq tera_context+72(%rip), %rcx
	movq %rsi, 0(%rcx,%rax,8)
	incq %rax
	movq %rax, tera_context+80(%rip)
	jmp .L_fixed_text_0_alloc_0_join
.L_fixed_text_0_alloc_0:
```
— generated `stats.s:2389-2408`

Read it with [Ch 61 § one-file-two-implementations]'s displacement table in hand: `+8` is
`arenaCursor`, `+64` is `nurseryLimit`, `+72` is `youngBase`, `+80` is `youngCount`, and
`tera_context` with no displacement is `arenaBase`. Load the cursor, add 24, compare against
`nurseryLimit`, jump to the slow path if above; otherwise publish the cursor, form the object
address, stamp shape id 3 and size 24 into the header, and append to `youngBase[youngCount++]`
— `tera_note_young`, inlined. Note also that the three instructions between the `leaq` and the
`cmpq` are unrelated: the list scheduler of
[Ch 64](../part-10-bytes/64-machineir-and-instruction-selection.md) has filled the gap with
work that has nothing to do with allocating, and the `ja` is a fork inside a block whose real
terminator is somewhere else.

One compare covers two questions at once — is there arena room, and is there a young slot —
which is the point of expressing a slot count as an address.

`tera_alloc` itself never reads `nurseryLimit`. It bumps against `arenaCommitted` and guards
on the young **count**. That is not an oversight; it is a fixed bug. Bounding `tera_alloc` by
bytes broke a single allocation larger than the whole nursery, because `nurseryLimit` is
derived from free young *slots* times `CLASS_HEADER_BYTES` and says nothing whatever about how
large one object may be: a 4 KB array requested when `room` happened to be 200 bytes would be
refused by a limit that was never about it.

The invariant: **`nurseryLimit` is a heuristic for the inline path only, and the young count
is the truth.** The inline path may be wrong in the conservative direction — it falls through
to `tera_alloc`, which decides properly — and may never be wrong in the other.

## What was tried and rejected: the shape of the mark

The x64 *major* collector has no work stack. `markRoot` sets a mark bit and does not descend;
all the propagation is `markPass`, a full-arena rescan driven to a fixpoint by `collect`
([Ch 61 § marking]). That shape is far less assembly than a work stack plus overflow handling,
and it needs no extra global array.

Porting the same shape to the *minor* collector made it **1.3× slower**. The reason is
structural rather than incidental: a rescan pass costs one walk of the thing it is scanning,
and for the major collector that is the arena — which the sweep was going to walk anyway, and
which is walked once per full collection, which is rare. For the minor collector the thing
being scanned is the young list, and a minor collection is *frequent* by construction: it runs
every time 8192 objects have been allocated. Multiplying a frequent operation by a rescan
per propagation round is a different arithmetic entirely.

So `markYoung` (`src/optimizing/backends/x64/heap.ts:204-254`) is a real depth-first worklist
over `marksBase`, with an overflow counter returned in `rax`, and `markYoungPass` (`:301-334`)
survives only as the overflow path — the same relationship the C backend has between
`tera_mark` and `tera_mark_pending`. The two x64 collectors are deliberately not the same
algorithm.

> **Measured worse.** A fixpoint-rescan minor mark, in the shape x64's major `markPass` uses:
> 1.3× slower than the work-stack `markYoung`. Like the address-range nursery it is not in the
> tree, so this is a recorded measurement, not a reproducible one.

*General rule.* The right marking shape depends on what a pass iterates over and how often the
pass runs, not on which collector it belongs to. A rescan is a good trade when the pass is rare
and the set being rescanned is one you were going to walk anyway; it is a bad trade when the
pass is frequent and the set is small enough that a worklist fits.

## The numbers

Three regimes, side by side. Every caveat that [Conventions § 9](../CONVENTIONS.md) requires
applies and is stated rather than implied: **there is no benchmark harness in this tree**;
each figure was taken one case per fresh process; the program was allocation-heavy with a live
old set and is not in the repository; the C figures are through `gcc -O2`; and the middle row
cannot be reproduced at all because the implementation that produced it was deleted.

| Regime | C backend | x64 backend |
| --- | --- | --- |
| non-generational mark-sweep | 400 ms | 500 ms |
| address-range nursery | 630 ms | *not built* |
| explicit young list | 244 ms | 196 ms |

What the table supports: on that program, the explicit young list beat both the
non-generational collector it replaced and the address-range nursery that was tried first, and
the address-range nursery was worse than doing nothing generational at all.

What it does not support: anything about tera against another language, any other program's
allocation profile, any claim that 1.6× on C and 2.5× on x64 are representative, or any
comparison between the C and x64 columns — those are different code generators producing
different code for different machines and the two numbers were never intended to be read
against each other.

## riscv64 is excluded on purpose

`riscv64Target` declares two capabilities and no more:

```ts
    capabilities: capabilitySet("terminating-throw", "float-text"),
```
— `src/optimizing/backends/riscv64/target.ts:42`

No `generational-heap`. So `src/optimizing/backends/riscv64/heap.ts` has no `writeBarrier`, no
`markYoung`, no `sweepYoung` and no `minor` — it has the ten routines of the full collector, against x64’s fifteen,
and nothing else — and the riscv64 assembly for the running example contains the string
`tera_write_barrier` exactly zero times.

The reason is not that the port is hard. It is that riscv64 has no runner in this tree. Its
tests compare assembly text; nothing riscv64 emits has ever been executed, because
`McTarget.encode()` throws for every opcode
([Ch 72 § riscv-encode](../part-11-two-controls/72-two-controls-riscv-and-c.md)). A
generational collector there would be four hundred lines of machine IR that no test could run,
sitting on the correctness-critical path of every allocation. **An unexecutable collector is
worse than no collector**, because the full collector it would be replacing does work and is
exercised through the C backend.

> **Unfinished.** `src/optimizing/backends/riscv64/target.ts:42` declares no
> `generational-heap`, so riscv64 keeps only the full collector. Cost of finishing: port
> `markYoung`, `markYoungPass`, `sweepYoung`, `minor` and `writeBarrier` from
> `src/optimizing/backends/x64/heap.ts` into riscv machine IR — five routines, on the order of
> 450 lines of builder code — and, first, a riscv64 instruction encoder, because until one
> exists nothing written there can be run.

Now the part the outline of this chapter got wrong, and it is worth being precise about
because it is the difference between a mechanism and a label. It is tempting to say the
exclusion is *enforced by* the capability. It is not. `"generational-heap"` occurs in exactly
four places in the whole repository:

```
$ grep -rn "generational-heap" src/ tests/
src/optimizing/backends/c/target.ts:12:    "generational-heap",
src/optimizing/backends/x64/target.ts:79:      "generational-heap",
src/optimizing/target/capabilities.ts:9:  | "generational-heap"
tests/e2e/optimizing/aot/arena-collector.test.ts:347:        model.capabilities.has("generational-heap"),
```

The union that declares the name, two backends that claim it, and one e2e test. **No pass, no
analysis and no emitter reads it.** What actually decides whether a backend has a barrier is
whether somebody wrote one into that backend's `heap.ts` and its lowering. The capability is a
declaration *about* that fact, not a cause of it.

> **Unenforced.** The `generational-heap` capability is declared by two `capabilitySet(...)`
> calls and read by no pass, analysis or emitter. Its correspondence to `tera_write_barrier`
> is held only by
> `tests/e2e/optimizing/aot/arena-collector.test.ts` >
> `"emits the barrier from exactly the backends that declare a generational heap"`, so a
> backend could claim the capability without emitting a barrier and nothing in the compiler
> would object. This entry is already in
> [Appendix D](../appendix/d-inventory.md); this chapter confirms it rather than restating it.

The test is nonetheless the best available check, and it is worth reading closely, because it
is written the right way round: it compiles the same program for `c`, `x64-windows` and
`riscv64`, and asserts that the presence of the symbol in the output **equals**
`model.capabilities.has("generational-heap")` for that backend — not against a hard-coded list
of two. So adding the capability to riscv64 without porting the routines fails, and porting
the routines without adding the capability fails too. It catches the divergence in either
direction; it just catches it in the test suite rather than in the compiler.

> **Unfinished.** `TERA_YOUNG_CAPACITY` (8192 objects) and `TERA_REMEMBERED_CAPACITY` (2048
> objects) are compile-time constants with no flag, so the nursery is not tunable per program
> the way `--heap-size` tunes the arena ([Ch 61 § what-a-heap-is]). A program whose live young
> set exceeds 8192 objects promotes everything on its first minor collection and gets no
> generational benefit at all, silently and with nothing reported. Cost of finishing: thread
> both through `AotCompileOptions` beside `heapBytes`, and add a `--stats`-style line
> reporting minor-versus-major collection counts so the degenerate case is visible from
> outside.

## What leaves

The collector chapter 63 inherits has two entry points rather than one. `tera_collect` is
unchanged: mark from the shadow stack, the static roots and the five runtime list heads, then
sweep the whole arena and promote everything that survives. `tera_minor` marks only young
objects, starting from the same roots plus the remembered set, then sweeps the young list and
promotes what it keeps; `tera_alloc` calls it when the young list fills and falls back to
`tera_collect` only when a minor collection did not free enough. Every compiled reference store
into a non-runtime object goes through `tera_write_barrier` first. On C and x64 only —
riscv64 gets the full collector and nothing else.

The seam that matters next is in `markRoots`. The five runtime list heads —
`waitHead`, `sweepHead`, `queueHead`, `rejectedHead`, `rejectedText` — are marked by
`tera_minor` exactly as they are by `tera_collect` (generated `stats.c:398-402`), and the x64
implementation reaches both through the same `markRoots` with a `youngOnly` flag
(`src/optimizing/backends/x64/heap.ts:458-503`). That is not a detail. A promise whose waiter
frame has survived a collection and been promoted, holding a resolved value allocated one
instruction ago, is exactly the old→young edge this chapter built the barrier for — and the
frame itself is reachable from nothing but a `tera_context` list head.

[Ch 63 § the-three-lists](63-the-event-loop-and-a-rejection-nobody.md) picks the story up
there: what those five pointers actually are, how a compiled coroutine parks on one of them,
and what happens to a rejection that nobody ever awaited.

## Verify it yourself

```bash
# The capability split, visible as a count of one symbol in three outputs.
node dist/cli.js targets
node dist/cli.js compile docs/example/stats.tera --emit source --target c       -o /tmp/stats-c
node dist/cli.js compile docs/example/stats.tera --emit source --target x64     -o /tmp/stats-x64
node dist/cli.js compile docs/example/stats.tera --emit source --target riscv64 -o /tmp/stats-rv
grep -c tera_write_barrier /tmp/stats-c/stats.c /tmp/stats-x64/stats.s /tmp/stats-rv/stats.s
```

Answers `12`, `19`, `0`. Read the 12 carefully: one is the definition, one is the call inside
`tera_array_reserve`, and ten are compiled reference stores.

```bash
# The running example's own barrier: Series storing the float[] it was handed.
sed -n '1274,1276p' /tmp/stats-c/stats.c
```

```bash
# The one reader of nurseryLimit: the x64 inline allocation fast path.
grep -n "cmpq tera_context+64(%rip)" -A 2 /tmp/stats-x64/stats.s | head -12
```

`tera_context+64` is `nurseryLimit`; the `ja` goes to the prelude's own slow path label.

```bash
# The capability really is only four occurrences, none of them in a pass.
grep -rn "generational-heap" src/ tests/
```

```bash
# The generational suite. On a machine with no C toolchain and no PE runner,
# 5 of the 8 cases in the "generational collector" block run and 3 skip.
npx vitest run --project e2e tests/e2e/optimizing/aot/arena-collector.test.ts
```

No timing command is offered: § the-numbers is a recorded measurement and the two losing
implementations no longer exist.

## Tests that pin this

- The barrier fires where it must and nowhere else:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"takes the write barrier on a reference store and leaves a number store alone"`,
  `"leaves a purely numeric store without a barrier"`.
- The region-guard bug, one test per region:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"leaves a store into static memory without a barrier"`,
  `"leaves a store into the runtime context without a barrier"`.
  Both compile with the C backend only; the x64 region guard is **[unpinned]**.
- The capability corresponds to the code, checked in both directions:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"emits the barrier from exactly the backends that declare a generational heap"`.
- Old→young survival across a whole nursery, run as a real program on two backends:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"keeps a young object stored into a promoted one alive"` — the title appears twice, once
  under `itNative` through a C toolchain and once under `itRunsPe` as a self-linked PE binary.
  Its `REPLACES` program replaces an old object's field with a fresh `Cell` and then churns
  `TERA_YOUNG_CAPACITY * 2` allocations past it, so the count crosses a nursery boundary even
  if the capacity constant changes.
- Promotion actually happening rather than repeated sweeping:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"promotes a survivor instead of sweeping it on the next nursery"`.
- The major collector still working underneath all of it:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"keeps allocating past the size of the arena"`,
  `"keeps a graph reachable only through a field alive across collections"`,
  `"still reclaims when the roots live in a class the program keeps"`.
- The flag bits' arithmetic — that the three flags fit under the alignment and that
  `tera_block_size`'s mask is the right one: **[unpinned]**. Nothing asserts
  `TERA_BLOCK_FLAGS < CLASS_ALIGNMENT_BYTES`; the relationship is currently only true by
  inspection.
- The measurements in § the-numbers: **[unpinned]**, and unreproducible. There is no benchmark
  harness in this tree and both losing implementations were deleted.
