# 55. The same graph, with no way out   ⟨ J · N ⟩

> **Status:** outline

**Thesis.** One middle end, two targets, and one options object: turning deopt off
turns loop unswitching *on*, turns allocation sinking off, and replaces
`Representation` — six kinds that convert into each other at run time — with
`AotScalar`, seven kinds that cannot.

**What arrived.** The `targetLegalizationPipeline` of [Ch 51 § the-second-pipeline]:
one function, one array of `TransformPass<CFGFunction>`, called by both drivers. And
from Part VII, a `CFGFunction` in canonical-phi SSA.

**What leaves.** A `ModuleIR` — many graphs, not one — that has been through
seventeen named module-level stages, each graph legalized for a named `AotBackend`,
every `frameState` nulled, every guard removed, and every value assigned an
`AotScalar` that a C type or a machine register class exists for. Chapter 56 is the
assignment; this chapter is the frame it happens in.

**New ideas.** *Whole-program compilation* (the unit is the module graph, not the
function); *a capability set as a target's self-description*; *the opcode set a
backend implements, derived rather than declared*; *scalar* as distinct from
*representation*.

**Length.** 12 pages

## Anchors

- `src/optimizing/optimizer.ts` — `Optimizer.compileStatic(compiledFn, request)` and
  `Optimizer.build(...)`, the *same* private method the JIT's `compile()` calls, with
  `feedback` passed as `null`. `StaticCompileRequest` (`classes`, `recoversThrows`,
  `gatheredArguments`, `options`). And the four-line `staticCompilerOptions`:

  ```ts
  export function staticCompilerOptions(
    base: CompilerOptions = compilerOptions("speed"),
  ): CompilerOptions {
    return { ...base, sinkAllocations: false, deoptimizes: false };
  }
  ```

  — src/optimizing/optimizer.ts:36-40

- `src/optimizing/options.ts` — `CompilerOptions` (19 fields), the four `OptLevel`
  presets, and the defaults `deoptimizes: true`, `sinkAllocations: true`,
  `scalarReplaceAggregates: true`, `splitLiveRanges: false`. Note `unswitchBudget`:
  0 / 0 / 48 / 96 across `none`/`baseline`/`speed`/`max`.
- `src/optimizing/pipeline.ts:110` — the one line that reads the flag:
  `const unswitchBudget = options.deoptimizes ? 0 : options.unswitchBudget;`
- `src/optimizing/target/model.ts` — `TargetModel` (`name`, `capabilities`,
  `speculation`, `abi`, `machineReprOf`), `MachineTargetModel` (adds `registers`,
  `integerClass`, `floatClass`, `locationOf`), `ScalarLocation { classId, width }`,
  `isMachineTarget`, `MACHINE_REPR` and `defaultMachineReprOf`.
- `src/optimizing/types/scalar.ts` — the seven `SCALAR_*` constants,
  `SCALAR_BY_KIND`, `SCALAR_WIDTHS`, `aotScalarOf`, `aotElementScalarOf`,
  `isStorableScalar`, `isNumericScalar`, `isReferenceScalar`, `carriesAbsence`,
  `scalarWidth`, `scalarStride`, `scalarAlignment`, `TEXT_STORAGE_BYTES = 1024`,
  `DEFAULT_TEXT_BUFFER_BYTES = 1 << 14`.
- `src/optimizing/types/representation.ts` — the six `REP_*`, and the whole of
  `abiRepresentationOf`: `handle → handle`, `bool → bool`, **everything else →
  tagged-number**. Three lines, six kinds into three.
- `src/optimizing/target/backend.ts` — `CodeBackend`, `AotBackend` (adds `outputs`,
  `platform`, `emits`, `symbolOf`, `createEmitter`, `link`), `isAotBackend`.
- `src/optimizing/target/capabilities.ts` — the same ten-name union chapter 51 met,
  read here with four different answers.
- `src/optimizing/backends/c/backend.ts` — `cBackend`: `outputs: ["assembly"]`,
  `platform: null`, `emits: cEmittedOpcodes()`. And
  `src/optimizing/backends/c/emit.ts:2588-2591`, `cEmittedOpcodes`, which builds the
  set by `Object.create(CFunctionEmitter.prototype)` and reading its own
  `handlers()` table.
- `src/optimizing/machine/select.ts:414-416` — the native equivalent:
  `emittedOpcodesOf(lowering)` = `new Set([...lowering.rules()].map(([opcode]) => opcode))`.
  The emits set is *literally the key set of the selection rules*.
- `src/optimizing/backends/x64/target.ts` — `x64Target(options)`, the `LOCATIONS` map
  (five entries: int32→GPR/4, float64→FPR/8, string→GPR/8, pointer→GPR/8, code→GPR/8 —
  **`SCALAR_TEXT` and `SCALAR_VOID` are absent**), the conditional `timers` capability
  (`io.now`/`io.wait`), `PLATFORM_IO` keyed by object format.
- `src/optimizing/backends/riscv64/target.ts` — two capabilities only:
  `capabilitySet("terminating-throw", "float-text")`.
- `src/optimizing/target/c-types.ts` — `C_BY_SCALAR` (six entries; no `SCALAR_TEXT`),
  `cTypeOf`, `prototypeOf`, `declarationOf`, `C_CODE = "tera_fn"`.
- `src/cli/targets.ts` — `aotBackends`, `architectureOf` (a portable backend is its own
  architecture), `architectures`, `emitsOf`, `linksItself`, `targetsReport`.
- `src/cli/compile.ts` — `resolveBackend` (architecture → candidates → portable-or-
  `choosePlatform`), `choosePlatform`, `requireHostToolchain`, `usesToolchain`,
  `selectEntry`, `mainSource`/`deliveryLines`, `warnSkipped` vs `noteLeftOut`,
  `aotCompilerOptions`.
- `src/optimizing/drivers/aot.ts` — `compileModule`, the `stage(name, run)` wrapper and
  its `ModuleTracer`, `AotProgram`, `AotDriverOptions`, `AotUndeclaredParameterError`,
  `AotLinkError`, `dropUnresolvedCallers`.

## Worked example

One `CheckSmi`, followed down both roads.

**On wasm** — `docs/example/stats-deopt.tera`, whose `total_of` the JIT compiles from
feedback. The guard survives with its frame state (`!fs`):

```
    v24 = CheckSmi v22 !fs
```

— produced by `node dist/cli.js --print-ir --filter total_of docs/example/stats-deopt.tera`

**On x64/C** — `docs/example/stats.tera`. No feedback exists, so almost no guard is
ever built; the ones that are come from `insertDeclaredParameterGuards` on a declared
`int` parameter. Under `--print-after-all` the *last* `CheckSmi` in the whole dump sits
in the graph printed after `#12 element-types`, and the very next dump — `#13
speculation-lowering [changed, nodes 32 -> 31 (-1)]` — no longer has it. Three lines
of `proveOrGeneric` did it:

```ts
  for (const node of passthrough) {
    editor.replaceAllUses(node, node.inputs[0]!);
    editor.remove(node);
    changed++;
  }
```

— src/optimizing/passes/speculation-lowering.ts:139-143

`CheckSmi` is in that `passthrough` list because `OPERATIONS[IR_CHECK_SMI]` declares
`SPECULATION_BASE_GUARD` (`src/optimizing/ir/operations.ts:846-851`), and the native
targets' strategy is `prove-or-generic`. Twenty-three passes later,
`#36 frame-state-elision` nulls what is left.

## Outline

- [ ] **§ one-build-two-callers** — Establish that `compileStatic` and `compile` are
      the same code. Show that `Optimizer.build` takes `feedback: FeedbackVector | null`
      and that `compile()` throws `"Cannot optimize without feedback"` while
      `compileStatic()` passes `null` deliberately. Everything downstream — `buildIR`,
      `runMiddleEnd`, `validateOptimizedGraph` — is shared. State the consequence up
      front: **the AOT compiler is not a second compiler, it is the same compiler with
      one field flipped.**
      **`> **New idea.** Whole-program compilation** — the JIT's unit of work is one
      hot function; the AOT driver's is a `ModuleIR`, every function in the program,
      because there is no interpreter left to hand the rest to.
- [ ] **§ three-fields-wide** — Read `staticCompilerOptions` line by line. Establish
      each of the three consequences separately and name where each is read:
      `sinkAllocations: false` → `allocationSinking` is spliced out of
      `middleEndPhases` (there is no deopt point to sink an allocation past);
      `deoptimizes: false` → `elideFrameStates` becomes a scythe instead of a no-op
      ([Ch 51 § frame-state-elision]);
      and — the surprising one — `deoptimizes: false` is what *turns loop unswitching
      on*: `const unswitchBudget = options.deoptimizes ? 0 : options.unswitchBudget;`
      Note the polarity carefully, because it reads backwards: the flag named after
      deoptimization gates a loop transform.
- [ ] **§ why-unswitching-needs-no-deopt** — *Why the obvious design fails.* The
      obvious reading is that unswitching is disabled on the JIT because it is
      expensive. It is not; it is disabled because loop unswitching clones a loop, and
      a cloned loop's `frameState` snapshots name bytecode offsets that now have two
      machine bodies. Establish the general rule: **a transform that duplicates control
      flow is cheap in a compiler with no way back and expensive in one that must be
      able to reconstruct an interpreter frame.** `[t: tests/optimizing/passes/unswitching.test.ts
      > "does nothing when the budget is zero"]`
- [ ] **§ a-target-describes-itself** — `TargetModel` in five fields. Put the four
      answers side by side as a table the reader can check with one command:
      wasm `deopt osr tagged-values float-text` (4, `deoptToInterpreter`);
      c/native64 `terminating-throw float-text select-integer select-float
      generational-heap utf16-text timers` (7, `proveOrGeneric`);
      x86-64 the same minus `select-float`, plus `timers` only when the platform has a
      clock and a blocking wait; riscv64 `terminating-throw float-text` (2). Establish
      that the *absence* of `tagged-values` is what makes this part necessary, and the
      absence of `deopt` is what makes chapter 56 necessary.
- [ ] **§ emits-is-derived-not-declared** — The nicest small idea in the target layer.
      `AotBackend.emits: ReadonlySet<string>` is the set of IR opcodes the backend
      actually has code for — and neither backend writes that set by hand.
      `cEmittedOpcodes()` constructs a prototype-only `CFunctionEmitter` purely to read
      its own `handlers()` table; `emittedOpcodesOf(lowering)` reads the keys of the
      machine lowering's `rules()`. Establish the invariant → enforcement → test chain:
      *invariant* — the legalizer's idea of what a backend emits cannot disagree with
      the backend; *enforcement* — the set is derived from the dispatch table, so
      disagreement is not expressible; *test* — the pass that consumes it,
      `legalizeOperations`, is pinned by
      `[t: tests/optimizing/passes/operation-legalization.test.ts > "does nothing when no
      target has named its opcodes"]`.
      Then note the one seam: `graph.emits` is assigned at
      `src/optimizing/drivers/aot.ts:769` and nowhere else — the fact chapter 51 met
      from the other side.
- [ ] **§ seven-scalars-against-six-representations** — The core type-system section.
      Lay `AotScalar` (`int32 float64 string text pointer code void`) beside
      `Representation` (`int32 float64 tagged-number handle tagged bool`) and establish
      the three real differences: (a) there is no `tagged` and no `bool` — a boolean is
      an `int32` (`SCALAR_BY_KIND` maps `TypeKind.Boolean → SCALAR_INT32`); (b) there
      are two *string* kinds, `SCALAR_STRING` (an 8-byte pointer to code units) and
      `SCALAR_TEXT` (1024 bytes of storage, the only scalar whose width is not a
      machine word), which chapter 59 is about; (c) there is `SCALAR_CODE`, a
      pointer-sized non-reference the collector must skip, which chapter 58 ends on.
      **`> **New idea.** Scalar vs representation** — a representation is a *form a
      value currently has* and can be converted between at run time; a scalar is a
      *storage class fixed at compile time*. The JIT converts; the native compiler
      refuses.
- [ ] **§ the-three-way-collapse** — `abiRepresentationOf` in three lines. Establish
      that on the JIT side the six representations collapse to three at any function
      or block boundary (`handle`, `bool`, `tagged-number`) — that is the wasm ABI
      chapter 52 described. Then the contrast: the native ABI does not collapse
      anything. `MachineTargetModel.locationOf(scalar)` answers a `{ classId, width }`
      per scalar, and the map has **five** entries on both x64 and riscv64. Show that
      `SCALAR_TEXT` is deliberately absent from both `LOCATIONS` and from
      `C_BY_SCALAR`: `locationOf` throws `no x64 location for text`, `cTypeOf` throws
      `no C type for scalar text`. A value of that scalar can live in a field and in a
      static buffer and nowhere else — never in a register, never in a parameter.
      Forward-reference [Ch 59 § three-storage-classes].
- [ ] **§ the-driver-resolves-a-backend** — Walk `tera compile`'s decision in the order
      `src/cli/compile.ts` makes it: architecture (`--target`, default
      `hostArchitecture()`) → candidate backends with that architecture → if none and
      no `--target`, the portable ones → `choosePlatform` (named `--platform`, else the
      host's OS, else the only one) → `usesToolchain` (does the backend write an
      executable itself, or must `cc` link it?) → `requireHostToolchain`. Show
      `targetsReport()` output and read the three rows against the three backends.
      Establish that `--emit source` is the honest escape hatch for a target that
      cannot link here, and that the refusal sentence names what it *can* emit.
- [ ] **§ seventeen-module-stages** — `compileModule`'s spine. Establish that before
      any function is lowered, seventeen named `stage(...)` calls run over the whole
      module, in this order: `uniquify-graph-names`, `name-callee-constants`,
      `module-captures`, `drop-function-bindings`, `error-surface`, `module-start`,
      `promote-run-once-globals`, `closure-conversion`, `promise-surface`,
      `argument-specialization`, `name-function-values`, `adopt-inferred-types`,
      `module-signatures`, `declare-global-variables` (only with a class table),
      `split-generators` (only with a class table), `number-text-bytes`,
      `module-inlining`. Each is a chapter or a section later in this part; the table
      here is the map. Note that `stage()` is *only* a tracing wrapper — with no
      `moduleTracer` it is `run()` — so these are names, not phases with a manager.
      `> **Unenforced.**` — nothing checks this order; unlike
      `targetLegalizationPipeline`, there is no `module-order.test.ts`.
- [ ] **§ then-per-function-then-again** — The rest of `compileModule`, which is not a
      straight line and should be shown as one figure: `lower(unit)` runs the
      legalization pipeline per graph; `splitCoroutines` then *adds* graphs which are
      lowered afterwards; `inlineLoweredCalls` runs over the lowered set;
      `boxEscapingStrings` runs after that, needing `callReachability`;
      `summarizeStringEscapes` and `summarizeWideText` are whole-module summaries
      stamped back onto every graph, invalidating `aotLegalityAnalysisId`; only then
      does `createEmitter(...).emit()` run. Establish why the shape is this way: three
      of these facts (does a callee re-enter me? does any function let wide text
      escape? does a string outlive a call?) are *whole-program* properties, and a
      per-function compiler cannot answer them.
- [ ] **§ dropping-the-callers-of-what-was-dropped** — `dropUnresolvedCallers`: a
      worklist that removes any compiled function referencing a symbol nothing defines,
      then any function calling *that*, until a fixpoint. Establish that this is why a
      single refusal cascades, and that the cascade's reason string is different
      (`calls unavailable function ${name}`) from the original — the pattern
      `docs/CONVENTIONS.md` rule 5 requires both messages for. Hand over to chapter 56.

## Honesty items

- `> **Unenforced.**` — the seventeen `stage(...)` names in
  `src/optimizing/drivers/aot.ts:689-797` have no ordering test. `closure-conversion`
  must precede `argument-specialization` (the specializer reads `carriesCapture`, which
  closure conversion stamps) and `module-captures` must precede
  `promote-run-once-globals`, but nothing in `src/` or `tests/` asserts either. Cost to
  finish: the same `after: [...]` field on a stage descriptor that [Ch 51 §
  order-as-executable-claim] costs for passes, or — much cheaper — a
  `tests/optimizing/drivers/module-order.test.ts` mirroring
  `tests/optimizing/pipeline-order.test.ts`.
- `> **Unfinished.**` — `TargetModel.machineReprOf` is a member of the interface, and
  all four targets set it to the same `defaultMachineReprOf`. No target overrides it,
  and the only caller is the machine layer. Cost to finish: nothing is missing, but the
  indirection is currently unpaid for and the chapter should say so once.
- `> **Never runs.**` — `CompilerOptions.splitLiveRanges` defaults to `false` and
  `staticCompilerOptions` does not change it, so the live-range splitter is off on
  every AOT build. This is deliberate and measured; the numbers are Part X's
  ([Ch 67]), and this chapter should only note that the AOT path does not turn it on.
- `> **Unfinished.**` — `AotBackend.emits` is a `ReadonlySet<string>` of raw opcode
  names with no relation to the `OPERATIONS` table that defines them. A backend can
  claim to emit an opcode that does not exist and nothing notices. Cost: type it as
  `ReadonlySet<IrOpcode>` and have `OPERATIONS`' key type be the source of truth — a
  one-file change that the `Object.create(...prototype)` trick in `cEmittedOpcodes`
  would survive unchanged.

## Verify it yourself

```bash
node dist/cli.js targets
node dist/cli.js --print-ir --filter total_of docs/example/stats-deopt.tera 2>&1 | grep "Check"
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c --print-after-all > /tmp/stats-passes.txt
grep -n "CheckSmi" /tmp/stats-passes.txt | tail -1
grep -n "speculation-lowering" /tmp/stats-passes.txt | tail -1
node dist/cli.js compile docs/example/stats.tera --emit source --target riscv64 -o /tmp/stats-rv
```

## Tests that pin this

- `tests/optimizing/backends/c/emit.test.ts` > `"bails on speculative guards that lowering must remove first"`
- `tests/optimizing/backends/c/emit.test.ts` > `"takes the parameter types from the declared signature"`
- `tests/optimizing/backends/c/emit.test.ts` > `"reports one scalar per declared parameter, in order"`
- `tests/optimizing/backends/c/emit.test.ts` > `"takes the return scalar from the declared return type"`
- `tests/optimizing/backends/c/emit.test.ts` > `"names the symbol after the graph"`
- `tests/optimizing/passes/unswitching.test.ts` > `"clones the loop and tests the invariant condition once, in the preheader"`
- `tests/optimizing/passes/unswitching.test.ts` > `"does nothing when the budget is zero"`
- `tests/optimizing/passes/unswitching.test.ts` > `"keeps the graph in SSA form"`
- `tests/optimizing/passes/operation-legalization.test.ts` > `"does nothing when no target has named its opcodes"`
- `tests/e2e/optimizing/aot/unswitching.test.ts` > `"answers what the guarded loop answered, through C"`
- `staticCompilerOptions` and `abiRepresentationOf` — **[unpinned]**. Neither symbol is
  named by any test under `tests/`; both are exercised only transitively.
