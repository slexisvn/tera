# 29. The Engine and its extension points   ⟨I · B · J · N⟩

Everything so far has been machinery with no visible seam: a lexer, a parser, a checker, a
bytecode compiler, an interpreter, four builtin tables. `Engine` is where all of it is
assembled into one object, and it is the only class in the tree a host program is meant to
construct. Its constructor is seventy lines long and its options type has twenty-six
fields. Read from the outside, those seventy lines answer two questions that turn out to be
the same question: *what does a running tera program need that is not passed to it as an
argument*, and *what may somebody else add to that*.

The first answer is six ambient registries — a value heap, a dependency registry, a
hidden-class registry, two id allocators and a garbage collector — bound around every
public method by a wrapper called `runInRuntime`. The second answer is a six-slot
`TeraExtension` record. Five of those six slots add *names*: a syntax form, a type
signature, a global function, an importable module. Only the sixth adds *knowledge*. That
distinction is the chapter's point, and it has a sharp edge: a plug-in that installs a pure
function and does not say it is pure gets eight calls out of a loop of eight, and a plug-in
that says so gets fewer than eight, because dead-code elimination is allowed to delete a
node whose `readonly` prop is set. The whole mechanism by which a third party can make that
happen is one function of twenty-one lines, in a file of thirty-nine.

**What arrived.** From [Ch 28 § what-leaves]: a `GlobalCellMap` populated by one loop over
every key of `builtins` and `createDomainBuiltins()`, written as `TaggedValue`s by
`installBuiltinEntries` (`src/runtime/builtins/index.ts:180`); nine `JSObject` prototypes
hanging off `interpreter.builtinPrototypes`, every property name of which has been through
`camelToSnake`; and `taggedToNative` / `nativeToTagged`, the only two doors between a tera
value and the JavaScript that four sibling packages are written in. Chapter 28 named
`installBuiltinEntries` as the only writer of that cell map. This chapter asks who else is
allowed to call it.

## Six registries

Start at the bottom of the engine, in code that has no idea an `Engine` exists. `mkString`
allocates a string in a heap. It does not take a heap argument. `IRNode`'s constructor
stamps a fresh id onto the node ([Ch 39 § one-counter-over-one-id-space]); it does not take an allocator. A
hidden-class transition looks up the target map in a registry shared by every object in the
process ([Ch 23 § the-transition-tree]); it does not take a registry. Each of these sits four
or five call levels below anything that knows which `Engine` is running, and threading a
parameter down every one of those levels would touch most of the 468 files in `src/`.

The solution the engine reaches for is a **dynamically scoped** binding.

> **New idea. Ambient context, or dynamic scope.** Ordinary lexical scope answers "what
> does this name mean?" by looking outward through the text of the program. Dynamic scope
> answers it by looking backward through the *call stack*: a value is bound for the
> duration of a call, every function reached from that call sees it, and the previous
> binding is restored when the call returns. JavaScript has no dynamic scope, so the engine
> builds one out of a module-level variable and `try`/`finally`. The pattern is a pair — a
> getter that reads the variable, and a `with*(value, fn)` wrapper that swaps it, calls
> `fn`, and puts the old value back no matter how `fn` exits. It is the same idea as
> Common Lisp's special variables or a thread-local, minus the threads.

Every one of the six is that exact pair. `withValueHeap` is representative:

```ts
export function withValueHeap<T>(heap: ValueHeap, run: () => T): T {
  const previous = activeValueHeap;
  activeValueHeap = heap;
  try {
    return run();
  } finally {
    activeValueHeap = previous;
  }
}
```
— `src/core/value/index.ts:584-592`

The `finally` is the whole design. Without it a throw would leave the wrong heap bound for
the rest of the process, and the next `Engine` in the same process would allocate into a
dead one. Nothing in `tests/` pins the restore-on-throw behaviour of any of the six
wrappers. `[unpinned]`

`Engine` binds all six at once, and it does it in one place:

```ts
  private runInRuntime<T>(run: () => T, bindHost = true): T {
    const hostBinding = bindHost ? this.hostAsyncBinding() : null;
    return withValueHeap(this.valueHeap, () =>
      withDependencyRegistry(this.dependencyRegistry, () =>
        withHiddenClassRegistry(this.hiddenClassRegistry, () =>
          withIRNodeIdAllocator(this.irNodeIdAllocator, () =>
            withCompiledFunctionIdAllocator(this.compiledFunctionIdAllocator, () =>
              withGC(this.gc, () => withHostAsync(hostBinding, run)),
            ),
          ),
        ),
      ),
    );
  }
```
— `src/api/engine.ts:822-835`

That produces the rule the rest of the class obeys without ever stating it: **every public
method's body runs inside `runInRuntime`.** `compile` is `runInRuntime(() =>
compileInRuntime(...))`. `compileAot` is `runInRuntime(() => compileAotInRuntime(...))`.
`performMicrotaskCheckpoint` is `runInRuntime(() =>
microtaskQueue.performCheckpoint(interpreter))`. There are thirty-one `this.runInRuntime(`
call sites in the file. The method names carry the convention as a suffix — the
`*InRuntime` half of a pair is the part that assumes the bindings are already in place, and
is therefore private.

## Why the obvious design fails

The design a reader reaches for first is simpler and shorter: export one `ValueHeap` from
`core/value`, one `HiddenClassRegistry` from `objects/maps`, one id counter from `optimizing/ir`,
and be done. No wrappers, no nesting, no `finally`. Every one of those modules already has
a module-level variable — `activeValueHeap` above is one — so the singleton is *already
there*; the only thing the wrapper adds is the ability to change it.

The program that breaks the singleton is not exotic. It is this book's own correctness
argument. `differential(source)` in `tests/helpers/tiers.ts` runs the same source once
through an `oracle` engine with the tiering thresholds set to `1e12` — so nothing ever
compiles — and then again through a `baseline` engine, a `jit` engine and an `osr` engine,
and compares the four answers ([Ch 79 § differential]). Those are four `Engine` instances
in one Node process. With module-level singletons they share a value heap, so a
`TaggedValue` minted by the oracle is a valid pointer inside the JIT engine's heap and
means something else; they share a hidden-class registry, so the oracle's `Series` map and
the JIT engine's `Series` map are the same object and the JIT's inline caches are warmed by
the oracle's run; they share the IR node-id counter, and [Ch 46 § sccp-unstamped-ids]
records what two nodes with the same id do to inference. The comparison stops being a
comparison.

Ambient-with-restore is a singleton you can nest. That is the entire reason it is worth the
seven levels of indentation: it is what lets the book check tier against tier at all.

## The seventh wrapper

Count the wrappers in `runInRuntime` and you get seven, not six. The innermost one is
different in kind:

```ts
  private hostAsyncBinding() {
    return {
      queue: this.microtaskQueue,
      drain: () => this.drainMicrotasks(),
      interpreter: this.interpreter,
      run: <T>(fn: () => T) => this.runInRuntime(fn),
    };
  }
```
— `src/api/engine.ts:813-820`

`withHostAsync` binds a four-field record, not a registry. Three of the fields are the
objects a host callback needs in order to re-enter tera — the microtask queue to enqueue on,
a way to drain it, and the interpreter to run frames in — and the fourth, `run`, is
`runInRuntime` itself, closed over `this`. That is what [Ch 28 § host-reentry-is-a-captured-function] captures:
`captureHostReentry()` reads `hostAsync?.run` and falls back to calling the function
straight if there is no binding (`src/runtime/domain/host.ts:78-81`). A host callback that
arrives on some later JavaScript stack — a `setTimeout`, a promise resolution inside a
sibling package — re-enters through that captured `run`, and so gets all six registries
back.

Which explains the `bindHost` parameter, and why it defaults to `true`. There is exactly
one situation in which it must be `false`: `hostAsyncBinding()` reads `this.interpreter`,
and the interpreter is *constructed* inside `runInRuntime`, at a point where
`this.interpreter` is still undefined. So the constructor passes `false` twice, at
`engine.ts:780-783` and `:785`, and every other call site takes the default. The boolean is
bootstrap, not policy. The thesis's "six" counts registries; the nesting is seven deep, and
the seventh is a binding.

## The constructor is an ordering

`Engine`'s constructor (`src/api/engine.ts:742-811`) reads at first like a list of
assignments. It is not; it is a topological order, and three of its edges are load-bearing.

```ts
    this.wireUnhandledRejectionReporter();
    this.gc = new GenerationalGC(options.gc || {}, this.valueHeap);
    this.interpreter = this.runInRuntime(
      () => new RegisterInterpreter(this) as EngineInterpreter,
      false,
    );
    this.installExtensionBuiltins();
    this.runInRuntime(() => this.installNativeModules(), false);
    this.sharedGlobals = new Set(this.interpreter.globalCells.cells.keys());
    this.interpreter.debugger = this.debugger;
    this.gc.bindRoots(
      this.interpreter,
      this.interpreter.globalCells,
      this.microtaskQueue,
    );
```
— `src/api/engine.ts:778-792`

**Extensions are resolved before the interpreter exists.** The first thing the constructor
does after the five registries is `resolveTeraExtensions(options.extensions)` at `:749`,
and it merges the result with the flat options — `syntaxPlugins`, `checker`, `compiler`,
`hostBuiltins`, `runtimeBuiltins` — before line 780. It has to: `installExtensionBuiltins`
at `:784` writes into `this.interpreter.globalCells`, which does not exist until `:780`,
and the interpreter's own constructor installs the engine's builtins first. So the order is
resolve, construct, then install on top.

**`sharedGlobals` is snapshotted after extension install.** Line 786 takes the key set of
the global cell map *as it stands*, which by then includes every extension global and every
native module cell. `sharedGlobals` is the set of names that survive a module reset — a
name in it is not cleared when a new module entry runs. Move line 786 one line up and a
plug-in's globals become per-module and vanish on the second entry. The dependency is
invisible in the code; it is entirely positional.

**`gc.bindRoots` needs three things that are constructed in three different places.** The
interpreter (its frame stack and suspended frames), the global cells, and the microtask
queue. That call at `:788-792` is the definition of the root set that [Ch 32 § a-root-is-a-field]
enumerates, and it cannot happen earlier because two of its three arguments do not exist
yet. `Engine` re-runs both `wireUnhandledRejectionReporter()` and `gc.bindRoots(...)` at
`:2018` and `:2026` when a runtime is reset, which is the tell that these two are
initialisation and not just assignment.

## Three hooks, three flags

`EngineOptions` (`src/api/engine.ts:106-133`) has twenty-six optional fields in four
groups: machinery (`backends`, `moduleFileSystem`, `typecheck`, `tieringPolicy`, `gc`,
`osr`, `compilerOptions`, …), tracing (`trace`, `traceCategories`, `onTrace`, `debugger`),
extension points (`extensions`, `syntaxPlugins`, `hostBuiltins`, `runtimeBuiltins`,
`compiler`, `checkerBuiltins`, `checkerAliases`, `checkerInterfaces`) and three lifecycle
hooks.

> **New idea. A lifecycle hook.** A hook is a function the caller supplies and the callee
> calls at a named moment, with the real object it was about to use. It is not a
> notification and not a log line: what distinguishes a hook from a message is that the
> argument is the live artifact, not a description of it. If the hook receives a string,
> the extension point is a logging API; if it receives the `RegisterCompiledFunction`, it
> is an extension point.

The three are `onCompile`, `onOptimize` and `onUnhandledRejection`, and each fires at
exactly one place.

`onCompile` fires from `reportCompiled`, which is four lines:

```ts
  private reportCompiled(compiled: RegisterCompiledFunction): void {
    if (!this.onCompile) return;
    for (const compiledFn of collectCompiledFunctions(compiled, true)) {
      if (!compiledFn.isLazy) this.onCompile(compiledFn);
    }
  }
```
— `src/api/engine.ts:1432-1437`

`collectCompiledFunctions(compiled, true)` walks the constant pool recursively, so a hook
set once sees `Series.mean`, `Series.label`, `Series`'s constructor and `report`, not just
the top-level function. `isLazy` functions are skipped — a function whose body has not been
compiled yet has nothing to disassemble.

`onOptimize` fires once per optimizing compilation, between the middle end finishing and
the wasm backend starting:

```ts
      this.optimizer.setCompilerExtensions(this.compilerExtensionsFor(compiledFn));
      const optimizerResult = this.optimizer.compile(compiledFn, null, this.compilerOptions);
      this.onOptimize?.(compiledFn, optimizerResult.graph);
```
— `src/api/engine.ts:1776-1778`

The line above the hook matters as much as the hook: `compilerExtensionsFor` is where
per-compile extension metadata is retrieved, and [Ch 29 § per-compile-extensions] returns to it.

`onUnhandledRejection` is not called directly at all. It is *wired*, once, in the
constructor:

```ts
  private wireUnhandledRejectionReporter(): void {
    const report = this.onUnhandledRejection;
    if (!report) {
      this.microtaskQueue.setUnhandledRejectionReporter(null);
      return;
    }
    this.microtaskQueue.setUnhandledRejectionReporter((rejections: UnhandledRejection[]) => {
      const infos = this.runInRuntime(() =>
        rejections.map(({ reason }) => ({
          reason: taggedToNative(reason),
          message: describeThrown(reason),
        })),
      );
      report(infos);
    });
  }
```
— `src/api/engine.ts:1578-1593`

Two details are worth stating. When no hook was given the engine installs `null` rather
than leaving the slot alone, so a reset engine does not keep a stale reporter. And the
mapping through `taggedToNative` happens *inside* `runInRuntime` — the rejection reason is
a `TaggedValue`, and converting it needs the value heap bound, on whatever host stack the
microtask drain happened to end on. Chapter 30 picks the queue up from here.

Now the payoff. Open `src/cli/main.ts` and look at what `--print-bytecode` and `--print-ir`
actually are:

```ts
  if (config.printBytecode) {
    options.onCompile = (fn: RegisterCompiledFunction) => {
      if (matchesFilter(config.filter, fn.name)) console.log(fn.disassemble());
    };
  }
  if (config.printIr) {
    options.onOptimize = (fn: RegisterCompiledFunction, graph: OptimizedGraph) => {
      if (matchesFilter(config.filter, fn.name)) console.log(printIR(graph));
    };
  }
```
— `src/cli/main.ts:88-97`

Two `console.log`s behind a substring filter. The third flag is the same shape:
`runProgram` sets `options.onUnhandledRejection` to a closure that reports and flips a
boolean, and returns `sawUnhandledRejection ? FAILURE_EXIT : 0` — the process exit code is
a hook's side effect (`src/cli/main.ts:182-201`).

So the d8-style inspection surface this book has been using since [Ch 3]
is not a CLI feature with privileged access to the engine's insides. It is three plug-ins,
each about four lines, using the same public options a third party gets. That is the
strongest available evidence that the hooks carry the real objects: `fn.disassemble()` and
`printIR(graph)` are the same functions the tests call.

Nothing in `tests/` pins that `--print-bytecode` is implemented as `onCompile` or
`--print-ir` as `onOptimize`. `[unpinned]` The hooks themselves are exercised —
`tests/optimizing/builder/top-level-graph.test.ts:39-40` sets both — but nothing ties the
flags to them.

```
$ node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
=== mean (params=0, locals=2, registers=5, constants=4) ===
Constants:
  [0] 0
  [1] "values"
  [2] "length"
  [3] 1
Locals: r0=total, r1=i
Instructions:
     0  LdaConst [0] (0)
     1  Star r0
```

## Six slots

`TeraExtension` is the record a plug-in hands the engine, and it is eight lines:

```ts
export type TeraExtension = {
  name: string;
  syntaxPlugins?: readonly SyntaxPlugin[];
  checker?: BindOptions;
  hostBuiltins?: NativeHostBuiltinRegistry;
  runtimeBuiltins?: BuiltinRegistryMap;
  modules?: readonly TeraNativeModule[];
  compiler?: TeraCompilerExtension;
};
```
— `src/api/extensions.ts:84-91`

Where each slot lands:

| slot | reaches | chapter |
| --- | --- | --- |
| `syntaxPlugins` | the parser's plug-in table | [Ch 6 § syntax-plugins] |
| `checker` | `BindOptions.builtins` / `.aliases` / `.interfaces` | [Ch 8 § the-root-scope-is-seeded-from-the-language-spec] |
| `hostBuiltins` | `hostBuiltin(name, fn)` → a global cell | [Ch 28 § host-bridge-taggedtonative-and-nativetotagged] |
| `runtimeBuiltins` | a raw `BuiltinRegistryEntry` → a global cell | [Ch 28 § install-is-one-loop-and-one-write] |
| `modules` | cells under `native:<name>`, plus a checker surface | [Ch 15 § two-edge-sets] |
| `compiler` | the optimizer | this chapter |

The first five install a **name**. After `syntaxPlugins`, a new form parses. After
`checker`, a name type-checks. After `hostBuiltins` or `runtimeBuiltins`, a name resolves
to a callable at run time. After `modules`, an import resolves. In every case the
optimizer's view of the resulting call is exactly what it would be for any opaque callee:
it may do anything, it may throw, it may write memory, so nothing may be moved across it
and nothing may be deleted. The sixth slot is the only one that changes that, and [Ch 29 § an-intrinsic-is-an-opcode]
and [Ch 29 § intrinsic-effects] are about how.

Three of the five installers are short enough to read whole. `installHostBuiltins`
(`:837-843`) wraps each JavaScript function in `hostBuiltin` — the marshalling wrapper from
[Ch 28 § marshalling-costs-a-copy] — and hands the result to `installBuiltinEntries`.
`installRuntimeBuiltins` (`:845-847`) is two lines, because a runtime builtin is already in
the registry's own shape and needs no wrapping. And `installExtensionBuiltins` is the
gate:

```ts
  private installExtensionBuiltins(): void {
    const needsRuntimeIntrinsics = this.compilerExtensions.intrinsics.some((intrinsic) => intrinsic.lowering === "runtime");
    if (!Object.keys(this.hostBuiltinRegistry).length && !Object.keys(this.runtimeBuiltinRegistry).length && !needsRuntimeIntrinsics) return;
    this.runInRuntime(() => {
      this.installRuntimeBuiltins(this.runtimeBuiltinRegistry);
      this.installRuntimeIntrinsics(this.runtimeBuiltinRegistry, this.compilerExtensions);
      this.installHostBuiltins(this.hostBuiltinRegistry);
    });
  }
```
— `src/api/engine.ts:886-894`

Note the order inside: runtime builtins go in *before* runtime intrinsics are registered,
because `installRuntimeIntrinsics` looks each intrinsic's payload up in the same registry
and throws if it is missing.

## Duplicate names throw

Two extensions both define a global called `sleep`. What happens?

Not last-write-wins, and not first-write-wins. The engine refuses to start.

```ts
export function mergeNamedExtensionItems<T extends { name: string }>(kind: string, ...sources: Array<readonly T[] | undefined>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const source of sources) {
    for (const value of source ?? []) {
      if (!value.name) throw new Error(`Unnamed ${kind}`);
      if (seen.has(value.name)) throw new Error(`Duplicate ${kind} '${value.name}'`);
      seen.add(value.name);
      out.push(value);
    }
  }
  return out;
}
```
— `src/api/extensions.ts:109-121`

`mergeExtensionRecords` (`:123-132`) is the same rule for the two slots that are records
rather than arrays, using `hasOwnProperty` instead of a `Set`. And
`resolveTeraExtensions` throws `Duplicate Tera extension '<name>'` (`:161`) before either,
so two copies of the same package fail earlier and with a better message than two
conflicting names inside them.

The invariant is: **installation order is never observable.** The enforcement is those
three throws — there is no code path in which a second definition of a name replaces a
first, because the merge functions are the only way anything reaches a registry, and every
one of them is called with the accumulated sources. The tests are
`[t: tests/e2e/api/engine-plugins.test.ts > "rejects duplicate extension names"]`, which
constructs an `Engine` with `{ name: "dupe" }` twice, and
`[t: tests/e2e/api/engine-plugins.test.ts > "rejects duplicate compiler metadata names"]`,
which does it three times over — duplicate intrinsics across two extensions, duplicate
guards and duplicate deopts within one — and asserts `/Duplicate compiler intrinsic/`,
`/Duplicate compiler guard/`, `/Duplicate compiler deopt/`.

The `kind` string is threaded through every call so the message names what collided:
`"syntax plugin"`, `"checker builtin"`, `"checker alias"`, `"checker interface"`, `"host
builtin"`, `"runtime builtin"`, `"native module"`, `"compiler intrinsic"`, `"compiler
effect metadata"`, `"compiler guard"`, `"compiler deopt"`, `"optimizer pass"`. Eleven
kinds, one function.

## What a name may be

`assertExtensionName` is the only validation in `extensions.ts`:

```ts
function assertExtensionName(name: string): void {
  if (!name || !/^[A-Za-z0-9_.@/-]+$/.test(name)) {
    throw new Error(`Invalid Tera extension name '${name}'`);
  }
}
```
— `src/api/extensions.ts:103-107`

Permissive enough for a scoped npm name like `@slexisvn/reactive`; strict enough that a
name with a colon, a space or a newline in it cannot end up inside a cell key by accident.
It is applied to the extension's own name only, at `resolveTeraExtensions:160` — the names
of the things *inside* an extension are checked for emptiness and for collision, never for
shape.

## Pass ordering

The `compiler` slot may carry `optimizerPasses`, each a `{ name, phase, order?, run }`
record. Ordering among them is decided once, at merge time:

```ts
function compareOptimizerPasses(left: TeraOptimizerPass, right: TeraOptimizerPass): number {
  return orderRank(left.order) - orderRank(right.order);
}

function orderRank(order: TeraOptimizerPass["order"]): number {
  if (order === "early") return 0;
  if (order === "late") return 2;
  return 1;
}
```
— `src/api/extensions.ts:191-199`

`mergeCompilerExtensions` sorts the merged array with that comparator (`:140`), and
`Array.prototype.sort` is stable, so passes of equal rank keep the order their extensions
were listed in. `[t: tests/e2e/api/engine-plugins.test.ts > "orders compiler passes by
extension order hints"]` pins it.

> **New idea. Phase ordering.** In a compiler, *which* passes run matters less than *in
> what order*. A pass that folds constants exposes work for a pass that deletes dead code,
> which exposes more constants; run them in the wrong order and each finds nothing. The
> problem of choosing the order is called phase ordering, and it has no general solution —
> LLVM and V8 both hard-code a sequence arrived at by measurement. [Ch 41 § the-pipeline]
> is where tera's own sequence is laid out.

Running a pass is the other half, and both `Engine` and `Optimizer` have their own copy of
it:

```ts
  runCompilerPasses<T>(phase: TeraCompilerPhase, target: T, compiler = this.compilerExtensions): T {
    let current: unknown = target;
    const context = {
      phase,
      intrinsics: compiler.intrinsics,
      effects: compiler.effects,
      guards: compiler.guards,
      deopts: compiler.deopts,
    };
    for (const pass of compiler.optimizerPasses) {
      if (pass.phase !== phase) continue;
      const next = pass.run(current, context);
      if (next !== undefined) current = next;
    }
    return current as T;
  }
```
— `src/api/engine.ts:923-939`

A pass that returns `undefined` is treated as having mutated in place; a pass that returns
a value replaces the target. Four phases are declared and all four are driven:
`"ast"` on the freshly parsed tree and `"semantic"` on `analyzeEffects(parsed)`
(`engine.ts:1209-1210` for a single source, `:1252-1253` for a module record), `"bytecode"`
on `compiler.compile(ast)` (`:1215`, `:1264`), and `"ir"` from the optimizer's own copy at
`src/optimizing/optimizer.ts:169`.

Now the limit, stated honestly. `order` sequences extension passes *among themselves*, at a
fixed point in the host pipeline. It does not interleave a plug-in pass with the engine's
own. For `"ir"` that fixed point is one line:

```ts
    graph = this.runCompilerPasses("ir", graph);
```
— `src/optimizing/optimizer.ts:169`

— after `graph.rebuildUses()` and `eliminateUnreachableBlocks(graph)` and before the OSR
transform, `buildFrameStateIndex` and the whole of `runMiddleEnd`. An extension pass sees a
graph that has been built and cleaned and nothing else. There is no way to ask for
"after inlining" or "before scalar replacement".
`[t: tests/e2e/api/engine-plugins.test.ts > "runs extension compiler passes without changing
the default pipeline"]` is the pin, and its title states the boundary precisely: the pass
runs, and the engine's own output is unchanged.

> **Unfinished.** `order` is three values with no tie-break and no relation to the host
> pipeline. `orderRank` (`src/api/extensions.ts:195-199`) maps early/normal/late to 0/1/2
> and stable sort keeps insertion order within a rank. Making "after the engine's inliner"
> expressible means naming the built-in passes in the public type — thirty-four middle-end
> steps on the JIT road ([Ch 41 § the-pipeline]) — which is the reason it has not been done.

> **Unenforced.** Nothing validates a pass's `phase` against the phases anyone drives.
> `TeraCompilerPhase` (`src/api/extensions.ts:7`) has four members and
> `runCompilerPasses` filters with `pass.phase !== phase`, so a pass whose phase is
> misspelled — or is a valid member nobody drives on the road being taken — silently never
> runs, with no diagnostic. `mergeCompilerExtensions` already inspects every pass at
> construction time and is the obvious place to check.

> **Unfinished.** Duplicated pass runner. `Engine.runCompilerPasses`
> (`src/api/engine.ts:923-939`) and `Optimizer.runCompilerPasses`
> (`src/optimizing/optimizer.ts:78-93`) have the same body over different fields — the
> optimizer's reads `this.compilerExtensions`, the engine's takes a parameter with a
> default. One shared helper taking `Required<TeraCompilerExtension>` would remove the
> copy; nothing currently keeps the two in step.

## An intrinsic is an opcode

Here is the difference between a plug-in that adds a name and a plug-in that adds
knowledge, in bytecode.

A `runtimeBuiltin` installs a `TaggedValue` in a global cell. Calling it compiles to a
global load into a register, then a generic `Call` against whatever that register holds. To
the IR builder that is an `IR_CALL` with an unknown callee, and the effect system has to
assume the worst.

An **intrinsic** is a `TeraIntrinsicSpec` — `{ name, phase?, lowering?, parameters?,
returns?, effects?, reads?, writes?, allocates?, guards?, deopts?, fallback?, description? }`
(`src/api/extensions.ts:26-40`). Declaring one with `lowering: "runtime"` does two things.
First, `installRuntimeIntrinsics` registers the payload on the interpreter under its name:

```ts
  private installRuntimeIntrinsics(registry: BuiltinRegistryMap, compiler: Required<TeraCompilerExtension>): void {
    for (const intrinsic of compiler.intrinsics) {
      if (intrinsic.lowering !== "runtime") continue;
      const entry = registry[intrinsic.name];
      if (!isRuntimeFunctionPayload(entry)) {
        throw new Error(`Runtime intrinsic '${intrinsic.name}' is not installed`);
      }
      this.interpreter.installRuntimeIntrinsic(intrinsic.name, entry);
      this.sharedGlobals.add(intrinsic.name);
    }
  }
```
— `src/api/engine.ts:849-860`

Second, the bytecode compiler stops emitting a global load. When
`isRuntimeIntrinsicCallee(this, node.callee)` holds and the call has no spread and no named
arguments, `compileCallExpression` writes the arguments into contiguous registers and emits
one instruction (`src/bytecode/register/compiler/expressions.ts:523-537`):

```
ROP_CALL_INTRINSIC   nameConstant  firstArgReg  argCount
```

`ROP_CALL_INTRINSIC` is `0x92`, disassembled as `CallIntrinsic`
(`src/bytecode/register/ops/bytecode.ts:121, 293`). The interpreter executes it by looking
the name up in `runtimeIntrinsics` and calling the payload
(`src/bytecode/register/interpreter/index.ts:1861-1870`, via `callRuntimeIntrinsic` at
`:732-736`). There is no callee register, so there is nothing for the IR builder to be
uncertain about: the name is a constant in the pool.

The IR builder turns it into `IR_CALL_INTRINSIC`, whose signature row is
`call(variadic(0), RESULT_HANDLE, declaredReturnTransfer)`
(`src/optimizing/ir/operations.ts:88, 974`). That is the whole point of the detour: the
optimizer has a *row* for this node, and rows are what passes reason about.
`[t: tests/e2e/api/engine-plugins.test.ts > "lowers runtime intrinsics to a dedicated
bytecode call opcode"]` pins the emission;
`[t: tests/e2e/api/engine-plugins.test.ts > "runs runtime intrinsic bytecode through the
optimized JIT tier"]` pins that the opcode survives all the way to tier 2.

> **Unenforced.** `installRuntimeIntrinsics` checks only `lowering: "runtime"`. An
> intrinsic declared `lowering: "global"` — or with `lowering` omitted, which is the
> default — is never checked against the builtin registry at all, so a spec naming a
> function nobody installed produces no error at construction, and no `CallIntrinsic`
> either: the call compiles as an ordinary global load, and fails at run time if the name
> does not resolve.
> `[t: tests/e2e/api/engine-plugins.test.ts > "rejects runtime intrinsic lowering without a
> runtime handler"]` pins the case that *is* checked, and by its title says so. Note that
> the interpreter's own `callRuntimeIntrinsic` throws the same sentence,
> `Runtime intrinsic '<name>' is not installed`, from a different place and at a different
> time.

## Intrinsic effects

The node exists. What makes it *optimizable* is one file, and this is the whole mechanism
by which a plug-in teaches the optimizer:

```ts
export function intrinsicCallMetadata(name: string, argCount: number, metadata: IntrinsicOptimizationMetadata = EMPTY_INTRINSIC_METADATA): ir.IRMetadata {
  const intrinsic = metadata.intrinsics.get(name);
  const effects = intrinsic?.effects ?? ["unknown"];
  const props: ir.IRMetadata = {
    name,
    argCount,
    intrinsic: true,
    declaredEffects: [...effects],
  };
  if (ir.isReadOnlyDeclaredEffects(effects)) props.readonly = true;
```
— `src/optimizing/metadata/intrinsics.ts:19-28`

The rest of the function (`:29-38`) copies `reads`, `writes`, `allocates`, `guards`,
`deopts`, `fallback` and `returns` onto the node when the spec supplies them. The IR
builder spreads the result into the node's props at
`src/optimizing/builder/ir-builder.ts:1663-1665`.

Two props do the work. `declaredEffects` is read by `declaredCallEffects`
(`src/optimizing/ir/operations.ts:318-320`), which is how the alias and motion machinery
in [Ch 43 § effects] answers "may this node be moved across that one". `readonly` is set
when `isReadOnlyDeclaredEffects` holds — reads something, writes nothing, allocates nothing
(`src/optimizing/ir/operations.ts:313-316`) — and it is the flag that lets dead-code
elimination delete a node whose result nobody uses ([Ch 44 § dce]) and lets global value
numbering collapse two identical calls into one ([Ch 45 § gvn]).

This is the same pair of props [Ch 28 § builtin-metadata-what-the-second-table-buys] stamps on the engine's own
builtins. The engine's builtins and a third party's intrinsics reach the optimizer through
*the same two fields*; there is no privileged internal path.

Here is the whole plug-in that proves it, from the test suite:

```ts
      runtimeBuiltins: {
        __test_pure_note: {
          name: "__test_pure_note",
          call(args) {
            calls++;
            return args[0];
          },
        },
      },
      compiler: {
        intrinsics: [{
          name: "__test_pure_note",
          phase: "bytecode",
          lowering: "runtime",
          parameters: ["value"],
          returns: "int",
          effects: ["pure"],
        }],
      },
      tieringPolicy: { baselineThreshold: 2, jitThreshold: 4 },
```
— `tests/e2e/api/engine-plugins.test.ts:336-355`

The program is a function `hot(value)` that calls `__test_pure_note(value)`, discards the
result, and returns `value + 1`; it is called eight times with the thresholds set low
enough that the JIT takes over partway through. The assertion is not a graph inspection.
It is a counter:

```
expect(calls).toBeGreaterThan(0);
expect(calls).toBeLessThan(8);
```

Eight written calls, fewer than eight executions of the payload. Nothing deleted the calls
the interpreter and baseline made; the optimizing tier deleted the ones it compiled,
because `effects: ["pure"]` set `readonly`, and `readonly` is what DCE consults.
`[t: tests/e2e/api/engine-plugins.test.ts > "eliminates unused pure runtime intrinsic calls
in optimized code"]`. Its sibling does the same for GVN:
`__test_pure_id(value) - __test_pure_id(value)` written sixteen times over a loop of eight,
asserted `toBeLessThan(16)`
`[t: tests/e2e/api/engine-plugins.test.ts > "common-subexpressions identical pure runtime
intrinsic calls in optimized code"]`. And
`[t: tests/e2e/api/engine-plugins.test.ts > "projects runtime intrinsic effect metadata into
IR optimizer passes"]` checks the props themselves reach the graph.

The conservative default is the other half. An unregistered name gets `["unknown"]`, which
is the top of the effect lattice: reads everything, writes everything. A call the engine
knows nothing about is never accidentally eliminated.

> **Unenforced.** `effects: ["pure"]` is taken on trust. `intrinsicCallMetadata` sets
> `props.readonly` from the declaration alone; nothing observes the payload's `call` to
> check it, and nothing could cheaply — the payload is arbitrary JavaScript. A plug-in that
> declares a printing function pure gets its output silently deleted at tier 2 while tier 0
> and tier 1 still print: a tier divergence the plug-in author causes and the engine cannot
> detect. The `["unknown"]` default guards the *unregistered* name; it does nothing about a
> declared lie. Cost to close it: there is no cheap version. A debug mode that ran declared-pure
> intrinsics twice and compared results would catch impurity that shows in the return value
> and miss impurity that shows on a side channel, which is the interesting case.

> **Never runs.** `TeraCompilerExtension.guards`, `.deopts` and `.effects`
> (`src/api/extensions.ts:71-73`) are carried from `resolveTeraExtensions` into the
> `TeraOptimizerPassContext` at `src/api/engine.ts:928-930` and
> `src/optimizing/optimizer.ts:83-85`, and read nowhere else in `src/` — `grep -rn
> "context.guards\|context.deopts\|context.effects" src/` returns nothing. The engine's own
> passes never consult a plug-in's `TeraGuardSpec` or `TeraEffectMetadata`; only an
> extension pass can, and only about metadata it supplied itself.
> `[t: tests/e2e/api/engine-plugins.test.ts > "exposes guard and deopt metadata to IR
> optimizer passes"]` pins exactly that and no more: a pass pushes `context.phase`,
> `context.guards[0].name` and `context.deopts[0].name` into an array and the test asserts
> the array — visibility, not effect. The near-miss is worth naming: `TeraIntrinsicSpec.effects`
> *is* consumed, at `src/optimizing/metadata/intrinsics.ts:21`. Two fields called `effects`
> on the same surface, with completely different fates.

## Per-compile extensions

`compile(source, { compiler })` lets a caller add intrinsics for one compilation.
`compileCompilerExtensions` (`:908-910`) merges the call-site extension over the
engine-wide one, using the same `mergeCompilerExtensions` — so a per-call duplicate throws
just like a construction-time one.

But tiering happens later. The function is compiled to bytecode now, and reaches the
optimizer eight or fifty calls later, on a different host stack, with the call-site options
long out of scope. So the metadata is attached to the function object:

```ts
  private rememberCompilerExtensions(compiledFn: RegisterCompiledFunction, compiler: Required<TeraCompilerExtension>): void {
    this.functionCompilerExtensions.set(compiledFn, compiler);
    for (const constant of compiledFn.constants) {
      if (isCompiledFunction(constant)) this.rememberCompilerExtensions(constant, compiler);
    }
  }

  private compilerExtensionsFor(compiledFn: RegisterCompiledFunction): Required<TeraCompilerExtension> {
    return this.functionCompilerExtensions.get(compiledFn) ?? this.compilerExtensions;
  }
```
— `src/api/engine.ts:912-921`

`functionCompilerExtensions` is a `WeakMap<RegisterCompiledFunction,
Required<TeraCompilerExtension>>`, so the record is dropped when the function is. The walk
into `compiledFn.constants` is what makes nested functions work: a lambda inside the
compiled source is a constant in its parent's pool, and gets the same metadata. And
`compilerExtensionsFor` falls back to the engine-wide record when the map has no entry, so a
function that reached the optimizer by some route other than `compileInRuntime` still gets
metadata rather than none. `rememberCompilerExtensions` itself is called unconditionally on
every compile — at `:1216` for a single source, `:1268` for a module record and `:1667` for
a lazily compiled function — because the merge has already happened by then and the
engine-wide record is what it stores in the common case. It is read at exactly one place,
the line before `onOptimize` fires
(`:1776`). `[t: tests/e2e/api/engine-plugins.test.ts > "uses per-compile runtime intrinsic
metadata for optimized functions"]`.

## Native modules are namespaces

The fifth slot adds an importable module rather than a global:

```ts
  private installNativeModules(): void {
    for (const module of this.nativeModules) {
      const spec = `${NATIVE_PREFIX}${module.name}`;
      const entries: BuiltinRegistryMap = {};
      for (const [name, fn] of Object.entries(module.hostExports ?? {})) {
        entries[name] = hostBuiltin(name, fn);
      }
      for (const [name, entry] of Object.entries(module.runtimeExports ?? {})) {
        entries[name] = entry;
      }
      for (const [name, entry] of Object.entries(entries)) {
        this.interpreter.globalCells.write(cellKey(spec, name), builtinValue(name, entry));
      }
    }
  }
```
— `src/api/engine.ts:861-876`

`NATIVE_PREFIX` is `"native:"` (`src/frontend/modules/resolver.ts:6`) and `cellKey`
(`src/runtime/intrinsics/global-cells.ts:11`) joins a module spec to a name. So a native
module's exports live under `native:<name>` keys, not in the flat global namespace: two
modules may both export `mean` without colliding, and neither shadows a user's `mean`.
Note the mixed shape — `hostExports` are wrapped in `hostBuiltin` and marshalled,
`runtimeExports` are taken as-is, and both end up in the same cell namespace.

The checker half is `nativeModuleInterfaces` (`:877-884`), which hands each module's
`ExternalModuleSurface` to the checker under the same `native:<name>` key. That is what
makes `from native:charts import bar` type-check without the module existing on disk — the
same two-graph module story as [Ch 15 § two-edge-sets], with the second graph supplied by a
plug-in.

## The full surface: @slexisvn/reactive

One package in `node_modules` fills five of the six slots at once, and it is the only
extension the CLI installs. Following [Conventions § 19], its internals are not this book's
subject; the shape of the socket it plugs into is.

`@slexisvn/reactive/tera` exports `createReactiveTeraExtension(converters)` returning a
`TeraExtension`, and `createReactiveTeraOptions(converters)` returning
`Pick<EngineOptions, "extensions">`. Inside the extension: a syntax plugin
(`reactiveSyntaxPlugin`), checker metadata (`reactiveCheckerMetadata`,
`reactiveCheckerBuiltins`), host builtins (`createReactiveHostBuiltins`), runtime builtins
(`createReactiveRuntimeBuiltins`), and a compiler extension (`reactiveCompilerMetadata`)
carrying fourteen intrinsic names — `REACTIVE_INTRINSICS`, all of the form
`__tera_reactive_*`, for `signal`, `read`, `write`, `update`, `computed`, `effect`,
`resource`, `batch`, `untrack`, `watch`, `peek`, `get`, `mutate` and `refetch`
(`node_modules/@slexisvn/reactive/dist/tera/index.d.ts:149-164`) — plus one optimizer pass:

```js
var reactiveOptimizerPass = {
  name: "reactive-lower-to-intrinsics",
  phase: "ast",
  order: "late",
  run(target) {
    return target && typeof target === "object" && target.type === "Program" ? rewriteProgram(target) : target;
  }
};
```
— `node_modules/@slexisvn/reactive/dist/tera/index.js:535-542`

That is the pattern in miniature: a `"late"` `"ast"` pass rewrites `signal(x)` into
`__tera_reactive_signal(x)` before the checker or the bytecode compiler ever sees it, and
the intrinsic specs tell the optimizer what those fourteen names do. Sugar in the front,
declared effects in the back.

The CLI's entire relationship with the plug-in system is sixteen lines:

```ts
import { createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import type { EngineOptions } from "../api/engine.js";
import type { TeraExtension } from "../api/extensions.js";
import { nodeModuleFileSystem } from "../frontend/modules/node-file-system.js";
import { createBackendRegistry } from "../optimizing/backends/index.js";
import { nativeToTagged, taggedToNative } from "../runtime/domain/host.js";

export function hostEngineOptions(): EngineOptions {
  const base = createReactiveTeraOptions({ nativeToTagged, taggedToNative });
  return {
    ...base,
    extensions: [...((base.extensions as TeraExtension[]) ?? [])],
    backends: createBackendRegistry(),
    moduleFileSystem: nodeModuleFileSystem,
  };
}
```
— `src/cli/host.ts:1-16`

The two converters the package needs are handed *in* — `nativeToTagged` and
`taggedToNative` from [Ch 28 § marshalling-costs-a-copy] — because the package must not link against the
engine's value representation. That is the boundary: the socket is two functions wide.

`[t: tests/e2e/api/engine-plugins.test.ts > "accepts named extension presets"]` pins the
`extensions: [...]` form as distinct from the flat `hostBuiltins` / `compiler` options, and
`[t: tests/e2e/api/engine-plugins.test.ts > "installs host builtins in the engine heap"]`
and `[t: tests/e2e/api/engine-plugins.test.ts > "bridges Tera callbacks to host functions"]`
pin the two directions a value crosses.

## What the running example does not need

`stats.tera` runs under `hostEngineOptions()` like everything else the CLI runs. So the
reactive extension is resolved, its fourteen intrinsic specs are merged, its syntax plugin
is installed on the parser, its checker metadata is merged into `BindOptions`, and its
runtime builtins are written into global cells. The program then calls none of it. Twenty-four
lines of arithmetic over two `float[]`s reach two builtins and no intrinsic.

What that costs, stated as code rather than as a measurement: one `resolveTeraExtensions`
call per `Engine`, which walks the extension array once and builds seven arrays and two
records; the merges; and one `RegisterInterpreter` construction that installs a few more
global cells than it otherwise would. `installExtensionBuiltins` returns at its second line
when all three registries are empty (`src/api/engine.ts:888`) — but with the reactive
extension present they are not empty, so the early return does not fire in the CLI. No
benchmark harness exists in this tree ([Conventions § 9]), so nothing here is a performance
claim; it is a description of what runs.

The one thing the spine genuinely cannot show is the payoff. `stats.tera` has no plug-in
call to eliminate, so the chapter's worked example is the `__test_pure_note` program in
`tests/e2e/api/engine-plugins.test.ts` rather than a ninth variation file
([Conventions § 2]).

## What leaves

A constructed `Engine`, and three parts of it that chapter 30 uses immediately.

**`runInRuntime` as the re-entry point.** Every entry into tera goes through it, and — this
is the part that matters next — so does every *resumption*. `hostAsyncBinding()`'s `run`
field is `runInRuntime` itself, and `captureHostReentry()` grabs it. When a promise settles
on a host stack that the engine did not initiate, the six registries come back through that
captured closure or not at all.

**A `MicrotaskQueue`**, constructed at `engine.ts:775-777` with
`options.microtaskPolicy || MicrotaskPolicy.AUTO`, reachable from host code as
`hostAsyncBinding().queue`, and drainable through `hostAsyncBinding().drain`, which is
`engine.drainMicrotasks()`. It is also one of the three arguments to `gc.bindRoots`, which
is how it became part of the root set.

**A reporter in that queue's slot.** `microtaskQueue.setUnhandledRejectionReporter(...)` is
wired to whatever the caller passed as `onUnhandledRejection`, or to `null` if nothing was
passed, and the conversion from `TaggedValue` to host value happens inside `runInRuntime`.

`[Ch 30 § what-await-is-not]` takes that queue and runs the first `await` through it —
`docs/example/stats-async.tera`, three awaits, four microtasks — and finds that the only
thing keeping a suspended function's registers alive is an entry in a `Map`.

## Verify it yourself

```bash
# --print-bytecode is onCompile: the hook receives the real RegisterCompiledFunction
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera | sed -n '1,12p'

# --print-ir is onOptimize: the hook receives the real CFGFunction.
# stats.tera never tiers up, so this needs a program that does.
# Write hot2.tera with an editor, outside the repo, and run:
#   fn tot(n: int) -> int:
#     s = 0
#     i = 0
#     while i < n:
#       s += i
#       i += 1
#     return s
#   i = 0
#   while i < 100:
#     tot(50)
#     i += 1
#   print(tot(200))
node dist/cli.js --print-ir --filter tot hot2.tera | head -14

# onUnhandledRejection is the process exit code.
# Write rej.tera with an editor:
#   async fn boom() -> int:
#     throw("nope")
#     return 1
#   boom()
#   print("done")
node dist/cli.js rej.tera; echo "exit=$?"

# the chapter's worked example: eight written calls, fewer than eight executed
npx vitest run --project e2e tests/e2e/api/engine-plugins.test.ts \
  -t "eliminates unused pure runtime intrinsic calls in optimized code"

# the whole extension contract, executable
npx vitest run --project e2e tests/e2e/api/engine-plugins.test.ts

# guards, deopts and effects on the extension surface reach nothing
grep -rn "context.guards\|context.deopts\|context.effects" src/
```

What those print. The `mean` disassembly, headed
`=== mean (params=0, locals=2, registers=5, constants=4) ===`. Then `fn tot params=1 {`
followed by a `graph [declaredSignature=…, osrCandidates=…]` line and the SSA blocks.
Then:

```
$ node dist/cli.js rej.tera
done
Uncaught (in promise) nope
exit=1
```

— `done` first, because the rejection is not decided until the queue goes quiet. Then
`Tests 1 passed | 14 skipped (15)`, then `Tests 15 passed (15)`. The `grep` prints nothing,
which is the `> **Never runs.**` item above.

## Tests that pin this

- `tests/e2e/api/engine-plugins.test.ts` > `"installs host builtins in the engine heap"`
  — the `hostBuiltins` slot reaches a global cell.
- `tests/e2e/api/engine-plugins.test.ts` > `"bridges Tera callbacks to host functions"`
  — a tera closure crossing out through `taggedToNative` ([Ch 28 § marshalling-costs-a-copy]).
- `tests/e2e/api/engine-plugins.test.ts` > `"accepts named extension presets"`
  — the `extensions: [...]` form as distinct from the flat options.
- `tests/e2e/api/engine-plugins.test.ts` > `"runs extension compiler passes without changing the default pipeline"`
  — a plug-in `"ir"` pass runs and the engine's own output is unchanged.
- `tests/e2e/api/engine-plugins.test.ts` > `"orders compiler passes by extension order hints"`
  — `orderRank`, early before normal before late.
- `tests/e2e/api/engine-plugins.test.ts` > `"exposes guard and deopt metadata to IR optimizer passes"`
  — visibility only. See the `> **Never runs.**` item in [Ch 29 § intrinsic-effects].
- `tests/e2e/api/engine-plugins.test.ts` > `"lowers runtime intrinsics to a dedicated bytecode call opcode"`
  — `ROP_CALL_INTRINSIC` instead of a global load plus a call.
- `tests/e2e/api/engine-plugins.test.ts` > `"runs runtime intrinsic bytecode through the optimized JIT tier"`
  — the opcode survives to tier 2.
- `tests/e2e/api/engine-plugins.test.ts` > `"projects runtime intrinsic effect metadata into IR optimizer passes"`
  — `intrinsicCallMetadata`'s props reach the graph.
- `tests/e2e/api/engine-plugins.test.ts` > `"eliminates unused pure runtime intrinsic calls in optimized code"`
  — the worked example: eight written calls, `calls < 8`.
- `tests/e2e/api/engine-plugins.test.ts` > `"common-subexpressions identical pure runtime intrinsic calls in optimized code"`
  — sixteen written calls, `calls < 16`.
- `tests/e2e/api/engine-plugins.test.ts` > `"uses per-compile runtime intrinsic metadata for optimized functions"`
  — the `functionCompilerExtensions` `WeakMap`.
- `tests/e2e/api/engine-plugins.test.ts` > `"rejects runtime intrinsic lowering without a runtime handler"`
  — the one install-time check, and the only `lowering` value it covers.
- `tests/e2e/api/engine-plugins.test.ts` > `"rejects duplicate extension names"`
  — `resolveTeraExtensions`.
- `tests/e2e/api/engine-plugins.test.ts` > `"rejects duplicate compiler metadata names"`
  — `mergeNamedExtensionItems`, three kinds in one test.
- Nothing pins that `--print-bytecode` and `--print-ir` are implemented as `onCompile` and
  `onOptimize`, that `runInRuntime` restores the previous ambient bindings when the body
  throws, or that `sharedGlobals` must be snapshotted after extension install rather than
  before. `[unpinned]`
