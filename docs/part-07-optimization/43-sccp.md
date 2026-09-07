# 43. SCCP   ⟨J · N⟩

> **Status:** outline

**Thesis.** Constants and reachability solved together beat solving them separately, and in
this engine an `Int32` opcode does not have int32 semantics until something proves it does.

**What arrived.** The graph as `type-narrowing` left it: `Generic*` arithmetic specialised
to `Int32*` or `Float64*` where guards proved it, `noOverflow` set on the ones that were
proved ([Ch 48 § settle-int32]). This is the first pass of the `canonicalization` phase.

**What leaves.** Foldable nodes replaced by freshly stamped `Constant` nodes; forwarding
nodes (`Phi`, `CheckSmi`, `CheckNumber`) whose value is known replaced *at their uses* while
the node itself stays in place; and every branch on a known condition rewritten to a `Jump`
with the dead edge disconnected — which `unreachable-block-elimination` will collect
twenty-one passes later ([Ch 47 § unreachable-blocks]).

**New ideas.** The flat (constant-propagation) lattice — bottom / a constant / top; a *dual*
worklist; the executable-edge set; why an optimistic analysis beats a pessimistic one.

**Length.** 12 pages

## Anchors

- `src/optimizing/passes/sccp.ts` — `sparseConditionalConstantPropagation`, `ConstantValue`,
  `SccpSolver` (`solve`, `cellOf`, `isReachable`, `takenSuccessor`, `markReachable`,
  `markEdge`, `visitBlock`, `visitNode`, `visitBranch`, `update`, `evaluate`, `anyBottom`,
  `evaluatePhi`), the `ARITHMETIC` and `COMPARISONS` tables, `WRAPS_IN_INT32`,
  `foldedArithmetic`, `FORWARDING`, `FOLDABLE`, `edgeKey`, `branchTargets`.
- `src/optimizing/infra/lattice.ts` — `flatLattice<T>()` and `FlatValue<T>`
  (`{kind:"bottom"} | {kind:"constant", value} | {kind:"top"}`); note `Object.is` as the
  default equality, which is why `-0` and `0` are different cells.
- `src/optimizing/infra/worklist.ts` — `Worklist<T>`; SCCP holds two of them
  (`flowWork` over blocks, `ssaWork` over nodes) and drains blocks first.
- `src/optimizing/ir/cfg-edit.ts` — `rewriteBranchAsJump` (detaches the condition, rewrites
  `type` and `props` in place, then `disconnect(block, dead)`), `disconnect`, `disconnectAt`.
- `src/optimizing/ir/graph-edit.ts` — `nodeIdStamper`, `reserveNodeIds`, `maxNodeId`,
  `replaceValueUses`, `detachInputs`.
- `src/optimizing/ir/index.ts` — `IRNodeIdAllocator` (`next`, `reserveAbove`, `reset`),
  `getCurrentIRNodeIdAllocator`, `withIRNodeIdAllocator`, `irConstant`.
- `src/optimizing/ir/operations.ts` — the opcodes SCCP knows by name: `IR_INT32_ADD/SUB/MUL/
  DIV/MOD/SHL/SHR/AND`, `IR_FLOAT64_ADD/SUB/MUL/DIV`, `IR_INT32_COMPARE`,
  `IR_FLOAT64_COMPARE`, `IR_NOT`, `IR_NEG`, `IR_CHECK_SMI`, `IR_CHECK_NUMBER`,
  `IR_GENERIC_ADD`, `IR_PHI`, `IR_BRANCH`, `IR_JUMP`, `IR_CONSTANT`.
- `src/optimizing/passes/dce.ts` — `eliminateUnreachableBlocks`, the pass that consumes what
  SCCP leaves behind.
- `src/optimizing/pipeline.ts` — SCCP appears **twice** (`"sccp"` at ordinal 9,
  `"sccp-after-escape"` at 13), both declared `invalidatesAnalyses` (`{kind:"none"}`).

## Worked example

`docs/example/stats.tera`, ahead of time. Exactly one of the 42 SCCP runs (two per function
× 21 functions) reports `changed`:

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | grep -E '#(9|13) sccp'
```

The unit-test graph in `tests/optimizing/pipeline.test.ts` (`foldedGraph`: `Int32Add(20, 22)`
then `Return`) is the miniature: the trace header reads

```
sccp [changed, nodes 4 -> 4 (+0), invalidated type-inference dominance loops points-to mod-ref]
```

— four nodes in, four nodes out, five analyses thrown away, and the dump now contains
`= Constant [value=42]`. Use it to establish that a folding pass *replaces in place* and
leaves the dead operands for DCE, and that `{kind:"none"}` is why one folded add costs the
whole analysis cache.

## Outline

- [ ] **`> **New idea.**` The flat lattice.** Establish three cells — `bottom` ("no reachable
      definition has reached this yet"), `constant(v)`, `top` ("more than one value, or a
      value we cannot name"). Establish `flatLattice`'s `join`: bottom is the identity, top is
      absorbing, two equal constants stay, two different constants become top. Establish that
      the analysis is *optimistic*: everything starts at bottom and only ever moves up, and
      `update` re-enqueues uses only when the join actually moved.
- [ ] **Why constants and reachability must be solved together.** **Why the obvious design
      fails:** run constant folding, then delete unreachable blocks, then re-run folding.
      Stage the program where that loses — a phi at a merge whose second predecessor is only
      reachable if a condition folds the *other* way. Establish that the classic fixpoint
      converges, but only by iterating two passes to a joint fixpoint by hand; SCCP does it in
      one solve.
- [ ] **Two worklists, one loop.** Establish `flowWork` (blocks newly proved reachable) and
      `ssaWork` (nodes whose input changed cell), and the drain order in `solve()`: blocks
      first, nodes second, and a node is only visited if `node.block` is reachable. Establish
      `markReachable` / `markEdge` and the `executable` set keyed `` `${from.id}->${to.id}` ``.
- [ ] **The executable-edge set is what makes a phi tighten.** Establish `evaluatePhi`: it
      walks `block.predecessors` by index, skips any predecessor whose edge is not in
      `executable`, and joins only the surviving inputs — returning early on `top`. Establish
      that this is the whole reason SCCP beats separate passes, and pin it with
      `"resolves a phi whose other predecessor cannot be reached"` and its mirror
      `"resolves the same phi to the other constant when the condition flips"`.
- [ ] **`visitBranch` is where reachability is decided.** Establish the three cases: a
      `bottom` condition marks *no* edge (the block has not been reached with a real value
      yet); a `top` condition marks both; a constant marks exactly one. Establish that a
      branch whose `trueBlock`/`falseBlock` props do not resolve to actual successors
      (`branchTargets` returning `null`) falls back to marking every successor — a
      conservative escape hatch, not an error.
- [ ] **What it folds.** Establish the `FOLDABLE` set as a table, not a switch: twelve
      arithmetic opcodes, two compares, `Not`, `Neg`, and `GenericAdd` restricted to two
      string constants. Establish `CHECK_SMI`/`CHECK_NUMBER` folding — `CheckNumber` of a
      numeric constant forwards it, `CheckSmi` forwards it only when
      `Number.isInteger(v) && v === (v | 0)`.
- [ ] **`FORWARDING` vs `FOLDABLE`: two different rewrites.** Establish that a `FOLDABLE`
      node is *replaced in its block slot* (`block.nodes[at] = folded`) and detached, whereas a
      `FORWARDING` node (`Phi`, `CheckSmi`, `CheckNumber`) keeps its slot and only has its uses
      redirected — because those three are guards or merges whose presence still means
      something to a later pass, and because a `FORWARDING` node with zero uses is skipped
      entirely.
- [ ] **The tera-specific twist: an `Int32Add` is not int32.** Establish `foldedArithmetic`:

      ```ts
      const wraps = WRAPS_IN_INT32.has(node.type) && node.props.noOverflow === true;
      return constant(wraps ? answer | 0 : answer);
      ```
      — src/optimizing/passes/sccp.ts:38-41

      Establish that `WRAPS_IN_INT32` holds only `ADD`/`SUB`/`MUL`, and that the wrap fires
      only when *range analysis or type narrowing already proved* `noOverflow`
      ([Ch 46 § noOverflow], [Ch 48 § settle-int32]). Establish the three consequences the
      tests name: an unproven `Int32Mul` folds to the exact product, not `imul` semantics;
      `Int32Div` by zero folds to `Infinity`; `Int32Mul` of opposite signs folds to `-0` and
      the `-0` survives because `flatLattice` compares with `Object.is` and `(-0)|0 === 0`
      would have destroyed it.
- [ ] **`> **New idea.**` Why the opcode name lies on purpose.** Establish the general rule
      this instantiates: in this IR an opcode names the *shape* the specialiser chose, and the
      *semantics* live in `props`. Point forward to [Ch 47 § strength-reduction] (which also
      keys on `noOverflow`) and [Ch 48 § repr-selection] (where `_rep` does the same job for
      storage). Note this once and keep using the code's names, per [CONVENTIONS § 4](../CONVENTIONS.md).
- [ ] **Folding a branch, and who cleans up.** Establish `takenSuccessor` and the second loop
      in the pass: find the dead successor, call `rewriteBranchAsJump`, which mutates the
      terminator's `type` and `props` in place and disconnects the edge (dropping the phi
      input at that index in `disconnectAt`). Establish that SCCP never removes a block, and
      that `unreachable-block-elimination` (`late-optimization`, ordinal 30) is what does.
- [ ] **War story: the node-id stamping bug.** Symptom: an array literal typed `Never` and a
      value that vanished. Mechanism: SCCP minted `irConstant(...)` nodes without stamping,
      the default allocator handed out an id a parsed graph already held, two nodes shared an
      id, and `TypeSolver` — which keys `this.types` by node *object* but whose upstream
      consumers key by `node.id` — answered for the wrong one. Fix: `nodeIdStamper(graph)`,
      which calls `reserveNodeIds` → `allocator.reserveAbove(maxNodeId(graph))`, so one ambient
      counter owns every id in the compile. Regression tests:
      `tests/optimizing/passes/sccp-identity.test.ts` and
      `tests/optimizing/passes/node-ids.test.ts`. **General rule:** a pass that constructs a
      node must stamp it; the constructor's default id is only safe for a graph nobody parsed.
      Cross-reference [Ch 44 § stamping] and [Ch 41 § maintainGraph].

## Honesty items

> **Unfinished.** `SccpSolver.evaluate` covers twelve arithmetic opcodes but the
> `ARITHMETIC` table omits `IR_INT32_OR`, `IR_INT32_XOR`, `IR_INT32_USHR`, `IR_INT32_NOT` and
> `IR_FLOAT64_POW` — all of which exist as opcodes and are foldable in principle. `FOLDABLE`
> lists `IR_INT32_SHL/SHR/AND` but not `OR`/`XOR`. Cost: five table rows, plus a decision
> about `USHR`'s unsigned result (see the repr-selection note in [Ch 48](48-types-and-representations-in-the-middle-end.md)
> that unsigned shift stays tagged because it can exceed int32).

> **Unenforced.** `sparseConditionalConstantPropagation` returns a `rewrites` count that the
> pipeline's `changed()` adapter turns into a boolean; nothing checks that a run reporting `0`
> left the graph untouched. See [Ch 41 § changed](41-the-pass-manager.md).

> **Unfinished.** `IR_GENERIC_ADD` folds only when *both* operands are string constants; a
> string plus a number constant, which the interpreter concatenates, is left alone. Deliberate
> (the coercion rules live in `passes/string-coercion.ts`, a legalization pass), but worth
> naming so a reader does not read the omission as an oversight.

## Verify it yourself

```bash
npx vitest run --project unit tests/optimizing/passes/sccp.test.ts tests/optimizing/passes/sccp-identity.test.ts
npx vitest run --project unit tests/optimizing/passes/node-ids.test.ts
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | grep -E ' sccp| sccp-after-escape'
node dist/cli.js compile docs/example/stats.tera --emit source --verify -o /tmp/stats.c
```

## Tests that pin this

- `tests/optimizing/passes/sccp.test.ts` > `"folds Int32Mul to the exact product, not wrapped imul semantics"`
- `tests/optimizing/passes/sccp.test.ts` > `"folds a multiply that was settled as wrapping the way int32 wraps"`
- `tests/optimizing/passes/sccp.test.ts` > `"folds Int32Mul of opposite signs to negative zero"`
- `tests/optimizing/passes/sccp.test.ts` > `"folds Int32Div by zero to Infinity (JS number semantics)"`
- `tests/optimizing/passes/sccp.test.ts` > `"folds Int32Mod by zero to NaN (JS number semantics)"`
- `tests/optimizing/passes/sccp.test.ts` > `"folds GenericAdd of two string constants"`
- `tests/optimizing/passes/sccp.test.ts` > `"folds chain: (2+3) * 0 => first fold 2+3=5, then 5*0=0"`
- `tests/optimizing/passes/sccp.test.ts` > `"resolves a phi whose other predecessor cannot be reached"`
- `tests/optimizing/passes/sccp.test.ts` > `"resolves the same phi to the other constant when the condition flips"`
- `tests/optimizing/passes/sccp.test.ts` > `"rewrites the constant branch to a jump and drops the dead edge"`
- `tests/optimizing/passes/sccp.test.ts` > `"leaves the phi alone when the condition is not a constant"`
- `tests/optimizing/passes/sccp.test.ts` > `"still folds a phi whose reachable inputs agree"`
- `tests/optimizing/passes/sccp-identity.test.ts` > `"gives every constant it folds an id no other node holds"`
- `tests/optimizing/passes/sccp-identity.test.ts` > `"leaves a graph the verifier still accepts"`
- `tests/optimizing/passes/node-ids.test.ts` > `"do not repeat an id the parsed graph already carries"`
- `tests/optimizing/passes/node-ids.test.ts` > `"do not repeat an id an earlier stamping pass handed out"`
- `tests/optimizing/passes/node-ids.test.ts` > `"keep a stamper and the value constructors on one counter"`
- `tests/optimizing/analyses/type-inference-identity.test.ts` > `"types an array whose id a constant already took"`
- `tests/optimizing/passes/dce.test.ts` > `"removes blocks not reachable from entry"`
- `tests/optimizing/pipeline.test.ts` > `"attributes each change and invalidation to the pass that caused it"`
- `tests/optimizing/pipeline.test.ts` > `"dumps the graph body under every section header"`
