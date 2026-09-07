# 22. Values: four bits inside a double   ⟨I · B · J · ~~N~~⟩

> **Status:** outline

**Thesis.** Every tera value is a JavaScript number whose low four bits are a type code,
so a value is never a pointer and can never dangle — which means a lost GC root does not
crash, it prints `undefined`, and that single fact shapes every debugging story in this
book.

**What arrived.** From [Ch 21]: a `TaggedValue` returned by `runFrame`, and
the `TaggedValue`s that `frame.acc`, `frame.registers[]` and `frame.thisValue` have been
moving around for a whole chapter without ever being opened. Chapter 21 used
`areBothSmi`, `mkNumber`, `smiPayload` and `SMI_MIN`/`SMI_MAX` on the `ROP_ADD` fast path
and deferred all five. Also: the interpreter's back-edge call to
`_maybeSweepHeapPayloads`, whose subject — the `ValueHeap` — has not been named yet.

**What leaves.** Two of the fourteen tag codes opened, and twelve deferred. `CODE_OBJECT`
and `CODE_ARRAY` are the codes whose payloads are a `JSObject` and a `JSArray`; chapter 23
receives exactly those two payload classes, plus the guarantee that their identity is
stable (`objectHeapIds`) and that `getPayload` on either is a `WeakMap`-free `Map` lookup,
not a pointer dereference. Also leaving: the five sameness predicates, of which chapter 23
needs `strictEqual` and chapter 24 needs none.

**New ideas.** *Tagged value* / *boxing* — how one machine word carries both a type and a
datum, and why "unboxed" is the thing every later tier is trying to earn. *Nibble* (four
bits). *Small integer (Smi)* as a distinguished representation, not an optimisation.
*Identity vs. equality* — two values that compare equal but are not the same object.
*Weak reference*, *finalization*, and why a cache that must not keep its keys alive needs
both. *Sentinel* — a value that means "no value", and the difference between one sentinel
and two. Deferred, not taught here: IEEE-754 *bit* layout, which arrives in
[Ch 36] and again in [Ch 56]; this chapter needs only that
a JavaScript number is a double and that doubles hold integers up to 2^53 exactly.

**Length.** 12 pages

## Anchors

- `src/core/value/index.ts` — the whole chapter. 1,158 lines, one file, no dependencies on
  the interpreter. `TAG_BITS = 4`, `TAG_MASK = 0xf`, `SMI_MAX = 0x3fffffff`,
  `SMI_MIN = -0x40000000` (43-46); the fourteen `CODE_*` constants and `CODE_MAX` (48-63);
  `CODE_TO_TAG` (240-256) and `TAG_TO_CODE` (258-269), two hand-written tables;
  `TAG_SHIFT_MULT` / `TAG_SHIFT_DIV` (280-281); `codeOf` (271), `heapId` (276),
  `getTag` (662), `smiPayload` (666), `getHeapId` (1055), `isPrimitive` (1049).
- `src/core/value/index.ts:298-575` — `class ValueHeap`: `heapPayloads` (slot array),
  `heapFreeList`, `heapIndices` (id → index), `pinnedHeapIds`, `objectHeapIds`
  (`WeakMap<object, number>` — identity), `allocatedHeapIds`, `externalLookupIds`, and the
  private `heapValue`, `localPayload`, `resolvePayload`. The `mk*` family (381-427) and
  `getPayload` (429-470), `isTaggedValue` (472-485), `sweepHeapPayloads` (514-530),
  `freeHeapObjectSlot` (492-507), `pinHeapSlot` (509-512).
- `src/core/value/index.ts:292-296` — the process-global escape hatch:
  `nextHeapPayloadId` (a module-level counter shared by *every* `ValueHeap`),
  `heapOwners: Map<number, WeakRef<ValueHeap>>`, and `heapOwnerFinalizer:
  FinalizationRegistry<Set<number>>`. `enableExternalLookup` (368-379) opts a heap in;
  `src/api/engine.ts:1339, 1350, 1504, 1510, 1607` are its five callers.
- `src/core/value/index.ts:577-600` — the ambient heap: `defaultValueHeap`,
  `activeValueHeap`, `getCurrentValueHeap`, `withValueHeap`, and the free-function
  wrappers (602-690) that every other file in `src/` actually imports.
- `src/core/value/index.ts:960-1047` — `abstractLooseEqual` (the `==` ladder),
  `abstractRelational`, `strictEqual`. Plus `toNumber` (780), `toBool` (804),
  `toString` (820), `toDisplayString` (886), `typeOf` / `typeOfCode` (927-958).
- `src/runtime/value-semantics.ts` — 50 lines, three exports. `compareValues(op, left,
  right)` is what the language's `==` actually means; `taggedToNumber`;
  `getRuntimeProperty` (the hand-off to [Ch 25]).
- `src/objects/heap/js-collections.ts:24-86` — `sameValueZero` and `hashTaggedValue`,
  both module-private, plus `hashInteger`, `hashDouble`, `hashString`. `hashDouble`
  (70-78) is the funnel: an integral double in int32 range is hashed *as an integer*.
  `OrderedHashTable._findEntry` (111-119) is the one caller of `sameValueZero`.
- `src/objects/exotic/proxy-ops.ts:40-51` — a *second* private `sameValue`, differing from
  `sameValueZero` in exactly one line (`Object.is` on zeros). Its only caller is the
  proxy `get`-trap invariant at line 412.
- `src/runtime/domain/host.ts` — `nativeToTagged`, the host boundary that must produce
  canonical numbers. Cited here, opened in [Ch 28].
- `src/bytecode/register/interpreter/index.ts:789-798` — `wrapConstant`: every numeric
  constant in the pool goes through `mkNumber`, so the constant `0.0` in `stats.tera`
  becomes a **Smi**, not a double.
- `tests/core/value.test.ts` — 534 lines, the tag layer's specification.
- `tests/objects/heap/js-collections.test.ts` — the sameness worked example's pin.
- `tests/runtime/domain/host.test.ts` — the canonical-number pin.

## Worked example

`docs/example/stats.tera`, and then a probe.

The spine reaches half of this chapter. `mean`'s constant pool is `0`, `"values"`,
`"length"`, `1` — two of them become Smis and two become heap strings, and `total = 0.0`
is a Smi despite being declared `float`:

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
```

It does not reach the other half. `stats.tera` builds no `Map`, no `Set` and no `WeakMap`,
so the chapter states that limit ([Conventions § 2](../CONVENTIONS.md)) and uses a probe
for the sameness story, exactly as [Ch 21] used one for host-stack recursion:

```bash
printf 'm = Map()\nm.set(1, "smi one")\nprint(m.get(2.0 - 1.0))\ns = Set()\ns.add(0.0)\ns.add(-0.0)\nprint(s.size)\n' > /tmp/sameness.tera
node dist/cli.js /tmp/sameness.tera
```

prints `smi one` and `1`. `strictEqual(mkSmi(1), mkDouble(1))` is deliberately **false** —
the tags differ — yet `Map` must treat them as one key. `js-collections.ts` gets there by
defining its own equality *and* its own hash, and the two have to agree: `sameValueZero`
compares numbers by payload across tags, and `hashDouble` sends any integral double in
int32 range through `hashInteger`, the same function the Smi case uses. Change one without
the other and every lookup silently misses — no error, just `undefined`.

## Outline

- [ ] **§ tagged-values — One number, every value.** Establish the whole representation in
      one sentence: a `TaggedValue` is a JavaScript `number`, `TaggedValue` is a branded
      `number` type (`TaggedValueBrand`, 81-83) that erases at run time, and there is no
      run-time class, box or wrapper anywhere. Show `mkSmi`, `mkBool`, `mkUndefined`,
      `mkNull` returning literal arithmetic. Establish the consequence the rest of the part
      depends on: values can be held in a plain JS array (`frame.registers`), passed as
      ordinary arguments, and stored in a `Float64Array` by the JIT — because they are
      already numbers. Name the cost up front: a heap value is an *index*, so reading it
      requires a table lookup, and the table can be wrong.
- [ ] **§ four-bits-inside-a-double — The layout.** `TAG_BITS = 4`, `TAG_MASK = 0xf`, and
      the fourteen codes as a fixed-width table (Conventions § 16), in numeric order with
      their `TAG_*` names beside them. Establish three properties of the *ordering*, each
      of which is load-bearing somewhere: `CODE_SMI === 0` (so `areBothSmi` is one `|` and
      one `&`); `CODE_FALSE`/`CODE_TRUE`/`CODE_UNDEFINED`/`CODE_NULL` are 1-4 and are
      *whole values*, not tags on a payload, so `isBool` is `v === CODE_TRUE || v ===
      CODE_FALSE` and `getHeapId` can dismiss them with `code <= CODE_NULL`; and
      `isPrimitive` is `code <= CODE_STRING || code === CODE_SYMBOL`, which only reads as
      one comparison because string sorts below object. Then the two hand-written tables,
      `CODE_TO_TAG` and `TAG_TO_CODE`, and the fact that neither is derived from the other.
- [ ] **§ why-not-a-shift — Why the obvious design fails.** The design a reader reaches for
      is a tagged pointer: shift the address left four, `or` in the tag, recover it with
      `>>> 4`. Stage it, then break it: JavaScript's bitwise operators coerce to *int32*,
      so `>>> 4` would cap the heap at 2^28 payloads and corrupt every value above it. The
      tree's answer is `TAG_SHIFT_MULT = 1 << TAG_BITS` and `TAG_SHIFT_DIV = 1 / 16`, and
      tagging is `id * 16 + code` with untagging `(v - code) * TAG_SHIFT_DIV` — multiply
      and divide, never shift, so the id range is the double's integer range. Establish
      that this is why the low nibble may still be read with `& TAG_MASK`: `ToInt32`
      truncates the high bits but preserves the low four.
- [ ] **§ mksmi-is-unchecked — `mkSmi` does not check; `mkNumber` does.**
      `mkSmi(n) = (n | 0) * 16` — three lines, no branch, no range test. Show what it does
      to the arguments it is not allowed to receive: `mkSmi(1.5)` yields the Smi `1`,
      `mkSmi(2**31)` yields `-2147483648`, `mkSmi(NaN)` yields `0`. Establish the division
      of labour this creates: `mkSmi` is the unchecked constructor for code that has
      already proved its argument, and [Ch 21]'s explicit `SMI_MIN`/`SMI_MAX` re-check
      after the integer add on `ROP_ADD` is exactly that proof. Then `mkNumber` (421-427)
      as the checked entry point everything else uses. Note `SMI_MAX = 2^30 - 1`, one bit
      narrower than int32, and say plainly that the tree does not record why.
- [ ] **§ negative-zero-comes-first.** `mkNumber`'s first line is
      `if (n === 0 && (1 / n) === -Infinity) return this.mkDouble(n)`. Establish why order
      matters and not merely that it does: `Number.isInteger(-0)` is `true` and `-0 | 0`
      is `+0`, so if the range test ran first, `-0` would become the Smi `0` and the sign
      would be gone for the rest of the program. Forward to [Ch 36] for the
      IEEE primer and to the `Set` half of the worked example, where `+0` and `-0` are
      deliberately re-merged one layer up.
- [ ] **§ two-absence-values.** `CODE_UNDEFINED = 3` and `CODE_NULL = 4` are two distinct
      whole values, and `isNullish` is the predicate that deliberately blurs them.
      Establish that this is a *choice with a cost*, paid twice: `strictEqual` needs a
      special case for both (1040-1046) because `getPayload` maps both to falsy host
      values; `abstractLooseEqual` needs the `xNull && yNull` clause (970-974) to make
      `null == undefined` true; and [Ch 56] shows the native compiler
      spending a second NaN payload to keep the distinction with no heap to lean on.
      Forward-reference [Ch 18] which promised this section.
- [ ] **§ the-value-heap — Where the other ten codes point.** Walk `ValueHeap`'s seven
      private fields and what each one exists for: `heapPayloads` (a `(id, payload)` slot
      array, index 0 permanently `null` so id 0 is never valid), `heapFreeList` (indices
      are recycled), `heapIndices` (id → index, because ids are *not* indices),
      `allocatedHeapIds`, `pinnedHeapIds`, `objectHeapIds`. Establish the central
      invariant: **indices are reused, ids never are** — `nextHeapPayloadId` only ever
      increments, so a stale `TaggedValue` can name a freed id and will resolve to
      `undefined` rather than to whoever moved into the slot. That is the whole reason a
      GC bug in this engine prints a wrong answer instead of returning someone else's
      object.
- [ ] **§ identity-is-a-weakmap.** `heapValue` (340-366) looks the payload up in
      `objectHeapIds` before allocating, so the same `JSObject` always gets the same tagged
      value and `a === b` works for objects. Establish the three-part guard on the reuse
      path (`existingId !== undefined && existingId > 0 && this.localPayload(existingId)
      === payload`) and what each part defends against. Then the asymmetry that matters
      later: `hasHeapIdentity` is `typeof payload === "object"`, so **primitives get no
      identity** — every `mkDouble` and every `mkString` allocates a fresh slot, and
      `mkDouble(1.5)` twice is two ids. This is the source of the boxed-primitive slab
      that [Ch 21]'s back edge sweeps and [Ch 31 § back-edge-sweep] sizes.
- [ ] **§ get-payload-is-a-switch.** `getPayload` (443-470) as fourteen overload
      signatures over one `switch (v & TAG_MASK)`: Smi is `v * TAG_SHIFT_DIV`, four codes
      are constants, ten go to `resolvePayload`. Establish the failure mode the chapter's
      thesis rests on, in order: `localPayload` returns `undefined` for a missing id;
      `resolvePayload` then asks the process-global owner map; if nobody owns it, the
      answer is `undefined`; `toString` on a `CODE_STRING` whose slot is gone therefore
      returns the *host* `undefined`, which `print` renders as `undefined`. Nothing throws.
      Name the three bugs this shape produced and where they are told —
      [Ch 32], [Ch 32] — and the general rule: in this
      engine a missing root is a *wrong answer* bug, not a crash bug.
- [ ] **§ heaps-are-plural.** `defaultValueHeap`, `activeValueHeap`, `withValueHeap`, and
      the free functions that read the ambient heap on every call. Establish why the
      indirection exists (one `Engine` per `ValueHeap`, so tests and the REPL can hold
      several) and what it cost: `nextHeapPayloadId` is *module*-global, shared by every
      heap in the process, which is what makes the cross-heap `heapOwners` map possible at
      all. Then `enableExternalLookup`: a `WeakRef<ValueHeap>` per id plus one
      `FinalizationRegistry` that deletes the ids when the heap dies, so a value can be
      read after its engine has been dropped without leaking the engine. Five callers, all
      in `src/api/engine.ts`.
- [ ] **§ five-kinds-of-same.** The chapter's spine section. A table: predicate, file,
      what it does to `(smi 1, double 1)`, to `(NaN, NaN)`, to `(+0, -0)`, and who calls
      it.
      `strictEqual` (core) — tag first, then payload: smi/double **differ**; used by
      `index_of`, by the ICs, and as the fallback of the other four.
      `abstractLooseEqual` (core) — the ECMAScript `==` ladder, reached only through the
      `loose==` operator.
      `compareValues` (`runtime/value-semantics.ts`) — what the *language's* `==` compiles
      to; numbers compare numerically across tags, strings and bools by payload, everything
      else falls to `strictEqual`.
      `sameValueZero` (`js-collections.ts`, private) — `Map`/`Set` keys: NaN equals NaN,
      `+0` equals `-0`.
      `sameValue` (`proxy-ops.ts`, private) — identical to `sameValueZero` except
      `Object.is` on zeros; one caller, the proxy `get` invariant.
      Establish the rule the table teaches: **the layer picks the predicate**, and two
      layers picking differently is not a bug here — it is the specification.
- [ ] **§ the-hash-must-agree — the worked example.** Run the probe. Establish that a hash
      table needs *two* agreeing functions, not one: `sameValueZero` decides that
      `mkSmi(1)` and `mkDouble(1)` are one key, and `hashDouble` has to send them to the
      same bucket or `_findEntry` never reaches the comparison. Show the two-line funnel
      (`if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) return
      hashInteger(v | 0)`) and the NaN constant `0x7FC00000` that makes the NaN case work.
      Then the general rule, which the book reuses in [Ch 34]: whenever
      equality is redefined, every index built on it must be redefined in the same commit.
- [ ] **§ canonical-numbers.** The invariant: *a number that fits in Smi range is always a
      Smi, whoever made it.* Enforcement: `mkNumber` inside the engine, and
      `nativeToTagged` at the host boundary — which used `mkDouble` for everything until it
      was changed, so a builtin returning `3` produced a value the interpreter's own `3`
      did not `strictEqual`. Test: the seven titles in `tests/runtime/domain/host.test.ts`.
      Establish why this is a correctness property and not a tidiness one — it is what lets
      [Ch 33]'s binary-op feedback stay `monomorphic` across a call to a builtin, and it is
      the reason `wrapConstant` calls `mkNumber` rather than switching on the literal's
      spelling. Close on `stats.tera`: `total = 0.0` is a Smi on the first iteration and a
      double from the second, and the feedback slot sees both.

## Honesty items

- > **Dead.** `CODE_MAX` (`src/core/value/index.ts:63`). Exported, and referenced by
  nothing in `src/`, `tests/`, `tools/` or `data/`. It is the obvious bound for the two
  hand-written code tables and for [Ch 25]'s `MEMBER_LOOKUPS` array, and neither uses it.
  Finishing it costs one line in each: `CODE_TO_TAG.length === CODE_MAX + 1` as a
  `satisfies`-style assertion at module load, or delete the constant.
- > **Unenforced.** `mkSmi` (`src/core/value/index.ts:602-604`) has no precondition check.
  `(n | 0) * TAG_SHIFT_MULT` truncates a fraction, wraps past int32 and turns `NaN` into
  `0`, all silently — `mkSmi(1.5)` is the Smi `1`. Every caller is expected to have proved
  its argument is an in-range integer, and nothing verifies that any of them did. The two
  callers that *do* prove it ([Ch 21]'s `ROP_ADD` and `ROP_SUB` range re-checks) are the
  only evidence the contract exists. A `SMI_MIN`/`SMI_MAX` assertion behind a debug flag
  would close it at the cost of a comparison on the hottest constructor in the engine.
- > **Unenforced.** `CODE_TO_TAG` (240-256) and `TAG_TO_CODE` (258-269) are two independent
  hand-written tables over the same fourteen codes, and neither is generated from the
  other. `TAG_TO_CODE` deliberately omits the five non-heap tags, so the omission cannot be
  distinguished from a typo. Adding a `CODE_*` constant and forgetting one table produces a
  value whose `getTag` is `"undefined"`, which the engine will happily print.
- > **Unenforced.** Nothing on the read path checks that a heap slot is still live.
  `getPayload` answers `undefined` for a swept id; only `isTaggedValue` (472-485) actually
  validates, and it is not called on any hot path. This is the mechanism behind the whole
  "prints the wrong number" family of GC bugs, and it is a deliberate trade: the check
  would cost a `Map.get` on every property read.
- > **Unfinished.** `RuntimeValue`, `RuntimeRecord` and `RuntimeCallable` (10-26) describe
  a *second*, untagged value model — plain host values — and the tag predicates all accept
  `RuntimeValue | HeapPayload` rather than `TaggedValue`, so `isSmi("hello")` type-checks
  and returns `false`. The wide signatures exist because the host bridge and the domain
  packages hand in raw host values. The cost of finishing is a `TaggedValue`-only
  predicate set plus explicit narrowing at the two boundaries that need the wide one.
- > **Never runs.** Nothing in `tests/` constructs a `ValueHeap` directly, or exercises
  `sweepHeapPayloads`, `pinHeapSlot`, `freeHeapObjectSlot`, `enableExternalLookup` or
  `withValueHeap` as units. They are covered only end-to-end, through
  `tests/e2e/gc/heap-payload-sweep.test.ts` and `tests/gc/gc.test.ts`. The identity
  invariant of § identity-is-a-weakmap has no direct test at all. `[unpinned]`

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
printf 'm = Map()\nm.set(1, "smi one")\nprint(m.get(2.0 - 1.0))\ns = Set()\ns.add(0.0)\ns.add(-0.0)\nprint(s.size)\n' > /tmp/sameness.tera
node dist/cli.js /tmp/sameness.tera
npx vitest run --project unit tests/core/value.test.ts tests/objects/heap/js-collections.test.ts tests/runtime/domain/host.test.ts
node dist/cli.js --stats docs/example/stats.tera | head -12
```

## Tests that pin this

- `tests/core/value.test.ts > "smi roundtrips through mkSmi/getPayload"`,
  `> "double roundtrips"`, `> "null and undefined roundtrip"`, `> "object roundtrips"`,
  `> "symbol roundtrips"` — the tag layout, one code at a time.
- `tests/core/value.test.ts > "returns correct tags"` — `CODE_TO_TAG`.
- `tests/core/value.test.ts > "isSmi/isDouble/isNumber"`, `> "isUndefined/isNull/isNullish"`,
  `> "isPrimitive"` — the mask predicates, including the two absence values.
- `tests/core/value.test.ts > "creates smi for small integers"`,
  `> "creates double for non-integer"`,
  `> "creates double for large integers beyond smi range"`,
  `> "creates smi for negative in range"` — `mkNumber`'s range guard.
  No test covers `mkNumber(-0)`, so the negative-zero-first ordering is `[unpinned]`.
- `tests/core/value.test.ts > "same smi values are equal"`,
  `> "smi and double with same numeric value are not equal (different tag)"`,
  `> "null === null, undefined === undefined"`, `> "null !== undefined"` — `strictEqual`,
  and the exact disagreement the worked example turns on.
- `tests/core/value.test.ts > "null == undefined"`, `> "smi == double with same value"`,
  `> "number == numeric string"`, `> "true == 1"` — `abstractLooseEqual`.
- `tests/core/value.test.ts > "returns -1 for smi/bool/null/undefined"` and
  `> "returns positive id for heap values"` — `getHeapId`'s `code <= CODE_NULL` shortcut.
- `tests/core/value.test.ts > "recognizes valid tagged values"` and
  `> "rejects non-tagged values"` — `isTaggedValue`, the validation nothing hot calls.
- `tests/core/value.test.ts > "answers the same for a value and for the tag code it carries"`
  and `> "names a tag code it has never seen"` — `typeOf` / `typeOfCode`.
- `tests/objects/heap/js-collections.test.ts > "+0 and -0 are the same key (SameValueZero)"`
  — the worked example's pin: a key set as `mkDouble(-0)` is read back with `mkSmi(0)`.
- `tests/objects/heap/js-collections.test.ts > "NaN key is found via SameValueZero"` —
  the `0x7FC00000` hash constant plus the `Number.isNaN` clause, together.
- `tests/objects/heap/js-collections.test.ts > "set/get round-trips for smi keys"`,
  `> "handles null and undefined as keys"`, `> "handles bool keys"` — `hashTaggedValue`
  over the non-heap codes.
- `tests/runtime/domain/host.test.ts > "tags an integral number in smi range as a smi"`,
  `> "tags a fractional number as a double"`,
  `> "tags an integral number beyond smi range as a double"`,
  `> "canonicalizes array elements"`, `> "canonicalizes plain object properties"`,
  `> "canonicalizes the result of a host builtin"` — the canonical-number invariant at the
  host boundary.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the boxed-primitive slab bounded under a double-heavy loop"`
  and `> "preserves live state (objects, arrays, closures, generators) across sweeps"` —
  the consequence of primitives having no identity.
