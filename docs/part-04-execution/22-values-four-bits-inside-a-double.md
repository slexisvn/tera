# 22. Values: four bits inside a double   ⟨I · B · J · ~~N~~⟩

Every value in tera is a JavaScript number. Not a number *sometimes* — always. `undefined`
is the number `3`. `true` is the number `2`. The integer `7` is the number `112`. The string
`"latency"` is some number ending in the bits `0110`, and the four bits at the bottom of
every one of those numbers say which kind it is. There is no box, no wrapper, no class, no
union type at run time. `frame.registers` in [Ch 21] could be a plain JavaScript array
because the things it holds are plain JavaScript numbers.

The consequence that matters is not speed. It is that **a value is never a pointer, so a
value can never dangle.** A heap value carries an *id*, and reading it is a table lookup that
answers `undefined` when the id is not in the table. Nothing dereferences anything. So when
a garbage collector in this engine loses track of a live object, the program does not crash,
does not fault, does not read someone else's memory — it prints `undefined`, or it prints a
number that is off by a little, and it exits 0. Every debugging story later in this book
inherits that: in tera a missing root is a **wrong-answer bug, not a crash bug**, and the
only way to find one is to compare answers.

This chapter opens two of the fifteen codes far enough for [Ch 23] to use them, and leaves
the other thirteen for the chapters that need them. It also opens the thing [Ch 21] swept on
every back edge without naming: the `ValueHeap`.

**What arrived.** From [Ch 21 § what-leaves]: a `TaggedValue` returned by `runFrame` — for
`report(latency)` a heap string, for `Series.mean` a double — plus the `TaggedValue`s that
`frame.acc`, `frame.registers[]` and `frame.thisValue` moved on every instruction of that
chapter without ever being opened. [Ch 21] used `areBothSmi`, `smiPayload`, `mkSmi`,
`mkDouble`, `mkNumber`, `CODE_UNDEFINED`, `SMI_MIN` and `SMI_MAX` on the `ROP_ADD` fast path
and deferred all of them. It also called `_maybeSweepHeapPayloads` on every back edge without
saying what was being swept. All of that is one 1,158-line file,
`src/core/value/index.ts`, whose only references to the interpreter are eight `import type`
lines that TypeScript erases, so at run time it depends on nothing downstream of it.

## Tagged values

> **New idea. Tagged value and boxing.** A dynamically typed language has to carry a type
> with every value, because nothing in the code says what a variable holds. The obvious way
> is **boxing**: allocate a small record holding a type field and the datum, and pass a
> pointer to it. Every value then costs an allocation and every read costs a dereference. The
> alternative is **tagging**: steal a few bits of the machine word itself for the type, and
> keep small values inline. What every optimizing tier in this book is trying to earn is
> permission to drop the tag entirely — to hold a number as a raw 64-bit float in a register
> with nothing attached. That is what "unboxed" means, and [Ch 45] is where it is won.

tera tags. The tag is four bits — a **nibble** — at the bottom of a JavaScript number, and
the type that names this is erased at run time:

```ts
type TaggedValueBrand<Tag extends ValueTag> = number & {
  readonly __taggedValueBrand?: Tag;
};
```
— `src/core/value/index.ts:81-83`

`number &` an object type with one optional never-written property. TypeScript treats
`SmiValue` and `DoubleValue` as distinct; JavaScript treats both as `number`. There is no
run-time representation of the brand at all.

The four constructors that do not touch the heap are literal arithmetic:

```ts
export function mkSmi(n: number): SmiValue {
  return ((n | 0) * TAG_SHIFT_MULT) as SmiValue;
}
```
— `src/core/value/index.ts:602-604`

and `mkBool` is `(b ? CODE_TRUE : CODE_FALSE)`, `mkUndefined()` is `CODE_UNDEFINED`,
`mkNull()` is `CODE_NULL` — three constants, returned as themselves (610-612, 650-656).

That is why the interpreter of [Ch 21] could be as plain as it was. Values go in a plain JS
array because they are numbers. They pass as ordinary arguments because they are numbers. The
JIT of [Ch 46] can put them in a `Float64Array` because they are numbers. Nothing is
serialized, marshalled or wrapped on the way in.

The cost is named here so it is not a surprise later. A heap value is an *index*, so reading
it requires a lookup in a side table — and a side table can be wrong. Everything from
[§ get-payload-is-a-switch](#get-payload-is-a-switch) onwards is about what happens when it
is.

## Four bits inside a double

Two constants set the layout, and two more bound the inline integer:

```ts
export const SMI_MAX = 0x3fffffff;
export const SMI_MIN = -0x40000000;
export const TAG_BITS = 4;
export const TAG_MASK = 0xf;
```
— `src/core/value/index.ts:43-46`

Four bits give sixteen codes. Fifteen are used (48-62), and they map onto fourteen tag names,
because `CODE_FALSE` and `CODE_TRUE` both answer `"bool"`:

```
 code  constant        CODE_TO_TAG   whole value?  payload lives
 ----  --------------  ------------  ------------  ------------------
    0  CODE_SMI        smi           no            in the value itself
    1  CODE_FALSE      bool          yes           -
    2  CODE_TRUE       bool          yes           -
    3  CODE_UNDEFINED  undefined     yes           -
    4  CODE_NULL       null          yes           -
    5  CODE_DOUBLE     double        no            ValueHeap slot
    6  CODE_STRING     string        no            ValueHeap slot
    7  CODE_OBJECT     object        no            ValueHeap slot
    8  CODE_FUNCTION   function      no            ValueHeap slot
    9  CODE_ARRAY      array         no            ValueHeap slot
   10  CODE_PROMISE    promise       no            ValueHeap slot
   11  CODE_ITERATOR   iterator      no            ValueHeap slot
   12  CODE_GENERATOR  generator     no            ValueHeap slot
   13  CODE_REGEX      regex         no            ValueHeap slot
   14  CODE_SYMBOL     symbol        no            ValueHeap slot
```

The *order* is not arbitrary. Three properties of it are load-bearing somewhere in the
engine, and none of them is written down in the tree.

`CODE_SMI === 0`, so a Smi is a value whose low nibble is zero — which makes "are these two
both Smis" one `|` and one `&`:

```ts
export function areBothSmi(a: RuntimeValue | HeapPayload, b: RuntimeValue | HeapPayload): boolean {
  return typeof a === "number" && typeof b === "number" && ((a | b) & TAG_MASK) === 0;
}
```
— `src/core/value/index.ts:742-744`

That is the guard [Ch 21 § fast-and-slow-paths-on-rop_add] tested before every integer
addition, and it is two machine operations because zero is the code that `or` cannot hide.

Codes 1 through 4 are **whole values**, not tags on a payload. `mkBool(true)` is literally the
number `2`; there is no id and no slot. So `isBool` is `v === CODE_TRUE || v === CODE_FALSE`
(703-705) — an identity test, not a mask — and `getHeapId` can dismiss all four in one
comparison:

```ts
export function getHeapId(v: RuntimeValue | HeapPayload): number {
  if (typeof v !== "number") return -1;
  const code = v & TAG_MASK;
  if (code <= CODE_NULL) return -1;
  return (v - code) * TAG_SHIFT_DIV;
}
```
— `src/core/value/index.ts:1055-1060`

`code <= CODE_NULL` covers Smi, both booleans, `undefined` and `null` in one branch, and it
reads as one comparison only because those five codes were placed first
[t: tests/core/value.test.ts > "returns -1 for smi/bool/null/undefined"].

And `isPrimitive` is `code <= CODE_STRING || code === CODE_SYMBOL` (1049-1053) — one range
plus one exception, which only works because `string` was placed below `object` and symbol
was placed last [t: tests/core/value.test.ts > "isPrimitive"].

Then two hand-written tables. `CODE_TO_TAG` (240-256) is a fifteen-element array indexed by
code; `TAG_TO_CODE` (258-269) is a ten-entry `Map` from tag name to code, deliberately
omitting the five non-heap tags because `heapValue` is the only caller and it can only
allocate heap things. Neither table is generated from the other, and neither is generated
from the constants.

> **Unenforced.** `CODE_TO_TAG` and `TAG_TO_CODE` (`src/core/value/index.ts:240-256` and
> `258-269`) are two independent hand-written tables over the same code set, and nothing ties
> either to the `CODE_*` constants. `TAG_TO_CODE`'s five deliberate omissions mean an
> accidental omission is indistinguishable from an intentional one. Add a `CODE_*` constant
> and forget `CODE_TO_TAG` and you get a value whose `getTag` is `TAG_UNDEFINED` — because
> `getTag` is `CODE_TO_TAG[codeOf(v)] || TAG_UNDEFINED` (662-664) — which the engine will
> print without complaint. Cost of enforcing: derive one table from the other, or assert
> `CODE_TO_TAG.length === CODE_MAX + 1` at module load.

> **Dead.** `CODE_MAX` (`src/core/value/index.ts:63`). Exported, and referenced by nothing in
> `src/`, `tests/`, `tools/` or `data/` — a tree-wide grep returns exactly one hit, its own
> definition. It is the obvious bound for both tables above and for [Ch 25]'s
> `MEMBER_LOOKUPS` array, and neither uses it. Finishing it costs one assertion per table;
> deleting it costs one line.

## Why not a shift *(Why the obvious design fails)*

The design a reader reaches for is a tagged pointer, and it is what every C engine does:
shift the address left by four, `or` in the tag, and recover the address with `>>> 4`. Two
instructions each way, no multiplication, no division.

It cannot be written in JavaScript. Every bitwise operator in the language coerces its
operands to **int32** first, so `v >>> 4` on a tagged value first truncates `v` to 32 bits.
The largest id a shift-based scheme could recover is therefore `(2**32 - 1) >>> 4`, which is
`268435455` — about 268 million payloads — and every value above that would not merely fail,
it would silently come back as some *other* id. A wrong answer, not an error.

The tree's answer is to multiply:

```ts
export const TAG_SHIFT_MULT = 1 << TAG_BITS;
const TAG_SHIFT_DIV = 1 / TAG_SHIFT_MULT;
```
— `src/core/value/index.ts:280-281`

Tagging is `id * TAG_SHIFT_MULT + code`; untagging is `(v - code) * TAG_SHIFT_DIV`. Multiply
and divide, never shift, so the id range is the *double's* integer range rather than int32's.
A double holds integers exactly up to 2^53 - 1, which leaves room for 562,949,953,421,311
ids — two million times what the shift version could address. The division is written as a
multiplication by the reciprocal, and 1/16 is exact in binary floating point, so no rounding
is introduced.

The nibble may still be read with `& TAG_MASK`, and it is, everywhere. That is not an
inconsistency: `ToInt32` discards the *high* bits and preserves the low ones, so the tag
survives the truncation the id does not. Read the tag with a mask; recover the id with
arithmetic. `codeOf` (271-274) and `heapId` (276-278) are those two lines, side by side.

## `mkSmi` does not check; `mkNumber` does

Look at `mkSmi` again: `(n | 0) * TAG_SHIFT_MULT`. Three tokens of work, no branch, no range
test, no assertion. Hand it an argument it is not allowed to receive and it answers
confidently:

```
mkSmi(1.5)    -> tagged 16,            payload 1
mkSmi(2 ** 31) -> tagged -34359738368, payload -2147483648
mkSmi(NaN)    -> tagged 0,             payload 0
```

A fraction is truncated, an out-of-range integer wraps through int32, and `NaN` becomes zero.
`mkSmi(NaN)` producing the Smi `0` is the worst of the three, because `0` is a plausible
answer that will propagate for a long time before anything notices.

This is a deliberate division of labour. `mkSmi` is the **unchecked** constructor, for code
that has already proved its argument is an in-range integer. `mkNumber` is the checked entry
point that everything else uses:

```ts
  mkNumber(n: number): TaggedValue {
    if (n === 0 && (1 / n) === -Infinity) return this.mkDouble(n);
    if (Number.isInteger(n) && n >= SMI_MIN && n <= SMI_MAX) {
      return mkSmi(n);
    }
    return this.mkDouble(n);
  }
```
— `src/core/value/index.ts:421-427`

`Number.isInteger` rejects the fraction, the range test rejects the overflow, and `NaN` fails
both [t: tests/core/value.test.ts > "creates smi for small integers"],
[t: tests/core/value.test.ts > "creates double for non-integer"],
[t: tests/core/value.test.ts > "creates double for large integers beyond smi range"].

The two proofs [Ch 21] carried out are what the contract looks like when it is honoured. The
`ROP_ADD` fast path adds two Smi payloads as ordinary numbers and then re-tests the sum
against `SMI_MIN`/`SMI_MAX` before calling `mkSmi` — that re-test is not a courtesy, it is
the precondition being discharged at the one call site that has the information to discharge
it.

`SMI_MAX` is `0x3fffffff`, which is 2^30 - 1: one bit narrower than int32. In an engine with
a real machine word this would be the bit spent on the tag, but here the tag is spent by
multiplying and the value is a double, so nothing in the representation requires it. The tree
does not record why the bound was chosen, and this book will not invent a reason.

> **Unenforced.** `mkSmi` (`src/core/value/index.ts:602-604`) has no precondition check.
> `(n | 0) * TAG_SHIFT_MULT` truncates a fraction, wraps past int32 and turns `NaN` into `0`,
> all silently. Every caller is expected to have proved its argument is an in-range integer,
> and nothing verifies that any of them did — the only evidence the contract exists at all is
> [Ch 21]'s two explicit range re-checks. A `SMI_MIN`/`SMI_MAX` assertion behind a debug flag
> would close it, at the cost of a comparison on every `mkSmi` call in the engine.

## Negative zero comes first

The first line of `mkNumber` is the negative-zero test, and its position is the whole point:

```ts
    if (n === 0 && (1 / n) === -Infinity) return this.mkDouble(n);
```
— `src/core/value/index.ts:422`

Run the range test first and `-0` is lost forever. `Number.isInteger(-0)` is `true`; `-0` is
`>= SMI_MIN` and `<= SMI_MAX`; and `-0 | 0` is `+0`. So `-0` would become the Smi `0`, and
from that instant no code anywhere in the engine could tell it from a positive zero — the
sign bit was never stored. The `1 / n === -Infinity` test is how you ask a JavaScript number
whether it is negative zero, because `-0 === 0` is `true` and comparison cannot answer it.

Sending it to `mkDouble` keeps the value on the heap as a genuine IEEE-754 `-0`, sign bit
intact. [Ch 36] and [Ch 56] open that bit layout; here it is enough that a double has a sign
and a Smi does not.

Two layers up, the distinction is deliberately thrown away again — `Set` merges `+0` and
`-0`, as [§ the-hash-must-agree](#the-hash-must-agree) shows. That is not a contradiction. The
representation preserves the difference so that the layers *above* it can each decide whether
to care, and they decide differently.

No test covers `mkNumber(-0)`. `tests/core/value.test.ts`'s `mkNumber` block tests `42`,
`3.14`, `0x40000000` and `-100`, and nothing else, so the ordering that makes negative zero
survive is `[unpinned]`.

## Two absence values

`CODE_UNDEFINED = 3` and `CODE_NULL = 4` are two distinct whole values, and the language
keeps them apart: `null !== undefined`
[t: tests/core/value.test.ts > "null !== undefined"] while `null == undefined`
[t: tests/core/value.test.ts > "null == undefined"]. `isNullish` (739-741) is the predicate
that deliberately blurs them, and it is one `||`.

Two distinct absences is a choice, and it is paid for at every layer. `abstractLooseEqual`
needs an explicit clause, because by the time it runs the two codes have already failed the
same-code test:

```ts
  const xNull = xc === CODE_NULL || xc === CODE_UNDEFINED;
  const yNull = yc === CODE_NULL || yc === CODE_UNDEFINED;
  if (xNull && yNull) return true;
  if (xNull || yNull) return false;
```
— `src/core/value/index.ts:970-973`

Four lines to say `null == undefined` and `null != 0`. And [Ch 56] shows the native compiler
paying for the same distinction with no heap under it: it spends a second NaN payload to keep
two absences apart, which [Ch 56 § two-absence-values-one-payload-each] prices.

`strictEqual` also mentions both, but for a different reason than the outline of this book
first assumed, and the difference is worth being exact about:

```ts
export function strictEqual(a: TaggedValue, b: TaggedValue): boolean {
  const ac = codeOf(a);
  const bc = codeOf(b);
  if (ac !== bc) return false;
  switch (ac) {
    case CODE_NULL:
    case CODE_UNDEFINED:
      return true;
    default:
      return getPayload(a) === getPayload(b);
  }
}
```
— `src/core/value/index.ts:1036-1047`

Those two cases are a **shortcut, not a correctness requirement.** The codes have already
been compared, and `getPayload` of a `CODE_NULL` is the host `null` and of a `CODE_UNDEFINED`
is the host `undefined` — and `null === null` and `undefined === undefined` are both true in
the host language. The `default` branch would give the same answer. What the cases buy is
skipping a `getPayload` call on the two most common values in a dynamically typed program.
That the shortcut is invisible from the code is exactly why this book states it: an engine
with 26 comment lines cannot tell you which of its branches are necessary and which are fast
paths, and reading them as necessary is how a refactor becomes a bug.

## The value heap

Ten of the fifteen codes carry an id rather than a value, and the table those ids index is
`ValueHeap` (`src/core/value/index.ts:298-575`). It declares twelve fields, six of which
carry the whole story:

- `heapPayloads` — an array of `{id, payload}` slots. Index 0 is set to `null` in the
  constructor and never used, so id 0 is never a valid heap id.
- `heapFreeList` — freed *indices*, recycled.
- `heapIndices` — a `Map` from id to index, which exists because **ids are not indices**.
- `allocatedHeapIds` — every id this heap currently owns.
- `pinnedHeapIds` — ids the sweeper must not free.
- `objectHeapIds` — a `WeakMap` from payload object to id, which is identity.

The central invariant is the pair of the first three: **indices are reused, ids never are.**
The id counter is module-level and only ever increments:

```ts
let nextHeapPayloadId = 1;
const heapOwners = new Map<number, WeakRef<ValueHeap>>();
const heapOwnerFinalizer = new FinalizationRegistry<Set<number>>((ids) => {
  for (const id of ids) heapOwners.delete(id);
});
```
— `src/core/value/index.ts:292-296`

So when a slot is freed and reused, the new occupant gets a *new* id, and the old id is
deleted from `heapIndices` rather than remapped. A stale `TaggedValue` — one held past the
collection of what it named — therefore resolves to `undefined`. It does not resolve to
whoever moved into the slot.

That single design choice is why a GC bug in this engine produces a wrong answer instead of a
type confusion. In a pointer-based engine, a stale reference into a reused slot yields an
object of the wrong class, and the next method call on it is undefined behaviour. Here it
yields nothing at all, and the nothing is spelled `undefined`. Safer, and much harder to find.

## Identity is a WeakMap

Object identity — the reason `a === b` works for two references to the same object — is one
lookup at the top of the allocator:

```ts
  private heapValue(tag: ValueTag, payload: HeapPayload): TaggedValue {
    const code = TAG_TO_CODE.get(tag);
    if (code === undefined) return CODE_UNDEFINED as TaggedValue;
    if (hasHeapIdentity(payload)) {
      const existingId = this.objectHeapIds.get(payload);
      if (
        existingId !== undefined &&
        existingId > 0 &&
        this.localPayload(existingId) === payload
      ) {
        return existingId * TAG_SHIFT_MULT + code as TaggedValue;
      }
    }
```
— `src/core/value/index.ts:340-352`

Three conditions guard the reuse path, and each defends against a different failure.
`existingId !== undefined` is the ordinary miss — this payload has never been tagged.
`existingId > 0` rejects the never-valid id 0, which is what a corrupted or defaulted entry
would look like. And `this.localPayload(existingId) === payload` re-reads the slot and checks
that it still holds the *same object*: without it, a payload whose slot was swept but whose
`WeakMap` entry survived would hand back a tagged value naming a dead id.

Everything else allocates:

```ts
    const id = nextHeapPayloadId++;
    let index: number;
    if (this.heapFreeList.length > 0) {
      index = this.heapFreeList.pop()!;
      this.heapPayloads[index] = { id, payload };
    } else {
      index = this.heapPayloads.length;
      this.heapPayloads.push({ id, payload });
    }
    this.heapIndices.set(id, index);
    this.allocatedHeapIds.add(id);
    if (hasHeapIdentity(payload)) this.objectHeapIds.set(payload, id);
    return id * TAG_SHIFT_MULT + code as TaggedValue;
  }
```
— `src/core/value/index.ts:353-366`

Note the guard on the identity write, and then note what it is:
`hasHeapIdentity` is `payload !== null && typeof payload === "object"` (283-285). So
**primitives get no identity.** A `mkDouble(1.5)` twice is two ids and two slots. A
`mkString("mean")` twice is two ids and two slots. Every arithmetic operation that produces a
non-Smi allocates, and none of them is ever deduplicated.

That is the source of the boxed-primitive slab [Ch 21]'s back edge sweeps and
[Ch 31 § the-collector-that-actually-runs] sizes: a floating-point loop allocates one heap
slot per intermediate value, and the only thing that reclaims them is the sweep
[t: tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the boxed-primitive slab bounded under a
double-heavy loop"].

## `getPayload` is a switch {#get-payload-is-a-switch}

Fourteen overload signatures (429-442) sit over one implementation, and the implementation is
a switch on the nibble:

```ts
  getPayload(v: number): HeapPayload {
    const code = v & TAG_MASK;
    switch (code) {
      case CODE_SMI:
        return v * TAG_SHIFT_DIV;
      case CODE_FALSE:
        return false;
      case CODE_TRUE:
        return true;
      case CODE_NULL:
        return null;
      case CODE_UNDEFINED:
        return undefined;
      case CODE_DOUBLE:
      ...
      case CODE_SYMBOL:
        return this.resolvePayload((v - code) * TAG_SHIFT_DIV);
      default:
        return undefined;
    }
```
— `src/core/value/index.ts:443-469`, the ten heap cases elided; the method closes at 470

A Smi is a multiplication. Four codes are constants. Ten codes go to `resolvePayload`. And the
`default` arm, for a nibble of 15, answers `undefined`.

Now read the failure path in order, because the chapter's thesis rests on it.

```ts
  private localPayload(id: number): HeapPayload {
    const index = this.heapIndices.get(id);
    if (index === undefined) return undefined;
    return this.heapPayloads[index]?.payload ?? undefined;
  }

  private resolvePayload(id: number): HeapPayload {
    const payload = this.localPayload(id);
    if (payload !== undefined) return payload;
    const owner = heapOwners.get(id)?.deref();
    return owner && owner !== this ? owner.localPayload(id) : undefined;
  }
```
— `src/core/value/index.ts:327-338`

A missing id gives `undefined` from `localPayload`. `resolvePayload` then asks the
process-global owner map whether some *other* heap knows the id. If nobody does — and after a
sweep nobody does, because the sweeper deletes from `heapOwners` too — the answer is
`undefined`.

Nothing throws. Nothing logs. `toString` on a `CODE_STRING` whose slot has been swept
receives the host `undefined`, coerces it, and `print` renders the six characters
`undefined`. A program that lost a root prints a plausible-looking result and exits 0.

That is the general rule this chapter exists to establish, and every GC chapter in the book
inherits it: **in this engine a missing root is a wrong-answer bug, not a crash bug.**
[Ch 32 § the-general-rule] tells three of them — a `range()` swept through a JS-closure-only
root, a suspended frame that was in no root set at all, and the invisible temporaries the
baseline compiler holds — and every one was found by an answer being wrong, never by a fault.

> **Unenforced.** Nothing on the read path checks that a heap slot is still live.
> `getPayload` answers `undefined` for a swept id and cannot distinguish that from a genuine
> `undefined`. The one function that *does* validate is `isTaggedValue` (472-485), which
> re-derives the id and asks `resolvePayload` whether anything is there
> [t: tests/core/value.test.ts > "recognizes valid tagged values"],
> [t: tests/core/value.test.ts > "rejects non-tagged values"] — and it is called on no hot
> path in the engine. This is a deliberate trade: checking would cost a `Map.get` on every
> property read. The price is the entire "prints the wrong number" family of bugs.

## Heaps are plural

There is one ambient heap and a way to swap it:

```ts
const defaultValueHeap = new ValueHeap();
let activeValueHeap: ValueHeap = defaultValueHeap;

export function getCurrentValueHeap(): ValueHeap {
  return activeValueHeap;
}

export function withValueHeap<T>(heap: ValueHeap, run: () => T): T {
  const previous = activeValueHeap;
  activeValueHeap = heap;
  try {
    return run();
  } finally {
    activeValueHeap = previous;
  }
}
```
— `src/core/value/index.ts:577-592`

and then eighty free functions — the file declares exactly 80 `export function`s, from
`mkSmi` at :602 to `typeOfCode` at the end — which is what every other file in `src/` imports
— `mkDouble`, `mkString`, `getPayload`, `isTaggedValue` — each of which reads `activeValueHeap`
on every call and delegates. The interpreter never names a heap.

The indirection exists because one `Engine` owns one `ValueHeap`, so a test suite or the REPL
can hold several engines at once without their values colliding. What it cost is the
module-level `nextHeapPayloadId`: because the counter is shared by every heap in the process,
an id is unique process-wide rather than merely heap-wide, which is what makes a cross-heap
lookup possible at all.

`enableExternalLookup` (368-379) is that lookup, opted into per heap. It registers a
`WeakRef<ValueHeap>` under every id the heap owns, plus one `FinalizationRegistry` callback
that deletes those ids when the heap itself is collected.

> **New idea. Weak reference and finalization.** A **weak reference** names an object without
> keeping it alive: the collector may still take it, and the reference then answers nothing.
> A **finalization registry** is the other half — it runs a callback *after* an object has
> been collected, so an index built on weak references can clean itself up. You need both,
> because a weak reference tells you the object is gone only when someone asks, and a table
> of dead entries that nobody asks about grows forever. `heapOwners` and
> `heapOwnerFinalizer` are exactly that pair.

The effect is that a tagged value can be read after its `Engine` has been dropped — the owner
map still resolves it — without the map itself pinning the engine in memory. Five callers, all
in `src/api/engine.ts`, at `:1339`, `:1350`, `:1504`, `:1510` and `:1607`.

> **Unenforced.** The identity invariant of
> [§ identity-is-a-weakmap](#identity-is-a-weakmap) — that the same payload always yields the
> same tagged value — is upheld by `objectHeapIds` alone and checked by nothing. Nothing in
> `tests/` constructs a `ValueHeap` directly: `sweepHeapPayloads` (514-530), `pinHeapSlot`
> (509-512), `freeHeapObjectSlot` (492-507), `enableExternalLookup` (368-379) and
> `withValueHeap` (584-592) have no unit test — a grep of `tests/` for any of those names
> returns nothing. They do run, but only end-to-end, through
> `tests/e2e/gc/heap-payload-sweep.test.ts` and `tests/gc/gc.test.ts`. Cost of enforcing: one
> unit test that tags the same `JSObject` twice and asserts the two tagged values are `===`,
> plus a `ValueHeap` unit file for the five untested methods. `[unpinned]`

## Five kinds of same

Because a value carries a tag, "the same" has more than one answer, and this engine gives
five. The table is the chapter's spine, and every row is a real function in the tree:

| predicate | where | `(smi 1, double 1)` | `(NaN, NaN)` | `(+0, -0)` | who calls it |
| --- | --- | --- | --- | --- | --- |
| `strictEqual` | `core/value/index.ts:1036` | **not equal** | not equal | equal | `index_of`, the ICs, and the fallback of the other four |
| `abstractLooseEqual` | `core/value/index.ts:960` | equal | not equal | equal | only the `loose==` operator |
| `compareValues` | `runtime/value-semantics.ts:20` | equal | not equal | equal | the language's own `==` |
| `sameValueZero` | `objects/heap/js-collections.ts:24` | equal | **equal** | equal | `Map` and `Set` keys |
| `sameValue` | `objects/exotic/proxy-ops.ts:40` | equal | equal | **not equal** | one site: the proxy `get` invariant |

`strictEqual` compares the code first and gives up if the codes differ, so a Smi and a double
holding the same number are *not* equal
[t: tests/core/value.test.ts > "smi and double with same numeric value are not equal (different tag)"].
That is not a bug in `strictEqual`; it is what "strict" means when the representation is part
of the value.

`compareValues` is what the language's `==` actually compiles to, and it is twenty lines:

```ts
export function compareValues(op: string, left: TaggedValue, right: TaggedValue): boolean {
  if (op === "loose==") return abstractLooseEqual(left, right);
  if (op === "loose!=") return !abstractLooseEqual(left, right);
  if (op === "==") {
    if (isNumber(left) && isNumber(right))
      return taggedToNumber(left) === taggedToNumber(right);
    if (isString(left) && isString(right))
      return getPayload(left) === getPayload(right);
    if (isBool(left) && isBool(right))
      return getPayload(left) === getPayload(right);
    return strictEqual(left, right);
  }
  if (op === "!=") return !compareValues("==", left, right);
  const c = abstractRelational(left, right);
  if (op === "<") return c < 0;
  if (op === ">") return c > 0;
  if (op === "<=") return c <= 0;
  if (op === ">=") return c >= 0;
  return false;
}
```
— `src/runtime/value-semantics.ts:20-39`

Three special cases — numbers compared numerically across tags, strings and booleans by
payload — and then `strictEqual` as the fallback. `isNumber` accepts either numeric code, so
the Smi/double distinction that `strictEqual` insists on is exactly what this function's
first clause exists to erase.

`sameValueZero` and `sameValue` differ from each other in one line. Both are module-private,
neither is exported, and the difference is what a `Map` key means versus what a proxy
invariant means:

```ts
function sameValueZero(a: TaggedValue, b: TaggedValue): boolean {
  const ta = getTag(a);
  const tb = getTag(b);
  const aNum = ta === "smi" || ta === "double";
  const bNum = tb === "smi" || tb === "double";
  if (aNum && bNum) {
    const va = getPayload(a);
    const vb = getPayload(b);
    if (Number.isNaN(va) && Number.isNaN(vb)) return true;
    return va === vb;
  }
  return strictEqual(a, b);
}
```
— `src/objects/heap/js-collections.ts:24-36`

`proxy-ops.ts`'s copy tests the same three things in a slightly different spelling, plus one
line `sameValueZero` does not have — `if (va === 0 && vb === 0) return Object.is(va, vb);`
(`proxy-ops.ts:47`) — which is what makes it distinguish `+0` from `-0`. It has exactly one
caller, the `get`-trap invariant at `proxy-ops.ts:412`.

The rule the table teaches, and the reason it is a table rather than a bug report: **the layer
picks the predicate.** Two layers picking differently is not an inconsistency here — it is the
specification. A `Map` must treat `1` and `1.0` as one key or it is not a `Map`. `index_of`
must not, or an inline cache keyed on representation would be unsound. A proxy invariant must
follow `Object.is`, because that is what the invariant is written against.

## The hash must agree {#the-hash-must-agree}

`stats.tera` builds no `Map`, no `Set` and no `WeakMap`, so this section uses a probe
(convention 2). Thirteen lines, outside the repository:

```
one = 0.5 + 0.5
xs = [one]
print(xs.index_of(1))
print(one == 1)
m = Map()
m.set(one, "found")
print(m.get(1))
n = 0.0 / 0.0
print(n == n)
s = Set()
s.add(n)
s.add(0.0 / 0.0)
print(s.size)
```

It prints:

```
-1
true
found
false
1
```

Five lines, five layers, and the same pair of values answered three different ways.

`one` is a genuine double: `0.5 + 0.5` takes `ROP_ADD`'s `areBothNumber` branch, which calls
`mkDouble` unconditionally (`interpreter/index.ts:1508-1509`). The literal `1` in the source
is a constant-pool entry, and `wrapConstant` sends it through `mkNumber`
(`interpreter/index.ts:789-798`), which makes it a Smi. So the program is genuinely comparing
a double `1` against a Smi `1`.

`xs.index_of(1)` answers `-1`, because `JSArray.indexOf`
(`src/objects/heap/js-array.ts:269-281`) uses `strictEqual` and the codes differ. `one == 1`
answers `true`, because `compareValues` compares numerically. And `m.get(1)` finds a key set
as `one`, because `Map` uses `sameValueZero` — *and* because the hash agrees.

That last conjunction is the section's point. A hash table needs **two** functions that agree,
not one. `_findEntry` (`js-collections.ts:111-119`) hashes the key, walks the bucket chain, and
calls `sameValueZero` only on entries it reaches. If `hashTaggedValue` sent the Smi `1` and the
double `1` to different buckets, the comparison would never run, and the lookup would answer
`undefined` — no error, no warning, just a miss.

It does not, because of a two-line funnel:

```ts
function hashDouble(v: number): number {
  if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) {
    return hashInteger(v | 0);
  }
  const buf = new Float64Array(1);
  buf[0] = v;
  const view = new Uint32Array(buf.buffer);
  return hashInteger((view[0]! ^ view[1]!) | 0);
}
```
— `src/objects/heap/js-collections.ts:70-78`

An integral double in int32 range is hashed **as an integer**, by the same `hashInteger` the
Smi case uses. Anything else is hashed from its raw bits. And `hashTaggedValue`'s `double`
case intercepts `NaN` before it reaches `hashDouble` at all, returning the constant
`0x7FC00000` (44-46), so both NaNs land in one bucket and `sameValueZero`'s
`Number.isNaN(va) && Number.isNaN(vb)` clause can then say they are the same key. Two
functions, one decision, written in two places.

Both halves are pinned:
[t: tests/objects/heap/js-collections.test.ts > "NaN key is found via SameValueZero"] needs the
hash constant and the comparison together, and
[t: tests/objects/heap/js-collections.test.ts > "+0 and -0 are the same key (SameValueZero)"]
sets a key as `mkDouble(-0)` and reads it back with `mkSmi(0)` — which requires the funnel,
because `-0 | 0` is `+0` and the Smi path would otherwise hash somewhere else entirely.

The general rule, which [Ch 34] reuses when an inline cache redefines what "the same map"
means: **whenever equality is redefined, every index built on it must be redefined in the same
commit.** An equality change that forgets its hash does not fail. It misses, silently, forever.

## Canonical numbers

The invariant this chapter would like to state is: *a number that fits in Smi range is always
a Smi, whoever made it.* It would be a good invariant. It would mean `strictEqual`'s
tag-first comparison never surprises anyone, because no double would ever hold an integral
value in range.

It is not true on this tree, and the probe above is the proof: `0.5 + 0.5` is a double `1`.

What *is* true is narrower and worth stating precisely. Canonicalization is a **boundary**
property, enforced at the two places values enter the system and at one place inside it:

- **The constant pool.** `wrapConstant` (`interpreter/index.ts:789-798`) sends every numeric
  constant through `mkNumber`, so it never matters how the literal was spelled. `total = 0.0`
  in `stats.tera` is constant `[0]`, printed by `--print-bytecode` as `0`, and it becomes a
  **Smi** despite the source writing it as the float literal `0.0`.
- **The host boundary.** `nativeToTagged` (`src/runtime/domain/host.ts:282-315`) calls
  `mkNumber` for every number, recursively through array elements and object properties. It
  used `mkDouble` for everything until it was changed, and the symptom was that a builtin
  returning `3` produced a value the interpreter's own `3` did not `strictEqual` — which meant
  a binary-operation feedback slot flipped from monomorphic to polymorphic across a call to a
  builtin, and [Ch 33]'s speculation gave up on a function for no reason the program could see.
  Seven titles in `tests/runtime/domain/host.test.ts` pin it, including
  [t: tests/runtime/domain/host.test.ts > "canonicalizes the result of a host builtin"] and
  [t: tests/runtime/domain/host.test.ts > "canonicalizes array elements"].
- **Smi + Smi.** `ROP_ADD`'s fast path re-tests the sum and calls `mkSmi` when it fits.

And what is *not* canonicalized is everything else arithmetic produces. `ROP_ADD`'s
`areBothNumber` branch is `mkDouble(this.toNumberValue(left) + this.toNumberValue(right))`
(`interpreter/index.ts:1508-1509`) — an unconditional `mkDouble`, even when the sum is a small
integer. So in `Series.mean`, `total` is a Smi for exactly as long as it holds the initial
`0`, becomes a double on the first `+= 12.5`, and stays a double for the rest of the loop even
though the running sum passes through integral values. The binary-op feedback slot sees both
kinds, which is [Ch 33 § what-each-recorder-stores]'s subject.

That gap is not merely untidy. It produces a live disagreement between the tiers, which this
chapter found while writing the probe above.

> **Broken.** A runtime-produced double that holds an in-range integer is not found by
> `index_of` in the interpreter, and *is* found by the optimizing tier and by a native binary.
> Measured on this tree, 2026-09-08, from a six-line program — `probe()` returning
> `[0.5 + 0.5].index_of(1)`:
>
> ```
> node dist/cli.js probe.tera                                    -> -1
> node dist/cli.js --baseline-threshold 1 --no-opt probe.tera    -> -1
> node dist/cli.js --opt-threshold 1 --baseline-threshold 1 ...  ->  0
> node dist/cli.js compile probe.tera -o probe.exe && ./probe.exe ->  0
> ```
>
> `--trace-opt` confirms the third line is really the JIT: it prints
> `[JIT] Compiling "probe": Wasm module compiled: 590 bytes, 1 blocks` and then
> `[JIT] Compiling "probe": Wasm installed in 2.82ms`, and the installed code is what
> answers `0`.
>
> The mechanism is this chapter, from both sides. In tier 0 the element is a `CODE_DOUBLE`
> and the argument is a `CODE_SMI`, `JSArray.indexOf` (`src/objects/heap/js-array.ts:269-281`)
> asks `strictEqual`, `strictEqual` compares codes first, and the search misses. In the
> compiled tiers there is no tag: `lowerSearch` replaces the call with an inline scan whose
> per-element test is `sameElement` (`src/optimizing/passes/array-methods.ts:159-171`), a
> numeric IR comparison on the element's lattice type, and 1 equals 1.
>
> By the book's own contract the interpreter is the oracle, so the compiled tiers are the ones
> that diverge — but the interpreter's answer is also the one that contradicts the language's
> own `==`, which says `one == 1` is `true` in the same program. Both cannot be right.
>
> Why no test catches it: all 90 lines in `tests/` that mention `index_of` search for a
> value written as a literal, and a literal reaches the constant pool, where `wrapConstant` canonicalizes it.
> The divergence needs a value computed at run time on one side and a literal on the other.
>
> Fixing it costs a decision rather than a line. Either `ROP_ADD`'s numeric branch calls
> `mkNumber` instead of `mkDouble` — restoring the global invariant at the price of a
> `Number.isInteger` and two comparisons on every non-Smi addition the interpreter performs — or
> `JSArray.indexOf` stops using `strictEqual` and uses `compareValues("==")`, which makes
> `index_of` agree with `==` and with the compiled tiers but changes what "the same element"
> means for every other array member built on it.

The general rule is the one this whole chapter has been circling: **a representation choice
that two layers can make independently is a disagreement waiting to be found.** The tag is
part of the value at tier 0 and is not part of the value at tiers 2 and 3, and every place
where the two roads compare values is a place where that difference can surface.

## What leaves

Two codes, opened. `CODE_OBJECT` and `CODE_ARRAY` are the codes whose payloads are a
`JSObject` and a `JSArray`, fetched with `getPayload` — which for those two codes is
`resolvePayload`, a `Map` lookup into the `ValueHeap`, not a pointer dereference. Their
identity is settled and does not need restating downstream: `objectHeapIds` guarantees that
the same payload object always yields the same tagged value, so [Ch 23] may say "the same
object" without qualification, and `a === b` on two references to one object is true.
Thirteen codes are left closed — `CODE_PROMISE` waits for [Ch 30], `CODE_ITERATOR` and
`CODE_GENERATOR` for [Ch 27], `CODE_SYMBOL` for [Ch 26].

Also leaving: `strictEqual`, which [Ch 23]'s hidden-class caches and [Ch 24]'s inline caches
use as their sameness test, and which [Ch 25] does not need at all. And the fact that
underlies every collector chapter in the book — a stale tagged value resolves to `undefined`
rather than to a stranger, because ids are never reused even though slots are.

[Ch 23 § hidden-classes-what-an-object-is] takes the two payload classes and asks what is
*inside* one: an object here stores no property names at run time, only a pointer to a shared descriptor and
an array of values, and the descriptor's identity includes the prototype.

## Verify it yourself

```bash
# The constant pool: `total = 0.0` is constant [0], printed as `0`, and wrapConstant
# makes it a Smi. Two of the four constants are numbers, two become heap strings.
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# The tag layer, the sameness predicates, the hash funnel and the host boundary (119 tests).
npx vitest run --project unit tests/core/value.test.ts \
  tests/objects/heap/js-collections.test.ts \
  tests/runtime/domain/host.test.ts

# The boxed-primitive slab, which exists because primitives get no identity.
npx vitest run --project e2e tests/e2e/gc/heap-payload-sweep.test.ts
```

The sameness probe is not in `docs/example/`, because a program written to make three layers
disagree cannot be given the single expected output
`tests/e2e/docs/book-examples.test.ts` requires. Save the thirteen lines from
[§ the-hash-must-agree](#the-hash-must-agree) as `sameness.tera` outside the repository —
with an editor, not a shell heredoc, which eats backslashes — and run:

```bash
node dist/cli.js sameness.tera
```

It prints `-1`, `true`, `found`, `false`, `1`.

For the `> **Broken.**` divergence, save these six lines as `probe.tera` and run all four:

```
fn probe() -> int:
  one = 0.5 + 0.5
  xs = [one]
  return xs.index_of(1)

print(probe())
```

```bash
node dist/cli.js probe.tera                                          # -1
node dist/cli.js --baseline-threshold 1 --no-opt probe.tera          # -1
node dist/cli.js --opt-threshold 1 --baseline-threshold 1 probe.tera #  0
node dist/cli.js compile probe.tera -o probe.exe && ./probe.exe      #  0
```

Add `--trace-opt` to the third to watch `probe` reach WebAssembly before it answers.

## Tests that pin this

- `tests/core/value.test.ts > "smi roundtrips through mkSmi/getPayload"`,
  `> "double roundtrips"`, `> "null and undefined roundtrip"`, `> "object roundtrips"`,
  `> "symbol roundtrips"` — the tag layout, one code at a time.
- `tests/core/value.test.ts > "returns correct tags"` — `CODE_TO_TAG`.
- `tests/core/value.test.ts > "isSmi/isDouble/isNumber"`,
  `> "isUndefined/isNull/isNullish"`, `> "isPrimitive"` — the mask predicates, including the
  two absence values and the `code <= CODE_STRING` ordering.
- `tests/core/value.test.ts > "creates smi for small integers"`,
  `> "creates double for non-integer"`,
  `> "creates double for large integers beyond smi range"`,
  `> "creates smi for negative in range"` — `mkNumber`'s range guard. The block tests `42`,
  `3.14`, `0x40000000` and `-100` and nothing else, so `mkNumber(-0)` — and therefore the
  negative-zero-first ordering — is `[unpinned]`.
- `tests/core/value.test.ts > "same smi values are equal"`,
  `> "smi and double with same numeric value are not equal (different tag)"`,
  `> "null === null, undefined === undefined"`, `> "null !== undefined"` — `strictEqual`, and
  the exact disagreement the probe turns on.
- `tests/core/value.test.ts > "null == undefined"`, `> "smi == double with same value"`,
  `> "number == numeric string"`, `> "true == 1"` — `abstractLooseEqual`.
- `tests/core/value.test.ts > "returns -1 for smi/bool/null/undefined"` and
  `> "returns positive id for heap values"` — `getHeapId`'s `code <= CODE_NULL` shortcut.
- `tests/core/value.test.ts > "recognizes valid tagged values"` and
  `> "rejects non-tagged values"` — `isTaggedValue`, the validation nothing hot calls.
- `tests/core/value.test.ts > "answers the same for a value and for the tag code it carries"`
  and `> "names a tag code it has never seen"` — `typeOf` / `typeOfCode`.
- `tests/objects/heap/js-collections.test.ts > "+0 and -0 are the same key (SameValueZero)"`
  — sets a key as `mkDouble(-0)` and reads it back with `mkSmi(0)`, which needs the hash
  funnel and the comparison to agree.
- `tests/objects/heap/js-collections.test.ts > "NaN key is found via SameValueZero"` — the
  `0x7FC00000` constant and the `Number.isNaN` clause, together.
- `tests/objects/heap/js-collections.test.ts > "set/get round-trips for smi keys"`,
  `> "handles null and undefined as keys"`, `> "handles bool keys"` — `hashTaggedValue` over
  the non-heap codes.
- `tests/runtime/domain/host.test.ts > "tags an integral number in smi range as a smi"`,
  `> "tags a fractional number as a double"`,
  `> "tags an integral number beyond smi range as a double"`,
  `> "canonicalizes array elements"`, `> "canonicalizes plain object properties"`,
  `> "canonicalizes the result of a host builtin"` — canonicalization at the host boundary,
  which is the only boundary that has tests of its own.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the boxed-primitive slab bounded under a double-heavy loop"`
  and `> "preserves live state (objects, arrays, closures, generators) across sweeps"` — the
  consequence of primitives having no identity.
- `ValueHeap` itself is `[unpinned]`: nothing in `tests/` constructs one, and
  `sweepHeapPayloads`, `pinHeapSlot`, `freeHeapObjectSlot`, `enableExternalLookup` and
  `withValueHeap` have no unit tests. The identity invariant of § identity-is-a-weakmap has
  no direct test at all.
- The `index_of` tier divergence is `[unpinned]`: all 90 lines in `tests/` that mention
  `index_of` search for a literal, and a literal is canonicalized in the constant pool before the search
  begins.
