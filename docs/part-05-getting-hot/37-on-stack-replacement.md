# 37. On-stack replacement   ⟨I · B · J⟩

> **Status:** outline

**Thesis.** An invocation counter cannot help a program with one long loop — and entering
a loop that is *already running* means rebuilding the function so that the loop header is
its entry, the loop's phis are its parameters, and everything outside the loop no longer
exists.

**What arrived.** From [Ch 36 § two-things-generated-code-must-do-by-hand]:
`compiledFn.baselineCode`, a JavaScript function closed over one `BaselineRuntime`, whose
generated body already carries — before every backward jump and only before backward ones
— `if(++sp>=1024){sp=0;osr=$.backEdge(target,r,tv,env,loopSpan);if(osr!==null)return osr;}`.
That one emitted line is this chapter's entry point, and its interpreter twin is
`onBackEdge` from [Ch 35 § back-edges]. Also: a `feedbackVector` with a `loopBudget`, and
a `callMode` of `CALL_BASELINE`.

**What leaves.** The same `RegisterCompiledFunction`, now with `osrCache` populated —
a `Map<number, OsrEntry | null>` keyed by **bytecode offset**, where a real entry is
`{code, slots}` and `null` means *asked once and refused, never ask again*. This is the
last of the four fields Part V promised. `optimizedCode` may still be `null`: a function
can reach optimized WebAssembly through this chapter without ever having been optimized
by call count. [Ch 38] takes the `RegisterCompiledFunction` and builds the SSA graph that
everything from here on stands on — and the OSR transform in this chapter is the first
thing in the book that *rewrites* that graph, so read it as a preview of Parts VI–VII as
well as a tiering mechanism.

**New ideas.** *on-stack replacement* itself — replacing a frame that has not returned;
*loop header*, *latch*, *preheader*, *loop exit block* (a light primer; the full loop
forest is [Ch 42 § loops]); *self-referential phi*, and why one whose only latch input is
itself is a constant in disguise; *graph rewriting* as a compiler action, not just
analysis; *resume precision* — how exactly a compiled frame can describe the interpreter
frame it would have to become.

**Length.** 12 pages

## Anchors

- `src/runtime/tiering/osr.ts` — 61 lines, and the whole run-time half.
  `OsrCapableEngine`, `OsrHost`, `RegisterReader`, and `enterOsr` (21-61): the
  `osrUrgency === 0` warm-up (30-33), the six-way capability check (36-45), the
  `osrCache` lookup and `compileOsr` call (47-50), `resetLoopBudget` (51), the argument
  vector built by calling `readRegister` once per `entry.slots` element (54-58),
  `_declinesEntry` (59), and the tail call
  `entry.code(args, thisValue, host, closureEnv)` (60).
- `src/optimizing/passes/osr.ts` (306 lines) — `applyOsrTransform` (118-274) and
  `repairFrameStateDominance` (276-306). Helpers: `carriesNumber` (14-27),
  `substituteFrameStateValues` (29-43), `substitute` (45-61), `loopGuardSources` (63-84),
  `osrRegionBlocks` (86-96), `templateFrameState` (98-103), `entryFrameState` (105-116).
- `src/optimizing/builder/ir-builder.ts:395-410` — where a candidate is *recorded*, inside
  the loop-header branch of the bytecode walk: `openLoopHeader` returns a
  `Map<slot, phi>`, `slots` is its key list, and
  `graph.osrCandidates.set(i, {headerBlockId, slots, phiIds})` keys it by the bytecode
  index `i` of the header. Every loop header gets one, whether or not it is ever hot.
- `src/optimizing/builder/cfg-state.ts:91-113` — `openLoopHeader`, which decides what the
  candidate's `slots` are: one phi per *live* local slot, minus `ACC_SLOT`.
- `src/optimizing/ir/index.ts` — `OsrCandidate` (108-112: `headerBlockId`, `slots`,
  `phiIds`); `CFGFunction.osrCandidates` (259) and `osrParamSlots` (260).
- `src/optimizing/optimizer.ts:150-201` — the one pipeline both roads use, with the OSR
  transform wedged between `runCompilerPasses("ir", …)` and `runMiddleEnd`: the
  `osrOffset !== null && !applyOsrTransform(...)` guard that sets
  `graph.bailout = "no osr entry at N"` (173-183), `buildFrameStateIndex`, `runMiddleEnd`,
  `clearFrameStateIndex`, then `repairFrameStateDominance(graph)` at 192 and
  `validateOptimizedGraph` at 198.
- `src/api/engine.ts:1706-1756` — `compileOsr` / `compileOsrInRuntime`: the
  `capabilities.has("osr")` target check, the `isAsync || isGenerator` refusal, the
  `optimizer.compile(compiledFn, offset, …)` call, `entry = {code, slots:
  result.graph.osrParamSlots ?? []}`, `registerOsr` for the dependency registry
  ([Ch 54 § dependencies]), `tracer.jitOSR`, and the `catch` that sets
  `disableOptimization = true` for a non-lowering error. Every path writes
  `compiledFn.osrCache.set(offset, entry)` — including the `null`s.
- `src/bytecode/register/interpreter/index.ts:1357-1383` — `onBackEdge`: the heap-sweep
  tick, then `hot = feedback ? feedback.decrementLoopBudget(max(pc - target, 1)) : policy
  ? loopCounter === policy.loopOsrThreshold : false`, then `enterOsr` with
  `(slot) => frame.getReg(slot)`. And 1775-1784, the `ROP_JUMP` case that returns the OSR
  answer straight out of `runFrame`.
- `src/optimizing/baseline/runtime.ts:415-437` — `BaselineRuntime.backEdge`: the same
  shape with `loopSpan * BACK_EDGES_PER_SAFEPOINT` charged to the budget and
  `(slot) => registers[slot]` as the reader.
- `src/optimizing/baseline/compiler.ts:44-52` — `safepointBefore`, the emitter of the line
  above; `target > from` returns `""`, so only backward jumps get one.
- `src/optimizing/backends/wasm/codegen.ts:4301-4319` — `failingEntryGuard`, which
  re-checks each entry guard against the actual argument vector; `:4853-4856` —
  `if (analysis.isOsr) optimizedCode._declinesEntry = (args) => failingEntryGuard(args)
  !== null`; `:1535` — `isOsr: !!graph.osrParamSlots`.
- `src/feedback/vector/index.ts:778-816` — `DEFAULT_LOOP_BUDGET = 1000`,
  `FeedbackVector.loopBudget` / `loopBudgetSize` / `osrUrgency`, `decrementLoopBudget`,
  `incrementOsrUrgency`, `resetLoopBudget`; and `fromCompiledFunction` (910-921), where
  the budget is `INVOCATION_COUNT_FOR_OPTIMIZATION * bytecodeLength`.
- `src/bytecode/register/ops/bytecode.ts:163-165` — `_declinesEntry` on `OptimizedCode`,
  and `OsrEntry = { code: OptimizedCode; slots: number[] }`; `:407` `osrCache`.
- `src/deopt/dependencies.ts:182` — `if (fn.osrCache) fn.osrCache.clear()`, the one place
  a refusal is ever forgotten.

## Worked example

`Series.mean` in `docs/example/stats.tera` runs a five-element loop and a four-element
loop, once each; nothing in the example set can be entered mid-flight, and Part V's opener
says so. So this chapter's
demonstration pins the *call counter shut* and lets the loop tier up anyway — the
condition the mechanism exists for, reproduced from the CLI in two commands:

```bash
TMP=$(mktemp -d) && printf 'fn work(n: int) -> int:\n  seen = 0\n  i = 0\n  while i < n:\n    seen = seen + 1\n    i = i + 1\n  return seen\n\nprint(work(200000))\n' > "$TMP/hotloop.tera"
node dist/cli.js --baseline-threshold 1 --opt-threshold 1000000 --trace-opt "$TMP/hotloop.tera"
node dist/cli.js --baseline-threshold 1 --opt-threshold 1000000 --no-osr --trace-opt "$TMP/hotloop.tera"
```

`work` is called **once**. With `--opt-threshold 1000000` it can never reach
`jitThreshold`. The first command prints, verbatim:

```
[JIT] Compiling "<script>": Baseline compiled: 12 bytecodes
[JIT] Compiling "work": Baseline compiled: 28 bytecodes
[JIT] OSR "work" at loop offset 4
200000
```

The second — identical but for `--no-osr` — prints the two baseline lines and the answer,
and no OSR line at all. `baselineCode` is set in both runs; `optimizedCode` is `null` in
both; only the first has a real entry in `osrCache`.
`tests/e2e/optimizing/baseline-osr.test.ts` asserts exactly that triple on a
150,000-iteration loop with `jitThreshold: Number.MAX_SAFE_INTEGER`, which is the same
experiment done from inside the engine rather than through flags.

## Outline

- [ ] **§ what-a-counter-cannot-see** — Establish the gap [Ch 35] left. Every tier-up
  mechanism so far triggers on *entering* a function: `invocationCount` reaching
  `baselineThreshold`, then `jitThreshold`. A program whose whole run is
  `work(200000)` enters `work` once. Show the worked example's first two trace lines —
  baseline compiled, and then nothing — as the shape of the problem, and state the
  requirement plainly: the tier-up has to happen to a frame that has not returned and
  cannot be re-entered from the top, because re-entering would redo the first 100,000
  iterations. `> **New idea.**` on-stack replacement.
- [ ] **§ the-poll** — Establish where the question gets asked, and that it is the *same*
  place [Ch 35] put the safepoint. Interpreter: `ROP_JUMP` / `ROP_JUMP_IF_TRUE` /
  `ROP_JUMP_IF_FALSE` compute `target < frame.pc` ([Ch 19 § back-edge]) and call
  `onBackEdge`. Baseline: `safepointBefore` emits the counter *at compile time*, guarded
  by `typeof target !== "number" || target > from`, so a forward jump gets an empty
  string. Establish the budget arithmetic side by side: the interpreter charges
  `max(pc - target, 1)` per back edge, the baseline charges
  `loopSpan * BACK_EDGES_PER_SAFEPOINT` once per 1024 back edges — the same currency,
  because generated code only polls every 1024th time. And the budget itself is
  `INVOCATION_COUNT_FOR_OPTIMIZATION * bytecodeLength`
  (`FeedbackVector.fromCompiledFunction`), which is why a long loop body reaches the
  question sooner than a short one — [Ch 35 § budget-is-a-product] earned this; here it
  decides *when*.
- [ ] **§ enterosr-in-full** — Read `src/runtime/tiering/osr.ts` as a whole; at 61 lines
  it is the shortest complete mechanism in the book. Walk it in order.
  1. **The warm-up.** `if (feedback && feedback.osrUrgency === 0) { incrementOsrUrgency();
     return null; }` — the *first* time a loop exhausts its budget, nothing happens except
     that a counter leaves zero. The second exhaustion is the first that can compile.
     Establish what this buys: one full budget of running time for the feedback vector to
     fill in, so the speculation the JIT is about to make is based on more than a
     cold loop's first pass.
  2. **The capability check.** Six disqualifiers in one `if`: no engine, no tiering
     policy, `osrEnabled === false` (this is `--no-osr`), `disableOptimization`,
     `requiresInterpreterOnly` ([Ch 27 § eleven-opcodes]), and no `compileOsr` method.
  3. **The cache.** `osrCache.get(target)`; `undefined` means never asked, so compile;
     `null` means asked and refused, and — this is the subtle part — `if (!entry) return
     null` treats both a fresh refusal and a cached one identically, so a loop that cannot
     be entered pays one compile attempt, ever.
  4. **`resetLoopBudget()` before the entry check**, so a refused loop starts its next
     budget from full rather than re-asking on the next back edge.
  5. **The argument vector.** `for (const slot of entry.slots) args.push(readRegister(slot))`
     — the compiled entry names the register slots it needs, in order, and the caller
     supplies a reader. Establish that this is the only coupling between the two frame
     layouts of [Ch 36 § a-frame-the-interpreter-would-recognise].
  6. **`_declinesEntry`.** A last-moment refusal *at run time*, on values the compiler
     only speculated about: `failingEntryGuard` walks the entry guards and checks each
     against the argument actually being passed. Establish the design rule this shares
     with [Ch 54]: it is cheaper to decline the entry than to enter and immediately
     deoptimize, because deoptimizing costs a materialized frame.
- [ ] **§ making-the-header-the-entry** — The centre of the chapter, and the first graph
  rewrite in the book. State the goal in one sentence — *produce a function whose entry
  block is the loop header and whose parameters are the loop's carried values* — then
  the primer. `> **New idea.**` loop header, latch, preheader, exit block; and
  *self-referential phi*: a phi whose latch input is the phi itself carries the same value
  every iteration, so it is not really a loop variable at all. Diagram: one mermaid
  before/after, four blocks each.
- [ ] **§ the-transform-step-by-step** — Read `applyOsrTransform` (118-274) in order; it
  is one function and the chapter's longest listing, so quote it in pieces of ≤20 lines.
  1. Find the candidate by bytecode offset, confirm the block is still a loop header in
     the loop forest, and confirm `slots.length === phiIds.length` with no duplicates
     (126-135).
  2. Identify the **single latch** and the **single external entry** (the preheader, or
     the one predecessor outside the loop) and their positions in
     `header.predecessors` (137-147).
  3. Compute the region: `osrRegionBlocks` = the loop's blocks *plus everything reachable
     from its exit blocks* (86-96). That "plus" is what makes the post-loop code and the
     `return` survive.
  4. Make one `irParameter` per candidate phi, in candidate order (167-174).
  5. **Fold or rewire, per phi** (181-202). Four cases, and the table is the section:
     a candidate phi whose latch input is itself → *fold* the phi away entirely,
     replacing it with the parameter (a loop-invariant value, like `n`); a candidate phi
     that really varies → keep it, replace its *entry* input with the parameter; a
     non-candidate phi whose latch input is itself → fold to its entry value; anything
     else → keep. Then `substitute` rewrites every input and every frame state in one
     pass (204), the surviving phis are renumbered (206-210), and folded nodes are
     dropped from the header.
  6. **Prove the region is closed** (212-231): every input of every node in the region
     must be defined in the region, be an OSR parameter, or be a constant — and a
     constant is simply re-homed into the header (`ir.homeInstruction`). Anything else
     returns `false`.
  7. **Re-create the guards** (233-256). This is the step that is easy to miss and
     impossible to skip: the loop body was compiled assuming its phis had already been
     checked by guards *above* the loop, and those blocks are about to be deleted. So
     `loopGuardSources` scans the region for `IR_CHECK_SMI` / `IR_CHECK_NUMBER` nodes
     whose input is one of the surviving phis, preferring `CHECK_SMI`, and the new entry
     block gets a fresh copy of each — plus, via `carriesNumber` (14-27), one for any phi
     whose latch value produces a number even if no guard was found. Each new guard gets a
     cloned frame state (`entryFrameState`) with the phi→parameter substitution applied.
     These are exactly the guards `_declinesEntry` re-checks in § enterosr-in-full.
  8. **Rewire and truncate** (257-273): the entry block is unlinked from the header,
     `osrEntry` takes its predecessor index, `graph.entry = osrEntry`,
     `graph.parameters = osrParams`, `graph.osrParamSlots = candidate.slots.slice()` —
     the list `enterOsr` will read registers by — and then
     `graph.blocks = [osrEntry, ...blocks.filter(b => osrBlocks.has(b))]`. Everything
     before the loop is gone. Establish the consequence: the resulting graph is a valid
     function that *cannot* be called normally, which is why it lives in `osrCache` and
     never in `optimizedCode`.
- [ ] **§ the-three-bailouts** *(Why the obvious design fails)* — Of the thirteen
  `return false` sites, three are about the program rather than a malformed request, and
  each one is a design a reader would have expected to work.
  1. **More than one latch, or no single external entry** (143). A loop with two back
     edges has no single "where we came from" edge to replace, so there is no place to put
     the entry block. `forest.irreducible` (125) is the same objection at a larger scale.
  2. **A self-recursive call inside the region** (150-160): `IR_CALL_KNOWN_FUNCTION` whose
     `props.target === selfFn`. Establish why — the OSR graph *is* `selfFn`, but with a
     different entry and a different parameter list, so a self-call inside it would have
     to call the normal entry that no longer exists in this graph.
  3. **A value defined before the loop and used inside it** that is neither a constant nor
     an OSR parameter (213-231). Stage the obvious fix — make it a parameter too — and
     say why it is not one line: the candidate's `slots` are fixed at IR-build time from
     `openLoopHeader`'s live-slot set, and a value with no register slot (a temporary, a
     hoisted load) has no name the interpreter could supply.
- [ ] **§ resume-precision-is-lost** — The chapter's honest core. Establish the problem:
  after `runMiddleEnd` has moved and deleted code, a frame state may still name a value
  whose definition no longer dominates the instruction that carries the state — which is
  meaningless, because the deopt machinery of [Ch 40] would have to read a value that has
  not been computed. Read `repairFrameStateDominance` (276-306): compute dominators, walk
  every frame state value, skip parameters, constants and sunk allocations, and for
  anything whose defining block does not dominate the use, **replace it with a single
  shared `irConstant(undefined)`**. Establish exactly what that costs: the register the
  interpreter resumes into holds `undefined` rather than the value it should have — a
  documented, deliberate loss of resume precision, traded for a graph the verifier will
  accept. Then the general rule: *a repair that makes the compiler's invariant true by
  changing the program's meaning is a bug budget, not a fix* — and note that this pass
  runs on **every** compilation, OSR or not (optimizer.ts:192), so the cost is not
  confined to this chapter.
- [ ] **§ the-baseline-side** {#the-baseline-side} — Establish the two-line answer to a
  question that sounds hard. Generated JavaScript cannot have its frame replaced; the
  host owns it. So it does not try. `$.backEdge` returns either `null` or *the value the
  optimized code returned*, and the emitted line is `if(osr!==null)return osr;` — the
  baseline function returns the OSR result **as its own result**. The optimized entry ran
  the rest of the loop *and* everything after it, up to and including the `return`. The
  interpreter's `ROP_JUMP` case does the identical thing:
  `const osr = this.onBackEdge(...); if (osr !== null) return osr;`. Establish the
  invariant that makes this sound — the OSR region is *closed under the loop's exits*
  (§ the-transform-step-by-step, step 3) — and the test that pins it:
  `tests/e2e/optimizing/osr.test.ts > "runs post-loop code and returns through the
  optimized entry"`. Then the corollary worth stating: `null` is doing double duty as
  "not hot enough", "refused", and "declined at entry", and the two callers cannot tell
  them apart — which is correct, because all three mean *keep interpreting*.
- [ ] **§ two-readers-one-contract** — Close on the register-reading asymmetry, which is
  where [Ch 20 § tdz-is-a-value-not-a-flag] comes back. The interpreter passes
  `(slot) => frame.getReg(slot)`: upvalue-aware, TDZ-checked, and it will *throw* rather
  than hand out a sentinel. The baseline passes `(slot) => registers[slot]`: a raw array
  index. Establish that both are correct today only because [Ch 36]'s five refusals and
  `requiresInterpreterOnly` between them keep TDZ-heavy and closure-heavy functions out of
  baseline — an argument by exclusion, not an enforced invariant. Then the smaller
  divergence: `enterOsr` normalises `undefined` to `mkUndefined()` (57) for exactly this
  reason.

## Honesty items

- > **Broken.** `--no-opt` does not stop on-stack replacement, and therefore does not stop
  the program from running in optimized WebAssembly. `buildTiering`
  (`src/cli/main.ts:49-57`) sets both `jitThreshold` and `loopOsrThreshold` to
  `Number.MAX_SAFE_INTEGER` for `optMode === "none"` — but `onBackEdge`
  (`src/bytecode/register/interpreter/index.ts:1367-1373`) reads `loopOsrThreshold`
  **only** when `compiledFn.feedbackVector` is falsy, and the vector is installed at
  `index.ts:902` before any back edge executes. Measured on the worked example:
  `node dist/cli.js --no-opt --stats hotloop.tera` reports `"jit_osr": 1`, and
  `--trace-opt` prints the full speculative-compilation trace. Adding `--no-osr` removes
  the counter entirely. The flag's own summary is `never tier up to the optimizing
  compiler` (`src/cli/spec.ts:199`). Cost of fixing: one line — make the `hot` expression
  consult the policy before the budget, or have `enterOsr` treat
  `loopOsrThreshold === Number.MAX_SAFE_INTEGER` as `osrEnabled === false`.
- > **Never runs.** `AdaptiveTieringPolicy.shouldOSR`
  (`src/runtime/tiering/adaptive.ts:172-187`) is a complete OSR admission policy —
  cooldown, compile-failure count, `hasOSRReadyFeedback` (no megamorphic slot), the
  `loopOsrThreshold` comparison, and `getOSRUrgency` — and it is declared on the
  interpreter's policy interface (`interpreter/index.ts:198`). Nothing in `src/` calls it.
  The only callers are `tests/runtime/tiering/adaptive.test.ts`. The real admission
  decision is `feedback.decrementLoopBudget(...)` plus the six-way check in `enterOsr`,
  which consults none of those signals. So `loopOsrThreshold: 30` — the number
  `docs/README.md` quotes as "loop iterations before entering a running loop" — governs
  only a fallback that fires when there is no feedback vector, and a policy method nothing
  invokes. Cost of connecting it: one call in `onBackEdge`; cost of deleting it: 25 lines
  plus two tests.
- > **Unfinished.** `FeedbackVector.osrUrgency`
  (`src/feedback/vector/index.ts:787, 798, 809-811`) is only ever incremented, and only
  ever read as `feedback.osrUrgency === 0` (`src/runtime/tiering/osr.ts:30`). It is a
  boolean wearing a counter's clothes: "has this loop ever exhausted a budget". Nothing
  decays it, nothing compares it to a threshold, and `AdaptiveTieringPolicy.getOSRUrgency`
  — which does compute a graded urgency — is a different function on a different object
  that never runs (above). Cost of finishing: pick one of the two.
- > **Unfinished.** `repairFrameStateDominance` (`src/optimizing/passes/osr.ts:276-306`)
  substitutes a single shared `irConstant(undefined)` for every frame-state value whose
  definition does not dominate its use, and returns the number of substitutions it made.
  `src/optimizing/optimizer.ts:192` discards the return value. So the engine knows exactly
  how much resume precision it just gave up, on every compilation, and reports it to
  nobody — not to `--stats`, not to `--trace-turbo`, not to `validateOptimizedGraph` two
  lines later. Cost of surfacing it: one `tracer` call.
- > **Unenforced.** Nothing checks that the two `RegisterReader`s agree. The interpreter
  supplies `frame.getReg`, which redirects through open upvalue cells and throws
  `VMReferenceError` on a TDZ slot; `BaselineRuntime.backEdge` supplies
  `registers[slot]`, a raw index that would hand `TDZ_UNINITIALIZED` — an object, not a
  `TaggedValue` — straight into the compiled entry's argument vector. Today this cannot
  happen, because [Ch 36 § the-five-refusals] and `requiresInterpreterOnly` keep those
  functions out of baseline; but that is a coincidence of two unrelated filters, stated
  in neither file. Cost of enforcing: route the baseline reader through a shared helper,
  or assert in `enterOsr` that every argument is a tagged value.
- > **Unenforced.** `enterOsr` calls `engine.compileOsr(compiledFn, target)` whenever
  `osrCache.get(target)` is `undefined` (`osr.ts:47-50`), and
  `compileOsrInRuntime` opens by reading the same cache again
  (`engine.ts:1711-1712`). The duplicate lookup is harmless, but it is also the only thing
  standing between "asked and refused" and an unbounded recompile loop — `enterOsr` itself
  never writes to `osrCache`, so a `compileOsr` implementation that forgot to cache its
  `null` would recompile on every budget exhaustion for the life of the program. The
  contract "compileOsr must cache, including failures" is stated nowhere. [unpinned]

## Verify it yourself

```bash
TMP=$(mktemp -d) && printf 'fn work(n: int) -> int:\n  seen = 0\n  i = 0\n  while i < n:\n    seen = seen + 1\n    i = i + 1\n  return seen\n\nprint(work(200000))\n' > "$TMP/hotloop.tera"
node dist/cli.js --baseline-threshold 1 --opt-threshold 1000000 --trace-opt "$TMP/hotloop.tera"
node dist/cli.js --baseline-threshold 1 --opt-threshold 1000000 --no-osr --trace-opt "$TMP/hotloop.tera"
node dist/cli.js --no-opt --stats "$TMP/hotloop.tera" | grep '"jit_osr"'
npx vitest run --project e2e tests/e2e/optimizing/baseline-osr.test.ts
npx vitest run --project e2e tests/e2e/optimizing/osr.test.ts
```

The third command is the honesty item: it prints `"jit_osr": 1` under a flag whose summary
is `never tier up to the optimizing compiler`.

## Tests that pin this

- `tests/e2e/optimizing/baseline-osr.test.ts > "tiers a hot loop up to optimized code after the function is already in baseline"`
  — the worked example, asserted from inside the engine: `baselineCode` truthy,
  `optimizedCode` falsy, a non-`null` value in `osrCache`, with
  `jitThreshold: Number.MAX_SAFE_INTEGER`.
- `tests/e2e/optimizing/baseline-osr.test.ts > "leaves the loop in baseline when OSR is disabled"`
  — the `osrEnabled === false` arm of the capability check.
- `tests/e2e/optimizing/baseline-osr.test.ts > "keeps the accumulated loop state when the baseline frame is replaced mid-loop"`
  — 150,000 iterations, and the answer must be `HOT_ITERATIONS * 2 + 1`. This is the test
  that pins the argument vector.
- `tests/e2e/optimizing/baseline-osr.test.ts > "carries a smi accumulator that overflows to double through the replacement"`
  — the entry guard's `CHECK_SMI` vs `CHECK_NUMBER` choice, from the other side.
- `tests/e2e/optimizing/baseline-osr.test.ts > "replaces a conditional back edge and honours an early return"`
- `tests/e2e/optimizing/baseline-osr.test.ts > "replaces an outer loop that carries a nested loop and a call"`
- `tests/e2e/optimizing/baseline-osr.test.ts > "preserves global side effects written by the loop it replaces"`
  — asserts the exact triangular number, so a partially-replayed or partially-skipped loop
  fails rather than merely differing.
- `tests/e2e/optimizing/osr.test.ts > "compiles and enters a hot loop on a single call"`
  — the thesis, in one title.
- `tests/e2e/optimizing/osr.test.ts > "preserves semantics for float loops"`
- `tests/e2e/optimizing/osr.test.ts > "preserves global side effects performed inside the loop"`
- `tests/e2e/optimizing/osr.test.ts > "runs post-loop code and returns through the optimized entry"`
  — § the-baseline-side stands on this one.
- `tests/e2e/optimizing/osr.test.ts > "deoptimizes correctly when an int loop value overflows to double"`
- `tests/e2e/optimizing/osr.test.ts > "handles branches, nested loops, calls, and early returns"`
- `tests/e2e/optimizing/osr.test.ts > "does not disturb loops that never reach the OSR budget"`
  — the negative control for § the-poll.
- `tests/e2e/optimizing/osr.test.ts > "rebuilds the caller frame when a deopt fires inside an inlined callee"`
- `tests/e2e/optimizing/osr.test.ts > "keeps a deep inline chain correct once the outer loop is replaced on stack"`
  — the interaction with [Ch 50 § inlining] and [Ch 40 § inlined-frames].
- `tests/e2e/optimizing/osr-objects.test.ts > "compiles an object field read loop through OSR"`
- `tests/e2e/optimizing/osr-objects.test.ts > "guards object fields flowing into float arithmetic"`
- `tests/e2e/optimizing/osr-objects.test.ts > "compiles an object field mutation loop through OSR"`
- `tests/e2e/optimizing/osr-objects.test.ts > "compiles an array push and read loop through OSR"`
- `tests/e2e/optimizing/osr-objects.test.ts > "stays correct when a guarded field value grows into a double"`
- `tests/e2e/optimizing/osr-objects.test.ts > "stays correct when a field value becomes a non-number mid-loop"`
  — the `_declinesEntry` / entry-guard pair, exercised on maps rather than numbers.
- `tests/e2e/optimizing/osr-objects.test.ts > "tiers up an object field mutation loop without OSR"`
- `tests/e2e/optimizing/osr-objects.test.ts > "tiers up an object field read loop without OSR"`
- `tests/e2e/optimizing/osr-objects.test.ts > "tiers up an array element read loop without OSR"`
  — the three controls that prove the OSR tests are testing OSR.
- `tests/runtime/tiering/adaptive.test.ts > "shouldOSR returns false without optimized OSR entry"`
- `tests/runtime/tiering/adaptive.test.ts > "getOSRUrgency increases with loop count"`
  — the only two callers of the policy that never runs.
- There is **no unit test for `applyOsrTransform` or `repairFrameStateDominance`**. There
  is no `tests/optimizing/passes/osr.test.ts`. The 306-line file at the centre of this
  chapter is covered only end-to-end, which is why § the-three-bailouts and
  § resume-precision-is-lost are argued from source rather than from a pinned title.
  `[unpinned]`
