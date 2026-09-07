# 31. Two heaps, two collectors   ⟨I · B · J⟩

> **Status:** outline

**Thesis.** tera runs two independent collectors over two different heaps, and the one that
actually keeps a numeric loop alive is not the one anybody expects.

**What arrived.** From [Ch 30]: two structures that reference values nothing else on any
stack does — `interpreter.suspendedFrames: Map<RegisterFrame, ResumeOwner>`, every register
of a half-finished async function, and `microtaskQueue.pendingRejections` plus its `queue`
of not-yet-run `Microtask`s. Chapter 30 hands them over with the explicit question *how do
these survive a collection*. Every value inside them is a `TaggedValue`: a JavaScript number
whose upper bits are an index into `ValueHeap.heapPayloads` ([Ch 22 § the-value-heap]).

**What leaves.** Two reclamation mechanisms and the rule for which one owns a value:

1. `GenerationalGC` (`src/gc/gc.ts`) over the *payload objects* that `factory.ts` registered
   — two `HeapRegion` semispaces, an `OldGeneration`, a `RememberedSet`, and a
   never-stepped `IncrementalMarker`. It reclaims `JSObject` / `JSArray` graphs.
2. `ValueHeap.sweepHeapPayloads(liveIds)` over the *handle table* — every boxed double,
   string, symbol and payload slot, whether or not it carries a `gcHeader`. It is polled
   from the back edge, and it is the one that runs.

Both take the same input: a set of **roots**. Producing that set is the whole of [Ch 32].

**New ideas.** *Garbage collection* and *reachability* (first appearance in the book —
liveness is approximated by "can be reached from a root", never by "will be used again");
*handle table / indirection*; *the generational hypothesis*; *semispace copying* and
*Cheney's algorithm*; *forwarding pointer*; *tenuring / promotion*; *write barrier* and
*remembered set*; *mark-compact* and *evacuation*; *tri-colour marking*; *safepoint* (used
here as a poll site — the tiering machinery on the same back edge is [Ch 35 § back-edges]).

**Length.** 16 pages

## Anchors

- `src/gc/gc.ts` — `GenerationalGC`. Constants at `:18-25`: `TENURE_THRESHOLD = 2`,
  `MAJOR_GC_RATIO = 0.75`, `MAJOR_GC_GROWTH_FACTOR = 1.5`,
  `DEFAULT_ALLOCATION_BUDGET = 4096`, `PRETENURE_SIZE_THRESHOLD = 512`,
  `MIN_ALLOCATION_BUDGET = 1024`, `MAX_ALLOCATION_BUDGET = 65536`,
  `DEFAULT_TARGET_PAUSE_MS = 2`. The `GCHeader` interface at `:29-37`
  (`age`, `marked`, `forwarding`, `generation`, `youngIndex`, `oldGenIndex`, `color`);
  `ManagedObject` and its optional `visitReferences` at `:39-42`; `hasGCHeader` at `:56-60`;
  `GCStats` at `:62-68`. `bindRoots` `:124-132`; `_roots` `:115-122`; `allocate` `:134-170`;
  `needsCollection` `:172-174`; `checkSafepoint` `:176-183`; `minorGC` `:185-276`;
  `majorGC` `:278-334`; `collectGarbage` `:336-343`; `startIncrementalMajorGC` `:345-367`,
  `incrementalMarkingStep` `:369-377`, `finishIncrementalMajorGC` `:379-419`;
  `incrementalWriteBarrier` `:421-427`; `getStats` `:441-458`; `_promote` `:460-464`,
  `_allocateOld` `:466-471`, `_checkMajorGCTrigger` `:473-483`,
  `_rebuildRememberedSetFromOldGen` `:485-499`.
- `src/gc/heap-region.ts` — `HeapRegion` (61 lines, the whole young generation).
  `YOUNG_GEN_SEMI_SPACE_SIZE = 1 << 19` at `:3`; `allocate` `:18-26` (bump `allocPointer`,
  return `null` when full); `set` `:32-35`; `reset` `:37-41` — `storage.fill(undefined, 0,
  this.highWater)`, the reason `highWater` exists; `isFull` `:43-45`; `usedSlots` `:47-49`
  (it returns `allocPointer`, not a live count); `forEach` `:51-58`.
- `src/gc/old-generation.ts` — `OLD_GEN_INITIAL_CAPACITY = 1 << 14` `:1`, `PAGE_SIZE = 1024`
  `:2`, `EVACUATION_THRESHOLD = 0.5` `:3`. `FreeList` `:5-27` (LIFO `push`/`pop`).
  `OldGeneration` `:29`: `allocate` `:39-58` (free list first, then bump, then `_grow`);
  `markCompact` `:66-134` — per-page `pageLive` / `pageTotal` `Uint32Array`s, the
  `evacuationCandidates` set, the sweep loop, `_rebuildFreeList`, then re-placing evacuees;
  `markSweep` `:136-139`; `compact` `:141-162`; `growthRate` `:164-167`;
  `_rebuildFreeList` `:177-184`; `_grow` `:186-195`; the `OldGenerationObject` type
  `:197-202`.
- `src/gc/write-barrier.ts` — 54 lines. `bindWriteBarrierGC` `:13-15`, `withWriteBarrierGC`
  `:17-25` (dynamically scoped, like `withGC`), `storeBarrier` `:27-44` — the *only*
  condition is `holder.generation === "old" && newRef.generation === "young"`, and it
  records the **holder object**, not the field; `storeBarrierForTaggedValue` `:46-53`,
  which unwraps a `TaggedValue` through `getPayload` first.
- `src/gc/remembered-set.ts` — 41 lines. `RememberedSet` is a `Set<T>` of holders:
  `record` `:10-12`, `remove` `:14-16`, `has` `:18-20`, `clear` `:22-24`,
  `iterateHolders` `:26-30`, `filterDead` `:32-36`, `size` `:38-40`.
- `src/gc/incremental-marker.ts` — `COLOR_WHITE` / `COLOR_GREY` / `COLOR_BLACK` `:1-3`,
  `DEFAULT_TIME_BUDGET_MS = 1` `:5`, the `GCObject` structural type `:12-18`, and
  `IncrementalMarker`: `startMarking` `:37-50`, `step` `:52-84` (deadline loop, at least one
  object per step), `writeBarrier` `:86-110` (both the SATB *old-ref* rule and the Dijkstra
  *new-ref* rule), `finishMarking` `:112-118`, `reset` `:124-130`.
- `src/objects/heap/factory.ts` — the registration funnel. The ambient `_gc` `:33`,
  `bindGC` `:35-38`, `withGC` `:40-48`, then `createJSObject` `:50-59`, `allocateInstance`
  `:66-76`, `createJSArray` `:78-86`, `createJSMap` / `createJSSet` / `createJSWeakMap`
  `:88-109`, `createJSPrimitiveWrapper` `:111-119`, `createJSProxy` `:121-127`. Every one
  is `new X(...)` followed by `if (_gc) _gc.allocate(obj)`.
- `src/objects/heap/js-object.ts` — `JSObject.gcHeader` declared `:98` and initialised to
  `null` `:118`; `visitReferences` `:137-156` — slots, overflow properties, prototype, and an
  explicit `if (isAccessorPair(slot)) continue`.
- `src/core/value/index.ts` — the other heap. `ValueHeap` `:298`, its private fields
  `:299-311`, `heapValue` (the allocator) `:340-364`, `getObjectHeapId` `:487-490`,
  `freeHeapObjectSlot` `:492-507`, `pinHeapSlot` `:509-512`,
  `sweepHeapPayloads` `:514-531`, `heapPayloadCount` `:533-535`,
  `heapPayloadLiveBytesEstimate` `:552-554`.
- `src/bytecode/register/interpreter/index.ts` — where the sweep is driven.
  `MIN_HEAP_SWEEP_BYTES = 1 << 18` `:173`, `HEAP_SWEEP_GROWTH = 4` `:174`,
  the `_sweepTick` / `_heapSweepThreshold` fields `:659-660`,
  `dropUnreachableSuspendedFrames` `:1335-1342`, `_maybeSweepHeapPayloads` `:1343-1356`,
  and `onBackEdge` `:1358-1365` with its `(this._sweepTick + 1) & 0xffff` poll.
- `src/optimizing/baseline/runtime.ts` — the second poller: `BaselineRuntime.backEdge`
  `:416-423` calls `this.interp._maybeSweepHeapPayloads()` on *every* safepoint, where
  `src/optimizing/baseline/compiler.ts:44-52` emits one per
  `BACK_EDGES_PER_SAFEPOINT = 1024` back edges
  (`src/runtime/tiering/defaults.ts:1`).
- `src/api/engine.ts` — `new GenerationalGC(options.gc || {}, this.valueHeap)` `:779`,
  `bindRoots(interpreter, globalCells, microtaskQueue)` `:788-792`, and
  `runInRuntime` `:822-830` wrapping every entry in `withGC(this.gc, …)`.
  `Engine.collectGarbage` `:1959-1962`.
- `src/cli/natives.ts` — `exposeGcExtension` `:106-118` (`gc()` / `gc(1)`) and the
  `CollectGarbage` native `:80-86`. The only two ways to force a collection.

## Worked example

`docs/example/stats.tera` cannot reach this chapter — the part opener says so, and
`--stats` proves it: `"minorGCCount": 0`, `"totalAllocated": 15`. So the chapter uses two
`-e` probes instead of a ninth spine file.

```
node dist/cli.js --stats docs/example/stats.tera | tail -14
```

**Probe A — a million boxed doubles, no objects.** 1.5 million iterations, two non-Smi
results per iteration, zero `JSObject`s. The scavenger never fires because nothing it owns
is ever allocated; the handle sweep on the back edge is the only thing keeping the slab
under a megabyte. This is the program in
`tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the boxed-primitive slab bounded under a
double-heavy loop"`, which asserts `heapPayloadLiveBytesEstimate() < 1 << 20`.

**Probe B — a quarter-million objects, and still no scavenge.**

```
node dist/cli.js --stats --no-opt -e 'total = 0
i = 0
while i < 250000:
  o = {v: i}
  total = total + o.v
  i = i + 1'
```

prints, reproducibly:

```
"minorGCCount": 0,
"allocationBudget": 4096,
"allocationsSinceGC": 250009
```

250,009 allocations against a budget of 4,096, and not one collection. The budget is real,
the check that reads it is real, and nothing calls the check. That is the chapter.

## Outline

- [ ] **§ two-heaps** — Establish the split before any algorithm. A `TaggedValue` is an
  index; `ValueHeap.heapPayloads` is the array it indexes; a *payload* may or may not be a
  `ManagedObject` with a `gcHeader`. Draw the two membership circles: every boxed double,
  string and symbol is in the handle table and **not** in the generational heap; every
  `JSObject` and `JSArray` is in both. Establish the consequence the rest of the chapter
  pays off — the two collectors have disjoint responsibilities and no shared trigger.
  `> **New idea.**` reachability: a collector never asks "will this be used again", only
  "can this be reached from a root".
- [ ] **§ the-registration-funnel** — Establish that membership in the generational heap is
  not a property of a type but of a *call site*. `factory.ts` is nine functions, each
  `new X(...)` then `if (_gc) _gc.allocate(obj)`; `GenerationalGC.allocate` is where
  `gcHeader` is first assigned (`gc.ts:135-145`). Establish that `_gc` is *ambient*, bound
  by `withGC` around every `Engine.runInRuntime`, so the same constructor produces a
  managed object inside the engine and an unmanaged one outside it. Then the escape:
  `JSArray.map` / `filter` / `concat` / `slice` build `new JSArray(result)` directly
  (`js-array.ts:312, 322, 370, 391`), so those arrays have no `gcHeader` — invisible to the
  scavenger, and invisible to `storeBarrier`, which returns early on `!holder.gcHeader`.
  Establish why this is currently harmless (`array-methods.ts:314-318` copies
  `sliced.elements` into a `createJSArray`) and why it is still an unenforced invariant.
- [ ] **§ semispaces-that-are-arrays** — Establish `HeapRegion` as the whole young
  generation: a JavaScript `Array` of `size` slots (`1 << 19` by default), an `allocPointer`
  that only bumps, and a `highWater`. `> **New idea.**` bump allocation. Establish the
  purpose of `highWater`: after a scavenge copies few survivors, `allocPointer` is small but
  `storage` still holds strong references above it, so `reset` must clear up to the *high
  water mark*, not up to the pointer — otherwise the region keeps dead objects alive
  forever. Pin it to `tests/gc/heap-region.test.ts > "reset clears stale slots left above a
  shrunken allocPointer"`. Establish that `usedSlots()` returns `allocPointer`, i.e. it is a
  *watermark*, and that `--stats`'s `youngGenUsed` therefore never counts live objects.
- [ ] **§ the-scavenge** — Walk `minorGC` (`gc.ts:185-276`) in order: swap `fromSpace` and
  `toSpace`, `reset` the new from-space, enumerate roots, then `processRef` each one — age,
  promote-or-copy, recurse through `visitReferences`. `> **New idea.**` semispace copying
  and Cheney's algorithm. Then the honest departure: this is a *degenerate* Cheney. There is
  no forwarding pointer and no scan pointer, because a JavaScript object reference cannot be
  rewritten — copying means moving an *index*, not an address, and the object's identity
  never changes. So the "already copied" test is a `visited: Set<ManagedObject>`
  (`gc.ts:200`), and `GCHeader.forwarding` (`gc.ts:32`) is initialised to `null` at
  `gc.ts:139` and never read or written again: a fossil of the textbook design. Close on the
  step that links the two heaps — `toSpace.forEach` calls
  `valueHeap.freeHeapObjectSlot(obj)` for every unvisited survivor
  (`gc.ts:242-246`), which is the *only* place the scavenger touches the handle table.
- [ ] **§ tenuring** — Establish the generational hypothesis and `TENURE_THRESHOLD = 2`:
  `processRef` increments `age` before deciding, so an object promotes on its second
  scavenge. Establish the second promotion path — to-space overflow: if
  `fromSpace.allocate` returns `null` mid-copy, the survivor is promoted instead
  (`gc.ts:213-220`), so a full young generation degrades into wholesale tenuring rather
  than failing. Establish the third, `_allocateOld` (`gc.ts:466-471`), which stamps
  `age = TENURE_THRESHOLD` so a pretenured object is never re-aged. Pin all three to
  `tests/gc/gc.test.ts > "promotes objects after surviving enough GC cycles"`,
  `> "overflows to old gen when young gen is full"` and
  `> "pretenure allocates directly to old generation"`. First honesty item: the overflow
  path in `allocate` (`gc.ts:156-160`) returns without `stats.totalAllocated++` or
  `_allocationsSinceGC++`.
- [ ] **§ the-adaptive-budget** — Establish the feedback loop nobody closes.
  `needsCollection()` is `_allocationsSinceGC >= _allocationBudget || fromSpace.isFull()`.
  After every scavenge, `gc.ts:263-273` halves the budget when the pause exceeded
  `targetPauseMs` (2 ms) and multiplies it by 1.5 when the pause was under half of it,
  clamped to `[1024, 65536]`. Establish that the tuning is correct, tested
  (`tests/gc/gc.test.ts > "budget adjusts after minor GC based on pause time"`,
  `> "does not reduce budget below minimum (1024)"`) and unreachable in a normal run,
  because the only caller of `needsCollection()` is `checkSafepoint`, and nothing calls
  `checkSafepoint`. Show probe B's 250,009-against-4,096.
- [ ] **§ the-store-barrier** — `> **New idea.**` the old-to-young problem: a scavenge that
  starts from frame roots alone will miss a young object referenced only by a tenured one.
  Establish `storeBarrier` (`write-barrier.ts:27-44`) as the fix, and its two design
  choices. First, *granularity*: it records the holder object, not the field, so the
  remembered set is a `Set` of objects and re-scanning one means re-running its whole
  `visitReferences`. Second, *lifetime*: `minorGC` calls `rememberedSet.clear()` at
  `gc.ts:250` and never rebuilds — the set is repopulated only by
  `_rebuildRememberedSetFromOldGen` inside `majorGC` (`gc.ts:318-319`) and by subsequent
  stores. Pin to `tests/gc/gc.test.ts > "minor GC clears remembered set but does not rebuild
  from old gen"` and `> "major GC rebuilds remembered set from old gen"`. State plainly what
  this costs: between a scavenge and the next major GC, an old→young edge written *before*
  that scavenge is remembered only if the barrier fires again.
- [ ] **§ marking** — `> **New idea.**` mark-and-sweep as a graph traversal, and *evacuation*
  as the answer to fragmentation. Walk `majorGC` (`gc.ts:278-334`): a `markSet`, an explicit
  `worklist` (no recursion), roots plus *every object in from-space* seeded as live — the
  young generation is treated as conservatively reachable during a major collection.
  Then `OldGeneration.markCompact` (`old-generation.ts:66-134`) in three phases: count
  liveness per 1024-object page into `pageLive` / `pageTotal`; declare a page an
  *evacuation candidate* when live/total < `EVACUATION_THRESHOLD` (0.5); sweep the unmarked,
  lift the survivors out of sparse pages, rebuild the free list, and re-place them into
  the holes. Pin to `tests/gc/old-generation.test.ts > "sweeps unmarked objects and returns
  sweep count"`, `> "evacuates objects from sparse pages to denser locations"`,
  `> "rebuilds free list after sweep"` and `> "hands a swept slot back out to the next
  allocation"`. This is the section [Ch 26 § weakmaps] points at for a marking fixpoint.
  Close on the tail of `majorGC` that does not belong to the generational heap at all —
  `collectLiveHeapIds` + `sweepHeapPayloads` at `gc.ts:321-322` — and show that it sweeps
  the handle table with a *shallower* walker than the back edge uses, which is the second
  honesty item and the reason `gc(1)` can make `o.n` print `undefined`. Hand the mechanism
  to [Ch 32 § three-walkers].
- [ ] **§ the-collector-that-actually-runs** — Establish the reveal. Neither `minorGC` nor
  `majorGC` is on any automatic path; the mechanism that keeps a real tera program bounded
  is `RegisterInterpreter._maybeSweepHeapPayloads` (`interpreter/index.ts:1343-1356`):
  `heapPayloadLiveBytesEstimate()` against `_heapSweepThreshold`, then
  `markReachableHeapIds(...)` ([Ch 32 § three-walkers]),
  `dropUnreachableSuspendedFrames(live)`, `sweepHeapPayloads(live)`, and a new threshold of
  `live × HEAP_SWEEP_GROWTH` floored at `MIN_HEAP_SWEEP_BYTES`. Establish the two poll sites
  and their different periods — `onBackEdge` every 65,536 back edges via
  `(this._sweepTick + 1) & 0xffff`, and `BaselineRuntime.backEdge` on *every* safepoint,
  which the baseline compiler emits once per 1,024 back edges. Establish the escape hatch
  the sweep needs: `pinHeapSlot`, used by `BaselineRuntime.c` (`runtime.ts:228-236`) to
  protect a constant cache the root walk cannot see. Name the third tier's gap: no
  wasm-compiled code polls, so a loop that reaches the JIT without passing through baseline
  has no sweep of its own.
- [ ] **§ why-the-obvious-design-fails** *(Why the obvious design fails)* — Stage the design
  a reader would reach for: one collector, over one heap, owning every value. Then the
  program that breaks it — probe A. A boxed double is a JavaScript `number` sitting in
  `heapPayloads[i].payload`. It is not an object, so it can carry no `gcHeader`, has no
  `visitReferences`, and cannot be a `ManagedObject`; `hasGCHeader` rejects it, `allocate`
  would have to box the box. Establish that this is why the handle table needs its own
  mark-and-sweep keyed on integer ids rather than on object identity, why that sweep is
  *precise* (it enumerates `heapPayloads` linearly and asks the live set) rather than
  copying, and why a value's collector is therefore decided by its representation, not by
  its lifetime. Land the general rule: when a runtime has two representations for "a thing
  the program holds", it will end up with two collectors whatever the design document says
  — the only choice is whether both are written down.
- [ ] **§ incremental-marking-that-never-steps** — Close honestly on the most complete piece
  of the file. `IncrementalMarker` is a correct tri-colour marker: `startMarking` greys the
  roots, `step` blackens under a millisecond deadline, and `writeBarrier` implements *both*
  guards — the SATB rule that re-greys an overwritten white reference and the Dijkstra rule
  that greys a newly stored one — pinned by
  `tests/gc/incremental-marker.test.ts > "SATB: pushes old WHITE ref when holder is BLACK"`,
  `> "marks reachable graph BLACK through transitive references"` and
  `> "handles cycles without infinite loop"`. Establish the wiring that isn't there:
  `_checkMajorGCTrigger` *starts* it (`gc.ts:479-481`), but the only caller of
  `incrementalMarkingStep` is `checkSafepoint`, which is dead. So once started, marking
  never advances and never finishes; `_incrementalMajorGCActive` stays true for the life of
  the process, `isIncrementalMarkingActive()` adds a branch to every store barrier forever,
  and `incrementalMarker.worklist` holds a strong reference to the entire young generation
  as it stood at the trigger (`gc.ts:361-366`) with nothing to drain it. State the cost of
  finishing: one call to `checkSafepoint` from the same back edge that already calls
  `_maybeSweepHeapPayloads`, plus a decision about whether `majorGC` should abandon an
  in-flight incremental cycle instead of ignoring it.
- [ ] **§ what-leaves** — Restate the two mechanisms and the one input they share, and hand
  [Ch 32] the question this chapter deliberately did not answer: `_roots()` and
  `markReachableHeapIds` are both called "the roots", they walk different structures to
  different depths, and neither of them can see a JavaScript local.

## Honesty items

- > **Dead.** `GenerationalGC.checkSafepoint` (`src/gc/gc.ts:176-183`) has no caller in
  `src/` or `tests/` — `grep -rn "checkSafepoint" src/ tests/ --include=*.ts` returns one
  line, the definition. It is the only reader of `needsCollection()` and the only driver of
  `incrementalMarkingStep()`, so with it dead the allocation budget, the adaptive pause
  tuning and incremental marking are all unreachable in a normal run. Cost of fixing: one
  call from `RegisterInterpreter.onBackEdge` next to `_maybeSweepHeapPayloads`, then a
  measurement, because nothing in this tree has ever run with it enabled.
- > **Dead.** `GCHeader.forwarding` (`src/gc/gc.ts:32`) is declared, initialised to `null`
  in `allocate` (`gc.ts:139`), and never read or assigned anywhere in `src/` or `tests/`.
  It is a fossil of Cheney's algorithm, which this scavenger does not need because JS
  references never move. Cost of removing: one field and one initialiser.
- > **Dead.** `GCHeader.marked` is written exactly once in the whole tree —
  `obj.gcHeader.marked = false` at `src/gc/old-generation.ts:102` — and never set to `true`
  and never read. Liveness during a major GC lives in the caller's `markSet`, not on the
  object.
- > **Dead.** `PRETENURE_SIZE_THRESHOLD = 512` (`src/gc/gc.ts:22`) has no use. `allocate`'s
  `pretenure` argument is a caller-supplied boolean; no size is ever consulted.
- > **Dead.** The `gc` entry in `CATEGORY_STYLES` (`src/core/tracing/index.ts:28`) is never
  matched: all six GC trace sites pass the string `"GC"` (`gc.ts:187, 259, 280, 331, 348,
  413`) and `--trace-gc` registers the category `"GC"` (`src/cli/spec.ts:119`), so
  `formatMessage` always falls through to the default branch. The output is identical only
  because the fallback upper-cases the category.
- > **Never runs.** `OldGeneration.markSweep` (`src/gc/old-generation.ts:136-139`) has no
  caller anywhere; it is a one-line adapter over `markCompact`. `OldGeneration.compact`
  (`:141-162`) and `OldGeneration.growthRate` (`:164-167`) have callers only in
  `tests/gc/old-generation.test.ts`. `RememberedSet.remove` (`remembered-set.ts:14`) has no
  caller at all and `filterDead` (`:32`) only a test.
- > **Never runs.** `GenerationalGC.majorGC` and `minorGC` are reachable only through
  `collectGarbage`, whose only callers are `Engine.collectGarbage`
  (`src/api/engine.ts:1959`) and the two CLI natives — `gc()` behind `--expose-gc` and
  `%CollectGarbage` behind `--allow-natives-syntax` (`src/cli/natives.ts:80-86, 106-118`) —
  plus the retry inside `allocate` when a semispace fills. A tera program that neither calls
  `gc()` nor allocates 524,288 managed objects never scavenges. Probe B is the demonstration.
- > **Broken.** `majorGC` (`src/gc/gc.ts:321-322`) and `finishIncrementalMajorGC`
  (`:404-405`) feed `valueHeap.sweepHeapPayloads` the result of `collectLiveHeapIds`, whose
  `trackValue` (`src/gc/roots.ts:292-299`) follows only `payload.source`. It never walks an
  object's `slots`, an array's `elements`, `overflowProperties`, `properties`,
  `closure.cells` or `compiled.constants` — all of which `markReachableHeapIds` does walk.
  A major collection therefore frees the handle of any payload reachable only through a
  field, and the program reads a dangling slot:
  `node dist/cli.js --expose-gc -e 'o = {s: "hi", n: 1.5}` / `gc(1)` / `print(o.n)'`
  prints `undefined`, and the string case prints nothing at all. It is invisible in normal
  use only because two other things are dead: `majorGC` runs only under `--expose-gc` /
  `%CollectGarbage`, and the automatic trigger reaches `startIncrementalMajorGC`, whose
  finish is unreachable. Cost of a fix: call
  `markReachableHeapIds(this.interpreter, this.globalCells, this.microtaskQueue,
  this.valueHeap)` at both sites — the deeper walker already exists and is already what the
  back-edge sweep uses. No test covers a major GC's handle sweep. [unpinned]
- > **Broken.** `GenerationalGC.allocate` (`src/gc/gc.ts:156-160`) returns from the
  young-generation-overflow path without incrementing `stats.totalAllocated` or
  `_allocationsSinceGC`, while the `pretenure` path at `:147-151` increments
  `totalAllocated` and not `_allocationsSinceGC`. `--stats` therefore under-reports
  allocations exactly when the heap is under pressure. Cost: two lines. No test pins the
  counters on either path. [unpinned]
- > **Unfinished.** Incremental marking is fully implemented and never stepped. See
  § incremental-marking-that-never-steps. `startIncrementalMajorGC` is reachable from
  `_checkMajorGCTrigger`, but `finishIncrementalMajorGC` is reachable only from
  `incrementalMarkingStep`, which is reachable only from dead code. `majorGC` does not clear
  `_incrementalMajorGCActive`, so a stop-the-world collection cannot end a stuck incremental
  cycle either.
- > **Unfinished.** The handle sweep has two poll sites — `RegisterInterpreter.onBackEdge`
  and `BaselineRuntime.backEdge` — and no third. Nothing in
  `src/optimizing/backends/wasm/` calls `_maybeSweepHeapPayloads`, so a loop that runs
  entirely in JIT-compiled code performs no handle sweep of its own. [unpinned]
- > **Unenforced.** `heapPayloadLiveBytesEstimate` (`src/core/value/index.ts:552-554`)
  returns `heapPayloads.length - heapFreeList.length` — a slot **count**, not a byte count —
  and is compared against `MIN_HEAP_SWEEP_BYTES = 1 << 18`
  (`src/bytecode/register/interpreter/index.ts:173`). Both names say bytes and both values
  are entries. Nothing checks the units.
- > **Unenforced.** Nothing requires a heap payload to be created through `factory.ts`.
  `JSArray.map`, `filter`, `concat` and `slice` (`src/objects/heap/js-array.ts:312, 322,
  370, 391`) construct `new JSArray(result)` directly; such an array has no `gcHeader`, is
  never scavenged, and silently defeats `storeBarrier`, which returns early on
  `!holder.gcHeader`. It is harmless today only because `array-methods.ts:314-318` copies
  the elements into a registered array before returning. No test pins that.

## Verify it yourself

```bash
node dist/cli.js --stats docs/example/stats.tera | tail -14
node dist/cli.js --stats --no-opt -e 'total = 0
i = 0
while i < 250000:
  o = {v: i}
  total = total + o.v
  i = i + 1'
node dist/cli.js --expose-gc --trace-gc -e 'a = [1, 2, 3]
gc(1)
print(a.length)'
node dist/cli.js --expose-gc -e 'o = {s: "hi", n: 1.5}
gc()
print(o.n)'
node dist/cli.js --expose-gc -e 'o = {s: "hi", n: 1.5}
gc(1)
print(o.n)'
grep -rn "checkSafepoint" src/ tests/ --include=*.ts
npx vitest run --project unit tests/gc/
npx vitest run --project e2e tests/e2e/gc/heap-payload-sweep.test.ts
```

The first prints `"minorGCCount": 0` for the spine. The second prints
`"allocationsSinceGC": 250009` against `"allocationBudget": 4096` with `"minorGCCount": 0`.
The third is the only way to see the collectors run at all:

```
[GC] Scavenge start — young gen: 10 objects
[GC] Scavenge end — copied: 1, promoted: 0, time: 0.45ms
[GC] Mark-Compact start — old gen: 0 objects
[GC] Mark-Compact end — swept: 0, evacuated: 0, heapFreed: 185, time: 0.72ms
```

`heapFreed: 185` is the handle table; `swept: 0` is the generational heap. The fourth and
fifth are the same program with a minor and a major collection: `gc()` prints `1.5`,
`gc(1)` prints `undefined`. The sixth returns a single line — the definition of
`checkSafepoint` and nothing else.

## Tests that pin this

- `tests/gc/gc.test.ts > "allocates objects into young generation with gcHeader"`
- `tests/gc/gc.test.ts > "pretenure allocates directly to old generation"`
- `tests/gc/gc.test.ts > "overflows to old gen when young gen is full"`
- `tests/gc/gc.test.ts > "returns true when allocation budget exceeded"`
- `tests/gc/gc.test.ts > "returns true when fromSpace is full"`
- `tests/gc/gc.test.ts > "promotes objects after surviving enough GC cycles"`
- `tests/gc/gc.test.ts > "collects unreachable young objects (not copied to toSpace)"`
- `tests/gc/gc.test.ts > "follows references to keep transitive objects alive"`
- `tests/gc/gc.test.ts > "processes remembered set — old→young references keep young objects alive"`
- `tests/gc/gc.test.ts > "collects unreachable old-gen objects"`
- `tests/gc/gc.test.ts > "keeps reachable old-gen objects alive through references"`
- `tests/gc/gc.test.ts > "major/full type runs both scavenge and mark-compact"`
- `tests/gc/gc.test.ts > "full lifecycle: start → steps → finish sweeps old gen"`
- `tests/gc/gc.test.ts > "startIncrementalMajorGC is idempotent"`
- `tests/gc/gc.test.ts > "budget adjusts after minor GC based on pause time"`
- `tests/gc/gc.test.ts > "does not reduce budget below minimum (1024)"`
- `tests/gc/gc.test.ts > "minor GC clears remembered set but does not rebuild from old gen"`
- `tests/gc/gc.test.ts > "major GC rebuilds remembered set from old gen"`
- `tests/gc/gc.test.ts > "major GC leaves an old object with no young reference out of the rebuilt set"`
- `tests/gc/gc.test.ts > "frees heap-payload slots of dead young objects during minorGC"`
- `tests/gc/gc.test.ts > "keeps slots of young objects still reachable from roots"`
- `tests/gc/heap-region.test.ts > "returns null when full"`
- `tests/gc/heap-region.test.ts > "reset clears all slots and allows reallocation from 0"`
- `tests/gc/heap-region.test.ts > "reset clears stale slots left above a shrunken allocPointer"`
- `tests/gc/heap-region.test.ts > "forEach visits only allocated non-undefined slots"`
- `tests/gc/old-generation.test.ts > "take returns null on empty, LIFO order otherwise"`
- `tests/gc/old-generation.test.ts > "allocate reuses free list slots before bumping pointer"`
- `tests/gc/old-generation.test.ts > "grows capacity when full"`
- `tests/gc/old-generation.test.ts > "sweeps unmarked objects and returns sweep count"`
- `tests/gc/old-generation.test.ts > "evacuates objects from sparse pages to denser locations"`
- `tests/gc/old-generation.test.ts > "rebuilds free list after sweep"`
- `tests/gc/old-generation.test.ts > "hands a swept slot back out to the next allocation"`
- `tests/gc/old-generation.test.ts > "defragments when fragmentation exceeds 30%"`
- `tests/gc/write-barrier.test.ts > "records old→young reference in remembered set"`
- `tests/gc/write-barrier.test.ts > "does not record young→young or young→old references"`
- `tests/gc/write-barrier.test.ts > "triggers incremental write barrier when marking is active"`
- `tests/gc/write-barrier.test.ts > "skips everything when gc is not bound"`
- `tests/gc/write-barrier.test.ts > "extracts payload and delegates to storeBarrier for old→young"`
- `tests/gc/remembered-set.test.ts > "record is idempotent"`
- `tests/gc/remembered-set.test.ts > "iterateHolders visits all recorded holders"`
- `tests/gc/incremental-marker.test.ts > "marks reachable graph BLACK through transitive references"`
- `tests/gc/incremental-marker.test.ts > "unreachable objects remain WHITE"`
- `tests/gc/incremental-marker.test.ts > "handles cycles without infinite loop"`
- `tests/gc/incremental-marker.test.ts > "step processes a subset and returns true while work remains"`
- `tests/gc/incremental-marker.test.ts > "SATB: pushes old WHITE ref when holder is BLACK"`
- `tests/gc/incremental-marker.test.ts > "skips barrier when not actively marking"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the boxed-primitive slab bounded under a double-heavy loop"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "preserves live state (objects, arrays, closures, generators) across sweeps"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the slab bounded once the loop runs in baseline-compiled code"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "still reaches a safepoint when the back edge is a conditional jump"`
