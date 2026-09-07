# 81. Refusal as a First-Class Answer   ⟨I · – · J · N⟩

> **Status:** outline

**Thesis.** Every engine can decline, and the sentences they decline with are the honest
specification of what each one can actually do — refusal is why the engine is allowed to be
aggressive everywhere else.

**What arrived.** The agreement contract from [Ch 80], and with it the observation that
agreement is cheap for a machine that is allowed to say no. Also, concretely: a
`CompileRejection` from the wasm backend, a `BackendLoweringError` from the native one, an
`AotSkippedFunction` list from the AOT driver, and `INTERPRETER_ONLY_OPS` from the
interpreter.

**What leaves.** The catalogue: every refusal the four machines can produce, gathered in
one place, argued as one position, and cross-referenced to `appendix/c-refusals.md`. Also
one general rule the reader will need in [Ch 82]: **the first error message names a
downstream symptom, not the cause.**

**New ideas.** None new. The chapter needs a `> **New idea.**` primer only for
*cooldown* — a per-function timer after which optimization is retried — if [Ch 35] did not
already give one; check before writing, and cross-reference rather than repeat.

**Length.** 12 pages

## Anchors

- `src/bytecode/register/interpreter/helpers.ts:67` — `INTERPRETER_ONLY_OPS`, a `Set` of
  **twelve** opcodes (`ROP_AWAIT`, `ROP_GET_ITERATOR`, `ROP_ITER_NEXT`, `ROP_ITER_DONE`,
  `ROP_ITER_VALUE`, `ROP_YIELD`, `ROP_LOAD_ARGUMENTS`, `ROP_TRY_START`, `ROP_TRY_END`,
  `ROP_THROW`, `ROP_LDA_KEYED_SLICE`, `ROP_ASSERT_CLASS_CONTRACTS`), and
  `requiresInterpreterOnly(compiledFn)`, which is `isAsync || instructions.some(...)`.
  Its five call sites: `interpreter/index.ts:503, :515, :975, :1011` and
  `src/runtime/tiering/osr.ts:41`. **Count check:** [Ch 27]'s title says *eleven* opcodes;
  the set holds twelve. One of the two is wrong and the chapter must say which.
- `src/optimizing/target/jit.ts` — the whole refusal vocabulary of the JIT in 37 lines:
  `RejectionKind = "unsupported" | "speculation" | "malformed"`, `CompileRejection`,
  `JitRejection` (`{compileRejection, analysisFailure}`), `JitCompileResult`
  (`{code, rejection}` — `code: null` *is* the refusal), `JitBackend`, `isJitBackend`.
- `src/optimizing/backends/wasm/graph-support.ts:314-323` — `unsupported()`,
  `speculation()`, `malformed()`, and `compileRejectionForNode(node, block)`, the validity
  check that decides which of the three a given graph node earns. Sixteen `malformed(...)`
  sites, each an *internal* invariant (`"has N inputs, expected M"`, `"has invalid field
  offset"`, `"has invalid call arity"`).
- `src/api/engine.ts:1807-1820` — the consequence. `malformedGraph = rejection?.kind ===
  "malformed"` is passed to `recordCompileFailure` as `unrecoverable`; at `:1845`
  `unrecoverable` sets `compiledFn.disableOptimization = true` **permanently**, while the
  other two kinds only set `optimizationCooldownUntil`.
- `src/optimizing/analyses/aot-legality.ts` — the AOT gate: `AOT_OPCODES` (the admitted
  opcode set), `AOT_BUILTINS`, `AOT_STRING_BUILTINS`, `AOT_PRINTABLE`, `AotLegality`,
  `AotLegalityResult`, `analyzeAotLegality`, `StringBufferRules`,
  `summarizeStringEscapes`, `StringEscapeSummary`, `holdsOwnText`, `isRootedPointer`,
  `rootSlotsOf`, `undeclaredParameterOf`, `undeclaredParameterReason`,
  `SPREAD_CALL_REASON`. 1,995 lines, and the largest single source of user-visible
  sentences in the tree.
- `src/optimizing/drivers/aot.ts` — `AotProgram` (`{files, compiled, skipped,
  moduleInits}`), `AotSkippedFunction`, `AotUndeclaredParameterError`, `AotLinkError`,
  `dropUnresolvedCallers` (the cascade: a worklist that drops every caller of a dropped
  callee and records `"calls unavailable function <name>"`), and the two `catch` blocks at
  `:777` and `:871` — `if (!isBackendLoweringError(error)) throw error;` then
  `skipped.push({name: graph.name, reason: error.message})`. That one line is the whole
  policy: a *lowering* refusal is data, anything else is a crash.
- `src/optimizing/passes/capability-check.ts` — `capabilityCheck(graph, target)`,
  `UnsupportedSpeculationError`, `deoptimizesOnItsOwn`, `throwsOutOfTheProgram`,
  `rendersFloatText`. Three capabilities gate it: `"deopt"`, `"terminating-throw"`,
  `"float-text"`.
- `src/optimizing/target/legalization.ts:444-451` — `capability-check` is the **last**
  entry in the legalization pipeline, `preserves: {kind: "all"}`, and its `run` returns
  `{changed: false}`. It exists only to throw.
- `src/optimizing/target/runtime-layout.ts` — the thread refusal:
  `TERA_THREAD_ENTRY_POINTS` (nine names: `CreateThread`, `CreateRemoteThread`,
  `_beginthread`, `_beginthreadex`, `pthread_create`, `thrd_create`, `clone`, `clone3`,
  `bsdthread_create`), `perThreadContextFields()`, `contextStorageFault(storage)`,
  `requireContextStorage()`, `threadEntryPointFault(surface)`,
  `withoutThreadEntryPoints(surface)`, `TERA_CONTEXT` (twenty-eight fields, twenty-seven
  of them `ownership: "perThread"`), `TERA_CONTEXT_STORAGE = "processGlobal"`.
- `src/cli/compile.ts` — where a refusal becomes a sentence on a terminal:
  `warnSkipped` (`tera compile: warning: skipped '<name>' (<reason>)`, called **only** from
  the `AotLinkError` catch at `:348`), `noteLeftOut` (`tera compile: note: '<name>' is not
  in the binary, and nothing the program runs calls it (<reason>)`, called at `:351` on
  the success path), `fail` (`tera compile: <message>`), `CompileError`, `selectEntry`,
  `usesToolchain`, `requireHostToolchain`, `resolveBackend`, `choosePlatform`.

## Worked example

`examples/builtins.tera` — 74 lines of surface exercises — compiles to nothing, and the
sentence it fails with names the wrong thing:

```bash
node dist/cli.js compile examples/builtins.tera -o /tmp/builtins.exe
```

```
tera compile: warning: skipped 'tera_program' (x64-windows backend cannot emit: tera_program keeps the string a call returned and then holds on to it; that string lives only until the next one is produced there, so it can be printed, built into another string, or copied into an object field, but not kept; use it where it is produced, or keep this part interpreted)
tera compile: x64-windows backend cannot emit: entry function tera_program could not be lowered to native code: x64-windows backend cannot emit: tera_program keeps the string a call returned and then holds on to it; ...
```

The message is a *string-lifetime* refusal from `StringBufferRules` [Ch 59]. It is
accurate about the mechanism and silent about the cause. Reduce the file to four lines and
the same sentence appears:

```
payload = JSON.stringify({ id: 1 })
print("stringify =", payload)
parsed = JSON.parse(payload)
print("parse.id  =", parsed.id)
```

The real cause is upstream: `JSON.stringify` is a call whose *returned* string is bound to
`payload` and then still live across the `JSON.parse` call on line 3. Nothing in the
message says "JSON", and nothing says which line. The chapter traces the message back to
the pass that actually declined, and uses the trip to argue § first-message-is-a-symptom.

Contrast with the refusal that *does* name its cause, `docs/example/stats-refused.tera`:

```bash
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe
```

```
tera compile: warning: skipped 'describe' (x64-windows backend cannot emit: function returns a string but its return type is not a string)
tera compile: warning: skipped 'tera_program' (calls unavailable function describe)
tera compile: x64-windows backend cannot emit: entry function tera_program could not be lowered to native code: it calls describe, skipped because x64-windows backend cannot emit: function returns a string but its return type is not a string
```

Three lines, and the reader can see the cascade: the leaf, the caller, the entry.

## Outline

- [ ] **§ refusal-is-the-license** — Establish the position before the catalogue. Every
      aggressive thing the engine does — speculating on a map, deleting a bounds check,
      inlining across a module, laying an object out with no runtime type — is only sound
      because there is a *defined way to not do it*. The JIT's version is
      `code: null`; the native compiler's is `AotSkippedFunction`; the interpreter's is
      "keep running". State the corollary that organises the chapter: **the refusal
      sentences are the specification**, because in a zero-comment codebase they are the
      only prose the compiler itself emits.
- [ ] **§ tier-zero-forever** — The interpreter's refusal, and the strictest one.
      `INTERPRETER_ONLY_OPS` holds twelve opcodes; a function containing any of them, or
      any `async` function, is never baselined, never JIT'd, never OSR'd — a *permanent*
      refusal with no cooldown and no diagnostic. Establish why the list is what it is
      (each opcode either suspends a frame, unwinds one, or reads a structure the compiled
      tiers do not model) and what it excludes (a `try` that is never entered still pins
      the whole function). Cross-reference [Ch 27] and settle the eleven-versus-twelve
      count there.
- [ ] **§ three-kinds-one-consequence** — The JIT's refusal, and the chapter's most
      load-bearing section. Read `src/optimizing/target/jit.ts` whole — 37 lines — and then
      show the consequence in `Engine.optimizeFunctionInRuntime`: `unsupported` and
      `speculation` set `optimizationCooldownUntil` and the function is retried;
      `malformed` sets `disableOptimization = true` and the function is **never optimized
      again for the life of the engine**. Establish the reasoning: `malformed` means *the
      compiler produced a graph that violates its own invariants*, which is a bug report,
      not a program property, and retrying would just burn budget. Then the hazard, stated
      plainly: `compileRejectionForNode` is a growing list of validity checks, and a new
      check classified as `malformed` when it should be `unsupported` **quietly
      deoptimizes every program that hits it**, with no error and no trace beyond
      `"Wasm compilation skipped — cooldown"`. Invariant → enforcement → test.
- [ ] **§ the-net-under-the-net** — Establish `"the graph validator is the net that
      replaced blanket use-list rebuilding"` — the def/use consistency checks in the same
      classification path. Note that they are `malformed` by construction, and that this is
      the *correct* use of the kind: a use list that dropped a real use is not a program
      property.
- [ ] **§ lowering-error-is-data** — The native compiler's refusal. Read the two `catch`
      blocks in `src/optimizing/drivers/aot.ts` and establish the one-line policy:
      `isBackendLoweringError(error)` decides whether a thrown exception is *data about
      this function* or *a crash of the compiler*. A `BackendLoweringError` becomes an
      `AotSkippedFunction` — `{name, reason}` — the build continues, and that function
      stays interpreted. Anything else propagates. Establish what this buys: a 400-function
      program with one unlowerable function still produces a binary.
- [ ] **§ the-cascade** — Read `dropUnresolvedCallers`. Establish that a refusal is not
      local: the dropped function's *symbol* is now undefined, so every caller must be
      dropped too, transitively, by worklist. Each drop records `"calls unavailable
      function <name>"` and, when the missing symbol is one of the skipped set, carries a
      `missing` field so the CLI can name it. Show `stats-refused.tera`'s three lines as
      the smallest complete cascade. Then the boundary case: when the *entry* is dropped,
      there is nothing to link, and `AotLinkError` carries the whole skipped list out to
      `warnSkipped`.
- [ ] **§ warning-versus-note** — A short, sharp section on the two CLI voices, because the
      distinction is real and nowhere documented in the tree. `noteLeftOut` (`:351`) runs
      on the **success** path: these functions are not in the binary and *nothing the
      program runs calls them*, so the binary is complete — a `note`. `warnSkipped`
      (`:348`) runs only inside the `AotLinkError` catch: the build **failed** and these
      are the functions that explain why — a `warning`. Establish the rule the codebase is
      following: severity tracks whether the artifact exists, not whether something was
      skipped.
- [ ] **§ capability-check-is-the-last-gate** — Establish the ordering argument.
      `capabilityCheck` is the final pass of `legalizationPipeline`
      (`src/optimizing/target/legalization.ts:444`), after if-conversion, operation
      legalization and dead-code elimination. It has to be last, because *legalization
      itself removes refusals*: `legalizeOperations` rewrites an `IR_SELECT` a target
      cannot emit into a diamond, and DCE can delete the last guard in a function, turning
      an `UnsupportedSpeculationError` into no error at all. Read the pass: three booleans
      (`"deopt"`, `"terminating-throw"`, `"float-text"`), an early return when all three
      hold, and a node walk otherwise. Cross-reference [Ch 51 § legalizing].
- [ ] **§ strings-and-absence** — Recall the two families of AOT refusal from Part IX
      without re-deriving them. String lifetimes [Ch 59]: three storage classes, and the
      refusal fires when a produced string is *kept* rather than used where it is made.
      Absence [Ch 57]: a reference carries only `null`, so `undefined` held as a reference
      is declined, and a declared type admitting **both** absences is declined because one
      pointer would then mean two things. Quote both sentences verbatim; they are the
      specification.
- [ ] **§ the-thread-refusal** — The most unusual refusal in the tree, and the one worth a
      full page: it refuses a **capability**, not a program. `TERA_CONTEXT` has twenty-eight
      fields, twenty-seven marked `ownership: "perThread"` — the arena cursor, the root
      base and count, the mark stack, the nursery limit, the young and remembered lists,
      the wait and microtask queues, the rejection list, and the pending-throw slot. There
      is exactly one instance of each. So `withoutThreadEntryPoints(surface)` refuses to
      bind `CreateThread`, `pthread_create`, `clone` and six siblings into the import
      table, with a message that *names the fields as the reason*:
      `"<names> would run tera code on a second thread while a program keeps <field list>
      in one tera_context"`. Establish the design principle: **the refusal is derived from
      the layout declaration, not written by hand**, so adding a per-thread field
      automatically strengthens the message. Cross-reference [Ch 61].
- [ ] **§ first-message-is-a-symptom** — *Why the obvious design fails*, and the rule the
      reader takes into [Ch 82]. The obvious design is "report the first thing that went
      wrong". It fails here because the pipeline is a cascade of *derived* facts: a string
      lifetime is derived from an escape summary, which is derived from a call graph, which
      is derived from whether each callee compiled. So the first message names the last
      derivation to fail — the symptom — and the cause is one or more steps upstream. Walk
      the `examples/builtins.tera` reduction as the demonstration. Then the practical
      advice: reduce the file until the message changes, and read `program.skipped` in
      order rather than reading only the top line. Note that `rule 5` of
      `docs/CONVENTIONS.md` requires both messages to be shown for exactly this reason.
- [ ] **§ the-catalogue** — Close by pointing at `appendix/c-refusals.md` and stating what
      it must contain: every refusal sentence, verbatim, with the file and function that
      emits it and the tier it constrains. This chapter argues the position; the appendix
      is the list.

## Honesty items

- > **Unenforced.** Nothing checks that a new validity check in
  `compileRejectionForNode` (`src/optimizing/backends/wasm/graph-support.ts`) is classified
  correctly. A check that should be `unsupported` but is written `malformed` sets
  `disableOptimization = true` on every function that trips it — the program keeps
  answering correctly and silently loses its optimizing tier forever. The only signal is
  `--trace-opt`'s `"Wasm compilation skipped — cooldown"`, which is the *wrong* message for
  that path. Cost of closing: make `malformed` mean *only* an internal-invariant violation
  and assert it — e.g. route every `malformed` through the same helper that
  `verifyAfterPass` uses — plus one test per kind. `tests/optimizing/backends/wasm/
  rejection.test.ts` already tests the classification for four shapes; nothing stops a
  fifth from being wrong.
- > **Unfinished.** `capabilityCheck` gates on exactly three capabilities. `CapabilitySet`
  in `src/optimizing/target/capabilities.ts` carries more than three — `osr`,
  `tagged-values`, `select-integer`, `select-float`, `generational-heap`, `timers`,
  `utf16-text` — and each of those is enforced somewhere else, or not at all: `timers` at
  `drivers/aot.ts:720`, `utf16-text` at `:858` and in `analyses/wide-text.ts:205`,
  `select-*` inside `if-conversion` and `operation-legalization`, `tagged-values` at
  `passes/builtin-method-lowering.ts:252` and `target/legalization.ts:112`. So "the last
  gate" is accurate for three of them and aspirational for the rest. Cost of finishing:
  move each capability's check into the one pass, which means each of those passes must
  become able to *refuse* rather than *branch* — a real redesign, not a move.
- > **Unenforced.** `INTERPRETER_ONLY_OPS` is a hand-maintained `Set` with no relation to
  the baseline compiler's or the IR builder's opcode coverage. An opcode added to
  `src/bytecode/register/ops/bytecode.ts` and handled by neither is not caught here; it is
  caught, at best, by a `default:` case at run time. Cost of closing: derive the set as
  *the complement of what the tiers handle*, which requires both tiers to publish their
  handled-opcode set the way `emittedOpcodesOf(lowering)` already does for machine code
  [Ch 64].
- > **Unfinished.** The thread refusal is a refusal *only*. `contextStorageFault` names
  exactly what a per-thread context would require, and `requireContextStorage` throws if
  anyone flips `TERA_CONTEXT_STORAGE`. Nothing implements the alternative. This is a
  deliberate non-goal — there is no thread-creation surface in the language, so a
  per-thread arena, root array and mark stack would be dead weight — and the chapter should
  say so rather than list it as a gap. Cost of finishing: per-thread arena, roots, marks,
  nursery, and every queue in `TERA_CONTEXT`; the layout declaration already enumerates the
  work.
- Historical, not current, and still the chapter's sharpest counter-example:
  `docs/example/labeled.tera` was a program the interpreter accepted and answered
  *wrongly* — it hung — rather than refusing. The bug is fixed
  ([Appendix D § closed]), but the reason it could happen is not: bytecode is the one
  representation in this engine with no verifier, so nothing in that tier was in a
  position to say no. Refusal is only available to a layer that checks something.
  See [Ch 19 § the-fix] and [Ch 78 § the-layer-with-no-verifier].

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe
node dist/cli.js compile examples/builtins.tera -o /tmp/builtins.exe
node dist/cli.js compile docs/example/queue.tera -o /tmp/queue.exe
npx vitest run --project unit tests/optimizing/backends/wasm/rejection.test.ts
npx vitest run --project unit tests/optimizing/target/runtime-layout.test.ts
npx vitest run --project unit tests/bytecode/register/interpreter/helpers.test.ts
```

## Tests that pin this

- Tier zero is permanent: `tests/bytecode/register/interpreter/helpers.test.ts` >
  `"returns true for async functions"`,
  `"returns true when instructions contain interpreter-only ops (await, yield, iterators)"`,
  `"returns true when instructions contain exception-handling ops (try/throw)"`,
  `"returns false for normal sync functions without special ops"`.
- The three JIT kinds are distinguished, and the distinction is deliberate:
  `tests/optimizing/backends/wasm/rejection.test.ts` >
  `"reports a missing return as a malformed graph, not an unsupported one"`,
  `"reports a wrong input count as malformed"`,
  `"reports an opcode the backend cannot emit as unsupported"`,
  `"separates a supported-but-unprofitable shape from a malformed one"`,
  `"keeps a regex node supported so the classification is not a catch-all"`,
  `"accepts a graph the backend can lower"`.
- Internal-invariant violations really are internal:
  `tests/optimizing/backends/wasm/rejection.test.ts` >
  `"accepts a graph whose use lists agree with its inputs"`,
  `"rejects a use list that dropped a real use"`,
  `"rejects a use list that counts the same use twice"`,
  `"rejects a use recorded for a node that never consumed the value"`.
- A refusal is data and the build survives: `tests/optimizing/drivers/aot.test.ts` >
  `"records functions the backend cannot lower as skipped"`,
  `"skips a later function with a duplicate backend symbol"`,
  `"links exactly the functions it reports as compiled"`.
- The cascade: `tests/optimizing/drivers/aot.test.ts` >
  `"prunes unresolved callers for a non-C backend too"`,
  `"links a dropped caller to the skipped function it was waiting for"`,
  `"passes the functions it skipped so the backend can explain a missing entry"`,
  `"wraps a backend that refuses to link as an AotLinkError"`,
  `"hands the skipped list to whoever catches the link failure"`.
- Undeclared parameters are refused by name: `tests/optimizing/drivers/aot.test.ts` >
  `"refuses a parameter whose type the source never declared, naming the function"`,
  `"carries every undeclared parameter it found on the error it raises"`; and
  `tests/optimizing/analyses/aot-legality.test.ts` >
  `"refuses a parameter whose type the source never declared"`,
  `"names the rest parameter when a gathered argument has no declared type"`.
- The thread refusal is derived from the layout, not written by hand:
  `tests/optimizing/target/runtime-layout.test.ts` >
  `"splits every context field into exactly one of the two ownerships"`,
  `"counts the pending throw slot as per-thread state, not a shared one"`,
  `"names the arena reservation as the only state two threads could share"`,
  `"refuses per-thread context storage while nothing provisions the per-thread state"`,
  `"lets the backends emit the one process-global context they build today"`,
  `"rejects a platform surface that can start a second thread"`,
  `"finds no thread entry point in any platform surface a program links today"`.
- String-lifetime refusals say what to do instead:
  `tests/optimizing/analyses/aot-legality.test.ts` >
  `"rejects a built string stored as a pointer and names what to do instead"`,
  `"says a built string is held without naming the operation that held it"`,
  `"names the callee a built string is handed to"`,
  `"admits a built string copied into storage the object owns"`,
  `"rejects a line of input handed to a function that keeps it"`.
- Absence refusals: `tests/optimizing/analyses/aot-legality.test.ts` >
  `"accepts undefined held as a reference the declared type names as the only absence"`,
  `"refuses it where the declared type admits both, so one pointer means two things"`,
  `"refuses it where the declared type names no absence to read it as"`,
  `"still accepts null held as a reference"`.
- Legalization removes refusals, so the gate must come after it:
  `tests/optimizing/target/legalization.test.ts` >
  `"expands a float select on a target that selects only integers"`,
  `"keeps an integer select on that same target"`,
  `"keeps a float select on a target that selects floats too"`,
  `"expands an integer select on a target that selects neither"`.
- The two example refusals are pinned: `tests/e2e/docs/book-examples.test.ts` >
  `"queue.tera runs in the interpreter but is refused ahead of time"`,
  `"stats-refused.tera runs in the interpreter but is declined by the backend"`.
