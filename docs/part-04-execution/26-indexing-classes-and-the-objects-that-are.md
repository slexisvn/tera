# 26. Indexing, classes, and the objects that are not objects   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Two subscript syntaxes with opposite out-of-range policies, a class model with
no runtime nominality, and three exotic object kinds that each opt out of the map
machinery in a different way.

**What arrived.** From [Ch 25 § three-answer-contract]: `memberLookupValue`'s three-valued
contract, and the receivers it *declines* — plain objects, `null`, `undefined` — handed on
to `getRuntimeProperty`. Chapter 25 resolved members by **name**. Everything in this
chapter is reached by something that is not a name: a subscript, a lineage, or a hook that
replaces the hidden class entirely.

**What leaves.** Every remaining way a value can be *read*: `a[i]`, `a[1:3]`, `m[i, j]`,
`this.#private`, `Klass.static`, a proxy trap, a `Map` entry. Chapter 27 receives the
completed read surface and turns to the two things that make a read *not return* — a throw
and an iterator — and to the eleven opcodes those two mechanisms cost.

**New ideas.** *Two syntaxes, one arithmetic* — the difference between a language-level
policy and a shared helper. *Nominality vs. structure* at run time (tera has classes but
compares them by **name string**, never by identity — the payoff for [Ch 57 §
structural-dispatch]). *Weak reference* and *ephemeron*: why "value alive while key is
alive" cannot be expressed by a single mark pass, and needs a fixpoint.

**Length.** 12 pages

## Anchors

### The shared arithmetic

- `src/core/indexing.ts` — 62 lines, zero dependencies, imported by the interpreter, the
  checker and two optimizer passes. `IndexDim` `:1-3` (the union that describes one
  subscript position), `SliceBounds` `:5`, `resolveSlice` `:7-21`, `normalizeIndex`
  `:23-26`, `COMPLEMENT` `:28-39`, `PROVEN_COUNT` `:44-53`, `provenCount` `:55-59`,
  `TAKES_ONE_ELEMENT` / `ADDS_ONE_ELEMENT` `:61-62`.
- `src/core/indexing.ts:55-59` — `provenCount` is the *only* thing in this file that is
  not about running the program: it is a compile-time question ("how many elements does
  `q.length > 0` prove?"), consumed by `src/frontend/checker/length-bounds.ts:94` and
  `src/optimizing/passes/array-methods.ts:678-679`. This is the arithmetic behind the cold
  open's refusal in [Ch 13 § shift-twice].
- `src/runtime/indexing.ts` — `indexValue` `:61-69`, dispatching to `indexArray` `:17-37`,
  `indexString` `:39-59`, or a host object's `_indexND` hook `:65-66`. Note `:30-32` and
  `:52-54`: an out-of-range **index** on this path throws
  `Index N is out of bounds for array of length L`.
- `src/bytecode/register/compiler/expressions.ts:812-844` — `compileIndexExpression`,
  which decides *which* opcode a subscript becomes. It builds a token array (`"i"`,
  `"s110"`, …) as a constant and emits `ROP_LDA_KEYED_SLICE` with the bound registers.
  The plain single-index path is `ROP_LDA_INDEX` / `LdaKeyedProperty` and never reaches
  `indexValue`.
- `src/bytecode/register/interpreter/handlers.ts:435-457` — `handleLdaKeyedSlice`: decodes
  the token array back into `IndexDim[]`, then `indexValue(obj, dims)`.
- `src/bytecode/register/interpreter/handlers.ts:405-419` — `handleLdaKeyedProp`'s array
  branch, the *other* policy: `ic.lookupElement(...)`, and `undefined` when it misses.
- `src/objects/heap/js-array.ts:103-113` — `JSArray.getIndex`, a **second**
  implementation of negative wrapping, independent of `normalizeIndex`, answering
  `undefined` rather than throwing. `setIndex` `:115-...` wraps the same way and silently
  drops a write that is still negative after wrapping.

### Classes at run time

- `src/runtime/class-access.ts` — 181 lines, the whole class model that survives to run
  time. `assertConstructorAccess` `:42-51` (abstract refused first, then visibility),
  `assertObjectMemberAccess` `:53-62`, `assertFunctionMemberAccess` `:64-73`, the
  `canAccess*` / `hasRestricted*` pairs `:75-103` used by introspection and the REPL.
- `src/runtime/class-access.ts:115-127` — `findMemberAccess`: the `staticBase` walk. One
  loop serves both static inheritance and instance-member lookup; the only difference is
  which of the two visibility tables it reads (`classInstanceMemberVisibility` /
  `classStaticMemberVisibility`).
- `src/runtime/class-access.ts:129-139` — `memberAccessAllowed`. `private` is
  `caller === access.ownerName`; `protected` adds `lineageIncludesBeforeOwner`
  `:154-166`, which walks the target's `staticBase` chain and requires the caller to
  appear *at or before* the owner.
- `src/runtime/class-access.ts:175-177` — `ownerNameOf`. Every comparison above is a
  **string** comparison on `classOwnerName || name || "<anonymous>"`.
- `src/objects/exotic/function-members.ts:33-...` — `resolveFunctionSlot`, the second
  `staticBase` walk in the tree (the first is `findMemberAccess`), and `:112-138`
  `functionMemberValue` calling `assertFunctionMemberAccess` on what it found: the class
  object *is* a `RuntimeFunctionPayload`, and statics are its own properties.
  `:177` is where `staticBase` is set — one assignment, at class-declaration time.

### The objects that are not objects

- `src/objects/exotic/js-proxy.ts` — 69 lines. `PROXY_HIDDEN_CLASS` `:17-30`: a **single
  shared object literal**, `id: -100`, whose `lookupProperty()` returns `null` and
  `hasProperty()` returns `false` unconditionally. `class JSProxy` `:32-62` with
  `prototype: null` and `isProxy: true`; `visitReferences` `:50-57` reaches only `target`
  and `handler`; `isJSProxyObject` `:64-69` accepts either the class or any duck-typed
  `isProxy === true`.
- `src/objects/exotic/proxy-ops.ts:413-421, 598-601, 660-663` — the three spec invariant
  checks that are implemented, each throwing a verbatim message
  (`'get' on proxy: property 'p' is a read-only and non-configurable data property on the
  proxy target but the proxy did not return its actual value`).
- `src/objects/maps/hidden-class.ts:944-953` — `INSTANCE_TYPE_MAP`, `_SET`, `_WEAKMAP`,
  `_STRING_WRAPPER`, `_NUMBER_WRAPPER`, `_BOOLEAN_WRAPPER`, and `getInitialMap`. These
  are ordinary `JSObject`s whose *map identity* names their instance type; the payload
  hangs off a side field.
- `src/objects/heap/factory.ts:88-118` — `createJSMap`, `createJSSet`, `createJSWeakMap`,
  `createJSPrimitiveWrapper`: `getInitialMap(INSTANCE_TYPE_X)` plus one side field
  (`_mapData`, `_setData`, `_weakMapData`, `_primitiveValue`).
- `src/objects/heap/js-collections.ts:88-164` — `OrderedHashTable`: parallel arrays
  `_keys` / `_chains` / `_deleted` plus an `Int32Array` `_buckets`. Insertion order *is*
  array order; `delete` `:125-132` only sets a tombstone; `iterateKeys` `:159-163` skips
  them; `_rehash` `:169-178` is the only compaction. `hashInteger` / `hashDouble` /
  `hashString` `:63-86`.
- `src/objects/heap/js-collections.ts:249-357` — `EphemeronHashTable`. Open addressing
  with linear probing (`_probe` `:270-291`, including the tombstone-reuse inner loop), a
  Knuth-multiplicative hash of one number, and that number is `getHeapId(key)` —
  the key's **value-heap handle index**, not the object.
- `src/core/value/index.ts:1055-1060` — `getHeapId`: `(v - code) * TAG_SHIFT_DIV`. A slot
  index, reusable after a sweep.
- `src/gc/roots.ts:196-203` — Map and Set contents are seeded as roots by iterating the
  table. `_weakMapData` is absent from the list, and the two blank lines at `:203-204`
  are where it would go.

## Worked example

`docs/example/stats.tera` reaches the plain subscript path and nothing else — its `mean`
loop compiles `values[i]` to one opcode:

```
    21  LdaKeyedProperty r3 r4 r5
```

Everything else in this chapter is out of the spine's reach, exactly as the part opener
([Part IV § what-the-running-example-cannot-reach]) says: no `Map`, no `WeakMap`, no
proxy, no getters. So the chapter's centrepiece is a probe, not a variation file:

**A `WeakMap` entry that outlives its key.** `EphemeronHashTable.set` stores
`_heapIds[idx] = getHeapId(key)` and `_keys[idx] = key` — both plain numbers. Neither is a
GC root: `gc/roots.ts` seeds `_mapData` and `_setData` and stops. So:

1. the key object is unreachable everywhere else and the value heap sweeps its slot;
2. the table still holds the id and still reports `has(...)` for it;
3. the entry's *value* was never marked either, so what `get` answers may itself be swept;
4. a later allocation can be handed the same slot index — a **different** object with the
   same `getHeapId`, which then hits the old entry.

What a real ephemeron pass would have to do instead: mark the value only once the key is
proven live, and repeat until no new marks appear — a fixpoint over the table, not a
single pass. Sketch that loop, cost it, and state where it would have to hook into
[Ch 31 § marking].

## Outline

- [ ] **Two subscripts, one file.** Establish `src/core/indexing.ts` as the shared
  arithmetic — 62 lines, no imports, read by the interpreter, the checker and two
  optimizer passes — then establish that sharing arithmetic is not sharing *policy*.
- [ ] **> New idea: normalising an index.** `normalizeIndex` (`:23-26`) is three lines:
  reject a non-integer, and add the length to a negative. Establish that it deliberately
  **does not clamp** — it can return a still-negative or still-too-large number, and
  leaves the range decision to its caller. Pin with "returns an out-of-range result rather
  than clamping".
- [ ] **Where the policies diverge.** The chapter's central table. `a[-1]` → the last
  element; `a[99]` → `undefined`; `m[5, 0]` →
  `Index 5 is out of bounds for array of length 2`. Establish that the split is decided at
  *compile* time by `compileIndexExpression`: one dim with a plain index becomes
  `LdaKeyedProperty` (IC path, misses answer `undefined`), anything with a slice or a
  comma becomes `LdaKeyedSlice` (`indexValue` path, out-of-range throws).
- [ ] **Slices clamp, indices do not.** `resolveSlice` normalises then hands back raw
  bounds; `indexArray` clamps with `Math.max(0, start)` / `Math.min(length, stop)`
  (`runtime/indexing.ts:26`). Establish the three `RangeError`s `resolveSlice` *does*
  raise — non-integer bound, non-integer step, step ≤ 0 — and that they are about the
  slice's *shape*, never its range.
- [ ] **Multi-dimensional means left to right, not per axis.** `m[0:2, 1]` answers
  `[3, 4]`, i.e. `m[0:2][1]`, because `indexArray` reuses `current` across dims
  (`:19-35`). Establish this explicitly against the numpy reading the syntax invites —
  [Conventions § 4], the code's meaning wins. Pin with "descends dimensions left to right"
  and "applies a slice then an index to the sliced result".
- [ ] **The third implementation of the same idea.** `JSArray.getIndex` /
  `setIndex` (`js-array.ts:103-...`) wrap negatives again, in their own arithmetic, with
  the opposite out-of-range answer, and `setIndex` silently drops a write that is still
  negative. Establish this as a real duplication with a real behavioural difference —
  the honest version of "the arithmetic is shared".
- [ ] **`provenCount`: the same file, a compile-time question.** Establish the shape —
  a `Map` from operator to a function of the bound, plus `COMPLEMENT` so a negated test
  can be read as its complement — and forward-reference [Ch 13 § shift-twice]: this is
  what proves the *first* `q.shift()` and cannot prove the second.
- [ ] **Classes, at run time, are four fields and a name.** Establish that after the
  checker is done there is no class table at run time: a class is a
  `RuntimeFunctionPayload` carrying `classOwnerName`, `staticBase`,
  `classInstanceMemberVisibility`, `classStaticMemberVisibility`, `classAbstract`,
  `classConstructorVisibility`. Statics are own properties of that payload; static
  inheritance is the `staticBase` walk in `findMemberAccess`.
- [ ] **Private is owner-only; protected is a lineage walk.** Walk `memberAccessAllowed`
  and `lineageIncludesBeforeOwner`. Establish the "at or before the owner" rule with the
  three-class case it exists for, and the "no current class ⇒ denied" default
  (`:136`) that makes external access fail closed.
- [ ] **> New idea: nominality.** Establish that every comparison here is a **string**
  comparison (`ownerNameOf`, `:175-177`), so two classes that share a name share
  visibility. Connect forward: this is the same absence of runtime nominality that forces
  AOT dispatch cones to be **structural** ([Ch 57 § structural-dispatch]) — one design
  decision, two consequences, one of them a hazard.
- [ ] **Abstract is refused before visibility.** `assertConstructorAccess:43-45` throws
  `Cannot instantiate abstract class 'X'` before it looks at the constructor's visibility.
  Establish that this holds with the type checker switched off entirely — pin with "guards
  abstract class construction at runtime without typecheck".
- [ ] **Exotic 1 — the proxy opts out of maps.** `PROXY_HIDDEN_CLASS` is one shared
  object with `id: -100`, `lookupProperty()` → `null`, `hasProperty()` → `false`.
  Establish the consequence for [Ch 24 § inline-caches]: every proxy in the process has
  the same map id, so an IC keyed on `(mapId, offset)` can never usefully hit one, and the
  `isJSProxyValue` check therefore sits *before* the IC at every access site. Note the
  duck-typed escape hatch in `isJSProxyObject`.
- [ ] **Exotic 2 — collections opt out by side field.** `Map`, `Set`, `WeakMap` and the
  three primitive wrappers are ordinary `JSObject`s distinguished by *initial map*
  (`getInitialMap(INSTANCE_TYPE_*)`) with the real payload in `_mapData` / `_setData` /
  `_weakMapData` / `_primitiveValue`. Establish why this is the cheap choice — hidden-class
  identity already distinguishes them, so no tag code was spent ([Ch 22 § tag-codes]) —
  and its cost: every consumer that walks an object must special-case the side fields, and
  `gc/roots.ts` is one of them.
- [ ] **`OrderedHashMap`: insertion order is array order.** Parallel arrays, an
  `Int32Array` bucket head per chain, a `_deleted` tombstone per slot. Establish that
  `delete` never compacts (so iteration cost is proportional to *ever-inserted*, not to
  `size`), that `_isOverloaded` counts tombstones against the load factor, and that
  `_rehash` is the only thing that ever reclaims them.
- [ ] **`EphemeronHashTable` is not an ephemeron table.** The chapter's honesty
  centrepiece, and the one place [Conventions § 4] is invoked by name. Establish what it
  actually is — an open-addressed table keyed by `getHeapId(key)`, holding key and value
  in ordinary arrays — then the three consequences: values are not kept alive by live
  keys, entries are never reclaimed when keys die, and a reused handle slot aliases a dead
  entry onto a new object.
- [ ] **What a fixpoint would cost.** Sketch the real algorithm (mark values whose keys
  are proven live; repeat until quiescent), where it hooks into the marker
  ([Ch 31 § marking]), and why keying on the handle index rather than the payload object
  would have to change first.
- [ ] **What leaves.** Restate the completed read surface and hand chapter 27 the two
  reads that do not return.

## Honesty items

- [ ] > **Broken.** `src/objects/heap/js-collections.ts:249-357` `EphemeronHashTable`
  implements no ephemeron algorithm: `_keys`/`_vals` are plain arrays and `gc/roots.ts`
  never seeds them, so a `WeakMap` value is not kept alive by a live key, and entries are
  never removed when a key dies. Fixing it costs a marking fixpoint in the collector plus
  a key representation that is not a reusable handle index.
- [ ] > **Broken.** `EphemeronHashTable` keys on `getHeapId(key)`
  (`src/core/value/index.ts:1055-1060`), a value-heap **slot index**. After a sweep the
  slot is reusable, so a new object can collide with a dead entry and read another
  object's value. Cost of a fix: identity that survives a sweep — a monotonic object id —
  or registering the table with the heap so entries are cleared on sweep.
- [ ] > **Unenforced.** `src/gc/roots.ts:196-203` seeds `_mapData` and `_setData` by
  name. Any future side-field payload (a fourth collection, a new exotic) is invisible to
  the collector until someone remembers to add a branch here; nothing derives this list
  from `factory.ts`.
- [ ] > **Unenforced.** Class visibility is decided by string comparison of
  `ownerNameOf` (`src/runtime/class-access.ts:175-177`). Two classes with the same
  `classOwnerName` — in different modules, or both `<anonymous>` — are the same owner for
  `private` purposes. Nothing checks owner-name uniqueness.
- [ ] > **Unfinished.** `src/objects/exotic/proxy-ops.ts` implements three of the spec's
  proxy invariant checks (`get` ×2, `has`, `deleteProperty`). `set`, `ownKeys`,
  `getPrototypeOf` and `defineProperty` have trap dispatch but no invariant verification.
- [ ] > **Unfinished.** `src/objects/heap/js-array.ts` `setIndex` returns silently when
  an index is still negative after wrapping — a dropped write with no diagnostic, where
  the `indexValue` path would have thrown.
- [ ] Naming note per [Conventions § 4]: `PROXY_HIDDEN_CLASS` is not a hidden class — it
  is a mutable module-level singleton with a fixed `id: -100` and stub methods, shared by
  every proxy in the process. `incrementObjectCount()` on it is a no-op, so proxy
  instances are invisible to the map-statistics that [Ch 23 § map-census] reports.

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera | grep Keyed
npx vitest run --project unit tests/core/indexing.test.ts tests/runtime/indexing.test.ts
npx vitest run --project unit tests/runtime/intrinsics/collection-methods.test.ts
npx vitest run --project e2e tests/e2e/language/classes.test.ts
sed -n '196,205p' src/gc/roots.ts
```

## Tests that pin this

- `tests/core/indexing.test.ts` > "core indexing" > "normalizeIndex" > "counts a negative
  index from the end", "returns an out-of-range result rather than clamping", "rejects a
  non-integer index".
- `tests/core/indexing.test.ts` > "core indexing" > "resolveSlice" > "defaults an absent
  start to 0 and an absent stop to the length", "counts a negative start from the end",
  "leaves a negative bound negative when it underflows the length", "rejects a non-integer
  bound", "rejects a zero or negative step".
- `tests/core/indexing.test.ts` > "core indexing" > "provenCount" > "counts one more than
  a bound the count must exceed", "counts the bound itself when the count may equal it",
  "reads a negated test as its complement", "counts nothing from an operator it does not
  know".
- `tests/runtime/indexing.test.ts` > "indexValue" > "arrays" > "counts a negative index
  from the end", "clamps a slice that runs past the end", "yields an empty array when the
  range is inverted", "descends dimensions left to right", "applies a slice then an index
  to the sliced result", "returns a fresh array rather than aliasing the source", "rejects
  an out-of-bounds index", "rejects more indices than dimensions".
- `tests/runtime/indexing.test.ts` > "indexValue" > "strings" > "keeps descending because
  a single character is still a string", "rejects an index past the end of a character
  reached by descending".
- `tests/runtime/indexing.test.ts` > "indexValue" > "host objects" > "delegates to the
  _indexND hook and forwards the dimensions", "rejects an object without an indexing
  hook".
- `tests/e2e/language/classes.test.ts` > "Tera classes" > "initializes and guards private
  instance fields", "guards private methods while allowing owner calls", "allows protected
  subclass access and rejects external access", "guards private constructors but allows
  owner factories", "guards private and protected static members", "inherits static
  members through the constructor chain", "keeps static members off instances and instance
  members off the class", "guards abstract class construction at runtime without
  typecheck".
- `tests/e2e/optimizing/member-access.test.ts` > "restricted class member access agrees
  across tiers" > "keeps private instance reads guarded after warmup" — the same rules
  under baseline and JIT.
- `tests/e2e/optimizing/member-access.test.ts` > "computed string-key access matches dot
  access on a string" > "indexes a string with a negative (python-style) index".
- `tests/e2e/optimizing/generator-members-tiers.test.ts` > "members of a receiver the
  compiled lookup has to branch for" > "yields an element a negative subscript reached".
- `tests/objects/exotic/proxy-ops.test.ts` > "Proxy integration" > "get on proxy without
  trap falls through to target", "has on proxy without trap falls through to target",
  "set on proxy without trap falls through to target", "delete on proxy without trap falls
  through to target", "ownKeys on proxy without trap falls through to target".
- `tests/runtime/intrinsics/collection-methods.test.ts` > "MAP_METHODS" > "CRUD
  operations" > "set/get/has/delete lifecycle", "delete returns false for non-existent
  key"; > "iterators" > "entries yields [key, value] pairs in insertion order".
- `tests/runtime/intrinsics/collection-methods.test.ts` > "SET_METHODS" > "iterators" >
  "values and keys yield same sequence (Set spec)".
- `tests/runtime/intrinsics/collection-methods.test.ts` > "WEAKMAP_METHODS" >
  "set/get/has/delete lifecycle with object keys", "throws TypeError on non-object key",
  "different object keys are independent", "get returns undefined for missing key". Note
  what is *not* here: no test collects a key and reads the table back. [unpinned] — the
  dangling-entry behaviour in the worked example has no regression test.
