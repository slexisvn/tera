# 23. Objects: hidden classes and elements kinds   ⟨I · B · J · ~~N~~⟩

> **Status:** outline

**Thesis.** An object carries no property names at run time. It carries a *map* borrowed
from a tree that every object of the same shape shares, with the prototype baked into that
map's identity, and a flat array of slots. An array carries even less: no names at all, and
one word saying what its elements have been so far.

**What arrived.** From [Ch 22]: two tag codes, `CODE_OBJECT` and `CODE_ARRAY`, whose
payloads are a `JSObject` and a `JSArray` fetched out of the `ValueHeap` by
`getPayload`. Object identity is already settled — the same payload always yields the same
tagged value — so this chapter can talk about "the same object" without qualification.
`strictEqual` arrives too, and is the predicate `index_of` and the ICs will use.

**What leaves.** The two payload classes, opened, and the four fields chapter 24 and
[Ch 34] both need to exist before an access can be cached: a `HiddenClass` with an `id`, a
`version`, an `isDeprecated` flag, a `protoObject` and a shared `prototypeValidityCell`;
a flat `slots: StoredPropertyValue[]` addressed by integer offset; a lazily-created
`overflowProperties` map for anything past ten; and, on `JSArray`, an `elementsKind` drawn
from a six-point lattice. Also leaving, and load-bearing for [Ch 54]: two dependency keys,
`DEP_MAP` (keyed by map id and version) and `DEP_ELEMENTS_KIND` (keyed by the kind *name*,
for every array in the program at once).

**New ideas.** *Hidden class* / *map* / *shape* — one shared descriptor, many objects, and
why the engine's own name for it (`HiddenClass`, also spelled "map" in the tracer and
"HC" in the log) is used consistently here per [GLOSSARY](../GLOSSARY.md). *Transition
tree* and *memoised edge*. *Structural sharing* — why the descriptor map is deliberately
aliased between parent and child. *Back pointer*. *Offset* as a compile-time-knowable
integer, the thing every inline cache is actually caching. *Validity cell* — one shared
counter standing in for "nothing about this prototype has changed". *Lattice* and
*one-way (monotone) join* — first appearance in the book of the shape [Ch 33] and [Ch 43]
both reuse; taught here on six concrete points rather than abstractly. *Hole* — an absent
element that is not `undefined`.

**Length.** 16 pages

## Anchors

- `src/objects/maps/hidden-class.ts` — 987 lines, the chapter's centre.
  `class HiddenClassRegistry` (67-150): `nextHiddenClassId`, `allHiddenClasses`,
  `deprecatedMaps`, `migrationTargetCache`, `initialMapCache`, `root`, `getInitialMap`,
  `reset`.
  `class PropertyDescriptor` (152-196): `offset`, `kind`, `writable`, `enumerable`,
  `configurable`, and `order` — which starts equal to `offset` and then diverges.
  `class HiddenClass` (249-915): the twenty-two fields, the constructor's two branches
  (311-346), `_ownEntries` (350-356), `properties` (358-360), `transition` (483-504),
  `transitionToPrototype` (506-526), `transitionWithAttributes` (528-583),
  `deleteProperty` (585-620), `transitionToPreventExtensions` / `transitionToSealed` /
  `transitionToFrozen` (622-703), `lookupProperty` (705-709), `invalidate` (375-389),
  `deprecate` (391-407), `_buildMigrationTarget` (409-451), `checkStability` (470-481).
  Constants: `MAX_TRANSITIONS_BEFORE_UNSTABLE = 32`, `MAX_DEPRECATIONS_BEFORE_FREEZE = 5`
  (20-21); the seven `INSTANCE_TYPE_*` strings (944-950).
- `src/objects/heap/js-object.ts` — 626 lines. `MAX_IN_OBJECT_PROPERTIES = 10` and
  `SLACK_TRACKING_CALL_COUNT = 7` (38-39); `class AccessorPair` (82-90);
  `StoredPropertyValue = TaggedValue | AccessorPair | undefined` and the `dataValue`
  filter (72-80); `class JSObject` (92-584) — `hiddenClass`, `slots`,
  `overflowProperties`, `constructorRef`, `symbolProperties`, `gcHeader`;
  `lookupPrototypeChain` (173-210) returning `{found, value, owner, descriptor, depth}`;
  `setProperty` (306-351), `deleteProperty` (353-406), `defineProperty` (408-462),
  `migrateInstance` (234-282), `setPrototype` (162-167),
  `invalidatePrototypeDependents` (216-226), `getPropertyByOffset` /
  `setPropertyByOffset` (490-521). `presizeInstanceSlots` and `recordConstruction`
  (586-618) are the slack tracker.
- `src/objects/heap/js-array.ts` — 504 lines. `elements`, `elementsKind`, `hiddenClass`,
  `slots`, `overflowProperties` (46-64); `getIndex` / `setIndex` (100-140) — note
  `makesHole = index > oldLength` and the negative-index wrap; `setLength` (154-174);
  `push` (176-194), `unshift` (208-225), `splice` (227-265) — the five sites that call
  `dependencyRegistry.invalidate(DEP_ELEMENTS_KIND, …)`; `getElementsKind` (438-440);
  `getProperty` / `setProperty` (442-489), the array's *named* properties, which do go
  through a hidden class.
- `src/objects/elements/elements-kind.ts` — 80 lines, the whole lattice.
  `PACKED_SMI`/`PACKED_DOUBLE`/`PACKED_TAGGED`/`HOLEY_SMI`/`HOLEY_DOUBLE`/`HOLEY_TAGGED`,
  `isHoleyElementsKind`, `makeHoleyElementsKind`, `classifyElementValue`,
  `mergeElementsKind` (43-68 — the join, written as three `if`s), `inferElementsKind`.
- `src/objects/heap/factory.ts` — 127 lines. `bindGC` / `withGC`, `createJSObject`,
  `allocateInstance` (66-76 — where `prototypeObj` is created on demand and
  `presizeInstanceSlots` is applied), `createJSArray`, `createJSMap` / `createJSSet` /
  `createJSWeakMap` / `createJSPrimitiveWrapper` (the four `getInitialMap` users),
  `createJSProxy`.
- `src/deopt/dependencies.ts` — `DEP_MAP`, `DEP_PROTO_VALIDITY`, `DEP_ELEMENTS_KIND` and
  `dependencyRegistry.invalidate`. Named here, opened in [Ch 54].
- `src/runtime/builtins/index.ts:813-865` — `Object.freeze`, `Object.is_frozen`,
  `Object.seal`, `Object.is_sealed`, `Object.preventExtensions`, `Object.isExtensible`.
  These are the *only* way tera source reaches integrity, and they do not use the
  transitions above. See the honesty items.
- `tests/objects/maps/hidden-class.test.ts` — 364 lines, the transition tree's spec.
- `tests/objects/heap/js-object.test.ts`, `tests/objects/heap/js-array.test.ts`,
  `tests/objects/elements/elements-kind.test.ts`.

## Worked example

`docs/example/stats.tera` builds the tree: two `Series` instances, one shared shape, and
every property IC in the file resolving against one map, `HC89`. Read the two views
together and say what each is counting — `--stats` reports `"hc_transitions": 88` for the
whole *process*, while `--trace` prints only the four add-transitions and one prototype
transition that fire after the tracer is armed; the other 83 belong to engine setup, and
the chapter says so rather than implying the program made them:

```bash
node dist/cli.js --trace docs/example/stats.tera | grep -E '^\[HC\]|^\[HIDDEN-CLASS\]'
node dist/cli.js --stats docs/example/stats.tera | grep -E 'hc_transitions|ic_hits|deprecatedMaps'
```

The spine cannot re-prototype anything, so the chapter's centrepiece is the program the
class suite already runs — the one that answers **512**:

```bash
printf 'class A:\n  constructor(n):\n    this.n = n\n  v():\n    return 1\nclass B extends A:\n  constructor(n):\n    super(n)\n  v():\n    return 2\na = A(5)\nb = B(9)\nbefore = a.v()\nObject.setPrototypeOf(a, Object.getPrototypeOf(b))\nprint(a.n * 100 + before * 10 + a.v())\n' > /tmp/reproto.tera
node dist/cli.js /tmp/reproto.tera
node dist/cli.js --trace /tmp/reproto.tera | grep proto
```

`a` already has `n` when its prototype is replaced, so the trace shows
`[HIDDEN-CLASS] HC88 --proto--> HC91` — a *populated* map forking on the prototype, with
`n`'s descriptor carried across. `a.n` is still `5` (hence `500`), `before` is `1` (hence
`10`), and `a.v()` now dispatches to `B`'s method (hence `2`).

Then the counterfactual, which is the chapter's "why the obvious design fails" beat: give
each object a `prototype` pointer of its own and keep the map for names only. `A` and `B`
instances have identical shapes, so they would share one map, and an inline cache keyed on
that map would dispatch `a.v()` and `b.v()` to the same method. `tests/objects/maps/
hidden-class.test.ts > "separates identical shapes carrying different prototypes"` is the
test that fails under that design and passes under this one.

## Outline

- [ ] **§ hidden-classes — What an object is.** Walk `JSObject`'s six fields and stop on
      what is *absent*: no name, anywhere. Establish the trade the whole part is built on —
      names are paid for once per *shape* instead of once per *object*, and reading a
      property becomes `slots[offset]` where `offset` came from a table lookup that an
      inline cache can skip. Introduce the vocabulary the tracer already prints (`HC0`,
      `HC89`) and fix it against [GLOSSARY](../GLOSSARY.md): *map*, *hidden class* and
      *shape* are the same thing here; a *class-table entry* in [Ch 57] is not.
      Establish the four fields [Ch 34] will re-check on every cache hit — `id`, `version`,
      `isDeprecated`, `protoObject` — and say so explicitly, because that is the contract
      this chapter owes forward.
- [ ] **§ the-transition-tree.** `transition(name)`: check `integrityLevel`, look for a
      memoised edge in `this.transitions`, else construct a child and store the edge.
      Establish that the tree is *shared and permanent* — the edge is cached on the parent,
      so the second `Series` walks exactly the path the first one built and fires no new
      transition at all — five `[HC]`/`[HIDDEN-CLASS]` lines cover both instances. Then the
      shape of the
      tree from the trace: `HC0 --"mean"--> HC85`, `HC85 --"label"--> HC86`, and the
      separate `HC87 → HC88 → HC89` chain for instances. Establish the ordering consequence
      with the two tests that pin it: same names in a different order is a *different* map.
      Close on `checkStability` and `MAX_TRANSITIONS_BEFORE_UNSTABLE = 32`: a map that
      sprouts more than 32 children stops being `isStable`, and past 64 it deprecates
      itself.
- [ ] **§ the-shared-descriptor-map.** The hardest twenty lines in the file
      (`hidden-class.ts:318-332`). On an *add* transition the child does **not** copy the
      parent's descriptors — it takes the parent's `_descMap` object by reference, writes
      its own entry into it, and sets `parent._sharedExtended = true`. Establish the
      invariant that makes that safe: **a descriptor belongs to a map only if
      `desc.order < map.propertyCount`**, enforced in exactly one place, `_ownEntries`
      (350-356), which `properties`, `getPropertyNames` and `lookupProperty` all go
      through. So the parent keeps seeing its own prefix while the child sees one more.
      Then the fork rule: the *second* child of the same parent finds `_sharedExtended`
      already true and pays for a real copy, filtered by the same `order` test. Establish
      why this design exists — a linear chain of *n* properties costs one map object per
      step and one descriptor map total, not *n* — and pin it with the four tests that
      probe siblings and forks. This is the section a reader must not skim: every later
      "the map says offset 1" claim rests on it.
- [ ] **§ offsets-back-pointers-and-delete.** `parent` is the back pointer;
      `getTransitionPath` and `getRoot` walk it. Offsets are assigned as
      `this.propertyCount` at add time and never move — *except* on delete.
      `HiddenClass.deleteProperty` (585-620) forks a child through the non-add branch (so
      every descriptor is cloned), removes the key, then re-sorts the survivors by `order`
      and rewrites both `offset` and `order` to a dense `0..n-1`. Establish the cost that
      falls out of it: `JSObject.deleteProperty` (353-406) has to rebuild the whole `slots`
      array, reading each surviving value out of the *parent* map's offset and writing it
      to the child's — and `oldHC.invalidate("delete:x")` bumps the version, so every IC on
      that map misses. State the rule: delete is not a property operation in this engine,
      it is a reshape.
- [ ] **§ prototype-is-part-of-map-identity.** The chapter's thesis sentence.
      `protoObject` is a field *on the map*, inherited by every child (292), and
      `transitionToPrototype` (506-526) is a first-class transition with its own memo table
      (`prototypeTransitions`, keyed by the prototype object itself). Establish the three
      consequences in order: two objects with the same names but different prototypes get
      different maps and therefore never share an IC entry; a map re-prototyped *after* it
      has properties keeps every descriptor, because the non-add constructor branch clones
      them (worked example, `HC88 --proto--> HC91`); and the new map gets a **fresh**
      `prototypeValidityCell` (516) while ordinary children *share* the parent's (316).
      Then the validity cell itself: one counter, bumped by `invalidate` and by
      `JSObject.invalidatePrototypeDependents`, standing in for "no prototype on this chain
      has changed" so an IC does not have to re-walk the chain. Note the asymmetry
      `setPropertyByOffset` introduces — it only invalidates when
      `hiddenClass.isPrototypeMap` is set, and that flag is set only by
      `transitionToPrototype` (507).
- [ ] **§ why-the-obvious-design-fails — a prototype pointer per object.** Stage the
      design a reader would write first: `JSObject.prototype` as an own field, maps for
      names only. It is smaller, it makes `setPrototypeOf` O(1) with no new map, and it is
      wrong: `A` and `B` instances in the worked example have identical shapes, so they
      share a map, and an inline cache that says "map 89 ⇒ offset 1" would hand `b.v()` the
      method it cached for `a`. Show the failing test by title and the passing behaviour
      (512). Establish the general rule the book reuses in [Ch 57]: *whatever dispatch is
      keyed on must be part of the key*.
- [ ] **§ ten-in-object-slots.** `MAX_IN_OBJECT_PROPERTIES = 10`. Offsets `0..9` live in
      the flat `slots` array; everything from 10 up lives in `overflowProperties`, a
      `Map<string, StoredPropertyValue>` that is `null` until the first overflow (lazy —
      four tests pin that). Establish that the hidden class keeps assigning offsets past 10
      regardless, so the *descriptor* is uniform and only the *storage* forks, which is why
      `getPropertyByOffset` has two branches and why an IC handler must know which side of
      10 it is on. Name the eleven places in `js-object.ts` that repeat the
      `offset < MAX_IN_OBJECT_PROPERTIES` test, and the one place that does not
      (`lookupPrototypeChain:180` compares against `slots.length` instead) — an
      `> **Unenforced.**` invariant, below.
- [ ] **§ accessors-share-the-slot.** `StoredPropertyValue` is
      `TaggedValue | AccessorPair | undefined`: a getter/setter pair is stored *in the same
      slot* a data property would use, and the descriptor's `kind` is the only thing that
      says which. Establish the filter this forces everywhere — `dataValue()` strips
      `AccessorPair` so `getProperty` can keep its `TaggedValue` return type — and the
      three consequences: `getProperty` on an accessor answers `undefined`,
      `visitReferences` skips accessor slots entirely so a getter closure is *not* traced
      as a reference from the object ([Ch 32]), and [Ch 24]'s `handleLdaProp` must check
      `desc.kind === "accessor"` *before* it consults the inline cache.
- [ ] **§ integrity-levels.** `transitionToPreventExtensions` → `transitionToSealed` →
      `transitionToFrozen` are real edges on the tree, chained in that order, each marking
      the child's descriptors and setting `integrityLevel` — which `transition()` and
      `transitionWithAttributes()` then read as a hard stop. Walk the design, then deliver
      the honesty item: **none of it is reachable from tera source.** `Object.freeze` sets
      a boolean on the payload instead, `handleStaProp` checks that boolean, and
      `delete o.x` — which consults the descriptor, not the boolean — succeeds on a frozen
      object. Reproduce it. Establish the general rule: two mechanisms for one property is
      one mechanism too many, and the tell is that only one of them is on the read path.
- [ ] **§ slack-tracking.** `recordConstruction` and `presizeInstanceSlots`
      (`js-object.ts:586-618`) plus `SLACK_TRACKING_CALL_COUNT = 7`. The constructor
      payload carries `slackCounter`, `slackExpectedProperties` and
      `slackTrackingComplete`; the first seven instances *teach* the constructor how many
      in-object slots its instances end up using, later instances are pre-sized to that
      number in one allocation, and every instance is trimmed to what it actually used.
      Establish what this buys (no repeated `slots.push(undefined)` growth per field) and
      what bounds it (`inObjectUsed` is capped at 10, so a wide object learns 10 and stops).
      Six tests pin the whole loop, including the cap.
- [ ] **§ deprecation-and-migration.** A map that transitions too much is *deprecated*:
      `deprecate` builds a migration target by replaying the property list onto a fresh
      root — cached by a string key of every descriptor's attributes *plus* the prototype
      (`migrationTargetCache` is keyed by `protoObject` first) — and registers it in
      `registry.deprecatedMaps`. Instances migrate **lazily**, on the next
      `storedProperty`/`setProperty`/`lookupPrototypeChain` that sees `isDeprecated`.
      Establish the one detail that makes migration correct and non-obvious:
      `migrateInstance` (234-282) copies values **by name**, looking each name's *old*
      offset up in the old map and writing it to the *new* map's offset — because the two
      maps agree on names and need not agree on offsets. Then the observable: `--stats`
      reports `deprecatedMaps` and `migrations.totalMigrations`, both `0` for `stats.tera`.
- [ ] **§ elements-kinds — six points and a one-way join.** An array has no names for its
      elements and no descriptors: it has `elements: Array<TaggedValue | undefined>` and
      one string, `elementsKind`. Introduce the lattice as a diagram (`mermaid`), three
      value grades × packed/holey, and `mergeElementsKind` as its join: three `if`s that
      can only ever move *up*. `> **New idea.**` primer on a lattice and a monotone join
      goes here, on six concrete points, and [Ch 33] and [Ch 43] refer back to it.
      Establish the two asymmetries the tests name: TAGGED never downgrades, and *holey is
      sticky* — once `isHoleyElementsKind` is true every later join keeps it, and nothing
      in the file ever un-holeys an array. Then how a hole is actually made: `setIndex`
      with `index > oldLength` (strictly greater — writing at exactly `length` appends),
      and `setLength` growing. Note the two operations that create no hole and change no
      kind: `pop` and `shift`.
- [ ] **§ where-elements-kind-is-invalidated.** Five call sites — `setIndex`, `setLength`,
      `push`, `unshift`, `splice` — each doing
      `dependencyRegistry.invalidate(DEP_ELEMENTS_KIND, oldKind, null, …)`. Establish the
      thing a reader will get wrong if nobody says it: **the dependency key is the kind
      *name*, not the array.** One string pushed into one `float[]` invalidates every
      optimized function in the program that assumed `PACKED_DOUBLE`, for any array at all.
      Show it end to end with `stats-deopt.tera`, whose trace prints
      `Dependency registered: total_of -> elements-kind:PACKED_DOUBLE` and then
      `DEOPT "total_of": elements-kind-check-failed at bytecode:8`. Establish the trade
      (coarse keys mean no per-object bookkeeping and no write barrier on the kind, at the
      price of collateral deopts) and hand the mechanism to [Ch 54].
- [ ] **§ arrays-are-not-objects.** Close on the handover. `JSArray` has a `hiddenClass`,
      but only for *named* properties — `length` is intercepted before the map is
      consulted, indices never reach it at all, and `keys()` lists indices first and named
      properties after. `JSArray` has no `protoObject` and no prototype chain: its methods
      come from `builtinPrototypes.arrayPrototype` by a different route entirely.
      Establish precisely what chapter 24 may and may not assume: `this.values` is an
      object access that ends in a map and an offset; `values.length` is not, and has to be
      answered somewhere else. That "somewhere else" is [Ch 25].

## Honesty items

- > **Never runs.** `JSObject.freeze()`, `JSObject.seal()` and
  `JSObject.preventExtensions()` (`src/objects/heap/js-object.ts:547-569`) have no caller
  anywhere in `src/`. The tera builtins `Object.freeze` / `Object.seal` /
  `Object.preventExtensions` (`src/runtime/builtins/index.ts:813-857`) set the boolean
  fields `_frozen` / `_sealed` / `_nonExtensible` on the payload instead. Consequently
  `HiddenClass.transitionToPreventExtensions`, `transitionToSealed` and
  `transitionToFrozen`, the `integrityTransitions` map, the `INTEGRITY_*` levels and the
  `integrityLevel` guard at the top of `transition()` are reachable only from
  `tests/objects/maps/hidden-class.test.ts` and `tests/objects/heap/js-object.test.ts`.
  Finishing it is three lines — have the builtins call the `JSObject` methods — plus
  deciding what to do about `Object.isExtensible`, which reads the flags.
- > **Broken.** Because of the above, `delete o.x` succeeds on a frozen object.
  `handleDeleteProp` (`src/bytecode/register/interpreter/handlers.ts:689-709`) routes to
  `runtimeDeleteProperty`, which consults `desc.configurable`; the descriptor is still
  configurable because no integrity transition ever ran. Reproduce:
  `Object.freeze(o); delete o.x; print(o.x)` prints `undefined` while
  `Object.is_frozen(o)` is `true`. `handleDeleteProp` also discards the boolean
  `runtimeDeleteProperty` returns and unconditionally answers `true`, so the failure is
  invisible to the program either way. `[unpinned]` — no test covers freeze-then-delete.
- > **Broken.** `HiddenClassRegistry.getInitialMap` (`hidden-class.ts:92-99`) stores its
  pseudo-transition under the key `` `@@${instanceType}` `` in `root.transitions` — the
  same map that ordinary property names transition through. A plain object that gains a
  property literally named `@@JS_MAP` after any `Map` has been constructed therefore
  transitions to the `Map` instance's initial map: the assigned value is silently dropped
  (the new map's `propertyCount` is 0, so `lookupProperty` refuses it and `setProperty`
  returns `false`), and the object now claims `instanceType === "JS_MAP"`, so
  [Ch 24]'s `size` fast path dereferences a missing `_mapData` and the process exits 1
  with a raw host message, `Cannot read properties of undefined (reading 'size')`.
  Reproduce with the four-line probe in "Verify it yourself". Finishing it costs a separate
  `Map` for instance-type edges, or a key character that the lexer cannot produce.
  `[unpinned]`
- > **Dead.** `class DescriptorArray` (`hidden-class.ts:198-247`) — a complete, versioned,
  cloneable, iterable descriptor collection with no consumer in `src/` at all. The real
  storage is the plain `_descMap: Map<string, PropertyDescriptor>` on `HiddenClass`. It has
  two tests, so it is maintained. Finishing it means either routing `_descMap` through it
  (which would give the `descriptorVersion` field a real owner) or deleting both.
- > **Dead.** `HiddenClass.tryDeprecate` (458-468), and with it `deprecationCount` and
  `MAX_DEPRECATIONS_BEFORE_FREEZE = 5`. No caller in `src/`, `tools/` or `tests/`. The
  "five deprecations then freeze" policy those three symbols describe is not the policy the
  engine runs — `checkStability` deprecates directly at
  `MAX_TRANSITIONS_BEFORE_UNSTABLE * 2`.
- > **Dead.** `HiddenClass.markUnstable` (370-373), `getStatistics` (896-914) and
  `getTransitionMetadataPath` (738-752): no caller anywhere, including tests.
  `checkStability` sets `isStable = false` inline instead of calling `markUnstable`, so the
  version bump `markUnstable` performs never happens on that path.
- > **Never runs.** `HiddenClass.dump` (847-894), `collectTransitionTree` and
  `_buildTreeLines`: reachable, but only from three lines in
  `tests/objects/maps/hidden-class.test.ts`. Nothing in the CLI, the tracer or
  `tools/visualizer` prints a transition tree, which is the one diagnostic this chapter
  most wants and cannot show.
- > **Unenforced.** `MAX_IN_OBJECT_PROPERTIES = 10` is declared twice — `js-object.ts:38`
  and `js-array.ts:38` — and compared against in eleven places, none of which share a
  helper. `JSObject.lookupPrototypeChain:180` breaks the pattern: it tests
  `desc.offset < current.slots.length` rather than against the constant, so it depends on
  `slots` never being longer than 10 (which `recordConstruction`'s trim currently
  guarantees) and on the overflow entry never being host-`undefined` (which
  `migrateInstance:268` can violate for a name the old map did not carry). No test
  distinguishes the two conditions.
- > **Unenforced.** `JSArray.getProperty("length")` (`js-array.ts:443`) returns a raw host
  `number`, not a `TaggedValue`; the declared return type
  `TaggedValue | number | undefined` says so out loud. Both current callers
  (`memberLookupValue`'s `arrayMember` and `runtimeGetProperty`) happen to intercept
  `"length"` before they get there, so the untagged value never escapes — by coincidence,
  not by construction. A third caller would ship a bare `5` into the tagged world, where
  `getTag(5)` answers `"double"`.

## Verify it yourself

```bash
node dist/cli.js --trace docs/example/stats.tera | grep -E '^\[HC\]|^\[HIDDEN-CLASS\]' | head -12
node dist/cli.js --stats docs/example/stats.tera | grep -E 'hc_transitions|ic_hits|deprecatedMaps'
printf 'class A:\n  constructor(n):\n    this.n = n\n  v():\n    return 1\nclass B extends A:\n  constructor(n):\n    super(n)\n  v():\n    return 2\na = A(5)\nb = B(9)\nbefore = a.v()\nObject.setPrototypeOf(a, Object.getPrototypeOf(b))\nprint(a.n * 100 + before * 10 + a.v())\n' > /tmp/reproto.tera
node dist/cli.js --trace /tmp/reproto.tera | grep -E 'proto|^512'
printf 'o = { x: 1 }\nObject.freeze(o)\no.x = 2\nprint(o.x)\nprint(Object.is_frozen(o))\ndelete o.x\nprint(o.x)\n' > /tmp/frozen.tera
node dist/cli.js /tmp/frozen.tera
printf 'm = Map()\nm.set(1, 2)\no = {}\no["@@JS_MAP"] = 7\nprint(o["@@JS_MAP"])\nprint(o.size)\n' > /tmp/collide.tera
node dist/cli.js /tmp/collide.tera; echo "exit=$?"
node dist/cli.js --trace docs/example/stats-deopt.tera | grep -E 'DEOPT|elements-kind'
npx vitest run --project unit tests/objects/maps/hidden-class.test.ts tests/objects/heap/js-object.test.ts tests/objects/heap/js-array.test.ts tests/objects/elements/elements-kind.test.ts
```

## Tests that pin this

- `tests/objects/maps/hidden-class.test.ts > "transition creates child with new property"`,
  `> "same property name reuses existing transition"`,
  `> "different properties create different children"`,
  `> "chained transitions accumulate properties"`,
  `> "property offsets increment sequentially"` — the tree and its memoised edges.
- `tests/objects/maps/hidden-class.test.ts > "an intermediate class does not see properties added by its descendants"`,
  `> "sibling branches from a shared prefix do not leak properties"`,
  `> "a forked branch preserves the shared-prefix offsets"`,
  `> "keeps a long linear chain consistent"` — the four tests that pin the shared
  `_descMap` and the `order < propertyCount` truncation. If § the-shared-descriptor-map is
  wrong, these are the tests that say so.
- `tests/objects/maps/hidden-class.test.ts > "deleteProperty removes property and reindexes offsets"`,
  `> "deleteProperty returns null for non-configurable"`,
  `> "deleteProperty on missing property returns self"`.
- `tests/objects/maps/hidden-class.test.ts > "separates identical shapes carrying different prototypes"`
  — the counterfactual's failing test.
  `> "shares one map across instances of the same prototype and shape"`,
  `> "carries the prototype through later property transitions"`,
  `> "preserves descriptors when the prototype changes after properties exist"`,
  `> "returns the same map when transitioning to the prototype already held"`.
- `tests/objects/maps/hidden-class.test.ts > "marks parent unstable after exceeding transition threshold"`,
  `> "single transition does not mark parent unstable"`,
  `> "stays stable below transition threshold"`,
  `> "excessive transitions trigger deprecation on the transitioning HC"`,
  `> "deprecate builds migration target with same properties"`,
  `> "deprecate is idempotent"`, `> "migration target preserves integrity level"`,
  `> "deprecated map is findable via global helpers"`.
- `tests/objects/maps/hidden-class.test.ts > "preventExtensions blocks new transitions"`,
  `> "seal makes all properties non-configurable"`,
  `> "freeze makes all data properties non-writable and non-configurable"`,
  `> "freeze chains through preventExtensions and sealed"`,
  `> "repeated integrity call returns same cached transition"` — the integrity machinery,
  and the only place it runs.
- `tests/objects/heap/js-object.test.ts > "objects with same property order share hidden class"`
  and `> "different property order produces different hidden class"`.
- `tests/objects/heap/js-object.test.ts > "first 10 properties stored in slots, rest in overflow"`,
  `> "overflowProperties is null on fresh object"`,
  `> "overflowProperties stays null with fewer than 10 properties"`,
  `> "overflowProperties created lazily when exceeding 10 slots"`,
  `> "pre-allocates slots array from hidden class propertyCount"`.
- `tests/objects/heap/js-object.test.ts > "learns the expected in-object property count from constructions"`,
  `> "pre-sizes a later instance to the learned count before any property is set"`,
  `> "freezes tracking after the construction-count threshold"`,
  `> "trims slack from an instance that uses fewer properties than learned"`,
  `> "preserves property values across pre-size and trim"`,
  `> "caps the learned count at the in-object limit for wide objects"` — slack tracking,
  all six.
- `tests/objects/heap/js-object.test.ts > "hides accessor pairs from getProperty, which reads data only"`
  — the `dataValue` filter.
- `tests/objects/heap/js-object.test.ts > "deprecated hidden class triggers migration on getProperty"`
  and `> "migration preserves all property values"` — lazy migration.
- `tests/objects/heap/js-object.test.ts > "skip invalidation for fresh single-object hidden class"`
  and `> "invalidates when hidden class has enough remaining objects"` — the
  `oldHC.objectCount > 1` guard in `setProperty`.
- `tests/objects/heap/js-object.test.ts > "lookupPrototypeChain finds inherited property"`,
  `> "own property shadows prototype property"`, `> "multi-level prototype chain"`.
- `tests/objects/elements/elements-kind.test.ts > "never downgrades from TAGGED"`,
  `> "never downgrades from DOUBLE to SMI"`, `> "holey is sticky even without makesHole"`,
  `> "makesHole flag transitions packed to holey"`,
  `> "holey + type promotion combines both"` — the one-way join, stated five ways.
- `tests/objects/elements/elements-kind.test.ts > "empty array -> PACKED_SMI"`,
  `> "mixed smi and double -> PACKED_DOUBLE"`, `> "any tagged value -> PACKED_TAGGED"`,
  `> "undefined holes transition to holey"`.
- `tests/objects/heap/js-array.test.ts > "getIndex/setIndex round-trip, fills holes with undefined"`,
  `> "extends with undefined when new length is longer"`,
  `> "skips holes but keeps explicit undefined elements"`,
  `> "does not list length as a key"`,
  `> "setProperty/getProperty for non-length named props via hidden class transitions"`.
- `tests/e2e/language/classes.test.ts > "reroutes dispatch when the prototype is replaced on a populated instance"`
  — the worked example, and the source of the number 512.
- No unit test covers `DEP_ELEMENTS_KIND`'s coarse keying (that one array's promotion
  invalidates every function that assumed the kind). It is observable only end to end,
  through `stats-deopt.tera`. `[unpinned]`
