# 34. Inline caches   ⟨I · B⟩

> **Status:** outline

**Thesis.** There is no global cache invalidation in this engine: every cached handler
re-checks map id, map version and deprecation on each hit, and absence is a stronger claim
than presence.

**What arrived.** From [Ch 33 § slots-are-operands], a feedback slot index on every
property, index and call instruction — and from [Ch 23 § hidden-classes], objects that
carry a `HiddenClass` with an `id`, a `version`, an `isDeprecated` flag, a `protoObject`
and a shared `prototypeValidityCell`.

**What leaves.** An `InlineCacheManager` holding one `InlineCache` per site key
`funcName#fnId:slot`, each a five-way bundle (load / store / element-load / element-store /
call) whose entries are *handlers* — small objects that answer `matches(obj)` and
`execute(obj)`. The optimizer does not read these; it reads the vector. What leaves for
the *program* is speed, and for [Ch 54 § deopt-triggers] a `dependencyRegistry`
invalidation on a monomorphic call miss.

**New ideas.** *Inline cache* (the name is historical: the cache is not inline in the
instruction stream here, it is a side map keyed by site); *handler chain*; *validity cell*;
*negative caching* — the idea that "this property is absent" is a cacheable fact, and a
harder one to keep true than "this property is at offset 3".

**Length.** 14 pages

## Anchors

- `src/feedback/ic/index.ts` — the whole chapter.
  - Constants: `MAX_POLY_ENTRIES = 8`, `MAX_ELEMENT_POLY_ENTRIES = 4`,
    `MONOMORPHIC_JIT_THRESHOLD = 100`, `DOMINANT_HANDLER_RATIO = 0.8`,
    `SETTLED_CALL_THRESHOLD = 100`.
  - Handlers: `FieldHandler` (abstract, owns `matches`), `LoadFieldHandler`,
    `StoreFieldHandler`, `TransitionStoreHandler`, `ProtoLoadFieldHandler`,
    `MissingPropertyHandler`, `LoadElementHandler`, `StoreElementHandler`, `CallHandler`.
  - Chain helpers: `captureProtoChain`, `protoChainMatches` and its `requireEnd` parameter.
  - Sites: `SiteInlineCache` (abstract, owns `invalidate`), `ElementSiteInlineCache`,
    `PropertySiteInlineCache` (`monomorphicSinceCount`, `jitCandidate`, `isSettled`),
    `PropertyLoadIC.lookup` / `_miss`, `PropertyStoreIC.store` / `_miss`,
    `ElementLoadIC.lookup` / `_miss`, `ElementStoreIC.store` / `_miss` /
    `_refreshTransition`, `CallIC.lookup` / `_miss` / `_addEntry`.
  - Entries: `ICEntry`, `ElementICEntry`, `CallICEntry`.
  - Fallback: `MegamorphicCache` with its four maps and `getLoad` / `setLoad` /
    `deleteLoad`.
  - Bundle and manager: `InlineCache`, `InlineCacheManager` (`getOrCreate`,
    `registerHiddenClassUsage`, `invalidateForHiddenClass`, `invalidateDeprecatedMaps`,
    `flush`, `collectStats`, `reportPolymorphism`, `getJitCandidates`).
  - Tracing: `siteTraceId`, `kindTraceId`, `targetTraceId` — the string site key is hashed
    to a number for `--trace-ic`, which is why the trace shows `Site #2846148340`.
- `src/objects/maps/hidden-class.ts` — `HiddenClass.id`, `.version`, `.isDeprecated`,
  `.migrationTarget`, `.protoObject`, `.prototypeValidityCell` (shared with the parent on
  transition), `lookupProperty`, `transitionToPrototype`.
- `src/objects/heap/js-object.ts` — `JSObject.prototype` (a getter that reads
  `hiddenClass.protoObject`), `lookupPrototypeChain` and its `depth`,
  `getPrototypeValidityVersion`, `invalidatePrototypeDependents`, `needsMigration`,
  `migrateInstance`, `getPropertyByOffset`, `setPropertyByOffset`.
- `src/bytecode/register/ops/bytecode.ts` — `getICKey`, the `_icKeys` memo, and the key
  format `` `${funcName}#${id}:${slot}` ``.
- `src/bytecode/register/interpreter/handlers.ts` — `handleLdaProp`, `handleStaProp`,
  `handleLdaIndex`, `handleStaIndex`: where the interpreter reaches the manager, and the
  accessor early-outs that route *around* the cache.
- `src/optimizing/baseline/runtime.ts` — `gp`, `sp`, `gi`, `si`, `invokeCall`: the second
  client, with its own per-slot `loadCaches` / `storeCaches` sitting *in front of* the
  shared IC ([Ch 36 § runtime-surface]).
- `src/deopt/dependencies.ts` — `dependencyRegistry.invalidate`, `DEP_CALL_TARGET`,
  `DEP_MAP`, `DEP_PROTO_VALIDITY`: the bridge from an IC miss to a JIT deoptimization.
- `src/api/engine.ts` — `runAgingCycle`, the only caller of
  `icManager.invalidateDeprecatedMaps`.

## Worked example

`docs/example/stats-poly.tera`. `report(s)` takes an untyped parameter and is handed a
`Series` and then a `Constant` — two classes with the same member names and different
shapes, so `report`'s `label` load site goes monomorphic and then misses.

```
node dist/cli.js --trace-ic docs/example/stats-poly.tera
```

The centrepiece is not in the example, because `stats-poly.tera` has no shared prototype
that changes underneath a receiver. The chapter takes it from the unit test instead:
`tests/feedback/ic.test.ts > "misses a same-map receiver carrying a different prototype"` —
two receivers with the *same* map id and different prototype objects, which a map-only
cache answers wrongly and `MissingPropertyHandler.matches` answers correctly.

## Outline

- [ ] **§ what-a-cache-here-is** — `> **New idea.**` primer: an inline cache remembers, per
  *program point*, what the last receiver looked like and where the answer was, so the
  second execution skips the lookup. Establish that in this engine the cache is a side map
  keyed by a string, not bytes patched into the instruction stream, and that the name is
  kept anyway ([CONVENTIONS.md] §4). Establish the key: `getICKey` builds
  `funcName#fnId:slot` once per function and memoises it in `_icKeys`, so the *identity* of
  a site is (function object, feedback slot) — the same pairing [Ch 33] allocated.
- [ ] **§ the-five-caches-behind-one-site** — Establish `InlineCache` as a bundle:
  `loadIC`, `storeIC`, `elementLoadIC`, `elementStoreIC`, `callIC`, all sharing one
  `MegamorphicCache`. Establish the sub-site key suffixes (`:load`, `:store`,
  `:element-load`, `:element-store`, `:call`) and that `InlineCache.state` reports the
  first non-uninitialized sub-cache in a fixed order — a reporting convenience with no
  semantics.
- [ ] **§ lookup-line-by-line** — Walk `PropertyLoadIC.lookup` in full: the deprecated-map
  migration and self-`invalidate` at the top; the monomorphic path (id compare, then
  `handler.matches(obj)`, then `monomorphicSinceCount` and the `jitCandidate` flip at 100);
  the polymorphic scan; the megamorphic path, which re-checks `matches` and *deletes* the
  entry on failure rather than replacing it. Establish the one asymmetry worth naming: a
  `MissingProperty` hit returns `{ hit: false, value: undefined }` — the cache hit, the
  *lookup* did not.
- [ ] **§ what-each-handler-verifies** — One table, one row per handler class, one column
  per thing `matches()` checks:
  - `LoadFieldHandler` / `StoreFieldHandler` (via `FieldHandler.matches`) — map id, map
    version, `!isDeprecated`. Three checks, no prototype involvement.
  - `TransitionStoreHandler` — `oldHiddenClassId`, `oldMapVersion`, `!isDeprecated`; it
    stores through `setProperty`, letting the map transition happen again.
  - `ProtoLoadFieldHandler` — seven checks; § the-two-prototype-handlers.
  - `MissingPropertyHandler` — four, one of which is a whole-chain walk.
  - `LoadElementHandler` / `StoreElementHandler` — nothing. They have no `matches` at all;
    the *entry* compares `elementsKind`.
  - `CallHandler` — target id, target version, arg count, and (for a method call) receiver
    map id and version.
- [ ] **§ the-two-prototype-handlers** *(the centrepiece)* — Establish why a prototype hit
  is the hard case: the value lives on an object the receiver does not own, and three
  different things can change under it. Walk `ProtoLoadFieldHandler`'s constructor — it
  snapshots `receiverMapId`, `receiverMapVersion`, `protoMapId`, `protoMapVersion`,
  `validityVersion`, the `protoObject` reference itself, and `receiverProtoChain =
  captureProtoChain(receiver, depth)` — and then its `matches`, which re-checks all seven.
  Establish that `protoChainMatches` compares links by **object identity** (`current !==
  link.object`) before comparing ids, so two structurally identical prototypes are not
  interchangeable. Establish the validity cell as the *cheap* signal: one shared counter
  per map family, bumped by `JSObject.invalidatePrototypeDependents`, which also tells the
  JIT via `DEP_PROTO_VALIDITY`.
- [ ] **§ absence-is-a-stronger-claim** — Establish the asymmetry that gives the chapter its
  thesis. To cache "`x` is at offset 3" you must be right about *one* object. To cache
  "`x` is absent" you must be right about *every* object on the chain, including that the
  chain *ends where it ended*. `MissingPropertyHandler` therefore calls
  `captureProtoChain(receiver, Infinity)` and `protoChainMatches(obj, chain, true)` — the
  `requireEnd` flag, whose whole job is to reject a receiver whose chain grew a link.
  Contrast with `ProtoLoadFieldHandler`, which passes `requireEnd: false`: once you have
  found the owner, what is past it cannot matter.
- [ ] **§ calls-and-the-dependency-bridge** — Establish `CallIC.lookup`'s monomorphic miss
  path as the only place in the file that reaches outside itself: on a miss it calls
  `dependencyRegistry.invalidate(DEP_CALL_TARGET, entry.targetId, entry.targetVersion,
  "call-target-miss")`, and for a method call also `DEP_MAP` with the receiver map. So a
  *cache* miss in the interpreter can throw away *compiled* code in the JIT. Forward to
  [Ch 54 § deopt-triggers].
- [ ] **§ two-limits** *(Why the obvious design fails)* — Establish that the polymorphic
  ceiling is **four** in `src/feedback/vector/index.ts` (`MAX_POLYMORPHIC_ENTRIES`) and
  **eight** in `src/feedback/ic/index.ts` (`MAX_POLY_ENTRIES`), with a third,
  `MAX_ELEMENT_POLY_ENTRIES = 4`, for elements. Establish what the asymmetry buys and what
  it costs: a site with five to eight shapes still runs fast, because the IC keeps
  serving it, while the vector has already reported `megamorphic` — so the optimizer
  refuses to speculate on a site the interpreter is handling well. Establish that this is a
  *defensible* split (the IC pays a linear scan; the JIT would pay a mispredicted guard)
  and that nothing in the tree says so, because the two constants are private to their
  files and share no name.
- [ ] **§ no-global-invalidation** — Establish the thesis directly. There is no
  write barrier from a map to its dependent caches. The only invalidation that runs during
  normal execution is a site invalidating *itself*, from `PropertyLoadIC.lookup` and
  `PropertyStoreIC.store`, when a deprecated receiver is migrated. Everything else is
  re-checked per hit. State the cost — three comparisons on every cached load — and the
  benefit: no bookkeeping to get wrong, and correctness that does not depend on anyone
  remembering to register a dependency.
- [ ] **§ the-index-nobody-fills** — Establish the honest coda.
  `InlineCacheManager.hiddenClassToICs` exists, `invalidateForHiddenClass` and
  `invalidateDeprecatedMaps` read it, and `registerHiddenClassUsage` — the only thing that
  writes it — is called from `tests/feedback/ic.test.ts` and nowhere else. So the
  manager-level invalidation path is a no-op over an empty map, `runAgingCycle` (its only
  caller) is itself uncalled, and the design still works, because § no-global-invalidation
  never needed it.
- [ ] **§ elements-do-not-specialize** — Establish the second honest coda.
  `LoadElementHandler.execute` is `arrayObj.getIndex(index)` and
  `StoreElementHandler.execute` is `arrayObj.setIndex(index, value)`, whatever
  `elementsKind` the handler carries. The kind is used to *key* entries and to drive the
  lattice; it selects no code. The elements-kind speculation that matters happens in the
  JIT, from the vector, and [Ch 54] is where `docs/example/stats-deopt.tera` shows it
  failing.

## Honesty items

- > **Never runs.** `InlineCacheManager.registerHiddenClassUsage`
  (`src/feedback/ic/index.ts`) has no caller in `src/` or `tools/` — only
  `tests/feedback/ic.test.ts`. Consequently `invalidateForHiddenClass` always returns 0 and
  `invalidateDeprecatedMaps` always iterates an empty `hiddenClassToICs`. Finishing it
  means a call from every `getOrCreate` hit site (interpreter handlers and
  `BaselineRuntime`) plus a decision about who removes stale entries.
- > **Never runs.** `Engine.runAgingCycle` (`src/api/engine.ts`), the only caller of
  `icManager.invalidateDeprecatedMaps`, has no caller anywhere in `src/` or `tools/`. Code
  aging is present and unscheduled.
- > **Never runs.** `InlineCacheManager.collectStats`, `reportPolymorphism` and
  `getJitCandidates`, and `PropertyLoadIC.getDominantHandler` / `getPolymorphicProfile` /
  `getSortedHandlers`, have no caller in `src/`. `--stats` reports the *tracer's* counters
  (`ic_transitions`, `ic_hits`), not these. The `DOMINANT_HANDLER_RATIO = 0.8` constant
  exists for a consumer that was never written.
- > **Never runs.** `PropertySiteInlineCache.isSettled` and `SETTLED_CALL_THRESHOLD = 100`
  have no reader. `MONOMORPHIC_JIT_THRESHOLD = 100` sets `jitCandidate`, which is read only
  by `getStats`, which is read only by `collectStats`, which nothing calls.
- > **Unfinished.** `ElementLoadIC` and `ElementStoreIC` key entries by `elementsKind` but
  their handlers ignore it: both `execute` bodies are one generic call. Specializing them
  means either separate handler classes per kind or a kind-indexed dispatch, and a
  measurement — which this tree has no harness for ([CONVENTIONS.md] §9).
- > **Unenforced.** Nothing checks that a site key is used with only one kind of access.
  `getICKey` is a string concatenation, and `handleLdaIndex` deliberately reuses slot `0`
  when a `ROP_LDA_INDEX` was emitted without a feedback slot ([Ch 33 §
  the-slot-that-was-never-allocated]), so a `for ... in` element load and an unrelated
  property load can land on the same `InlineCache` bundle. They use different sub-caches,
  so it is currently harmless; nothing makes it stay harmless. [unpinned]

## Verify it yourself

```bash
node dist/cli.js --trace-ic docs/example/stats-poly.tera
node dist/cli.js --trace-ic docs/example/stats.tera
node dist/cli.js --stats docs/example/stats-poly.tera
npx vitest run --project unit tests/feedback/ic.test.ts
npx vitest run --project unit tests/objects/maps/hidden-class.test.ts
```

## Tests that pin this

- `tests/feedback/ic.test.ts > "misses a same-map receiver carrying a different prototype"`
- `tests/feedback/ic.test.ts > "misses when the prototype later gains properties"`
- `tests/feedback/ic.test.ts > "misses a same-map receiver whose prototype differs"`
- `tests/feedback/ic.test.ts > "misses when an intermediate prototype link is replaced"`
- `tests/feedback/ic.test.ts > "misses when proto validity version changes"`
- `tests/feedback/ic.test.ts > "misses when proto deprecated"`
- `tests/feedback/ic.test.ts > "matches when hcId, version match and not deprecated"`
- `tests/feedback/ic.test.ts > "misses on different version"`
- `tests/feedback/ic.test.ts > "misses on deprecated"`
- `tests/feedback/ic.test.ts > "always returns undefined"`
- `tests/feedback/ic.test.ts > "transitions uninitialized -> monomorphic -> polymorphic on different objects"`
- `tests/feedback/ic.test.ts > "transitions to megamorphic after 8 unique classes"`
- `tests/feedback/ic.test.ts > "returns missing property as hit:false, value:undefined"`
- `tests/feedback/ic.test.ts > "becomes JIT candidate after 100 monomorphic hits"`
- `tests/feedback/ic.test.ts > "handles deprecated map by invalidating"`
- `tests/feedback/ic.test.ts > "transitions through states on different element kinds"`
- `tests/feedback/ic.test.ts > "transitions to megamorphic after >4 kinds"`
- `tests/feedback/ic.test.ts > "matches same compiled target with same argCount"`
- `tests/feedback/ic.test.ts > "misses on different target version"`
- `tests/feedback/ic.test.ts > "transitions to polymorphic on different callee"`
- `tests/feedback/ic.test.ts > "registerHiddenClassUsage and invalidateForHiddenClass"` —
  the only exercise this path gets, and it is the reason § the-index-nobody-fills can be
  stated as fact rather than suspicion.
- `tests/feedback/ic.test.ts > "delegates to sub-ICs"`
- `tests/feedback/ic.test.ts > "invalidate resets all sub-ICs"`
