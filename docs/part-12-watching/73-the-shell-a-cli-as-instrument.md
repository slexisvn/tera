# 73. The shell: a CLI as instrument   ⟨**I** · **B** · **J** · **N**⟩

> **Status:** outline

**Thesis.** Every command, flag, help line and usage error comes out of one array of
declarations, so an undocumented flag is not a discipline problem but a structural
impossibility — and those flags are how every listing in this book was made.

**What arrived.** Four working machines and nothing pointed at them: an interpreter, a
baseline compiler, a JIT and an AOT compiler, each reachable only from the library API
([Ch 72 § two-controls]).

**What leaves.** `dist/cli.js`: eight commands over one `CommandSpec` table, and an
`EngineOptions` object built by `buildEngineOptions` that carries the reader's chosen
tiering thresholds, trace categories and dump hooks into every later chapter's
"Verify it yourself" box.

**New ideas.** A specification table as the single source for a parser, a renderer and a
test; inline versus separated flag values; the `--` literal escape; the bare `-` stdin
convention; a compiler intrinsic as a named global.

**Length.** 12 pages

## Anchors

- `src/cli/spec.ts` — `FlagSpec<C>` (`name`, `short?`, `value?`, `valueOptional?`, `group`,
  `summary`, `apply`), `CommandSpec<C>` (`name`, `summary`, `arguments`, `flags`,
  `defaults`, `accept`), `FLAG_GROUPS` and `FlagGroup`, `CliUsageError`, `STDIN_TOKEN`,
  `TRACE_ALIASES`, `ENGINE_FLAGS`, `INPUT_FLAGS`, `TYPECHECK_FLAG`, the eight commands
  (`RUN_COMMAND`, `REPL_COMMAND`, `CHECK_COMMAND`, `DEBUG_COMMAND`, `COMPILE_COMMAND`,
  `TARGETS_COMMAND`, `HELP_COMMAND`, `VERSION_COMMAND`), `COMMANDS`, `commandNamed`, and
  the four value parsers `parseTypecheck` / `parseCount` / `parseBytes` / `parseChoice`.
- `src/cli/args.ts` — `parseArgs`, `parseWith`, `splitFlag`, `flagNamed`, `valueOf`,
  `replFrom`, `hasInput`, `topicOf`, `askedFor`, and the constants `FLAGS_END`,
  `HELP_FLAGS`, `VERSION_FLAGS`.
- `src/cli/help.ts` — `commandHelp`, `generalHelp`, `helpFor`, `flagLabel`, `usageOf`,
  `row`, `LABEL_WIDTH`.
- `src/cli/main.ts` — `buildEngineOptions`, `buildTiering`, `matchesFilter`, `dispatch`,
  `main`, `runProgram`, `runCheck`, `checkModuleFile`, `runModuleEntry`,
  `printModuleGraph`, `gatherSources`, `reportUnhandledRejections`, `USAGE_EXIT = 2`,
  `FAILURE_EXIT = 1`.
- `src/cli/host.ts` — `hostEngineOptions`: the host layer `buildEngineOptions` spreads
  before it applies anything the user asked for.
- `src/cli/natives.ts` — `NATIVES` (`OptimizeFunctionOnNextCall`, `DeoptimizeFunction`,
  `NeverOptimizeFunction`, `GetOptimizationStatus`, `IsOptimized`, `CollectGarbage`),
  `nativesExtension`, `exposeGcExtension`, `optimizationStatus`, and the four status bits
  `STATUS_INTERPRETED` / `STATUS_BASELINE` / `STATUS_OPTIMIZED` / `STATUS_TIERING_DISABLED`.
- `src/cli/targets.ts` — `aotBackends`, `architectureOf`, `architectures`, `emitsOf`,
  `linksItself`, `hostArchitecture`, `targetsReport`, `runTargets`, `EMITS`, `PORTABLE`.
- `src/cli/stdin.ts` — `createLineReader`, `createStdinInput`, `readStdinChunk`,
  `suspendedChunkReader`, `ChunkReader`, `StdinSuspension`, `END_OF_INPUT_CODES`.
- `src/core/tracing/index.ts` — `CATEGORY_STYLES` (the eleven category names the tracer
  knows how to colour), `Tracer.shouldLog`, `setCategories`, `log`.
- `src/cli/compile.ts` — `aotCompilerOptions`: the only place in `src/` that installs a
  `passTracer` or sets `verifyEachPass` (see [Ch 41 § where-the-tracer-comes-from]).

## Worked example

The eleven command lines that produced every listing in this book, run in order on
`docs/example/stats.tera`. Each one is the exact form some later chapter's
"Verify it yourself" box cites.

```bash
node dist/cli.js docs/example/stats.tera
node dist/cli.js --print-ast docs/example/stats.tera
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 --filter mean docs/example/stats.tera
node dist/cli.js --print-module-graph docs/example/stats.tera
node dist/cli.js --trace=ic docs/example/stats.tera
node dist/cli.js --stats docs/example/stats.tera
node dist/cli.js check docs/example/stats.tera
node dist/cli.js targets
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe --verify
node dist/cli.js compile docs/example/stats.tera --emit source -o /tmp/stats.c --print-after-all
```

Two of these are the section's payload rather than decoration.

- `--print-ir` alone prints nothing for `stats.tera`. The program calls `mean` twice, which
  never reaches the default JIT threshold, so no function is ever optimized and the hook
  never fires. `--opt-threshold 1 --baseline-threshold 1` is what makes the graph appear.
  This is the chapter's demonstration that a dump flag is a *hook*, not a report: it can
  only show you what the engine decided to do.
- `--print-after-all` belongs to `compile`, not to `run`. Asking for it on a run is
  rejected with `tera: unknown option '--print-after-all' for 'run'` — the flag table is
  per command, so the parser can say which command it was parsing.

## Outline

- [ ] **One table, three readers.** Establish `FlagSpec<C>` and `CommandSpec<C>` as
      declarations with an `apply` closure, and that exactly three things read them:
      `parseWith` in `args.ts`, `commandHelp`/`generalHelp` in `help.ts`, and
      `tests/cli/args.test.ts`. Land the structural claim: help is not written by hand, so
      a flag that exists is a flag that is documented. Pin it with
      `"documents every flag the command declares"`, which loops over `COMMANDS` and every
      `command.flags`, and `"lists every command it can run"`.
- [ ] **`apply` is where the type ends.** Establish that `FlagSpec<C>.apply(config, value)`
      takes a `string` always — a flag with no value is applied with `""` — and that the
      four parsers (`parseTypecheck`, `parseCount`, `parseBytes`, `parseChoice`) are the
      only place a string becomes something else, each throwing `CliUsageError` with the
      accepted spelling in the message. Quote two verbatim:
      `--typecheck expects off|warn|strict, got 'x'` and
      `--emit expects exe|obj|source, got 'x'`. Pin with `"rejects a value the flag does
      not offer"` and `"refuses a string size that is not a size"`.
- [ ] **How a token becomes a flag.** Establish `splitFlag` (strip one or two leading
      dashes, split on the first `=`), then the three-way `valueOf`: a flag with no
      `value` takes none and rejects an inline one; an inline value is used as-is; a
      `valueOptional` flag left bare gets `""` and consumes nothing, so the positional
      after it survives. Pin with `"accepts a value attached to the flag or standing
      after it"`, `"leaves the positional alone when an optional value is absent"`,
      `"rejects a value on a flag that takes none"` and `"rejects a missing value"`.
- [ ] **The three tokens that are not flags.** Establish `--` setting `literal` so every
      later token goes to `spec.accept`; the bare `-` (`STDIN_TOKEN`) routed to
      `config.readStdin`; and any token not starting with `-`. Pin with
      `"treats a file named like a command as a file after the separator"` and
      `"reads stdin for the bare dash"`.
- [ ] **No command, no input: the REPL fallback.** Establish `parseArgs`'s order — help
      flags, version flags, a named first token, then `RUN_COMMAND` — and `replFrom`
      destructuring the run config down to the `EngineFlags` it shares with the repl
      config, `satisfies`-checked. Establish why this matters: `node dist/cli.js
      --no-opt` starts a REPL with tiering off, and the flags are not silently dropped.
      Pin with `"starts the repl when there is nothing to run"` and
      `"keeps engine flags when it falls back to the repl"`.
- [ ] **`buildEngineOptions` is a layering, in a fixed order.** Establish the four layers:
      `hostEngineOptions()` (reactive host bindings, the backend registry, the node module
      file system), then the two extensions the flags may add, then `createStdinInput()`,
      then the CLI-derived `typecheck`, `osr`, `tieringPolicy`, `trace` and the two hooks.
      Establish `buildTiering`: `--no-opt` sets `jitThreshold` and `loopOsrThreshold` to
      `MAX_SAFE_INTEGER` rather than adding a boolean, `--always-opt` sets
      `{baseline: 2, jit: 3, loopOsr: 3}`, and explicit thresholds are applied *after*
      either, so `--no-opt --opt-threshold 5` means five. Cross-reference
      [Ch 35 § when-to-tier-up].
- [ ] **`onCompile` and `onOptimize` are the whole dump surface.** Establish that
      `--print-bytecode` installs `onCompile` and `--print-ir` (aliased `--trace-turbo`)
      installs `onOptimize`, both wrapped in `matchesFilter`, so `--filter` is a substring
      test on the function name shared by both. Establish the consequence stated in the
      worked example: these fire when the engine compiles, so a dump flag cannot show you
      a tier the program never reached.
- [ ] **Trace categories.** Establish `--trace` with an optional comma list, the six
      `TRACE_ALIASES` that expand to category sets, and `Tracer.shouldLog` matching
      `"all"` or an exact string. Establish that `--trace-maps` deliberately pushes *two*
      spellings, `hidden_class` and `hidden-class`, because both appear in call sites.
      Use `docs/example/stats-deopt.tera` and quote the two lines verbatim:
      `[DEOPT] Dependency registered: total_of -> elements-kind:PACKED_DOUBLE` and
      `[DEOPT] DEOPT "total_of": elements-kind-check-failed at bytecode:8`. Cross-reference
      [Ch 54 § reading-a-deopt].
- [ ] **`--allow-natives-syntax`: intrinsics as ordinary names.** Establish that the six
      natives are registered as `runtimeBuiltins` *and* as compiler `intrinsics` with
      `lowering: "runtime"`, under plain identifiers — `OptimizeFunctionOnNextCall(f)`, not
      V8's `%OptimizeFunctionOnNextCall(f)`. **Why the obvious design fails:** copying V8's
      `%` prefix would mean teaching the offside tokenizer that `%` can start an
      identifier, and `%` is currently a binary operator *and* a line-continuation token
      (`src/cli/repl/multiline.ts` lists it in `CONTINUATION_PUNCT`); a prefix sigil buys
      nothing that a flag-gated extension does not already buy. Establish
      `optimizationStatus`'s four bits as the readable answer, and `--expose-gc` as the
      same mechanism with one builtin.
- [ ] **`tera targets` is derived, never written down.** Establish `architectures()`
      grouping `aotBackends()` by `architectureOf`, `emitsOf` reading `backend.outputs`,
      and `linksItself` deciding the last column. Show the real output and note that the
      `c` row says `needs a C compiler` because its outputs do not include `executable`.
      Pin with `"lists one row per architecture rather than one per platform pair"`,
      `"claims only the artifacts a half-finished encoder can really produce"` and
      `"says which architectures write an executable without a C compiler"`.
- [ ] **`tera check` is always strict.** Establish `runCheck` calling
      `createReactiveCheckOptions("strict")` and `checkModuleGraph(..., { mode: "strict" })`
      with no way to relax it, against `--typecheck off|warn|strict` on `run`. Establish
      the one-line consequence, which is [Ch 56 § aot-always-checks]'s premise: the mode
      AOT compiles under is the mode `check` reports in, so `tera check` is a preflight for
      `tera compile`, not for `tera run`.
- [ ] **Exit statuses are part of the interface.** Establish `USAGE_EXIT = 2` for anything
      that throws `CliUsageError` (from `parseArgs` or from `dispatch`), `FAILURE_EXIT = 1`
      for a diagnostic error, an unhandled rejection, or an uncaught throw, and `0`
      otherwise. Note the asymmetry worth naming: `runCheck` returns 1 when it reported an
      error, but reporting happens on stderr, so a script must read the status, not the
      output.
- [ ] **What the CLI does not expose.** Close on the gap chapter 77 lives in: there is no
      `--opt-bisect-limit`, no `--module-tracer`, and no way to reach `OptBisect` from the
      command line at all. `--verify` and `--print-after-all` exist only on `compile`, so
      the JIT's per-pass verification and IR dumps have no CLI at all. Hand over to
      [Ch 77 § bisecting-your-own-compiler].

## Honesty items

> **Never runs.** `src/optimizing/infra/opt-bisect.ts`'s `OptBisect` has no flag in
> `src/cli/spec.ts`. `CompilerOptions.optBisect` is reachable only from the library API and
> `tools/visualizer/src/workers/bisect.ts`. Cost: one `FlagSpec` in the `COMPILE_COMMAND`
> flag list plus a line in `aotCompilerOptions`, and — for the JIT side — a route from
> `buildEngineOptions` into `EngineOptions.compilerOptions`, which no flag currently sets.

> **Never runs.** `CompilerOptions.moduleTracer` likewise has no flag. Every remark a
> module-level AOT stage records is unreachable from the shell; only
> `tools/visualizer/src/workers/compiler-worker.ts` installs one.

> **Unenforced.** Nothing checks that the category string handed to `tracer.log` is one a
> `--trace-*` alias can select. `src/optimizing/passes/ic-lowering.ts` logs under `"JIT"`
> (uppercase) while `TRACE_ALIASES`'s `trace-opt` selects `jit`, `compile` and `wasm`, so
> those two lines are visible under a bare `--trace` and invisible under `--trace-opt`.
> `CATEGORY_STYLES` in `src/core/tracing/index.ts` is a colour table, not a closed set —
> `formatMessage` falls back to `category.toUpperCase()` for anything it does not know, so
> a typo in a category name produces a plausible-looking prefix and a silently unselectable
> event. Cost: make `CATEGORY_STYLES` the declared set and type `tracer.log`'s first
> parameter as `keyof typeof CATEGORY_STYLES`.

> **Unfinished.** `src/cli/stdin.ts` exports `StdinSuspension` and `suspendedChunkReader`
> so a caller can hand terminal control back while a program blocks on input, but
> `buildEngineOptions` calls `createStdinInput()` with no argument. Only
> `src/cli/repl/index.ts` passes a suspension. A program run with `tera run` that reads
> stdin therefore works, but a program run under `tera debug` shares the debugger's own
> line reader (`runDebug`'s `readLine` is `options.input`), which is the same function —
> worth stating plainly rather than leaving the reader to discover it.

> **Dead.** `FlagSpec.short` is declared and honoured by both `flagNamed` and `flagLabel`,
> but exactly two flags in the whole table use it: `-e` for `--eval` and `-o` for
> `--output`. Not a defect; worth naming so a reader does not go looking for short forms
> that are not there.

## Verify it yourself

```bash
node dist/cli.js help
node dist/cli.js help compile
node dist/cli.js targets
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 --filter mean docs/example/stats.tera
npx vitest run --project unit tests/cli/args.test.ts tests/cli/repl.test.ts tests/cli/targets.test.ts tests/cli/stdin.test.ts
```

## Tests that pin this

- `tests/cli/args.test.ts` > `"runs the files it is given without naming a command"`
- `tests/cli/args.test.ts` > `"starts the repl when there is nothing to run"`
- `tests/cli/args.test.ts` > `"keeps engine flags when it falls back to the repl"`
- `tests/cli/args.test.ts` > `"takes the first token as the command when it names one"`
- `tests/cli/args.test.ts` > `"treats a file named like a command as a file after the separator"`
- `tests/cli/args.test.ts` > `"reads stdin for the bare dash"`
- `tests/cli/args.test.ts` > `"accepts a value attached to the flag or standing after it"`
- `tests/cli/args.test.ts` > `"reads source given to the eval flag in either form"`
- `tests/cli/args.test.ts` > `"leaves the positional alone when an optional value is absent"`
- `tests/cli/args.test.ts` > `"splits a comma list given to the tracer"`
- `tests/cli/args.test.ts` > `"rejects a flag that belongs to another command"`
- `tests/cli/args.test.ts` > `"points at the help of the command it was parsing"`
- `tests/cli/args.test.ts` > `"rejects a value the flag does not offer"`
- `tests/cli/args.test.ts` > `"rejects a missing value"`
- `tests/cli/args.test.ts` > `"rejects a value on a flag that takes none"`
- `tests/cli/args.test.ts` > `"rejects a second input file for a command that compiles one"`
- `tests/cli/args.test.ts` > `"rejects arguments to a command that takes none"`
- `tests/cli/args.test.ts` > `"reports usage problems as usage errors"`
- `tests/cli/args.test.ts` > `"asks for an executable built from the top level of the file"`
- `tests/cli/args.test.ts` > `"refuses a string size that is not a size"`
- `tests/cli/args.test.ts` > `"bounds the string size by its own floor, not the heap's"`
- `tests/cli/args.test.ts` > `"says how many characters the string size buys"`
- `tests/cli/args.test.ts` > `"checks SSA form after every pass only when asked to"`
- `tests/cli/args.test.ts` > `"lists every command it can run"`
- `tests/cli/args.test.ts` > `"documents every flag the command declares"`
- `tests/cli/args.test.ts` > `"falls back to the general help for a topic it does not know"`
- `tests/cli/args.test.ts` > `"names the arguments each command takes"`
- `tests/cli/targets.test.ts` > `"lists one row per architecture rather than one per platform pair"`
- `tests/cli/targets.test.ts` > `"leaves out the backends that only run just in time"`
- `tests/cli/targets.test.ts` > `"names every platform an architecture can build for"`
- `tests/cli/targets.test.ts` > `"reports the artifacts a target can emit"`
- `tests/cli/targets.test.ts` > `"claims only the artifacts a half-finished encoder can really produce"`
- `tests/cli/targets.test.ts` > `"says which architectures write an executable without a C compiler"`
- `tests/cli/targets.test.ts` > `"tells the reader what this machine defaults to"`
- `tests/cli/targets.test.ts` > `"resolves the host to a registered target"`
- `tests/cli/stdin.test.ts` > `"strips a trailing carriage return from CRLF lines"`
- `tests/cli/stdin.test.ts` > `"returns a final line that has no terminator"`
- `tests/cli/stdin.test.ts` > `"joins one line split across chunks"`
- `tests/cli/stdin.test.ts` > `"keeps returning null once the input is exhausted"`
- `tests/cli/stdin.test.ts` > `"does not read another chunk while buffered lines remain"`
- The `--allow-natives-syntax` intrinsics are exercised only through the CLI end to end;
  no unit test names them. `[unpinned]`
