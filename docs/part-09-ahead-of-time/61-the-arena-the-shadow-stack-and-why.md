# 61. The arena, the shadow stack, and why nothing moves   ⟨– · – · – · N⟩

A compiled tera program has no runtime underneath it. There is no VM holding a heap on its
behalf, no `ValueHeap` side table, no interpreter that can be asked what a machine word
means. When the program wants sixteen bytes it takes them from a region it reserved from the
operating system itself, and when that region fills, the program collects its own garbage,
in code the compiler wrote into it. This chapter is about that region, about how the
collector finds the live references, and about the one property of the answer that closes off
half the designs in the garbage-collection literature.

The property is small and it is easy to miss. Every function that holds a heap reference
stores a copy of it into an array — the *shadow stack* — so that a collection running deep
inside a callee can enumerate every reference the program can still reach. That array looks
exactly like the handle table a moving collector needs. It is not one. Its slots are
*mirrors*: the pointer also lives in a register or a C local, and every use reads that copy,
never the slot. A collector that moved an object would have to rewrite both, and it can only
reach one. So nothing in a compiled tera program ever moves, and no amount of work on the
collector will change that without changing every backend's code generator first.

The second thing worth saying up front is that the collector exists twice. One version is C
source text that a system compiler will compile; the other is x64 machine IR that this
compiler will assemble; a third, for riscv64, is a third hand-written copy. They agree about
where `tera_context.rootCount` lives because a single file computes that offset and all three
read it. They do not agree about much else, and this chapter says where they diverge, because
"one layout, three implementations" is a much narrower claim than "one collector".

**What arrived.** From [Ch 60 § what-the-prelude-hands-on](60-a-runtime-written-in-its-own-language.md): a
single entry module whose AST carries, beside the user's own declarations, every generated
prelude class and function the program demanded — `_FixedDigits`, `_FixedText`, `_m_exp`,
`Error` — with every call site already rewritten to name them. Chapter 61 receives that as
ordinary user code, and it is the reason the running example touches an allocator at all.
`docs/example/stats.tera` is five floats and two `Series` objects; on its own it would never
need a heap. But `.to_fixed(2)` pulls in `_FixedDigits`, whose `cells` field is an `int[]`
that `push`es inside a `while` loop, and `_FixedText`, whose `text` field is rebuilt on every
digit. Those allocate.

The collector actually *collecting* is out of the running example's reach. Five floats and a
handful of prelude objects will not fill a one-gigabyte arena, and no variation file is going
to. Per [Conventions § 2](../CONVENTIONS.md), this chapter says so rather than contriving a
ninth example: the sections that need a heap under pressure read the allocation-heavy programs
in `tests/e2e/optimizing/aot/arena-collector.test.ts`, whose round counts are computed from
`TERA_HEAP_COMMIT_BYTES` so that they still overflow the arena if the constant changes.
Everything else in this chapter — the block header, the root frames, the mirror, the free
list, the three-implementation split — is read out of the C the running example itself
compiles to.

## What a heap is

> **New idea.** A *heap* is not "RAM". It is a data structure: a contiguous region of address
> space, plus a set of rules for handing out pieces of it and taking them back. Every
> language you have used has one, usually inherited from the C library's `malloc` and hidden
> from you. A compiled tera program does not inherit one. It builds its own, out of one
> request to the operating system, and it is the only thing in the program that ever asks the
> operating system for memory at all.

The whole arena is three numbers in `tera_context` and one call to the OS. `arenaBase` is
where the region starts; `arenaCursor` is how far into it the program has allocated;
`arenaCommitted` is how much of it is actually backed by physical pages. A fourth,
`arenaReserved`, is how much address space was asked for. Keeping those four apart is most of
the work of reading this chapter — three of them are byte counts and one is a pointer, and
two of the three counts move for entirely different reasons.

The sizes are constants in one file:

```ts
export const TERA_HEAP_RESERVE_BYTES = 1 << 30;
export const TERA_HEAP_COMMIT_BYTES = 1 << 20;
export const TERA_HEAP_MINIMUM_BYTES = 1 << 16;
```
— `src/optimizing/target/runtime-layout.ts:112-114`

One gigabyte reserved, one megabyte committed at startup, and a floor of 64 KB that
`--heap-size` may not go below. `--heap-size` is the one user-facing control:
`src/cli/spec.ts:390-395` parses it with `TERA_HEAP_MINIMUM_BYTES` as its lower bound, and
what reaches the emitted C is a `#define` at the very top of the file, ahead of the default
the backend would otherwise use:

```
$ node dist/cli.js compile docs/example/stats.tera --emit source --target c \
    --heap-size 64m -o /tmp/stats-64m
$ grep -n "define TERA_HEAP_RESERVE" /tmp/stats-64m/stats.c
3:#define TERA_HEAP_RESERVE 67108864
23:#define TERA_HEAP_RESERVE 1073741824
```

Line 23 is the backend's own `#ifndef` fallback. Line 3 is the flag winning. On the machine
backends there is no preprocessor, so the number is written straight into the `tera_context`
image instead — `contextDatum` (`src/optimizing/machine/heap-data.ts:85-99`) emits zeros for
every field except `arenaReserved`, which it fills with the requested reservation.

None of the four other capacities is adjustable. `TERA_ROOT_CAPACITY` (16384),
`TERA_MARK_CAPACITY` (4096), `TERA_YOUNG_CAPACITY` (8192) and `TERA_REMEMBERED_CAPACITY`
(2048) are compile-time constants with no flag.

> **Unfinished.** The four array capacities in `runtime-layout.ts:106-109` are not
> reachable from the command line, while the arena they sit beside is. A deeply recursive
> program exhausts `TERA_ROOT_CAPACITY` in `tera_enter_roots` and exits with
> `TERA_EXIT_HEAP_EXHAUSTED` — exit code 70, from `src/optimizing/target/faults.ts:1` — which
> is the same code and the same silence the allocator produces when the *arena* is full. The
> two failures are not distinguishable from outside the process. Cost of finishing: thread
> the four capacities through `AotCompileOptions` the way `heapBytes` already is, and give the
> root overflow its own exit code and its own sentence.

## One file, two implementations

Here is the problem before the solution. `tera_context.rootCount` is read by C source that
`gcc` or `clang` will compile, and by x64 machine IR that this compiler will assemble into
bytes itself. The C compiler picks the offset by laying out a struct. The x64 lowering picks
it by writing a displacement into a `movq`. If those two disagree by eight bytes, the program
is not slower or noisier — it is silently wrong, in a way that shows up as a corrupted heap
several thousand allocations later.

Nothing in the toolchain would catch it, because the two paths never meet. So the offsets are
not written down twice. They are computed once, from an ordered list of field names and
widths:

```ts
  for (const spec of specs) {
    const count = spec.count ?? 1;
    const offset = alignUp(cursor, spec.bytes);
    const field: RuntimeField<Name> = {
      name: spec.name,
      bytes: spec.bytes,
      count,
      offset,
      size: spec.bytes * count,
      ownership: spec.ownership ?? "shared",
    };
    if (byName.has(spec.name)) throw new Error(`${symbol} declares ${spec.name} twice`);
    byName.set(spec.name, field);
    fields.push(field);
    cursor = offset + field.size;
    alignment = Math.max(alignment, spec.bytes);
  }
```
— `src/optimizing/target/runtime-layout.ts:60-76`

`declareRecord` walks the specs in order, aligns each field naturally, and derives `bytes` and
`alignment` from what it found rather than from a written-down number. A duplicate name throws
at module load, before any compile can start. `field(name)` throws on a name that is not
there, so a typo in a backend is a crash, not a wrong displacement.

The record it builds — `TERA_CONTEXT`, `runtime-layout.ts:119-148` — has twenty-eight fields,
from `arenaBase` to `pendingThrowValue`. The two readers sit in different worlds and take the
same answer out of it. The C backend asks for a name:

```ts
export function cContextField(name: TeraContextField): string {
  return `${TERA_CONTEXT.symbol}.${cFieldName(name)}`;
}
```
— `src/optimizing/backends/c/emit.ts:1305-1307`

The x64 backend asks for a memory operand:

```ts
export function contextField(name: TeraContextField) {
  const field = TERA_CONTEXT.field(name);
  return mem(field.bytes, {
    symbol: TERA_CONTEXT.symbol,
    displacement: field.offset,
  });
}
```
— `src/optimizing/backends/x64/heap.ts:82-88`

`cContextField("rootCount")` produces the text `tera_context.root_count`; `contextField("rootCount")`
produces a `MemoryOperand` at displacement 48. You can see the second one in the emitted
assembly for the running example — `movq tera_context+48(%rip), %r10`, the first instruction
of `tera_enter_roots` — and you can see the first in the emitted C, where the system compiler
will independently compute the same 48 because `cContextType` builds the struct by iterating
`TERA_CONTEXT.fields` in declaration order and refuses to emit a field it has no C type for.

That last refusal is the enforcement, and it is stronger than it looks: adding a field to
`TERA_CONTEXT` without adding a row to `C_CONTEXT_TYPES` (`emit.ts:1270-1298`) throws
`the C backend has no type for tera_context.<name>` at emit time rather than producing a
struct whose layout has quietly diverged. The invariant is *both readers derive their offset
from one ordered declaration*; the enforcement is a computed table with a single writer plus
that throw; and the test is
`tests/optimizing/target/runtime-layout.test.ts` >
`"declares the same context fields in the C backend, in the same order"`, which slices the C
struct out of the emitted preamble and compares the field list against `TERA_CONTEXT.fields`
element by element.

The sharing does not extend as far as it first appears, and the chapter would be dishonest to
imply that it does. `TERA_CLASS_RECORD` (`runtime-layout.ts:201-206`) declares the collector's
per-shape record as four `u32`s — `tailReferences`, `fieldStart`, `fieldCount`, `reserved`,
sixteen bytes — and `classData` (`src/optimizing/machine/heap-data.ts:45-83`) renders it by
iterating `TERA_CLASS_RECORD.fields` rather than in a hand-written order, so the x64 and
riscv64 backends emit exactly that. The C backend does not. It emits its own struct, because a
C compiler can hold a real pointer where the machine backends have to hold an index:

```c
typedef struct {
  uint32_t tail;
  uint32_t fields;
  const uint32_t *offsets;
} tera_class;
```
— generated `stats.c:114-118`

Three members, not four; a pointer to a per-shape offset array, not a start index into one
flat table. The two shapes carry the same information and neither reads the other's bytes, so
nothing is wrong — but *class layout* is a place where the two implementations are equivalent
by construction rather than identical by derivation, and only the context record is shared
field-for-field.

## The block header

Every block in the arena, live or dead, begins with the same eight bytes. The offsets come
from `src/optimizing/metadata/class-table.ts:50-53`.

```
        0               4               8
        +---------------+---------------+----------------------------+
 live   | shape id  u32 | flags     u32 | fields, in layout order    |
        +---------------+---------------+----------------------------+

        0               4               8              16
        +---------------+---------------+--------------+-------------+
 free   | 0             | size in bytes | next free    | ...         |
        +---------------+---------------+--------------+-------------+
```

[Ch 57 § eight-bytes-and-three-spare-bits](57-objects-without-a-runtime-type.md) laid that
header out and taught the trick of stealing tag bits from an aligned value. Two overloads of
it make the collector work, and both are worth stating plainly because
everything downstream depends on them.

The first: **shape id 0 means "this block is free"**. `TERA_FREE_SHAPE_ID = 0`
(`runtime-layout.ts:253`), and the class table's row 0 is a permanent zero row — you can see
it as the first `{ 0, 0, 0 }` in the generated `tera_classes[]` — so no real class ever gets
id 0. A single `u32` load answers "is this a hole?" with no side table.

The second: **in a free block the flags word holds the block's size in bytes**, not flags. In
a live block the same word holds the block's size *with* the flag bits or-ed into its low
three bits, which is why one routine can read the size of either:

```c
static uint32_t tera_block_size(const unsigned char *block) {
  return *(const uint32_t *)(block + 4) & ~(uint32_t)7u;
}
```
— generated `stats.c:180-182`

That mask is `TERA_BLOCK_FLAGS`, and the reason it is legal is `CLASS_ALIGNMENT_BYTES = 8`.
Every block is rounded up to an eight-byte boundary, so every block's size has its bottom
three bits clear, so those three bits are free to hold something else. Today they hold
`TERA_MARK_FLAG = 1`, `TERA_OLD_FLAG = 2` and `TERA_REMEMBERED_FLAG = 4`
(`runtime-layout.ts:254-256`). This chapter spends the first. Chapter 62 spends the other two.

The last eight bytes of the free-block layout are the free list itself: `TERA_LINK_BYTES = 8`
at offset `CLASS_HEADER_BYTES`, so `FREE_BLOCK_BYTES = 16` (`class-table.ts:79`) is the
smallest hole that can carry a next-pointer and therefore the smallest hole that can join the
list at all. A smaller one is simply abandoned.

## Reserve, then commit

> **New idea.** *Address space* and *memory* are two different resources. Reserving address
> space claims a range of addresses and promises nobody else will get them; it costs almost
> nothing and touches no physical pages. Committing memory backs a range with pages the
> operating system must actually find. A program that reserves a gigabyte and commits a
> megabyte has a gigabyte-wide address range and a megabyte of real cost.

That distinction is why `tera_reserve` and `tera_grow` are separate routines. The reservation
happens once, lazily, on the first allocation, and it is the only place either backend calls
into the operating system for memory:

```c
static void tera_reserve(void) {
  unsigned char *base = tera_map(tera_context.arena_reserved);
  if (base == 0) exit(70);
  size_t first = 1048576 < tera_context.arena_reserved
    ? 1048576
    : tera_context.arena_reserved;
  if (tera_commit(base, first) == 0) exit(70);
  tera_context.arena_base = base;
  tera_context.arena_committed = first;
  tera_nursery_reset();
}
```
— generated `stats.c:417-427`

`tera_map` is `VirtualAlloc(…, MEM_RESERVE, PAGE_READWRITE)` on Windows and
`mmap(…, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, …)` elsewhere; `tera_commit` is
`VirtualAlloc(…, MEM_COMMIT, …)` and `mprotect(…, PROT_READ | PROT_WRITE)`
(`src/optimizing/backends/c/emit.ts:315-331`). Both spellings are the same two-step idea in
two vocabularies: claim the range with no access, then grant access to a prefix of it.

`tera_grow` doubles `arenaCommitted`, clamps to `arenaReserved`, and commits — generated
`stats.c:429-439`. It never re-maps and never relocates. That is not an oversight to be
tidied up later; it is a hard consequence of the next few sections. A program whose heap could
be relocated would have to rewrite every pointer into it, and this program cannot rewrite any
pointer into it at all. Reserving a gigabyte up front is how a non-moving collector buys
itself room to grow: the addresses were always ours, so nothing that already points into the
arena is disturbed when more of it becomes real.

## Allocation in three steps

`tera_alloc` is the same routine written three times. The C version reads like this:

```c
static unsigned char *tera_alloc(size_t size, int32_t shape_id) {
  if (tera_context.arena_base == 0) tera_reserve();
  if (tera_context.young_count == 8192u) tera_minor();
  unsigned char *object = tera_bump(size);
  if (object == 0) object = tera_take(size);
  if (object == 0 && tera_context.young_count > 0) {
    tera_minor();
    object = tera_bump(size);
    if (object == 0) object = tera_take(size);
  }
  if (object == 0) {
    tera_collect();
    object = tera_bump(size);
    if (object == 0) object = tera_take(size);
  }
  if (object == 0 && tera_grow(size) != 0) object = tera_bump(size);
  if (object == 0) exit(70);
```
— generated `stats.c:473-491`

Strip the generational parts, which belong to [Ch 62], and the shape is: **bump, then take,
then collect and retry, then grow, then give up**.

*Bump* is the fast path. `tera_bump` (`stats.c:441-446`) adds `size` to `arenaCursor` if that
still fits inside `arenaCommitted`, and answers the old cursor. That is two loads, an add, a
compare and a store, and it is what almost every allocation in a young program does.

*Take* is the free list. `tera_take` (`stats.c:448-471`) walks a singly-linked list threaded
through the free blocks themselves — the link lives at offset 8, inside the hole — and returns
the first block big enough.

> **New idea.** *First fit* means taking the first hole large enough rather than searching for
> the smallest one that fits. It is the cheapest policy to implement and the one most likely
> to leave the arena in a state where the total free space is ample but no single hole is
> large enough for the next request. That state is called *external fragmentation*, and a
> moving collector's usual answer to it is to slide the survivors together. This collector
> cannot do that.

What tera does instead is split and coalesce. When `tera_take` finds a block strictly larger
than the request, it carves the request off the front and puts the remainder back on the list
as a fresh free block — but only if the remainder is at least `FREE_BLOCK_BYTES`, because a
smaller remainder has nowhere to keep the link. And when the sweep finds a run of consecutive
dead blocks it releases them as one, which is the only mechanism in the program that makes
big holes out of small ones.

State honestly what is not here: there are no size classes, no segregated free lists, no best
fit, no address-ordered list, no splay tree. There is one singly-linked list in no particular
order, walked from the head. Whether that is adequate is not measured — there is no benchmark
harness in this tree — and the only claim the tests make is that a program allocating four
times the committed arena still answers correctly
[t: `tests/e2e/optimizing/aot/arena-collector.test.ts` > `"keeps allocating past the size of the arena"`].

## Roots and safepoints

> **New idea.** A *root* is a reference the collector must treat as live without being told
> so by another object — the starting points of the reachability walk. In a compiled program
> the roots are, essentially, "every reference in every live stack frame", plus whatever the
> runtime itself is holding. A *safepoint* is a point in the program where a collection is
> allowed to run, because the machine state there is describable. In tera, every call that can
> allocate is a safepoint, and every call that can allocate can therefore collect — which
> means `tera_array_reserve` in the middle of a `push` is a safepoint, and so is the
> constructor call one line into a loop body.

The hard part is not the walk. The hard part is that at a safepoint the compiler must be able
to answer, from the emitted program alone, "which machine words right now hold references?"
There are three ways to answer that, and the choice among them determines the shape of
everything else.

*Conservative scanning* reads the raw machine stack and treats any word that looks like it
could be a heap pointer as one. It requires no compiler support at all. It also retains
garbage that happens to be pointed at by an integer, and — decisively — it makes moving an
object impossible, because you cannot safely rewrite a word you are only guessing about.

*Stack maps* are what a production runtime uses. The compiler emits a side table saying, for
each call site, which frame slots and which registers hold references at that instruction.
The collector walks the machine frames, looks each return address up in the table, and reads
exactly the right words. It is precise, it costs nothing at run time when no collection is
happening, and it supports moving, because the collector knows every slot that names an object
and can rewrite all of them.

*A shadow stack* is the program maintaining an explicit array of live references by hand. On
every definition of a reference, a store. On function entry, a frame; on exit, a pop. The
collector walks that array and never looks at a machine frame at all.

tera uses the third.

## Why not stack maps

*(Why the obvious design fails.)*

Stack maps are strictly better than a shadow stack for the two native backends. They cost no
stores in the mutator, they retain nothing extra, and they are the precondition for every
moving collector in the literature. If the native x64 backend were the only backend, this
chapter would be about stack maps.

It is not, and the backend that rules them out is the portable one. `cBackend` emits **C
source**. A system compiler — whichever one the user happens to have — allocates its
registers, chooses its frame layout, decides whether `unsigned char *v27` lives in `%rbx` or
at `-40(%rbp)` or nowhere at all because it was rematerialized. Nothing in the emitted program
can know that, and nothing in the emitted program can walk its own frames to find out. A stack
map for the C backend would have to be produced by a compiler tera does not control and cannot
inspect.

The alternative was two mechanisms: stack maps for x64 and riscv64, a shadow stack for C. That
means two collectors, two root protocols, two sets of bugs, and — because the e2e suite treats
the C binary and the native binary as answering the same program — two chances for them to
disagree about liveness. One mechanism for three backends beats two mechanisms for two. The
shadow stack wins by portability, not by merit.

Name the cost in the same breath. A shadow stack pays a store on every rooted definition, on
the mutator's path, whether or not a collection ever happens. And a root, once stored, lives
for the whole activation: nothing clears a slot when the value stops being used, so the
collector retains objects that a stack-map collector would have let die. That over-retains. It
is never *wrong* — retaining too much is a memory cost, not a correctness bug — and the free
slots are zeroed on frame entry, so a stale pointer from a previous call can never be read as
live. The trade is: some retention and some stores, in exchange for one implementation that
works everywhere.

## The root frame

The protocol has four steps, and they must happen in this order.

1. Read `rootCount` into a local — the *base* of this function's frame.
2. Check that `base + N` fits in `TERA_ROOT_CAPACITY`, or exit.
3. Publish `rootCount = base + N`.
4. **Zero** the N new slots.

Step 4 is not tidiness. Between step 3 and the first real store, the program may call
something that allocates, which may collect, which will walk `rootsBase[0 .. rootCount)` —
and that range now includes N slots that were last written by some unrelated function that has
long since returned. If they are not zeroed, the collector marks from stale pointers into
blocks that may since have been freed and reused.

Here is the whole thing for `report`, the running example's one free function, straight out of
the emitted C:

```c
const tera_char * report(unsigned char *p0) {
  const size_t roots = tera_context.root_count;
  if (roots + 1 > 16384) exit(70);
  tera_context.root_count = roots + 1;
  for (size_t at = roots; at < tera_context.root_count; at++) tera_context.roots_base[at] = 0;
  tera_context.roots_base[roots + 0] = (unsigned char *)p0;
  const tera_char *v0 = Series_label(p0);
  tera_context.root_count = roots;
  return v0;
}
```
— generated `stats.c:1226-1235`

Four lines of prologue, one store for the one rooted value (the `Series` parameter), the call,
and the restore before the return. `CEmitter.rootFrame` (`src/optimizing/backends/c/emit.ts:2526-2540`)
emits the first four; `rootStore` (`:1939-1943`) emits the fifth; `emitReturn` (`:2429-2430`)
emits `tera_context.root_count = roots;` ahead of every `return`.

The same protocol on x64 is a call to a shared routine, because writing four instructions into
every prologue would be larger than calling one. `tera_enter_roots` takes the slot count in
`r11` (`ROOT_COUNT_REGISTER`) and hands back the *address* of the frame's first slot in `r10`
(`ROOT_FRAME_REGISTER`):

```
tera_enter_roots:
.Ltera_enter_roots_entry:
	movq tera_context+48(%rip), %r10
	movq %r10, %rax
	addq %r11, %rax
	cmpq $16384, %rax
	ja .Ltera_enter_roots_overflow
	movq %rax, tera_context+48(%rip)
	movq %r10, %rax
	leaq tera_roots(%rip), %r10
	leaq 0(%r10,%rax,8), %r10
	xorl %eax, %eax
.Ltera_enter_roots_zero:
	cmpq %r11, %rax
	jae .Ltera_enter_roots_done
	movq $0, 0(%r10,%rax,8)
	incq %rax
	jmp .Ltera_enter_roots_zero
.Ltera_enter_roots_done:
	ret
```
— generated `stats.s:4-23`

The same four steps: read (`tera_context+48` is `rootCount`), bound-check against 16384, publish,
zero. The scaled-index addressing `0(%r10,%rax,8)` is the derived shift `TERA_ROOT_SLOT_SHIFT`
earning its keep — it is `log2(TERA_ROOTS.bytes)`, so there is no second constant to keep in
step with the array's element width.

The epilogue reverses it by arithmetic rather than by remembering the count: `leaveRoots`
(`src/optimizing/backends/x64/lowering.ts:515-529`) reloads the saved frame address, subtracts
`rootsBase`, shifts right by `ROOT_SLOT_SHIFT`, and stores that back into `rootCount`. And
unlike the C path, it is not hand-placed: `insertFrameCode`
(`src/optimizing/machine/frame-code.ts:16-30`) inserts the epilogue in front of *every*
instruction flagged `returns`, in every block, mechanically.

> **Unenforced.** Nothing verifies the root-frame protocol after it is emitted.
> `validateMachineFunction` (`src/optimizing/machine/verifier.ts:192-209`) runs four checks per
> call — block links, operand validity, tied form, and then either no-surviving-virtuals or
> reaching-definitions depending on the stage — and none of them is about roots; it has no
> rule pairing a `tera_enter_roots` call with the
> epilogue store, and no rule that the `N` the prologue publishes equals the number of slots
> the body writes. The C output is text and is never parsed. `emitRoot`
> (`src/optimizing/machine/select.ts:141-158`) returns silently when the value has no slot, no
> frame or no register, so a dropped store is indistinguishable from a value that was never
> rooted. A function that leaked root slots would report as `TERA_EXIT_HEAP_EXHAUSTED` from
> some unrelated later call. Cost of enforcing: a machine-IR verifier rule pairing the
> `tera_enter_roots` call with the epilogue restore and comparing the published count against
> `fn.roots`, roughly twenty lines, plus the equivalent assertion in `CEmitter`.

## One slot, one value

Which values get slots is decided by three lines and a `Map`:

```ts
export function isRootedPointer(legality: AotLegality, value: CFGInstruction): boolean {
  if (value.type === IR_RUNTIME_BASE) return false;
  if (value.uses.length === 0) return false;
  return legality.scalarOf(value) === SCALAR_POINTER;
}

export function rootSlotsOf(
  legality: AotLegality,
  values: Iterable<CFGInstruction>,
): Map<CFGInstruction, number> {
  const slots = new Map<CFGInstruction, number>();
  for (const value of values) {
    if (!isRootedPointer(legality, value) || slots.has(value)) continue;
    slots.set(value, slots.size);
  }
  return slots;
}
```
— `src/optimizing/analyses/aot-legality.ts:846-862`

Everything whose `AotScalar` is `SCALAR_POINTER` is rooted, with two exclusions. A value with
no uses is dead and cannot be read again. And `IR_RUNTIME_BASE` — the node that materialises
the address of a runtime data symbol like `tera_statics` — is excluded because it does not
point into the arena at all; it names static memory, which is never swept. Slots are numbered
by iteration order, and `slots.size` is both the next index and the running count.

The invariant is that **within one function, each slot index belongs to exactly one value**.
The enforcement is the `slots.has(value)` guard on line 858. That guard is a fix, and the bug
it fixes is worth telling, because the mechanism is a piece of JavaScript semantics rather
than a piece of compiler theory.

*Symptom.* A loop that carried a reference across its back edge produced a binary that read
freed memory — but only once the arena filled, so only in long runs, and only under the
allocation-heavy tests. Eight rooted values in one function shared six slots.

*Mechanism.* Both callers of `rootSlotsOf` iterate blocks as `[...block.phis, ...block.nodes]`.
And `addPhi` puts the new phi in **both** lists:

```ts
  const phi = new CFGInstruction(IR_PHI, { index: block.phis.length });
  for (const input of inputs) phi.addInput(input);
  phi.block = block;
  block.phis.push(phi);
  block.nodes.splice(block.phis.length - 1, 0, phi);
```
— `src/optimizing/ir/cfg-edit.ts:95-99`

So every phi is visited twice. Without the guard, the second visit called `slots.set` on a key
that was already present — which overwrites the phi's index with a later one, *and does not
grow the map*, because `Map.set` on an existing key leaves `size` alone. The next distinct
value then received that same `slots.size` as its index. Two live references, one slot,
whichever wrote last winning; the other object was unrooted while the program was still going
to read it.

*Fix.* `|| slots.has(value)` — skip a value already numbered. The double-visit shape is still
there in both callers (`select.ts:129-131` and `emit.ts:1976-1980`) and is deliberately left
alone: the guard is the right place for the fix, because it makes the function correct for
*any* iteration order rather than making one caller's order careful.

*Regression test.* `tests/e2e/optimizing/aot/arena-collector.test.ts` >
`"gives a loop-carried reference a root slot of its own"` compiles a loop that keeps the
previous `Cell` while making a new one, slices `walk`'s body out of the emitted C, collects
every `roots_base[roots + N] = (unsigned char *)name;` into a map from slot to the set of names
written there, and asserts that no slot has more than one name.

*General rule.* When a value can be reached twice by an enumeration, the deduplication belongs
at the point where identity is decided, not at each call site — and a `Map` whose values are
derived from its own `size` is a data structure that fails silently on a repeated key, because
the repeated write is a no-op in the one dimension you are reading.

You can run the same check over the running example, over every function at once:

```
$ awk '/\) \{$/ { fn = $0 } /roots_base\[roots \+ /{ match($0, /roots \+ [0-9]+/); \
    print fn " |" substr($0, RSTART, RLENGTH) }' /tmp/stats-c/stats.c \
    | sort | uniq -c | awk '{print $1}' | sort | uniq -c
     83 1
```

Eighty-three root stores across the whole compiled program, and every one of them is the only
store to its (function, slot) pair. Note the grouping by function: the naive check — `grep -o`
over the whole file — is meaningless, because slot 0 is written nineteen times, once by each of
nineteen different functions that each have exactly one rooted value.

## Nothing moves

> **New idea.** A *handle* is a slot that is the only way to reach an object: every use of the
> object goes through `*handle`, so a collector is free to move the object and rewrite the
> slot, and every reader picks up the new address for free. A *mirror* is a slot that holds a
> copy: the value also lives in a register or a local, and every use reads *that*. Rewriting a
> mirror moves nothing. It only makes the two copies disagree.
>
> The tera glossary fixes this deliberately: an AOT root slot is **not** a handle, even though
> a handle in the JIT is also a slot holding a pointer. See
> [Glossary § the words that mean two things](../GLOSSARY.md).

tera's root slots are mirrors, and you can see it in six lines of the running example's own
output. This is `_FixedDigits.put`, which does `this.cells.push(0)` inside a `while`:

```c
  unsigned char *v27 = (*(unsigned char * *)(p0 + 8));
  tera_context.roots_base[roots + 4] = (unsigned char *)v27;
  unsigned char *v28 = tera_array_reserve(v27, 7, 4);
  tera_context.roots_base[roots + 5] = (unsigned char *)v28;
  const int32_t v29 = (*(int32_t *)(v27 + 8));
  ((int32_t *)(v28 + 8))[v29] = v0;
  const int32_t v31 = tera_i32_add(v29, v4);
  (*(int32_t *)(v27 + 8)) = v31;
```
— generated `stats.c:1503-1510`

`v27` is the array header, loaded out of the object's field and rooted at slot 4.
`tera_array_reserve` may allocate a bigger element buffer, and allocating can collect, so line
3 is a safepoint. The *object* survives it, because slot 4 names it. Then line 5 reads `v27` —
the C local, not the slot — and line 8 writes through `v27` again. If the collector had moved
that object, slot 4 would hold the new address and `v27` would hold the old one, and the
program would read and write a corpse. Nothing reloads from the slot, on any path, anywhere in
any of the three backends.

This is the chapter's whole payload, and it is produced by a twenty-four-line program.

The trap is that `isRootedPointer` roots *every* `SCALAR_POINTER` value, so the shadow stack
genuinely does enumerate every live reference the program can reach. That is the hard half of
what a moving collector needs, and having it makes the design look one small step away from
compaction. It is not. What is missing is the other half — that every *use* reads through the
slot — and supplying it means:

- in the C emitter, every pointer use becomes `tera_context.roots_base[roots + N]` instead of
  a local, and the C compiler is handed a program whose every reference is an aliased memory
  operand it may not keep in a register across a call;
- in the x64 and riscv64 lowerings, every live pointer register must be reloaded from its slot
  after every call, which is precisely the constraint the register allocator of [Ch 66] exists
  to avoid, applied to the one class of values it matters most for;
- three backends change, not one, and the shadow-stack store that was the design's only cost
  becomes a store *and* a reload per reference per safepoint.

So the judgement is not "moving is hard" — it is that a moving collector would cost every
pointer use in the program a memory operand, in three code generators, to buy compaction for a
fragmentation problem that has not been measured. Written down that way it is an engineering
decision with a price, not an excuse.

And not moving pays for two things that other chapters already spent. An interior `char *`
into an object's inline text stays valid for as long as the object does
([Ch 59 § storage-an-object-owns-privately](59-strings-without-a-runtime-tag.md)) — a moving collector would
have to find and fix every interior pointer, which is strictly harder than fixing object
pointers. And a reference cached in a callee-saved register survives a collection untouched,
which is why the root store can be write-only.

## Marking

> **New idea.** *Tri-colour marking*, informally: every block is white (not yet reached), grey
> (reached, but its children not yet examined) or black (reached, children examined). Start by
> greying the roots; repeatedly take a grey block, examine its children, grey any white ones,
> and blacken it. When no grey blocks remain, every white block is unreachable. tera keeps the
> colour in one bit — `TERA_MARK_FLAG` says black-or-grey — and keeps "grey" as membership in
> a work list, which is where the two implementations diverge.

The C version keeps an explicit work stack in `tera_marks`, 4096 entries:

```c
static int32_t tera_mark(unsigned char *object) {
  size_t top = 0;
  int32_t overflowed = 0;
  if (object != 0) tera_context.marks_base[top++] = object;
  while (top > 0) {
    unsigned char *block = tera_context.marks_base[--top];
    uint32_t *flags = (uint32_t *)(block + 4);
    if ((*flags & 1u) != 0u) continue;
    *flags |= 1u;
    uint32_t references = tera_reference_count(block);
    for (uint32_t at = 0; at < references; at++) {
      unsigned char *field = tera_reference_at(block, at);
      if (field == 0) continue;
      if (top == 4096) overflowed = 1;
      else tera_context.marks_base[top++] = field;
    }
  }
  return overflowed;
}
```
— generated `stats.c:225-244`

A depth-first walk with an explicit stack rather than recursion — a recursive marker's own
stack depth is a function of the object graph, which is exactly the thing you cannot bound.
When the stack fills, the routine does not fail and does not silently drop a subgraph: it sets
`overflowed` and continues, and `tera_collect` then drives a rescan to a fixpoint —
`while (overflowed != 0) overflowed = tera_mark_pending();`. `tera_mark_pending`
(`stats.c:245-264`) walks the whole arena linearly looking for a *marked* block with an
*unmarked* child, and marks from there. It is a full-arena pass and it may run more than once,
which is the price of a bounded work stack.

The x64 major collector does not have a work stack at all. `markRoot`
(`src/optimizing/backends/x64/heap.ts:437-456`) sets `TERA_MARK_FLAG` on the root object with a
single `orl` and does not descend. All the propagation is `markPass` (`:272-300`) — which *is*
the rescan — driven by `collect` (`:413-436`):

```ts
    builder
      .at("propagate")
      .callSymbol(X64_RUNTIME_SYMBOLS.markPass)
      .emit("testl", r("rax", COUNT_BYTES), r("rax", COUNT_BYTES))
      .to("jne", "propagate")
      .callSymbol(X64_RUNTIME_SYMBOLS.sweep)
```
— `src/optimizing/backends/x64/heap.ts:424-429`

Why the difference: the rescan is far less assembly than a work stack plus overflow handling,
needs no extra global array, and is already required by the C version as a fallback. The C
version keeps both because it can afford to — it is C text, and the system compiler does the
hard part. The x64 version keeps only the one it cannot avoid. Neither is more correct; the
C one converges in fewer arena passes on a deep graph, and the x64 one is smaller.

The reference walk itself reads the class table. `tera_classes[shape_id]` gives the shape's
reference-field offsets and a `tail` flag for the array case:
`tera_reference_count` answers `shape->fields` for an ordinary object, and
`(block_size - 8) / 8` for a block whose class carries `tailReferences` — an array of pointers,
whose element count is derived from its own header rather than stored twice
(generated `stats.c:211-215`). `ClassShape.tailReferences` is set at
`src/optimizing/metadata/class-table.ts:174` for exactly one case: an element buffer whose
element scalar is `SCALAR_POINTER`
[t: `tests/optimizing/target/runtime-layout.test.ts` > `"marks only a buffer of references as carrying a tail the collector walks"`].

The table itself is flat — a 16-byte record per shape plus one `u32` array of offsets — which
matters for [Ch 70]: it needs no relocations, so it can be emitted as plain data in a section
and read at a fixed displacement from the symbol.

## The five list heads

The shadow stack is not the whole root set. `tera_collect` also marks five pointers straight
out of `tera_context`, plus every static root:

```c
static void tera_collect(void) {
  int32_t overflowed = 0;
  for (size_t at = 0; at < tera_context.root_count; at++) {
    overflowed |= tera_mark(tera_context.roots_base[at]);
  }
  for (uint32_t at = 0; at < tera_static_root_count; at++) {
    overflowed |= tera_mark(*(unsigned char **)(tera_statics + tera_static_roots[at]));
  }
  overflowed |= tera_mark(tera_context.wait_head);
  overflowed |= tera_mark(tera_context.sweep_head);
  overflowed |= tera_mark(tera_context.queue_head);
  overflowed |= tera_mark(tera_context.rejected_head);
  overflowed |= tera_mark(tera_context.rejected_text);
  while (overflowed != 0) overflowed = tera_mark_pending();
  tera_sweep();
  tera_context.young_count = 0;
  tera_context.remembered_count = 0;
  tera_nursery_reset();
}
```
— generated `stats.c:366-385`

Those five are the event loop's own data structures, and they are covered in
[Ch 63](63-the-event-loop-and-a-rejection-nobody.md): `waitHead` and `sweepHead` are the timer
list and the list being drained this turn, `queueHead` is the microtask queue, `rejectedHead`
and `rejectedText` are the unhandled-rejection report. A coroutine frame parked on the timer
list is reachable from *nothing else* — no live function holds it, so no root slot mirrors it —
exactly as a suspended generator in the interpreter was reachable only from the scheduler.

The invariant is: **a runtime list head is a root, and adding a sixth list without adding a
sixth mark is a use-after-free with no compile error.** `TERA_CONTEXT` knows those fields exist
and knows their types; it does not know that five of them are roots.

That drift has already happened, and the reason it is not a live bug is a capability check
several files away. The riscv64 collector marks **three** of the five —
`queueHead`, `rejectedHead`, `rejectedText` (`src/optimizing/backends/riscv64/heap.ts:349-359`)
— and never touches `waitHead` or `sweepHead`. That is not a bug today, because those two
fields are only ever written by the timer lowering in
`src/optimizing/passes/coroutines.ts:1126` and `:1207`, which requires the `timers` capability,
and riscv64 declares only `terminating-throw` and `float-text`
(`src/optimizing/backends/riscv64/target.ts:42`). A riscv64 program cannot start a timer, so
those two heads are permanently null, so not marking them is correct. Nothing anywhere states
that reasoning, and nothing would notice if `timers` were added to riscv64 tomorrow.

> **Unenforced.** The runtime list heads that `tera_collect` and `tera_minor` mark are written
> out by hand, once per collector: twice in `src/optimizing/backends/c/emit.ts` (`:1566-1570`
> and `:1590-1594`), once in `markRoots` in `src/optimizing/backends/x64/heap.ts:492-500`
> (shared by the major and minor entry points), and once in
> `src/optimizing/backends/riscv64/heap.ts:349-359`. The three lists are **not the same
> length** — riscv64 marks three of the five — and the only thing making that correct is that
> riscv64 does not declare `timers`. There is no `root: true` on the field spec, no derived
> loop, and no test relating a backend's capability set to its root set. Cost of enforcing: an
> `ownership`-style tag on the `TERA_CONTEXT` field spec and a generated loop in each emitter,
> perhaps thirty lines across `runtime-layout.ts` and the three backends.

The static roots are the other half. Module-level variables and static class fields live in
`tera_statics`, a 4 KB byte array, and the ones that hold references are listed by offset in
`tera_static_roots` with a count in `tera_static_root_count`
(`src/optimizing/machine/heap-data.ts:66-76`). The running example has none — its two `Series`
are locals of the entry function, so `tera_static_root_count` is 0 — but a program with a
module-level object gets its offset in that table. Note the shape of the mark:
`*(unsigned char **)(tera_statics + offset)`, a load *through* the static slot. That is the one
place in the program where a slot is read rather than mirrored, and it is also the one place
where the collector could rewrite a pointer if it wanted to. It is not enough on its own, for
all the reasons in § nothing-moves.

## Sweeping

`tera_sweep` walks the arena linearly from `arenaBase` to `arenaCursor`, block by block, using
each block's own size to find the next one. It has two cases.

A live block — non-zero shape id and mark bit set — has its flags word rewritten:

```c
    if (*(const uint32_t *)block != 0u && (*flags & 1u) != 0u) {
      *flags = (*flags & ~(uint32_t)7u) | 2u;
      at += tera_block_size(block);
      continue;
    }
```
— generated `stats.c:346-350`

Clear all three flag bits, set `TERA_OLD_FLAG`. That single line is chapter 62's seam: the mark
bit is cleared for the next cycle, the remembered bit is cleared because the remembered set is
about to be emptied, and the old bit says *this block has survived a collection*. Every object
in the heap after a full sweep is old.

A dead block starts a run. The loop keeps extending `bytes` across consecutive dead blocks —
free ones and unmarked ones alike — and releases the whole run once:

```c
    size_t run = at;
    size_t bytes = 0;
    while (run < tera_context.arena_cursor) {
      unsigned char *next = tera_context.arena_base + run;
      uint32_t live = *(const uint32_t *)next != 0u &&
        (*(uint32_t *)(next + 4) & 1u) != 0u;
      if (live) break;
      bytes += tera_block_size(next);
      run += tera_block_size(next);
    }
    tera_release(block, bytes);
```
— generated `stats.c:351-362`

That is the coalescing, and it is the only thing standing between this collector and unbounded
external fragmentation. Note that `tera_sweep` sets `free_head = 0` as its first act and
rebuilds the list from scratch: there is no incremental free-list maintenance, so a block never
appears twice and a coalesced run replaces its pieces automatically.

`tera_release` does two things that matter:

```c
static void tera_release(unsigned char *block, size_t bytes) {
  if (block + bytes == tera_context.arena_base + tera_context.arena_cursor) {
    tera_context.arena_cursor -= bytes;
    return;
  }
  *(uint32_t *)block = 0u;
  *(uint32_t *)(block + 4) = (uint32_t)bytes;
  if (bytes >= 8 + 8) {
    *(unsigned char **)(block + 8) = tera_context.free_head;
    tera_context.free_head = block;
  }
}
```
— generated `stats.c:302-313`

First, if the dead run ends exactly at the arena cursor it **rewinds the cursor** rather than
building a free block. A pure-churn program — allocate, drop, allocate, drop — therefore never
grows its arena at all: the sweep hands the tail back and the next bump starts from the same
place. Second, a hole joins the free list only if it is at least `FREE_BLOCK_BYTES`; a smaller
hole gets a valid free header (so the linear walk can step over it) but no link, and is
abandoned until a neighbouring block dies and coalescing absorbs it.

Here, too, the two implementations are not the same routine. The x64 major `sweep`
(`heap.ts:350-411`) never rewinds the cursor: its dead-run path always writes the free header
and links the block, with `release` (`:521-548`) — the version that *does* rewind — used only
by the minor collector's `sweepYoung`. Both are correct, since a free block at the end of the
arena is as reusable as a shortened cursor. They differ in whether a churn loop's arena
plateaus or creeps. That difference is not measured, and the book will not claim which is
better.

## What was tried and rejected

Two recorded items, both about symbol and layout discipline rather than about algorithms, and
both of which cost real debugging.

**A runtime routine named after a data symbol.** The statics base used to be produced by
calling a routine named `tera_statics`. Once the arena's data moved to module level, that
routine's symbol collided with the `tera_statics` *data* symbol — two definitions of one name
in one object file, from two different emitters, with a linker error naming neither of them
usefully. The routine is gone. The address is now materialised inline by an `IR_RUNTIME_BASE`
node carrying the symbol name (`src/optimizing/ir/index.ts:919-923`), which the machine
backends lower to a single instruction — `leaq tera_statics(%rip), %rax` on x64
(`src/optimizing/backends/x64/lowering.ts:1270-1278`), `lla` on riscv64. The general rule the
episode produced is visible in the code as a shape rather than a comment: runtime *symbols* are
declared in one place (`runtime-layout.ts:238-246`) and runtime *data* is declared in another
(`TERA_ARRAYS`, `TERA_TABLES`), and no name appears in both lists. And it left a second trace
in this chapter's own material — `isRootedPointer`'s first line is `if (value.type === IR_RUNTIME_BASE) return false;`,
because a node that names static memory must never be given an arena root slot.

**Data after functions.** The runtime data must be emitted *after* every function body in the
assembly-text path. It is, structurally: `heapData(...)` is the last entry of `bodies` in
`src/optimizing/machine/backend.ts:432-442`, appended after every runtime routine and every
compiled function. Put it first and every function's `.LC*` and `.LB*` local labels shift,
and the byte-for-byte comparisons against `gas` in
`tests/optimizing/backends/x64/assembly.test.ts` diverge on relocation addends rather than on
instructions — a failure that reports as "the encoder is wrong" when the encoder is fine.

One encoding footnote belongs with them, because it is visible in the source and looks like a
mistake. `sweep` opens by zeroing a register and storing the register, rather than storing an
immediate zero:

```ts
    .emit("xorl", w("r8"), r("r8", COUNT_BYTES))
    .emit("movq", contextField("freeHead"), r("r8"))
```
— `src/optimizing/backends/x64/heap.ts:355-356`

`movq mem(symbol), imm` encodes its RIP-relative displacement differently from the way `gas`
does, so the comparison test fails on an instruction that is otherwise correct. Zeroing a
register first sidesteps it. The pattern is not applied everywhere — `sweepYoung` at `:592` and
`minor` at `:648` do use `movq contextField(...), imm(0)` — so this is a local workaround at
the sites where it mattered, not a rule.

## What leaves

Chapter 62 receives a complete, working, non-moving mark-sweep collector. Concretely: a
reserve-then-commit arena addressed by `arenaBase`/`arenaCursor`/`arenaCommitted`, a
first-fit free list keyed on shape id 0 and threaded through the holes themselves, a coalescing
sweep that rebuilds that list from scratch on every collection, and a shadow stack whose
slots are mirrors — so nothing in the heap may be relocated, and every use reads a register or
a local rather than a slot. Two backends implement all of it independently from one shared
`tera_context` layout; the third, riscv64, implements a subset that its capability set makes
correct.

Two facts in particular are what the next chapter spends.

First, **every surviving object is stamped `TERA_OLD_FLAG` by the sweep** — the single line
`*flags = (*flags & ~7u) | 2u;` at generated `stats.c:347`. The collector already knows, for
free, which objects have survived a collection and which have not. That is the generational
hypothesis's entire input, and it is already being computed.

Second, **bits 1 and 2 of the flags word are free**, because `CLASS_ALIGNMENT_BYTES = 8` puts
three zero bits at the bottom of every block size and only one of them is spoken for.
`TERA_OLD_FLAG` and `TERA_REMEMBERED_FLAG` are already declared in `runtime-layout.ts:255-256`
and already read by `tera_is_young` and `tera_remember` in the emitted C.

[Ch 62 § the-young-list](62-generations-without-moving.md) asks the obvious next question — can
the young objects be collected without walking the whole arena? — and its answer starts by
noting that the textbook shape for doing so, an address-range nursery, was built here and
measured worse, precisely because a collector that cannot move an object cannot compact
survivors out of a nursery. That result is named here only so the reader does not spend the
next chapter waiting for it.

## Verify it yourself

```bash
# The chapter's thesis in six lines: a C local read and written after a call that can collect.
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
sed -n '1503,1510p' /tmp/stats-c/stats.c
```

```bash
# The root frame, opened and closed, from the running example's one free function.
sed -n '1226,1235p' /tmp/stats-c/stats.c
```

```bash
# One slot, one value, grouped by function. Prints "83 1": eighty-three root stores,
# every one of them the only store to its (function, slot) pair.
awk '/\) \{$/ { fn = $0 } /roots_base\[roots \+ /{ match($0, /roots \+ [0-9]+/); \
  print fn " |" substr($0, RSTART, RLENGTH) }' /tmp/stats-c/stats.c \
  | sort | uniq -c | awk '{print $1}' | sort | uniq -c
```

```bash
# --heap-size is the one user control over the arena; it wins over the backend default.
node dist/cli.js compile docs/example/stats.tera --emit source --target c \
  --heap-size 64m -o /tmp/stats-64m
grep -n "define TERA_HEAP_RESERVE" /tmp/stats-64m/stats.c
```

```bash
# The same rootCount, reached the other way: a displacement the C compiler never sees.
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats-x64
sed -n '4,23p' /tmp/stats-x64/stats.s
```

```bash
# The collector's own suite. On a machine with no C toolchain and no PE runner,
# 8 pass and 11 skip of 19 — the report says which.
npx vitest run --project e2e tests/e2e/optimizing/aot/arena-collector.test.ts

# The layout agreement between the two implementations, at the cheapest tier.
npx vitest run --project unit tests/optimizing/target/runtime-layout.test.ts
```

## Tests that pin this

- The class table the collector walks:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"describes every class the collector has to sweep"`, and the `tailReferences` rule in
  `tests/optimizing/target/runtime-layout.test.ts` >
  `"marks only a buffer of references as carrying a tail the collector walks"`.
- The shadow stack exists at all: `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"gives every function that holds a reference a root frame"`.
- One slot, one value — the use-after-free regression:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"gives a loop-carried reference a root slot of its own"`.
- The collector actually reclaiming, run as a real binary — `itNative` through a C compiler,
  `itRunsPe` through the self-linked executable:
  `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"keeps allocating past the size of the arena"`,
  `"keeps a graph reachable only through a field alive across collections"`,
  `"keeps the elements of a grown array alive across collections"`,
  `"still reclaims when the roots live in a class the program keeps"`.
- The native binary agreeing with the interpreter on a run small enough not to collect —
  the oracle check: `tests/e2e/optimizing/aot/arena-collector.test.ts` >
  `"agrees with the interpreter on a run the arena could hold outright"`.
- Array growth staying valid across a `tera_array_reserve` that collects — the exact shape
  the § nothing-moves excerpt reads:
  `tests/e2e/optimizing/aot/heap-arrays.test.ts` >
  `"allocates the array on the heap rather than in the frame"`,
  `"grows an array past the length it was created with"`,
  `"grows an array reachable through a field without losing the holder"`,
  `"keeps every batch a loop refilled and handed over"`.
- Layout agreement between the two implementations, directly:
  `tests/optimizing/target/runtime-layout.test.ts` >
  `"gives every record field a naturally aligned, non-overlapping slot"`,
  `"emits one datum per declared record, array and table"`,
  `"reserves exactly the declared number of bytes for the context"`,
  `"reserves exactly the declared number of bytes for every array"`,
  `"declares the same context fields in the C backend, in the same order"`,
  `"sizes the C backend storage from the same declarations"`,
  `"names the same class tables in the C backend"`.
- The one-instance-only assumption the arena rests on, and the refusal that enforces it:
  `tests/optimizing/target/runtime-layout.test.ts` >
  `"names the arena reservation as the only state two threads could share"`,
  `"refuses per-thread context storage while nothing provisions the per-thread state"`,
  `"finds no thread entry point in any platform surface a program links today"`.
  See [Ch 81 § no-concurrency](../part-13-agreement/81-refusal-as-a-first-class-answer.md).
  Note the limit of that pin: it fixes `arenaReserved` as the only field tagged `shared`
  today, so a *new* shared-tagged field fails the test — but a new field wrongly tagged
  `perThread` is invisible, and threads are refused, so the tag is documentation in that
  direction.
- That the emitted root protocol is balanced on every exit path: **[unpinned]**. Nothing
  parses the emitted C, and `validateMachineFunction` has no root rule. See the
  `> **Unenforced.**` in § the-root-frame.
