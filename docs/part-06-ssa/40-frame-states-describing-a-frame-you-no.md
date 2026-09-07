# 40. Frame states: describing a frame you no longer have   ⟨I · · J · N⟩

> **Status:** outline

**Thesis.** Every deoptimizing node carries a snapshot of the interpreter frame expressed
as IR nodes, which means the graph has a second, invisible use graph — and
`uses.length === 0` is not death.

**What arrived.** The `CFGFunction` chapter 39 built: guards placed from feedback,
dependencies registered, and — attached to every node that can give up — a `FrameState`
the walk captured as it went.

**What leaves.** For the JIT, the same graph with its frame states intact, indexed for
O(1) liveness queries, and a validator that refuses any deoptimizing node that lost one.
For the native compiler, the same graph with **every** frame state set to `null`, because
its target model has no `deopt` capability. Part VII optimizes whichever of the two it
was handed.

**New ideas.** deoptimization as a contract, not a mechanism (the mechanism is
chapter 54); a snapshot expressed in the *new* representation naming values of the *old*
one; a second use graph; why a liveness predicate that consults only one of the two
graphs is a use-after-free.

**Length.** 16 pages

## Anchors

- `src/deopt/frame-state.ts` — `FrameState` (`compiledFunction`, `bytecodeOffset`,
  `localValues`, `stackValues`, `thisValue`, `id`, `callerFrameState`, `isInlinedFrame`,
  `safepoint`, `sunkAllocations`), `FrameValue`, `VirtualAllocation`,
  `setCallerFrame`, `getInlineChain`, `getInlineDepth`, `matches`, `toCompact`,
  `formatIRValue`, `FrameStateBuilder`. 291 lines.
- `src/optimizing/builder/frame-state.ts` — `captureFrameState`,
  `captureFrameStateWithCaller`: 57 lines, and the single line that matters
  (`if (liveness && !liveness.isLive(bytecodeOffset, slot)) continue;`).
- `src/optimizing/builder/register-liveness.ts` — `registerLiveness` and its
  `WeakMap` cache keyed by `RegisterCompiledFunction`, the bitset backward dataflow,
  the `closureCapturedSlots` seed that keeps captured registers live regardless, and the
  two conservative `return true` answers in `isLive`.
- `src/optimizing/ir/frame-state-values.ts` — `visitFrameStateValues`,
  `visitGraphFrameStateValues`, `visitDeoptSnapshotValues`, `replaceGraphFrameStateValue`,
  `buildFrameStateIndex`, `clearFrameStateIndex`, `frameStateReferences`,
  `markFrameStateValues`, `frameStateValueIds`, `maxDeoptSnapshotSlots`,
  `sunkAllocationIds`. 212 lines — the whole second use graph.
- `src/optimizing/ir/editor.ts` — `GraphEditor.removeIfDead`, `removeDeadChain`,
  `remove`. 65 lines; the two liveness predicates the rest of the book must use.
- `src/optimizing/ir/index.ts` — `irRequiresFrameState` (delegates to `canDeoptimize`),
  `CFGInstruction.frameState`, `CFGFunction._frameStateIndex`.
- `src/optimizing/ir/operations.ts` — `canDeoptimize`, `DEOPT_NEVER` / `DEOPT_ALWAYS` /
  `DEOPT_ON_OVERFLOW`, and the `props.noOverflow` escape.
- `src/optimizing/validation/graph-validator.ts` — `validateFrameStates` (306-332),
  `validateFrameStateValueDominanceWith` (464-484), `validateFrameStateValues` (486-…),
  `validateFrameStateValueAvailable` (551-572), and the split between
  `validateGraphInvariants` (109-118, no frame-state checks) and
  `validateOptimizedGraph` (120-135, all of them).
- `src/optimizing/pipeline.ts` — `maintainGraph` (69-72): `homeFloatingValues` then
  `buildFrameStateIndex`, run *between* passes by the pass manager.
- `src/optimizing/optimizer.ts:185-199` — `buildFrameStateIndex`, `runMiddleEnd`,
  `clearFrameStateIndex`, `repairFrameStateDominance`, `validateOptimizedGraph`.
- `src/optimizing/passes/frame-state-elision.ts` — `elideFrameStates`. Eighteen lines,
  the whole file.
- `src/optimizing/target/legalization.ts:412` — where it runs, and `capabilities.has("deopt")`.
- `src/optimizing/passes/dce.ts:109-138` — `eliminateDeadPhis`, which got the rule right
  from the start via `visitFrameStateValues`.
- `src/optimizing/passes/global-builtin-lowering.ts:169,174,211-225,253-257,274` — the
  worked example: `spelled.frameState = node.frameState` then `editor.removeIfDead(callee)`.
- `src/optimizing/backends/wasm/runtime-support.ts:485,999` — `callBuiltinGlobal`, the
  second bug.
- `tests/optimizing/ir/editor.test.ts` — the liveness-predicate suite.
- `tests/optimizing/ir/frame-state-values.test.ts` — the index and visitor suite.
- `tests/e2e/optimizing/frame-state-liveness.test.ts`,
  `tests/e2e/optimizing/global-builtins.test.ts` — the two regressions.

## Worked example

Not `mean` — a `print`. The chapter's example is the bug that made every function
containing a `print` un-JIT-able, and the second bug hiding behind it.

```bash
# every node that can deoptimize carries one; !fs marks it
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter mean docs/example/stats.tera

# the native compiler deletes all of them, in 19 of stats.tera's 21 graphs
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe --print-after-all \
  | grep -c "frame-state-elision \[changed"
```

The `<script>` graph of `stats.tera` is where the bug lived:
`v27 = LoadGlobal [name="print"]` feeds `v31 = GenericCall v27, v30 [argCount=1] !fs`,
and `print` also sits in a live bytecode register, so the frame states at that offset
name `v27` too. `global-builtin-lowering` rewrites the call into a `CallBuiltin` and
retires the `LoadGlobal`. Ten lowering passes retired it with
`if (callee.uses.length === 0) editor.remove(callee)` — which deleted a node the frame
states still named.

## Outline

- [ ] **§ the-contract** — `> **New idea.**` deoptimization as a *contract*: the JIT is
      allowed to assume the map it saw is the map it will see, on one condition — that it
      can put the interpreter back exactly where it was if the assumption fails.
      Establish the shape of the obligation before any code: the compiled function must
      be able to name, for the resume point, every value the interpreter frame held. The
      *mechanism* — materialization, the deoptimizer, the stub — is chapter 54. This
      chapter is only about carrying the description.
- [ ] **§ what-a-frame-state-holds** — `FrameState` (`frame-state.ts:22-48`):
      `compiledFunction` and `bytecodeOffset` say *where to resume*; `localValues`
      (a sparse `Map<slot, FrameValue>`), `stackValues` and `thisValue` say *with what*;
      `id` indexes it in the per-compilation list; `callerFrameState` and
      `isInlinedFrame` chain it; `safepoint` and `sunkAllocations` belong to later
      chapters ([Ch 45 § allocation-sinking], [Ch 62 § safepoints]). Establish the crucial
      typing: `FrameValue = RuntimeValue | IRNodeLike`, so a slot holds *either* a
      concrete tagged value *or* a pointer to a `CFGInstruction` in the new graph. The
      snapshot is written in the new representation and describes the old one.
- [ ] **§ liveness-at-capture** — `captureFrameStateWithCaller` (`builder/frame-state.ts:24-57`)
      filters every slot through `registerLiveness(compiledFn).isLive(bytecodeOffset, slot)`.
      Walk the analysis: a backward bitset dataflow over the instruction array
      (`out = ∪ succ.live`, `live = (out \ written) ∪ read`), worklist to fixpoint, one
      `Uint32Array` word per 32 slots. Establish the three deliberate escapes — every slot
      a closure captured stays live unconditionally
      (`closureCapturedSlots`, `register-liveness.ts:86-89`); an unmodellable opcode makes
      `analyze` return `null` and the whole filter turns off; an out-of-range offset or
      slot answers `true`. All three fail *toward* a bigger frame, which costs bytes, not
      correctness.
- [ ] **§ who-must-own-one** — `irRequiresFrameState(node)` is `canDeoptimize(node)`, and
      `canDeoptimize` reads the operation table: `DEOPT_ALWAYS`, or `DEOPT_ON_OVERFLOW`
      with `props.noOverflow !== true`. Establish that the *only* declaration of which
      nodes need a frame state is the effects field of chapter 38's table, and that
      `int32-overflow-widening` can retire the obligation by proving no overflow — a
      pass's proof turning into a smaller frame. Invariant → enforcement
      (`validateFrameStates`, three distinct errors: `missing frame state`,
      `has unassigned frame state`, `references foreign frame state`) → test.
- [ ] **§ the-second-use-graph** — The chapter's whole point.
      `CFGInstruction.uses` holds one entry per input **edge** and nothing else. A frame
      state naming that node is invisible there. So the graph has two use relations:
      the value graph, maintained by `addInput` / `replaceInput` / `rebuildUses`; and the
      frame-state graph, reachable only by walking every node's `frameState` chain.
      Establish the consequence that costs the most: `node.uses.length === 0` does not
      mean the node is dead.
- [ ] **§ the-bug-that-taught-it** *(bug as engineering)* — Symptom: `--print-ir` shows a
      correct graph, and the JIT silently falls back to baseline; with validation on,
      `validateOptimizedGraph` reports a frame-state value with no definition. Mechanism:
      `global-builtin-lowering` rewrites `GenericCall(LoadGlobal "print", x)` into
      `CallBuiltin`, re-homes the frame state onto the replacement, then retires the
      `LoadGlobal` — but `print` occupies a live bytecode register, so every frame state
      at that offset names it. Not top-level-specific: any function calling a global
      builtin hit it; a module top level just made it obvious, because every top level
      ends in a call whose arguments are still live. Scope: ten lowering passes shared the
      copy-pasted `if (x.uses.length === 0) editor.remove(x)`. Fix: one predicate,
      `GraphEditor.removeIfDead`. Regression test. General rule: never decide a node is
      dead from `uses.length` alone.
- [ ] **§ the-second-bug-behind-the-first** — Unblocking the JIT for `print`-containing
      functions exposed that the wasm runtime stub for `IR_CALL_BUILTIN` handled method
      and namespace intrinsics and did `return mkUndefined()` for everything else — so
      the seven *global* builtins (`print`, `input`, `parse_int`, `parse_float`, …) were
      no-ops in JIT code. `print` printed nothing; `parse_float` answered `undefined`.
      Fixed by `callBuiltinGlobal` (`backends/wasm/runtime-support.ts:485`), which reads
      the global cell and calls it the way `callBuiltinNamespace` already did. Establish
      the general rule this produced: a bug that *blocks* a code path hides every bug
      *on* that path, so the differential test for the newly-unblocked path is part of
      the fix, not a follow-up. That test is `global-builtins.test.ts`, which runs the
      same program at two tiering policies and asserts the printed lines are equal.
- [ ] **§ the-index-and-what-it-costs** — `frameStateReferences(graph, value)`
      (`frame-state-values.ts:191-198`) answers from `graph._frameStateIndex`, a
      `Map<FrameValue, {replace}[]>` built lazily by `buildFrameStateIndex` and rebuilt by
      the pass manager's `maintain` hook (`maintainGraph`, `pipeline.ts:69-72`). O(1)
      instead of an O(n) rescan per removal. The same index doubles as the fast path in
      `replaceGraphFrameStateValue`, which rewrites every recorded location and migrates
      the entries to the new key. Establish: the index is a cache over a relation the
      graph already holds, and `clearFrameStateIndex` is how a caller says "I no longer
      trust it".
- [ ] **§ stale-within-one-pass** — The index is rebuilt *between* passes. Inside one
      pass it goes stale the moment the pass removes a node that carried a frame state:
      that node's entries stay in the map, so `removeIfDead` over-*refuses*. Establish
      why over-refusal is harmless in JIT lowering (it leaves one dead `LoadGlobal` for
      DCE) and fatal in `promise-surface`, where refusing to retire the `.then` /
      `Promise.resolve` receiver chain leaves the original generic calls in the graph and
      the backend refuses the whole entry with
      `the promise tera_promise$resolve$0 returns is used as a plain value here`.
      Measured on `tests/e2e/optimizing/aot/promise-surface.test.ts`: a naive conversion
      refused ~40 removals and failed 8 of 16 tests; with a fresh index only 25 are
      refused and every one is genuine, cross-checked against a ground-truth scan of
      `block.nodes[].frameState`.
- [ ] **§ where-the-invalidation-lives-and-why-not-elsewhere** — `removeDeadChain`
      (`editor.ts:38-54`) clears the index on entry and again after removing any node that
      *carried* a frame state, so each step of the cascade queries ground truth. Cost: one
      rebuild per orphaning removal — acceptable there because the pass already calls
      `rebuildUses()` per rewrite site. Establish the deliberate refusal: that
      invalidation is **not** in `remove` or `removeIfDead`, because JIT lowering passes
      remove frame-state-carrying nodes at every site and it would make them O(n²). The
      policy lives in the cascade, not the primitive, and that is a decision, not an
      oversight.
- [ ] **§ what-was-tried-and-rejected** *(What was tried and rejected)* — Tagging each
      index entry with its owning node and treating a removed owner as dead. It is
      unsound: lowering passes re-home frame states —
      `replacement.frameState = node.frameState` in `global-builtin-lowering`,
      `array-methods`, `array-shapes`, `class-member-lowering`, `string-split`, … —
      *before* removing the original, so the owner test would delete nodes a live re-homed
      frame state still names. Exactly the bug § the-bug-that-taught-it fixed. Only a
      rebuild sees the re-homing. Establish the general rule: an index over a relation
      that other code rewrites in place cannot be invalidated by identity.
- [ ] **§ caller-chains** — When the builder inlines (chapter 39 § inlining-happens-during-construction),
      `captureFrameStateWithCaller` gives the callee's frame states the caller's frame as
      `callerFrameState` and sets `isInlinedFrame`. Establish what the chain is *for*:
      one deoptimization must rebuild N interpreter frames, and `getInlineChain` /
      `getInlineDepth` are how chapter 54 walks them. Note that every visitor in
      `frame-state-values.ts` recurses through `callerFrameState` and every one carries a
      `seen` set, because a cycle there would hang the compiler —
      `visitFrameStateValues` is pinned on exactly that.
- [ ] **§ eighteen-lines-that-say-what-a-frame-state-is-for** —
      `src/optimizing/passes/frame-state-elision.ts`, the whole file:

      ```
      if (target.capabilities.has("deopt")) return 0;
      … for every node in every block: node.frameState = null;
      ```

      Establish the argument: a frame state exists so a speculating compiler can undo a
      speculation. A target that cannot deoptimize never undoes anything, so the
      description is pure weight. Show the measurement — 19 of `stats.tera`'s 21 graphs
      report `frame-state-elision [changed]`, 2 report `[unchanged]` — and the tier
      consequence: from here to the end of Part X, the native pipeline is running the same
      passes over a graph with no second use graph at all, so `uses.length === 0` *is*
      death on that path and nowhere else.
- [ ] **§ what-checks-this-and-what-does-not** — `validateOptimizedGraph` runs
      `validateFrameStates` *and* `validateFrameStateValueDominanceWith`, which reports
      `B<n> v<id> frame state local <k> … uses v<m> with no definition`.
      `validateGraphInvariants` — the one `tera compile --verify` and `verifyEachPass`
      call — runs neither. And `validateOptimizedGraph` is called only from
      `optimizer.ts:199` and `backends/wasm/codegen.ts:3955`. Establish the gap plainly:
      frame states *do* reach the module-level AOT passes (`promise-surface` runs in
      `drivers/aot.ts` long before `frame-state-elision`, and `compileStatic` builds IR
      through the same `buildIR`), and nothing on that path ever checks them. Carries an
      honesty marker. Also name the second trap: backend legalization runs *after* the
      optimizer's own `validateOptimizedGraph`, so a legalization pass that corrupts the
      graph surfaces as `Wasm: graph validation failed` — read that as "a legalization
      pass did it", not the builder.
- [ ] **§ what-leaves** — Two graphs, one shape. Restate the rule Part VII inherits:
      `GraphEditor.removeIfDead` is the only correct liveness predicate on the JIT path;
      `removeDeadChain` is the only correct cascade; and on the native path both are
      trivially equivalent to `uses.length === 0` because there is nothing else left to
      consult.

## Honesty items

- > **Unenforced.** Frame-state value availability is checked only by
  `validateOptimizedGraph` (`src/optimizing/validation/graph-validator.ts:120-135`), which
  is called from `src/optimizing/optimizer.ts:199` and
  `src/optimizing/backends/wasm/codegen.ts:3955` — both JIT. `--verify` /
  `CompilerOptions.verifyEachPass` runs `validateGraphInvariants`
  (`graph-validator.ts:109-118`), which does not look at frame states at all. Frame states
  survive into the module-level AOT passes, so an AOT pass can orphan a frame-state value
  and nothing reports it; the damage is invisible because `elideFrameStates` later deletes
  the evidence. Closing it costs adding the frame-state checks to
  `verifyAfterPass` (`pipeline.ts:290-298`) and threading the frame-state list to it.
- > **Unenforced.** `graph._frameStateIndex` has no staleness marker, generation counter
  or assertion. `frameStateReferences` cannot tell a fresh index from one four removals
  out of date; it answers from whatever is there. The only defence is the discipline in
  `removeDeadChain` and the `maintain` hook, and the only way to know a pass got it wrong
  is a downstream refusal.
- > **Never runs.** `FrameStateBuilder` in `src/deopt/frame-state.ts:228-291` — a
  `capture` / `getState` / `count` / `dump` façade over `FrameState`, with nine tests. Zero
  call sites in `src/`: the builder path uses the free functions in
  `src/optimizing/builder/frame-state.ts` and pushes into a plain array, and
  `src/optimizing/optimizer.ts` owns that array as `this.frameStates`. Deleting it costs
  64 lines of source and one `describe` block.
- > **Never runs.** `FrameState.matches` in `src/deopt/frame-state.ts:153-167` — nine
  tests, zero call sites in `src/` (every `.matches(` in the tree belongs to
  `src/feedback/ic/index.ts`). It is also incomplete if anyone did call it: it compares
  `compiledFunction`, `bytecodeOffset`, locals and stack, but not `thisValue`,
  `callerFrameState` or `sunkAllocations`, so two frames differing only in `this` or in
  the inline chain compare equal.
- > **Unenforced.** `CFGFunction._frameStateIndex` is declared twice, in two shapes:
  `Map<FrameValue, { replace(next: FrameValue): void }[]> | null` on
  `src/optimizing/ir/index.ts:280`, and `Map<FrameValue, FrameStateIndexLocation[]>` on
  `src/optimizing/ir/frame-state-values.ts:24`. They happen to be structurally
  compatible, so nothing catches a future divergence. The field is also an underscore-
  prefixed public property, so any code anywhere may write it.

## Verify it yourself

```bash
# the JIT keeps them: !fs on every guard, call and allocation
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter mean docs/example/stats.tera

# the native compiler deletes them: 19 graphs changed, 2 had none
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe --print-after-all \
  | grep -c "frame-state-elision \[changed"

# and the binary that comes out still agrees with the interpreter
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe --verify && /tmp/stats.exe

# the two liveness predicates and the cascade's invalidation policy
npx vitest run --project unit tests/optimizing/ir/editor.test.ts \
  tests/optimizing/ir/frame-state-values.test.ts

# the two regressions: the liveness filter, and the global builtins it unblocked
npx vitest run --project e2e tests/e2e/optimizing/frame-state-liveness.test.ts \
  tests/e2e/optimizing/global-builtins.test.ts

# a frame state actually used, end to end
node dist/cli.js --trace docs/example/stats-deopt.tera | grep DEOPT
```

## Tests that pin this

- `tests/optimizing/ir/editor.test.ts` > "removes an unused node that no frame state names"
- `tests/optimizing/ir/editor.test.ts` > "keeps an unused node a frame state still names"
- `tests/optimizing/ir/editor.test.ts` > "removes a chain of inputs stranded by the root"
- `tests/optimizing/ir/editor.test.ts` > "stops the chain at an input another node still uses"
- `tests/optimizing/ir/editor.test.ts` > "stops the chain at a node a live frame state names"
- `tests/optimizing/ir/editor.test.ts` > "frees inputs named only by a frame state the chain itself removed"
- `tests/optimizing/ir/editor.test.ts` > "leaves unhomed inputs such as parameters in place"
- `tests/optimizing/ir/frame-state-values.test.ts` > "visits locals, stack, and thisValue with replacement callbacks"
- `tests/optimizing/ir/frame-state-values.test.ts` > "recursively visits callerFrameState"
- `tests/optimizing/ir/frame-state-values.test.ts` > "does not infinite-loop on circular callerFrameState"
- `tests/optimizing/ir/frame-state-values.test.ts` > "uses indexed fast path when _frameStateIndex is built"
- `tests/optimizing/ir/frame-state-values.test.ts` > "builds index mapping node → replacement locations, clearFrameStateIndex nulls it"
- `tests/optimizing/ir/frame-state-values.test.ts` > "adds frame state values to liveNodes set and worklist"
- `tests/optimizing/builder/frame-state.test.ts` > "carries a register the resume point still reads"
- `tests/optimizing/builder/frame-state.test.ts` > "leaves out a register nothing reads before it is overwritten"
- `tests/optimizing/builder/frame-state.test.ts` > "decides per offset, so one register is dropped at one point and kept at another"
- `tests/optimizing/builder/frame-state.test.ts` > "keeps a register a closure captured, however dead the bytecode reads"
- `tests/optimizing/builder/frame-state.test.ts` > "keeps every register when the bytecode holds an opcode liveness cannot model"
- `tests/optimizing/builder/frame-state.test.ts` > "marks a frame given a caller as an inlined one"
- `tests/optimizing/validation/graph-validator.test.ts` > "throws when deopt-capable node lacks frame state"
- `tests/optimizing/validation/graph-validator.test.ts` > "passes when deopt-capable node has frame state"
- `tests/optimizing/ir/call-builtin.test.ts` > "still requires a frame state so deoptimization can rebuild the frame"
- `tests/optimizing/ir/operations.test.ts` > "stops requiring a frame state once overflow is proven impossible"
- `tests/e2e/optimizing/frame-state-liveness.test.ts` > "still reads a loop local that a closure captured"
- `tests/e2e/optimizing/frame-state-liveness.test.ts` > "still deoptimizes correctly after the loop temporaries were pruned"
- `tests/e2e/optimizing/frame-state-liveness.test.ts` > "still reads a local only the next iteration goes back for"
- `tests/e2e/optimizing/frame-state-liveness.test.ts` > "still resumes with the current value of a reassigned parameter"
- `tests/e2e/optimizing/global-builtins.test.ts` > "prints every line the interpreter prints"
- `tests/e2e/optimizing/global-builtins.test.ts` > "answers what the builtin answers in the interpreter"
- `elideFrameStates` itself: [unpinned] — no unit test; observed through
  `--print-after-all` and the native e2e suites only.
