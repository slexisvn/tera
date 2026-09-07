# 42. The analyses everything stands on   ⟨J · N⟩

> **Status:** outline

**Thesis.** Six analyses answer every structural question the middle-end passes ask, and the
memory abstraction they share is one string key.

**What arrived.** A `CFGFunction` and an `AnalysisManager` whose cache is empty, plus a pass
that has just declared `requires: [...]` and had them prefetched ([Ch 41 § step-order]).

**What leaves.** Five cached objects — a `DominatorTree`, a `LoopForest`, a
`PointsToResult`, a `ModRef` and a `TypeInference` — each keyed by a branded symbol, each
holding answers no single pass could afford to recompute, and all of them thrown away the
moment a pass declares `{kind:"none"}`.

**New ideas.** Dominance and the dominator tree; postorder and reverse postorder; back edge,
natural loop, latch, preheader, irreducible control flow; dominance frontier; alias analysis
and "may alias"; mod-ref; a lattice and a fixpoint (the second and definitive treatment —
`> **New idea.**` primers for *bottom*, *top*, *join* and *monotone*); worklist algorithm;
union-find.

**Length.** 14 pages

## Anchors

- `src/optimizing/analyses/dominance-core.ts` — `DominatorBlock`, `DominatorGraph`,
  `computePostorder` (explicit stack, no recursion), `computeReversePostorder`,
  `computeDominatorData`, `computeDominators`, the private two-finger `intersect`,
  `buildDominatorTree`, and the O(depth) `dominates`.
- `src/optimizing/analyses/dominance.ts` — `DominatorTree` (`enter`/`exit` Euler numbering,
  `dominates`, `immediateDominator`, `childrenOf`, `reversePostorder`, `frontierOf`,
  the lazy private `computeFrontiers`, the private iterative `number`), `EMPTY_FRONTIER`,
  `dominanceAnalysisId`, `dominanceAnalysis`.
- `src/optimizing/analyses/loops.ts` — `Loop` (`header`, `latches`, `parent`, `children`,
  `blocks`, `exitingBlocks`, `exitBlocks`, `preheader`, `depth`), `LoopForest`
  (`roots`, `irreducible`, `loopOf`, `isHeader`, `contains`, `loops()`, `depthOf`),
  `collectBackEdges`, `isBackEdge`, `hasIrreducibleEdge`, `discoverNaturalLoops`
  (the union-find `find`/`union`/`adopt` closures), `dominatorTreePostorder`,
  `deriveBoundaries`, `loopForestAnalysisId`.
- `src/optimizing/analyses/points-to.ts` — `PointsToResult` (`partitionOf`, `mayAlias`,
  `escapes`, `allocClassOf`, `virtualAllocations`), `analyzePointsTo`, the `Flow`
  `{targets, shapes}` pair, `UNKNOWN_SITE = -1`, `ARRAY_MAP_ID = -1`, `seed`, `propagate`,
  `escapedSitesOf`, `shapedApart`, `globalsMayAlias`, and the constant tables
  `CALLS`, `NON_POINTER_VALUES`, `STORE_VALUE_INDEX`, `STORE_BASE_INDEX`,
  `INPUT_ESCAPE_EFFECTS`.
- `src/optimizing/analyses/heap-model.ts` — `Partition` (`alloc` / `shape` / `global` /
  `any`), `Field` (`slot` / `index` / `anyIndex` / `any`), `partitionKey`, `fieldKey`,
  `locationKey`, `fieldOf`, `fieldsOverlap`, `MemoryLocation`, `memoryLocationOf`,
  `basesMayAlias`, `locationsMayAlias`.
- `src/optimizing/analyses/mod-ref.ts` — `ModRef` (`locationOf`, `gref`, `gmod`,
  `killsEverything`, `mayAlias`, `basesMayAlias`, `writesOf`, `mayReadFrom`),
  `RegionMemory`, `EMPTY_REGION`, `buildModRef`, `locatesMemory`, `domainSet`.
- `src/optimizing/analyses/type-inference.ts` — `TypeInference` (`typeOf`, `isSpeculative`),
  `SPECULATIVE_SOURCES` (seven check opcodes), `TypeSolver` (`seedParameters`, `solve`,
  `observersOf`, `propagateSpeculation`, `evaluate`, plus the `TypeContext` methods
  `returnTypeOf` / `declaredTypeOf` / `memberTypeOf`), `inferTypes`,
  `typeInferenceAnalysisId`.
- `src/optimizing/ir/operations.ts` — `TypeContext`, `Transfer`, `transferType`,
  `OperationSpec.transfer`, and the effect vocabulary the heap model reads:
  `MEMORY_NONE/IMMUTABLE/HEAP/GLOBALS/CONTEXT/FRAME/ANY`,
  `ACCESS_NONE/SLOT/ELEMENT/PROPERTY/GLOBAL`, `effectsOf`, `memoryAccessOf`,
  `readsMutableMemory`, `writesMemory`, `clobbersAllMemory`, `hasOpaqueMemoryEffect`,
  `isAllocationSite`, `forwardsPointerIdentity`, `isTrackedLoad`, `isTrackedStore`.
- `src/optimizing/infra/dataflow.ts` — `FlowDirection`, `FlowGraph<N>`,
  `MonotoneProblem<N,F>`, `DataflowResult<N,F>`, `solveMonotone`.
- `src/optimizing/infra/lattice.ts` — `Lattice<T>`, `productLattice`, `mapLattice`,
  `setLattice`, `FlatValue<T>`, `flatLattice`.
- `src/optimizing/infra/worklist.ts` — `Worklist<T>` and its buffer compaction.
- `src/optimizing/infra/union-find.ts` — `UnionFind<T>` (`makeSet`, `find`, `union`,
  `sameSet`).
- `src/optimizing/infra/priority-queue.ts` — `PriorityQueue<T>`, `Ordering<T>`.
- `src/optimizing/infra/dom-walk.ts` — `ScopedVisitor<B,S>`, `walkDominatorTree`.
- `src/optimizing/types/lattice.ts` — `TypeKind`, `LatticeType`, `neverType`, `anyType`,
  `joinTypes`, `narrowType`, `excludeType`, `isSubtype`, `typeEquals`, `acceptsNull`,
  `typeFromConstant`, `typeFromTypeof`.

## Worked example

Why `typeOf` an unseen value is `Never`, and why a `Never` input poisons a node — so
"not analysed yet" and "unreachable" are the same lattice value.

`TypeSolver.typeOf` returns `this.types.get(value) ?? BOTTOM` where `BOTTOM = neverType()`
(`type-inference.ts:42,62-64`). `evaluate` then reads:

```ts
private evaluate(node: ir.CFGInstruction): LatticeType {
  if (node.type === ir.IR_PHI) return transferType(node, this);
  for (const input of node.inputs) {
    if (this.typeOf(input).kind === TypeKind.Never) return BOTTOM;
  }
  return transferType(node, this);
}
```
— src/optimizing/analyses/type-inference.ts:146-152

Establish: (1) `Never` is the lattice bottom, so it is *also* the initial value of every
node the worklist has not reached; (2) the loop above is the standard "bottom is absorbing"
rule that lets the worklist converge upward; (3) `IR_PHI` is the deliberate exception,
because a loop-header phi always has one input the solver has not visited yet, and poisoning
it would freeze the whole loop at bottom; (4) the consequence for a reader debugging a
`Never`: it means *either* "the value cannot exist" *or* "the solver never got here", and
nothing in the API tells you which.

## Outline

- [ ] **`> **New idea.**` Dominance.** Establish the definition (every path from entry to *b*
      passes through *a*), the immediate dominator, and the dominator tree. Use the diamond
      from `tests/optimizing/analyses/dominance-core.test.ts` as the picture. Mermaid CFG plus
      its dominator tree side by side.
- [ ] **Cooper–Harvey–Kennedy, and the two-finger intersect.** Establish
      `computeDominatorData`: postorder numbering, `idom.set(entry, entry)` as the seed,
      iterate the postorder in reverse until nothing moves, and `intersect(b1, b2)` walking
      the two candidates up the partial `idom` map by *smaller postorder number first*.
      Establish why the "unreachable block is its own dominator" fallback loop at the end
      (`for (const block of graph.blocks) if (!idom.has(block)) idom.set(block, block)`) exists
      and what it buys the passes that run before `unreachable-block-elimination`.
- [ ] **Euler numbering makes `dominates` two comparisons.** Establish `DominatorTree.number`
      (an iterative preorder over `children`, stamping `enter` and `exit` from one clock) and
      then `enterA <= enterB && exitB <= exitA`. Contrast with `dominance-core.ts`'s own
      `dominates`, which walks the idom chain and is O(depth). **Why the obvious design
      fails** is the wrong frame here; the honest frame is that *both* exist and are used by
      different callers — name the callers.
- [ ] **Dominance frontiers, computed lazily and used once.** Establish `frontierOf` and the
      Cytron construction in `computeFrontiers` (for every join block, walk each predecessor
      up the idom chain to the boundary). Establish that it is memoised on first ask
      (`this.frontiers ??= ...`), and that it has exactly one consumer in the tree.
- [ ] **`> **New idea.**` Back edges and natural loops.** Establish that a back edge is an
      edge `latch -> header` where the header dominates the latch (`isBackEdge`), and that
      the natural loop of that edge is everything that can reach the latch without leaving
      through the header. Show `collectBackEdges` and the backward worklist in
      `discoverNaturalLoops`.
- [ ] **LLVM-shaped discovery: dominator-tree postorder plus union-find.** Establish why
      headers are processed in *dominator-tree postorder* (`dominatorTreePostorder` filtered
      to headers) — innermost first, so an inner loop is already a `LoopDraft` by the time the
      outer loop's worklist reaches it, and the outer loop `adopt`s the whole subloop in one
      step instead of re-walking its blocks. Establish the `find`/`union`/`adopt` closures as
      a local union-find, and note they do *not* use `infra/union-find.ts`.
- [ ] **Boundaries.** Establish `deriveBoundaries`: exiting blocks, exit blocks, and the
      strict preheader test — exactly one external predecessor, with exactly one successor,
      and that successor is the header. Establish that `preheader === null` is the single most
      common reason LICM and guard peeling decline ([Ch 46](46-loops-and-the-optimization-that-cannot-fire.md)).
- [ ] **`> **New idea.**` Irreducible control flow, and who reads it.** Establish
      `hasIrreducibleEdge` (a backward edge in reverse-postorder index that is *not* a back
      edge by dominance) and its two consumers: `src/optimizing/passes/osr.ts:125` refuses OSR
      and `src/optimizing/backends/wasm/codegen.ts:507,1616` refuses to emit. Establish that
      tera's front end cannot produce one from source; the flag protects against passes that
      rebuild control flow.
- [ ] **`> **New idea.**` Alias analysis, and Andersen vs Steensgaard.** Establish the
      question ("can these two pointers name the same object?"), the inclusion-based
      (Andersen) formulation, and the coarser unification-based (Steensgaard) one.
      **What was tried and rejected:** the analysis is Andersen — `propagate` unions target
      sets along copy edges — but the Steensgaard rule "a value that may hold more than one
      site is treated as escaping" had to be restored explicitly, and lives in
      `escapedSitesOf` as the final loop
      (`if (held.size === 1 && !held.has(UNKNOWN_SITE)) continue; mark(value);`).
      Cross-reference the note in `andersen-points-to` and [Ch 45 § escape-analysis].
- [ ] **What points-to actually tracks.** Establish the two-set `Flow` — allocation *sites*
      and *shape stamps* (`CHECK_MAP`'s `expectedMapId`, or `ARRAY_MAP_ID` for `CHECK_ARRAY`).
      Establish the three escape routes in `escapedSitesOf` (returned, passed to a
      non-pure call, stored into something), the `containment` map that propagates escape
      transitively into stored values, and the `UNKNOWN_SITE` sentinel that makes an
      unanalysable value alias everything.
- [ ] **One string key.** Establish `locationKey(partition, field)` producing e.g.
      `alloc:17|slot:0`, `shape:3|anyIndex`, `global:counter|anyIndex`, `any|any`. Establish
      `fieldsOverlap`'s asymmetry (a `slot` overlaps only the same `slot`; an `anyIndex`
      overlaps every `index`) and that `basesMayAlias` falls back to comparing `baseKey`
      strings when either base is `null` (globals). **This is the abstraction three passes
      share, and it is the reason ch 45's three passes are one chapter.**
- [ ] **Mod-ref: the oracle three passes ask.** Establish `buildModRef`'s single pass over
      the graph, filling `locations` / `refs` / `mods` / `writeLocations` / `kills`, then
      `writesOf(blocks)` summarising a whole region into `{clobbersEverything, locations,
      keys}` and `mayReadFrom(node, region)` answering the one question LICM asks. Establish
      the declared-effect domains (`props.intrinsicReads` / `intrinsicWrites`) as a second,
      *name-based* memory universe that sits beside the heap model and is what intrinsic CSE
      keys on.
- [ ] **Type inference as a Kildall worklist on the operation table.** Establish that there is
      no per-opcode `switch` here: `evaluate` calls `transferType(node, this)`, which is
      `operationOf(node.type).transfer`, i.e. the transfer function lives on the operation
      spec ([Appendix B](../appendix/b-ir-operations.md)). Establish `seedParameters` from
      `graph.declaredSignature`, the `joinTypes(previous, next)` monotone update, and
      `observersOf` — uses, *plus* the array a stored element flows into, which is what lets
      an array's elements-kind be inferred from its stores.
- [ ] **The taint set, introduced here.** Establish `SPECULATIVE_SOURCES` (the seven check
      opcodes), `propagateSpeculation` running in the *same* worklist as the types, and that
      the worklist re-enqueues on `!this.propagateSpeculation(node) && !grew` — i.e. a node
      whose type did not grow still wakes its observers if its taint did. State that the
      single consumer is in ch 49 and leave the payoff there.
- [ ] **The generic machinery, and how little of it the middle end uses.** Establish
      `solveMonotone` (`FlowGraph`, `MonotoneProblem`, forward/backward, boundary set,
      `Worklist`), the lattice combinators, `Worklist`'s FIFO drain with buffer compaction,
      `UnionFind` with path compression and union by rank, `PriorityQueue` as a binary heap,
      and `walkDominatorTree`'s fork-per-child state. Then establish, honestly, which of them
      any middle-end pass calls — see Honesty items.

## Honesty items

> **Never runs.** `productLattice` and `mapLattice`
> (`src/optimizing/infra/lattice.ts:7,18`) have no caller anywhere in `src/` or `tools/`;
> their only references are in `tests/optimizing/infra/lattice.test.ts`. They are correct,
> tested combinators nothing composes. Cost of finishing: a consumer, or deletion.

> **Never runs.** `walkDominatorTree` / `ScopedVisitor` (`src/optimizing/infra/dom-walk.ts`)
> have no caller outside their own test. Three passes hand-roll exactly this walk instead —
> `Narrower.walk` (`passes/type-narrowing.ts:276-290`, with an explicit undo trail),
> `walkDom` (`passes/escape-analysis.ts:314-325`, recursive, forks two `Map`s per child) and
> `walkBlock` (`passes/checks.ts:90-123`, recursive, forks one `Map` per child). Cost of
> finishing: reworking three passes onto one iterative walker, which would also remove the
> stack-depth risk in the two recursive ones.

> **Unfinished.** `solveMonotone` (`src/optimizing/infra/dataflow.ts`) — the general monotone
> framework — has exactly one consumer in the tree, and it is not a middle-end pass:
> `src/optimizing/machine/verifier.ts:176` uses it for machine-IR liveness. Every memory pass
> in [Ch 45](45-memory-what-a-load-can-be-told.md) uses the *separate* `runSnapshotDataflow`
> driver instead. Two dataflow frameworks, no shared abstraction.

> **Unenforced.** `UnionFind.find` is recursive (`src/optimizing/infra/union-find.ts:12-19`)
> and has no unit test of its own; it is exercised only through
> `analyses/aot-legality.ts:481` and `passes/string-boxing.ts:175`.

> **Unenforced.** `DominatorTree.frontierOf` is used by exactly one pass
> (`src/optimizing/passes/global-promotion.ts:87`). SSA construction ([Ch 39](../part-06-ssa/39-building-ssa-from-bytecode.md))
> does not use dominance frontiers, so the classic Cytron placement algorithm is present
> without being the reason it is present.

## Verify it yourself

```bash
npx vitest run --project unit tests/optimizing/analyses/
npx vitest run --project unit tests/optimizing/infra/dataflow.test.ts tests/optimizing/infra/lattice.test.ts
node dist/cli.js --print-ir --filter total_of docs/example/stats-deopt.tera
grep -rn "walkDominatorTree\|productLattice\|mapLattice" src/ tools/*/src/
grep -rn "solveMonotone" src/ --include=*.ts
```

## Tests that pin this

- `tests/optimizing/analyses/dominance-core.test.ts` > `"in diamond, merge block is dominated by entry but not by branches"`
- `tests/optimizing/analyses/dominance-core.test.ts` > `"treats a block unreachable from entry as dominated only by itself"`
- `tests/optimizing/analyses/dominance-core.test.ts` > `"resolves a loop with a back edge"`
- `tests/optimizing/analyses/dominance-core.test.ts` > `"diamond: entry is idom of both branches and merge"`
- `tests/optimizing/analyses/dominance.test.ts` > `"does not treat an arm of the diamond as dominating the merge"`
- `tests/optimizing/analyses/dominance.test.ts` > `"handles a loop back edge without diverging"`
- `tests/optimizing/analyses/dominance.test.ts` > `"is resolved and cached through the AnalysisManager"`
- `tests/optimizing/analyses/loops.test.ts` > `"maps nested loops to increasing depth"`
- `tests/optimizing/analyses/loops.test.ts` > `"merges two latches into one loop"`
- `tests/optimizing/analyses/loops.test.ts` > `"derives exiting blocks, exit blocks, and preheader"`
- `tests/optimizing/analyses/loops.test.ts` > `"excludes unreachable blocks from loops"`
- `tests/optimizing/analyses/loops.test.ts` > `"marks irreducible two-entry regions"`
- `tests/optimizing/analyses/points-to.test.ts` > `"proves two fresh allocations do not alias"`
- `tests/optimizing/analyses/points-to.test.ts` > `"marks an allocation escaping through a phi and call argument"`
- `tests/optimizing/analyses/points-to.test.ts` > `"proves different map-guarded pointers do not alias"`
- `tests/optimizing/analyses/points-to.test.ts` > `"marks an allocation stored into another object field as escaping"`
- `tests/optimizing/analyses/points-to.test.ts` > `"propagates escape through returned array elements"`
- `tests/optimizing/analyses/points-to.test.ts` > `"keeps a loop-carried allocation in the same class"`
- `tests/optimizing/analyses/mod-ref.test.ts` > `"reports the locations a region writes"`
- `tests/optimizing/analyses/mod-ref.test.ts` > `"marks a region containing an unknown call as clobbering everything"`
- `tests/optimizing/analyses/mod-ref.test.ts` > `"does not treat a declared immutable-read builtin as a clobber"`
- `tests/optimizing/analyses/mod-ref.test.ts` > `"says a field load ignores a region that writes a different field"`
- `tests/optimizing/analyses/mod-ref.test.ts` > `"says a global load depends on a write to the same global only"`
- `tests/optimizing/analyses/type-inference-identity.test.ts` > `"keeps each colliding node's own type rather than the last one written"`
- `tests/optimizing/infra/dataflow.test.ts` > `"reaches a fixpoint over a back edge"`
- `tests/optimizing/infra/dataflow.test.ts` > `"leaves an unreachable node at bottom"`
- `tests/optimizing/infra/dataflow.test.ts` > `"computes live variables from uses back to definitions"`
- `tests/optimizing/infra/lattice.test.ts` > `"keeps equal constants and collapses conflicting ones to top"`
- `tests/optimizing/infra/worklist.test.ts` > `"preserves every distinct item across backing-buffer compaction"`
- `tests/optimizing/infra/dom-walk.test.ts` > `"forks state down each branch so siblings never share mutations"`
