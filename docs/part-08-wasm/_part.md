# Part VIII — The graph becomes WebAssembly

> **Status:** outline

**Length.** 2 pages

## What this part is

Part VII left one artifact: an optimized `CFGFunction` in canonical-phi SSA, its
nodes typed by `typeInferenceAnalysisId` and — for the tiers that need it — carrying
`frameState` edges. That graph is *target-neutral*. It does not know whether it is
about to become WebAssembly bytes handed to `WebAssembly.Instance`, or C, or x64
machine code in a PE file.

Part VIII is the first half of the answer: the graph is made legal for **one**
target, and then that target's code generator writes bytes. The other half — the
same graph taken to a native object file — is Part IX.

The badge convention used in this book: `⟨ I · B · J · N ⟩` names the four machines
(interpreter, baseline, JIT, native). A chapter or section heading lists only the
machines its content constrains.

## What this stage owes everything downstream

- **The pass list is the contract.** `targetLegalizationPipeline` in
  `src/optimizing/target/legalization.ts` is a single function returning an array of
  `TransformPass<CFGFunction>`. Both the JIT and the AOT driver call it. Every
  ordering fact this part establishes is inherited unchanged by Part IX.
- **`TargetModel.capabilities` is how a target says what it is.** Ten capability
  names in `src/optimizing/target/capabilities.ts` (`deopt`, `osr`, `tagged-values`,
  `terminating-throw`, `float-text`, `select-integer`, `select-float`,
  `generational-heap`, `utf16-text`, `timers`) decide which passes exist in the
  pipeline at all, which values may become an `IR_SELECT`, and whether frame states
  survive. Part IX reads the same table with four different answers.
- **Refusal is a first-class outcome.** `BackendLoweringError`
  (`src/optimizing/target/errors.ts`) and `CompileRejection`
  (`src/optimizing/target/jit.ts`, three kinds: `unsupported`, `speculation`,
  `malformed`) are the shape of "no". The JIT turns a refusal into a silent
  fallback to the interpreter; the AOT compiler turns the same refusal into a
  sentence the user reads. Part IX, chapter 56 is that second half.
- **The boundary cost model.** Chapter 53 measures where an object actually lives
  when JIT'd code runs. Everything Part XIII says about tier agreement rests on the
  copy-in / copy-back rule established here.

## The chapters

| Ch | Title | Tiers | Pages |
| --- | --- | --- | --- |
| 51 | Legalizing for a target | ⟨ J · N ⟩ | 14 |
| 52 | Emitting WebAssembly by hand | ⟨ J ⟩ | 16 |
| 53 | The boundary is the wall | ⟨ I · J ⟩ | 18 |
| 54 | Deoptimizing out of wasm, and when the JIT says no | ⟨ I · J ⟩ | 14 |

## Which of the four machines this part constrains

- **Interpreter ⟨ I ⟩** — constrained only where JIT'd code re-enters it. Chapter 53
  (`executeRuntimeStub` is a second interpreter over IR nodes) and chapter 54
  (`interpreter.resumeAt` receives a `RegisterFrame` rebuilt from wasm linear memory).
- **Baseline ⟨ B ⟩** — **not constrained by this part at all.** The baseline compiler
  emits JavaScript and never sees a `CFGFunction`. Chapter 51's pipeline and chapter
  52's encoder are invisible to it. It appears here only as the tier a JIT refusal
  falls back to.
- **JIT ⟨ J ⟩** — the whole subject. `wasmTarget`
  (`src/optimizing/backends/wasm/target.ts`) declares exactly four capabilities:
  `deopt`, `osr`, `tagged-values`, `float-text`.
- **Native ⟨ N ⟩** — constrained by chapter 51 only, and constrained *differently*:
  `cTarget` declares seven capabilities and none of them is `deopt` or
  `tagged-values`, so it gets three passes the JIT never runs and loses two the JIT
  always runs.

## What the running example can and cannot reach here

`docs/example/stats.tera` reaches this part twice: `Series.mean` is the loop chapter
52 rebuilds as nested wasm scopes, and `report`/`label` are what the trace shows
being compiled and installed. It does **not** reach:

- if-conversion or `IR_SELECT` (chapter 51 § select-twice-illegal uses `Math.sign`);
- a nine-operand runtime stub (chapter 53 § eight-operand-limit uses an inline `-e`
  program, because the spine has no call that wide);
- a deopt — that is `docs/example/stats-deopt.tera`, the whole of chapter 54.

## Verify it yourself

```bash
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera 2>&1 | grep -i "wasm\|stub"
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats-deopt.tera 2>&1 | grep -i "wasm\|DEOPT"
node dist/cli.js targets
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts
```
