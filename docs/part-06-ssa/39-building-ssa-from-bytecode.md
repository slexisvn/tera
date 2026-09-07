# 39. Building SSA from bytecode   ⟨· · J · N⟩

> **Status:** outline

**Thesis.** A loop header has to place phis before the back-edge values exist, so the
builder inserts a phi for every slot and lets a later pass delete the excess.

**What arrived.** The `CFGFunction` shape of chapter 38, still empty — plus a
`RegisterCompiledFunction` with its instruction array, constant pool, source map,
`localCount`/`paramCount`/`registerCount`, and the feedback vector chapter 33 filled in.

**What leaves.** That same `CFGFunction`, populated: blocks discovered, phis placed and
closed, feedback turned into guards, dependencies registered, and — on the native tier —
every recoverable call followed by a pending-throw test. Chapter 40 takes the frame
states this walk attached; Part VII takes the graph itself.

**New ideas.** a back edge and a loop header; why a *forward* walk cannot know a loop
header's incoming values; a maximal-phi placement and why it is correct-but-wasteful;
speculation as an explicit guard node; an exception edge, and the trick of not having one.

**Length.** 20 pages

## Anchors

- `src/optimizing/builder/ir-builder.ts` — `buildIR` (the whole walk, lines 304-455),
  `compileInstruction` (the ~1800-line opcode dispatch, 475-2270), `closeLoopEdge`,
  `bailOut`, `SUSPENDING_AWAIT_REASON`, `SPREAD_CALL_REASON`, `UNSUPPORTED_REASONS`,
  `RECOVERABLE_CALLS`, `hotSuccessorOf`, `capturedLocalSlots`, `landingOf`, `positionAt`,
  `AWAITED_CALL_PROP`. 2272 lines.
- `src/optimizing/builder/cfg-state.ts` — `RegisterState`, `IncomingStatesByTarget`,
  `rememberIncomingState`, `definedValue`, `openLoopHeader`, `addLoopBackedgeInputs`,
  `mergeIncomingState`, and the `ACC_SLOT = -1` convention that lets the accumulator ride
  in the same slot map. 174 lines — the whole SSA construction algorithm.
- `src/optimizing/builder/register-liveness.ts` — `registerLiveness`, `analyze`
  (a backward bitset dataflow over the bytecode, worklist to fixpoint),
  `successorsOf`, `closureCapturedSlots` seeding, `isLive`. Used by chapter 40.
- `src/optimizing/builder/throw-recovery.ts` — `handlerStacksOf`, `branchOnPendingThrow`,
  `recoverAfterCall`, `recordPendingThrow`, `takePendingThrow`, `returnPendingThrow`,
  `PENDING_THROW_PROP`, `PendingThrowLanding`. 215 lines.
- `src/optimizing/builder/inline.ts` — `selectInlineTarget`, `canInlineTarget`,
  `tryInline`, `inlineCallee`, `buildPolymorphicDispatch`, `recordInlineDecision`, and
  `captureFrameStateWithCaller` as used to build caller chains. 1157 lines.
- `src/optimizing/builder/feedback-utils.ts` — `COMPARE_OP_MAP`, `constantString`,
  `numericPackedElementRep`, `numericFeedbackKind`.
- `src/optimizing/builder/property-nodes.ts` — `genericDeletePropNode`.
- `src/optimizing/ir/index.ts` — `IRNodeIdAllocator`, `withIRNodeIdAllocator`,
  `getCurrentIRNodeIdAllocator`, `resetIRNodeIds`, `OsrCandidate`,
  `withIRSourcePosition`, `currentIRSourcePosition`.
- `src/optimizing/ir/graph-edit.ts` — `maxNodeId`, `reserveNodeIds`, `nodeIdStamper`.
- `src/optimizing/passes/dce.ts` — `eliminateTrivialPhis` (61-106) and
  `eliminateDeadPhis` (109-138): the "later pass" the thesis relies on.
- `src/optimizing/pipeline.ts` — `runMiddleEnd` (`reserveNodeIds` on entry, line 318),
  and the four `trivial-phi-elimination*` steps.
- `src/optimizing/optimizer.ts:150-200` — the call order: parameters, entry block,
  `buildIR`, bailout check, `rebuildUses`, unreachable-block elimination, OSR, then the
  middle end.

## Worked example

`docs/example/stats.tera`, method `Series.mean`.

```bash
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter mean docs/example/stats.tera
```

Block `B3` is the loop header. It carries exactly two phis — `v3` for `total` and `v4`
for `i` — each with the entry value first and the back-edge value last, matching
`preds=B0,B2`. The `graph [...]` line records
`osrCandidates=Map{4: {headerBlockId: 3, slots: [0, 1], phiIds: [3, 4]}}`, which is the
builder's own record of what it placed there.

The over-placement is visible in the variation:

```bash
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter total_of docs/example/stats-deopt.tera
```

Here `openLoopHeader` placed **three** phis — `osrCandidates` still says
`slots: [0, 1, 2], phiIds: [4, 5, 6]` — and the printed header holds only `v5` and `v6`.
`v4` was the slot holding the `values` parameter, whose two incoming values were the same
node, so `eliminateTrivialPhis` folded it away. That is the thesis in one dump: place a
phi per slot, delete the excess.

## Outline

- [ ] **§ one-walk-no-dominators** — Establish the shape before any detail: `buildIR` is
      a single forward pass over the instruction array with one accumulator (`acc`) and
      one register-slot map (`regs`), and no dominator tree — the classic Cytron
      placement algorithm needs dominance frontiers and this builder deliberately does
      not compute them. Contrast with what chapter 42 computes later, for the *passes*.
- [ ] **§ finding-the-blocks** — Two prepasses over the instruction array
      (`ir-builder.ts:346-368`). First: every jump target gets a block, and so does the
      instruction after it — plus, when `graph.recoversThrows`, every handler target.
      Second: any jump whose target is at or before it marks that target
      `isLoopHeader = true`. Establish that "is this a loop header?" is answered by a
      backward branch and nothing else — no loop analysis at build time.
      `> **New idea.**` back edge, loop header.
- [ ] **§ the-accumulator-and-the-slot-map** — Register bytecode has an accumulator
      (chapter 25); `buildIR` models it as a plain local variable `acc`, handed between
      block bodies through `CFGBlock._lastAcc`. `cfg-state.ts` folds it into the same
      slot map under `ACC_SLOT = -1`, so merge and phi placement need one code path, not
      two. Establish: parameters are seeded into `regs` at `receiverSlots + i`, and
      captured slots become `StoreContextSlot` at entry
      (`capturedLocalSlots`, `ir-builder.ts:325-345`).
- [ ] **§ remembering-what-arrives** — `rememberIncomingState` is called on *every* edge
      the builder creates: on fallthrough into a discovered block (line 383), at each
      jump and branch arm (1457, 1473, 1475), and from a throw landing (2169). Each call
      snapshots `regs` (a copy) and `acc` against the target's bytecode offset.
      Establish: the builder never asks "what reaches here?" — it accumulates the answer
      as it goes, keyed by target, and the target reads it when the walk arrives.
- [ ] **§ merging-a-join** — `mergeIncomingState` (`cfg-state.ts:151-174`): index the
      recorded states by predecessor, take the union of live slots, and for each slot
      collect one incoming value per `block.predecessors[i]` *in predecessor order*. If
      every incoming value is the same node, keep the node; otherwise `addPhi`.
      Establish that a phi is created only where predecessors disagree, and that
      `definedValue` fills a `Constant undefined` homed in the predecessor when a slot is
      missing from one arm — so a phi never has a hole.
- [ ] **§ the-problem-a-loop-header-has** — Stage it concretely on `mean`. At the moment
      the walk reaches bc:4 (the header) it has seen exactly one edge, from `B0`. The
      values on the back edge — `v13` for `total`, `v15` for `i` — do not exist yet, and
      cannot, because they are computed by instructions the walk has not read. Whatever
      the header decides now is wrong for at least one predecessor. Establish that this
      is not an implementation wart: it is the reason SSA construction is a named
      problem.
- [ ] **§ why-the-obvious-design-fails** *(Why the obvious design fails)* — Stage the
      two designs a reader reaches for. (a) Two passes: discover the loop, then build.
      Cost: a second traversal, and a builder that must be re-entrant over the same
      bytecode. (b) Cytron: compute the dominator tree and iterated dominance frontiers
      first, insert phis exactly where needed. Cost: dominance before construction, in a
      builder whose whole shape is one forward walk. What this tree does instead:
      `openLoopHeader` (`cfg-state.ts:91-113`) inserts a phi for **every** slot in
      `range(localCount)` plus every slot any recorded predecessor mentions, then clears
      `regs` and re-seeds it entirely from the phis. Correct by construction, wasteful by
      construction, and the waste is somebody else's problem.
- [ ] **§ closing-the-back-edge** — `addLoopBackedgeInputs` (`cfg-state.ts:115-149`),
      reached from `closeLoopEdge` when the walk finally emits the jump back to the
      header. Three jobs: append the latch value to every phi that is short; create a
      *late* phi for a slot the header did not open (and `republish` it into every
      recorded state naming that block, so nothing keeps reading the pre-phi value); and
      self-reference (`phi.addInput(phi)`) any phi whose slot the latch does not define.
      Establish `expectedInputs = block.predecessors.length + 1` — the count is one ahead
      because the latch edge is being added right now.
- [ ] **§ the-padding-sweep** — The final loop of `buildIR` (`ir-builder.ts:448-454`):
      `while (phi.inputs.length < block.predecessors.length) phi.addInput(phi)`.
      Establish the invariant it exists to satisfy — `validatePhis` requires
      `phi.inputs.length === block.predecessors.length` — and the deliberate choice of
      *self* as the filler: a self-input is ignored by `trivialPhiInput` and by
      `eliminateTrivialPhis`, so padding never blocks the fold that removes the padding.
      A `Constant undefined` filler would have been a real second value and would have
      pinned every over-placed phi forever.
- [ ] **§ someone-else-deletes-the-excess** — `eliminateTrivialPhis` (`dce.ts:61-106`):
      worklist over every phi, ignore self-inputs, fold when at most one distinct other
      input remains, re-enqueue phi consumers so chains collapse, then `removePhis` and
      `rebuildUses`. `eliminateDeadPhis` (109-138) removes the ones nothing uses *and no
      frame state names* — the first appearance of chapter 40's rule. Establish that the
      pipeline runs `trivial-phi-elimination` four times (`pipeline.ts:124,239,254,272`)
      because later passes create new trivial phis. Show `total_of` losing `v4`.
- [ ] **§ feedback-becomes-speculation** — The other half of `compileInstruction`. For
      each shape, the guard chain the builder emits and the dependency it registers:
      monomorphic property → `CheckMap` + `LoadField(offset)` + `addDependency(DEP_MAP,
      mapId, mapVersion)` (`ir-builder.ts:1092-1112`); polymorphic → `PolymorphicLoad`
      with parallel `maps`/`offsets` arrays and no map check (1145); array element →
      `CheckArray` + `CheckElementsKind` + `CheckBounds` + `LoadElement`, with
      `addDependency(DEP_ELEMENTS_KIND, kind)` (1330-1345); `.length` on a known
      elements-kind → `LoadArrayLength` (1056-1064). Establish the pattern: feedback
      never becomes a *fact*, it becomes a guard node plus a registered dependency, and
      chapter 40 makes the guard survivable. Every branch of every one of these has an
      `else` that emits the generic node — the builder degrades, it does not refuse.
- [ ] **§ branch-bias-steers-block-order** — `hotSuccessorOf` (`ir-builder.ts:232-244`)
      reads `feedback.branch(slot).bias`, corrects for whether the opcode is
      `JUMP_IF_FALSE` or `JUMP_IF_TRUE`, and stamps `branch.props.hotSuccessor`.
      Establish that this is a *hint in a props key*, consumed much later by block
      layout in [Ch 69 § loop-layout], and that all three links of this were dead until
      2026-08-18.
- [ ] **§ exceptions-with-no-exception-edges** — The chapter's best structural idea, and
      a native-tier one (`graph.recoversThrows` is set by `needsThrowRecovery` in
      `src/api/engine.ts:480-483`, and defaults to `false` in `optimizer.ts:128`, so the
      JIT never does this). `handlerStacksOf` walks the bytecode to give every offset the
      stack of handlers covering it. Then after **every** call in `RECOVERABLE_CALLS`
      (`ROP_CALL`, `ROP_CALL_METHOD`, `ROP_CALL_NAMED`, `ROP_CALL_METHOD_NAMED`,
      `ROP_AWAIT`), `recoverAfterCall` splices in: load the pending-throw flag out of
      `tera_context`, compare it to zero, `Branch` to a taken block and a resumed block.
      The taken block either takes the pending value and jumps to the enclosing handler,
      or returns the marked `PENDING_THROW_STATUS`. Establish the payoff: there is no
      exception edge kind, no invoke instruction, no landing-pad concept — every pass in
      Parts VII through X sees ordinary blocks and ordinary branches and needs to know
      nothing about exceptions.
- [ ] **§ the-two-prose-bail-outs** — `UNSUPPORTED_REASONS` (`ir-builder.ts:105-108`) maps
      exactly two opcodes to a sentence written for a user rather than a compiler
      engineer. Quote both verbatim (convention 5): `ROP_AWAIT`'s
      `SUSPENDING_AWAIT_REASON` and `ROP_CALL_SPREAD`'s `SPREAD_CALL_REASON`. Every other
      unhandled opcode gets the machine-shaped fallback
      `unhandled opcode <name> (0x<hex>) at bc:<n>`. Establish that `graph.bailout` is
      set with `??=` — the *first* reason wins — and that `optimizer.ts:166` returns
      immediately on it, so a bail-out is a decline, not an error. This is the same
      "refusal as specification" pattern the AOT compiler uses in [Ch 56 § aot-declines].
- [ ] **§ inlining-happens-during-construction** — Not a pass: `tryInline` /
      `inlineCallee` (`inline.ts:266-…`) splice a callee's bytecode into the caller's
      graph *while the caller is being built*, with its own `inlineBlockMap`,
      `inlineIncoming` and `inlineLoopPhis` — a nested copy of everything this chapter
      described, drawing blocks from the same `CFGFunction`. Establish what it must not
      break: the callee's frame states get the caller's as
      `callerFrameState` (`captureFrameStateWithCaller`), a looping callee is refused
      past `maxLoopingCalleeSize`, and a declared-`int` return is re-wrapped with a
      `CheckSmi` at the splice. Point at [Ch 49 § module-inliner] for the AOT inliner,
      which is a different program at a different level.
- [ ] **§ one-counter-over-one-id-space** *(What was tried and rejected)* — The war story.
      The old hard rule was "any pass that creates nodes must stamp them with
      `nodeIdStamper(graph)`", and stamping was *causing* the collisions it was meant to
      prevent, because there were two counters over one id space: the ambient
      `IRNodeIdAllocator` in `CFGInstruction`'s constructor, and `nodeIdStamper`, seeded
      at `maxNodeId(graph) + 1`. `resetIRNodeIds()` runs before every unit and the
      builder numbers densely from 0, so at pipeline entry those two are *equal by
      construction* — the stamper's first id is always the allocator's next id, and the
      next bare `ir*()` call re-issues it. Symptom: `examples/business.tera` carried `v8`
      naming both a `Constant` and an `Await`; and before that,
      `examples/control_flow.tera` refused to compile with *"array has an unsupported
      element type"* because type inference was keyed by `node.id`, the second node on a
      shared id was never enqueued, and `typeOf` answered the bottom `Never`. Fix: one
      counter, `reserveAbove` at the four places a graph can be re-entered with ids the
      allocator does not know (`parseIR`, `runMiddleEnd`, `coroutines.withFreshNodeIds`,
      `nodeIdStamper` itself), plus type inference re-keyed by node identity and
      `validateNodeIdentity` reporting `v<id> names both <A> and <B>`. General rule: do
      not add `nodeIdStamper` "for safety" — it buys nothing now; call `reserveNodeIds`
      once at any entry point that introduces foreign ids.
- [ ] **§ what-leaves** — Restate the artifact and hand off: a graph with maximal phis
      not yet trimmed, guards not yet checked for redundancy, generic nodes not yet
      lowered, and a frame state on every node that can deoptimize. That last one is
      chapter 40.

## Honesty items

- > **Unenforced.** `CFGFunction.osrCandidates` records `phiIds` at build time
  (`ir-builder.ts:405-409`) and nothing keeps them in step with phi elimination.
  `--print-ir` on `docs/example/stats-deopt.tera` shows a candidate naming `phiIds:
  [4, 5, 6]` for a header that holds only `v5` and `v6`. `applyOsrTransform`
  (`src/optimizing/passes/osr.ts:167-170`) handles this by `return false` — it silently
  declines OSR for that loop rather than repairing the record. Live-safe in the shipped
  order (OSR runs before `runMiddleEnd`, `optimizer.ts:172-184`), but it makes a printed
  post-optimization graph unusable as an OSR fixture.
- > **Unfinished.** `bailOut` (`ir-builder.ts:132-143`) has two written explanations for
  twelve call sites. Every other decline reads
  `unhandled opcode <name> (0x<hex>) at bc:<n>` — accurate, and useless to the person who
  wrote the tera. Finishing it costs one sentence per opcode in `UNSUPPORTED_REASONS`.
- > **Unenforced.** `graph.bailout ??= reason` keeps the *first* bail-out and discards
  every later one, so a function that hits two unsupported opcodes reports only the
  earlier. Nothing records that a second existed. Same shape as the AOT decline cascade
  in [Ch 56 § refusal-cascade], where both messages *are* shown.
- > **Dead.** The stamping half of `nodeIdStamper`
  (`src/optimizing/ir/graph-edit.ts:99-105`) is redundant since the ambient allocator
  became the single counter: a freshly constructed node already holds a fresh id, and the
  stamp assigns it a second one. Only the `reserveNodeIds` call inside it is
  load-bearing. Removing the stamp costs an audit of ~90 call sites, which is why it is
  still there.
- No honesty marker for `compileInstruction`'s length (`ir-builder.ts:475-2270`, one
  `switch`). It is large because the bytecode is large; splitting it would move the same
  dispatch somewhere else. Stated once, not marked.

## Verify it yourself

```bash
# the loop header, its two phis, and the builder's own osrCandidates record
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter mean docs/example/stats.tera

# the bytecode it was built from: r3 reused, no definitions
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# maximal placement, then the fold: 3 slots recorded, 2 phis surviving
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter total_of docs/example/stats-deopt.tera

# the SSA construction algorithm and the liveness it rides on
npx vitest run --project unit tests/optimizing/builder/cfg-state.test.ts \
  tests/optimizing/builder/register-liveness.test.ts

# exceptions as ordinary control flow
npx vitest run --project unit tests/optimizing/builder/throw-recovery.test.ts

# the invariants the walk must leave true
npx vitest run --project unit tests/optimizing/validation/graph-validator.test.ts
```

## Tests that pin this

- `tests/optimizing/builder/cfg-state.test.ts` > "creates phis for registers that differ across predecessors"
- `tests/optimizing/builder/cfg-state.test.ts` > "keeps a single value when every predecessor agrees"
- `tests/optimizing/builder/cfg-state.test.ts` > "fills undefined for a register missing from one predecessor"
- `tests/optimizing/builder/cfg-state.test.ts` > "fills undefined for an accumulator missing from one predecessor"
- `tests/optimizing/builder/cfg-state.test.ts` > "drops registers that no predecessor defines"
- `tests/optimizing/builder/cfg-state.test.ts` > "creates a phi for every local slot"
- `tests/optimizing/builder/cfg-state.test.ts` > "seeds header phis from the recorded entry state, not the walking state"
- `tests/optimizing/builder/ir-builder.test.ts` > "lowers MOV as source then destination"
- `tests/optimizing/builder/ir-builder.test.ts` > "creates Phi and adds to phis and nodes"
- `tests/optimizing/builder/ir-builder.test.ts` > "multiple phis get sequential indices"
- `tests/optimizing/builder/ir-builder.test.ts` > "connect appends one phi input per predecessor"
- `tests/optimizing/builder/ir-builder.test.ts` > "overflow-capable arithmetic requires frame state unless noOverflow"
- `tests/optimizing/builder/register-liveness.test.ts` > "keeps a register the loop reads again after the backedge"
- `tests/optimizing/builder/register-liveness.test.ts` > "declines to analyze bytecode holding an opcode it cannot model"
- `tests/optimizing/builder/register-liveness.test.ts` > "settles on a loop whose live register sits in the top bit of a word"
- `tests/optimizing/builder/throw-recovery.test.ts` > "covers the body between a try and its end with the handler it declares"
- `tests/optimizing/builder/throw-recovery.test.ts` > "nests an inner handler on top of the one already covering the body"
- `tests/optimizing/builder/throw-recovery.test.ts` > "splits the block into a taken and a resumed half, both linked from it"
- `tests/optimizing/builder/throw-recovery.test.ts` > "returns the pending throw when the call sits under no handler"
- `tests/optimizing/builder/throw-recovery.test.ts` > "jumps to the handler and remembers the thrown value for it when one is in scope"
- `tests/optimizing/builder/throw-recovery.test.ts` > "carries the register state of the call site into the handler's incoming state"
- `tests/optimizing/builder/top-level-graph.test.ts` > "builds a graph the backend accepts"
- `tests/optimizing/builder/top-level-graph.test.ts` > "prints what the interpreter prints"
- `tests/optimizing/validation/graph-validator.test.ts` > "accepts a phi whose input count matches the predecessor count"
- `tests/optimizing/validation/graph-validator.test.ts` > "throws when a phi has more inputs than the block has predecessors"
- `tests/optimizing/validation/graph-validator.test.ts` > "throws when use-def dominance is violated"
- Trivial-phi elimination on a real loop: [unpinned] — `eliminateTrivialPhis` has no
  dedicated unit test; it is exercised through `tests/optimizing/ir/text-fixture.test.ts`
  and the e2e tiers only.
