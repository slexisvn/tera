# 78. Verifiers Everywhere   ⟨**I** · **B** · **J** · **N**⟩

> **Status:** outline

**Thesis.** In a codebase with no comments, a verifier is the only executable statement of
an invariant — and the invariants worth writing down are the ones that look obviously true.

**What arrived.** From [Ch 77]: the `GraphVerification<G>` hook on `PassManager` and the
`verification: readonly string[]` field it fills. `PassManager.step` calls it after any
pass that reported `changed`, puts the result on the trace record *carrying the graph that
broke*, and only then throws `VerificationError`. That hook is the socket; this chapter is
what plugs into it. Also arriving: `CompilerOptions.verifyEachPass`, the boolean the
`compile --verify` flag sets.

**What leaves.** The measured limit of static checking. Verifiers catch structural damage
to a graph — a stale use edge, a phi with the wrong arity, a value read before it is
defined — and they catch it in whichever tier is *running them*. They cannot catch a
graph that is well-formed and means the wrong thing, and they are not run at all in three
places this chapter names. Chapter 79 opens on exactly that gap and answers it with a
different kind of evidence: not "is this graph well-formed?" but "does this program
answer the same thing every way it is run?"

**New ideas.**

- `> **New idea.** A verifier.` A function that takes a data structure and returns the list
  of things wrong with it, run in a debug configuration and not in production. It is not a
  test — it does not supply inputs. It is an assertion that travels with every input the
  program is ever given.
- `> **New idea.** A multiset.` The use-list check compares not *which* nodes use a value
  but *how many times each one does*, because `add(v, v)` uses `v` twice and a def-use
  edge that goes missing in that case is invisible to a set comparison. `countUses`
  returns a `Map<node, number>` for this reason.
- Dominance, SSA, phis, frame states and backward dataflow are all reused, not introduced —
  [Ch 39 § dominators], [Ch 38 § ssa], [Ch 40 § frame-states], [Ch 65 § liveness].

**Length.** 12 pages

## Anchors

- `src/optimizing/validation/graph-validator.ts` (652 lines) — three exported entry points
  and one error class:
  - `GraphValidationError` (line 41) with an `errors: string[]` field; the message is the
    errors joined with `"; "`.
  - `validateRepresentations` (line 51) — the *legalizer's* checker. Runs `validateStamp`
    over parameters and every node whose `resultClassOf(node.type) !== RESULT_NONE`, then
    compares `abiRepresentationOf` of every `IR_RETURN` input against
    `graph.returnRepresentation`. Errors: `"B{n} v{id} {type} has no representation"`,
    `"graph has no return representation"`, `"B{n} v{id} returns {abi} but the graph
    declares {abi}"`.
  - `validateGraphInvariants` (line 109) — the *per-pass* checker. `isEmptyGraph`, then
    `collectStructuralErrors` and nothing else.
  - `validateOptimizedGraph` (line 120) — the *pre-codegen* checker. `validateFrameStates`,
    then `collectStructuralErrors`, then `validateFrameStateValueDominanceWith`.
  - `collectStructuralErrors` (line 94) — the shared seven, in order: `validateOpcodes`,
    `validateNodeIdentity`, `validateNodeOwnership`, `validatePhis`, `validateControlFlow`,
    `validateUseDefDominanceWith`, `validateUseLists`.
  - the check bodies: `validateOpcodes` (138), `validateNodeIdentity` (153),
    `validateNodeOwnership` (175), `validateControlFlow` (198), `validateBlockEdges` (236),
    `validateBranchTerminator` (261), `validateJumpTerminator` (286),
    `validateFrameStates` (306), `validatePhis` (335), `validateUseLists` (352),
    `graphValues` (392), `incrementUse` (412), `countUses` (419),
    `validateUseDefDominanceWith` (425), `validateFrameStateValueDominanceWith` (464),
    `validateFrameStateValues` (486), `validateFrameStateValueAvailable` (550),
    `valueLocations` (577), `validateInputAvailable` (590),
    `validatePhiInputAvailable` (625).
- `src/optimizing/pipeline.ts:291-299` — `verifyAfterPass`, the `GraphVerification<CFGFunction>`
  that calls `validateGraphInvariants`, catches `GraphValidationError` and maps each message
  to `` `${graph.name} after ${pass}: ${message}` ``. `cfgPassManager` (line 301) installs
  it only when `options.verifyEachPass`. `runMiddleEnd` (line 314) runs the same check on
  the as-built graph under the pass name `"it was built"`.
- `src/optimizing/optimizer.ts:186-199` — the JIT's sequence: `buildFrameStateIndex`,
  `runMiddleEnd`, `clearFrameStateIndex`, `repairFrameStateDominance`, then
  `validateOptimizedGraph(graph, this.frameStates)`. `staticCompilerOptions` (line 36) —
  `{ ...base, sinkAllocations: false, deoptimizes: false }` — is the AOT configuration.
- `src/optimizing/passes/osr.ts:276-306` — `repairFrameStateDominance`. Read what it
  actually does: for every frame-state value that is not a parameter, not a constant, not
  a sunk allocation, and whose defining block does not dominate the use, it calls
  `replace(placeholder)` where `placeholder = ir.irConstant(undefined)`. It does not
  recover the value; it forgets it. This is why frame-state dominance is checked *after*
  the middle end and not between passes.
- `src/optimizing/backends/wasm/codegen.ts:3955` — the second and last caller of
  `validateOptimizedGraph` in `src/`.
- `src/optimizing/target/legalization.ts:99-105` — `representationCheckPass`, the
  `TransformPass` wrapper that runs `validateRepresentations` as a pipeline step with
  `preserves: { kind: "all" }` and `changed: false`, so it is a pass that only ever
  observes. Also `frame-state-elision` (line 410), which is why AOT graphs mostly have no
  frame states left to damage.
- `src/optimizing/machine/verifier.ts` (209 lines) — `MachineStage =
  "pre-allocation" | "post-allocation"`, `MachineValidationError`,
  `validateMachineFunction(fn, stage, after)` (line 192), and the five checks:
  `validateBlockLinks` (34), `validateOperands` (63), `validateTiedForm` (94),
  `validateNoVirtualsRemain` (120, post-allocation only), `validateReachingDefs`
  (161, pre-allocation only, a backward `solveMonotone` over `setLattice<VirtualRegister>`
  whose only error is `"v{n} is read on a path that never defines it"`).
- `src/optimizing/machine/pipeline.ts:30-68` — `compileMachineFunction` and its local
  `verify(fn, stage, after)` closure, called at six points:
  `"instruction-selection"`, `"scheduling"`, `"two-address-lowering"`,
  `"register-allocation"`, `"frame-code"`, `"peephole"`. The same closure drives
  `options.machineTracer`, so verifying and recording are one hook.
- `src/bytecode/register/ops/register-effects.ts` — `registerEffectsOf`,
  `controlEffectOf`, `jumpTargetOf`, `handlerTargetOf`, `forEachRegisterRead`,
  `forEachRegisterWrite`, `closureCaptures`, `closureCapturedSlots`, `ControlEffect`, and
  the shared effect constants (`ACCUMULATOR_ONLY`, `READS_FIRST`, `READS_FIRST_TWO`,
  `LOADS_FIRST`, `MOVES_FIRST_TO_SECOND`, `READS_CALLEE_AND_ARGUMENTS`,
  `READS_CALLEE_AND_NAMED_ARGUMENTS`). This is a *table*, and a table can be checked for
  completeness against the opcode list.
- `src/bytecode/register/ops/bytecode.ts` — 90 `export const ROP_*` opcodes, and
  `RegisterCompiledFunction.patchJump`. There is no verifier over any of it: a grep for
  `validate` or `verif` across `src/bytecode/` returns nothing.
- `tests/e2e/optimizing/aot/feature-matrix.test.ts:91` — `const VERIFIED =
  compilerOptions("speed", { verifyEachPass: true })`, applied to both `BACKENDS` entries
  (`c` at `format: "assembly"`, `x64-windows` at `format: "executable"`). 58 features × 3
  cases = 174 tests, all with both verifiers on.

## Worked example

Turning `verifyEachPass` on for the first time, and the failure it produced within minutes.
`strengthReduction` rewrote an `Int32Mul` into a shift and removed the multiply from its
block — without detaching the multiply from the use lists of its own inputs. The graph was
still *runnable*; every subsequent pass that asked "who uses this value?" got a wrong
answer. `validateUseLists` names it exactly:

```
v7 Int32Mul has stale use by v12 Int32Add
```

It fired in 18 of the 58 feature-matrix samples. This is the same class of def-use
corruption as [Ch 44 § replace-input], and it is the argument of the chapter in one bug:
nobody would have written a *test* for "strength reduction maintains use lists", because
that is not what strength reduction is for.

> The failure count and the timing come from the project's own working notes, not from a
> test in this tree. The *fix* is pinned: `"drops the replaced multiply from the use lists
> of its inputs"`. [unpinned] for the 18/58 figure.

## Outline

- [ ] **What a verifier is, and what it is not.** `> **New idea.** A verifier.` Establish
      the difference from a test: a test chooses its input, a verifier runs on every input
      the program is ever given. Establish the shape all three of this tree's verifiers
      share — accumulate into `string[]`, throw one error carrying all of them, never
      return `false` — and why that shape matters when a single bad rewrite produces
      forty messages.
- [ ] **Three entry points, three jobs.** Establish the table before walking any check:
      `validateGraphInvariants` is structural and runs between passes;
      `validateOptimizedGraph` is structural *plus* frame states and runs once before
      codegen; `validateRepresentations` is neither, and runs as an ordinary pipeline pass
      inside legalization. Establish that only the first is what `--verify` turns on.
- [ ] **The seven structural checks, with their messages.** Walk `collectStructuralErrors`
      in its own order, quoting the error string each check produces, because the message
      *is* the specification:
      - `validateOpcodes` — every node's `type` is in the operation spec table.
        `"v{id} has no operation spec for {type}"`.
      - `validateNodeIdentity` — one id names one node. `"v{id} names both {a} and {b}"`.
        Establish why this one exists at all: [Ch 43 § node-ids] and the SCCP bug where two
        nodes shared an id and type inference, keyed by id, answered `Never`.
      - `validateNodeOwnership` — `node.block === block` for everything a block lists,
        with `IR_PARAMETER` and `IR_CONSTANT` exempt because they float; and every phi in
        `block.phis` also appears in `block.nodes`.
      - `validatePhis` — `phi.inputs.length === block.predecessors.length`, and no input is
        empty. Establish this as the executable form of the canonical-phi rule from
        [Ch 38 § phis]: inputs are positionally parallel to predecessors, and that is the
        whole contract.
      - `validateControlFlow` / `validateBlockEdges` — no duplicate successors or
        predecessors, edge symmetry in both directions, no nodes after the terminator,
        `IR_BRANCH` successors exactly equal `{trueBlock, falseBlock}`, `IR_JUMP` has one
        successor equal to `targetBlock`, `IR_RETURN` and `IR_DEOPTIMIZE` have none.
      - `validateUseDefDominanceWith` — a use is either later in the same block, or in a
        block the definition dominates; for a phi, the definition must be available at
        the *predecessor* the input arrived from, not at the phi's own block.
      - `validateUseLists` — the multiset check.
- [ ] **`> **New idea.** A multiset**, and the deliberate exemptions.** Establish
      `countUses` and why `add(v, v)` forces counting rather than set membership.
      Then establish the two exemptions written into `validateInputAvailable` and
      `validatePhiInputAvailable`: `IR_PARAMETER` and `IR_CONSTANT` return early, because
      constants and parameters are not owned by a block and dominance is meaningless for
      them. Establish this as a *design decision* with a cost — a constant that has been
      detached from the graph entirely is invisible to the dominance check.
- [ ] **Frame states: the two checks and where they run.** `validateFrameStates` — every
      node for which `irRequiresFrameState` is true has one, its id is assigned, and it
      belongs to the caller-supplied `frameStates` array rather than being foreign.
      `validateFrameStateValueDominanceWith` — every local, stack slot, `this` value and
      caller frame state in the chain is available at the use, with the error re-labelled
      `"B{n} v{id} frame state local 3 …"` so the reader is told *which slot*. Establish
      the exclusion: `sunkAllocationIds` values are skipped, because a sunk allocation
      deliberately has no definition to dominate anything — [Ch 47 § allocation-sinking].
- [ ] **The real gap.** Establish it plainly: `--verify` runs `validateGraphInvariants`,
      which does **not** call `validateFrameStates` or
      `validateFrameStateValueDominanceWith`. Frame-state checking lives only in
      `validateOptimizedGraph`, whose only two callers in `src/` are `optimizer.ts:199`
      and `wasm/codegen.ts:3955` — both on the JIT road. `drivers/aot.ts` calls
      `runMiddleEnd` and never calls it. So per-pass verification of an AOT build checks
      structure and nothing about deopt metadata.
- [ ] **Why the exclusion is legitimate — and what it costs.** Establish the argument for
      it: between passes, frame-state dominance is *expected* to be temporarily false;
      `repairFrameStateDominance` runs after the middle end and fixes it up. Then establish
      the cost, honestly, by reading what "fixes up" means: it substitutes
      `irConstant(undefined)` for any value it cannot prove available. A pass that
      accidentally breaks dominance is therefore not reported — it is silently converted
      into a deopt frame with a missing local. Establish the mitigation on the AOT side
      (`frame-state-elision` under `deoptimizes: false` removes most of them) and name what
      it does not cover.
- [ ] **The machine verifier, and three invariants that look true and are not.** Establish
      `validateMachineFunction(fn, stage, after)` and the six call sites in
      `compileMachineFunction`. Then the three, each as a "why the obvious design fails"
      in miniature, because each was a check that was written, fired on correct code, and
      had to be weakened:
      1. **Operand width does not equal register width.** x64 emits `sete %al` then
         `movzbl %al, %eax` on the *same* virtual register, so a narrower view is legal.
         Only `operand.width > register.width` is a defect.
      2. **Address registers widen legally.** `leal` uses a four-byte virtual as an
         eight-byte address base, so the width check iterates `node.operands` directly and
         skips registers reached through a `memory` operand — which is exactly why
         `validateOperands` does *not* use `registerOperandsOf` while
         `validateNoVirtualsRemain` does. Unlike the other two, this one has no test that
         states it positively: [unpinned], and a refactor that switched the loop to
         `registerOperandsOf` would pass the suite.
      3. **Tied operands are compared by name, not identity.** `coalesceRoundTrips`
         clones a `PhysicalRegister` (`{ ...operand.register, name: held }`), so after
         coalescing a correctly-tied instruction holds two distinct objects with the same
         name — hence `physicalNameOf`. Establish the general rule that falls out:
         physical-register *identity* comparison is unreliable anywhere after coalescing.
- [ ] **The staged checks.** Establish why `validateReachingDefs` and
      `validateNoVirtualsRemain` are an `if`/`else` on `stage`, not both: before allocation
      every register is virtual and liveness at the entry block must be empty; after
      allocation there are no virtuals left to solve over. Then name the consequence: after
      register allocation, *nothing* re-proves that a physical register is defined before
      it is read.
- [ ] **A different kind of verifier: a table checked for completeness.** Establish
      `registerEffectsOf` as a lookup table over 90 `ROP_*` opcodes, and the test that
      enumerates every `ROP_`-prefixed export and asserts none of them maps to `null`.
      Establish what this buys — a new opcode that nobody taught to report its reads and
      writes fails the suite immediately, and the baseline compiler, the IR builder and
      the liveness analysis all read that one table — and state precisely what it is: a
      test, not a type. Nothing in the type system forces a new `ROP_` constant to acquire
      an entry.
- [ ] **The layer with no verifier.** Close on the argument the book has been building
      since [Ch 19]. Bytecode is the one representation with no checker of any kind — and
      it is the layer that carried the book's longest-lived bug, a labeled `continue`
      whose jump offset was never backpatched — caught by a person running the file, not
      by the compiler. Establish what a bytecode verifier would check, one item per
      existing analogue: every jump and handler target inside the instruction range (which
      would have caught `labeled.tera` before it ran once), every register read after some write
      on every path (`validateReachingDefs`, already written and generic over
      `solveMonotone`), every `ROP_TRY_START` matched by a `ROP_TRY_END`, every
      instruction's operand count matching its declared shape, and no instruction after an
      unconditional terminator. Establish the cost of building it and hand the reader to
      [Ch 79]: until it exists, the only thing standing under the bytecode is running the
      program four ways and comparing.

## Honesty items

> **Unenforced.** `validateGraphInvariants` — the function behind `compile --verify` —
> does not check frame states at all. `validateFrameStates` and
> `validateFrameStateValueDominanceWith` are reachable only through
> `validateOptimizedGraph` (`graph-validator.ts:120`), whose callers in `src/` are exactly
> `src/optimizing/optimizer.ts:199` and `src/optimizing/backends/wasm/codegen.ts:3955`.
> `src/optimizing/drivers/aot.ts` calls neither, so no AOT build ever runs the
> frame-state checks, with `--verify` or without it.

> **Unfinished.** `repairFrameStateDominance` (`src/optimizing/passes/osr.ts:276`) repairs
> a broken frame-state value by replacing it with `ir.irConstant(undefined)`. The graph
> validates afterwards because the value is now a constant, which
> `validateInputAvailable` exempts from dominance. The information is gone, not restored;
> the counter it returns is the number of values discarded and nothing reads it.

> **Unenforced.** After register allocation nothing checks that a physical register is
> defined before it is read. `validateMachineFunction` runs `validateReachingDefs` only in
> the `pre-allocation` stage (`verifier.ts:202`, an `else` branch), and it is written over
> `VirtualRegister` — `upwardExposedUses` and `definedVirtuals` both skip anything for
> which `isVirtual` is false. Making it work post-allocation means keying the solve on
> `physicalNameOf` instead.

> **Unenforced.** There is no verifier for register bytecode. `src/bytecode/` contains no
> file matching `validate` or `verif`, and nothing checks that every jump emitted by
> `RegisterCompiledFunction.patchJump` was actually patched — which is the mechanism of
> the labeled-`continue` bug in [Ch 19 § labeled-continue] and
> [Ch 82 § the-inventory].

> **Unenforced.** The completeness of `registerEffectsOf` is guaranteed by a test that
> reflects over module exports (`declaredOpcodes` is defined *inside*
> `tests/bytecode/register/ops/register-effects.test.ts:18`, not in `src/`), not by the
> type system. A `ROP_` constant added without an effects entry compiles.

> **Unenforced.** `verifyEachPass` is off in every default configuration
> (`compilerOptions()` sets it `false`) and the flag that turns it on, `--verify`, exists
> only on the `compile` command. The JIT can be verified per pass only by constructing
> `CompilerOptions` in code, as `tests/e2e/optimizing/aot/feature-matrix.test.ts:91` does.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe --verify
grep -rn "validateOptimizedGraph\|validateGraphInvariants\|validateRepresentations" src/ --include=*.ts
grep -rln "validate\|verif" src/bytecode/ --include=*.ts ; grep -c "export const ROP_" src/bytecode/register/ops/bytecode.ts
npx vitest run --project unit tests/optimizing/validation/graph-validator.test.ts tests/optimizing/machine/verifier.test.ts tests/bytecode/register/ops/register-effects.test.ts
npx vitest run --project e2e tests/e2e/optimizing/aot/feature-matrix.test.ts -t "template interpolation"
```

The first command prints `tera compile: wrote …` — `stats.tera` is clean under per-pass
verification. The second shows the caller set: two callers of `validateOptimizedGraph` in
`src/`, one call of `validateGraphInvariants` (in `pipeline.ts`), one of
`validateRepresentations` (in `legalization.ts`). The third prints **nothing** for the
bytecode layer, then `90`.

## Tests that pin this

- `tests/optimizing/validation/graph-validator.test.ts`
  - `"throws when two nodes in a block claim the same id"` and
    `"passes when the same node is listed once per block"` — node identity, both
    directions.
  - `"throws when node.block is wrong"` — ownership.
  - `"accepts a phi whose input count matches the predecessor count"`,
    `"throws when a phi has fewer inputs than the block has predecessors"`,
    `"throws when a phi has more inputs than the block has predecessors"` — phi arity.
  - `"throws for successor/predecessor mismatch"` — edge symmetry.
  - `"throws when nodes appear after terminator"` and
    `"throws when branch targets missing block"` — terminator position and targets.
  - `"throws when use-def dominance is violated"`.
  - `"throws when deopt-capable node lacks frame state"` and
    `"passes when deopt-capable node has frame state"` — `irRequiresFrameState`.
  - `"throws when a node carries an opcode the property table does not describe"`.
  - `"passes when every return matches the declared representation"`,
    `"rejects a return whose abi representation differs from the declared one"`,
    `"rejects a value-producing node the legalizer never stamped"`,
    `"rejects a graph that never declared a return representation"` —
    `validateRepresentations`, all four.
  - `"carries errors array"` — `GraphValidationError`.
- `tests/optimizing/backends/wasm/rejection.test.ts` — the use-list multiset, stated as
  three separate failures:
  - `"accepts a graph whose use lists agree with its inputs"`.
  - `"rejects a use list that dropped a real use"` (`/missing use/`).
  - `"rejects a use list that counts the same use twice"` (`/mismatched use count/`).
  - `"rejects a use recorded for a node that never consumed the value"` (`/stale use/`).
- `tests/optimizing/machine/verifier.test.ts`
  - `"accepts a virtual that is defined before it is read"` and
    `"rejects a virtual read on a path that never defines it"`.
  - `"accepts a definition that reaches the use through a predecessor"` and
    `"rejects a definition that reaches only one of two incoming paths"` — the backward
    solve, both answers.
  - `"rejects a virtual read wider than it was created"` and
    `"accepts a sub-register view of a wider virtual"` — invariant #1, both directions.
  - `"rejects a memory operand naming a stack slot from another frame"`.
  - `"rejects a successor edge with no matching predecessor edge"` and
    `"rejects a branch to a block the function does not own"`.
  - `"rejects a virtual that survived allocation"`.
  - `"rejects tied operands that ended up in different registers"`,
    `"accepts tied operands that name the same register through distinct objects"` —
    invariant #3, stated as a test — and
    `"rejects a tied instruction that is not in destructive form"`.
- `tests/bytecode/register/ops/register-effects.test.ts`
  - `"models every opcode the instruction set declares"` — the completeness check.
  - `"reports no effects for an opcode outside the instruction set"` and
    `"answers no control effect for an opcode outside the instruction set"`.
  - `"never reads or writes the operand that carries a control target"`.
  - `"opens a handler at a try and closes it at its end"` and
    `"keeps the handler of a try apart from the target of a jump"`.
- `tests/optimizing/passes/simplify.test.ts` — the regression tests the worked example
  produced:
  - `"drops the replaced multiply from the use lists of its inputs"`.
  - `"drops the replaced multiply when it decomposes into a shift and an add"`.
  - `"drops a subtraction of a value from itself from that value's use list"`.
- `tests/optimizing/infra/pass-manager.test.ts`
  - `"verifies a graph only after a pass that changed it"`.
  - `"traces the graph that broke an invariant before it throws"`.
- `tests/e2e/optimizing/aot/feature-matrix.test.ts` — 58 features run under
  `verifyEachPass: true` on two backends, e.g.
  `"compiles template interpolation for the x64-windows backend"` and
  `"compiles generators for the c backend"`.
