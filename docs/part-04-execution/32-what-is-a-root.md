# 32. What is a root   ⟨I · B · J⟩

> **Status:** outline

**Thesis.** A root set can only see fields, so anything that must survive has to *be* a
field — and every generated-code tier has to export its own live values, because the
collector cannot introspect the host language's stack.

**What arrived.** From [Ch 31 § the-collector-that-actually-runs]: two reclamation
mechanisms that both take the same input and neither of which can compute it.
`GenerationalGC.minorGC` calls `_roots()`; `RegisterInterpreter._maybeSweepHeapPayloads`
calls `markReachableHeapIds`. Both bottom out in `src/gc/roots.ts`, and [Ch 31] left one
question open on purpose: those two are not the same walk, and there is a third.

**What leaves.** Part IV's three artifacts, now safe to trust: the oracle answer
`latency mean=15.70 / throughput mean=898.19`, produced under a collector that did not
corrupt it; a filled `feedbackVector` per function, which [Ch 33 § slots-are-operands]
picks up; and a tier verdict from `requiresInterpreterOnly`. Plus one rule that binds every
later part: a tier that invents a new place to keep a value — a JavaScript `var`, a wasm
linear-memory offset, an AOT stack slot — owes the collector an export, and [Ch 62 § shadow-stack]
is the native compiler paying the same debt with a different currency.

**New ideas.** *Root set* and *root walk* (this chapter's subject; [Ch 31] used the term
without defining it); *precise vs conservative* root scanning, and why a JavaScript host
forces precision by making conservative stack scanning impossible; *transitive closure* as
the actual definition of "live"; *duck typing as an interface* — `roots.ts` names no class,
it matches on field names; *shadow stack* / *root export*, forward-referenced to the AOT
collector; *handle pinning* as the alternative to exporting.

**Length.** 14 pages

## Anchors

- `src/gc/roots.ts` (347 lines, the whole root system). The structural types `:10-27` —
  `UpvalueLike`, `RootSlotValue`, `FrameLike` and `InterpreterLike`, which name *no class*
  and are satisfied by anything with the right fields. `forEachRootFrame` `:29-36`;
  `visitTransientRoots` `:38-43`; the payload shapes `:44-71`, especially
  `MicrotaskRootRecord` `:47-52` and `PayloadLike` `:57-71`. `visitFrameRoots` `:73-93`.
  Then the three walkers: `markReachableHeapIds` `:109-226` (seeds `:142-181`, transitive
  worklist `:183-223`), `enumerateRoots` `:228-283`, `collectLiveHeapIds` `:285-334`, and
  the shared `extractHeapObject` `:336-345` with its recursion through `payload.source`.
- `src/gc/external-roots.ts` — fifteen lines, entire. A module-level
  `Set<ExternalRootProvider>` `:5`, `registerExternalRootProvider` `:7-11`,
  `visitExternalRoots` `:13-15`. Called from all three walkers
  (`roots.ts:152`, `:248`, `:316`).
- `src/bytecode/register/interpreter/index.ts` — the populations. `activeFrames`,
  `baselineFrames`, `suspendedFrames`, `transientRoots` declared `:652-658` and initialised
  `:671-674`; the single `transientRoots` push/pop, around `runAsyncWithSuspension`
  in the `CALL_ASYNC` branch, `:610-621`; `dropUnreachableSuspendedFrames` `:1335-1342`.
- `src/bytecode/register/interpreter/frame.ts` — `RegisterFrame` `:36-80`. `thisValue`
  `:69`, `originalArgs` `:73`, `this.locals = this.registers` `:75` (an alias, which is why
  `visitFrameRoots`'s `frame.registers || frame.locals` is safe), and the argument copy
  `:77-79` — bounded by `compiledFn.paramCount`, not by `args.length`. `closeUpvalues`
  `:124-129` and `closeUpvaluesFrom` `:131-137`.
- `src/bytecode/register/interpreter/helpers.ts:156-186` — `resumeAfterSuspend`. The frame
  is re-registered with a `null` owner at `:164` and the previous owner restored inside the
  reaction at `:166-167`, so for the whole duration of an `await` the frame is in
  `suspendedFrames` with no owner and is therefore unconditionally a root.
- `src/runtime/intrinsics/global-cells.ts` — `GlobalCell` `:29` with `value` `:31`,
  `writeCount` `:33` and `read()` `:44`; `GlobalCellMap` `:73`. The walkers accept either a
  `GlobalCellMap` or a bare `Map` (`getCellsCollection`, `roots.ts:99-101`).
- `src/runtime/microtasks/microtask.ts` — what the queue actually holds: `Microtask`
  `:70-81`, `PromiseReactionMicrotask` `:83-105` (`reaction`, `promise`, `state`, `value`),
  `PromiseResolveThenableMicrotask` `:107-170` (`promiseToResolve`, `thenable`,
  `thenMethod`), `CallbackMicrotask` `:172-187` (`callback`). Compare with the four field
  names `roots.ts:164-175` looks for.
- `src/runtime/iteration/iterator.ts` — `IteratorRecord` `:47-62`: two fields, `source` and
  `next`. `wrapValueIterator` `:71-99` and `getIterator` `:101-183`; the array branch
  `:116-129` is the one whose closure captures `arr` and whose `source` is the only field
  that names the array.
- `src/optimizing/baseline/compiler.ts` — `SCRATCH_LOCALS = ["t","t2","t3","t4","osr"]`
  `:34`, `ROOTED_LOCALS = ["acc", ...SCRATCH_LOCALS]` `:35`, and the prologue `:145-155`
  ending in
  `$.enter(r,function(){return[acc,t,t2,t3,t4,osr];});` — the export, written as a closure
  because a JavaScript `var` cannot be a field.
- `src/optimizing/baseline/runtime.ts` — `BaselineFrameRoots` `:98-101`;
  `enter` `:404-406` and `leave` `:408-410` pushing and popping
  `interp.baselineFrames`; `c(idx)` `:228-236`, which calls `pinHeapSlot(val)` on the
  constant cache instead of exporting it.
- `src/optimizing/backends/wasm/codegen.ts` — the JIT's export. `threadLocal` `:167-176`,
  the provider `:177-181` (`for (const info of m.values()) visit(info.value)`),
  `ObjectPointerInfo` `:264-271`, and the save/restore around a wasm call
  `:4646-4651` / `:4717` / `:4728` / `:4778`.
- `src/objects/heap/js-object.ts:137-156` — `visitReferences`, with its two
  `if (isAccessorPair(...)) continue` lines. `src/core/value/index.ts:198-199` —
  `RuntimeFunctionPayload.accessors` and `.staticBase`, neither of which any walker follows.
- `tests/gc/transient-roots.test.ts`, `tests/gc/roots.test.ts`,
  `tests/e2e/gc/heap-payload-sweep.test.ts`, `tests/e2e/optimizing/gc-roots.test.ts` — the
  four suites that pin this chapter, and the only place the
  `{ allocationBudget: 8, youngGenSize: 16 }` reproduction config is written down
  (`gc-roots.test.ts:5` and `:179`).

## Worked example

Each case study is reproduced the same way: run it under
`gc: { allocationBudget: 8, youngGenSize: 16 }` — small enough that a collection happens
every few allocations — with the fix reverted. The failure then appears in under a second,
and it appears as a *wrong printed value*, never as a crash: a swept handle index is still a
valid number, so `getPayload` returns `undefined` and the program keeps going.

```bash
npx vitest run --project e2e tests/e2e/optimizing/gc-roots.test.ts
npx vitest run --project e2e tests/e2e/gc/heap-payload-sweep.test.ts
npx vitest run --project unit tests/gc/transient-roots.test.ts tests/gc/roots.test.ts
```

One failure of this shape is still live and needs no revert at all:

```
$ node dist/cli.js --expose-gc -e 'o = {s: "hi", n: 1.5}
gc(1)
print(o.n)'
undefined
```

`1.5` is a boxed double whose only reference is `o.slots[1]`. The major collection's handle
sweep uses `collectLiveHeapIds`, which does not walk `slots`. Exit code 0, no diagnostic,
wrong answer. That is the whole chapter in three lines.

## Outline

- [ ] **§ a-root-is-a-field** — Establish the constraint before the mechanism. `> **New
  idea.**` conservative vs precise root scanning: a native collector can scan the machine
  stack and treat anything that looks like a pointer as one. tera's collectors run *inside*
  JavaScript, where the host stack is not addressable, so the root set can only contain what
  some reachable object exposes as a property. Establish the corollary that names the
  chapter: *a value that must survive has to be a field of something already reachable*.
  Show `roots.ts:10-27` — `FrameLike` and `InterpreterLike` mention no class at all; they
  are lists of field names. Establish that this is why `tests/gc/gc.test.ts`'s
  `makeGCWithRoots` can pass `{ activeFrames: [{ locals: [...], stack: [] }] }` and be a
  legitimate interpreter as far as the collector is concerned.
- [ ] **§ the-three-frame-populations** — `forEachRootFrame` (`roots.ts:29-36`) is six
  lines and three `for` loops: `activeFrames`, `baselineFrames`, and the *keys* of
  `suspendedFrames`. Establish what each population means — a frame the dispatch loop is
  inside, a record pushed by generated JavaScript, and a frame that left the loop and will
  be re-entered — and that only the first exists in a textbook interpreter. Establish that
  the `?? []` on each line is what lets any of the three be absent, which is how the same
  walker serves a full `RegisterInterpreter` and a two-field test double.
- [ ] **§ what-a-frame-exports** — Walk `visitFrameRoots` (`roots.ts:73-93`) field by field:
  `registers || locals`, `stack`, `acc`, `readLocals()`, `closureEnv.cells`,
  `openUpvalues`. Establish why `registers || locals` is not a bug — `RegisterFrame`
  sets `this.locals = this.registers` (`frame.ts:75`) so an `UpvalueCell` can hold
  `{locals: registers}` as its view. Establish why an *open* upvalue needs no export of its
  own (the cell reads `frame.locals[slot]`, already visited) and a *closed* one does (its
  value moved into `closedValue`, reachable only through `closure.cells`). Then the gap:
  `thisValue` and `originalArgs` are live fields of every `RegisterFrame` and no walker
  visits either. Establish exactly why it has not bitten — a receiver is also in a caller
  register, and arguments are copied into `registers[0..paramCount)` — and exactly where
  that stops being true: `frame.ts:77-79` bounds the copy by `paramCount`, so a surplus
  argument lives only in `originalArgs`. First honesty item.
- [ ] **§ the-other-four-populations** — Establish the non-frame roots in the order the
  walkers take them. **Global cells**: every `GlobalCell.read()`, i.e. the entire module
  top level, which is why `s = "direct"` survives `gc(1)` in the probe and `o.s` does not.
  **Transient roots** (`roots.ts:38-43`): an explicit array with a push/pop discipline, with
  exactly one producer in the tree — `interpreter/index.ts:610-621` wrapping
  `runAsyncWithSuspension` in `try { … } finally { transientRoots.pop() }`, because the
  promise capability's value exists nowhere else while the async body runs. Pin to
  `tests/gc/transient-roots.test.ts > "marks a transient root as live"` and
  `> "drops the root again once it is popped"`. **The microtask queue** and
  **`pendingRejections`** — and the honesty item they carry, § what-none-of-them-follow.
- [ ] **§ external-providers** — Establish the extension point, and how small it is.
  `src/gc/external-roots.ts` is fifteen lines: a `Set` of callbacks, a register function, a
  visit function. Establish the contract — a provider is handed a `visit(value: TaggedValue)`
  and calls it for everything it is holding — and that it is *global*, not per-engine, and
  has no deregistration. Establish that exactly one provider exists
  (`wasm/codegen.ts:177-181`) and that it is what makes § case-the-jit-serialized-objects
  work. State the design claim plainly: fifteen lines is what it costs to let a backend that
  the collector has never heard of contribute roots, and the AOT collector's shadow stack
  ([Ch 62 § shadow-stack]) is the same idea with no shared code.
- [ ] **§ three-walkers** — The centre of the chapter. Lay `markReachableHeapIds`,
  `enumerateRoots` and `collectLiveHeapIds` side by side in one table: what each returns,
  who calls it, which populations it seeds from, and how deep it goes.

  | | `markReachableHeapIds` | `enumerateRoots` | `collectLiveHeapIds` |
  | --- | --- | --- | --- |
  | returns | `Set<number>` of heap ids | `GCObject[]` | `Set<number>` of heap ids |
  | called by | `_maybeSweepHeapPayloads` | `GenerationalGC._roots` | `majorGC`, `finishIncrementalMajorGC` |
  | microtask queue | yes, four field names | `task.promise` only | **no parameter at all** |
  | `compiledFn.constants` | via `p.compiled.constants` | no | yes, per frame |
  | transitive | full worklist over 13 shapes | none — the GC's own `visitReferences` does it | `payload.source` only |

  Establish that `enumerateRoots`' shallowness is *correct*: it feeds a collector that walks
  the graph itself. Then establish that `collectLiveHeapIds`' shallowness is not, because it
  feeds `sweepHeapPayloads`, which walks nothing. Show the two call sites
  (`gc.ts:321-322`, `:404-405`) and the three-line reproduction from the worked example.
  Establish the fix — the deeper walker already exists — and the reason nobody hit it:
  both call sites are inside `majorGC`, which [Ch 31 § incremental-marking-that-never-steps]
  showed is unreachable without `--expose-gc`.
- [ ] **§ what-none-of-them-follow** — An honest inventory, each item with the field, the
  walker that would have to change, and what it would cost.
  **`AccessorPair` slots**: `JSObject.visitReferences` skips them explicitly
  (`js-object.ts:141, 148`) and `markReachableHeapIds` seeds `p.slots` without unwrapping
  them, so a getter or setter function stored in a slot is reachable from nothing. **Function
  accessors and `staticBase`** (`core/value/index.ts:198-199`): `PayloadLike` follows
  `properties`, `prototype`, `prototypeObj` and `closure.cells`, and neither of these.
  **`_weakMapData`**: `PayloadLike` names `_mapData` and `_setData` and stops —
  cross-reference [Ch 26 § weakmaps], which owns that bug. **Microtask payloads**: the walk
  at `roots.ts:164-175` tests for `value`, `result`, `argument` and `promise`; of the four
  `Microtask` subclasses, only `PromiseReactionMicrotask` has two of those, `result` and
  `argument` exist on none of them, and `thenable`, `thenMethod`, `callback` and every
  `reaction` closure are unreachable. Land the general rule this produces: a root walk
  written as a list of *field names* is a duplicate of a type declaration that nothing
  compares it against, which is why every one of these is an `> **Unenforced.**` and not a
  `> **Broken.**` — they are latent until a program routes a value through one of them.
- [ ] **§ case-the-iterator** — First case study, and the cleanest statement of the thesis.
  `for j of range(1000000)`: `range` returns a JavaScript `number[]`
  (`src/runtime/domain/builtins.ts:16-25`) which becomes a `JSArray` handle, the for-of
  opcodes keep the *iterator* in a register, and the array itself is captured only by the
  `next` closure inside `IteratorRecord` (`iterator.ts:116-129`, `const arr = getPayload(value)`).
  Establish the symptom: the array's handle was swept and the loop started reading
  `undefined`. Establish that no walker could have been fixed, because a JavaScript closure
  environment has no enumerable fields — the fix had to be a *representation* change:
  `IteratorRecord.source` (`iterator.ts:48`), a field holding the same tagged value, plus
  three lines of walker (`roots.ts:222`, `:296-298`, `:343`). Pin to
  `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps a temporary array alive for the whole
  for-of loop"`. General rule: when a value is only reachable through host-language capture,
  the fix is a field, never a smarter walk.
- [ ] **§ case-the-baseline-accumulator** — Second case study. Baseline emits
  `var acc,t,t2,t3,t4,osr` (`compiler.ts:146`) — six JavaScript locals holding tagged
  values mid-expression, in a function the collector cannot see into. Establish the export:
  `$.enter(r, function(){return[acc,t,t2,t3,t4,osr];})` (`compiler.ts:155`), a closure
  whose *call* materialises the locals as an array, reached from `visitFrameRoots` through
  `frame.readLocals` (`roots.ts:81`). Establish the two halves — `r` is already an object
  and can be passed directly; `acc` and the temporaries cannot, so the export is a function
  instead of a value — and that `leave()` pops on the way out (`runtime.ts:404-410`), so the
  discipline is exactly `transientRoots`'. Then the third strategy, used where neither
  works: `BaselineRuntime.c` (`runtime.ts:228-236`) keeps a constant cache in a plain array
  and calls `pinHeapSlot(val)`, marking the slot un-sweepable rather than making it
  reachable. Pin the four cases in
  `tests/e2e/optimizing/gc-roots.test.ts > "baseline frames are garbage collection roots"`.
- [ ] **§ case-the-suspended-frame** — Third case study, arriving directly from [Ch 30].
  A frame that has left the dispatch loop is in no stack and no register file; its registers
  are reachable only from `suspendedFrames`, which is why that `Map`'s *keys* are the third
  population in `forEachRootFrame`. Establish the two-sided problem this creates. Keeping
  them is necessary — pin to
  `tests/e2e/gc/heap-payload-sweep.test.ts > "preserves an async coroutine's heap local
  across collections"` and `> "preserves a generator's heap argument before it starts and
  while it is suspended"`. Keeping them *forever* is a leak, which is why
  `dropUnreachableSuspendedFrames` (`interpreter/index.ts:1335-1342`) runs inside the sweep
  and deletes any frame whose `owner` is itself unreachable — an abandoned generator. Then
  the window: `resumeAfterSuspend` sets the owner to `null` for the duration of an `await`
  (`helpers.ts:164`), and `dropUnreachableSuspendedFrames` skips a null owner, so an
  awaiting frame is unconditionally retained and only becomes droppable once its owner is
  restored (`helpers.ts:166-167`). Establish that the ordering — mark, then drop, then sweep
  — is load-bearing and unenforced.
- [ ] **§ case-the-jit-serialized-objects** — Fourth case study, and the one that needs the
  extension point. The JIT copies an object graph into wasm linear memory and keeps
  `objPtrs: Map<number, ObjectPointerInfo>` mapping a wasm pointer back to
  `{ptr, obj, value}` (`codegen.ts:264-271`). During a wasm call that map is the only thing
  holding some of those tagged values, and it lives in a JavaScript local. Establish the
  export: `threadLocal.currentObjPtrs` set on entry and restored on every exit path
  (`codegen.ts:4651`, `:4717`, `:4728`, `:4778`), read by the one external root provider
  (`:177-181`). Establish why a `threadLocal` module variable rather than a parameter — the
  provider is registered at module load, before any engine exists — and what the save/restore
  discipline costs on a re-entrant call. Pin to
  `tests/e2e/optimizing/gc-roots.test.ts > "materializes a single object shared by many
  fields exactly once"` and `> "does not blow up exponentially on a diamond chain, and
  deopts past the depth guard"`.
- [ ] **§ the-general-rule** *(What was tried and rejected)* — Close on the pattern across
  four case studies. Establish that in every one, the failure was the same shape — a live
  value held only in host-language storage — and the fix was always one of three moves, in
  ascending cost: *export a field* (`IteratorRecord.source`), *export a reader*
  (`readLocals`, the external root provider), or *pin the slot* (`pinHeapSlot`). Establish
  what was rejected: making the walkers cleverer, which is impossible against a closure
  environment, and scanning conservatively, which a JavaScript host cannot do at all.
  Establish the debt this leaves the rest of the book: the same three moves reappear in
  [Ch 62] as an AOT shadow stack, where the reason is different — the native collector
  *could* scan the stack, and deliberately does not, because a root slot there is a mirror
  and not a handle.
- [ ] **§ what-leaves** — Restate Part IV's three artifacts and hand [Ch 33] the second one:
  the interpreter has been recording as it ran, and none of what it wrote down has been read
  yet.

## Honesty items

- > **Broken.** `collectLiveHeapIds` (`src/gc/roots.ts:285-334`) is the walker
  `majorGC` and `finishIncrementalMajorGC` hand to `sweepHeapPayloads`
  (`src/gc/gc.ts:321-322`, `:404-405`), and its `trackValue` `:292-299` follows only
  `payload.source`. Any payload reachable only through `slots`, `elements`,
  `overflowProperties`, `properties`, `closure.cells` or `compiled.constants` is freed by a
  major collection; the program then reads a dangling handle and gets `undefined` with no
  diagnostic. Reproduce with `node dist/cli.js --expose-gc -e 'o = {s: "hi", n: 1.5}` /
  `gc(1)` / `print(o.n)'`. It also takes no `microtaskQueue` parameter, so a pending
  microtask's values are not live during a major GC. Cost of a fix: call
  `markReachableHeapIds` at both sites — it already does all of this. No test covers a major
  GC's handle sweep. [unpinned]
- > **Unenforced.** `visitFrameRoots` (`src/gc/roots.ts:73-93`) does not visit
  `RegisterFrame.thisValue` or `RegisterFrame.originalArgs` (`frame.ts:69`, `:73`). It holds
  today because a receiver is also in a caller register and because arguments are copied into
  `registers[0..paramCount)`; `frame.ts:77-79` bounds that copy by `paramCount`, so an
  argument passed beyond the declared arity lives only in `originalArgs` and is invisible.
  Nothing checks the correspondence and no test pins it.
- > **Unenforced.** The microtask root walk (`src/gc/roots.ts:164-175`) matches the field
  names `value`, `result`, `argument` and `promise`. Across the four `Microtask` subclasses
  in `src/runtime/microtasks/microtask.ts`, `result` and `argument` exist on none;
  `PromiseResolveThenableMicrotask.thenable` / `.thenMethod` / `.promiseToResolve`,
  `CallbackMicrotask.callback` and every `PromiseReactionMicrotask.reaction` closure are
  matched by nothing. Fixing it means either a `visitRoots()` method on `Microtask` or a
  walker that is derived from the class list rather than guessed alongside it.
- > **Unenforced.** No walker follows an `AccessorPair`. `JSObject.visitReferences`
  (`src/objects/heap/js-object.ts:141, 148`) skips accessor slots with an explicit
  `continue`, and `markReachableHeapIds` seeds `p.slots` without unwrapping, so a getter or
  setter function stored as a property is reachable from nothing. Cost: two `if` branches in
  each walker plus a decision about whether `AccessorPair` should carry a `gcHeader`.
- > **Unenforced.** `PayloadLike` (`src/gc/roots.ts:57-71`) does not name
  `RuntimeFunctionPayload.accessors` or `.staticBase`
  (`src/core/value/index.ts:198-199`), so a static member inherited through a class's
  `staticBase` chain and a function-level accessor are outside every walk. Same shape as the
  `_mapData` / `_setData` list that [Ch 26 § weakmaps] flags: a hand-maintained field list
  with no derivation from the payload types.
- > **Unenforced.** `registerExternalRootProvider` (`src/gc/external-roots.ts:7-11`) writes
  into a module-global `Set` with no matching deregistration and no engine scoping. Two
  engines in one process share the provider set, and a provider whose backend is torn down
  keeps being called. There is exactly one provider today, so it has never mattered. No test
  exercises the external-root path at all. [unpinned]
- > **Unenforced.** The ordering inside `_maybeSweepHeapPayloads`
  (`src/bytecode/register/interpreter/index.ts:1343-1356`) — mark, then
  `dropUnreachableSuspendedFrames(live)`, then `sweepHeapPayloads(live)` — is required for
  correctness: dropping before marking would free a frame that is still owned, and sweeping
  before dropping would leave the dropped frames' payloads alive for one more cycle.
  Nothing states or checks the ordering.
- > **Never runs.** `RegisterFrame.closeUpvalues` / `closeUpvaluesFrom`
  (`frame.ts:124-137`) have callers only in the interpreter
  (`interpreter/index.ts:1771, 2028, 2186, 2192, 2508`). The baseline compiler builds
  `UpvalueCell`s into its own `_ouv` map (`compiler.ts:153, 382`) and never closes them, so a
  closure created by baseline-compiled code holds an *open* cell for the life of the value.
  It is safe — an open cell is a view onto `r`, which `enter` exported — but the two tiers do
  not agree on upvalue lifetime and nothing reconciles them. [unpinned]

## Verify it yourself

```bash
node dist/cli.js --expose-gc -e 'o = {s: "hi", n: 1.5}
gc(1)
print(o.n)'
node dist/cli.js --expose-gc -e 's = "direct"
gc(1)
print(s)'
npx vitest run --project unit tests/gc/roots.test.ts tests/gc/transient-roots.test.ts
npx vitest run --project e2e tests/e2e/optimizing/gc-roots.test.ts
npx vitest run --project e2e tests/e2e/gc/heap-payload-sweep.test.ts
grep -rn "registerExternalRootProvider" src/ tests/ --include=*.ts
```

The first prints `undefined` — a boxed double reachable only from an object slot, freed by
a major collection. The second prints `direct` — the same value in a global cell, which
`collectLiveHeapIds` does walk. The last returns three lines: the definition in the fifteen-line
`src/gc/external-roots.ts`, and the import and the single call in
`src/optimizing/backends/wasm/codegen.ts`.

## Tests that pin this

- `tests/gc/roots.test.ts > "returns object with gcHeader directly"`
- `tests/gc/roots.test.ts > "returns null for primitives and non-gc objects"`
- `tests/gc/roots.test.ts > "collects gc objects from interpreter frame locals and stack"`
- `tests/gc/roots.test.ts > "collects gc objects from globalCells Map"`
- `tests/gc/roots.test.ts > "collects promises from microtask queue"`
- `tests/gc/roots.test.ts > "handles all null inputs gracefully"`
- `tests/gc/roots.test.ts > "collects from multiple frames"`
- `tests/gc/transient-roots.test.ts > "marks a transient root as live"`
- `tests/gc/transient-roots.test.ts > "tracks a transient root in the live heap-id set"`
- `tests/gc/transient-roots.test.ts > "reports a transient root as a GC root object"`
- `tests/gc/transient-roots.test.ts > "follows a transient root transitively into its slots"`
- `tests/gc/transient-roots.test.ts > "drops the root again once it is popped"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "preserves live state (objects, arrays, closures, generators) across sweeps"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the slab bounded once the loop runs in baseline-compiled code"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "still reaches a safepoint when the back edge is a conditional jump"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "preserves an async coroutine's heap local across collections"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "preserves a generator's heap argument before it starts and while it is suspended"`
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps a temporary array alive for the whole for-of loop"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps an object held only in a baseline register alive across allocation"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps an array held only in a baseline register alive across allocation"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps a string held only in a baseline register alive across allocation"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps a nested object reachable after a nested allocation"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps the awaited promise alive while the async body allocates"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps a promise alive across a nested async call chain"`
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps the promise alive when the async result is discarded"`
- `tests/e2e/optimizing/gc-roots.test.ts > "materializes a single object shared by many fields exactly once"`
- `tests/e2e/optimizing/gc-roots.test.ts > "does not blow up exponentially on a diamond chain, and deopts past the depth guard"`
- `tests/gc/gc.test.ts > "follows references to keep transitive objects alive"`
- `tests/gc/gc.test.ts > "keeps slots of young objects still reachable from roots"`
