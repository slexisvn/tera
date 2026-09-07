# 79. How we know any of this is true   ⟨**I** · **B** · **J** · **N**⟩

> **Status:** outline

**Thesis.** For a speculative multi-tier engine the only practical correctness argument is
differential: run the same program every way and demand the same answer — and the harness
must be defended against the ways that test can pass vacuously.

**What arrived.** From [Ch 78]: the measured limit of static checking. Three verifiers that
prove a graph is *well-formed* — structural invariants between passes, frame states before
codegen, machine invariants at six points in `compileMachineFunction` — plus the enumerated
places where none of them runs: no AOT build calls `validateOptimizedGraph`, nothing
re-proves reaching definitions after register allocation, and the register bytecode has no
verifier at all. A well-formed graph that means the wrong thing is still wrong, and this
chapter is the evidence that covers that gap.

**What leaves.** The demand itself, stated as an executable rule: *four machines, one
answer*, checked by `differential` over seven tiering presets, by `peAgrees`/`runElf` over
produced binaries, and by the AOT agreement oracle in `aot-agreement.ts`. Chapter 80 takes
that demand and shows the seven mechanisms — frame states, deoptimization, dependency
invalidation, speculative-type taint, OSR, one-answer-per-value-kind and this harness — as
one design with one purpose.

**New ideas.**

- `> **New idea.** Differential testing.` You cannot write down the expected answer for
  every program, but you can insist that two implementations agree. One of them is
  designated the *oracle* — here, the interpreter with tier-up thresholds pushed to
  10¹² — and everything else is compared against it. The bug you find is "these two
  disagree", which does not say which one is wrong.
- `> **New idea.** A vacuous pass.` A test that cannot fail. If two tiers are compared on
  something neither of them produces, the assertion is `undefined === undefined` and the
  suite is green for a broken engine. Most of this chapter is about the specific ways this
  harness could be vacuous and what stops each one.
- Oracle, tiering thresholds, OSR, deoptimization, arenas and the C ABI are all reused —
  [Ch 77 § choosing-an-oracle], [Ch 35 § when-to-tier-up], [Ch 53 § osr],
  [Ch 68 § the-arena], [Ch 66 § calling-conventions].

**Length.** 16 pages

## Anchors

- `vitest.config.ts` (41 lines) — the whole projects definition. `EVERYTHING`,
  `END_TO_END`, `WITHOUT_END_TO_END`, the `shared` object
  (`testTimeout: 60000`, `isolate: false`, `globalSetup`,
  `maxWorkers: process.env.TERA_TEST_WORKERS ?? "40%"`), the `Tier` interface, the `TIERS`
  table of four rows, and `projects: TIERS.map(...)` which sets
  `env: { TERA_NATIVE: level }` per project. Four projects from one four-row table; the
  only difference between `unit` and `e2e` is an include/exclude on one path, and the only
  difference between `e2e`, `native` and `full` is the value of one environment variable.
- `tests/helpers/native-tier.ts` (15 lines, all of it) — `TIERS = { off: 0, native: 1,
  full: 2 }`, `NATIVE_TIER_VARIABLE = "TERA_NATIVE"`, `requested()`, `nativeTier`,
  `runsOwnBackends` (`>= native`), `runsToolchain` (`>= full`). Every gated test in the
  tree reads one of the last two booleans.
- `tests/helpers/global-setup.ts` (14 lines) — `project.provide("cCompiler", tier ===
  "full" ? detectCompiler() : null)`, and the `declare module "vitest"` block that types
  `ProvidedContext`. The C compiler is detected once per project, not once per file.
- `tests/helpers/tiers.ts` (92 lines) — `src`, the `TIERS` table of seven presets
  (`oracle`, `baseline`, `jit`, `osr`, `eager`, `baselineOsr`, `production`), `engineFor`,
  the seven named engine constructors, `DiffOpts`, `PRINTS_INSTEAD_OF_ANSWERING`,
  `answersNothingVisible`, `differential` (defaults to
  `tiers: ["baseline", "jit", "osr"]`), `writeModuleProject`, `cleanModuleProjects`,
  `differentialModules`, `tierUp`. Read the presets as *thresholds*, not as tier names:
  `oracle` is `jitThreshold: 1e12, baselineThreshold: 1e12` — the interpreter, forced.
- `tests/helpers/aot-agreement.ts` (103 lines) — `interpreted(source)` (collects `output`
  into a string with `\n` appended per line), `image(source)` (`x64-windows`, `format:
  "executable"`, asserting `program.skipped` is `[]`), `cText(source)` (`c`, `format:
  "assembly"`, same assertion), and `peAgrees(source)` — six lines that are the whole AOT
  contract: `status === 0` and `stdout === interpreted(source)`. Then `cCalls`/`CCalls`
  (`matches`, `text`, `value`, `faults`) and `cAgreement` (`agrees`, `faults`), both
  returning *thunks* so the batch can be filled before any compiler runs.
- `tests/helpers/c-executor.ts` (365 lines) — the economics. `BATCH_SIZE = 64`,
  `UNIT_SUFFIX = "_u"`, `UNSELECTED_STATUS = 97`, `RUN_TIMEOUT_MS = 30_000`;
  `makeUnit`/`renameSymbols` (every definition gets a `_u<N>` suffix so 64 programs can
  share a translation unit); `link`'s `sharing` map keyed on `unit.head` (identical
  preambles are grouped into one `.c` file); `dispatchMain` (`switch (argc > 1 ?
  atoi(argv[1]) : -1)`); `resolve` and its per-case fallback at lines 265–271 — if the
  batch fails to link, each case is re-linked alone rather than 64 tests failing together;
  `cBatch` with its lazy `chunks` map and `afterAll` cleanup; `runCProgram`,
  `runCFunction`, `runCStringFunction`; `cCompiler = inject("cCompiler")` and
  `itNative = it.skipIf(cCompiler === null)`.
- `tests/helpers/pe-runner.ts` — `runsWindowsPrograms` (`runsOwnBackends && platform ===
  "win32" && arch === "x64"`), `itRunsPe`, `runPe(image, input)`: write the bytes to a
  temp file and `spawnSync` them. No linker, no toolchain — the engine produced the whole
  file.
- `tests/helpers/elf-runner.ts` — the same for ELF, with `detect()` choosing between
  `nativeLauncher` and `wslLauncher` (which translates the path with `wsl.exe -e wslpath
  -a` and runs it inside WSL), `elfLauncher`, `itRunsElf`, `runElf`.
- `tests/e2e/optimizing/differential-guard.test.ts` (16 lines) — the guard tested in both
  directions and in the case that looks like it should fail but must not.
- `tests/e2e/optimizing/gc-roots.test.ts:179` — `const eagerGc = { allocationBudget: 8,
  youngGenSize: 16 }` and `baselineGc`, which threads it into `differential`. This is the
  hostile-GC configuration.
- `tests/e2e/optimizing/x64/native-balance.test.ts` — the produced-binary case:
  `examples/balance.tera` compiled to `x64-linux` `executable` once (memoized in `built`),
  then `runElf(image, equation + "\n")` for each of eight equations including `"junk"` and
  the incomplete `"H2 + O2"`, each compared against `interpreted(equation)`.
- `src/optimizing/drivers/text-driver.ts` — `afterPass(text, run)`: `parseIR`, run the
  transform under a `IRNodeIdAllocator` seeded at `maxNodeId(graph) + 1`, `rebuildUses`,
  `printIR`. Also `runNamedPass`, `afterNamedPass`, `passByName`, `middleEndPassNames`,
  `UnknownPassError`. `tests/helpers/ir-text.ts` re-exports these and adds `valuesIn`.
- `tests/e2e/docs/book-examples.test.ts` — the test that makes this book checkable: it
  enumerates `docs/example/*.tera`, runs each one, and compares against the output the
  book prints. Every one, with no exemption: `EXPECTED` is asserted to equal the directory
  listing, so an example cannot be added without an expectation and cannot keep one that
  has stopped being true. `labeled.tera` is the case that proves it — its labeled
  `continue` looped forever, and the row that now demands
  `["1", "2", "3", "5", "6", "7"]` is what pins the fix
  ([Ch 19 § the-jump-nobody-patched]).

## Worked example

Two halves, both run.

**One.** `differential` on `docs/example/stats.tera` is *refused*, and that refusal is the
lesson. The file's last statement is `print(report(throughput))`, so `answersNothingVisible`
returns true and the helper throws before running anything:

```
differential compares what a program answers, not what it printed; end the source with the
value itself rather than a print, or the tiers are compared as undefined === undefined
```

Deleting the two `print` calls and ending on `report(latency)` makes the same program
comparable, and the oracle's answer — the string `latency mean=15.70` — is then demanded
from `baseline`, `jit`, `osr`, `eager`, `baselineOsr` and `production` in turn.

**Two.** `examples/balance.tera` compiled to an `x64-linux` executable and *run*, eight
chemical equations fed to it on stdin, each compared byte for byte against the same program
in the interpreter — including `"junk"` and the malformed `"H2 + O2"`, which must fail
identically:

```bash
npx vitest run --project native tests/e2e/optimizing/x64/native-balance.test.ts --reporter=verbose
```

```
✓ compiles the top level of the example along with its functions 1693ms
✓ writes the same bytes as the interpreter for every equation 3858ms
✓ balances an equation it was never given at compile time 277ms
✓ reads input that has no trailing newline 284ms
✓ agrees with the interpreter when stdin is closed straight away 288ms
```

The third title is the one to dwell on: the binary balances an equation that did not exist
when it was compiled. That is the difference between an agreement test and a snapshot.

## Outline

- [ ] **The problem with testing a compiler.** Establish why the usual answer does not
      scale here: there is no specification document to test against, and four
      implementations must agree on every program, not on a list of programs. Establish
      the alternative that was chosen — `> **New idea.** Differential testing` — and its
      one weakness: a disagreement does not say who is wrong.
- [ ] **Four projects from one table.** Walk `vitest.config.ts` end to end; it is short
      enough to quote almost entirely. Establish that `unit` and `e2e` differ only by an
      include/exclude on `tests/e2e/**`, and that `e2e`, `native` and `full` differ only in
      `env: { TERA_NATIVE }`. Establish `isolate: false` and
      `maxWorkers: "40%"` as deliberate, and what they cost.
- [ ] **Fifteen lines of gate.** `tests/helpers/native-tier.ts` in full: an ordered
      three-value enum, one environment variable, two exported booleans. Establish the
      pattern every gated test uses — `it.skipIf(...)` bound once into `itNative`,
      `itRunsPe`, `itRunsElf` — and why a skipped test is visible in the reporter rather
      than absent. Establish `global-setup.ts` as the reason compiler detection happens
      once, and `inject("cCompiler")` as the channel.
- [ ] **The project rule.** Establish the convention as stated: *if the test executes tera
      source through an `Engine`, it is e2e.* Everything else — a pass, an analysis, a data
      structure driven directly — is a unit test. Establish why this rule and not
      "integration vs unit": it maps exactly onto *does this need the whole front end to
      have worked*.
- [ ] **Seven presets, and what a preset actually is.** Read the `TIERS` table as
      thresholds. `oracle` pushes both thresholds to 10¹² and turns OSR off, so it is the
      interpreter and nothing else. `baseline` lets tier 1 in at 3 calls and keeps tier 2
      out. `jit` lets tier 2 in at 30. `osr` is `jit` plus on-stack replacement. `eager`
      compiles almost immediately (3/2/3). `baselineOsr` is baseline with OSR left on.
      `production` is the shipped defaults from
      `src/runtime/tiering/defaults.ts`. Establish that a preset is a *policy*, so the
      harness is testing the tier-up machinery too, not only the compiled code.
- [ ] **Why the obvious design fails: comparing what a program printed.** Stage it as the
      design a reader would reach for — capture stdout from each tier and `expect` them
      equal — then the failure. Establish `answersNothingVisible` and
      `PRINTS_INSTEAD_OF_ANSWERING` as the fix: `differential` compares `runNative`'s
      *return value*, and a source whose last statement is a `print(` call returns
      `undefined` from every tier, so the assertion becomes `undefined === undefined` and
      passes for a completely broken JIT. Establish the general rule: **a harness must be
      able to fail.** Note the deliberate narrowness — the check is textual and only looks
      at the last non-blank line, which is why `"still allows a print that is not the last
      statement"` exists.
- [ ] **Running under a hostile collector.** Establish `differential`'s `gc` parameter and
      `eagerGc = { allocationBudget: 8, youngGenSize: 16 }`: a collection after almost
      every allocation, so a value that is live only in a baseline register or a JIT frame
      is swept unless it is rooted. Establish why this belongs in the differential harness
      rather than in a GC test — the bug it finds is not "the collector is wrong", it is
      "tier N forgot to root something", and only the comparison can see it. Cross-refer
      [Ch 30 § root-sets].
- [ ] **The native tier: running what was produced.** Establish the escalation.
      `--project native` writes the engine's own ELF or PE bytes to a file and executes
      them; nothing else is involved — no assembler, no linker, no libc — so what runs is
      exactly what [Ch 70] and [Ch 71] emitted. `--project full` adds a C toolchain.
      Establish `runPe`, `runElf` and the WSL launcher (`wsl.exe -e wslpath -a`) as the
      reason a Windows machine can still test the Linux backend.
- [ ] **The economics of `cBatch`.** Establish the cost first — measured on the project's
      own machine, one run: the `full` tier is 5463 tests, about 400 compiler spawns at
      ~98 ms each, on 40% of 20 cores, and the AOT compiler itself is linear in program
      size (4 classes 188 ms → 32 classes 288 ms). The tier is slow because of process
      spawns, not algorithms. Then the four mechanisms that amortize them:
      1. **Symbol renaming.** `makeUnit` suffixes every definition with `_u<N>` via
         `renameSymbols`, which walks a `TOKEN` regex and skips string and character
         literals — so 64 independent programs can define `add` and still link.
      2. **Preamble grouping.** `link` buckets units by `unit.head`, the text before the
         first definition, so programs with identical prelude share one translation unit.
      3. **One binary, `argv[1]` dispatch.** `dispatchMain` writes a `switch (argc > 1 ?
         atoi(argv[1]) : -1)` over all selected cases; `runCase` spawns it once per case,
         and a case nobody selected exits `97`.
      4. **A per-case fallback.** In `resolve`, if the batched link throws, each case is
         re-linked and re-run alone. Establish what this is for: one program that emits
         invalid C must not fail its 63 neighbours, because the harness's job is to say
         *which* program is broken.
      Establish the laziness that makes it work: `cBatch`'s accessors return thunks, so
      every `it` in a file registers its request during collection and the first *executed*
      one compiles the whole chunk.
- [ ] **The AOT agreement oracle in six lines.** Quote `peAgrees` whole. Establish that
      `expect(program.skipped).toEqual([])` inside `image` is half the contract — a
      compiler that declines the function has not agreed, it has abstained — and that
      `run.status === 0` and `run.stdout === interpreted(source)` is the other half.
      Establish the asymmetry with the JIT harness: `differential` compares *values*
      because both sides are in the same process; `peAgrees` compares *stdout* because a
      subprocess has nothing else to hand back, and the print path is therefore part of
      what is being tested. Cross-refer [Ch 62 § printing-a-double].
- [ ] **Pass fixtures, and why printed IR is a test format.** Establish `afterPass`:
      `parseIR(text)` → run one transform → `printIR`. This only works because the textual
      form round-trips exactly, which is why `"round-trips a printed function unchanged"`
      is load-bearing rather than a nicety. Establish the workflow it enables — paste
      `--print-ir` or `--print-after-all` output straight into a fixture — and the node-id
      caveat: `afterPass` seeds a fresh `IRNodeIdAllocator` at `maxNodeId + 1`, because ids
      must not collide with the ones the text already names ([Ch 43 § node-ids]).
- [ ] **What the harness still cannot see.** Close on the honest limit, from
      [Ch 65 § scheduling-regions]. A machine block can hold a conditional branch in the
      *middle* — `SelectionContext.guard()` emits a `ja` to a slow path and keeps emitting
      the fast path into the same block — and the first scheduling window bounded regions
      by the *trailing* terminator run. Instructions crossed the `ja`: the arena cursor
      commit moved above it and the size argument for `tera_alloc` sank below it. The
      result was an access violation in any program that allocates in a loop. `npm test`
      could not see it and neither could `--project e2e`, because neither runs a produced
      binary. The tier that catches it is `--project native`. Establish the rule that came
      out of it — *run the tier that executes the artifact you changed* — and the cost of
      that rule, which is the whole reason the four projects exist.

## Honesty items

> **Unenforced.** `differential`'s guard is textual and one line deep:
> `answersNothingVisible` splits on `\n`, drops blank lines and asks whether the last one
> `trimStart().startsWith("print(")`. A source ending in `x = print(y)`, in a print inside
> a trailing block, or in any other statement that also answers `undefined` passes the
> guard and is compared vacuously. Nothing checks that the oracle's answer is not
> `undefined`, which would be the direct check.

> **Unfinished.** Of 202 `differential` call sites in `tests/`, 180 take the default
> `["baseline", "jit", "osr"]`. `eager`, `baselineOsr` and `production` appear in a handful
> of files each, and no call site in the tree passes all six non-oracle presets. The seven
> presets are available; the suite does not systematically use them.

> **Unenforced.** `differentialModules` (`tests/helpers/tiers.ts:73-83`) has no guard at
> all. `differential` refuses a source that only prints; its multi-file sibling calls
> `answersNothingVisible` nowhere, so an eleven-call-site harness for cross-module
> behaviour can compare `undefined` against `undefined` with nothing to stop it.

> **Unenforced.** The `full` tier is gated twice, by two different mechanisms that must
> stay in step: `runsToolchain` (`tests/helpers/native-tier.ts:15`) gates the binutils
> helpers in `tests/helpers/gnu-assembler.ts` (`gnuToolchain`, `elfReader`,
> `objectDumper`), while the C compiler is gated by `cCompiler === null` through
> `itNative`, which `global-setup.ts` sets to `null` for every tier except `full`. Both
> read the same environment variable by different routes; nothing checks they agree.

> **Unenforced.** `isolate: false` in `vitest.config.ts:10` means test files in a worker
> share one module registry and one process. `remarks` in
> `src/optimizing/infra/pass-remarks.ts` is a module-level singleton, and
> `tests/helpers/tiers.ts` keeps a module-level `moduleRoots` array cleaned by an
> explicitly-called `cleanModuleProjects`. Nothing enforces that a test leaves this shared
> state as it found it.

> **Measured worse — as a process, not a pass.** The `full` tier was measured at ~140 s and
> repeatedly pinned the development machine at 100% CPU and RAM; running two vitest
> projects at once OOM-killed it twice. The recorded rule is a schedule, not a scope:
> `npm test` after every edit, the affected *files* at the native tier when the edit
> reaches codegen, and the whole native tree once, at the end. These numbers come from the
> project's own working notes on one machine, one run — there is no benchmark harness in
> this tree.

## Verify it yourself

```bash
npx vitest run --project e2e tests/e2e/optimizing/differential-guard.test.ts
npx vitest run --project e2e tests/e2e/docs/book-examples.test.ts
npx vitest run --project native tests/e2e/optimizing/x64/native-balance.test.ts --reporter=verbose
node dist/cli.js docs/example/stats.tera
grep -rn "differential(" tests/ --include=*.ts | wc -l ; grep -rn "differential(" tests/ --include=*.ts | grep -vc "tiers:"
```

The first prints 3 passed — the guard refuses, accepts and does not over-refuse. The second
prints 13 passed: every file in `docs/example/` prints what this book says it prints. The
third runs a real ELF binary the engine produced (through WSL on a Windows host) and
compares eight equations against the interpreter. The last prints `202` and `180`.

## Tests that pin this

- `tests/e2e/optimizing/differential-guard.test.ts` — the whole file, under
  `"the differential helper guards against a source it cannot observe"`:
  - `"refuses a program whose last statement only prints"`.
  - `"compares a program that answers with the value itself"`.
  - `"still allows a print that is not the last statement"`.
- `tests/e2e/docs/book-examples.test.ts`
  - `"covers every example file, so a new one cannot be added untested"` — the
    meta-test that keeps this book's example directory honest.
  - `"stats.tera is the twenty-four lines the book claims"`.
  - `"queue.tera runs in the interpreter but is refused ahead of time"` — the cold open
    from [Ch 1], pinned.
  - `"stats-refused.tera runs in the interpreter but is declined by the backend"`.
  - `"labeled.tera resumes the outer loop instead of restarting the program"`.
- `tests/e2e/optimizing/x64/native-balance.test.ts` — under
  `"examples/balance.tera as a standalone executable"`:
  - `"compiles the top level of the example along with its functions"` — asserts
    `program.skipped` is `[]` *and* that the compiled set is exactly
    `["tera_program", "balance"]`.
  - `"writes the same bytes as the interpreter for every equation"`.
  - `"balances an equation it was never given at compile time"`.
  - `"reads input that has no trailing newline"`.
  - `"agrees with the interpreter when stdin is closed straight away"`.
- `tests/e2e/optimizing/gc-roots.test.ts` — the hostile-GC differential, under
  `"baseline frames are garbage collection roots"`:
  - `"keeps an object held only in a baseline register alive across allocation"`.
  - `"keeps an array held only in a baseline register alive across allocation"`.
  - `"keeps a string held only in a baseline register alive across allocation"`.
  - `"keeps a nested object reachable after a nested allocation"`.
  - and, from the same file, `"materializes a single object shared by many fields exactly
    once"` and `"does not blow up exponentially on a diamond chain, and deopts past the
    depth guard"`.
- `tests/optimizing/ir/text.test.ts` — what makes pass fixtures possible:
  - `"round-trips a printed function unchanged"`.
  - `"rebuilds the use list so a pass can walk consumers"`.
  - `"restores property values with their original types"`.
  - `"wires phis into both the block node list and its phi list"`.
  - `"refuses an opcode the IR does not define"` and
    `"refuses a value that was never defined"` — the parser is itself a small verifier.
