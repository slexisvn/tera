# 45. Memory: what a load can be told, and an object that stops existing   ⟨I · J · N⟩

> **Status:** outline

**Thesis.** One dataflow driver serves three memory passes, and deleting an allocation means
promising you can rebuild it at a deopt.

**What arrived.** The graph after `algebraic-simplification`, with a `PointsToResult` and a
`ModRef` in the analysis cache and every heap access resolvable to a `MemoryLocation`
([Ch 42 § one-string-key]).

**What leaves.** Redundant loads replaced by the value already known at that location; stores
nothing can observe deleted; duplicate read-only intrinsics collapsed; and — where all nine
conditions hold — an allocation and every load, store and guard against it *gone*, with its
field values written into `FrameState.sunkAllocations` so a bailout can rebuild the object in
an interpreter frame.

**New ideas.** Available expressions (forward, must); liveness (backward, may); a *snapshot*
dataflow that rewrites in a second sweep; escape analysis and scalar replacement;
materialization at deopt.

**Length.** 16 pages

## Anchors

- `src/optimizing/infra/snapshot-dataflow.ts` — `SnapshotDirection`, `SnapshotProblem<State>`
  (`direction?`, `empty`, `clone`, `meet`, `equals`, `transfer`, `rewrite`),
  `runSnapshotDataflow`, `reachableBlocks`, `boundaryBlocks`, `mergeInputs`, `sources`,
  `nextBlocks`.
- `src/optimizing/passes/load-elimination.ts` — `loadElimination`, `MemoryEntry`
  (a `MemoryLocation` plus `value` and `visible`), `MemoryState`
  (`byLocation` / `byBase` / `visibleBaseKeys`), `transferBlock`, `rewriteBlock`,
  `transferNode`, `storeValue`, `killAliases`, `candidateBaseKeys`, `addLocation`,
  `removeLocation`, `killVisible`, `isExternallyVisible`, `meetStates`, `sameEntry`.
- `src/optimizing/passes/dead-stores.ts` — `deadStoreElimination`, `LocationUniverse`,
  `LiveState`, `buildUniverse`, `memoryLocation`, `addAliases`, `addBaseAliases`,
  `removeAliases`, `hasLiveAlias`, `aliasKeys`, `candidateBaseKeys`, `isExternallyVisible`,
  and `meetStates` as **union** (a backward *may* problem).
- `src/optimizing/passes/intrinsic-cse.ts` — `commonSubexpressionIntrinsicReads`,
  `AvailableState` (`entries` / `domainIndex` / `unknownKeys`), `isReactiveReadIntrinsic`,
  `isCseEligibleIntrinsicRead`, `applyBarrier`, `intrinsicKey`, `inputKey`,
  `intrinsicReadDomains`, `intrinsicWriteDomains`, `invalidateDomain`, `invalidateUnknown`.
- `src/optimizing/passes/escape-analysis.ts` — `escapeAnalysisAndScalarReplacement`, and the
  nine refusal predicates: `pointsTo.escapes`, `unsupportedAliasUse`, `undominatedAliasPhi`,
  `unresolvedElementIndex`, `hasUntrackedLoopStore`, `callerFrameStatesReferenceAliases`,
  the inline `allDominated` loop, `requiresUnsupportedMergeState`, and
  `createPhiFieldStates` returning `null`. Plus `safeReceiverUses`, `receiverRoot`,
  `offsetStateKey`, `latestStoreForField`, `hasBackedgeStore`, `fieldKeysForAlias`,
  `fieldKeysForLoopHeader`, `naturalLoopBody`, `loopHeadersUnder`, `initialOffsetState`,
  `recordVirtualState`, `processBlock`, `walkDom`, `removeNodes`, and the tables
  `ALLOCATIONS`, `IDENTITY_GUARDS`, `ELEMENT_ACCESSES`, `AGGREGATE_STORES`,
  `RECEIVER_ACCESSES`.
- `src/optimizing/passes/allocation-sinking.ts` — `allocationSinking`, `EscapeAnalysis`,
  `VirtualState`, `getSunkAllocations`, `analyzeEscape`, `sinkToDeoptOnly`,
  `buildVirtualState`, `removeAllocation`, `findStoredValue`.
- `src/deopt/materializer.ts` — `withMaterializedAllocations`, `ObjectMaterializer`
  (`materialize`, `_resolveValue`), `VirtualAllocationState`, `SunkAllocationCarrier`.
- `src/deopt/frame-state.ts` — `VirtualAllocation`, `FrameState.sunkAllocations`,
  `setSunkAllocations`, `callerFrameState`, `setCallerFrame`.
- `src/optimizing/ir/frame-state-values.ts` — `replaceGraphFrameStateValue`,
  `sunkAllocationIds`, `visitFrameStateValues`, `buildFrameStateIndex`.
- `src/optimizing/analyses/heap-model.ts` — `MemoryLocation`, `locationKey`, `fieldsOverlap`,
  `basesMayAlias`.
- `src/optimizing/ir/operations.ts` — `isTrackedLoad`, `isTrackedStore`,
  `isOpaquePropertyAccess`, `clobbersAllMemory`, `readsMutableMemory`, `ACCESS_PROPERTY`.
- `src/optimizing/optimizer.ts` — `staticCompilerOptions` (`sinkAllocations: false`), the one
  line that removes `allocation-sinking` from the AOT pipeline.

## Worked example

**The running example cannot reach scalar replacement.** Every allocation in every
`docs/example/*.tera` file escapes, and the pass says so in English:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^remark' | sort -u
```

```
remark missed v5: the allocation escapes: points-to found a use that lets the object
  outlive this frame, so its fields cannot become plain values
remark missed v6: v33 indexes the array with a value that is not a constant in range,
  so the element it reads is not known statically
```

The two `Series` objects are stored into globals and the `float[]` is indexed by a loop
variable — the first and fourth refusals, on the book's own spine. Per
[CONVENTIONS § 2](../CONVENTIONS.md), the chapter states this limit in its opener and takes
its worked shapes from `tests/optimizing/passes/escape-analysis.test.ts`, where the
diamond test `"does not leak store from sibling block in diamond CFG"` and the loop test
`"scalar replaces a loop-carried object field with a phi"` are the two pictures.

## Outline

- [ ] **`> **New idea.**` A snapshot dataflow.** Establish `runSnapshotDataflow`'s two sweeps:
      solve `transfer` to a fixpoint over reachable blocks, *then* walk every block once more
      calling `rewrite` with the settled in-state. Establish why the split exists — the
      transfer function must be pure and re-runnable, so mutation cannot happen inside it —
      and that `rewrite` clones the state and re-derives it node by node. Establish the two
      configuration points: `direction` and `meet`, and that `boundaryBlocks` is `[entry]`
      forward and "every block with no reachable successor" backward.
- [ ] **`> **New idea.**` Available expressions.** Establish load elimination as the classic
      forward *must* problem: a location's value is available at a merge only if both
      predecessors agree on it — `meetStates` keeps a location only when
      `sameEntry(entry, other)` holds, comparing `value`, `base`, `key` **and** `visible`.
      Pin with `"eliminates load available from every branch at a merge"`.
- [ ] **The state is three indices, not one map.** Establish `byLocation`
      (key → entry), `byBase` (baseKey → set of keys, so a kill can find aliases without
      scanning), and `visibleBaseKeys` (which bases a call must clobber). Establish
      `addLocation` / `removeLocation` maintaining all three in step.
- [ ] **The externally-visible distinction.** Establish `isExternallyVisible(location)`:
      a global (`base === null`) is always visible; an `alloc` partition is visible only if
      `pointsTo.escapes(location.base)`; anything else (`shape`, `any`) is visible. Establish
      `killVisible` on a clobbering call, and `candidateBaseKeys` — a store through a *visible*
      base must kill every visible base, a store through a fresh non-escaped one kills only
      itself. This is the mechanism behind
      `"preserves state for fresh non-escaped allocation after call"`.
- [ ] **`> **New idea.**` Liveness, backwards.** Establish dead store elimination as the
      mirror: `direction: "backward"`, `meet` is **union** (a *may* problem — a store is dead
      only if it is dead on every path, so liveness must over-approximate), and `empty()` seeds
      `new Set(universe.visibleKeys)` at each exit, because anything externally visible is
      live at function exit by default. Establish `buildUniverse` as the pre-pass that
      enumerates every location the function touches, because a backward analysis needs the
      universe up front.
- [ ] **`IR_RETURN` re-livens everything reachable.** Establish `transferNode`'s return case:
      `addBaseAliases(state, input, ...)` with `matchField: false` and field `anyIndex`, so
      *every* field of anything the return may alias becomes live again. Establish that this
      is the smallest correct rule, and that a better one needs a reachability walk the pass
      does not do. Pin the cross-block shapes with
      `"eliminates store when all successors overwrite same key"` and
      `"does NOT eliminate when a successor reads before overwriting"`.
- [ ] **Intrinsic CSE keys on declared effect domains, not the heap.** Establish
      `intrinsicKey` (`name` plus one token per input, where a `LOAD_GLOBAL` input is keyed by
      its *global name* and a primitive `Constant` by its value, so two separately-built loads
      of the same global canonicalize). Establish the *second* memory universe: `applyBarrier`
      clears everything on `clobbersAllMemory`, and otherwise invalidates only the named
      domains in `props.intrinsicWrites` plus every entry with unknown reads. Establish that
      this is the reactive-graph integration point — cross-reference the `reactive` sibling
      repository per [CONVENTIONS § 19](../CONVENTIONS.md) — and pin with
      `"keeps domain-qualified intrinsic reads across non-aliasing writes"` and
      `"keeps unknown-domain intrinsic reads conservative across domain writes"`.
- [ ] **`> **New idea.**` Escape analysis and scalar replacement.** Establish the goal: an
      object whose lifetime is inside one frame does not need to exist; each of its fields can
      be a plain SSA value. Establish the gate — `pointsTo.escapes(alloc)` first, then
      `aliases = every value whose allocClassOf is this allocation's id`.
- [ ] **The nine refusals, read as a specification.** Establish each with its verbatim remark
      text, in the order the pass asks them:
      1. the allocation escapes;
      2. `unsupportedAliasUse` — an alias is used as something other than a receiver;
      3. `undominatedAliasPhi` — a phi merges the object where the allocation does not dominate;
      4. `unresolvedElementIndex` — a non-constant or out-of-range array index;
      5. `hasUntrackedLoopStore` — a loop-body store this pass cannot carry across the back edge;
      6. `callerFrameStatesReferenceAliases` — an *inlined caller* frame state still holds it;
      7. the `allDominated` loop — a use in a block the allocation does not dominate;
      8. `requiresUnsupportedMergeState` — a merge needs a field state no phi can express;
      9. `createPhiFieldStates === null` — a needed per-field phi could not be built.
      Establish that this is a nine-item catalogue of what "an object is local" actually means.
- [ ] **The dominator walk carries per-field state.** Establish `walkDom` forking two `Map`s
      (`propState` by name, `offsetState` by slot, with `"elem_iN"` keys for array slots) down
      each dominator-tree child, and `processBlock` turning `StoreField` into a map write,
      `LoadField` into a map read (inserting an `undefined` constant when the field was never
      written), and `CheckMap`/`CheckArray`/`Phi` aliases into deletions. Pin the isolation
      with `"does not leak store from sibling block in diamond CFG"` and the forwarding with
      `"propagates store to dominated block correctly"`.
- [ ] **`createPhiFieldStates`: one phi per field, at loop headers and object merges.**
      Establish the two loops — one over alias phis, one over `carryingHeaders` — both calling
      `createFieldPhi`, which builds an input per predecessor from `latestStoreForField`, or
      the phi itself on a back edge, or the allocation's initial state. Establish the
      all-or-nothing rollback: if any input is missing or not dominated, every phi created so
      far is removed and the function returns `null`. Pin with
      `"scalar replaces a loop-carried object field with a phi"` and
      `"does NOT replace an object a loop phi carries in from the iteration before"`.
- [ ] **The promise: `recordVirtualState`.** Establish that before touching any node,
      `processBlock` calls `recordVirtualState(node, propState, offsetState)`, which walks the
      node's frame state **and every caller frame state above it**, and for each one that still
      names an alias writes a `{fields, props}` snapshot into `state.sunkAllocations` keyed by
      the allocation's id. Establish that this happens *first*, so the snapshot describes the
      object as of that program point. Quote the invariant: **you may delete an allocation only
      if every frame state that could resume can rebuild it.**
- [ ] **Redeeming the promise: `ObjectMaterializer`.** Establish
      `withMaterializedAllocations(frameState, runtimeValues)` as the entry point on the
      bailout path, and `ObjectMaterializer.materialize` creating a real `JSObject`, setting
      props by name and growing `obj.slots` to fill fields by offset. Establish
      `_resolveValue`'s three-step lookup — already-materialized, live runtime value, then a
      `Constant`'s own value — and its `mkUndefined()` fallback. Cross-reference
      [Ch 54 § bailing-out] for where this is called from.
- [ ] **Allocation sinking is the deopt-only sibling.** Establish the difference: escape
      analysis deletes objects that *never* escape; `allocationSinking` deletes objects whose
      *only* escape point is an `IR_DEOPTIMIZE`. Establish `analyzeEscape`'s narrower alias
      set (`GENERIC_SET_PROP`/`GET_PROP`/`CHECK_MAP` and, through a `CheckMap`,
      `STORE_FIELD`/`LOAD_FIELD`), `sinkToDeoptOnly` writing `sunkAllocations` onto the
      *deopt node's props* rather than onto a frame state, and the two remarks it prints when
      it declines. Then establish the one line that removes it for AOT:
      `staticCompilerOptions` sets `sinkAllocations: false`, because a native binary has no
      `IR_DEOPTIMIZE` for anything to be sunk *into*. Cross-reference [Ch 55 § no-way-out].

## Honesty items

> **Dead.** `meetPredecessors` in `src/optimizing/passes/intrinsic-cse.ts:70-85` is a
> complete predecessor-merge function with no caller anywhere in the tree — `runSnapshotDataflow`
> does the merging. It is a leftover from before the pass moved onto the shared driver. Cost
> of finishing: delete it, or explain why the shared `mergeInputs` is not enough.

> **Unfinished.** `allocationSinking` recognises only `IR_NEW_OBJECT`
> (`allocation-sinking.ts:47`); an array whose only escape is a deopt is never sunk, even
> though `escapeAnalysisAndScalarReplacement` handles `IR_NEW_ARRAY` fully. Cost: array
> element state in `buildVirtualState` and a matching branch in `ObjectMaterializer`.

> **Unfinished.** `ObjectMaterializer._resolveValue` returns `mkUndefined()` for anything it
> cannot resolve, including a sunk allocation whose own fields reference another sunk
> allocation not yet materialized in iteration order. `materialize` iterates
> `sunkAllocations` in insertion order with no topological sort, so a cycle or a
> wrong-ordered pair silently yields `undefined` fields rather than an error.

> **Unenforced.** `escapeAnalysisAndScalarReplacement` takes a `graph` parameter in its local
> `replaceValue` helper (`escape-analysis.ts:801`) and never uses it; the function updates
> `uses` directly instead of going through `replaceValueUses`, so it does **not** call
> `replaceGraphFrameStateValue`. The callers compensate by calling
> `replaceGraphFrameStateValue` separately on the next line, three times. Nothing enforces
> that pairing.

> **Unenforced.** Nothing checks that a deleted allocation is actually rebuildable. The
> invariant "every frame state that names an alias got a `sunkAllocations` entry" is
> maintained by construction in `recordVirtualState` and verified by no verifier;
> `validateOptimizedGraph` checks frame-state *value dominance*, not sunk-allocation coverage.

> **Measured worse** — *not claimed*. There is no benchmark harness in this tree
> ([CONVENTIONS § 9](../CONVENTIONS.md)), so the chapter must not say scalar replacement is
> faster. What it can say is what the remarks say: on the running example it fires zero times.

## Verify it yourself

```bash
npx vitest run --project unit tests/optimizing/passes/load-elimination.test.ts tests/optimizing/passes/dead-stores.test.ts
npx vitest run --project unit tests/optimizing/passes/escape-analysis.test.ts tests/optimizing/passes/allocation-sinking.test.ts
npx vitest run --project unit tests/optimizing/passes/intrinsic-cse.test.ts
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^remark' | sort -u
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | grep -E ' escape-analysis| load-elimination| dead-store-elimination'
grep -rn "sinkAllocations" src/optimizing/optimizer.ts src/optimizing/pipeline.ts
```

## Tests that pin this

- `tests/optimizing/passes/load-elimination.test.ts` > `"eliminates load after store to same object and offset"`
- `tests/optimizing/passes/load-elimination.test.ts` > `"preserves state for fresh non-escaped allocation after call"`
- `tests/optimizing/passes/load-elimination.test.ts` > `"invalidates state after call for escaped objects"`
- `tests/optimizing/passes/load-elimination.test.ts` > `"does not replace a loop-carried field load with the preheader store"`
- `tests/optimizing/passes/load-elimination.test.ts` > `"eliminates load available from every branch at a merge"`
- `tests/optimizing/passes/load-elimination.test.ts` > `"two fresh allocations are no-alias"`
- `tests/optimizing/passes/load-elimination.test.ts` > `"preserves load state across pure call"`
- `tests/optimizing/passes/load-elimination.test.ts` > `"invalidates local field state across generic property write"`
- `tests/optimizing/passes/dead-stores.test.ts` > `"eliminates store overwritten by later store to same object:offset"`
- `tests/optimizing/passes/dead-stores.test.ts` > `"keeps store when a load of same key appears between stores"`
- `tests/optimizing/passes/dead-stores.test.ts` > `"invalidates tracking after a call (store before call is not dead)"`
- `tests/optimizing/passes/dead-stores.test.ts` > `"eliminates store when all successors overwrite same key"`
- `tests/optimizing/passes/dead-stores.test.ts` > `"does NOT eliminate when a successor reads before overwriting"`
- `tests/optimizing/passes/dead-stores.test.ts` > `"eliminates a store overwritten through multiple blocks on every path"`
- `tests/optimizing/passes/intrinsic-cse.test.ts` > `"does not eliminate reactive reads across write barriers"`
- `tests/optimizing/passes/intrinsic-cse.test.ts` > `"does not reuse branch-local reactive reads at a merge block"`
- `tests/optimizing/passes/intrinsic-cse.test.ts` > `"canonicalizes repeated global loads feeding the same reactive read"`
- `tests/optimizing/passes/intrinsic-cse.test.ts` > `"keeps domain-qualified intrinsic reads across non-aliasing writes"`
- `tests/optimizing/passes/intrinsic-cse.test.ts` > `"invalidates domain-qualified intrinsic reads across aliasing writes"`
- `tests/optimizing/passes/intrinsic-cse.test.ts` > `"reaches a fixed point for loops with intrinsic write barriers"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"scalar replaces non-escaping object with field access"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"does NOT replace when object escapes through call"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"does NOT replace when an allocation has an unsupported alias use"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"does NOT replace an array read past its last element"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"does not leak store from sibling block in diamond CFG"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"does not scalar replace when a field load needs unsupported merge state"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"does not scalar replace allocations referenced by caller frame states"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"scalar replaces a loop-carried object field with a phi"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"scalar replaces an object the loop body allocates fresh each iteration"`
- `tests/optimizing/passes/escape-analysis.test.ts` > `"does NOT replace an object a loop phi carries in from the iteration before"`
- `tests/optimizing/passes/allocation-sinking.test.ts` > `"sinks allocation that only escapes through deopt, attaches virtual state"`
- `tests/optimizing/passes/allocation-sinking.test.ts` > `"sinks allocation with field stores via CheckMap, captures field virtual state"`
- `tests/optimizing/passes/allocation-sinking.test.ts` > `"does NOT sink when allocation escapes through return (not deopt-only)"`
- `tests/optimizing/passes/allocation-sinking.test.ts` > `"replaces loads with stored values after sinking"`
- `tests/optimizing/infra/pass-remarks-from-passes.test.ts` > `"names the allocation it refused to scalar replace and why it escapes"`
- `tests/optimizing/infra/pass-remarks-from-passes.test.ts` > `"reports a success rather than an escape when the object stays put"`
