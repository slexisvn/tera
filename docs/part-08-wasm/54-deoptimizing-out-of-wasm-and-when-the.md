# 54. Deoptimizing out of wasm, and when the JIT says no   ⟨ I · J ⟩

> **Status:** outline

**Thesis.** A JavaScript host cannot read wasm locals, so the frame state is spilled
into linear memory before the bailout — and a deopt that invents a value is worse
than one that gives up.

**What arrived.** A live `OptimizedCode` closure from chapter 53, running: arguments
marshalled into linear memory, `threadLocal.currentObjPtrs` set, the wasm export
executing with the program's values in wasm locals the host cannot see.

**What leaves.** Either a `TaggedValue` (the optimized answer), or a `RegisterFrame`
handed to `interpreter.resumeAt` with `frame.pc` set to the exact bytecode offset the
speculation was taken at — and `compiledFn.optimizedCode = null`, so the next call
starts over. Either way the program's observable behaviour is identical, which is the
whole claim of Part XIII.

**New ideas.** *Deoptimization* / *bailout*; *frame state* as a spill format rather
than a compiler concept; *eager* versus *lazy* deopt; *materialization* (rebuilding a
value that was never stored anywhere); *dependency* and *invalidation*.

**Length.** 14 pages

## Anchors

- `src/optimizing/backends/wasm/codegen.ts` — `emitDeoptSnapshot`,
  `emitConditionalDeopt`, `emitNumberGuard`, `emitCheckedInt64FromF64`;
  `readDeoptSnapshot` and the `imports.env.deopt` closure in `compile`;
  `createWrapper`'s `failingEntryGuard`, `recordWasmDeopt`, the `catch (e) { if (e
  instanceof DeoptSignal) ... }` block, `commitTrackedObjects`, `storeGlobalCells`,
  the `REP_HANDLE` runtime-value patch-up loop, `resumeFrameStateChain` /
  `materializeFrameFromState` dispatch, `optimizedCode._dispose`,
  `optimizedCode._declinesEntry` (OSR only), `MAX_DEOPT_COUNT`.
- `src/optimizing/backends/wasm/wasm-format.ts` — `DEOPT_SNAPSHOT_BASE = 8`,
  `DEOPT_SNAPSHOT_SLOT_BYTES = 8`.
- `src/optimizing/ir/frame-state-values.ts` — `visitDeoptSnapshotValues`,
  `visitOneDeoptSnapshot`, `deoptSnapshotSlotCount`, `maxDeoptSnapshotSlots`,
  `sunkAllocationIds`. This is the file that defines *slot order*, and both the writer
  and the reader call it.
- `src/optimizing/backends/wasm/deopt-reasons.ts` — `DEOPT_REASON_LIST` (12 entries),
  `deoptReasonId`, `deoptReasonFromId`, `deoptReasonForNode`.
- `src/optimizing/backends/wasm/deopt-sites.ts` — `siteOf`, `DeoptSiteTable`,
  `collectDeoptSites`, and `DeoptSiteTable.resolve`'s three-tier fallback.
- `src/deopt/signal.ts` — `DeoptSignal` (`reason`, `bytecodeOffset`, `frameStateId`,
  `runtimeValues`, `closureEnv`).
- `src/deopt/frame-materializer.ts` — `materializeFrameValue` (the big
  re-derivation switch), `materializeFrameFromState`, `resumeFrameStateChain`,
  `requireCompiledFunction`, `isDeoptIRNode`.
- `src/deopt/deoptimizer.ts` — the twelve `DEOPT_*` reason constants, `Deoptimizer`,
  `LazyDeoptMarker` (`markForDeopt`, `hasPendingDeopt`, `consumeDeopt`,
  `invalidateDependents`), `handleDisableOptimization`, `recordDeoptReason`,
  `getStats`, `IC_FAILURE_REASONS`.
- `src/deopt/dependencies.ts` — `DEP_MAP`, `DEP_ELEMENTS_KIND`, `DEP_CALL_TARGET`,
  `DEP_PROTO_VALIDITY`, `DependencyRegistry.register` / `unregister` / `invalidate`,
  `dependencyKey`.
- `src/deopt/origin.ts` — `DeoptSiteLike`, `DeoptSiteLookup`, `deoptOriginData`,
  `candidatesFor`.
- `src/optimizing/target/jit.ts` — `RejectionKind`, `CompileRejection`,
  `JitRejection`, `JitCompileResult`.
- `src/api/engine.ts:1807-1858` — where a rejection becomes either a cooldown or a
  permanent `disableOptimization`, via `recordCompileFailure`.
- `src/optimizing/backends/wasm/graph-support.ts` — `hotBoxedReturnRejection`,
  `boxedNumericReturns`, `hotBlocks` — the one marshalling-shaped decline that
  survives.
- `tests/e2e/optimizing/tiering-declines.test.ts`, `tests/e2e/optimizing/deopt.test.ts`,
  `tests/optimizing/backends/wasm/deopt-sites.test.ts`.

## Worked example

`docs/example/stats-deopt.tera` puts a string into a float array. `total_of` runs 200
times on `clean: float[]`, the JIT speculates `PACKED_DOUBLE` and registers a
dependency on it, and then the same function is handed `tainted`.

```bash
node dist/cli.js --trace docs/example/stats-deopt.tera
```

```
[DEOPT] Dependency registered: total_of -> elements-kind:PACKED_DOUBLE
[DEOPT] DEOPT "total_of": elements-kind-check-failed at bytecode:8
warm  total=78.50
taint total=21.531.257.7518
```

The second line is a real bailout mid-loop: the snapshot is read out of linear
memory at `DEOPT_SNAPSHOT_BASE`, `total` and `i` are restored into
`frame.locals`, `frame.pc = 8`, and `Series`-free `total_of` finishes in the
interpreter. The third line is the proof — `21.531.257.7518` is the string
concatenation the interpreter performs once a `string` is in the array, which is
exactly what the un-optimized program does.

## Outline

- [ ] **§ the-problem** — Establish the asymmetry in one paragraph. When the
      interpreter bails out of baseline code, the values are JavaScript variables the
      host can read. When wasm bails out, the values are in **wasm locals**, and the
      JavaScript host has no API to read a wasm local — not from an import, not from a
      trap handler, not at all. Whatever the bailout needs must therefore be *pushed
      into linear memory by the wasm code itself, before it calls out*.
      **`> **New idea.** Deoptimization** — discarding optimized code mid-execution and
      resuming the same activation in a slower tier, at the same program point, with the
      same values.
- [ ] **§ three-ways-to-stop** — Set the shape of the chapter. Optimized code stops
      being valid in three different ways, at three different times, with three
      different mechanisms:
      (1) **eagerly at entry**, in JavaScript, before a single byte is marshalled —
      `failingEntryGuard`;
      (2) **from inside wasm**, mid-execution — the `env.deopt` import and `DeoptSignal`;
      (3) **lazily**, because something the code assumed changed while it was not
      running — `LazyDeoptMarker` and `dependencyRegistry.invalidate`.
      A table with: when it fires, what reads the frame state, what the cost is.
- [ ] **§ entry-guards** — The cheapest one. `createWrapper` collects `entryGuards`
      whose input is an `IR_PARAMETER`, and `failingEntryGuard(args)` re-checks each in
      plain JavaScript: `IR_CHECK_SMI` → `!isSmi(arg)`, `IR_CHECK_NUMBER` →
      `!isNumber(arg)`, `IR_CHECK_MAP` → the argument's `hiddenClass.id` against
      `expectedMapId`. Land the point: **the guard is compiled into wasm *and* checked
      in JS**, because failing before `allocateTagged` runs costs nothing, and failing
      after it has copied an object graph costs everything. The same function is reused
      as `optimizedCode._declinesEntry` for OSR entry (`analysis.isOsr`). Note the
      global-cell pre-check just above it: if any mirrored cell no longer holds a
      number, deopt at offset 0 before marshalling.
- [ ] **§ the-snapshot** — The spill format. `emitDeoptSnapshot(fs, analysis, bytes)`
      walks `visitDeoptSnapshotValues(fs, writeValue)` and, for each value that has a
      wasm local, emits `i32.const <offset>; local.get <loc>; [f64.convert_i32_s];
      f64.store align=3 offset=0` — where `offset = DEOPT_SNAPSHOT_BASE + slot * 8`.
      **The slot number is a running counter, not a name.** Establish the invariant that
      makes this work at all: the writer and the reader both walk
      `visitDeoptSnapshotValues`, which visits locals `0..maxSlot`, then stack values,
      then sunk-allocation props and fields, then `thisValue`, then the caller frame
      state — in that order, for the whole inlined chain. Position matters and nothing
      else does.
      **`> **Unenforced.**` — nothing checks that `emitDeoptSnapshot` and
      `readDeoptSnapshot` are walking the same order; the guarantee is that both call
      one function.**
      Note that `maxDeoptSnapshotSlots(graph)` sizes the region for the largest frame
      state in the function, so the snapshot area is reused by every guard.
- [ ] **§ reading-it-back** — `readDeoptSnapshot(fs)` in `compile`, over a
      `Float64Array` view of the same memory, incrementing `slot` in lockstep. Then the
      four-way decision per value: (a) rep is `REP_HANDLE` and
      `threadLocal.currentObjPtrs` has the truncated pointer → put the **real
      `TaggedValue`** in `runtimeValues`; (b) rep is `REP_HANDLE` and it does not →
      `slot++; return` — **record nothing**; (c) wasm type i32 → `mkSmi(rawInt)`;
      (d) wasm type f64 → `mkDouble(rawF64)`. Case (b) is the chapter's thesis in four
      lines: the slot holds a pointer this activation cannot resolve, and the only
      honest answer is silence, because `mkNumber(4194304)` would be a silent
      miscompile. The value is then re-derived by `materializeFrameValue` or the resume
      fails loudly.
      `[t: tests/e2e/optimizing/deopt.test.ts > "resumes a guarded method call without
      inventing a numeric callee"]`
- [ ] **§ the-signal** — `imports.env.deopt(reasonId, frameStateId)` is two integers
      and a `throw`. It looks the reason up through `deoptReasonFromId` (a 12-entry
      list, index-encoded so the wasm side can push an `i32.const`), finds the frame
      state, reads the snapshot, and throws `DeoptSignal`. Establish why a *throw* is
      the right mechanism: it unwinds the wasm frames for free, and the `OP_UNREACHABLE`
      that `emitConditionalDeopt` emits after the call is a promise to the validator
      that control does not return. Show `emitConditionalDeopt` whole — it is 12 lines
      and it is the entire in-wasm bailout: `if(void) { snapshot; i32.const reason;
      i32.const fsId; call deopt; unreachable } end`. Same shape appears inside
      `emitCheckedInt64FromF64` — cross-reference [Ch 52 § tointeger] for the *other*
      choice.
- [ ] **§ catching-it** — The `catch (e)` in `runActivation`, in order, because the
      order is the correctness argument:
      1. `wasmCallDepth--` and restore `threadLocal.currentObjPtrs` / `currentRuntime`
         — before anything can re-enter;
      2. `commitTrackedObjects()` — copy every tracked object *back* out of linear
         memory, because the partial execution's writes are real;
      3. `storeGlobalCells()` — same for the mirrored globals;
      4. `recordWasmDeopt(...)` — count it, clear `optimizedCode`, unregister
         dependencies, disable optimization past `maxDeoptCount`;
      5. patch `e.runtimeValues`: any entry whose node rep is `REP_HANDLE` and whose
         recorded value is a pointer `objPtrs` knows is replaced by the real
         `TaggedValue` — the second chance at case (b) above;
      6. `frameState.isInlinedFrame` → `resumeFrameStateChain`, otherwise
         `materializeFrameFromState` + `interpreter.resumeAt`.
      Establish: **committing before resuming is not an optimization, it is the
      correctness condition** — the interpreter is about to re-read those objects.
- [ ] **§ materialization** — `materializeFrameValue` is the function that answers
      "what was this value?" for a node whose runtime value was not in the snapshot.
      Walk its strategy: pass-through nodes (`IR_CHECK_*`, `IR_BOX`, `IR_UNBOX`,
      `IR_LOAD_LOCAL`, `IR_STORE_CONTEXT_SLOT`) recurse to input 0; `IR_PARAMETER`
      indexes `args`; `IR_LOAD_FIELD` / `IR_POLYMORPHIC_LOAD` re-read the object;
      `IR_LOAD_GLOBAL` re-reads the cell; `IR_CONSTANT` rebuilds by JS type; and the
      arithmetic cases *re-execute* the operation on materialized inputs.
      **`> **New idea.** Materialization** — a value the optimizer deleted can be
      recomputed from the graph, because SSA still records how it was made.
      Then the refusals, which are the point: `IR_PHI` takes `trivialPhiInput` and
      otherwise **throws** `Cannot materialize non-trivial Phi v<id> without runtime
      value`; `IR_LOAD_CONTEXT_SLOT` and `IR_MAKE_CLOSURE` throw outright. A loop
      accumulator has no single answer, and guessing one would resume the loop with the
      wrong total.
      `[t: tests/e2e/optimizing/deopt.test.ts > "resumes with the current loop
      accumulator after a late type miss"]`
- [ ] **§ attribution** — Why a bailout can name a source line. `collectDeoptSites`
      walks the graph at compile time and records a `DeoptSite` per `canDeoptimize`
      node: `nodeId`, `opcode`, `reason`, `blockId`, `frameStateId`, `bytecodeOffset`,
      `line`. `DeoptSiteTable.resolve(reason, frameStateId)` then tries three things in
      order — sites sharing the frame state *and* the reason; all sites sharing the
      frame state; all sites sharing the reason anywhere. `deoptOriginData` reports
      `nodeId`/`opcode`/`line` **only when exactly one candidate survives**, and always
      reports the full `candidates` array. Establish the rule: *a diagnostic that
      narrows to one guard says which; a diagnostic that cannot says how many.*
      `[t: tests/optimizing/backends/wasm/deopt-sites.test.ts > "resolves a bailout to
      the single guard that shares its frame state and reason"]`
      `[t: tests/optimizing/backends/wasm/deopt-sites.test.ts > "returns every guard
      sharing a frame state when the reason does not single one out"]`
- [ ] **§ lazy-deopt** — The third way. Code can become invalid while it is not
      running: a hidden-class transition, an elements-kind change, a call target
      rebound. `dependencyRegistry.register(compiledFn, graph.dependencies)` records
      what was assumed (`DEP_MAP`, `DEP_ELEMENTS_KIND`, `DEP_CALL_TARGET`,
      `DEP_PROTO_VALIDITY`); `invalidate` finds the dependents and
      `LazyDeoptMarker.markForDeopt` nulls `optimizedCode` and calls `updateCallMode`.
      No frame state is needed because no frame exists. Show the trace line from the
      worked example — `Dependency registered: total_of -> elements-kind:PACKED_DOUBLE`
      — and note it is printed *before* the deopt it eventually causes.
      `[t: tests/e2e/optimizing/speculation-deopt.test.ts > "dependency invalidation
      marks function for lazy deopt"]`
      `[t: tests/e2e/optimizing/speculation-deopt.test.ts > "two functions sharing same
      map dependency both get marked for lazy deopt"]`
- [ ] **§ when-the-jit-says-no** — Turn from bailing out to never starting.
      `CompileRejection` has three kinds and they are not severities:
      **`malformed`** means *the compiler is wrong* — `engine.ts:1809` prefixes it
      `internal compiler error:` and sets `disableOptimization = true`, permanently;
      **`unsupported`** means *this program shape is outside the backend's domain* —
      cooldown via `compileCooldownUntil`, retried later;
      **`speculation`** means *the feedback is not good enough yet* — same cooldown, but
      the retry may genuinely succeed once the caller warms up.
      Same struct, three futures. Show `WasmBackend.jitCompile` returning
      `{ code: null, rejection }` and the trace line the user sees for all three:
      `Wasm compilation skipped — cooldown`.
      `[t: tests/optimizing/backends/wasm/rejection.test.ts > "reports a missing return
      as a malformed graph, not an unsupported one"]`
      `[t: tests/optimizing/backends/wasm/rejection.test.ts > "separates a
      supported-but-unprofitable shape from a malformed one"]`
- [ ] **§ declines-that-were-reverted** — *What was tried and rejected.* Chapter 53
      established that copying an object graph per activation is the dominant cost of
      object code. The obvious response was to refuse to compile the functions that pay
      it: three marshalling-shaped tiering declines were added in 2026 — a loop with a
      global and a heap-passing call, a loopless leaf that allocates and returns a heap
      value, a function storing a fresh object into a global each iteration. They
      worked; they were reverted; and the tree now contains a `describe` block whose
      only purpose is to assert that **none of them fires any more**, because the inline
      numeric store and the LICM fix in chapter 53 removed the reason for them. What
      survives is one narrow decline, `hotBoxedReturnRejection`
      (`speculation("boxes a numeric return into a handle on a hot path")`). Land the
      general rule: **a decline is a bet that the cost is structural; when the cost
      turns out to be a missing optimization, the decline is the thing to delete** —
      and the way you keep that honest is a test that asserts a refusal is *absent*.
      `[t: tests/e2e/optimizing/tiering-declines.test.ts > "JITs a global-object mutation
      loop with no calls (LICM keeps it fast)"]`
      `[t: tests/e2e/optimizing/tiering-declines.test.ts > "JITs a local object mutation
      loop (no global, no call)"]`
      `[t: tests/e2e/optimizing/tiering-declines.test.ts > "JITs a loopless function that
      only returns strings (no alloc, no dynamic access)"]`
- [ ] **§ what-leaves** — Close Part VIII. The JIT's contract is not "fast"; it is
      "indistinguishable". Every mechanism in these four chapters — the refusals of
      chapter 51 and 52, the copy-back of chapter 53, the snapshot and the
      materializer here — exists so that `docs/example/stats-deopt.tera` prints the
      same two lines whether it deoptimizes or not. Forward-reference
      [Ch 55 § no-way-out]: Part IX takes the identical graph to a target that has
      **no `deopt` capability at all**, and every guard in this chapter has to become
      either a proof or a refusal.

## Honesty items

- `> **Broken.**` — `--stats` reports zero deopts for a wasm bailout.
  `Deoptimizer.recordDeoptReason` and `Deoptimizer.getStats`
  (`src/deopt/deoptimizer.ts:384-398`) are the source of the `deoptStats` block, but
  the wasm wrapper never routes through `Deoptimizer`: `createWrapper`'s local
  `recordWasmDeopt` calls `tracer.jitDeopt` and `policy.recordDeopt` directly.
  **Measured:** `node dist/cli.js --stats --trace-deopt docs/example/stats-deopt.tera`
  prints `"jit_deopts": 1` in `tracerStats` and `"deoptStats": { "total": 0,
  "reasons": {} }` in the same JSON object. Cost to fix: give the wrapper the
  `Deoptimizer` it already has an interpreter reference for, or move the counters onto
  the tracer — a handful of lines either way, but it has to pick one owner.
- `> **Unenforced.**` — the deopt snapshot's slot numbering is positional and shared
  by convention only. `emitDeoptSnapshot` (`codegen.ts:2151`) and `readDeoptSnapshot`
  (`codegen.ts:4101`) each keep their own `let slot = 0` and each call
  `visitDeoptSnapshotValues`. If a pass changed a frame state between the two — or if
  one of them ever skipped a value the other counted — the reader would silently
  attribute one node's value to another. Nothing asserts the counts match; there is
  not even a slot-count word written into the snapshot region. Cost: write
  `deoptSnapshotSlotCount(fs)` into slot 0 and check it on read, ~6 lines.
- `> **Unfinished.**` — `Deoptimizer.deoptimizeFromSignalState`
  (`src/deopt/deoptimizer.ts:275`) is declared `: never` and throws
  `Deoptimization without FrameState not fully supported yet`. Every wasm path avoids
  it by defaulting `frameStateId` to `-1` and taking the `resumeAt(new
  RegisterFrame(...))` branch instead, so the message is a statement about the class,
  not the backend. Cost to finish: nothing in the wasm tier needs it; the honest move
  is to delete it and let the `-1` path be the documented one.
- `> **Never runs.**` — `IC_FAILURE_REASONS` in `src/deopt/deoptimizer.ts:173` is a
  six-element `Set` that is constructed and never read anywhere in `src/`. Cost to
  remove: one deletion. Cost to use: it looks like the beginning of a policy that
  would treat inline-cache-shaped bailouts differently from arithmetic ones, which is
  a real design and not a cleanup.
- `> **Unfinished.**` — `optimizedCode._declinesEntry` is installed only when
  `analysis.isOsr`. A non-OSR optimized function has no way to say "do not enter me
  with these arguments" other than entering and bailing out — which is cheap, because
  `failingEntryGuard` runs before marshalling, but it still counts a deopt and
  therefore still walks the function toward `maxDeoptCount` and permanent
  `disableOptimization`. **[unpinned]**
- `> **Measured worse.**` — the three reverted marshalling declines; see
  § declines-that-were-reverted. They are the book's clearest example of a change that
  was complete, correct, tested, and removed because the numbers changed underneath it.

## Verify it yourself

```bash
node dist/cli.js --trace docs/example/stats-deopt.tera
node dist/cli.js --no-opt docs/example/stats-deopt.tera
node dist/cli.js --stats --trace-deopt docs/example/stats-deopt.tera 2>&1 | grep -A 4 '"deoptStats"'
npx vitest run --project unit tests/optimizing/backends/wasm/deopt-sites.test.ts
npx vitest run --project e2e tests/e2e/optimizing/tiering-declines.test.ts
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera 2>&1 | grep -i "cooldown\|Bailout"
```

## Tests that pin this

- `tests/e2e/optimizing/deopt.test.ts` > `"resumes a guarded method call without inventing a numeric callee"`
- `tests/e2e/optimizing/deopt.test.ts` > `"keeps a mirrored global correct across a deopt resume"`
- `tests/e2e/optimizing/deopt.test.ts` > `"keeps an optional call on a changing global consistent"`
- `tests/e2e/optimizing/deopt.test.ts` > `"does not throw when a failing return stub coincides with a dead optional chain"`
- `tests/e2e/optimizing/deopt.test.ts` > `"still short-circuits the optional chain to null when its result is used"`
- `tests/e2e/optimizing/deopt.test.ts` > `"resumes with the current loop accumulator after a late type miss"`
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"records one site per node that can bail out, and skips the ones that cannot"`
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"resolves a bailout to the single guard that shares its frame state and reason"`
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"returns every guard sharing a frame state when the reason does not single one out"`
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"falls back to matching on reason alone when the frame state is unknown"`
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"finds nothing in a graph whose arithmetic was proven not to overflow"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"CheckSmi frameState has correct compiledFunction, Deoptimizer restores pc from it"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"frameState locals are materialized into RegisterFrame by Deoptimizer"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"each CheckSmi guard has a distinct frameState ID matching frameStates array"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"Deoptimizer sets deoptCount and clears optimizedCode via handleDisableOptimization"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"reaching maxDeoptCount via speculation frameState disables optimization"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"disableOptimization triggers exactly at maxDeoptCount boundary"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"dependency invalidation marks function for lazy deopt"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"two functions sharing same map dependency both get marked for lazy deopt"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"frameState with stack values: Deoptimizer sets acc from last stack entry"`
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"deopt from CheckMap guard vs CheckSmi guard restore to different bytecodeOffsets"`
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"JITs a global-object mutation loop with no calls (LICM keeps it fast)"`
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"JITs a local object mutation loop (no global, no call)"`
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"JITs a loopless function that only returns strings (no alloc, no dynamic access)"`
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"optimizes a loop that mutates a global object and calls a heap-passing helper"`
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"optimizes a loopless leaf that allocates and returns a heap value"`
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"optimizes a function that stores a fresh object into a global each iteration"`
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"resumes deoptimized closure bodies with their captured environment"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"reports a missing return as a malformed graph, not an unsupported one"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"separates a supported-but-unprofitable shape from a malformed one"`
- `hotBoxedReturnRejection` — **[unpinned]** by name; reached only through
  `compileRejection` in the e2e tiering suites.
