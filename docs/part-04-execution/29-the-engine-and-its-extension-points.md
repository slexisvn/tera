# 29. The Engine and its extension points   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** An engine's public surface is six ambient contexts and a handful of hooks; a
plug-in that only adds a function is not enough — it has to be able to teach the optimizer
what the function does.

**What arrived.** From [Ch 28]: a `GlobalCellMap` holding every entry of `builtins` and
`createDomainBuiltins()`, nine `JSObject` prototypes on `interpreter.builtinPrototypes`, and
`taggedToNative` / `nativeToTagged` — the two functions any host value must cross. Chapter 28
ended by naming `installBuiltinEntries` as the only writer. This chapter asks who else is
allowed to call it.

**What leaves.** A constructed `Engine`: `runInRuntime` as the wrapper every entry point and
every *resumption* must re-enter; a `MicrotaskQueue` whose `drain` is already reachable from
host code through `hostAsyncBinding().drain`; and
`microtaskQueue.setUnhandledRejectionReporter(...)` wired to whatever the caller passed as
`onUnhandledRejection`. Chapter 30 takes that queue and runs the first `await` through it.

**New ideas.** *Ambient context / dynamic scope* (a `with*(value, fn)` wrapper instead of a
parameter, and why a compiler with six global registries reaches for it); *lifecycle hook*;
*plug-in / extension point*; *phase ordering*; *declared effect* as a compiler input — the
same `declaredEffects` / `readonly` props [Ch 28 § builtin-metadata] stamped on builtins, now
supplied by a third party. *DCE* and *GVN* are named here and opened in [Ch 44] and [Ch 45].

**Length.** 14 pages

## Anchors

- `src/api/engine.ts` (2,043 lines) — `EngineOptions` (106-133): twenty-six optional fields, in
  four groups (machinery, tracing, extension points, hooks). `EngineUnhandledRejection`
  (135-138). The constructor (742-811), read as a strict ordering: registries, then extensions
  resolved and merged, then `wireUnhandledRejectionReporter()` (778), then the GC, then the
  interpreter — built inside `runInRuntime(..., false)` at 780-783 because
  `this.interpreter` does not exist yet and the host binding would read it.
- `src/api/engine.ts:813-819` — `hostAsyncBinding()`: the four-field object [Ch 28 §
  host-reentry] captures, whose `run` is `runInRuntime` itself.
- `src/api/engine.ts:822-834` — `runInRuntime`. Seven nested `with*` calls: `withValueHeap`,
  `withDependencyRegistry`, `withHiddenClassRegistry`, `withIRNodeIdAllocator`,
  `withCompiledFunctionIdAllocator`, `withGC` — the six ambient registries — then
  `withHostAsync(hostBinding, run)`, which is a *binding*, not a registry, and is skipped when
  `bindHost` is false.
- `src/api/engine.ts:836-896` — the five install functions: `installHostBuiltins` (836),
  which wraps each JS function in `hostBuiltin` and hands the result to
  `installBuiltinEntries`; `installRuntimeBuiltins` (844), two lines;
  `installRuntimeIntrinsics` (848-860), which throws `Runtime intrinsic 'x' is not installed`
  when a declared intrinsic has no payload; `installNativeModules` (862-876), which writes
  under `cellKey(NATIVE_PREFIX + name, ...)` so a native module is a *module namespace*, not a
  global; `installExtensionBuiltins` (887-896), which early-returns when there is nothing to
  install.
- `src/api/engine.ts:914-921` — `rememberCompilerExtensions` / `compilerExtensionsFor`: a
  `WeakMap<RegisterCompiledFunction, Required<TeraCompilerExtension>>` walked recursively into
  `compiledFn.constants`, so a function compiled with per-call extensions keeps them when the
  JIT reaches it eight calls later.
- `src/api/engine.ts:923-939` — `runCompilerPasses(phase, target, compiler)`: build a context,
  filter passes by `phase`, run each, keep the return value if it is not `undefined`.
- `src/api/engine.ts:1209-1215, 1252-1264` — the three phases the engine drives:
  `"ast"` on the parsed tree, `"semantic"` on `analyzeEffects(parsed)`, `"bytecode"` on
  `compiler.compile(ast)`.
- `src/api/engine.ts:1432-1438` — `reportCompiled`, which fans `onCompile` over
  `collectCompiledFunctions(compiled, true)` and skips `isLazy` functions.
- `src/api/engine.ts:1778` — `this.onOptimize?.(compiledFn, optimizerResult.graph)`, fired
  between `optimizer.compile` and `jitBackend.jitCompile`; note the line before it,
  `this.optimizer.setCompilerExtensions(this.compilerExtensionsFor(compiledFn))`.
- `src/api/engine.ts:1578-1593` — `wireUnhandledRejectionReporter`: installs `null` when no
  hook was given, otherwise a closure that maps each `UnhandledRejection` through
  `taggedToNative` and `describeThrown` *inside* `runInRuntime`.
- `src/api/extensions.ts` (199 lines, the whole extension contract) — `TeraCompilerPhase`
  (7), `TeraCompilerEffect` (8) with its nine members, `TeraGuardKind` (9), `TeraDeoptSpec`
  (10), `TeraGuardSpec` (18), `TeraIntrinsicSpec` (26-40), `TeraEffectMetadata` (41-55),
  `TeraOptimizerPassContext` (56-62), `TeraOptimizerPass` (63-68) with `order?: "early" |
  "normal" | "late"`, `TeraCompilerExtension` (69-75), `TeraNativeModule` (77-82),
  `TeraExtension` (84-91) — the six slots a plug-in may fill — and `ResolvedTeraExtensions`
  (94-101). Then `assertExtensionName` (103-107) and its regex `/^[A-Za-z0-9_.@/-]+$/`;
  `mergeNamedExtensionItems` (109-121) and `mergeExtensionRecords` (123-132), the two
  functions that turn a name collision into a thrown `Duplicate <kind> '<name>'`;
  `mergeCompilerExtensions` (134-142); `resolveTeraExtensions` (144-189);
  `compareOptimizerPasses` (191-193) and `orderRank` (195-199).
- `src/optimizing/optimizer.ts:62-92, 169` — `Optimizer`'s own `runCompilerPasses`, a
  near-copy of the engine's, and the single line `graph = this.runCompilerPasses("ir", graph)`
  that is the whole `"ir"` phase.
- `src/optimizing/metadata/intrinsics.ts` (40 lines) — `createIntrinsicOptimizationMetadata`
  (12-17), a name→spec `Map`; `intrinsicCallMetadata` (19-40), which defaults missing effects
  to `["unknown"]`, sets `props.readonly` via `ir.isReadOnlyDeclaredEffects`, and copies
  `reads` / `writes` / `allocates` / `guards` / `deopts` / `fallback` / `returns` onto the IR
  node. **This is the whole mechanism by which a plug-in teaches the optimizer.**
- `src/bytecode/register/ops/bytecode.ts:121, 293` — `ROP_CALL_INTRINSIC = 0x92`, disassembled
  as `CallIntrinsic`; `src/bytecode/register/compiler/expressions.ts:531` emits it;
  `src/bytecode/register/interpreter/index.ts:728` (`installRuntimeIntrinsic`) and `1861-1862`
  execute it.
- `src/optimizing/ir/operations.ts:88, 974` — `IR_CALL_INTRINSIC = "CallIntrinsic"` and its
  signature row `call(variadic(0), RESULT_HANDLE, declaredReturnTransfer)`.
- `src/cli/host.ts` (16 lines, quotable whole) — `hostEngineOptions()`: spread
  `createReactiveTeraOptions({ nativeToTagged, taggedToNative })`, copy its `extensions`
  array, add `createBackendRegistry()` and `nodeModuleFileSystem`. The CLI's *entire*
  relationship with the plug-in system.
- `src/cli/main.ts:87-96, 180-186, 219-222` — where `--print-bytecode` becomes `onCompile`,
  `--print-ir` becomes `onOptimize`, and `onUnhandledRejection` sets
  `sawUnhandledRejection`, which becomes `FAILURE_EXIT`.
- `node_modules/@slexisvn/reactive/dist/tera/index.d.ts:150-181` — `REACTIVE_INTRINSICS`
  (fourteen names, all `__tera_reactive_*`), `reactiveOptimizerPass`,
  `createReactiveTeraExtension`, `createReactiveTeraOptions`. The pass itself is
  `{ name: "reactive-lower-to-intrinsics", phase: "ast", order: "late" }`.
- `tests/e2e/api/engine-plugins.test.ts` (514 lines, 15 tests) — the executable specification
  of everything above.

## Worked example

A pure runtime intrinsic called eight times in a hot loop, asserted to be invoked *fewer than*
eight times. The whole plug-in is twenty lines of `EngineOptions` —
`tests/e2e/api/engine-plugins.test.ts:332-375`:

```ts
runtimeBuiltins: { __test_pure_note: { name: "__test_pure_note", call(args) { calls++; return args[0]; } } },
compiler: { intrinsics: [{ name: "__test_pure_note", phase: "bytecode", lowering: "runtime",
                           parameters: ["value"], returns: "int", effects: ["pure"] }] },
tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
```

— tests/e2e/api/engine-plugins.test.ts:334-355

```bash
npx vitest run --project e2e tests/e2e/api/engine-plugins.test.ts \
  -t "eliminates unused pure runtime intrinsic calls in optimized code"
```

Trace the path the chapter must walk: `runtimeBuiltins` → `installBuiltinEntries`
([Ch 28 § install]) → `installRuntimeIntrinsics` → `interpreter.installRuntimeIntrinsic` →
the compiler emits `ROP_CALL_INTRINSIC` instead of a global load plus a call →
`intrinsicCallMetadata` reads `effects: ["pure"]` → `props.readonly = true` on the
`IR_CALL_INTRINSIC` node → dead-code elimination deletes the ones whose result is unused. The
assertion is `expect(calls).toBeLessThan(8)`: the count is the proof.

The sibling test does the same for GVN — `__test_pure_id(value) - __test_pure_id(value)`
called from a loop of eight, asserted `toBeLessThan(16)`.

## Outline

- [ ] **Six registries that cannot be parameters.** Open `runInRuntime` (822-834). Establish
      the problem first: a value heap, a dependency registry, a hidden-class registry, two id
      allocators and a GC are consulted by code five call levels deep — `mkString` does not
      take a heap argument. State the solution as what it is: a *dynamically scoped* binding,
      saved and restored around a call. Then the consequence that makes it a rule rather than a
      convenience: **every public method's body is inside `runInRuntime`.** Thirty-one
      `this.runInRuntime(` call sites in this file.
- [ ] **Why the obvious design fails: module-level singletons.** Stage it — export one
      `ValueHeap` from `core/value` and be done. Then the program that breaks it: two `Engine`s
      in one process, which is exactly what `tests/helpers/tiers.ts`'s `differential(...)`
      does on every tier comparison ([Ch 78]). Establish: ambient-with-restore is a singleton
      you can nest, and it is what makes the book's own correctness argument possible.
- [ ] **The seventh wrapper is not a registry.** `withHostAsync(hostBinding, run)` binds
      a `{ queue, drain, interpreter, run }` object, and `bindHost = false` exists for exactly
      one caller: constructing the interpreter at 780, before `this.interpreter` is assignable.
      Establish: the boolean is bootstrap, not policy — and note the thesis's "six" counts
      registries, while the nesting is seven deep.
- [ ] **The constructor is an ordering.** Walk 742-811 in order and name the three
      dependencies that make it an ordering rather than a list: extensions must be resolved
      before the interpreter exists (the builtins they add are installed into its global
      cells); `sharedGlobals` is snapshotted from `globalCells.cells.keys()` *after* extension
      install (786), so plug-in globals count as shared and survive a module reset; and
      `gc.bindRoots` needs the interpreter, the global cells and the microtask queue, which is
      the root set [Ch 32] enumerates.
- [ ] **Three hooks, three flags.** `onCompile` fired from `reportCompiled` (1432-1438) over
      every nested function, `isLazy` ones skipped; `onOptimize` fired at 1778 with the
      `CFGFunction` the JIT is about to lower; `onUnhandledRejection` wired at 1578 into the
      microtask queue's reporter slot. In the CLI (`main.ts:87-96`) the first two are two
      `console.log`s guarded by `matchesFilter`, and the third sets a boolean that becomes the
      process exit code. Establish: `--print-bytecode` and `--print-ir` are not CLI features;
      they are the smallest possible plug-ins, and they prove the hooks carry the real objects.
- [ ] **`TeraExtension` has six slots.** `syntaxPlugins`, `checker`, `hostBuiltins`,
      `runtimeBuiltins`, `modules`, `compiler`. Walk each to what it reaches: parser
      ([Ch 6 § syntax-plugins]), binder ([Ch 8]), `hostBuiltin`-wrapped globals ([Ch 28 §
      host-bridge]), raw `BuiltinRegistryEntry` globals, `native:`-prefixed module cells
      ([Ch 15]), and the optimizer. Establish: five of the six add *names*; only the sixth
      adds *knowledge*.
- [ ] **A name collision is an exception, not a last-write-wins.** `mergeNamedExtensionItems`
      (106-118) and `mergeExtensionRecords` (120-129) each throw
      `Duplicate <kind> '<name>'` on the second occurrence, and `resolveTeraExtensions`
      throws `Duplicate Tera extension '<name>'` before that. Establish the invariant:
      **installation order is never observable**, because a program in which it would matter
      does not start. Enforcement: the two merge functions. Tests: the two `rejects duplicate
      …` cases.
- [ ] **`assertExtensionName` and what a name may be.** `/^[A-Za-z0-9_.@/-]+$/` — permissive
      enough for `@slexisvn/reactive`, strict enough to keep a name out of a cell key by
      accident. One sentence; it is the only validation in the file.
- [ ] **Pass ordering, precisely.** `mergeCompilerExtensions` sorts `optimizerPasses` by
      `orderRank` (early 0, normal 1, late 2) once, at merge time; `runCompilerPasses`
      filters by `phase` and runs them in that order. Establish the limit honestly: `order`
      sequences *extension passes among themselves*, at a fixed point in the host pipeline —
      it does not interleave a plug-in pass with the engine's own sixty. For `"ir"` that
      fixed point is `optimizer.ts:169`, after `eliminateUnreachableBlocks` and before the
      OSR transform.
- [ ] **A runtime intrinsic is an opcode.** `lowering: "runtime"` makes
      `installRuntimeIntrinsics` register the payload on the interpreter, and the bytecode
      compiler emit `ROP_CALL_INTRINSIC` (`expressions.ts:531`) — a *named* call with no
      global load and no callee register — which becomes `IR_CALL_INTRINSIC` in the graph.
      Establish: this is why an extension function can be optimized at all. A plain
      `runtimeBuiltin` is a global cell holding an opaque callable; an intrinsic is a node the
      optimizer has a row for.
- [ ] **Declared effects are the whole point.** `intrinsicCallMetadata` (19-40) copies the
      spec's `effects` onto the node and sets `readonly` when
      `ir.isReadOnlyDeclaredEffects(effects)`. Absent a spec the default is `["unknown"]` —
      the conservative answer, so an unregistered name is never accidentally eliminated.
      Establish the symmetry with [Ch 28 § builtin-metadata]: the engine's own builtins and a
      third party's intrinsics reach the optimizer through *the same two props*. Then state
      what nothing checks: `effects: ["pure"]` is a promise, and a lying plug-in gets its
      calls deleted.
- [ ] **Per-compile extensions and the WeakMap.** `compile(source, { compiler })` merges
      call-site extensions over engine-wide ones (`compileCompilerExtensions`, 910), and
      `rememberCompilerExtensions` (914) walks `compiledFn.constants` to tag every nested
      function. Establish why: tiering happens *later*, on a different stack, so the metadata
      has to be attached to the function object rather than held in a variable. Pin it with
      `"uses per-compile runtime intrinsic metadata for optimized functions"`.
- [ ] **Native modules are namespaces, not globals.** `installNativeModules` (862-876) writes
      `cellKey(\`${NATIVE_PREFIX}${module.name}\`, name)`, and `nativeModuleInterfaces` (878)
      hands each module's `ExternalModuleSurface` to the checker. Establish: a plug-in can add
      an importable module that type-checks, without adding a single global — the same
      two-graph module story as [Ch 15].
- [ ] **The full-surface example: `@slexisvn/reactive`.** It fills five of the six slots at
      once: a syntax plugin, checker metadata, host builtins, runtime builtins, and a compiler
      extension holding fourteen `__tera_reactive_*` intrinsics plus one AST pass
      (`{ name: "reactive-lower-to-intrinsics", phase: "ast", order: "late" }`) that rewrites
      `signal(x)` into `__tera_reactive_signal(x)`. `src/cli/host.ts` is sixteen lines and
      installs all of it. Establish the boundary set by [Conventions § 19]: the package's
      internals are not this book's subject; the *shape of the socket* is.
- [ ] **What the running example does not need.** `stats.tera` runs with `hostEngineOptions()`
      like everything else, so the reactive extension is resolved, merged and installed for it
      — and it calls none of it. Establish: the extension surface costs one `resolveTeraExtensions`
      per `Engine`, and `installExtensionBuiltins` returns immediately when the registries are
      empty (889-890). State it as a fact about the code, not as a performance claim.

## Honesty items

- > **Never runs.** `TeraCompilerExtension.guards`, `.deopts` and `.effects`
  (`src/api/extensions.ts:71-73`) are carried from `resolveTeraExtensions` into the
  `TeraOptimizerPassContext` at `src/api/engine.ts:928-930` and
  `src/optimizing/optimizer.ts:83-85`, and read nowhere else in `src/`. The engine's own
  passes never consult a plug-in's `TeraGuardSpec` or `TeraEffectMetadata`; only an extension
  pass can, and only about itself. `tests/e2e/api/engine-plugins.test.ts > "exposes guard and
  deopt metadata to IR optimizer passes"` pins exactly that — visibility, not effect. Note
  the near-miss: `TeraIntrinsicSpec.effects` *is* consumed (`metadata/intrinsics.ts:21`), so
  the two `effects` fields on the extension surface have very different fates.
- > **Unenforced.** `effects: ["pure"]` is taken on trust. `intrinsicCallMetadata` sets
  `props.readonly` from the declaration alone; nothing observes the payload's `call` to check
  it. A plug-in that declares a printing function pure gets its output silently deleted at
  tier 2 while tier 0 still prints — a tier divergence the plug-in author causes and the
  engine cannot detect. The conservative default (`["unknown"]` for an unregistered name) is
  the only guard, and it does not apply to a *declared* lie.
- > **Unenforced.** Nothing validates a pass's `phase`. `TeraCompilerPhase` has four members;
  `runCompilerPasses` is called with `"ast"`, `"semantic"` and `"bytecode"` from the engine and
  `"ir"` from the optimizer, and filters with `pass.phase !== phase`. A typo'd or
  never-driven phase makes a pass silently never run, with no diagnostic at merge time — the
  one place (`mergeCompilerExtensions`) that already inspects every pass.
- > **Unfinished.** `order` is three values with no tie-break and no relation to the host
  pipeline. `orderRank` (`src/api/extensions.ts:195-199`) maps early/normal/late to 0/1/2 and
  `Array.prototype.sort` keeps insertion order within a rank; there is no way to say "after
  the engine's inliner" or "before scalar replacement". Making that expressible means naming
  the sixty built-in passes in the public type, which is the reason it has not been done.
- > **Unfinished.** Duplicated pass runner. `Engine.runCompilerPasses`
  (`src/api/engine.ts:923-939`) and `Optimizer.runCompilerPasses`
  (`src/optimizing/optimizer.ts:78-92`) have the same body over different fields — the
  optimizer's reads `this.compilerExtensions`, the engine's takes a parameter. One shared
  helper taking `Required<TeraCompilerExtension>` would remove the copy; nothing currently
  keeps the two in step.
- > **Unenforced.** `installRuntimeIntrinsics` throws `Runtime intrinsic 'x' is not installed`
  (`src/api/engine.ts:853-855`) only for `lowering: "runtime"`. An intrinsic declared with
  `lowering: "global"` — or with `lowering` omitted — is never checked against the builtin
  registry at all, so a spec naming a function nobody installed produces no error and no
  `CallIntrinsic`. Pinned in the negative by `> "rejects runtime intrinsic lowering without a
  runtime handler"`, which only covers the `"runtime"` case.

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera | sed -n '1,12p'
printf 'fn tot(n: int) -> int:\n  s = 0\n  i = 0\n  while i < n:\n    s += i\n    i += 1\n  return s\ni = 0\nwhile i < 100:\n  tot(50)\n  i += 1\nprint(tot(200))\n' > /tmp/hot2.tera
node dist/cli.js --print-ir --filter tot /tmp/hot2.tera | head -14
printf 'async fn boom() -> int:\n  throw("nope")\n  return 1\nboom()\nprint("done")\n' > /tmp/rej.tera && node dist/cli.js /tmp/rej.tera; echo "exit=$?"
npx vitest run --project e2e tests/e2e/api/engine-plugins.test.ts -t "eliminates unused pure runtime intrinsic calls in optimized code"
npx vitest run --project e2e tests/e2e/api/engine-plugins.test.ts
```

Expected: the `mean` disassembly (that is `onCompile`); a `fn tot params=1 {` header followed
by `graph [declaredSignature=…, osrCandidates=…]` and the SSA blocks (that is `onOptimize`);
`done` then `Uncaught (in promise) nope` and `exit=1` (that is `onUnhandledRejection`); then
1 passed / 14 skipped; then 15 passed.

## Tests that pin this

- `tests/e2e/api/engine-plugins.test.ts > "installs host builtins in the engine heap"` — the
  `hostBuiltins` slot reaches a global cell.
- `tests/e2e/api/engine-plugins.test.ts > "bridges Tera callbacks to host functions"` — a tera
  closure crossing out through `taggedToNative` ([Ch 28 § marshalling]).
- `tests/e2e/api/engine-plugins.test.ts > "accepts named extension presets"` — the
  `extensions: [...]` form, as opposed to the flat `hostBuiltins` / `compiler` options.
- `tests/e2e/api/engine-plugins.test.ts > "runs extension compiler passes without changing the
  default pipeline"` — a plug-in pass runs and the engine's own output is unchanged.
- `tests/e2e/api/engine-plugins.test.ts > "orders compiler passes by extension order hints"` —
  `orderRank`.
- `tests/e2e/api/engine-plugins.test.ts > "exposes guard and deopt metadata to IR optimizer
  passes"` — visibility only; see Honesty items.
- `tests/e2e/api/engine-plugins.test.ts > "lowers runtime intrinsics to a dedicated bytecode
  call opcode"` — `ROP_CALL_INTRINSIC`.
- `tests/e2e/api/engine-plugins.test.ts > "runs runtime intrinsic bytecode through the
  optimized JIT tier"` — the opcode survives to tier 2.
- `tests/e2e/api/engine-plugins.test.ts > "projects runtime intrinsic effect metadata into IR
  optimizer passes"` — `intrinsicCallMetadata`'s props reach the graph.
- `tests/e2e/api/engine-plugins.test.ts > "eliminates unused pure runtime intrinsic calls in
  optimized code"` — the chapter's worked example: `calls < 8`.
- `tests/e2e/api/engine-plugins.test.ts > "common-subexpressions identical pure runtime
  intrinsic calls in optimized code"` — `calls < 16` for sixteen written calls.
- `tests/e2e/api/engine-plugins.test.ts > "uses per-compile runtime intrinsic metadata for
  optimized functions"` — the `functionCompilerExtensions` WeakMap.
- `tests/e2e/api/engine-plugins.test.ts > "rejects runtime intrinsic lowering without a runtime
  handler"` — the one install-time check.
- `tests/e2e/api/engine-plugins.test.ts > "rejects duplicate extension names"` and
  `> "rejects duplicate compiler metadata names"` — `resolveTeraExtensions` and
  `mergeNamedExtensionItems`.
- Nothing pins that `--print-bytecode` and `--print-ir` are implemented as `onCompile` /
  `onOptimize`, or that `runInRuntime` restores the previous ambient bindings on throw.
  `[unpinned]`
