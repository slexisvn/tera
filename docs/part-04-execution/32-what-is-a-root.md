# 32. What is a root   ⟨I · B · J⟩

Both of the collectors in [Ch 31] take the same input and neither of them computes it. What
they take is a *root set*: the starting points from which reachability is measured. In a
native runtime that set is largely implicit — the collector scans the machine stack and the
registers, treats anything that looks like a pointer into the heap as one, and gets a
conservative but complete answer for free. tera's collectors do not have that option,
because they run *inside* JavaScript. The host stack is not addressable. A local variable
in a JavaScript function is not a field of anything; it is not enumerable, not reachable,
not nameable from outside the function that declares it.

That single constraint decides the shape of everything in this chapter. A root set here can
only contain what some reachable object exposes **as a property**. Which means: anything
that must survive a collection has to *be* a field. And which means, in turn, that every
tier that invents a new place to keep a value — a JavaScript `var` in baseline-compiled
code, a `Map` of wasm pointers in the JIT, a closure variable inside an iterator — owes the
collector an export, in code, by hand. Four of this chapter's five case studies are what
happened when one of those debts went unpaid.

`docs/example/stats.tera` cannot demonstrate any of this. The spine program allocates
fifteen managed objects and never triggers a collection at all ([Ch 31 § two-heaps]), so
every case study below is reproduced instead from a purpose-built probe or from the test
suite's own configuration — `gc: { allocationBudget: 8, youngGenSize: 16 }`, written down at
`tests/e2e/optimizing/gc-roots.test.ts:5` and `:179`, small enough that a collection happens
every few allocations.

**What arrived.** From [Ch 31 § the-collector-that-actually-runs]: two reclamation
mechanisms that both take a root set and neither of which can produce one.
`GenerationalGC.minorGC` and `majorGC` call `_roots()` (`src/gc/gc.ts:115-122`), which is
`enumerateRoots`. `RegisterInterpreter._maybeSweepHeapPayloads` calls
`markReachableHeapIds`. The tail of `majorGC` calls a third function,
`collectLiveHeapIds`. All three live in `src/gc/roots.ts`, all three are called "the roots",
and [Ch 31] left the consequence open on purpose: they are not the same walk, and one of
them is wrong.

> **New idea.** *Root set* and *root walk.* The root set is the collection of references
> the collector is told to start from without proving anything about them — the program's
> currently-executing frames, its globals, anything a runtime is holding on the program's
> behalf. The *root walk* is the code that produces that set. Everything else is derived:
> a value is live if and only if it is in the **transitive closure** of the root set under
> "points at". Get the root set wrong in one direction and you leak; wrong in the other and
> you free something the program is still using. In this engine the second failure mode does
> not crash — a freed handle index is still a perfectly valid JavaScript number, so
> `getPayload` returns `undefined` and the program keeps running with a wrong value.

## A root is a field

> **New idea.** *Conservative versus precise root scanning.* A collector written in C can
> walk the machine stack word by word and treat any word that happens to fall inside the
> heap's address range as a possible pointer. That is *conservative*: it may retain garbage
> that merely looks like a pointer, but it cannot miss a live reference, and it requires no
> cooperation from the compiler. The alternative is *precise* scanning, where the compiler
> emits a map saying which stack slots hold references at each safepoint. Precise scanning
> needs the compiler's cooperation but never retains garbage — and, crucially, it is the
> only kind of scanning available to a collector that cannot see the stack at all.

tera's collectors cannot see the stack at all. They are JavaScript objects walking other
JavaScript objects; the interpreter's own call stack, the baseline-compiled function's
`var acc,t,t2,t3,t4,osr`, and the JIT's local `objPtrs` map are all invisible to them.
Conservative scanning is not merely a worse choice here, it is not implementable. So the
root walk is precise by force, and precision means fields.

`src/gc/roots.ts` says exactly that in its type declarations, and it says it without naming
a single class:

```ts
type FrameLike = {
  registers?: RootSlotValue[];
  locals?: RootSlotValue[];
  stack?: RootSlotValue[];
  acc?: TaggedValue;
  closureEnv?: { cells?: UpvalueLike[] } | null;
  openUpvalues?: Map<number, UpvalueLike> | null;
  compiledFn?: { constants?: RegisterConstant[] };
  readLocals?: () => TaggedValue[];
};
type InterpreterLike = {
  activeFrames?: FrameLike[];
  baselineFrames?: FrameLike[];
  suspendedFrames?: Iterable<[FrameLike, unknown]>;
  transientRoots?: TaggedValue[];
};
```

— src/gc/roots.ts:12-27

There is no `import type { RegisterFrame }` behind that. `FrameLike` is a list of field
names, and every field is optional. Anything with the right property names is a frame as
far as the collector is concerned; anything with none of them is an empty frame rather than
an error.

That is duck typing used deliberately as an interface, and its practical consequence is
visible in the test suite. `tests/gc/gc.test.ts`'s helper builds an entire interpreter out
of one object literal:

```js
  const rootObjects = [];
  const interpreter = {
    activeFrames: [{ locals: rootObjects, stack: [] }],
  };
  gc.bindRoots(interpreter, null, null);
```

— tests/gc/gc.test.ts:22-26

Two fields on the interpreter's frame, two on the interpreter, and `GenerationalGC` accepts
it as a legitimate root provider. Every generational-collector test in the tree runs against
that double.
[t: tests/gc/roots.test.ts > "collects gc objects from interpreter frame locals and stack"],
[t: tests/gc/roots.test.ts > "handles all null inputs gracefully"]

The corollary is the sentence that names the chapter. **A value that must survive a
collection has to be a field of something already reachable.** Not a variable, not a
closure capture, not an entry in a `Map` held in a local. A field, on an object, on a path
the walk already takes. Everything that follows is either a demonstration of that or a
consequence of it.

## The three frame populations

`forEachRootFrame` is six lines and three loops:

```ts
function forEachRootFrame(
  interpreter: InterpreterLike,
  visit: (frame: FrameLike) => void,
): void {
  for (const frame of interpreter.activeFrames ?? []) visit(frame);
  for (const frame of interpreter.baselineFrames ?? []) visit(frame);
  for (const [frame] of interpreter.suspendedFrames ?? []) visit(frame);
}
```

— src/gc/roots.ts:29-36

Three populations, and only the first exists in a textbook interpreter.

**`activeFrames`** is the dispatch loop's own stack of `RegisterFrame`s — pushed on call,
popped on return, holding the registers of every function currently executing. This is the
population a collector normally means by "the stack".

**`baselineFrames`** is a population that only exists because a second tier does. When
baseline-compiled JavaScript runs, there is no `RegisterFrame`: the function's registers are
a JavaScript array and its temporaries are JavaScript locals. `BaselineRuntime.enter` pushes
a `BaselineFrameRoots` record — `{ registers, readLocals }`
(`src/optimizing/baseline/runtime.ts:98-101`) — onto this array, and `leave` pops it. It is
a record *about* a frame the collector cannot see, not the frame itself.
[t: tests/e2e/optimizing/gc-roots.test.ts > "keeps an object held only in a baseline register alive across allocation"]

**`suspendedFrames`** is the third, and it is a `Map`, not an array — the walk takes its
*keys*. These are frames that have left the dispatch loop entirely and will be re-entered
later: the half-finished async functions and unstarted or paused generators that [Ch 30 §
what-leaves] handed over. They are on no stack, in no register file, and reachable from
nothing else in the process.

All three lines end in `?? []`. That is what lets any of the three be absent, which is what
lets the same walker serve a full `RegisterInterpreter` and the two-field literal above.
It is also, quietly, what makes the walk unable to complain: an interpreter that has
forgotten to expose a population produces a smaller root set rather than an error.

## What a frame exports

`visitFrameRoots` is the field-by-field definition of what survives:

```ts
export function visitFrameRoots(
  frame: FrameLike,
  visit: (value: RootSlotValue) => void,
): void {
  const registers = frame.registers || frame.locals;
  if (registers) for (const value of registers) visit(value);
  if (frame.stack) for (const value of frame.stack) visit(value);
  if (frame.acc !== undefined) visit(frame.acc);
  if (frame.readLocals) for (const value of frame.readLocals()) visit(value);
```

— src/gc/roots.ts:73-81

Two more loops follow (`:82-92`), each walking a `Map` or array of `UpvalueLike` cells —
`frame.closureEnv?.cells` and `frame.openUpvalues.values()` — and visiting `cell.get()` for
any entry whose `get` is actually a function. Six sources in all, in order.

`registers || frame.locals` looks like a bug and is not. `RegisterFrame` sets
`this.locals = this.registers` in its constructor (`frame.ts:75`) — an alias, not a copy —
so that an `UpvalueCell` can hold a `{locals}` view onto a frame's register array without
the frame and the cell disagreeing. The `||` exists so the walk serves both a real frame
(which has `registers`) and a test double or a baseline record (which may only have
`locals`). Either way it visits the same array once.

`stack` is the operand stack, empty in a register interpreter and present on the doubles.
`acc` is the accumulator register, which is a field rather than an array slot and so needs
its own line. `readLocals()` is the baseline export — a *function* that materialises the
generated code's JavaScript locals as an array, discussed in
§ case-the-baseline-accumulator.

The last two are about upvalues, and the asymmetry between them is worth the paragraph. An
**open** upvalue needs no export of its own: the cell reads `frame.locals[slot]`, and
`frame.locals` is the register array the walk has already visited. Visiting the cell is
redundant but harmless. A **closed** upvalue is different — `close()` copies the value out
of the register into the cell's own `closedValue`, and the frame is then gone. From that
point the value is reachable only through `closure.cells`, which the walk reaches not here
but in the transitive step (`roots.ts:206-210`).

Now the gap. `RegisterFrame` has two more fields holding tagged values that no walker
visits at all:

```ts
    this.thisValue = thisValue || CODE_UNDEFINED;
```

— src/bytecode/register/interpreter/frame.ts:69

and `this.originalArgs = args;` at `:73` (declared at `:42` and `:46` respectively).

> **Unenforced.** `visitFrameRoots` (`src/gc/roots.ts:73-93`) does not visit
> `RegisterFrame.thisValue` or `RegisterFrame.originalArgs`. It has not bitten for two
> reasons, both incidental. A receiver is normally also live in a *caller's* register,
> because the call site had to compute it. And arguments are copied into the frame's own
> registers by the constructor — but only some of them:
> `for (let i = 0; i < args.length && i < compiledFn.paramCount; i++)`
> (`frame.ts:77-79`) bounds the copy by the declared arity. An argument passed beyond the
> declared parameter count lives *only* in `originalArgs`, and is invisible to every walker
> in the file. Nothing checks the correspondence between "fields a frame has" and "fields
> the walk visits", and no test pins it. Cost of fixing: two lines in `visitFrameRoots`,
> plus a decision about whether the extra retention of `originalArgs` — which pins every
> argument for the frame's whole lifetime, not just until its register is overwritten — is
> acceptable.

## The other four populations

Beyond frames, the walkers take four more sources, in the order the code takes them.

**Global cells.** `GlobalCellMap` (`src/runtime/intrinsics/global-cells.ts:73`) is a
`Map<string, GlobalCell>`, and a `GlobalCell` (`:29`) has `value`, `state`, `writeCount` and
a `read()` accessor (`:44`). Every walker iterates the map and seeds `cell.read()`, falling
back to `cell.value` for a cell-like object without the method (`roots.ts:157-159`,
`:259-260`, `:326-328`). A tera module's entire top level is global cells, which is why
`s = "direct"` survives `gc(1)` in the probes below and `o.s` does not: one is a cell, the
other is a slot in an object. `getCellsCollection` (`roots.ts:99-101`) accepts either a
`GlobalCellMap` or a bare `Map`, which is how the test doubles work.
[t: tests/gc/roots.test.ts > "collects gc objects from globalCells Map"]

**Transient roots.** `visitTransientRoots` (`roots.ts:38-43`) walks an explicit
`TaggedValue[]` on the interpreter with a strict push/pop discipline. There is exactly one
producer in the tree, and it is the `CALL_ASYNC` branch of the call path:

```ts
  if (compiled.callMode === CALL_ASYNC) {
    const { capability, value } = mkPromiseCapability(interpreter.microtaskQueue);
    const asyncFrame = new RegisterFrame(compiled, args, thisValue, fn.closure);
    if (!compiled.feedbackVector) interpreter.initFeedbackVector(compiled);
    interpreter.transientRoots.push(value);
    try {
      runAsyncWithSuspension(interpreter, asyncFrame, capability);
    } finally {
      interpreter.transientRoots.pop();
    }
    recordReturnFeedback(slot, value);
    return value;
  }
```

— src/bytecode/register/interpreter/index.ts:610-621

The promise `value` exists nowhere else while the async body runs. It has not been returned
to a caller's register, it is not in a global cell, and the frame that will eventually
resolve it holds the *capability*, not the tagged handle. Between the `mkPromiseCapability`
and the `return`, `transientRoots` is the only thing naming it. The `finally` is not
politeness; without it, an async body that throws would leave the array growing.
[t: tests/gc/transient-roots.test.ts > "marks a transient root as live"],
[t: tests/gc/transient-roots.test.ts > "follows a transient root transitively into its slots"],
[t: tests/gc/transient-roots.test.ts > "drops the root again once it is popped"]

**The microtask queue.** `markReachableHeapIds` walks `microtaskQueue.queue` looking for
four field names — `value`, `result`, `argument`, `promise` (`roots.ts:164-175`).
`enumerateRoots` walks the same array but takes only `task.promise`, and only when it is an
object with a `gcHeader` (`:267-273`). What those field names do and do not match is
§ what-none-of-them-follow.
[t: tests/gc/roots.test.ts > "collects promises from microtask queue"]

**`pendingRejections`.** The `Map<PromiseHandle, TaggedValue>` [Ch 30 § what-leaves] handed
over: `markReachableHeapIds` seeds every *value* in it (`roots.ts:177-181`),
`enumerateRoots` extracts an object from each (`:275-280`). The keys are not walked in
either — a rejection reason is kept alive, the promise it belongs to is not, and the promise
is expected to be reachable some other way.

## External providers

There is one extension point, and it is fifteen lines long — the entire file:

```ts
import type { TaggedValue } from "../core/value/index.js";

type ExternalRootProvider = (visit: (value: TaggedValue) => void) => void;

const providers = new Set<ExternalRootProvider>();

export function registerExternalRootProvider(
  provider: ExternalRootProvider,
): void {
  providers.add(provider);
}

export function visitExternalRoots(visit: (value: TaggedValue) => void): void {
  for (const provider of providers) provider(visit);
}
```

— src/gc/external-roots.ts:1-15

The contract is one sentence: a provider is handed a `visit(value: TaggedValue)` callback
and calls it once for everything it is currently holding. All three walkers call
`visitExternalRoots` (`roots.ts:152`, `:248`, `:316`), each passing its own seeding
function, so a provider contributes to whichever walk is running without knowing which one
it is.

Fifteen lines is what it costs to let a backend the collector has never heard of contribute
roots, and that is the whole design claim. The JIT emits wasm; `src/gc/` contains no
reference to wasm, no import from `src/optimizing/`, and no knowledge that a second tier
exists. § case-the-jit-serialized-objects is what the fifteen lines buy.

The price is visible in what the file does *not* have.

> **Unenforced.** `registerExternalRootProvider` writes into a module-global `Set` with no
> matching deregistration and no engine scoping. Two `Engine`s in one process share the
> provider set; a provider whose backend has been torn down keeps being called on every
> walk; and a provider that throws takes the collection down with it. There is exactly one
> provider in the tree today (`src/optimizing/backends/wasm/codegen.ts:177-181`), registered
> at module load, so none of this has ever mattered. `grep -rn
> "registerExternalRootProvider" src/ tests/ --include=*.ts` returns three lines — the
> definition, the import, and the single call — and no test exercises the external-root path
> at all. Cost of fixing: a returned unregister function, and a `WeakRef` or an
> engine-scoped registry. [unpinned]

The native compiler pays the same debt with entirely different currency and no shared code:
its shadow stack ([Ch 61 § the-root-frame]) is a list of pointers the compiled program
itself maintains, because there is no VM object for a provider to be registered on.

## Three walkers

`src/gc/roots.ts` exports three functions that all mean "the roots" and all disagree.

| | `markReachableHeapIds` | `enumerateRoots` | `collectLiveHeapIds` |
| --- | --- | --- | --- |
| lines | `:109-226` | `:228-283` | `:285-334` |
| returns | `Set<number>` of heap ids | `GCObject[]` | `Set<number>` of heap ids |
| called by | `_maybeSweepHeapPayloads` | `GenerationalGC._roots` | `majorGC`, `finishIncrementalMajorGC` |
| frames | all three populations | all three populations | all three populations |
| transient roots | yes | yes | yes |
| external providers | yes | yes | yes |
| global cells | yes | yes | yes |
| microtask queue | yes, four field names | `task.promise` only | **no parameter at all** |
| `pendingRejections` | yes | yes | no |
| `compiledFn.constants` | via `p.compiled.constants` | no | yes, per frame |
| transitive | full worklist, 13 shapes | none | `payload.source` only |

The three differ in exactly one dimension that matters — **how deep they go** — and for two
of the three the depth is correct.

`enumerateRoots` is the shallowest by design. It returns `GCObject[]`, and it feeds
`GenerationalGC`, which walks the graph *itself* by calling `obj.visitReferences(processRef)`
on every object it processes ([Ch 31 § the-scavenge]). Depth would be duplicated work and a
second place to get it wrong. Its job is to name the starting objects and stop, and it does
exactly that: `extractHeapObject` (`roots.ts:336-345`) turns a value into a `GCObject` or
`null`, and everything else is the caller's problem.
[t: tests/gc/roots.test.ts > "returns object with gcHeader directly"],
[t: tests/gc/roots.test.ts > "returns null for primitives and non-gc objects"],
[t: tests/gc/roots.test.ts > "collects from multiple frames"]

`markReachableHeapIds` is the deepest, because it feeds `sweepHeapPayloads`, which walks
nothing. It seeds from every population (`:142-181`) and then drains a worklist over
thirteen payload shapes (`:183-223`): `slots`, `elements`, `overflowProperties`,
`symbolProperties`, `_primitiveValue`, `_mapData` entries, `_setData` values,
`closure.cells`, `properties`, `compiled.constants`, `prototype`, `prototypeObj`, `source`.
That list is the transitive closure, spelled out by hand.

`collectLiveHeapIds` also feeds `sweepHeapPayloads`, and is as shallow as `enumerateRoots`:

```ts
  const trackValue = (v: TaggedValue): void => {
    const id = getHeapId(v);
    if (id > 0) liveIds.add(id);
    const payload = heap.getPayload(v) as PayloadLike | null | undefined;
    if (payload && typeof payload === "object" && payload.source !== undefined) {
      trackValue(payload.source);
    }
  };
```

— src/gc/roots.ts:292-299

One field. `payload.source`, and nothing else.

> **Broken.** `collectLiveHeapIds` (`src/gc/roots.ts:285-334`) is the walker `majorGC` and
> `finishIncrementalMajorGC` hand to `sweepHeapPayloads` (`src/gc/gc.ts:321-322`,
> `:404-405`), and it follows only `payload.source`. Any payload reachable only through
> `slots`, `elements`, `overflowProperties`, `properties`, `closure.cells` or
> `compiled.constants` is freed by a major collection; the program then reads a dangling
> handle and gets `undefined` with no diagnostic and exit code 0. It also takes no
> `microtaskQueue` parameter (`:285-289`), so a pending microtask's values are not live
> during a major collection either. Reproduce in three lines:
>
> ```
> $ node dist/cli.js --expose-gc -e 'o = {s: "hi", n: 1.5}
> gc(1)
> print(o.n)'
> undefined
> ```
>
> `1.5` is a boxed double whose only reference is `o.slots[1]`. Cost of a fix: call
> `markReachableHeapIds(this.interpreter, this.globalCells, this.microtaskQueue,
> this.valueHeap)` at both sites — the deeper walker already exists and is already what the
> back-edge sweep uses. No test covers a major collection's handle sweep. [unpinned]

Nobody hit this in normal use for the reason [Ch 31 § the-collector-that-actually-runs]
gives: both call sites are inside a major collection, and a major collection is reachable
only from `gc()` under `--expose-gc`, `%CollectGarbage` under `--allow-natives-syntax`, or
an incremental cycle whose finisher is itself unreachable. The bug is real, it is
reproducible in three lines, and it has never fired in a program nobody was debugging.

The general shape is worth naming, because § what-none-of-them-follow is the same shape
eight more times: **three functions that must agree on a definition, with the definition
written out separately in each.** Nothing derives one from another and nothing compares
them.

## What none of them follow

An inventory. Each item names the field, the walker that would have to change, and what
fixing it would cost. All of them are `> **Unenforced.**` rather than `> **Broken.**`,
because none is a wrong answer today — each is a latent one, waiting for a program that
routes a value through it.

**`AccessorPair` slots.** `JSObject.visitReferences` skips them explicitly, twice:
`if (isAccessorPair(slot)) continue` at `src/objects/heap/js-object.ts:141` and the same for
overflow properties at `:148`. `markReachableHeapIds` seeds `p.slots` directly
(`roots.ts:185-187`) without unwrapping the pair. So a getter or setter *function* stored as
a property of an object is reachable from nothing at all.

> **Unenforced.** No walker follows an `AccessorPair`. Cost: two `if` branches in
> `visitFrameRoots`'s transitive step and two in `JSObject.visitReferences`, plus a decision
> about whether `AccessorPair` should carry a `gcHeader` of its own so the generational
> collector can see it too.

**Function accessors and `staticBase`.** `PayloadLike` (`roots.ts:57-71`) names
`properties`, `prototype`, `prototypeObj` and `closure.cells` on a payload, and stops.
`RuntimeFunctionPayload` also has `accessors?: Record<string, FunctionAccessor>` and
`staticBase?: RuntimeFunctionPayload | null` (`src/core/value/index.ts:198-199`).

> **Unenforced.** `PayloadLike` does not name `RuntimeFunctionPayload.accessors` or
> `.staticBase`, so a function-level accessor and a static member inherited through a
> class's `staticBase` chain are outside every walk. Cost: two entries in the worklist loop.
> The deeper cost is that `PayloadLike` is a hand-maintained subset of a payload type it is
> never checked against — the same shape as the `_mapData` / `_setData` list below.

**`_weakMapData`.** `PayloadLike` names `_mapData` and `_setData` and stops there.
`CollectionObject` (`src/objects/heap/factory.ts:26-31`) has a third: `_weakMapData`, an
`EphemeronHashTable`. Its contents are outside every walk. That is deliberate in intent and
wrong in mechanism, and [Ch 26 § weakmaps-ephemeronhashtable-is-not-an-ephemeron-table] owns the bug — the table implements no ephemeron
algorithm, so "not walked" does not produce weak-map semantics, it produces a table whose
values die at unpredictable times.

**Microtask payloads.** The walk at `roots.ts:164-175` tests for `value`, `result`,
`argument` and `promise`. Compare with what the four `Microtask` classes in
`src/runtime/microtasks/microtask.ts` actually have. `Microtask` (`:70-81`) has `type` and
`label`. `PromiseReactionMicrotask` (`:83-105`) has `reaction`, `promise`, `state` and
`value` — two of the four names match. `PromiseResolveThenableMicrotask` (`:107-170`) has
`promiseToResolve`, `thenable` and `thenMethod` — none match. `CallbackMicrotask`
(`:172-187`) has `callback` — none match. And `result` and `argument`, two of the four names
the walk tests for, exist on no `Microtask` subclass in the tree at all.

> **Unenforced.** The microtask root walk matches four field names, two of which exist
> nowhere. A queued `PromiseResolveThenableMicrotask` contributes no roots, a queued
> `CallbackMicrotask` contributes none, and every `PromiseReactionMicrotask.reaction`
> closure — which captures the frame it will resume — is matched by nothing. Cost of fixing:
> either a `visitRoots(visit)` method on `Microtask` that each subclass overrides, or a
> walker derived from the class list rather than guessed alongside it. The first is four
> small methods and makes the compiler complain when a fifth subclass is added.

Land the general rule these produce. **A root walk written as a list of field names is a
duplicate of a type declaration that nothing compares it against.** Every item above is a
place where a payload type grew a field and the walk did not. It is why they are marked
unenforced rather than broken: they are correct until the day a program stores something
reachable-only-there, and there is no mechanism that would tell you that day had arrived.

## Case: the iterator

The cleanest statement of the thesis in the tree, and the one no smarter walker could have
fixed.

```
for j of range(1000000):
  last = j
```

`range` is a host builtin that returns a JavaScript `number[]`
(`src/runtime/domain/builtins.ts:16-25`), which crosses into the runtime as a `JSArray` and
gets a handle. The for-of opcodes then call `getIterator`, whose array branch is this:

```ts
  if (isArray(value)) {
    let index = 0;
    const arr = getPayload(value) as Required<Pick<RuntimeObject, "getLength" | "getIndex">>;
    return mkIterator(
      new IteratorRecord(value, () => {
        if (index >= arr.getLength())
          return createIteratorResult(mkUndefined(), true);
        const item = arr.getIndex(index++);
        return createIteratorResult(
          item !== undefined ? item : mkUndefined(),
          false,
        );
      }),
    );
  }
```

— src/runtime/iteration/iterator.ts:116-130

The loop keeps the *iterator* in a register. The array is named by `arr` — a `const` in a
JavaScript closure environment — and by the `value` passed as the record's first argument.
Take away that first argument and nothing outside the closure names the array.

**Symptom.** Partway through a million iterations the loop starts reading `undefined`. Not a
crash: the handle index in the tagged value is still a valid number, `getPayload` finds a
null entry, and the program keeps going with wrong values.

**Mechanism.** The handle sweep runs on the back edge ([Ch 31 §
the-collector-that-actually-runs]), computes the live set with `markReachableHeapIds`, finds
the iterator record but nothing that names the array, and frees the array's slot. The array
object itself was still alive — the JavaScript closure held it, so the *host's* collector
would never have touched it — but its **handle** was reclaimed, and a tagged value is
nothing but a handle.

**Fix.** Not a smarter walk. A JavaScript closure environment has no enumerable fields;
there is no property to visit, no `Object.keys` that would find `arr`, no mechanism at any
price. The fix was a representation change: give `IteratorRecord` a field.

```ts
export class IteratorRecord {
  source: TaggedValue;
  next: (interpreter: IteratorInterpreter | null) => TaggedValue;
```

— src/runtime/iteration/iterator.ts:47-49

`source` holds the same tagged value the closure captured, as an ordinary property of an
ordinary object the walk already visits. Three lines of walker then follow it:
`roots.ts:222` in the transitive worklist, `:296-298` in `collectLiveHeapIds`'s
`trackValue`, and `:343` in `extractHeapObject`. All three exist because `source` is the one
field all three walkers agree on.

**Regression test.**
[t: tests/e2e/gc/heap-payload-sweep.test.ts > "keeps a temporary array alive for the whole for-of loop"]
runs the loop above for a million iterations and asserts `last` is `999999`.

**General rule.** When a value is reachable only through host-language capture, the fix is a
field, never a smarter walk. Every remaining case study is a variation on that sentence.

## Case: the baseline accumulator

The baseline compiler emits JavaScript, and its prologue starts by declaring six locals:

```
var acc,t,t2,t3,t4,sp=0;
```

— generated by src/optimizing/baseline/compiler.ts:145

`SCRATCH_LOCALS = ["t", "t2", "t3", "t4", "osr"]` at `compiler.ts:34` and
`ROOTED_LOCALS = ["acc", ...SCRATCH_LOCALS]` at `:35` name them. Between two bytecodes,
`acc` and the temporaries hold tagged values — the receiver of a property store, the
left operand of an addition, the array being indexed — inside a function the collector
cannot see into, in exactly the situation § a-root-is-a-field says is invisible.

The registers themselves are not a problem: `var r=new Array(nRegs)` (`compiler.ts:146`) is
an object, and an object can be passed. The temporaries cannot be, because passing `acc`
passes its *value at that moment*, and the collector needs its value at collection time,
which is later. So the prologue exports a reader instead:

```
$.enter(r,function(){return[acc,t,t2,t3,t4,osr];});
```

— generated by src/optimizing/baseline/compiler.ts:154

`BaselineRuntime.enter` (`runtime.ts:404-406`) pushes `{ registers, readLocals }` onto
`interp.baselineFrames`; `leave` (`:408-410`) pops it. The closure is the export: calling it
materialises six JavaScript locals as an array, and `visitFrameRoots`'s
`if (frame.readLocals) for (const value of frame.readLocals()) visit(value)`
(`roots.ts:81`) calls it during every walk. The discipline — push on entry, pop on exit —
is exactly `transientRoots`'.

Note what this costs. Every root walk, on every collection, calls a JavaScript closure per
live baseline frame and allocates a six-element array. That is not measured anywhere in this
tree, and it is not obviously the wrong trade: the alternative is spilling six values to a
real object on every bytecode.

Then there is a third strategy, used where neither exporting a value nor exporting a reader
works. `BaselineRuntime.c(idx)` memoises decoded constants:

```ts
  c(idx: number) {
    let val = this.constValueCache[idx];
    if (val === undefined) {
      val = this.wc(idx);
      this.constValueCache[idx] = val;
      pinHeapSlot(val);
    }
    return val;
  }
```

— src/optimizing/baseline/runtime.ts:228-236

`constValueCache` is a plain array on the runtime object, not on any frame, and it outlives
every frame that reads from it. Rather than teach the walk about it, the cache calls
`pinHeapSlot(val)` — adding the id to `pinnedHeapIds`, which both `freeHeapObjectSlot`
(`src/core/value/index.ts:499`) and `sweepHeapPayloads` (`:518`) refuse to touch. Pinning
makes a slot un-sweepable rather than making it reachable. It never unpins. For a constant
pool that is correct and bounded; as a general technique it is a leak with better manners.

**Regression tests.** The four cases in
`tests/e2e/optimizing/gc-roots.test.ts` under describe `"baseline frames are garbage
collection roots"`, each run under `{ allocationBudget: 8, youngGenSize: 16 }`:
[t: tests/e2e/optimizing/gc-roots.test.ts > "keeps an object held only in a baseline register alive across allocation"],
[t: tests/e2e/optimizing/gc-roots.test.ts > "keeps an array held only in a baseline register alive across allocation"],
[t: tests/e2e/optimizing/gc-roots.test.ts > "keeps a string held only in a baseline register alive across allocation"],
[t: tests/e2e/optimizing/gc-roots.test.ts > "keeps a nested object reachable after a nested allocation"]

One more thing the two tiers do not agree on:

> **Never runs.** `RegisterFrame.closeUpvalues` and `closeUpvaluesFrom`
> (`frame.ts:124-129`, `:131-140`) have callers only in the interpreter
> (`src/bytecode/register/interpreter/index.ts:1771, 2028, 2186, 2192, 2508`). The baseline
> compiler builds its own `UpvalueCell` map — `var _ouv=new Map()` at `compiler.ts:152`,
> populated by `$.closure(...)` at `:382` — and never closes anything in it. A closure
> created by baseline-compiled code therefore holds an *open* cell for the life of the
> value. It is safe today, because an open cell is a view onto `r` and `enter` exported
> `r`. But the two tiers do not agree on upvalue lifetime, nothing reconciles them, and a
> baseline frame that returns while a closure it made is still live keeps that frame's whole
> register array alive through the cell. [unpinned]

## Case: the suspended frame

A frame that has left the dispatch loop is on no stack and in no register file. Its
registers hold everything a half-finished async function or a paused generator is working
with, and the only structure naming it is `interpreter.suspendedFrames`. That is why the
`Map`'s *keys* are the third population in `forEachRootFrame`, and it is the direct answer
to the question [Ch 30 § what-leaves] asked.

Keeping them is necessary.
[t: tests/e2e/gc/heap-payload-sweep.test.ts > "preserves an async coroutine's heap local across collections"],
[t: tests/e2e/gc/heap-payload-sweep.test.ts > "preserves a generator's heap argument before it starts and while it is suspended"]

Keeping them *forever* is a leak. A generator that is created, advanced once, and then
abandoned is never resumed and never removed from the map, so its frame and every register
in it would be retained for the life of the process. The answer is a second pass inside the
sweep:

```ts
  dropUnreachableSuspendedFrames(live: Set<number>): void {
    for (const [frame, owner] of this.suspendedFrames) {
      if (owner && !live.has(getHeapObjectId(owner))) {
        this.suspendedFrames.delete(frame);
      }
    }
  }
```

— src/bytecode/register/interpreter/index.ts:1335-1342

The `ResumeOwner` is the generator object or promise the program would use to resume the
frame. If the program can no longer reach the owner, it can no longer resume the frame, so
the frame is garbage regardless of what its registers point at. Reachability of the *owner*
stands in for reachability of the frame.

The `if (owner && ...)` is the window. `resumeAfterSuspend` sets the owner to `null` for the
duration of an `await`:

```ts
  const ownerBeforeAwait = interpreter.suspendedFrames.get(suspendedFrame);
  interpreter.suspendedFrames.set(suspendedFrame, null);
  pendingPromise.addReaction((state, result) => {
    if (ownerBeforeAwait === undefined) interpreter.suspendedFrames.delete(suspendedFrame);
    else interpreter.suspendedFrames.set(suspendedFrame, ownerBeforeAwait);
```

— src/bytecode/register/interpreter/helpers.ts:163-167

A null owner is skipped by `dropUnreachableSuspendedFrames`, so an awaiting frame is
retained *unconditionally* — which is right, because a pending promise's continuation must
run whether or not anything holds the promise. It becomes droppable again only when the
reaction restores the previous owner, which happens before the frame is resumed.

And there is an ordering the whole thing depends on. `_maybeSweepHeapPayloads` runs mark,
then drop, then sweep ([Ch 31 § the-collector-that-actually-runs]).

> **Unenforced.** The order inside `_maybeSweepHeapPayloads`
> (`src/bytecode/register/interpreter/index.ts:1343-1356`) is load-bearing in both
> directions. Dropping before marking would delete frames whose owners the mark is about to
> prove live. Sweeping before dropping would leave the dropped frames' payloads alive for
> one more cycle — harmless, but it means the invariant is real in one direction and merely
> tidy in the other. Nothing states the ordering, nothing checks it, and it is three
> adjacent statements in a method with no comment (the tree has 26 comment lines in 120,822;
> this is one of the places that costs).

There is one more piece of evidence in the tree that this area is hard, and it is switched
off:

> **Unenforced.** A fuzzer-derived reproduction for seed 5534 — "object live only in an
> untracked JS location across a GC" — sits entirely commented out at
> `tests/e2e/optimizing/gc-roots.test.ts:124-177`, together with its single case,
> `"agrees across every tier (no use-after-free of a swept payload slot)"`. The bug it
> reproduced is fixed; the test that would notice a regression does not run. Cost of
> restoring: uncommenting it, and accepting the 300,000 ms timeout it was written with.
> [unpinned]

## Case: the JIT serialized objects

The fourth case study is the one that needs the extension point.

When the optimizing tier compiles a function that touches objects, it copies the object
graph into wasm linear memory and keeps a map back:

```ts
type ObjectPointerInfo = {
  ptr: number;
  obj: HeapPayload;
  value: TaggedValue;
  serializedSlots?: number;
  capacity?: number;
  serializedCount?: number;
};
```

— src/optimizing/backends/wasm/codegen.ts:264-271

`objPtrs: Map<number, ObjectPointerInfo>` (`codegen.ts:4411`) is built fresh per call and
lives in a JavaScript local. During the wasm call it is, for some of those tagged values,
the only thing holding them: the originals may have been overwritten in the caller's
registers, and the wasm side holds raw integers that the collector cannot recognise as
references at all.

A local cannot be a root. So the codegen publishes it to a module-level slot around the
call:

```ts
const threadLocal: ThreadLocalState = {
  currentObjPtrs: null,
  currentRuntime: null,
};

registerExternalRootProvider((visit) => {
  const m = threadLocal.currentObjPtrs;
  if (!m) return;
  for (const info of m.values()) visit(info.value);
});
```

— src/optimizing/backends/wasm/codegen.ts:172-181

`threadLocal.currentObjPtrs = objPtrs` on entry (`:4651`), and the previous value restored
on every exit path — `:4717` and `:4728` in the failure paths, `:4778` on the normal one,
with `prevObjPtrs` captured at `:4646`. Save-and-restore rather than set-and-clear, because
a wasm call can re-enter: a compiled function that calls back into the interpreter, which
calls another compiled function, nests two `objPtrs` maps, and only the innermost is the one
whose values are live in wasm memory right now. Setting `null` on the way out would strand
the outer map's values.

Why a module variable rather than a parameter threaded through the walk? Because the
provider is registered at module load — the `registerExternalRootProvider` call at
`codegen.ts:177` runs when the file is first imported, before any `Engine` exists. There is
nothing to attach it to. That is also the reason the provider set is process-global, and the
reason § external-providers has an honesty item about it.

**Regression tests.**
[t: tests/e2e/optimizing/gc-roots.test.ts > "materializes a single object shared by many fields exactly once"] —
one object referenced by many fields must serialize once and come back as one object, not
several; and
[t: tests/e2e/optimizing/gc-roots.test.ts > "does not blow up exponentially on a diamond chain, and deopts past the depth guard"] —
a diamond-shaped graph must not be traversed once per path, and past a depth limit the JIT
declines rather than serializing forever. Both run under
`{ allocationBudget: 8, youngGenSize: 16 }`, so a collection lands in the middle.

## The general rule

*(What was tried and rejected.)*

Four case studies, one shape. In every one, a live value was held only in host-language
storage — a closure variable, a JavaScript `var`, a `Map` in a local, a frame off the stack
— and the collector, which can see only fields, could not see it. In every one the fix was
one of three moves, in ascending cost and descending elegance.

**Export a field.** `IteratorRecord.source`: one property, three lines of walker, no
per-collection cost. Available whenever the holder is already an object the walk reaches,
and it is the only one of the three that also fixes the *generational* collector, because a
field is something `visitReferences` can be taught.

**Export a reader.** `readLocals`, and the external root provider. A closure that
materialises values on demand, called once per walk. Necessary when the values are not in
any object — JavaScript locals, a map in a local — and it costs an allocation per frame per
collection, unmeasured.

**Pin the slot.** `pinHeapSlot`, used by the baseline constant cache. Marks a handle
permanently un-sweepable. Correct for a bounded set that lives as long as the runtime, a
leak for anything else, and the only one of the three that does not make the value
*reachable* — the collector still cannot find it, it is simply forbidden to free it.

Two things were rejected, and both are worth stating because a reader will reach for them.

**Making the walkers cleverer.** There is no walk that finds `arr` inside the iterator's
`next` closure. A JavaScript closure environment exposes no properties, no enumeration, no
reflection; the only way in is a debugger protocol, which is not available to a program
inspecting itself. The information does not exist at any price.

**Scanning conservatively.** The classic escape — scan the stack and treat anything
pointer-shaped as a pointer — is not merely expensive here, it is impossible. There is no
addressable stack to scan, and tagged values are ordinary JavaScript numbers indistinguishable
from arithmetic results even if there were. Precision is not a design preference in this
engine; it is the only implementable option.

The debt this leaves the rest of the book: the same three moves reappear in the native
compiler, where the reason is different and the conclusion is the same. There, the collector
*could* scan the stack — it is compiled code, the stack is memory — and deliberately does
not, because a root slot in an AOT frame is a **mirror** of a pointer rather than a handle
naming one, which is precisely why nothing in that heap can move.
[Ch 61 § the-root-frame] is the same idea with no shared code, and
[Ch 61 § why-not-stack-maps] is the rejection argument again with different reasons.

## What leaves

Part IV's three artifacts, now safe to trust.

**An answer.** `latency mean=15.70 / throughput mean=898.19`, produced with no compilation
at all, under a collector that did not corrupt it. This is the oracle the other three tiers
are checked against.

**Feedback.** A filled `feedbackVector` per function — each `FeedbackSlot` carrying the
maps, call targets, type tags and elements kinds the interpreter observed while it ran —
together with warm `InlineCacheManager` entries. Nothing has read any of it yet.
[Ch 33 § slots-are-operands] is the first reader.

**A tier verdict.** `requiresInterpreterOnly(compiledFn)`
(`src/bytecode/register/interpreter/helpers.ts:82`), one `Set` membership test over the
instruction stream, deciding for the life of the process whether a function may ever reach
baseline or the JIT.

And one rule that binds every later part: **a tier that invents a new place to keep a value
owes the collector an export.** A JavaScript local owes a `readLocals` closure. A map of
wasm linear-memory offsets owes an external root provider. An AOT stack slot owes a shadow
stack entry ([Ch 61 § the-root-frame]). The debt is always paid in one of three currencies
— a field, a reader, or a pin — and it is always paid by hand, because there is no
mechanism in this engine that would notice it had not been.

## Verify it yourself

```bash
# A boxed double reachable only from an object slot, freed by a major collection.
node dist/cli.js --expose-gc -e 'o = {s: "hi", n: 1.5}
gc(1)
print(o.n)'

# The same value in a global cell, which collectLiveHeapIds does walk.
node dist/cli.js --expose-gc -e 's = "direct"
gc(1)
print(s)'

# Three lines: the definition, the import, the one call.
grep -rn "registerExternalRootProvider" src/ tests/ --include=*.ts

npx vitest run --project unit tests/gc/roots.test.ts tests/gc/transient-roots.test.ts
npx vitest run --project e2e tests/e2e/optimizing/gc-roots.test.ts
npx vitest run --project e2e tests/e2e/gc/heap-payload-sweep.test.ts
```

The first prints `undefined`. The second prints `direct`. The third returns exactly:

```
src/gc/external-roots.ts:7:export function registerExternalRootProvider(
src/optimizing/backends/wasm/codegen.ts:10:import { registerExternalRootProvider } from "../../../gc/external-roots.js";
src/optimizing/backends/wasm/codegen.ts:177:registerExternalRootProvider((visit) => {
```

— the whole extension surface, one provider, no test. The three suites report 12, 9 and 7
tests passing respectively.

For the object-slot case, the two probes are the same program with one character changed,
and that character is the whole chapter: `gc()` runs a minor collection and prints `1.5`,
`gc(1)` runs a major one and prints `undefined`, because the two collections use different
root walkers.

## Tests that pin this

- `tests/gc/roots.test.ts > "returns object with gcHeader directly"` — `extractHeapObject`'s first case.
- `tests/gc/roots.test.ts > "returns null for primitives and non-gc objects"` — that a boxed primitive is not a generational root.
- `tests/gc/roots.test.ts > "collects gc objects from interpreter frame locals and stack"` — `visitFrameRoots` against a two-field double.
- `tests/gc/roots.test.ts > "collects gc objects from globalCells Map"` — that a bare `Map` is accepted as a cell collection.
- `tests/gc/roots.test.ts > "collects promises from microtask queue"` — `enumerateRoots`' `task.promise` branch.
- `tests/gc/roots.test.ts > "handles all null inputs gracefully"` — the `?? []` discipline.
- `tests/gc/roots.test.ts > "collects from multiple frames"` — that `forEachRootFrame` visits every population.
- `tests/gc/transient-roots.test.ts > "marks a transient root as live"` — the array `CALL_ASYNC` pushes into.
- `tests/gc/transient-roots.test.ts > "tracks a transient root in the live heap-id set"` — the same through `markReachableHeapIds`.
- `tests/gc/transient-roots.test.ts > "reports a transient root as a GC root object"` — and through `enumerateRoots`.
- `tests/gc/transient-roots.test.ts > "follows a transient root transitively into its slots"` — that the worklist runs from a transient seed.
- `tests/gc/transient-roots.test.ts > "drops the root again once it is popped"` — the `finally`.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps a temporary array alive for the whole for-of loop"` — `IteratorRecord.source`, the iterator case study.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "preserves live state (objects, arrays, closures, generators) across sweeps"` — that the sweep's live set is not too small.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the slab bounded once the loop runs in baseline-compiled code"` — that it is not too large either.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "still reaches a safepoint when the back edge is a conditional jump"` — that the poll is emitted on every back-edge shape.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "preserves an async coroutine's heap local across collections"` — `suspendedFrames` as the third population.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "preserves a generator's heap argument before it starts and while it is suspended"` — including a frame that has never run.
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps an object held only in a baseline register alive across allocation"` — the `$.enter` export.
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps an array held only in a baseline register alive across allocation"` — the same for elements.
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps a string held only in a baseline register alive across allocation"` — a payload with no `gcHeader` at all.
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps a nested object reachable after a nested allocation"` — the transitive step from a baseline root.
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps the awaited promise alive while the async body allocates"` — `transientRoots` end to end.
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps a promise alive across a nested async call chain"` — nested pushes.
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps the promise alive when the async result is discarded"` — the case where no register names it.
- `tests/e2e/optimizing/gc-roots.test.ts > "materializes a single object shared by many fields exactly once"` — `objPtrs` identity across the boundary.
- `tests/e2e/optimizing/gc-roots.test.ts > "does not blow up exponentially on a diamond chain, and deopts past the depth guard"` — and its depth limit.
- `tests/gc/gc.test.ts > "follows references to keep transitive objects alive"` — that `enumerateRoots`' shallowness is covered by the collector's own walk.
- `tests/gc/gc.test.ts > "keeps slots of young objects still reachable from roots"` — the handle-table half of the same claim.
