# Plan: Dominator-based Loop Forest (chuẩn compiler theory / V8 / Turboshaft)

## Goal

Replace the heuristic loop detection in `src/optimizing` with one authoritative,
dominator-based **loop nesting forest**, and route every consumer through it.
Remove all three existing detectors and the persisted `isLoopHeader` reads.

This is a full rewrite (no backward compatibility). Old public shapes
(`findLoops`, `LoopInfo`) are deleted, not deprecated.

## Hard conventions (apply to every file touched)

1. **No comments.** Names carry the meaning. If a line needs a comment, rename or
   extract until it does not.
2. **No hardcoding.** No magic numbers or magic strings. Thresholds, opcode sets,
   and names come from named constants or from the graph. Reuse existing IR opcode
   constants from `../ir/index.js`.
3. **No O(n^2).** Every routine here is near-linear: `O(V + E)` with `O(1)`
   dominance queries, and `O((V + E)·α)` where union-find is used. Do not write a
   per-loop pass that re-walks the whole function. Justify complexity in the PR
   description, not in code comments.
4. **No duplicate code.** There must be exactly one back-edge test, one natural-loop
   builder, one loop-membership map in the whole `src/optimizing` tree. The wasm
   backend and the passes consume the same `LoopForest`.
5. **No backward-compat shims.** Delete `findLoops`/`LoopInfo` and the wasm
   `findBackEdges`/`findLoopHeaders`/`findLoopBlocks`. Rewrite callers and tests.
6. **Match house style.** ESM imports with `.js` suffix, `strict` TS, the
   `analysisId`/`AnalysisPass` pattern from `infra/analysis-manager.ts`, structural
   graph typing like `DominatorGraph` in `analyses/dominance-core.ts`. Classes for
   analysis results (see `DominatorTree`), pure functions for transforms.
7. **Theory vocabulary.** Use the standard terms as identifiers: `header`, `latch`,
   `backEdge`, `naturalLoop`, `exitingBlock`, `exitBlock`, `preheader`, `depth`,
   `irreducible`, `LoopForest`, `Loop`. Semantics follow LLVM `LoopInfo` /
   Turboshaft `LoopFinder`.

## Theory reference (the definitions the code must implement)

- Edge `t → h` is a **back edge** iff `h` dominates `t`. `h` is a **loop header**,
  `t` is a **latch**. (Dragon Book §9.6.2; Cooper & Torczon EAC §9.2.)
- The **natural loop** of back edge `t → h` is `{h}` plus every block that can reach
  `t` without passing through `h`.
- Two back edges with the same header belong to the **same** loop (multiple latches).
- Loop `A` is **nested** in loop `B` iff `header(A) ∈ blocks(B)` and `A ≠ B`.
  This induces the **loop forest**; `depth(root) = 1`.
- A retreating edge whose target does **not** dominate its source ⇒ the region is
  **irreducible**. Natural-loop union is only valid for reducible graphs, so an
  irreducible graph forces the JIT to decline (fall back to baseline).
- Preheader/exit terminology: an **exiting block** is in the loop with a successor
  outside it; an **exit block** is outside the loop, a successor of an exiting block;
  a **preheader** is a single block outside the loop whose only successor is the
  header and which is the header's only external predecessor.

## Current state to remove

Three independent, heuristic detectors exist today. All go away.

| Location | What it does now | Fate |
|---|---|---|
| `analyses/loops.ts` `findLoops` | headers from `block.isLoopHeader`; back edges from DFS-preorder + block-id compare (`isBackEdgeWithOrder`) | **replaced** by `LoopForest` |
| `backends/wasm/graph-support.ts` `findBackEdges`/`findLoopHeaders`/`findLoopBlocks` | retreating edges in RPO index | **deleted**; wasm consumes `LoopForest` |
| `CFGBlock.isLoopHeader` reads in `passes/checks.ts`, `passes/osr.ts`, `backends/wasm/codegen.ts` | bytecode-offset flag from the builder | **replaced** by `forest.isHeader(block)` |

`CFGBlock.isLoopHeader` stays as a **builder-only** artifact: `ir-builder.ts` needs
it during SSA construction to place loop phis before the latch block exists. Nothing
outside `builder/` may read it after that. `computeBlockOrder` (RPO) in
`graph-support.ts` stays — it is layout, not loop detection.

---

## Target architecture

### New module: `analyses/loops.ts` (full rewrite)

```ts
export class Loop {
  readonly header: CFGBlock;
  readonly parent: Loop | null;
  readonly children: readonly Loop[];
  readonly latches: readonly CFGBlock[];
  readonly blocks: ReadonlySet<CFGBlock>;      // includes nested-loop blocks (LLVM getBlocksSet)
  readonly exitingBlocks: readonly CFGBlock[];
  readonly exitBlocks: readonly CFGBlock[];
  readonly preheader: CFGBlock | null;         // null when the graph has no canonical preheader
  readonly depth: number;
}

export class LoopForest {
  readonly roots: readonly Loop[];
  readonly irreducible: boolean;
  constructor(graph: CFGFunction, dominators: DominatorTree);
  loopOf(block: CFGBlock): Loop | null;        // innermost loop containing block
  isHeader(block: CFGBlock): boolean;
  contains(loop: Loop, block: CFGBlock): boolean;
  loops(): Iterable<Loop>;                      // pre-order (outer before inner)
  depthOf(block: CFGBlock): number;            // 0 outside any loop
}

export const loopForestAnalysisId = analysisId<LoopForest>("loops");

export const loopForestAnalysis: AnalysisPass<CFGFunction, LoopForest> = {
  id: loopForestAnalysisId,
  run: (graph, analyses) => new LoopForest(graph, analyses.get(dominanceAnalysisId)),
};
```

The pass pulls the dominator tree from the `AnalysisManager` — no second dominator
computation. Standalone callers (wasm backend, tiering decline) build
`new DominatorTree(graph)` once and pass it in; that is the same construction path,
not a duplicate.

### Construction algorithm (inside `LoopForest`)

Dominator-based natural loops with LLVM-style near-linear subloop mapping.

**Step 1 — back edges. `O(E)` with `O(1)` `dominates`.**
For every block `t` and successor `h` of `t`: if `dominators.dominates(h, t)` then
`t → h` is a back edge; record `h` as a header and `t` as one of its latches.
Unreachable blocks have no dominator numbering ⇒ `dominates` returns false ⇒ they
never produce back edges. That is correct; they are simply outside every loop.

**Step 2 — irreducibility probe. `O(E)`.**
Compute RPO once (reuse the postorder already computed for dominators if exposed, or
a local DFS — but do not duplicate the traversal that dominance already does; prefer
exposing an RPO getter on `DominatorTree`). An edge `t → h` that is retreating in RPO
(`rpoIndex(h) <= rpoIndex(t)`) but **not** a back edge (`!dominates(h, t)`) proves an
irreducible region. If any such edge exists, set `irreducible = true`. The forest is
still built best-effort from the reducible back edges; consumers gate on the flag.

**Step 3 — natural loops + nesting, near-linear (LLVM `discoverAndMapSubloop`).**
Process candidate headers in **postorder of the dominator tree** (innermost first).
Maintain `innermost: Map<CFGBlock, Loop>`.

For each header `h` that has ≥1 latch, create `Loop L(h)` and reverse-CFG worklist
from its latches:

```
for block in reverse-BFS from latches, stopping at h:
  sub = innermost.get(block)
  if sub is undefined:
    innermost.set(block, L)
    if block !== h: push all predecessors(block)
  else:
    outer = outermostDiscovered(sub)          // union-find find(), path-compressed
    if outer === L: continue
    setParent(outer, L)                         // outer becomes child of L
    union(outer, L)
    push all predecessors(header(outer))        // climb over the whole subloop at once
```

`outermostDiscovered`/`union` is a union-find keyed by `Loop`, with path compression,
so the total cost is `O((V + E)·α(V))` — no O(n^2) even for deeply nested loops. Do
not climb `parent` pointers in a bare `while` loop; that is the O(depth) trap the
union-find removes.

`h` itself is seeded into `innermost` as `L` before the walk so the worklist stops
there.

**Step 4 — block sets, depth, order.**
Walk the finished forest top-down: `depth(root)=1`, `depth(child)=depth(parent)+1`.
Build each `Loop.blocks` as its own innermost blocks plus the union of children's
`blocks` (compute bottom-up so each block is added once → linear). `loopOf(block)` is
`innermost.get(block) ?? null`. `depthOf(block) = loopOf(block)?.depth ?? 0`.

**Step 5 — derived boundary sets, `O(E)` total.**
For each loop `L`:
- `latches`: recorded in step 1.
- `exitingBlocks` / `exitBlocks`: one scan of `L.blocks`; a block with a successor
  `s ∉ L.blocks` is exiting, and each such `s` is an exit block (dedupe with a set).
- `preheader`: the header's external predecessors are `preds(h) \ L.blocks`. If there
  is exactly one such block `p` and `p.successors == [h]`, then `preheader = p`, else
  `null`.

Freeze the mutable scaffolding into the `readonly` fields before returning.

### Consumers to rewire

| File | Before | After |
|---|---|---|
| `pipeline.ts` | imports `loopAnalysisId`, `hoistLoopInvariants(g, loops)` etc. | import `loopForestAnalysisId`; pass `LoopForest` |
| `passes/loop-opts.ts` `hoistLoopInvariants` | iterates `LoopInfo[]`, body = `loop.blocks` array, preheader = first pred not in body | iterate `forest.loops()` **innermost-first**; body = `loop.blocks` set; use `loop.preheader` (skip loop when `null`); membership via `forest.contains` |
| `passes/loop-opts.ts` `loopUnrolling` | same shape + `DominatorTree` | consume `LoopForest` + `DominatorTree`; exit/continue blocks from `loop.exitBlocks` instead of re-deriving from the branch |
| `passes/allocation-shape.ts` | `for (loop of loops) for (block of loop.blocks)` | `for (block of forest.loops()-blocks)` or `forest.loopOf(block) != null`; keep the "repeated block" set semantics |
| `passes/checks.ts` | `block.isLoopHeader` at lines ~528, ~595 | `forest.isHeader(block)`; the pass must `requires` the loop analysis and receive the forest |
| `passes/osr.ts` | `header.isLoopHeader`; `reachableFrom` to split latch/entry | `forest.isHeader(header)`; latches from `loop.latches`, entry from `loop.preheader` (or the single external predecessor); delete `reachableFrom` |
| `backends/wasm/codegen.ts` structured emit (~1647) | `findBackEdges`/`findLoopHeaders`/`findLoopBlocks` | build `DominatorTree` + `LoopForest`; if `forest.irreducible` → emit failure (decline); headers = `forest.isHeader`, loop blocks = `loop.blocks`, exits = `loop.exitBlocks`; keep `computeBlockOrder` for RPO layout |
| `backends/wasm/codegen.ts` tiering decline (~507, ~541) | `block.isLoopHeader`; `findLoops` | `LoopForest`; `isMarshallingLeaf` = "no loops" ⇒ `[...forest.loops()].length === 0`; `hasMarshallingDominatedLoop` iterates `forest.loops()`; also decline when `forest.irreducible` |

`graph-support.ts`: delete `findBackEdges`, `findLoopHeaders`, `findLoopBlocks`. Keep
`computeBlockOrder`. If `DominatorTree` does not already expose RPO, add a getter
there and have both dominance and the irreducibility probe reuse it (single traversal).

---

## Implementation steps (ordered, each ends green)

Run after every step: `npm run typecheck` and `npm test`. Per the project's
JIT-perf convention, also run the differential fuzzer and require 0 failures before
declaring a step done.

**Step 1 — Analysis core.** Rewrite `analyses/loops.ts` with `Loop`, `LoopForest`,
`loopForestAnalysis`. Register it in `analyses/index.ts` (replace `loopAnalysis`).
Add an RPO getter on `DominatorTree` if needed. No consumer changes yet — old
consumers still reference the removed symbols, so do Step 1 and Step 2 in one commit
if the build must stay green, or land Step 1 behind the new id and flip callers in the
same PR.

**Step 2 — Rewire pipeline + passes.** Update `pipeline.ts`, `loop-opts.ts`,
`allocation-shape.ts`, `checks.ts`, `osr.ts` to the new API per the table. Make
`checks` and `osr` declare the loop analysis in their `requires`.

**Step 3 — Rewire wasm backend.** Replace the three `graph-support` helpers with
`LoopForest` in `codegen.ts` (structured emit + tiering decline). Add the
`forest.irreducible` decline. Delete the dead helpers.

**Step 4 — Delete `isLoopHeader` non-builder reads.** Confirm (grep) the only
remaining `isLoopHeader` references are in `builder/` and `dump()`. Everything else is
`forest.*`.

**Step 5 — Tests.** Rewrite `tests/optimizing/loop-opts.test.ts` and any loop
assertions in `tests/optimizing/checks.test.ts` against `LoopForest`. Add
`tests/optimizing/analyses/loops.test.ts` covering:
single loop; nested loops (depth + `loopOf`); two latches → one loop; sibling loops;
exiting/exit/preheader derivation; unreachable block excluded; and an irreducible
diamond-with-two-entries asserting `forest.irreducible === true`. Build inputs with
the `cfg-edit.ts` helpers (`link`, `connect`, `addPhi`), not by hand-mutating arrays.

## Phase 2 (optional, recommended — land only after Phase 1 is green)

**Loop simplify / preheader insertion.** Add `insertPreheader(graph, loop)` to
`ir/cfg-edit.ts`, built on the existing `link`/`disconnect`/`addPhi` primitives:
redirect every external predecessor of the header through a new block whose sole
successor is the header, rewriting header phis so external-edge inputs move to the
preheader phi. Add a `loop-simplify` transform that runs it for every loop with
`preheader === null`, placed as the first pass of `high-level-optimization`, marked as
invalidating dominance + loops. This makes `loop.preheader` non-null for LICM/OSR/
unroll and matches LLVM `-loop-simplify` / V8 loop canonicalization. Keep it separate
because it mutates the CFG and shifts OSR offsets — verify OSR seeds still resolve.

## Definition of done / invariants

- Exactly one back-edge test in the tree (`dominates(h, t)`), one natural-loop
  builder, one membership map.
- No read of `CFGBlock.isLoopHeader` outside `builder/` and `dump()`.
- `LoopForest` construction is `O((V + E)·α(V))`; no per-loop full-function rescans.
- `forest.irreducible` ⇒ JIT declines and wasm structured emit refuses; never emits
  loop labels for an irreducible graph.
- `npm run typecheck` clean, `npm test` green, differential fuzz 0 failures.
- For every reducible test graph: `forest.isHeader(b)` iff `b` is the target of a back
  edge; `loopOf` returns the innermost loop; nested-loop `depth` strictly increases
  inward; `blocks` of a parent ⊇ `blocks` of each child.
