# 50. Inlining and tail calls   ⟨J · N⟩

> **Status:** outline

**Thesis.** A cost model with bonuses for constant arguments that decide branches, a splice
that must rebuild the frame-state chain, and the one place a self-recursive call becomes a
loop.

**What arrived.** From [Ch 49](49-speculative-types-are-not-facts.md): the graph after
`type-narrowing`, and the cached `TypeInference` with its `speculative` set — plus the rule
that a type from a guard is only true where the guard survives. Inlining is the first thing
downstream that moves guarded values into a function where the guard's dominance was
established somewhere else.

**What leaves.** One optimized `CFGFunction` in canonical-phi SSA from Part VII: typed by
`typeInferenceAnalysisId`, with `frameState` edges on every node that can bail out, and no
idea which of four code generators is about to read it.

**New ideas.** *Cost model* and *budget* as two different limits (per-callee vs per-caller);
*splicing* a graph into another graph, and the SSA repair it needs; a *nested* frame state —
one deopt snapshot naming another; *bottom-up call order*; *tail position*, and why a
self-recursive tail call is a loop.

**Length.** 12 pages

## Anchors

### The AOT (module-level) inliner

- `src/optimizing/passes/inlining.ts` — 377 lines, the whole chapter's spine.
  `OPAQUE_TO_INLINING` (50-58, seven opcodes); the cost constants (62-68);
  `COSTED` (70-82); `nodeCost` (96-98); `calleeBody` (100-118); `decidesABranch` (120-124);
  `foldingBonus` (126-135); `inlineCostOf` (137-141); `callSiteOf` (143-155);
  `inlinable` (157-176); `mergesANumber` (178-181); `answersInt32` (183-194);
  `needsDeclaredIntWrap` (196-199); `wrapInInt32` (201-212);
  `substituteParameters` (214-230); `adoptFrameState` (232-234);
  `spliceStraightLine` (236-262); `spliceRegion` (264-303); `inlineKnownCalls` (305-377).
- `src/optimizing/passes/tail-calls.ts` — 85 lines. `TailSite` (15-20); `tailSiteOf` (22-38);
  `rewritable` (40-46); `rewriteSelfTailCalls` (48-85). Note the import at line 13: it reuses
  `callSiteOf` from the inliner, so "is this a call to a known function" has one definition.
- `src/optimizing/metadata/call-graph.ts:87-113` — `bottomUpCallOrder`: a DFS postorder over
  the call graph that skips a `"visiting"` callee, i.e. it tolerates recursion by ignoring the
  back edge rather than by detecting cycles.
- `src/optimizing/drivers/aot.ts` — `inlineModuleCalls` (643-658) and `inlineLoweredCalls`
  (627-641), the two places `inlineKnownCalls` is called; the `stage` helper (676-687) which
  is also the only thing that opens a remark scope; `stage("module-inlining", …)` (797) and
  the bare `inlineLoweredCalls(...)` call (823).
- `src/optimizing/options.ts:21-22, 58-59, 72-73, 86-87, 100-101` — `inlineThreshold`
  (0 / 8 / 24 / 64 by level) and `inlineBudget` (0 / 64 / 512 / 2048). Level 0 switches
  inlining off entirely, which `inlineKnownCalls` reports as a remark before returning.
- `src/optimizing/infra/pass-remarks.ts` — `RemarkRecorder.record` (63-73) and the line that
  decides whether the inliner's six carefully-worded explanations are kept:
  `if (scope === null) return;`.

### The JIT (builder-level) inliner

- `src/optimizing/builder/inline.ts` — `selectInlineTarget` (211-253), `canInlineTarget`
  (185-207) reading `graph.inlining` (`maxDepth`, `maxCalleeSize`, `minCallFrequency`) and
  `graph.inlineBudgetRemaining`; `recordInlineDecision` (257-264); `tryInline` (266-275)
  incrementing/decrementing `graph.inlineDepth` in a `finally`; `inlineCallee` (278-…);
  `buildPolymorphicDispatch` (90-…); the four `captureFrameStateWithCaller` call sites at
  350, 363, 841, 918.
- `src/optimizing/builder/frame-state.ts` — 57 lines. `captureFrameState` (7-22) is a
  wrapper passing `null`; `captureFrameStateWithCaller` (24-56) is the real one, and the only
  difference is `if (callerFrameState) fs.setCallerFrame(callerFrameState);` (48-50).
  Also `registerLiveness(compiledFn)` filtering dead slots out of the snapshot.
- `src/optimizing/baseline/compiler.ts:282-285` — `isTailCall`, the tree's **only** tail call:
  the baseline compiler emits `return f(...)` in the JavaScript it generates.

## Worked example

`stats.tera` **cannot reach this chapter.** Both of its cross-function calls are excluded by
construction: `report(s)` calls `s.label()`, and `callSiteOf` returns `null` for any
`IR_GENERIC_CALL` with `props.isMethod === true` (inlining.ts:152); `Series.label` declares
`returns: string`, which `inlinable` refuses outright (169). Measured: compiling
`docs/example/stats.tera` produces exactly **21** `#-1 ir-builder` trace records for **21**
functions — one apiece, so nothing was re-optimized, so nothing was inlined.

So the chapter uses the smallest program that does reach it:

```
fn scale(x: float, k: float) -> float:
  return x * k

fn total(values: float[]) -> float:
  t = 0.0
  i = 0
  while i < values.length:
    t += scale(values[i], 2.0)
    i += 1
  return t

print(total([12.5, 9.0, 31.25]))
```

```
$ node dist/cli.js compile inl.tera --emit source --target c --print-after-all -o out \
    | grep -A1 '^\*\*\* IR after #-1 ir-builder' | grep '^fn ' | sort | uniq -c
      1 fn scale params=2 {
      2 fn tera_program params=0 {
      2 fn total params=1 {
```

**Two `ir-builder` records for `total`, and two for `tera_program`.** That is the chapter's
sharpest observable: `inlineModuleCalls` calls `runMiddleEnd(graph, …)` again on every caller
it changed (`aot.ts:657`), so the thirty-three-pass pipeline runs twice on those graphs and
**pass ordinal 8 is not a unique point in a compile**. The emitted C confirms the splice:
`double total(unsigned char *p0)` contains the multiply inline and no call, while
`double scale(double p0, double p1)` is still emitted beside it.

The cost arithmetic — `inlined scale here: 4 nodes at cost -6, leaving 60 of the budget` and
its five sibling refusal messages — is written by `remarks.applied` / `remarks.missed` and
**cannot be seen from the CLI**. See Honesty items.

## Outline

- [ ] **`> **New idea.**` Two limits, not one.** Establish the difference the tree encodes in
      two options. `inlineThreshold` is a *per-decision* score: is this callee worth its code
      *here*? `inlineBudget` is a *per-caller* allowance in nodes, spent down as
      `remaining -= body.size` and never refilled. Establish that a callee can pass the
      threshold and still be refused because the budget ran out, and that the order of blocks
      and nodes therefore decides which call sites win — the loop is a single linear scan
      (`inlineKnownCalls`, 322-373), not a priority queue.
- [ ] **The cost model, arithmetic first.** Establish `nodeCost` as a table lookup with a
      default of `STEP_COST = 1`, and quote the table: `Constant`, `Phi`, `Jump` and `Return`
      are `FREE`; the three call opcodes cost `CALL_COST = 8`; integer and float division,
      modulo and `pow` cost `ROUTINE_COST = 16` because they lower to a routine, not an
      instruction. Then quote the whole decision:

      ```ts
      export function inlineCostOf(site: CallSite, body: CalleeBody): number {
        return (
          body.cost - CALL_COST - site.args.length * ARGUMENT_COST - foldingBonus(site)
        );
      }
      ```
      — src/optimizing/passes/inlining.ts:137-141

      Establish the reading: *cost is what the body costs minus what the call would have
      cost*, so a callee smaller than a call has a **negative** score and is inlined at every
      level whose threshold is `>= 0`. Establish that `ARGUMENT_COST = 1` credits the argument
      setup the call no longer needs.
- [ ] **The two bonuses, and why the second is three times the first.** Establish
      `foldingBonus`: every constant argument earns `CONSTANT_ARGUMENT_BONUS = 4`, and a
      constant argument whose *parameter* `decidesABranch` earns a further
      `FOLDED_BRANCH_BONUS = 12`. Establish `decidesABranch` as a two-level use walk — the
      parameter feeds a `Branch`, or feeds something that feeds a `Branch` — and therefore
      that it is a *syntactic* approximation of "SCCP will delete a whole arm of this callee
      once the argument is a constant" ([Ch 43 § reachability]). Establish the design claim
      the numbers make: a constant that removes control flow is worth three constants that
      merely remove an argument.
- [ ] **`OPAQUE_TO_INLINING` read as a catalogue of what splicing breaks.** Seven opcodes,
      each for a different reason, and the chapter should give the reason rather than the list:
      `LoadContextSlot`/`StoreContextSlot` because a context is indexed relative to *its*
      function ([Ch 20 § closure-conversion]); `Deoptimize` because it names a bytecode offset
      in a frame that would no longer exist; `Await`/`Yield` because a suspended frame belongs
      to one coroutine ([Ch 58 § coroutine-lowering]); `LoadText`/`StoreText` because a
      produced string's characters are owned by the frame that made them
      ([Ch 59 § string-buffer-lifetimes]). Establish that `calleeBody` returns `null` on the
      first one it meets, and that the same function also refuses a callee whose entry block
      has predecessors or phis, or that has a block without a terminator, or that returns
      nothing anywhere.
- [ ] **`inlinable`: nine refusals, read as a specification.** Establish them in the order the
      code asks: named arguments; self-recursion (`callee === caller` — the *other* pass
      handles that); `isAsync`, `isGenerator`, `recoversThrows`, `resumable`;
      `gatheredArguments` (an `arguments`-style capture); a declared `string` return; **any**
      parameter whose declared type accepts null; arity mismatch. Then the return-shape rule:
      if the call's value is unused, anything goes; otherwise every return must return a value,
      and there must be exactly one return **or** the callee's declared return must be a
      numeric AOT scalar (`mergesANumber`). Establish why that last clause exists — the merge
      phi in `spliceRegion` has to have one representation, and a numeric scalar is the case
      where it does ([Ch 48 § the-return-join]). Pin with
      `"leaves a call that passes the wrong number of arguments alone"`,
      `"leaves a call whose arguments are named alone"`,
      `"leaves a callee that answers a string alone"`,
      `"leaves a callee that calls itself alone"`,
      `"refuses a callee whose entry a back edge re-enters"`.
- [ ] **Splice one: a single-block callee.** Establish `spliceStraightLine`: `cloneGraph` the
      callee under the name `<caller>$inline`, `substituteParameters` (a map from the clone's
      `Parameter` nodes to the call's argument nodes, applied with `replaceInput`), then walk
      every node except the terminator, `stamp` it with a fresh id from the *caller's*
      allocator ([Ch 39 § node-id-stamping]), `adoptFrameState` it, and `insertBefore` the
      call. Finally `replaceAllUses(call, answered)` and delete the call. Establish that no
      block is created and no phi is needed. Pin with
      `"splices a straight-line callee into its caller"` and
      `"keeps the caller answering the value the callee returned"`.
- [ ] **Splice two: a callee with control flow, and the SSA repair.** Establish the five steps
      of `spliceRegion` in order: `splitBlockBefore` cuts the caller's block at the call,
      producing a `continuation`; `cloneBlocks` copies every callee block into the caller;
      parameters are substituted across all of them; the block that held the call gets a
      `Jump` into the clone of the callee's entry; and then each cloned `Return` is
      **rewritten in place** into a `Jump` to the continuation —
      `detachInputs(terminator); terminator.type = IR_JUMP; terminator.props = { targetBlock: continuation.id }`
      — with its former operand collected. One answer means use it directly; several mean
      `addPhi(continuation, answers)`. Establish that this is exactly the SSA merge rule from
      [Ch 38 § phi], applied to a merge point the source never wrote. Pin with
      `"splices a callee that branches, and merges its answers into one phi"`,
      `"leaves the caller reading the phi wherever it read the call"`,
      `"keeps the code that followed the call after the spliced body"`.
- [ ] **`adoptFrameState`, and the one-line version of a hard problem.** Quote it:

      ```ts
      function adoptFrameState(node: CFGInstruction, call: CFGInstruction): void {
        node.frameState = irRequiresFrameState(node) ? call.frameState : null;
      }
      ```
      — src/optimizing/passes/inlining.ts:232-234

      Establish what it is doing: a spliced node that can bail out must name a frame, and the
      only frame that still exists is the **caller's**, at the call. Establish that this is
      legitimate *for AOT only* — `staticCompilerOptions` sets `deoptimizes: false`, frame
      states are stripped later, and the graft only has to keep the graph well-formed until
      then. Then contrast with the JIT, next section. **This is the chapter's hinge paragraph.**
- [ ] **`> **New idea.**` A nested frame state.** Establish the JIT's problem: when the
      builder inlines a callee, a bailout *inside* the inlined body must reconstruct **two**
      interpreter frames — the callee's, and the caller's underneath it — because the
      interpreter is about to resume in a world where the call really happened. Establish the
      mechanism as the one extra parameter that separates `captureFrameState` from
      `captureFrameStateWithCaller`, and the single line `fs.setCallerFrame(callerFrameState)`.
      Establish that `builder/inline.ts` calls it at four sites and that
      `sunkAllocationIds`/`visitDeoptSnapshotValues` walk `callerFrameState` as a chain
      ([Ch 40 § frame-state-values], [Ch 54 § rebuilding-a-frame]). Establish the
      contrast in one sentence: **the JIT builds a chain; the AOT pass overwrites with the
      caller's link and lets a later pass delete the whole thing.**
- [ ] **`needsDeclaredIntWrap`: the callee's promise becomes the caller's problem.** Establish
      the situation: a callee declared `-> int` is entitled to have its result wrapped to
      int32 by the *callee* ([Ch 25 § declared-int-wraps-everywhere]). Splice the body in and
      that boundary is gone. Establish `answersInt32` — a return operand is already int32 if
      its result class is `RESULT_INT32`, or it is a parameter the callee declared `int`, or it
      is an integral constant inside `withinInt32` — and `needsDeclaredIntWrap` requiring
      **every** return to pass. Establish the repair: `wrapInInt32` inserts
      `Int32Or(answered, 0)` — the compiler's spelling of `x | 0` — before the call site. Pin
      with the three titles that separate the cases:
      `"wraps an inlined callee whose declared int return is not proven int32"`,
      `"leaves an inlined callee alone when every return already answers int32"`,
      `"leaves an inlined callee alone when it does not declare an int return"`.
- [ ] **Module level: bottom-up, and the pipeline that runs twice.** Establish
      `bottomUpCallOrder` as a DFS postorder that visits callees before callers and *skips*
      any callee currently `"visiting"`, so a recursive cycle is tolerated by ignoring one
      edge rather than by refusing. Establish why bottom-up: a callee that has already been
      optimized is smaller, so it costs less, so more of it fits the budget. Then establish the
      consequence that surprises everyone reading a `--print-after-all` dump:

      ```ts
      const rewrote = inlineKnownCalls(graph, functions, options) + rewriteSelfTailCalls(graph, functions);
      if (rewrote === 0) continue;
      functions.unitOf(graph)?.analyses?.invalidateAll();
      runMiddleEnd(graph, staticCompilerOptions(options));
      ```
      — src/optimizing/drivers/aot.ts:654-657

      **Pass ordinals are per-`runMiddleEnd`, not per-compile.** A function that was inlined
      into has two ordinal-8s, two ordinal-18s, and two `#-1 ir-builder` records. Show the
      `uniq -c` listing from the Worked example. Cross-reference [Ch 41 § ordinals].
- [ ] **Two inliners, one book chapter — say why they are different pieces of code.**
      Establish the split named in the part opener: `builder/inline.ts` inlines **bytecode at
      IR-build time**, driven by feedback (`selectInlineTarget` reads an `InlineCallHint` with
      a `frequency`, a monomorphic `targetRef` or a polymorphic `targets` list, and
      `buildPolymorphicDispatch` builds a guarded multi-way dispatch); `passes/inlining.ts`
      inlines **graph into graph** after the fact, driven by a static cost model with no
      feedback at all. Establish the reason the JIT cannot use the second one: by the time a
      `CFGFunction` exists the feedback has already been consumed, and the JIT has exactly one
      graph — there is no module. Establish the reason the AOT cannot use the first: there is
      no `feedbackVector` (`inlineCallee` returns `null` immediately without one,
      `builder/inline.ts:293`).
- [ ] **`> **New idea.**` Tail position, and a call that is a loop.** Establish `tailSiteOf`'s
      five conditions: the block's terminator is a `Return`; the node immediately before it is
      a call; `callSiteOf` resolves that call to **this same graph**; the returned value is
      either nothing or the call itself; and the call has no other use. Establish
      `rewritable`'s four whole-function refusals (async, generator, `gatheredArguments`,
      `recoversThrows`, plus an entry with predecessors or phis). Then the transform, which is
      shorter than the analysis: add a `preamble` block, make it the new entry, give the old
      entry one phi per parameter seeded with that parameter, mark it `isLoopHeader`, and
      rewrite every tail site into a `connect(block, entry, argumentsAsPhiInputs)` plus a
      `Jump`. Establish the subtlety the tests isolate — an argument that is *itself* a
      parameter must be carried as the loop's phi, not as the original parameter, or the
      second iteration reads the first iteration's value. Pin with
      `"carries an argument that is itself a parameter as the loop's own value"`,
      `"turns a self call in tail position into a back edge"`,
      `"reads every parameter through the phi that the loop updates"`,
      `"leaves the entry as the only block without a predecessor"`.
- [ ] **What is *not* here: a machine tail call.** Establish plainly that no backend emits
      one. `rewriteSelfTailCalls` handles the self-recursive case by turning it into a loop;
      a *mutual* tail call, or a tail call to a different function, is compiled as an ordinary
      call and grows the stack. Grep the tree for a tail-call opcode and the only hit is
      `isTailCall` in `src/optimizing/baseline/compiler.ts:282`, where the **baseline**
      compiler emits `return f(...)` in generated JavaScript — and JS engines do not guarantee
      that either. Pin the refusal with
      `"leaves a tail call to a different function alone"`.

## Honesty items

> **Never runs.** The inliner's six remark messages — the ones that explain *why* a call was
> or was not inlined, including the cost arithmetic
> (`"${name} scores ${cost} against a threshold of ${threshold}: the body is not worth the code it would add here"`)
> — are unreachable from the CLI. `RemarkRecorder.record` (`src/optimizing/infra/pass-remarks.ts:63-73`)
> starts with `if (scope === null) return;`, and a scope is opened in only three places:
> `PassManager.run` when tracing is on (`infra/pass-manager.ts:94`), the text driver
> (`drivers/text-driver.ts:69`), and the AOT driver's `stage` helper — which opens one **only
> when `opts.moduleTracer !== null`** (`drivers/aot.ts:676-679`). `moduleTracer` is set in
> exactly one place in the repository: `tools/visualizer/src/workers/compiler-worker.ts:741`.
> So the inliner's explanations exist for the compiler visualizer ([Ch 76]) and nothing else;
> `node dist/cli.js compile … --print-after-all` prints no line containing "inlin". Cost of
> fixing: a `--print-remarks` flag that installs a `moduleTracer`, or moving
> `inlineKnownCalls` into the pass manager.

> **Never runs.** `inlineLoweredCalls` (`drivers/aot.ts:627-641`) is called at line 823
> **outside** any `stage(...)`, so its remarks are discarded even in the visualizer. It is
> also the one of the two module-inlining calls that does *not* re-run the middle end — it
> only calls `analyses.invalidateAll()` — so a graph inlined at this late point is never
> re-optimized.

> **Unfinished.** `drivers/aot.ts:639-640` calls `analyses.invalidateAll();` twice in a row on
> the same object. The second call cannot do anything the first did not.

> **Unfinished.** `inlineKnownCalls` spends its budget in block-then-node order with a single
> linear scan and no ranking, so which call sites are inlined depends on the order the builder
> emitted blocks. There is no test that pins budget-exhaustion behaviour at all — the pass
> tests all run with a budget large enough for the callee — so a change to block ordering
> could silently change which functions get inlined.

> **Unenforced.** `adoptFrameState` overwrites a spliced node's frame state with the *call
> site's*, which is sound only because AOT never deoptimizes (`staticCompilerOptions` sets
> `deoptimizes: false`, `src/optimizing/optimizer.ts:39`). Nothing in `inlining.ts` asserts
> that, checks `options.deoptimizes`, or is named for it. If this pass were ever run in a
> pipeline that deoptimizes, a bailout inside a spliced body would resume at the caller's
> bytecode offset with the callee's values — and there is no verifier for that.

> **Unfinished.** No backend emits a machine tail call. `rewriteSelfTailCalls` covers the
> self-recursive case only; mutual recursion in tail position grows the stack on every target.
> Cost of finishing: a `TailCall` opcode, a capability on `TargetModel`, and — for x64 and
> riscv64 — an epilogue that restores the frame before the jump, interacting with the unwind
> tables of [Ch 68 § unwind].

## Verify it yourself

```bash
printf 'fn scale(x: float, k: float) -> float:\n  return x * k\n\nfn total(values: float[]) -> float:\n  t = 0.0\n  i = 0\n  while i < values.length:\n    t += scale(values[i], 2.0)\n    i += 1\n  return t\n\nprint(total([12.5, 9.0, 31.25]))\n' > /tmp/inl.tera
node dist/cli.js /tmp/inl.tera
node dist/cli.js compile /tmp/inl.tera --emit source --target c --print-after-all -o /tmp/inl 2>&1 \
  | grep -A1 '^\*\*\* IR after #-1 ir-builder' | grep '^fn ' | sort | uniq -c
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep -c '^\*\*\* IR after #-1 ir-builder'
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 | grep -ic inlin
grep -rn "moduleTracer" src/ tools/ --include=*.ts
npx vitest run --project unit tests/optimizing/passes/inlining.test.ts tests/optimizing/passes/tail-calls.test.ts
```

## Tests that pin this

- `tests/optimizing/passes/inlining.test.ts` > `"splices a straight-line callee into its caller"`
- `tests/optimizing/passes/inlining.test.ts` > `"keeps the caller answering the value the callee returned"`
- `tests/optimizing/passes/inlining.test.ts` > `"splices a callee that branches, and merges its answers into one phi"`
- `tests/optimizing/passes/inlining.test.ts` > `"leaves the caller reading the phi wherever it read the call"`
- `tests/optimizing/passes/inlining.test.ts` > `"keeps the code that followed the call after the spliced body"`
- `tests/optimizing/passes/inlining.test.ts` > `"refuses a callee whose entry a back edge re-enters"`
- `tests/optimizing/passes/inlining.test.ts` > `"leaves a call that passes the wrong number of arguments alone"`
- `tests/optimizing/passes/inlining.test.ts` > `"leaves a call whose arguments are named alone"`
- `tests/optimizing/passes/inlining.test.ts` > `"leaves a callee that answers a string alone"`
- `tests/optimizing/passes/inlining.test.ts` > `"leaves a callee that calls itself alone"`
- `tests/optimizing/passes/inlining.test.ts` > `"wraps an inlined callee whose declared int return is not proven int32"`
- `tests/optimizing/passes/inlining.test.ts` > `"leaves an inlined callee alone when every return already answers int32"`
- `tests/optimizing/passes/inlining.test.ts` > `"leaves an inlined callee alone when it does not declare an int return"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"turns a self call in tail position into a back edge"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"carries each argument into the parameter it replaces"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"carries an argument that is itself a parameter as the loop's own value"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"reads every parameter through the phi that the loop updates"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves the entry as the only block without a predecessor"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a call whose result the caller still works on alone"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a call whose arguments are named alone"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a coroutine alone"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a function that recovers throws alone"`
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a tail call to a different function alone"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"puts each pass's remarks on that pass's own trace record"`
- `tests/optimizing/infra/pass-manager.test.ts` > `"does not leak a throwing pass's remarks into the next run"`
- **No test pins the cost model's arithmetic, the budget, or either bonus.** `[unpinned]` —
  `inlineCostOf` and `foldingBonus` are exported but never imported by a test; every inlining
  test runs with a budget and threshold large enough that the decision is never close.
