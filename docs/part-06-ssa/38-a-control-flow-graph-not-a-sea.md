# 38. A control-flow graph, not a sea of nodes   ⟨· · J · N⟩

> **Status:** outline

**Thesis.** Values are pinned to a block and to a position within it, program order IS
the schedule, and one frozen operation table answers every structural question a pass
can ask.

**What arrived.** A `RegisterCompiledFunction` — the register bytecode of chapter 25,
plus the feedback vector chapter 33 filled in and the tier-up decision chapter 35 made.
Registers, a constant pool, a source map, no notion of a definition.

**What leaves.** A `CFGFunction`: blocks of `CFGInstruction`s in canonical phi SSA, each
value naming its inputs by identity, each block naming its predecessors in a fixed order,
and every structural property of every opcode readable from `OPERATIONS`. Chapter 39
shows the walk that builds it; this chapter is the shape it builds into.

**New ideas.** basic block; control-flow graph; SSA and the single-assignment rule; a phi;
def-use edges as a multiset; an effect (reads/writes/allocates/can-deoptimize); a
terminator; a pinned value; a type transfer function. Deliberately *not* here: dominance
(chapter 42), the lattice itself (chapter 42), deoptimization (chapter 40).

**Length.** 18 pages

## Anchors

- `src/optimizing/ir/index.ts` — `CFGInstruction` (`id`, `type`, `props`, `inputs`,
  `uses`, `rep`, `frameState`, `block`, `position`), `CFGBlock` (`nodes`, `phis`,
  `predecessors`, `successors`, `terminator`, `isLoopHeader`), `CFGFunction` (`blocks`,
  `entry`, `parameters`, `dependencies`, `addBlock`, `addParameter`, `addDependency`,
  `rebuildUses`), `dropOneUse`, `homeInstruction`, `trivialPhiInput`,
  `IRNodeIdAllocator`, `withIRNodeIdAllocator`, `irRequiresFrameState`, and the ~90
  `ir*()` node factories. 1090 lines.
- `src/optimizing/ir/operations.ts` — the 98 `IR_*` opcode constants; `OperationSpec`,
  `OperationEffects`, `Arity`, `ResultClass`, `MemoryKind`, `DeoptMode`,
  `MemoryAccessKind`, `SpeculationRole`, `OverloadKind`, `Transfer`, `TypeContext`;
  the constructors `pureValue` / `guard` / `load` / `store` / `call` / `allocation` /
  `terminator` / `pinned`; the `OPERATIONS` table and its
  `as const satisfies Record<Opcode, OperationSpec>`; `ALL_OPCODES`, `operationOf`,
  `effectsOf`, `canDeoptimize`, `isMovable`, `isTrackedLoad`, `isTrackedStore`,
  `isRematerializable`, `alwaysProducesBoolean`. 1273 lines.
- `src/optimizing/ir/cfg-edit.ts` — `addPhi`, `connect`, `link`, `disconnectAt`,
  `disconnect`, `phiInputFor`, `predecessorIndex`, `removePhi`, `removePhis`,
  `splitEdge`, `splitBlockAfter`, `splitBlockBefore`, `retargetTerminator`,
  `rewriteBranchAsJump`, `BLOCK_TARGET_PROPS`. The single tier for structural mutation.
- `src/optimizing/ir/graph-edit.ts` — `replaceValueUses`, `dropUse`, `detachUsesOf`,
  `detachUsesOfAll`, `detachInputs`, `detachNode`, `retainNodes`, `homeFloatingValues`,
  `maxNodeId`, `reserveNodeIds`, `nodeIdStamper`.
- `src/optimizing/ir/editor.ts` — `GraphEditor` (`replaceAllUses`, `setInput`,
  `insertBefore`, `insertAfter`, `removeIfDead`, `removeDeadChain`, `remove`). 65 lines.
- `src/optimizing/ir/text.ts` — `printIR`, `parseIR`, `GRAPH_FIELDS`, `OpaqueValue`,
  `IRTextError`, `printGraphAttributes`, `splitTopLevel`, `parseValue`.
- `src/optimizing/ir/metadata.ts` — `metadataString`, `metadataNumber`,
  `metadataNumberArray`, `metadataStringArray`: the narrowing helpers that exist
  *because* `props` is untyped.
- `src/optimizing/ir/probe.ts` — `cfgGraphProbe`, which makes `printIR` the one renderer
  the pass tracer uses.
- `src/optimizing/validation/graph-validator.ts` — `validateGraphInvariants`,
  `validateNodeIdentity`, `validateNodeOwnership`, `validatePhis`, `validateUseLists`,
  `validateControlFlow`. What actually enforces the shape.
- `tests/optimizing/ir/def-use.test.ts` — the multiset regression suite.
- `tests/optimizing/ir/operations.test.ts` — the table-completeness suite.
- `tests/optimizing/ir/text.test.ts`, `tests/optimizing/ir/text-fixture.test.ts`,
  `tests/e2e/optimizing/ir-text.test.ts` — the round-trip contract and the fixture
  workflow it enables.

## Worked example

`docs/example/stats.tera`, method `Series.mean` — seven lines of tera that become four blocks,
two phis and twenty-two values.

```bash
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter mean docs/example/stats.tera
```

That dump is the chapter's single running listing. Its last section feeds the same 29
lines back through `parseIR` and prints them again, byte-identical — which is what makes
every pass fixture in Parts VII through X possible.

> Naming note: the running program's method is `mean`, not `total`. The loop it contains
> carries exactly two loop-varying locals, `total` and `i`, which is why the header ends
> up with exactly two phis.

## Outline

- [ ] **§ what-a-register-cannot-tell-you** — Establish the problem. Show `mean`'s
      bytecode (`--print-bytecode --filter mean`): `r3` holds `this.values` at bc:9 and
      `this.values.length` at bc:11. Nothing in the encoding says which store a read
      sees. `> **New idea.**` basic block, control-flow graph, SSA, the
      single-assignment rule. Establish: SSA is not notation, it is the answer to
      "which definition?" precomputed into an edge.
- [ ] **§ three-classes-and-nothing-else** — `CFGFunction` / `CFGBlock` /
      `CFGInstruction` (`index.ts:126-357`). Establish that an instruction *is* the SSA
      value — there is no separate value class — and that `block.nodes` is the schedule.
      `homeInstruction` (`index.ts:359-369`) places a floating value after the phis of a
      block; `GraphEditor.insertBefore` / `insertAfter` are the only sanctioned splices.
- [ ] **§ why-the-obvious-design-fails** *(Why the obvious design fails)* — Stage the
      sea-of-nodes alternative a reader who has met Turbofan would reach for: let pure
      values float, thread effects on a chain, recover a schedule at the end. Then the
      cost this tree refuses to pay: a scheduling pass, an effect-chain invariant every
      pass must maintain, and a second traversal order for every backend. What it buys
      instead: `isMovable` (`operations.ts:1215-1220`) and `isPinned`
      (`operations.ts:1027-1029`) let individual passes move individual nodes, and the one
      place a real scheduler exists is MachineIR (`src/optimizing/machine/schedule.ts`),
      after lowering. Establish: this is a *choice*, recorded, with a named price.
- [ ] **§ the-props-bag** — `IRMetadata = Record<string, IRMetadataValue>`
      (`index.ts:99`). 62 distinct `props.<name>` reads across the tree, plus 29 keyed by
      constant. `metadata.ts` exists solely to narrow them back. Establish the trade:
      opcodes stay few (98) because per-opcode data lives in an untyped side channel, and
      the cost is that a misspelled key is silent. Show the four ad-hoc typed escape
      hatches on `CFGInstruction` (`_deadForSelfRecursion`, `_speculativeType`,
      `_constPtrIndex`, `_inlineNumericStore`) as the same pressure leaking the other way.
- [ ] **§ two-names-for-one-representation** — `CFGInstruction.rep` is assigned in the
      constructor from `props._rep`, copied by `clone.ts:36,131` and `ic-lowering.ts:134`,
      restored by `parseIR` (`text.ts:387`) — and read by no decision anywhere. Every
      real consumer reads `props._rep` instead: `repr-selection.ts:627` writes it,
      `backends/wasm/graph-support.ts:307` and `graph-validator.ts:67,85` read it.
      Establish the rule the rest of the book follows: representation is a `props` key.
      Carries an honesty marker.
- [ ] **§ canonical-phi-ssa** — `> **New idea.**` a phi. The invariant:
      `phi.inputs[i]` is the value arriving from `block.predecessors[i]`; there is no
      `edgeArgs` side table and no second source of truth. The helpers built on it —
      `addPhi`, `connect` (link + append one input to *every* phi),
      `predecessorIndex`, `phiInputFor`, `disconnectAt` (drops the predecessor *and* its
      input column) — `cfg-edit.ts:86-141`. Invariant → enforcement (`validatePhis`,
      `graph-validator.ts:335-350`) → test. Note that `connect` appends `phiArgs[i]`
      positionally, so a caller that supplies fewer arguments than the block has phis
      appends `undefined` and the validator catches it later, not sooner.
- [ ] **§ the-def-use-multiset** — `uses` holds one entry per input **edge**, so
      `irInt32Add(v, v)` yields `v.uses === [add, add]`. `addInput` pushes;
      `replaceInput` calls the four-line `dropOneUse` (`index.ts:121-124`).
      *Bug told as engineering:* the original `replaceInput` did
      `old.uses = old.uses.filter(u => u !== this)`, removing every entry while replacing
      one edge — so `add` still read `v` at index 1 while `v.uses` claimed nobody did.
      Symptom: none, for months, because `rebuildUses()` runs after most passes and
      papered it over; it only bites a pass that reads `uses` between the mutation and
      the next rebuild (DCE, GVN, escape analysis could delete a live value). Mechanism,
      fix, regression test, and the general rule: use-list edits go through
      `graph-edit.ts`; never write `uses = uses.filter(...)` inline — it is both this bug
      and O(n²). Same shape existed in `disconnectAt` and was fixed with `dropUse`.
- [ ] **§ the-operation-table** — `OperationSpec` (`operations.ts:233-247`): thirteen
      fields — `effects`, `terminator`, `pinned`, `removableWhenUnused`,
      `forwardsPointerIdentity`, `arity`, `result`, `operands`, `overload`, `access`,
      `opaqueMemory`, `speculation`, `transfer`. Walk `effects` first
      (`reads`/`writes`/`allocates`/`deopt` over the seven `MemoryKind`s), then the
      constructor helpers that make 98 entries fit on a screen and a half. Establish:
      the table is data, and every predicate a pass asks (`isMovable`, `isEffectFree`,
      `isGuard`, `isTrackedLoad`, `isRematerializable`, `hasObservableEffect`,
      `clobbersAllMemory`) is derived from it, not from an opcode switch. 26 source
      files consult it.
- [ ] **§ effects-that-depend-on-the-node** — `OperationSpec.effects` may be a function.
      Two instances: `declaredCallEffects` maps a callee's declared effect list through
      `DECLARED_EFFECT_RESULTS` (`operations.ts:280-291`), and `dispatchMapEffects`
      reads `props.isStore`. Establish why `staticEffectsOf` (`operations.ts:1097-1099`) returns `null` for these and
      why `isTrackedLoad` / `isRematerializable` / `isAllocationSite` therefore decline
      them — a conservative answer built into the accessor, not into each caller.
- [ ] **§ what-the-table-cannot-be-wrong-about** *(invariant → enforcement → test)* —
      `as const satisfies Record<Opcode, OperationSpec>` (`operations.ts:993`) makes a
      missing entry a type error and a misspelled field a type error, while keeping the
      literal types for `ALL_OPCODES`. Then the two runtime completeness tests, and the
      derived table: `ALWAYS_BOOLEAN` (`operations.ts:1080-1086`) is built at module load
      by *probing every transfer function* with an empty node and an unconstrained
      context and keeping the ones that answer `Boolean`. Establish: nine opcodes are on
      that list and nobody typed the list. `alwaysProducesBoolean(IR_GENERIC_IN)` is true
      while `resultClassOf(IR_GENERIC_IN)` is `RESULT_CONTEXTUAL` — lattice type and
      machine representation are separate axes and the table keeps them separate.
- [ ] **§ transfer-functions** — `Transfer = (node, context) => LatticeType`. Read
      `phiTransfer` (join over inputs), `guardTransfer` (narrow the input by the fact the
      guard proves), `additionTransfer` (string if either side is), `selectionTransfer`.
      Establish that the operation table *contains* the type rules but computes nothing;
      the fixpoint that uses them is `analyses/type-inference.ts` in [Ch 42 §
      type-inference]. Forward-reference the soundness rule from
      [Ch 47 § speculative-taint]: a fact a guard installed is speculative, and a fold
      that ignores that is a miscompile.
- [ ] **§ the-textual-form** — `printIR` (`text.ts:141-152`), the exact grammar
      (`fn <name> params=<n> {`, an optional `graph [...]` line, parameters, then blocks
      as `B<id> [loop-header] succs=… preds=…:`), the `!fs` mark, and the contract
      `printIR(parseIR(t)) === t`. Note the two facts that make the contract non-trivial:
      the `graph [...]` line was omitted from the first version, so a graph with
      `isAsync: true` printed identically to one without and the round-trip test passed
      vacuously — the guard is now "every field of `GRAPH_FIELDS` is equal after a round
      trip", asserted on real optimizer graphs, not hand-built ones. And `preds=` is
      always printed even though it is derivable, because phi inputs are parallel to
      `predecessors` and losing that order silently rewires phis.
- [ ] **§ opaque-values-as-named-loss** — A property the text cannot represent
      (a `RegisterCompiledFunction` in `CheckCallTarget.expectedTarget`, a `ClassTable`)
      prints as `<opaque:RegisterCompiledFunction>` and parses back to an `OpaqueValue`
      carrying that label. Establish the design rule: the loss is *named* and round-trips
      exactly, and touching an `OpaqueValue` in a pass fails loudly — chosen over
      silently substituting a default, which would make a fixture test the wrong path.
      The e2e test asserts the exact set of opaque labels per program, so a newly-lossy
      property kind fails a test instead of slipping through.
- [ ] **§ the-fixture-workflow** — `tests/helpers/ir-text.ts` and
      `src/optimizing/drivers/text-driver.ts`: `afterPass(text, run)` parses, runs one
      pass under a scoped `IRNodeIdAllocator` seeded at `maxNodeId + 1`, and prints.
      Establish that this is why `--print-ir` output pastes straight into a test, and why
      `CFGFunction.dump()` was deleted so `printIR` is the one renderer (pass tracer,
      CLI, tests). Name the limit: `parseIR` reads exactly one `fn` block — it locates
      the body's end with `body.lastIndexOf("}")` — so a whole-program dump must be
      sliced to one function first. Carries an honesty marker.
- [ ] **§ what-actually-checks-any-of-this** — `validateGraphInvariants` and its six
      checks: opcode known, no two nodes on one id, `node.block` agrees with the block
      listing it, phi input count equals predecessor count, control flow well-formed,
      and `uses` exactly equals the multiset the inputs imply
      (`validateUseLists`, `graph-validator.ts:352-387` — it counts, so it catches the
      `add(v, v)` bug). Reachable from `tera compile --verify`. Establish what it does
      *not* check, and hand that to chapter 40.

## Honesty items

- > **Dead.** `CFGInstruction.rep` in `src/optimizing/ir/index.ts:132`. Assigned in the
  constructor from `props._rep`, copied by `src/optimizing/ir/clone.ts:36,131`, restored
  by `parseIR` (`text.ts:387`), propagated by `src/optimizing/passes/ic-lowering.ts:134`
  — and read by no decision. All four real consumers read `props._rep` instead. Removing
  it costs four assignment sites and one field declaration.
- > **Dead.** `CFGBlock.instructions` in `src/optimizing/ir/index.ts:206,216`. Set once
  in the constructor as an alias of `nodes` and read by nothing in `src/` or `tests/`
  (the `block.instructions` reads in `src/optimizing/machine/` and the backends'
  `assembly.ts` are MachineIR blocks, a different type). It is also a hazard, not just
  waste: `retainNodes` and `removePhis` *reassign* `block.nodes`, at which point the
  alias silently points at a stale array. Removing it costs two lines.
- > **Never runs.** `getDefaultIRNodeIdAllocator` in `src/optimizing/ir/index.ts:57-59`.
  Exported, zero call sites in `src/`, `tests/` or `tools/`. Its sibling
  `getCurrentIRNodeIdAllocator` is live (`text.ts:363`, `graph-edit.ts:94`).
- > **Unfinished.** `parseIR` in `src/optimizing/ir/text.ts:314-423` reads exactly one
  function: it takes `body.lastIndexOf("}")` as the body's end, so a two-function dump
  fails with `malformed instruction "}"` and a *truncated* one-function dump fails with
  `unterminated property list in …` when a graph attribute happens to end in `}`.
  Verified by feeding a whole-program `--print-ir` dump to it. Finishing it costs a
  top-level loop over `fn` blocks and a return type change from `CFGFunction` to a list.
- > **Unenforced.** Nothing checks that a `props` key a pass writes is a key any consumer
  reads, or that the type matches. `src/optimizing/ir/metadata.ts` narrows defensively at
  read time and answers `null` on a mismatch; a typo in the *writer* is silent. The
  operation table constrains opcodes exhaustively and `props` not at all.
- > **Unenforced.** `connect(pred, succ, phiArgs)` in `src/optimizing/ir/cfg-edit.ts:103-110`
  appends `phiArgs[i]` for every phi in `succ`, including `undefined` when the caller
  supplies too few. Nothing rejects that at the call; `validatePhis` reports
  `B<n> v<id> input <i> is empty` only if a validator later runs.

## Verify it yourself

```bash
# the chapter's running listing: four blocks, two phis, twenty-two values
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter mean docs/example/stats.tera

# where the phis came from: r3 holds two different values in one method
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# the operation table's completeness and derived-boolean tests
npx vitest run --project unit tests/optimizing/ir/operations.test.ts

# the def-use multiset, and the round trip that makes pass fixtures possible
npx vitest run --project unit tests/optimizing/ir/def-use.test.ts \
  tests/optimizing/ir/text.test.ts tests/optimizing/ir/text-fixture.test.ts

# the same round trip against graphs the real optimizer produced
npx vitest run --project e2e tests/e2e/optimizing/ir-text.test.ts
```

## Tests that pin this

- `tests/optimizing/ir/def-use.test.ts` > "keeps one use entry per input edge when a value feeds a node twice"
- `tests/optimizing/ir/def-use.test.ts` > "removes only the replaced edge, leaving the surviving edge listed"
- `tests/optimizing/ir/def-use.test.ts` > "empties the use list only once every edge has been replaced"
- `tests/optimizing/ir/def-use.test.ts` > "rewrites every edge of a repeated operand through replaceValueUses"
- `tests/optimizing/ir/def-use.test.ts` > "drops a single use entry rather than every occurrence"
- `tests/optimizing/ir/def-use.test.ts` > "keeps the remaining phi edge listed when one predecessor is disconnected"
- `tests/optimizing/ir/def-use.test.ts` > "detaches a batch of nodes from a shared producer in one pass"
- `tests/optimizing/ir/def-use.test.ts` > "records a dependency once no matter how often it is added"
- `tests/optimizing/ir/operations.test.ts` > "declares an entry for every exported opcode constant"
- `tests/optimizing/ir/operations.test.ts` > "exposes exactly the declared opcodes and nothing else"
- `tests/optimizing/ir/operations.test.ts` > "declares the arity each IR constructor actually builds"
- `tests/optimizing/ir/operations.test.ts` > "keeps the effect classifications mutually exclusive"
- `tests/optimizing/ir/operations.test.ts` > "derives the boolean-producing operations from their type transfers"
- `tests/optimizing/ir/operations.test.ts` > "separates machine representation from lattice type for instanceof and in"
- `tests/optimizing/ir/operations.test.ts` > "never classifies one operation as both a tracked load and a tracked store"
- `tests/optimizing/ir/operations.test.ts` > "derives call effects from the effects the caller declared"
- `tests/optimizing/ir/operations.test.ts` > "drives dead code elimination: stores survive, unused loads and arithmetic do not"
- `tests/optimizing/ir/text.test.ts` > "round-trips a printed function unchanged"
- `tests/optimizing/ir/text.test.ts` > "keeps phi inputs aligned with the predecessor order"
- `tests/optimizing/ir/text.test.ts` > "derives predecessors from successors when they are left out"
- `tests/optimizing/ir/text.test.ts` > "names the type of a property it cannot represent, and keeps the name"
- `tests/optimizing/ir/text.test.ts` > "keeps every field of the declared field list identical across a round trip"
- `tests/optimizing/ir/text.test.ts` > "names an attribute it cannot represent instead of dropping it"
- `tests/optimizing/ir/text-fixture.test.ts` > "drops the value nothing consumes and keeps the rest"
- `tests/e2e/optimizing/ir-text.test.ts` > "round-trips a counted loop through parse and print"
- `tests/e2e/optimizing/ir-text.test.ts` > "names every property of a branching call it cannot represent"
- `tests/e2e/optimizing/ir-text.test.ts` > "keeps every function-level field of a counted loop"
- `tests/optimizing/builder/ir-builder.test.ts` > "connect appends one phi input per predecessor"
- `tests/optimizing/builder/ir-builder.test.ts` > "reconstructs use lists from inputs"
- `tests/optimizing/validation/graph-validator.test.ts` > "throws when two nodes in a block claim the same id"
- `tests/optimizing/validation/graph-validator.test.ts` > "throws when a phi has fewer inputs than the block has predecessors"
- `tests/optimizing/validation/graph-validator.test.ts` > "throws when a node carries an opcode the property table does not describe"
- `CFGInstruction.rep` being dead: [unpinned] — no test asserts it is unread.
