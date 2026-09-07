# 75. The debugger   ⟨**I** · B · J · N⟩

> **Status:** outline

**Thesis.** A debugger is a callback on the interpreter's fetch step plus a way to read a
frame — and because a JavaScript-hosted dispatch loop cannot be suspended, the callback has
to be *synchronous*, which decides everything else: what a pause can contain, how a step is
implemented, which tier you are allowed to be running in, and what a graphical front end
must do to survive.

**What arrived.** An `Engine` driven a statement at a time, and the two ways chapter 74
found to ask what a name means: `Engine.introspectMembers` reading *live* values out of
`interpreter.globalCells`, and a `SourceSymbolTable` answering from text ([Ch 74 §
completion-layer-one]). The debugger asks the first of those questions of a *frame* rather
than of a global.

**What leaves.** `DebugPauseEvent` — one plain, structured-cloneable record of a single
moment: `reason`, `location`, `breakpoint`, and a `DebugSnapshot` holding every active frame's
locals and the whole global cell map, all already reduced to strings and numbers. It is
produced by a synchronous hook that *does* perturb what it observes (`forceInterpreter`
pins the program to tier zero). Chapter 76 records the compiler instead of the program with
six hooks of the same shape, and must not perturb it at all.

**New ideas.** A *hook* on the fetch–decode–execute loop; a source map as a `pc` → `(line,
column)` table; a *snapshot* as a deep copy taken because a live pointer would go stale; a
*call frame* and *frame depth*; a stepping mode expressed as a predicate over depth; the
Debug Adapter Protocol as a request/response bus; `SharedArrayBuffer` and `Atomics.wait` as
the only way one JavaScript thread can block on another.

**Length.** 14 pages

## Anchors

- `src/debugger/runtime.ts` — `RuntimeDebugger` (100-104: exactly three members),
  `DebugController` (408-546), `DebugCommand`/`DebugPauseReason` (28-29),
  `DebugSourceLocation` (31-38), `DebugBreakpoint` (40-46), `DebugValueSnapshot`/
  `DebugPropertySnapshot`/`DebugBindingSnapshot`/`DebugFrameSnapshot`/`DebugSnapshot`
  (48-81), `DebugPauseEvent` (83-88), `DebugRuntimeView` (90-96), `DebugPauseHandler` (98),
  `StepState` (108-112), `BreakpointSkipState` (114-118), the four constants
  `BREAKPOINT_ANY_COLUMN = -1`, `KEY_SEPARATOR` (`"\u0000"`), `MAX_DEBUG_CHILDREN = 64`,
  `MAX_DEBUG_DEPTH = 2` (23-26), `DEBUG_EVAL_SOURCE = "<eval>"` (21).
- `src/debugger/runtime.ts` — the key functions: `sourceLocation` (157-173),
  `taggedValueSnapshot` (219-251), `visibleObjectProperties` (179-217),
  `registerValueSnapshot` (253-258), `slotValueSnapshot` (260-275), `frameSnapshot`
  (277-300), `globalSnapshots` (302-316), `runtimeSnapshot` (318-331), and the three key
  builders `breakpointKey` (132-134), `stepLocationKey` (145-151),
  `breakpointLocationKey` (153-155).
- `src/debugger/runtime.ts` — `DebugBreakpointStore` (333-406): `byId`/`byKey`, `set`,
  `delete`, `deleteAt`, `match` (392-398, exact column first then any-column), `matchKey`.
- `src/debugger/runtime.ts` — `DebugController.beforeInstruction` (469-507), `stepHit`
  (509-514), `setStep` (516-528), `applyCommand` (530-545), and the state it owns:
  `stepState`, `breakpointSkip`, `entryConsumed`, `lastPause`.
- `src/bytecode/register/interpreter/index.ts:1398` — `this.debugger?.beforeInstruction(this,
  frame, frame.pc)`, the first statement of the `runFrame` dispatch loop, *before* the
  opcode is read and before `frame.pc++`.
- `src/bytecode/register/interpreter/index.ts:348-353` — `debuggerForcesInterpreter`, and
  its four call sites: `tryTierUp` (486, returns `null`), the `CALL_OPTIMIZED` path (585),
  `execute` (925) and the closure-call path (1168).
- `src/api/engine.ts:2039-2041` — `Engine.setDebugger`, which writes both `this.debugger`
  and `this.interpreter.debugger`.
- `src/debugger/index.ts` — `TeraDebugSession` (18-68) with `engine`, `controller` and a
  `pauses` array; `TeraDebugSessionOptions` is `Omit<EngineOptions, "debugger">` plus five
  fields, and `dispose()` is `setDebugger(null)`.
- `src/cli/debug.ts` — `runDebug` (194-227), `promptDebugCommand` (180-192),
  `parseDebugCommand` (115-178), `parseLocation` (103-113), `resolveSource` (95-101),
  `withForwardSlashes` (91-93), `printPause` / `printLocals` / `printBacktrace` /
  `printDebugHelp`, `DebugQuit`, `sourceCache`, `DEBUG_PROMPT = "(tera-debug) "`.
- `vscode-ext/src/client/debug/worker.ts` — `waitForDebugCommand` (47-56),
  `commandFromCode` (31-45), `pauseHandler` (173-177), `shouldStopAtBreakpoint` (144-171),
  `conditionPasses` (117-128), `hitConditionPasses` (102-115), `formatLogMessage`
  (130-142), `applyBreakpoints` (73-87), `eventBreakpointSpec` (89-100), `startDebug`
  (179-216), and the six command codes plus `STATE_COMMAND`/`STATE_PAUSE` (11-18).
- `vscode-ext/src/client/debug/adapter.ts` — `TeraDebugAdapter` (113+), its
  `commandState = new Int32Array(new SharedArrayBuffer(...))` (116), the `initialize`
  capability set (146-157), the `pause` request storing `STATE_PAUSE` (221), and
  `resumeWorker` doing `Atomics.store` + `Atomics.notify` (463-464).
- `vscode-ext/src/client/debug/paths.ts` — `normalizeDebugPath` (file URLs, relative
  resolution, then `realpathSync.native`), `hasUnresolvedVariablePath`.
- `vscode-ext/src/client/debug/evaluate.ts` — `evaluateDebugExpression`: a 340-line
  expression evaluator over `DebugBindingSnapshot[]` with no call syntax at all.
- `src/bytecode/register/ops/bytecode.ts` — `SourceMapEntry`, the `sourceMap` array indexed
  by `pc`.
- `src/bytecode/register/interpreter/frame.ts` — `RegisterFrame` (`registers`, `acc`,
  `hasUpvalues`, `openUpvalues`, `getReg`, `compiledFn`), `RegisterValue`,
  `isTDZUninitialized`.

## Worked example

`tests/e2e/debugger/debugger.test.ts` >
`"does not re-hit a continued breakpoint after returning from a callee on the same line"`,
reproduced by deleting the `breakpointSkip` assignment from `applyCommand`'s `continue`
branch (`src/debugger/runtime.ts:531-537`). With that one object literal removed, three of
the six debugger tests fail and the chapter's point is visible in the diff:

```
- expected [ 4, 4, 4, 4, 4, 4 ] to deeply equal [ 4 ]     (the named test)
- expected [ Array(7) ] to have a length of 1 but got 7   ("pauses on line breakpoints…")
- expected [ Array(2) ] to have a length of 1 but got 2   ("offers a session wrapper…")
```

The honest reading is broader than the test title: `breakpointSkip` is not only about
returning from a callee. Because `beforeInstruction` fires *per instruction* and a
breakpoint is keyed *per line*, a single `b 4` matches every one of the six instructions
`y: int = inc(x)` compiles to. `breakpointSkip` is what turns a per-instruction hook into a
per-line breakpoint, and the callee case is the reason it has a `depth` field rather than
being a single boolean.

The live counterpart on the running example, which also demonstrates path-suffix breakpoint
resolution and the backtrace:

```bash
printf 'b docs/example/stats.tera:10\nc\nlocals\nbt\nc\nlocals\nq\n' \
  | node dist/cli.js debug docs/example/stats.tera
```

## Outline

- [ ] **Three members is the whole contract.** Open on `RuntimeDebugger`: `enabled`,
      `forceInterpreter`, `beforeInstruction`. Establish that `Engine.setDebugger` writes it
      into the interpreter and nothing else, that `DebugController` is one implementation
      and `TeraDebugSession` is a convenience wrapper around it, and that everything in the
      rest of the chapter — breakpoints, stepping, snapshots, two front ends — is built on
      top of those three fields without adding a fourth. Cross-reference
      [Ch 73 § buildengineoptions-is-a-layering] for how `tera debug` gets its engine.
- [ ] **The hook is the first statement of the dispatch loop.** Establish
      `src/bytecode/register/interpreter/index.ts:1398`: `beforeInstruction` runs *before*
      `instructions[frame.pc]` is read and before `frame.pc++`, so the pc a pause reports is
      the instruction about to run, not the one that just ran. **New idea:** a bytecode
      interpreter is a fetch–decode–execute loop, and a debugger is a callback wedged into
      the fetch. Establish that `this.debugger?.` is an optional call on a field that is
      `null` in every non-debug engine, so the cost when nobody is debugging is one property
      read per instruction. Do not characterise that cost further — there is no benchmark
      harness in this tree.
- [ ] **A source map turns a pc into a place, and a missing entry is silence.** Establish
      `sourceLocation`: `frame.compiledFn.sourceMap[pc]`, rejected unless `line` and
      `column` are both numbers, with `sourceName` falling back to the function's own and
      then to `DEBUG_EVAL_SOURCE`. **New idea:** a source map is an array parallel to the
      instruction stream. Land the consequence, which is the chapter's first honest limit:
      `beforeInstruction` returns immediately when `sourceLocation` is `null`, so an
      instruction with no mapping can never hit a breakpoint, never satisfy a step, and
      never appear in a backtrace — it is skipped in complete silence. Pin with
      `"records source locations on emitted bytecode"`.
- [ ] **A snapshot, not a pointer.** Establish why `DebugPauseEvent` carries a
      `DebugSnapshot` of plain values rather than the `RegisterFrame` objects themselves:
      the frames are mutated by the very next instruction, and — for the VS Code front end —
      the event must cross a worker boundary by structured clone. **New idea:** *snapshot*
      versus *live reference*. Establish `taggedValueSnapshot`'s shape: always `tag` and
      `display` (through `toDisplayString`), `raw` only for values a front end can compare
      or arithmetic on, `children` only for arrays and objects, and the whole function
      wrapped in a `try/catch` that degrades to `{tag: "error", display: message}` rather
      than letting a broken value kill the pause.
- [ ] **Reading a slot is not reading a register.** Establish `slotValueSnapshot`'s three
      cases in order: a captured variable, where `frame.hasUpvalues && frame.openUpvalues`
      means the *live* value lives in an upvalue cell and the register is stale; a raw
      register hit; and `frame.getReg(slot)` as the fallback when `registers[slot]` is
      `undefined`. Land the general rule: any tool that reads a frame directly has to know
      the closure representation, which is why this file imports from
      `interpreter/frame.js`. Cross-reference [Ch 20 § upvalues].
- [ ] **What the snapshot deliberately does not show.** Establish `frameSnapshot` iterating
      `compiledFn.localNames`, skipping unnamed slots, tagging `internal: name.includes("$")`
      for compiler-synthesised bindings, taking `localBindingKinds[slot]` (defaulting to
      `"temp"`), and — the point — dropping any binding whose snapshot came back `tdz`.
      **New idea:** the temporal dead zone; a slot exists before its declaration runs and
      holds a sentinel, not a value. Establish the two caps: `MAX_DEBUG_CHILDREN = 64` and
      `MAX_DEBUG_DEPTH = 2`, both silent. Establish `globalSnapshots` walking
      `runtime.globalCells.cells` and skipping `undefined` cells, so a declared-but-unwritten
      global is invisible. Pin with `"pauses on line breakpoints and snapshots locals"` and
      `"snapshots globals for debugger watches"`.
- [ ] **The breakpoint store: one key, two lookups.** Establish `breakpointKey` joining
      `sourceName`, `line` and `column ?? -1` with a NUL separator, and `match` trying the
      exact column first and then the any-column key — so `b 10` set from the CLI (which
      never sends a column) matches whatever column the first mapped instruction on line 10
      happens to have. Establish the `byId`/`byKey` pair keeping `set` idempotent: setting
      the same location twice re-enables the existing breakpoint and returns the same id,
      which is what the VS Code adapter's "replace all breakpoints for this file" flow
      relies on.
- [ ] **Stepping is a predicate over frame depth.** Establish `StepState` as `{mode, depth,
      origin}` where `origin` is a `stepLocationKey` — source, `functionId`, line, *no
      column* — and `depth` is `event.snapshot.frames.length`. Then `stepHit`, three lines
      that are the whole step machine: never stop on the origin *line*; `stepInto` stops
      anywhere else; `stepOver` stops when `depth <= step.depth`; `stepOut` stops when
      `depth < step.depth`. **New idea:** step-over is not "run one statement" — it is "stop
      at the next line that is not deeper than where I was", which is why it needs the call
      stack and not the source. Pin with
      `"steps over calls without pausing inside the callee"`.
- [ ] **`breakpointSkip`, and what deleting it does.** The worked example. Establish the
      state: `{breakpoint, origin, depth}`, written by *both* `applyCommand`'s `continue`
      branch and `setStep`, and cleared at the top of `beforeInstruction` when the program
      has left the line (`depth <= skip.depth && currentKey !== skip.origin`) and no step is
      pending. Establish the two things it fixes: a line breakpoint firing once per
      instruction on that line, and the *return* from a callee landing back on the caller's
      line and re-arming a breakpoint the user already continued past — which is why the
      clearing condition tests depth rather than just the line key. Show the three failing
      assertions from deleting it. **General rule:** when a hook fires at a finer grain than
      the concept it implements, the difference has to be stored as explicit state; there is
      no way to derive "already stopped here" from the instruction alone.
- [ ] **Pinning the tier, and what it costs.** Establish `forceInterpreter` defaulting to
      `true` in the `DebugController` constructor (line 422) and `src/cli/debug.ts` never
      overriding it, then `debuggerForcesInterpreter` at its four call sites: `tryTierUp`
      returns `null` so no function is ever handed to the optimizer, and the three execution
      paths refuse `optimizedCode` and `baselineCode` even when they already exist. State
      the cost plainly rather than in a footnote: under `tera debug` the program runs only in
      tier zero, so any timing observed in a debug session is meaningless, and *the JIT
      cannot be watched at all* — there is no way to see a deopt, an inline cache, or an OSR
      entry from this tool. Cross-reference [Ch 76 § the-recording-gate], which is how the
      book shows those instead. **Why the obvious design fails:** a breakpoint inside
      optimized code would need the optimizer to materialize a frame state at an arbitrary
      bytecode offset and deoptimize into it on demand — the machinery exists ([Ch 40 §
      frame-states]) but is keyed to *guard* sites, not to every instruction, so pinning
      tier zero is what a `beforeInstruction` hook can honestly promise.
- [ ] **Front end one: a gdb prompt driven from inside the callback.** Establish
      `runDebug`: a `DebugController` with `pauseOnEntry: true`, an `onPause` that calls
      `promptDebugCommand`, and — the structural point — that the prompt loop runs
      *synchronously inside the interpreter's stack*, reading with `options.input` and
      writing with `fs.writeSync(1, …)` because there is no event loop turn available to
      await. Establish `parseDebugCommand`'s gdb vocabulary (`c`/`s`/`n`/`o`/`b`/`clear`/
      `locals`/`bt`/`q`), the commands that return `null` to re-prompt without resuming, and
      `DebugQuit` as an exception thrown through the interpreter and caught in `runDebug`
      as exit 0. Establish `resolveSource`: an absolute path if it matches, otherwise a
      *unique* suffix match over the module graph's `initOrder` paths with separators
      normalized — which is why `b docs/example/stats.tera:10` works on Windows.
- [ ] **Front end two: a worker that blocks, because the hook cannot.** Establish the
      problem in one sentence: DAP is asynchronous and message-driven, `onPause` must return
      a `DebugCommand` synchronously, and one JavaScript thread cannot do both. Establish
      the answer: `TeraDebugAdapter` runs the engine in a `worker_threads` Worker, shares a
      two-slot `Int32Array` over a `SharedArrayBuffer`, and `waitForDebugCommand` calls
      `Atomics.wait` on `STATE_COMMAND` while the adapter thread keeps pumping DAP requests
      and answers `continue`/`next`/`stepIn`/`stepOut` with `Atomics.store` +
      `Atomics.notify`. **New idea:** `Atomics.wait` is the only genuine blocking primitive
      in JavaScript, and it is available only off the main thread. Establish `STATE_PAUSE`
      as the second slot: `pauseRequested` polls it with `Atomics.exchange` on every
      instruction, which is how DAP's asynchronous "pause" reaches a synchronous hook.
- [ ] **Three features the worker adds on top of an unchanged controller.** Establish that
      conditional breakpoints, hit counts and logpoints exist entirely in
      `shouldStopAtBreakpoint`, above `DebugController`, which knows nothing about them:
      `hitConditionPasses` parsing `>=`/`<=`/`>`/`<`/`=`/`%` against a per-key hit counter;
      `conditionPasses` running `evaluateDebugExpression` over the *snapshot's* bindings —
      a small evaluator with no call syntax, so a watch cannot have side effects; and a
      logpoint posting an `output` message and returning `"continue"`, so it never stops.
      Land the design claim: because a pause is a plain data record, a front end can filter
      pauses without the runtime learning any new concepts. Land the honest corollary: the
      snapshot of every frame is built *before* `shouldStopAtBreakpoint` decides, so a
      condition that is false still pays for a full `runtimeSnapshot`. Pin with
      `"evaluates pure watch expressions over locals and globals"`, `"rejects function
      calls"` and `"evaluates watches from locals and globals"`.
- [ ] **What leaves.** Close by naming the shape both front ends consumed — a synchronous
      hook producing a serializable record that a different thread reads — and hand it to
      chapter 76, which uses the same shape six more times against the *compiler*, where the
      thing being observed must not change because it is being observed.

## Honesty items

> **Dead.** `locationKey` in `src/debugger/runtime.ts:136-143` — the four-part key including
> `location.column` — has no caller anywhere in the tree. `stepLocationKey` (line-granular)
> and `breakpointLocationKey` (any-column) are the two that are used. Cost: delete seven
> lines, or use it to give `stepState` column granularity, which would change stepping
> semantics.

> **Dead.** `registerValueSnapshot` builds `{tag: "tdz", display: "<uninitialized>"}` and
> its only caller path is `slotValueSnapshot` → `frameSnapshot`, which then does
> `if (value.tag === "tdz") continue`. No front end can ever display the string
> `<uninitialized>`; a local in its temporal dead zone simply vanishes from the locals list.
> Cost: one line — keep the binding and let the UI show the sentinel — but it changes what
> `locals` prints.

> **Unfinished.** `DebugControllerOptions.pauseRequested` and the `"pause"` value of
> `DebugPauseReason` are reachable only from `vscode-ext/src/client/debug/worker.ts`.
> `src/cli/debug.ts` never passes a `pauseRequested`, so `tera debug` has no interrupt: once
> you type `c`, the only way to stop a running program is to kill it. Cost: a
> `SIGINT` handler setting a flag plus one line in `runDebug`'s controller options.

> **Unfinished.** The empty command means "step over" (`parseDebugCommand`'s `case ""`, a
> deliberate gdb convention), and `runDebug`'s `readLine` is
> `() => options.input?.("") ?? ""`. End of input is therefore indistinguishable from
> pressing Enter: `node dist/cli.js debug docs/example/stats.tera < /dev/null` single-steps
> the whole program to completion, printing a prompt it will never read an answer to.
> Verified — it terminates and prints the right output, so this is a usability edge, not a
> hang. Cost: distinguish `null` from `""` in `ReadLine` and treat `null` as `continue`.

> **Unfinished.** `MAX_DEBUG_CHILDREN = 64` and `MAX_DEBUG_DEPTH = 2` truncate silently.
> An array of 1,000 elements shows 64 with no marker saying so, and an object two levels
> down shows its `display` string with no `children` at all — which a front end renders as a
> leaf, indistinguishable from a value that genuinely has no members. Cost: a
> `truncated: true` field on `DebugValueSnapshot` and one branch in each front end.

> **Unenforced.** Nothing checks that the `sourceMap` covers the instruction offsets a user
> can reasonably set a breakpoint on. `beforeInstruction` returns silently for an unmapped
> pc, and `DebugBreakpointStore.set` accepts any line number at all — including a line the
> file does not have, or a line that maps to no instruction. The CLI reports
> `breakpoint 1 at …:20` either way, so a breakpoint that can never fire is indistinguishable
> from one that will. Cost: a `verifyBreakpoints` pass over the loaded module graph's source
> maps, plus DAP's existing `verified: false` field on the breakpoint response.

> **Unenforced.** `printLocals` in `src/cli/debug.ts` prints every binding in
> `frame.locals`, including the ones `frameSnapshot` marked `internal: true` for containing
> `$`. The VS Code worker filters them (`binding.internal` in `conditionPasses` and
> `formatLogMessage`); the CLI does not. Nothing states which behaviour is intended.

## Verify it yourself

```bash
npx vitest run --project e2e tests/e2e/debugger/debugger.test.ts
printf 'b 20\nc\nlocals\nbt\nq\n' | node dist/cli.js debug docs/example/stats.tera
printf 'b docs/example/stats.tera:10\nc\nlocals\nbt\nc\nlocals\nq\n' | node dist/cli.js debug docs/example/stats.tera
printf '' | node dist/cli.js debug docs/example/stats.tera
node dist/cli.js help debug
```

The third command is the one to read closely. It stops inside `mean` on the first
iteration, prints `total = 0` / `i = 0`, then a four-deep backtrace
`mean` → `label` → `report` → `<script>` at lines 10, 15, 18 and 23, and on `c` stops on the
*same* line again with `total = 12.5` / `i = 1` — a loop re-entry, which `breakpointSkip`
correctly does not suppress because the depth test only clears the skip once the program has
left the line.

To reproduce the worked example, delete lines 533-537 of `src/debugger/runtime.ts` (the
`this.breakpointSkip = { … }` object in `applyCommand`'s `continue` branch), re-run the
first command, and restore the file.

## Tests that pin this

- `tests/e2e/debugger/debugger.test.ts` > `"records source locations on emitted bytecode"`
- `tests/e2e/debugger/debugger.test.ts` > `"pauses on line breakpoints and snapshots locals"`
- `tests/e2e/debugger/debugger.test.ts` > `"snapshots globals for debugger watches"`
- `tests/e2e/debugger/debugger.test.ts` > `"steps over calls without pausing inside the callee"`
- `tests/e2e/debugger/debugger.test.ts` > `"does not re-hit a continued breakpoint after returning from a callee on the same line"`
- `tests/e2e/debugger/debugger.test.ts` > `"offers a session wrapper that records pause events"`
- `vscode-ext/tests/debug-adapter.test.ts` > `"evaluates watches from locals and globals"`
- `vscode-ext/tests/debug-evaluate.test.ts` > `"evaluates pure watch expressions over locals and globals"`
- `vscode-ext/tests/debug-evaluate.test.ts` > `"rejects function calls"`
- `stepOut` has no test of its own; only `stepInto`, `stepOver` and `continue` are
  exercised. `[unpinned]`
- `forceInterpreter` has no test asserting that a debug session never reaches tier one or
  two. Its four call sites in `src/bytecode/register/interpreter/index.ts` are pinned by
  nothing. `[unpinned]`
- The CLI front end (`src/cli/debug.ts`) has no test file at all — `parseDebugCommand`,
  `resolveSource`'s suffix matching and `DebugQuit` are covered only by running the binary.
  `[unpinned]`
- `hitConditionPasses`, `formatLogMessage` and `waitForDebugCommand` in
  `vscode-ext/src/client/debug/worker.ts` have no tests. `[unpinned]`
