# Part VII — The graph is optimized

> **Status:** outline

**Length.** 2 pages

## What this stage owes everything downstream

- **One middle end, two machines.** Part VI handed over a `CFGFunction` in canonical-phi
  SSA. Everything in Part VII runs on that one graph, and the *same* thirty-three-to-
  thirty-four-pass pipeline (`src/optimizing/pipeline.ts` → `middleEndPhases`) runs whether
  the graph is on its way to WebAssembly or to an ELF/PE binary. Part VIII and Part IX
  differ in what they do *after* this, not during it.
- **The one option that splits them.** `CompilerOptions.deoptimizes` is `true` for the JIT
  and `false` for AOT (`staticCompilerOptions` in `src/optimizing/optimizer.ts` sets
  `sinkAllocations: false, deoptimizes: false`). Two passes read it: `loop-unswitching`
  (budget forced to `0` when `deoptimizes`, so the JIT never unswitches) and
  `allocation-sinking` (dropped from the pipeline entirely for AOT). Everything else is
  literally the same code on the same graph.
- **Frame states are the currency.** A pass that moves, deletes or merges a value must keep
  every frame state that names it answerable — otherwise a JIT bailout lands in an
  interpreter frame that has a hole in it. Two passes are defined by this: LICM refuses to
  hoist anything carrying a frame state, and guard peeling *requires* one.
- **What leaves this part.** The same `CFGFunction`, smaller and more specific: generic
  arithmetic specialised, redundant loads and stores gone, guards moved out of loops where
  they could be proved once, constants folded, unreachable blocks removed, and (for the
  wasm target only) every surviving node stamped with a representation. Part VIII lowers it
  to wasm; Part IX lowers it to machine code.
- **What does not leave.** Nothing here decides *whether* a function compiles. Legality is
  Part IX's job ([Ch 56 § refusing-well]); representation *selection* is a legalization
  pass, not a middle-end one ([Ch 48 § repr-selection]).

## Tiers this part constrains

| Chapter | ⟨I · B · J · N⟩ | Why |
| --- | --- | --- |
| 41 The pass manager | ⟨J · N⟩ | one `PassManager`, both compiling tiers |
| 42 The analyses everything stands on | ⟨J · N⟩ | shared analysis cache |
| 43 SCCP | ⟨J · N⟩ | same pass, both pipelines |
| 44 GVN-PRE | ⟨J · N⟩ | same pass, both pipelines |
| 45 Memory, and an object that stops existing | ⟨I · J · N⟩ | scalar replacement is shared; the materializer rebuilds an *interpreter* object |
| 46 Loops, and the optimization that cannot fire | ⟨J · N⟩ | unswitching is AOT-only by construction; BCE fires in neither |
| 47 Simplification, dead code, wrong identities | ⟨J · N⟩ | same passes, both pipelines |
| 48 Types and representations | ⟨J · N⟩ type narrowing, ⟨J⟩ representation selection | reps are gated on the `tagged-values` capability, which only wasm has |
| 49 Speculative types are not facts | ⟨J · N⟩ | the whole chapter is the difference between the two |
| 50 Inlining and tail calls | ⟨J · N⟩ | *two* inliners: `builder/inline.ts` (JIT, feedback-driven) and `passes/inlining.ts` (AOT, module-level) |

The interpreter and the baseline compiler appear in this part only as destinations: the
interpreter is where a JIT bailout lands (ch 45), and neither ever sees a `CFGFunction`.

## The chapters

- **[41. The pass manager](41-the-pass-manager.md)** — what a pass declares, and the one
  boolean everything hangs on.
- **[42. The analyses everything stands on](42-the-analyses-everything-stands-on.md)** —
  six analyses, one string key, and the generic machinery under them.
- **[43. SCCP](43-sccp.md)** — constants and reachability, solved together.
- **[44. GVN-PRE](44-gvn-pre.md)** — value numbering, then partial redundancy and the edge
  you have to split first.
- **[45. Memory: what a load can be told, and an object that stops existing](45-memory-what-a-load-can-be-told.md)**
  — one dataflow driver, three passes, and a promise to rebuild what you deleted.
- **[46. Loops, and the Optimization That Cannot Fire](46-loops-and-the-optimization-that-cannot-fire.md)**
  — LICM, peeling, unswitching, range analysis, and bounds-check elimination that never
  removes a bounds check.
- **[47. Simplification, dead code, and the identities that are wrong](47-simplification-dead-code-and-the-identities-that.md)**
  — the textbook identity list, mostly as a list of bugs.
- **[48. Types and representations in the middle end](48-types-and-representations-in-the-middle-end.md)**
  — narrowing by proof, and one scalar out of the function.
- **[49. Speculative Types Are Not Facts](49-speculative-types-are-not-facts.md)** — the
  sharpest instance of the book's hinge ([Ch 55 § no-way-out]).
- **[50. Inlining and tail calls](50-inlining-and-tail-calls.md)** — a cost model, a splice,
  and a nested frame-state chain.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c \
  | grep -c '^\*\*\* IR after'
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c \
  | grep '^\*\*\* IR after' | grep -c '\[changed'
node dist/cli.js docs/example/stats.tera
npx vitest run --project unit tests/optimizing/pipeline.test.ts tests/optimizing/pipeline-order.test.ts
```
