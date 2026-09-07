# 36. The baseline compiler   ⟨I · B · J⟩

> **Status:** outline

**Thesis.** A compiler whose output is a JavaScript source string, whose frame is
register-compatible with the interpreter's, and whose hottest trick is adding two tagged
values without untagging them.

**What arrived.** From [Ch 35 § callmode], a `RegisterCompiledFunction` whose
`invocationCount` has reached `baselineThreshold` (8 by default) and which
`requiresInterpreterOnly` did not veto.

**What leaves.** `compiledFn.baselineCode` — a JavaScript function with `_isBaseline`
set and up to four fast entry points `_call0` … `_call3` attached, closed over one
`BaselineRuntime` instance; and `callMode` updated to `CALL_BASELINE`. The vector it
writes into is the same one [Ch 33] described, so the JIT that reads it later cannot tell
which tier filled it — except for branch bias, which only this tier records.

**New ideas.** *Template JIT / baseline compiler* — why a compiler that does no analysis at
all is worth writing; *tagged arithmetic* (a first-principles derivation from
`CODE_SMI === 0`); *goto in a language without goto*; *negative zero* as an IEEE-754
value distinct from zero, and why it forces multiplication off the fast path;
*conservative root* — a value the collector must be told about because the host language
hides it.

**Length.** 16 pages

## Anchors

- `src/optimizing/baseline/compiler.ts`
  - `BaselineCompiler.compile` — the five refusals, `new Function(...)`, the `_call0` …
    `_call3` wrappers, `_isBaseline`.
  - `BaselineCompiler.generateBody` — the prologue (`var acc,t,t2,t3,t4,osr,sp=0`, the
    register array, the argument copy, `$.cf.lastExecutionTime`, the optional `_ouv`/`_ce`
    closure pair), `$.enter(...)`, `L:while(1){switch(pc){`, and the `finally{$.leave();}`.
  - `BaselineCompiler.emitOp` — one `case` per opcode; the arithmetic cases are the
    chapter's centrepiece.
  - `safepointBefore` — the emitted back-edge counter.
  - `returnExpression` and `declaredInt32Return` (`src/runtime/declared-int.ts`).
  - Module constants `MAX_BASELINE_INSTRUCTIONS = 1000`, `SCRATCH_LOCALS`,
    `ROOTED_LOCALS`, `TAGGED_SMI_MIN`, `TAGGED_SMI_MAX`, `BASELINE_THRESHOLD`.
- `src/core/value/index.ts` — `CODE_SMI = 0`, `TAG_MASK = 0xf`, `TAG_SHIFT_MULT`,
  `SMI_MAX = 0x3fffffff`, `SMI_MIN = -0x40000000`. Everything in § tagged-arithmetic is a
  consequence of these five constants ([Ch 22 § four-bits-inside-a-double]).
- `src/optimizing/baseline/runtime.ts` — `BaselineRuntime`, the entire surface behind `$`:
  - constants `u` / `n` / `t` / `f`; the `fv` getter; `MAX_CALL_DEPTH = 1000`.
  - constants and globals: `c` / `wc` with `constValueCache` and `pinHeapSlot`.
  - globals: `lg` / `sg` with `globalCaches` and the `cell.writeCount` version check.
  - properties: `gp` / `sp` with per-slot `loadCaches` / `storeCaches` in front of the
    shared `icManager`, the accessor early-outs, and the `offset < 10` slot/overflow split.
  - elements: `gi` / `si`.
  - arithmetic: `add`, `sub`, `mul`, `div`, `mod`, `eq`, `neq`, `cmp`, `not`, `neg`, and
    the bitwise family; `_recordBinaryFb` and `rfb`.
  - feedback: `branch` — the only writer of `recordBranch` in the tree.
  - roots: `enter`, `leave`, and `interp.baselineFrames`.
  - back edge: `backEdge`.
  - calls: `invokeCall`, `invokeCall0` / `invokeCall1` / `invokeCall2`,
    `fastOptimizedCall`, `fastBaselineCall`, `callMethod`, `rcn`, `hasMethodCalls`,
    `hasConstructorCalls`, `invokeIntrinsic`.
  - closures: `closure`, `loadUpvalue`, `storeUpvalue`.
- `src/gc/roots.ts` — `visitFrameRoots` and its `frame.readLocals` branch; the
  `interpreter.baselineFrames` iteration. This is the *other* half of `$.enter`.
- `src/bytecode/register/interpreter/index.ts` — `baselineFrames`, and `execute`'s
  `baselineThreshold` branch that installs the result.
- `src/runtime/tiering/defaults.ts` — `BACK_EDGES_PER_SAFEPOINT = 1024`,
  `DEFAULT_TIERING_POLICY.baselineThreshold = 8`.
- `src/bytecode/register/ops/bytecode.ts` — `BaselineCode`, `_call0` … `_call3`,
  `_isBaseline`, `getICKey`.

## Worked example

`docs/example/stats.tera`, function `Series.mean` — 43 bytecodes, one loop, one property
chain, one indexed load.

```
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --always-opt --trace-opt docs/example/stats.tera
```

The first gives the bytecode `generateBody` walks; the second confirms it compiles, with
the reason line `[JIT] Compiling "mean": Baseline compiled: 43 bytecodes`.

> The CLI has no flag that prints the generated JavaScript. The chapter's central listing —
> the body for `mean`, with the `$.enter(r,function(){return[acc,t,t2,t3,t4,osr];})` line
> highlighted — is reconstructed by hand from `generateBody`'s emission rules, each line
> attributed to the `emitOp` case that produced it, and the *shape* is pinned by
> `tests/optimizing/baseline/compiler.test.ts > "generates switch/case dispatch loop"` and
> its three siblings, which assert on `generateBody`'s string directly. The
> deleted-closure half of the demonstration — that removing the `readLocals` closure
> reintroduces a use-after-free — is pinned by
> `tests/e2e/optimizing/gc-roots.test.ts > "keeps an object held only in a baseline register alive across allocation"`.

## Outline

- [ ] **§ why-emit-source** *(Why the obvious design fails)* — Establish the design a
  reader would reach for: a second interpreter, or straight to the optimizing compiler.
  Then the constraints that rule both out. The engine is hosted; its fastest available
  instruction selector is the host's own JIT; and the *only* portable way to reach it is
  `new Function`. Establish what that buys (register allocation, inlining and instruction
  selection for free) and what it costs (no control over the result, a `try`/`catch`
  around compilation because the string can be rejected at parse time, and no way to
  inspect the machine code the chapter would like to show).
- [ ] **§ goto-in-a-language-without-goto** — Establish the dispatch skeleton:
  `L:while(1){switch(pc){ case 0: … case 1: … }}`, in which every bytecode index is a
  `case` label and every jump is `pc = t; continue L;`. Establish why fall-through between
  cases is *correct* here — consecutive bytecodes fall through in the interpreter too —
  and why `default: return $.u` is the right terminator. Establish that this makes the
  generated function's control flow an exact image of the bytecode's, which is what makes
  [Ch 37 § the-baseline-side] able to re-enter it.
- [ ] **§ a-frame-the-interpreter-would-recognise** — Establish the register-compatibility
  invariant: `var r = new Array(nRegs)`, filled with `$.u`, then arguments copied into
  `r[0..nParams)`. Same indices, same tagging, same undefined-fill as `RegisterFrame`. This
  is the invariant that lets `$.backEdge` hand `r` straight to `enterOsr` as a register
  reader, and lets `visitFrameRoots` treat a baseline frame and an interpreter frame with
  the same code. Invariant → enforcement → test: nothing enforces it (the two frame layouts
  are built by unrelated files); the tests that would catch a divergence are the OSR and
  GC-roots e2e suites.
- [ ] **§ tagged-arithmetic** — `> **New idea.**` primer deriving the trick from
  [Ch 22]'s tag layout. A tagged Smi is `payload × 16` with the low four bits zero, because
  `CODE_SMI` is 0. Therefore `taggedA + taggedB === (payloadA + payloadB) × 16` — the sum of
  two tagged Smis *is* the tagged sum, with no untag and no retag. Show the emitted ADD:
  a tag test on both operands (`(acc&15)===0 && (t&15)===0`), the raw add, a range check
  against `TAGGED_SMI_MIN`/`TAGGED_SMI_MAX`, and `$.add(...)` otherwise. Establish that
  subtraction is identical and that comparison is even cheaper — `acc<t` on tagged values
  is `payloadA<payloadB` scaled by a positive constant, so the emitted `LT` needs no
  arithmetic at all.
- [ ] **§ why-multiplication-cannot** — Establish the exception. `(a×16)×(b×16)` is
  `a×b×256`, not `a×b×16`, so MUL must divide both operands by 16 first — and then the
  result is an *untagged* integer that must be retagged, which reintroduces the range
  check and one more. `> **New idea.**` primer on negative zero: IEEE-754 has two zeros,
  `-1 × 0` is `-0`, and `-0 × 16` is `-0`, which as a tagged value is bit-identical to
  `+0`. Show the guard the emitted code carries — `(t2!==0||1/t2>0)` — and establish it as
  the general rule: a fast path is only allowed to skip work it can prove is redundant, and
  the sign of zero is not redundant.
- [ ] **§ the-five-refusals** — Establish that `compile` declines rather than mis-compiles,
  and enumerate: an empty instruction list; more than `MAX_BASELINE_INSTRUCTIONS` (1000);
  any of `ROP_TRY_START` / `ROP_TRY_END` / `ROP_THROW`; any of `ROP_CALL_SPREAD` /
  `ROP_REST_ARGS` / `ROP_SPREAD_ARRAY` / `ROP_DEFINE_ACCESSOR` /
  `ROP_ASSERT_CLASS_CONTRACTS`; and an unhandled opcode, which makes `emitOp` return
  `null` and propagates out of `generateBody`. Add the sixth that is not a refusal but a
  catch: `new Function` throwing, which is logged and returns `null`. Establish the design
  rule this shares with [Ch 56 § refusing-well]: returning `null` costs one interpreted
  execution; guessing costs correctness.
- [ ] **§ the-runtime-surface** — Establish `$` as the whole non-inline half of the
  compiler. Every emitted line is either a tagged-value operation the host can do directly
  or a one-character call into `BaselineRuntime`. Group the surface: constants and globals;
  properties and elements; arithmetic; calls; closures; frame management. Establish the
  naming convention (`gp`, `sp`, `gi`, `si`, `lg`, `sg`, `c`, `u`/`n`/`t`/`f`) as a
  deliberate code-size choice — every one of these appears once per emitted instruction, in
  a string the host must parse.
- [ ] **§ three-caches-in-front-of-a-cache** — Establish `BaselineRuntime`'s own caching,
  which sits *before* the shared `InlineCacheManager` of [Ch 34]:
  `constValueCache` (index → tagged value, plus `pinHeapSlot` so the collector keeps it);
  `globalCaches` (index → `{cell, writeCount, value}`, validated by comparing the cell's
  `writeCount`, and *invalidated by hand* in `sg`); and `loadCaches` / `storeCaches`
  (feedback slot → `{hiddenClassId, version, offset}`, validated by the same three checks
  `FieldHandler.matches` makes). Establish why the last one exists at all — the shared IC
  is a map lookup plus a virtual call, and this is an array index — and the cost: a fourth
  independent statement of the map-version protocol, which nothing keeps in step with the
  other three.
- [ ] **§ where-feedback-comes-from-here** — Establish that the baseline is a full feedback
  citizen: `gp`/`sp` call `recordPropertyAccess`, `gi`/`si` call `recordIndexedAccess`,
  `_recordBinaryFb` calls `recordBinaryOp`, `invokeCall` calls `recordCallTarget`, and
  `branch` calls `recordBranch` — the last of which nothing else in the tree ever calls.
  Establish the consequence for [Ch 46 § loop-shape] and `hotSuccessorOf`: branch bias
  exists only for functions that spent time in baseline, so `--always-opt`'s
  `baselineThreshold: 2` is not a rounding choice, it is what makes bias exist at all.
  Then the counter-fact: `invokeCall0` / `1` / `2` try `fastOptimizedCall` and
  `fastBaselineCall` *first*, and both of those return without recording anything — so the
  hotter a call site gets, the less feedback it produces.
- [ ] **§ the-fast-call-path-is-also-a-tier-up-site** — Establish `fastBaselineCall`'s
  double duty. It refuses on a constructor, a closure, a method-calling callee, or a callee
  that already has optimized code; then it *increments the callee's `invocationCount`* and,
  on exactly hitting `jitThreshold`, calls `jitEngine.optimizeFunction` — so a function can
  be promoted to the JIT by a caller it never returns to. Establish the equality test
  (`=== jitThreshold`, not `>=`) and what it implies: exactly one attempt, ever, from this
  path.
- [ ] **§ two-things-generated-code-must-do-by-hand** — Establish the chapter's closing
  invariant pair, both of which the interpreter gets free.
  1. *Roots.* An interpreter frame is a `RegisterFrame` object the collector can walk. A
     baseline frame's registers live in a plain JS array and its accumulator lives in a
     `var` the collector cannot see, so `generateBody` emits
     `$.enter(r,function(){return[acc,t,t2,t3,t4,osr];})` — the array is passed by
     reference, and the six scratch locals are passed as a *closure that reads them at
     collection time*. `visitFrameRoots` calls it. Delete the closure and every value that
     lives only in `acc` between two allocations is swept.
  2. *Safepoints.* An interpreter reaches `onBackEdge` on every back jump; generated code
     must count its own, so `safepointBefore` emits `if(++sp>=1024){sp=0; osr=$.backEdge(...);
     if(osr!==null)return osr;}` before every backward jump, and only before backward ones.
  Establish the general rule: leaving the host's abstraction gets you speed and takes away
  everything the abstraction was doing for you, item by item.

## Honesty items

- > **Dead.** `BaselineCompiler.emitOp` has cases for `ROP_REST_ARGS`,
  `ROP_SPREAD_ARRAY` and `ROP_CALL_SPREAD` (`src/optimizing/baseline/compiler.ts`) that
  emit `$.restArgs`, `$.spreadArray` and `$.callSpread`. `compile` refuses any function
  containing those three opcodes before `generateBody` runs, so none of the three cases can
  execute, and the three `BaselineRuntime` methods behind them are unreachable from
  baseline code. Either drop them from the refusal list or delete the emitters.
- > **Dead.** `BaselineCode._call3` is created in `compile` and returned by
  `fastBaselineCall(callee, 3)`, but `fastBaselineCall`'s only callers are `invokeCall0`,
  `invokeCall1` and `invokeCall2`. A three-argument `ROP_CALL` falls through to the generic
  `$.invokeCall(...)` array path. The `case 3:` arm and the `_call3` wrapper never run.
  Closing the gap is an `invokeCall3` in the runtime plus one more branch in `emitOp`'s
  `ROP_CALL` case.
- > **Unfinished.** `BaselineRuntime.gp` reads a cached field with
  `typeof slotValue === "number" ? slotValue : undefined` and answers `$.u` when the stored
  value is not a JS number. Tagged values are numbers, so this is a filter on the
  representation rather than on the program — but it silently substitutes `undefined`
  rather than falling back to the slow path, which is the wrong failure mode for a cache.
  [unpinned]
- > **Unenforced.** The register-compatibility invariant of § a-frame-the-interpreter-would-recognise
  is stated nowhere and checked nowhere. `RegisterFrame` (in
  `src/bytecode/register/interpreter/index.ts`) and `generateBody`'s prologue build the
  same layout in two unrelated files; a change to one is caught only indirectly, by the OSR
  and GC-roots e2e suites failing.
- > **Unenforced.** `ROOTED_LOCALS` is `["acc", ...SCRATCH_LOCALS]`, and the emitted
  closure returns exactly those names. Nothing checks that every `var` `generateBody`
  declares appears in `ROOTED_LOCALS`; a new scratch temporary added to the prologue and
  forgotten here would be an unrooted slot, which is precisely the bug § two-things
  describes. The e2e roots tests would catch it only if a value happened to live in that
  temporary across an allocation.

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --always-opt --trace-opt docs/example/stats.tera
node dist/cli.js --baseline-threshold 1 --opt-threshold 2 --trace-opt docs/example/stats-poly.tera
npx vitest run --project unit tests/optimizing/baseline/compiler.test.ts
npx vitest run --project unit tests/optimizing/baseline/runtime.test.ts
npx vitest run --project e2e tests/e2e/optimizing/gc-roots.test.ts
```

## Tests that pin this

- `tests/optimizing/baseline/compiler.test.ts > "generates switch/case dispatch loop"`
- `tests/optimizing/baseline/compiler.test.ts > "emits jump as pc assignment + continue"`
- `tests/optimizing/baseline/compiler.test.ts > "emits conditional branch for JUMP_IF_FALSE"`
- `tests/optimizing/baseline/compiler.test.ts > "emits SMI fast path for ADD with tag check"`
- `tests/optimizing/baseline/compiler.test.ts > "emits return acc for ROP_RETURN"`
- `tests/optimizing/baseline/compiler.test.ts > "rejects empty instructions"`
- `tests/optimizing/baseline/compiler.test.ts > "rejects functions with > 1000 instructions"`
- `tests/optimizing/baseline/compiler.test.ts > "rejects functions containing try/throw"`
- `tests/optimizing/baseline/compiler.test.ts > "rejects functions containing spread/rest/defineAccessor"`
- `tests/optimizing/baseline/compiler.test.ts > "compiles functions containing ROP_CALL_METHOD"`
- `tests/optimizing/baseline/compiler.test.ts > "compiles closures with upvalues"`
- `tests/optimizing/baseline/compiler.test.ts > "compiles closure bodies that require a closure environment"`
- `tests/optimizing/baseline/compiler.test.ts > "compiles simple return-constant function and returns callable with _isBaseline flag"`
- `tests/optimizing/baseline/compiler.test.ts > "creates fast-call variants (_call0, _call1, _call2, _call3)"` —
  the only exercise `_call3` gets, and the reason its honesty item is fact.
- `tests/optimizing/baseline/compiler.test.ts > "wraps the answer of a call in tail position, which never reaches ROP_RETURN"`
- `tests/optimizing/baseline/runtime.test.ts > "smi + smi → smi when result fits"`
- `tests/optimizing/baseline/runtime.test.ts > "smi + smi → double on overflow"`
- `tests/optimizing/baseline/runtime.test.ts > "mul: smi * smi → smi when fits"`
- `tests/optimizing/baseline/runtime.test.ts > "c() caches constants — same index returns same tagged value"`
- `tests/optimizing/baseline/runtime.test.ts > "wraps integer constants beyond the smi range without truncating"`
- `tests/optimizing/baseline/runtime.test.ts > "records a taken branch as taken"`
- `tests/optimizing/baseline/runtime.test.ts > "reports an evenly split branch as mixed"`
- `tests/optimizing/baseline/runtime.test.ts > "eq: null === undefined → false (strict equality does not conflate them)"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps an object held only in a baseline register alive across allocation"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps an array held only in a baseline register alive across allocation"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps a string held only in a baseline register alive across allocation"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps a nested object reachable after a nested allocation"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the slab bounded once the loop runs in baseline-compiled code"`
