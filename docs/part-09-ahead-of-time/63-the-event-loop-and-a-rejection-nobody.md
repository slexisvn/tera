# 63. The event loop, and a rejection nobody awaited   ⟨I · – · – · N⟩

Run the running example's async variation twice, once through the interpreter and once as a
native executable, and the two are indistinguishable:

```
$ node dist/cli.js docs/example/stats-async.tera
latency mean=15.70
throughput mean=898.19
$ node dist/cli.js compile docs/example/stats-async.tera -o /tmp/async.exe && /tmp/async.exe
latency mean=15.70
throughput mean=898.19
```

The interpreter got there with a `MicrotaskQueue`, a `JSPromise` carrying a list of
reactions, an `AsyncSuspend` control-flow object and a rejection ledger — all of it hosted by
a VM ([Ch 30](../part-04-execution/30-async-at-run-time-promises-microtasks-and.md)). The
binary has none of that, because there is nothing underneath it to host anything. What it has
instead is thirteen fields on `tera_context` and four generated functions that this chapter
builds: a ready queue, a wait set, a rejection list, and the loop that drains them.

It also has exactly one indirect call. Everywhere else in a compiled tera program the target
of a call is a symbol chosen at compile time — higher-order functions are monomorphised on
their function argument, dispatch cones become comparison chains, and the checker refuses
what neither can resolve ([Ch 58 § the-one-code-pointer](58-making-the-program-static.md)).
But `tera_drain` pops a suspended frame off a queue and cannot know which coroutine it
belongs to; that is the *definition* of a ready queue. So the frame carries its own resume
routine in a field, and `grep` finds one call through a variable in the whole emitted file.

`docs/example/stats.tera` cannot reach any of this — it has no `async` and no `await`. The
spine here is `docs/example/stats-async.tera`, which is in the tree and runs in
`tests/e2e/docs/book-examples.test.ts`. Two things even it cannot reach, and both appear
below as commands rather than listings, per [Conventions § 2](../CONVENTIONS.md): timers,
because nothing in the example set sleeps, and an unhandled rejection, because every example
succeeds.

**What arrived.** From [Ch 62 § what-leaves](62-generations-without-moving.md): a generational
non-moving heap. `tera_alloc` bumps against a nursery bounded by `nurseryLimit` on the inline
path and against the young count on the slow one; `tera_minor` marks the young list against a
remembered set; `tera_collect` walks the whole arena. And, crucially for this chapter, both
collectors already mark five runtime list heads out of `tera_context` —
`waitHead`, `sweepHead`, `queueHead`, `rejectedHead` and `rejectedText`. Chapters 61 and 62
rooted those five before naming them. This chapter is what they are.

## What the interpreter had

Start by naming what does not survive.

The interpreter's async machinery is a set of runtime services.
[Ch 30 § the-queue-is-an-array-with-a-head-index](../part-04-execution/30-async-at-run-time-promises-microtasks-and.md)
describes a `MicrotaskQueue` that is a growable array with a head index and a ten-thousand-task
budget per turn. `JSPromise` holds a *list* of reactions, because in JavaScript any number of
`.then` handlers may attach to one promise. `AsyncSuspend` is an object thrown through the
interpreter's own control flow to unwind a frame.
[Ch 30 § who-owns-a-rejection](../part-04-execution/30-async-at-run-time-promises-microtasks-and.md)
describes a four-operation ledger tracking which rejections have been observed.

Every one of those is a heap object with a runtime type, manipulated by TypeScript running
inside a VM. A compiled tera program has no TypeScript, no VM, and no runtime type. So the
replacement is not a port. It is thirteen `tera_context` fields —

```
waitHead  waitTail  waitCount  waitDue
sweepHead sweepCount
queueHead queueTail queueCount
rejectedHead rejectedCount rejectedText reportedCount
```
— `src/optimizing/target/runtime-layout.ts:133-145`

— and four `CFGFunction`s the AOT driver generates and then compiles like any other:
`tera_drain`, `tera_wake`, `tera_report_rejections` and `sleep`.

Keeping the loop's state in the context rather than in SSA values is the house idiom for
generated IR, and it has a visible consequence: none of those four graphs contains a single
phi. Every value the loops need is loaded from a context field at the top of the block that
needs it and stored back at the bottom. The graphs are built by hand with an `Emitter`, and
not needing SSA construction is why that is tractable.

## Three shapes

The object model is three synthetic classes, defined in twenty-six lines:

```ts
export function coroutineBaseShapes(classes: ClassTable): void {
  classes.defineSynthetic(
    syntheticSurface(CORO_FRAME_BASE, null, [
      [CORO_ROUTINE_FIELD, CORO_RESUME_TYPE],
      [CORO_STATE_FIELD, "int"],
      [CORO_NEXT_FIELD, CORO_FRAME_BASE],
    ]),
  );
  classes.defineSynthetic(
    syntheticSurface(CORO_PROMISE_BASE, null, [
      [CORO_STATE_FIELD, "int"],
      [CORO_WAITING_FIELD, "int"],
      [CORO_WAITER_FIELD, CORO_FRAME_BASE],
      [CORO_UNREPORTED_FIELD, "int"],
      [CORO_NEXT_REJECTED_FIELD, CORO_PROMISE_BASE],
      [CORO_ERROR_FIELD, PENDING_THROW_TYPE],
      [CORO_ERROR_VALUE_FIELD, classes.thrownType() ?? PENDING_THROW_TYPE],
    ]),
  );
```
— `src/optimizing/metadata/coroutines.ts:82-101`

`tera_frame` is a suspended activation: a code pointer, a resume state saying which suspend
point to jump back to, and a `next` link. That third field is why the ready queue needs no
node type of its own — the queue is *intrusive*, threaded through the frames themselves, so
draining allocates nothing. That matters more than it sounds: a drain runs immediately before
the program exits and immediately after every await, which is exactly when an allocation would
be most inconvenient.

`tera_promise` is the result: a state (`PENDING` / `RESOLVED` / `REJECTED`), **one** waiter
slot and a flag saying whether it is occupied, and three fields of rejection bookkeeping —
`unreported`, `nextRejected` and the error text. § the-waiter-chain is about that "one".

`tera_timer extends tera_promise`, adding `due: float` and a `timer` link
(`coroutines.ts:102-107`). The inheritance is doing real work rather than tidiness: a timer
**is** a promise, so `await sleep(10)` goes down the same park-and-wake path as
`await someAsyncFunction()`, unchanged, and `buildSleep` needs to implement nothing but
allocation.

On top of those three, [Ch 58 § deciding-what-the-frame-must-hold](58-making-the-program-static.md)
derives a per-function subclass pair — `f$frame` and `f$promise` — with one field per value
that has to survive a suspend. In the running example those are `mean_of$frame`,
`mean_of$promise`, `main$frame` and `main$promise`.

## The ready queue

`tera_drain` is four basic blocks, and you can read the whole thing in the emitted C.
Compile the async example to C source and look at the loop:

```c
static int32_t tera_drain(void) {
  ...
L1:;
  unsigned char *v4 = (unsigned char *)&tera_context;
  const int32_t v5 = (*(int32_t *)(v4 + 168));
  const int32_t v6 = (double)v5 > (double)v0;
  if (v6 != 0) { goto L2; } else { goto L3; }
L3:;
  tera_context.root_count = roots;
  return v2;
L2:;
  unsigned char *v9 = (unsigned char *)&tera_context;
  unsigned char *v10 = (*(unsigned char * *)(v9 + 152));
  tera_context.roots_base[roots + 0] = (unsigned char *)v10;
  unsigned char *v11 = (*(unsigned char * *)(v10 + 24));
  tera_context.roots_base[roots + 1] = (unsigned char *)v11;
  (*(unsigned char * *)(v9 + 152)) = v11;
  const int32_t v13 = (*(int32_t *)(v9 + 168));
  (*(int32_t *)(v9 + 168)) = tera_to_i32((double)v13 - (double)v1);
```
— generated `stats-async.c:4597-4627`, one line elided at the arithmetic

Read it with the displacement table from
[Ch 61 § one-file-two-implementations](61-the-arena-the-shadow-stack-and-why.md):
`tera_context + 152` is `queueHead`, `+ 160` is `queueTail`, `+ 168` is `queueCount`. `L1`
tests `queueCount > 0`; `L3` returns; `L2` takes the head, follows its `next` at frame offset
24, publishes the successor as the new head, decrements the count, and resumes. Then two more
lines, which are the next section.

Notice both the head and its successor get root slots. A resumed coroutine allocates, an
allocation can collect, and at that moment the only reference to the rest of the queue is
`queueHead` — which the collector marks by name — plus these two locals, which it marks
because they are mirrors on the shadow stack.

`buildDrain` (`src/optimizing/passes/coroutines.ts:1270-1331`) constructs those four blocks
directly, with no phis: `entry` jumps to `test`, `test` branches to `body` or `done`, `body`
falls back to `test`.

## The one indirect call

> **New idea.** A *direct call* names its target at compile time — the assembler writes a
> symbol and the linker fills in an address. An *indirect call* reads the target out of memory
> at run time and jumps to whatever is there. Direct calls can be inlined, devirtualized and
> checked; indirect calls cannot, and on modern hardware they are also the ones a branch
> predictor can get wrong. A compiler that can turn an indirect call into a direct one almost
> always should.

A compiled tera program has almost none. Module-level captures remove the closure object;
closure conversion removes the environment; monomorphisation compiles one copy of a
higher-order function per function argument ([Ch 58 § a-parameter-that-is-only-ever-called]);
interface and subclass dispatch become comparison chains over shape ids
([Ch 57 § the-dispatch-ladder](57-objects-without-a-runtime-type.md)); and what none of those
resolves, the legality analysis refuses.

`tera_drain` defeats all of it. It holds a frame it took off a queue, and the queue is shared
by every coroutine in the program. Deciding which `$resume` to call is precisely what the
data structure exists to defer. So the frame carries its routine:

```ts
    const routine = step.load(head, base, CORO_ROUTINE_FIELD);
    const resumed = irGenericCall(routine, [head]);
```
— `src/optimizing/passes/coroutines.ts:1322-1323`

`CORO_RESUME_TYPE` is `"(tera_frame) -> int"` (`metadata/coroutines.ts:7`), and a field of
that type gets the scalar `SCALAR_CODE` (`src/optimizing/types/scalar.ts:15`) — the sixth of
the seven `AotScalar`s, pointer-sized and **not** a reference. That distinction is
load-bearing for the previous two chapters: `referenceFieldOffsets`
(`src/optimizing/metadata/class-table.ts:1002-1008`) collects only `SCALAR_POINTER` fields, so
a code pointer never enters `tera_class_fields` and the collector never follows it. You can
check that in the running example's own class table: the frame base's entry is
`tera_fields_3[] = { 24 }` — the `next` link at offset 24 and nothing at offset 8, where the
routine lives.

In the emitted C the whole mechanism is five lines, spread across three thousand:

```c
typedef void (*tera_fn)(void);                     /* 5    */
  tera_fn v0 = (tera_fn)mean_of_resume;            /* 1299 */
  (*(tera_fn *)(v8 + 8)) = v0;                     /* 1324 */
  const tera_fn v16 = (*(tera_fn *)(v10 + 8));     /* 4628 */
  ((int32_t (*)(unsigned char *))v16)(v10);        /* 4629 */
```
— generated `stats-async.c`

The address of a resume routine is *stored into a frame* when the coroutine is created — twice
in this program, once for `mean_of` and once for `main` — and read back out by `tera_drain`.
Search the whole file for a call through a variable and there is exactly one site: line 4629.
Every other call in the binary names its target.

The alternative the tree rejected is a comparison chain over frame kinds, which would have
been consistent with how every other dispatch in a compiled tera program works. It is rejected
by name in a test — `tests/e2e/optimizing/aot/async.test.ts` >
`"resumes a frame through the routine it carries rather than a comparison chain"` — because a
chain would grow with the number of async functions in the program and would have to be
regenerated whenever one was added, in a routine that is emitted once and shared.

## Why the obvious design fails: a waiter is not a list

The obvious design is the interpreter's, and it is the one the ECMAScript specification
requires: a promise holds a *list* of reactions, because `p.then(a); p.then(b)` must run both.

Here a promise holds **one** waiter frame and an `int` flag saying whether the slot is
occupied. That looks like a shortcut. It is not; it is a consequence of a refusal made in a
different file.

`misusedPromise` (`src/optimizing/drivers/aot.ts:343-361`) walks every graph and refuses any
function in which a call to a suspending callee has a use that is not an `IR_AWAIT`:

```ts
      if (node.uses.every((use) => use.type === IR_AWAIT)) continue;
      return {
        name: graph.name,
        reason:
          `the promise ${name} returns is used as a plain value here; ` +
          `await it before using it, or keep this part interpreted`,
      };
```
— `src/optimizing/drivers/aot.ts:351-357`

Every use, directly. Not "reaches an await through a phi" — *is* an await. So the awaited
value is always the call node itself, a promise can never be stored, copied, passed or
merged, and no two coroutines can ever hold the same promise. One waiter slot is therefore
enough, and a program that would need two is declined before this code is reached:

```
$ node dist/cli.js compile mis.tera -o mis.exe
tera compile: note: 'mid' is not in the binary, and nothing the program runs calls it (the promise g returns is used as a plain value here; await it before using it, or keep this part interpreted)
```

The protocol on top of one slot is short. A coroutine suspending on a promise checks whether
its state is already `RESOLVED`; if so it enqueues itself immediately, and if not it parks —
`p.waiter = self; p.waiting = SOMEONE_WAITING` — and returns to the drain loop. Resolving the
promise checks `waiting`, and if a frame is parked, clears the flag and enqueues it.

One footnote earns its line. `waiting` is stored explicitly at every promise allocation site
(`coroutines.ts:936`, and again in `buildSleep`) rather than relied on to be zero, because
`tera_alloc`'s free-list path hands back a *recycled* block. The C allocator does zero the
whole block before stamping the header (generated `stats.c:492`), but depending on that would
make the coroutine lowering correct only for one of the three backends' allocators.

> **Unenforced.** The one-waiter invariant — that a promise can never reach two coroutines —
> is established by `misusedPromise` in `src/optimizing/drivers/aot.ts`, which is a *refusal in
> a different file* from the field it protects. Nothing in `coroutineBaseShapes`
> (`src/optimizing/metadata/coroutines.ts:82-107`) records that `waiter` is single-occupancy,
> and a future pass that introduced a phi between a suspending call and its await would
> silently overwrite a parked frame — losing a coroutine with no diagnostic. Cost of enforcing:
> the no-comment rule means it cannot be a note, so it wants an assertion in `appendWaiting`
> that `waiting == CORO_NOBODY_WAITING` before the store — about four IR nodes, paid on every
> park.

## Two ordering constraints

`splitCoroutine` (`src/optimizing/passes/coroutines.ts:905-968`) does its work in a fixed
order, and two adjacent lines in the middle of it are load-bearing:

```ts
  const exits = returnsOf(resume);
  for (const point of points) suspendAt(resume, classes, frame, self, point);
  spills.spillInto(frame, self);
```
— `src/optimizing/passes/coroutines.ts:937-939`

**Invariant one: `suspendAt` must run before `spillInto`.** `suspendAt` splits a block at an
await and introduces new *uses* of the awaited promise on the far side of the split — in the
resume block, which is reached by a jump from the dispatch head rather than by falling
through. Those uses have to go through the spill machinery, or the resume block's entry reads
an SSA value that no dominating block defines.

**Invariant two: `exits` must be captured before `suspendAt`.** `suspendAt` inserts returns of
its own — the pending-throw path a suspended coroutine takes when it hands control back to the
drain loop. Those are not ordinary exits and must not be settled as though a value had been
returned, so `returnsOf` has to run first and its answer has to be frozen.

**Enforcement.** The order of three statements in one function. Nothing else.

> **Unenforced.** Both constraints in § two-ordering-constraints hold only because of the
> sequence at `src/optimizing/passes/coroutines.ts:937-939`. Reversing either produces a graph
> that passes `validateSSA` on simple programs and reaches an undefined value on programs with
> more than one suspend, and the symptom surfaces in a resume block a long way from the cause.
> The coroutine pass is not among the passes `verifyEachPass` covers
> ([Ch 78 § verifiers-everywhere](../part-12-watching/78-verifiers-everywhere.md)), so nothing
> re-checks the graph between these three lines and the next stage. Cost of enforcing: an
> assertion in `suspendAt` that the exit set is already frozen, plus adding the coroutine pass
> to the per-pass verifier.

## Sleep is a promise subclass

`buildSleep` is twenty-seven lines and implements no scheduling at all:

```ts
  const out = new Emitter(classes, entry);
  const timer = out.allocate(shape);
  out.store(timer, shape, CORO_STATE_FIELD, out.constant(CORO_STATE_PENDING));
  out.store(timer, shape, CORO_WAITING_FIELD, out.constant(CORO_NOBODY_WAITING));
  out.store(timer, shape, CORO_UNREPORTED_FIELD, out.constant(CORO_REPORTED));
  out.store(
    timer,
    shape,
    CORO_DUE_FIELD,
    out.add(irFloat64Add(nowMillis(out), millis)),
  );
  const joined = appendWaiting(graph, classes, timer, shape, entry);
  joined.addNode(irReturn(timer));
```
— `src/optimizing/passes/coroutines.ts:1165-1178`

Allocate a `tera_timer`, mark it pending with nobody waiting, compute its deadline from the
clock builtin, append it to the wait set, return it. Everything else — awaiting it, parking on
it, being woken by it — is the promise path that already exists, because a timer *is* a
promise. Note `unreported` is set to `CORO_REPORTED` rather than `CORO_UNREPORTED`: a timer
never rejects, so it must never enter the rejection list.

That is the design point worth taking away. Adding a new asynchronous source to this runtime
costs one subclass of `tera_promise` and one allocator function. It does not cost a scheduler,
a new queue, or a new state in the drain loop.

There is one trap, and its failure mode is silence. `sleep` has to be listed in
`suspendingCallees`:

```ts
  if (timers) asynchronous.add(CORO_SLEEP);
```
— `src/optimizing/drivers/aot.ts:287`

If it is not, `await sleep(10)` is not recognized as a suspension point, the enclosing async
function is never split, and the program compiles — to code that does not wait. Nothing
reports anything.

## Blocking, not spinning

A compiled program that has nothing to run and a timer outstanding must not spin. `buildWake`
(`coroutines.ts:1182-1269`) opens by actually sleeping:

```ts
  const span = opening.add(
    irFloat64Sub(opening.loadContext(started, "waitDue", FLOAT), nowMillis(opening)),
  );
  waitMillis(opening, span);
```
— `src/optimizing/passes/coroutines.ts:1201-1205`

`waitMillis` lowers to the `WAIT_BUILTIN`, which the C backend renders as `tera_pause` —
`Sleep((unsigned long)millis)` on Windows and `nanosleep` elsewhere, with an early return when
the span is not positive (`src/optimizing/backends/c/emit.ts:1214-1225`). A real blocking wait
on a real OS primitive.

`waitDue` is why no scan is needed to decide how long to sleep. `appendWaiting` maintains it as
the earliest deadline in the wait set — set outright when the set was empty, and reduced by a
minimum when a timer is appended to a non-empty one (`coroutines.ts:1126-1136`). The blocking
step reads one field.

After the wait, `buildWake` moves the entire wait list wholesale into `sweepHead`/`sweepCount`,
zeroes `waitCount`, and re-partitions it one timer at a time. An expired timer is resolved and
its parked waiter enqueued; an unexpired one is appended back onto the now-empty wait set.

The list is *rebuilt* rather than filtered in place for two reasons, and both are consequences
of decisions made two chapters ago. There is no way to remove an entry from the middle of a
singly-linked list without a previous-pointer, and adding one would grow every timer. And
filtering into a new list would allocate — inside the loop that runs when the program has
nothing to run, which is exactly when a collection is most likely and least welcome. Moving
the head pointer costs two stores and allocates nothing.

That is also why the second list head exists at all. `sweepHead` is not a separate data
structure; it is the wait set, borrowed for the duration of one pass, so that appends during
the pass go to a fresh list rather than into the list being walked.

## The loop with timers

`buildDrain` takes a `timers: boolean` and grows two blocks when it is true:

```ts
  if (timers) {
    const blocking = graph.addBlock();
    const stalled = new Emitter(classes, empty);
    const waiting = stalled.loadContext(stalled.context(), "waitCount", DECLARED_INT);
    const parked = stalled.add(irInt32Compare(">", waiting, stalled.constant(0)));
    empty.addNode(irBranch(parked, blocking, done));
```
— `src/optimizing/passes/coroutines.ts:1295-1301`

When the ready queue empties, ask whether anything is parked. If it is, call `tera_wake` and go
back to the test; otherwise finish. Six blocks instead of four.

The semantics that fall out of those six blocks are worth naming, because they are a language
decision and not an implementation detail: **a pending timer keeps the program alive.** The
entry function has returned, the queue is empty, and the program still waits — which is what
Node does, and what the `OUTLIVES` case pins:

```
async fn late() -> int:
  await sleep(5)
  print("ran")
  return 0
late()
print("first")
```
prints `first` then `ran`
[t: `tests/e2e/optimizing/aot/timers.test.ts` > `"keeps the program alive while a frame is still parked when the interpreter runs it"`,
and the same shape as a native binary at `"keeps the program alive while a frame is still parked in a native binary"`].

The flag is conditional rather than always-on for a mechanical reason: `buildWake` is only
added to the module when `timers` holds
(`src/optimizing/drivers/aot.ts:566-571`), so an unconditional branch to it in `tera_drain`
would leave every non-timer async program referencing a symbol that was never emitted. You can
see the outcome in the running example: `grep -c tera_wake` over its emitted C answers `0`,
and `tera_drain` is the four-block version.

> **Unfinished.** `await sleep(ms)` compiles on two of the four target/platform combinations.
> `cTarget` declares `"timers"` unconditionally
> (`src/optimizing/backends/c/target.ts:14`); the x64 target declares it only when its
> `PlatformIo` supplies both `now` and `wait`
> (`src/optimizing/backends/x64/target.ts:80-83`), which `windowsIo` does and `sysvIo` does
> not; and riscv64 declares neither `timers` nor anything else beyond `terminating-throw` and
> `float-text`. So the same source compiles on x64-windows and is declined on x64-linux. This
> entry is already in [Appendix D](../appendix/d-inventory.md); this chapter confirms it and
> shows the message. Cost of finishing: a monotonic clock and a blocking wait per platform —
> `clock_gettime` and `nanosleep` in `sysvIo`, on the order of sixty lines of machine IR;
> riscv64 needs an instruction encoder first.

The refusal is a full sentence naming the backend by id, and — as everywhere in this compiler —
it arrives with the downstream symptom beside it:

```
$ node dist/cli.js compile tick.tera --target x64 --platform linux --emit source -o /tmp/tick-lin
tera compile: note: 'tick' is not in the binary, and nothing the program runs calls it (sleep needs a monotonic clock and a blocking wait, which the x64-linux backend does not provide)
tera compile: note: 'tera_program' is not in the binary, and nothing the program runs calls it (calls unavailable function tick)
```

The second note is the consequence, not a second problem: the entry cannot be compiled because
it calls a function that was declined. Both are notes rather than errors, and a file is still
written — the declined functions simply are not in it, and would run in the interpreter
([Ch 56](56-legality-and-the-art-of-refusing-well.md)).

## Deadlock is reported, not hung

A program can await a promise that nothing will ever settle. A real JavaScript runtime exits
zero at that point, with the promise unresolved and no diagnostic — the loop simply has nothing
left to do. tera treats it as a fault.

`stopWhenPending` (`src/optimizing/passes/coroutines.ts:444-467`) inserts, after the drain that
each await performs, a check that the promise is no longer `PENDING`, and a throw if it is:

```ts
  const pending = stateIs(classes, out, awaited, promise, CORO_STATE_PENDING);
  const { raise, resumed } = branchWhen(graph, block, pending);
  const stopped = new Emitter(classes, raise);
  const intrinsic = builtinGlobalIntrinsicByName(THROW_BUILTIN)!;
  raise.addNode(
    irCallBuiltin(
      THROW_BUILTIN,
      [stopped.add(irConstant(TERA_NEVER_SETTLED))],
      builtinMethodCallMetadata(intrinsic),
    ),
  );
```
— `src/optimizing/passes/coroutines.ts:453-463`

`TERA_NEVER_SETTLED` is `"awaited a promise that never settled"`, and it lives in
`src/optimizing/target/faults.ts` beside every other user-visible sentence the runtime can
produce — one string for all three backends rather than one per emitter. The program prints
`Uncaught awaited a promise that never settled` and exits 1.

Whether that is the right choice is a judgement, and this book will not pretend it is
uncontroversial: a program that Node would let finish quietly, tera fails. The argument for it
is that a compiled binary has no console to inspect afterwards and no debugger attached, so a
silent exit-zero is indistinguishable from success. The argument against it is that it is a
deliberate divergence from the interpreter's own behaviour, which is the one thing this book
otherwise treats as sacred.

## Drain before exit

Nothing calls `tera_drain` from the outside. It is spliced in:

```ts
export function drainBeforeExit(graph: CFGFunction): number {
  return withFreshNodeIds(graph, () => {
    let inserted = 0;
    for (const block of graph.blocks) {
      const at = block.nodes.findIndex((node) => node.type === IR_RETURN);
      if (at < 0) continue;
      const calls = [CORO_DRAIN, CORO_REPORT].map((name) => {
        const call = irCallKnownFunction({ name } as never, []);
        call.block = block;
        return call;
      });
      block.nodes.splice(at, 0, ...calls);
      inserted++;
    }
```
— `src/optimizing/passes/coroutines.ts:970-983`

Every block that contains an `IR_RETURN` gets `tera_drain(); tera_report_rejections();`
inserted in front of it. Every one, not just the last, because an entry with an early return
would otherwise exit with coroutines still queued and rejections still unexamined. The running
example's entry has two exits, and both are covered:

```
$ grep -n "tera_drain();" /tmp/async-c/stats-async.c
3361:  tera_drain();
3382:  tera_drain();
```

> **Unenforced.** `drainBeforeExit` is applied to `entry.graph` alone — the single unit whose
> name matches `entryName` (`src/optimizing/drivers/aot.ts:572-573`). A program whose real exit
> lay in another unit would leave the loop undrained and every rejection unreported, silently.
> No current lowering produces that shape and no test covers it. Cost of enforcing: check that
> `drainBeforeExit` returned a non-zero count when the module has coroutines — one line, which
> at least converts silence into a compiler error.

## Rejections nobody awaited

The specification comes from the interpreter, and
[Ch 30 § who-owns-a-rejection](../part-04-execution/30-async-at-run-time-promises-microtasks-and.md)
states it: a rejection that nothing ever observes must print
`Uncaught (in promise) <value>` on stderr and fail the program; a rejection that something
awaited must print nothing.

The AOT compiler cannot decide that at rejection time. "Nobody awaited it" is a statement about
the *whole rest of the program*, and it only becomes knowable after the final drain, when there
is nothing left that could await anything. So the machinery is a ledger, and the three
`tera_promise` fields carry it:

- Settling a promise as rejected pushes it onto `rejectedHead` through the promise's own
  `nextRejected` field — LIFO, intrusive, no allocation — and increments `rejectedCount`.
- An await that consumes a rejection clears the promise's `unreported` flag.
- `tera_report_rejections`, spliced in by `drainBeforeExit` immediately after the final
  `tera_drain`, walks the list and reports what is left.

The behaviour is identical to the interpreter's, and it is checkable in one command:

```
$ node dist/cli.js rej.tera ; echo "exit=$?"
done
Uncaught (in promise) boom
exit=1
$ node dist/cli.js compile rej.tera -o rej.exe && ./rej.exe ; echo "exit=$?"
done
Uncaught (in promise) boom
exit=1
```

`done` on stdout, the report on stderr, exit 1, from a program whose `f()` result nobody bound.

## Backwards accumulation

Here is the nicest small idea in the chapter. Reporting *every* unawaited rejection needs one
exit path, and the exit path a compiled tera program has is a single `throw`. So N rejections
have to become one string — in the order they settled, from a list that is in the reverse of
that order, with no tail pointer, no second pass and no new runtime routine.

The trick is to concatenate backwards. Walk the LIFO list forwards (which is reverse settle
order) and put each unreported error on the *front* of an accumulator held in
`tera_context.rejectedText`. Reversing the traversal and reversing the concatenation cancel.

In the emitted C it is nine lines:

```c
L5:;
  unsigned char *v42 = (unsigned char *)&tera_context;
  unsigned char *v43 = (*(unsigned char * *)(v42 + 192));
  tera_context.roots_base[roots + 3] = (unsigned char *)v43;
  const tera_char *v44 = (tera_char *)(v43 + 40);
  const tera_char *v45 = (tera_char *)(v26 + 40);
  const tera_char *v46 = tera_str_append(tera_str_set(sb0, 8192, v45), 8192, v5);
  const tera_char *v47 = tera_str_append(tera_str_set(sb1, 8192, v46), 8192, v44);
  tera_str_set((tera_char *)(v26 + 40), 512, v47);
  (*(unsigned char * *)(v42 + 192)) = v26;
```
— generated `stats-async.c:4710-4720`

`tera_context + 192` is `rejectedText`, the accumulator; `+ 40` is a promise's `error` field.
`v45` is this promise's message, `v44` is everything accumulated so far, and the result is
`this + SEPARATOR + accumulated`, written back into this promise and made the new accumulator.

`v5` is the separator, and it is a compile-time constant array of code units:

```c
static const tera_char v5[] = {0xa, 0x55, 0x6e, 0x63, 0x61, 0x75, 0x67, 0x68, 0x74, 0x20,
  0x28, 0x69, 0x6e, 0x20, 0x70, 0x72, 0x6f, 0x6d, 0x69, 0x73, 0x65, 0x29, 0x20, 0x0};
```
— generated `stats-async.c:4642`

That is `"\nUncaught (in promise) "` — `TERA_REJECTED_SEPARATOR`, defined in
`src/optimizing/target/faults.ts:5` as `` `\n${TERA_UNCAUGHT_PREFIX}${TERA_REJECTED_PREFIX}` ``.
The accumulated string therefore already contains the newlines and the repeated prefix, and the
final throw only has to prepend `TERA_REJECTED_PREFIX` once for the first entry, because the
throw builtin supplies the leading `"Uncaught "` the way it does for any uncaught value. One
throw renders as N lines of stderr.

Two rejections, both fire-and-forget, are enough to see it work in the right order:

```
$ node dist/cli.js rej2.tera        # interpreter
done
Uncaught (in promise) first
Uncaught (in promise) second
$ node dist/cli.js compile rej2.tera -o rej2.exe && ./rej2.exe
done
Uncaught (in promise) first
Uncaught (in promise) second
```

Byte for byte, exit 1 from both, out of a list that was built in the opposite order.

## Rooted or swept

Close the loop with [Ch 61 § the-five-list-heads](61-the-arena-the-shadow-stack-and-why.md).

A frame parked on a promise is reachable from `promise.waiter` and from nothing else. A frame
on the ready queue is reachable from `queueHead` and the `next` chain and from nothing else. A
rejected promise waiting to be reported is reachable from `rejectedHead` and from nothing else
— *by construction*, since "nobody awaited it" is exactly the statement that no live frame
holds it. And the partially accumulated report is reachable only from `rejectedText`.

So every one of those four pointers has to be in the root set of every collector, minor and
major, or the exit walk reads freed memory. They are: `tera_collect` marks all five
(generated `stats.c:366-385`) and `tera_minor` marks the same five
(generated `stats.c:398-402`), and the x64 implementation reaches both through one `markRoots`
with a `youngOnly` flag (`src/optimizing/backends/x64/heap.ts:458-503`).

**The general rule: a runtime list head is a root set.** Adding a sixth runtime list means
adding a sixth mark, by hand, in four places — and chapter 61 records that the hand-written
lists have already drifted, with riscv64's collector marking three of the five. That is not a
live bug only because riscv64 declares no `timers` capability, so `waitHead` and `sweepHead`
are permanently null there. Nothing states that reasoning and nothing checks it
([Ch 61 § the-five-list-heads]).

The behavioural pin for all of this is a single e2e case that forces a collection while a frame
is suspended: `tests/e2e/optimizing/aot/async.test.ts` >
`"keeps a suspended frame alive across a collection"`, plus two shapes in the suspending-coroutine
match table — `"a collection while a frame is parked on a promise"` and
`"a collection while a frame is parked on a promise that rejects"`.

## When the protocol exists at all

One paragraph of honest scoping, because the rejection machinery is not always there.

The whole protocol is part of throw recovery, and throw recovery is switched on by
`needsThrowRecovery`:

```ts
function needsThrowRecovery(selected: readonly RegisterCompiledFunction[]): boolean {
  if (selected.some(catchesThrows)) return true;
  return selected.some((fn) => fn.isAsync === true) && selected.some(raisesThrows);
}
```
— `src/api/engine.ts:480-483`

The first line is the obvious case: a program with a `catch` needs recovery. The second is the
one this chapter needs, and it took a bug to find: a module with an async function **and** a
throw needs recovery even with no `try` anywhere. Without that clause, a throwing coroutine in
a `try`-free program lowers straight to the terminating throw builtin — it exits the process at
the point of the throw and never rejects its promise at all, so nothing is ever added to
`rejectedHead` and the report is empty. The pin is
`tests/e2e/optimizing/aot/async-suspend.test.ts` >
`"reports a rejection nobody catches even with no try anywhere"`, and the title says exactly
what the clause is for.

## What leaves

Part X receives the program complete. Four more `CFGFunction`s — `tera_drain`,
`tera_report_rejections`, and, when the program sleeps, `tera_wake` and `sleep` — appear in
`module.units` with no special status whatever: they are selected, scheduled,
register-allocated and encoded by exactly the machinery that handles the user's own functions,
and [Ch 64](../part-10-bytes/64-machineir-and-instruction-selection.md) will not be able to tell
them apart from `report`.

One thing in them is new to Part X, and it is one opcode: `IR_GENERIC_CALL` applied to a value
whose scalar is `SCALAR_CODE`. Nothing else a compiled tera program contains produces an
indirect call — not a closure, not an interface method, not a higher-order function argument —
so `tera_drain`'s `call *%rax` is the single site where the backend must lower a call whose
target is a register rather than a symbol. That is
[Ch 64 § instruction-selection](../part-10-bytes/64-machineir-and-instruction-selection.md)'s
obligation, and it is the last thing this part hands over.

## Verify it yourself

```bash
# The interpreter and the binary agree on the async spine.
node dist/cli.js docs/example/stats-async.tera
node dist/cli.js compile docs/example/stats-async.tera -o /tmp/async.exe && /tmp/async.exe
```

```bash
# The one indirect call. Five tera_fn lines; the call itself is the next line after the last.
node dist/cli.js compile docs/example/stats-async.tera --emit source --target c -o /tmp/async-c
grep -n "tera_fn" /tmp/async-c/stats-async.c
sed -n '4628,4629p' /tmp/async-c/stats-async.c
```

```bash
# tera_wake is emitted only when the program sleeps. Answers 0.
grep -c "tera_wake" /tmp/async-c/stats-async.c

# Drain before exit, at every return the entry has. Answers two lines.
grep -n "tera_drain();" /tmp/async-c/stats-async.c
```

```bash
# A rejection nobody awaited, interpreter and binary, byte for byte.
printf 'async fn g() -> int:\n  return 1\n\nasync fn f(tag: string) -> int:\n  x = await g()\n  throw tag\n  return x\n\nf("first")\nf("second")\nprint("done")\n' > /tmp/rej2.tera
node dist/cli.js /tmp/rej2.tera ; echo "exit=$?"
node dist/cli.js compile /tmp/rej2.tera -o /tmp/rej2.exe && /tmp/rej2.exe ; echo "exit=$?"
```

Both print `done` on stdout and two `Uncaught (in promise) …` lines on stderr, in settle
order, and both exit 1.

```bash
# The timers capability, as a refusal with the backend named.
printf 'async fn tick() -> int:\n  await sleep(1)\n  return 7\n\nprint(await tick())\n' > /tmp/tick.tera
node dist/cli.js compile /tmp/tick.tera --target x64 --platform windows --emit source -o /tmp/tick-win
node dist/cli.js compile /tmp/tick.tera --target x64 --platform linux   --emit source -o /tmp/tick-lin
```

The windows build is silent; the linux one prints the `sleep needs a monotonic clock and a
blocking wait, which the x64-linux backend does not provide` note and the downstream note about
the entry.

```bash
# The suites. Nine pass and fourteen of twenty-three skip without a PE runner; the report says so.
npx vitest run --project e2e tests/e2e/optimizing/aot/timers.test.ts \
                             tests/e2e/optimizing/aot/async.test.ts
```

## Tests that pin this

- The indirect call, and that it is deliberate:
  `tests/e2e/optimizing/aot/async.test.ts` >
  `"resumes a frame through the routine it carries rather than a comparison chain"`.
- The split reproducing interpreter interleaving:
  `tests/e2e/optimizing/aot/async.test.ts` >
  `"interleaves a suspending call the way the coroutine split has to reproduce"`,
  `"runs the immediately awaited shape without interleaving"`,
  `"splits the shape whose promise outlives the call that made it"`,
  `"compiles the immediately awaited shape with no promise at all"`,
  `"keeps a suspended frame alive across a collection"` — the last is
  [Ch 61 § the-five-list-heads] and this chapter's `queueHead` being one fact.
- Timers as a data structure rather than a service:
  `tests/e2e/optimizing/aot/timers.test.ts` >
  `"takes no wait set into a program that never sleeps"`,
  `"gives a program that sleeps a wait set and a blocking step"`,
  `"refuses to sleep on a backend with no clock, and says why"` — the last loops over every
  backend and asserts against `model.capabilities.has("timers")` rather than a hard-coded list,
  so it catches the divergence in both directions.
- Timer semantics, each of three cases asserted three ways. The titles are generated, so the
  full strings are `"<case> when the interpreter runs it"`, `"<case> the way the interpreter
  does"` (C toolchain) and `"<case> in a native binary"` (PE), for each of
  `"wakes each parked frame once its deadline passes"`,
  `"keeps the program alive while a frame is still parked"` and
  `"settles overlapping deadlines from one wait"` —
  `tests/e2e/optimizing/aot/timers.test.ts`.
- Rejections, byte-identical to the interpreter:
  `tests/e2e/optimizing/aot/async-suspend.test.ts` >
  `"reports the rejection the way the interpreter does and fails the program"`,
  `"stays silent once the rejection has been awaited"`,
  `"reports every rejection nobody awaited, in the order they settled"`,
  `"reports the one rejection nobody awaited and keeps quiet about the rest"`,
  `"reports a rejection nobody catches even with no try anywhere"`;
  and `tests/e2e/optimizing/aot/timers.test.ts` >
  `"reports a rejection that only escapes after a deadline"`.
- The waiter chain and rejection propagation across coroutines. These are shapes in the
  suspending-coroutine match table, so each real title is
  `"prints what the interpreter prints for <shape>"` in
  `tests/e2e/optimizing/aot/async-suspend.test.ts`, for the shapes
  `"a waiter parked on a promise is woken by its rejection"`,
  `"a rejection that crosses two coroutines uncaught in the middle"`,
  `"a coroutine that catches the rejection of the coroutine it awaited"`,
  `"a collection while a frame is parked on a promise"`,
  `"a collection while a frame is parked on a promise that rejects"`,
  `"a chain of four coroutines each awaiting the next"`.
- The one-waiter refusal, by name:
  `tests/e2e/optimizing/aot/async-suspend.test.ts` >
  `"declines a promise used as a plain value rather than reordering it"`.
- That the shape list has not rotted:
  `tests/e2e/optimizing/aot/async-suspend.test.ts` >
  `"names only shapes the match table still carries"` — 23 shapes checked against the match
  table, so a renamed shape fails rather than silently dropping a case.
- The interpreter side this chapter is measured against — nine cases in
  `tests/e2e/language/unhandled-rejection.test.ts`, of which the three closest are
  `"reports each distinct fire-and-forget rejection"`,
  `"does not report a rejection an await raised into a try that caught it"`,
  `"does not report a rejection settled before anything awaited it"`.

  > **Unfinished.** The interpreter suite has nine cases; the AOT counterpart
  > (`describe("AOT rejections nobody awaits")`) has five, plus one deadline case in
  > `timers.test.ts`. The four with no AOT twin are the ones about a rejection *observed* at
  > top level (`"surfaces a top level await of a rejection nobody caught as uncaught"`,
  > `"does not report when the rejection is observed at the top level (surfaces as uncaught)"`)
  > and about module entry (`"surfaces the same uncaught rejection when the entry is run as a
  > module"`), plus `"does not report when the rejection is handled with catch"`. Cost of
  > finishing: the AOT cases are all `itRunsPe`, so each needs a PE runner and each only runs
  > on Windows; adding them is otherwise mechanical.
- The two ordering constraints in § two-ordering-constraints: **[unpinned]**. They are held by
  the order of three statements and nothing re-checks the graph between them.
- That `SCALAR_CODE` fields are excluded from the collector's reference walk: **[unpinned]**
  as a direct assertion. It is enforced by `referenceFieldOffsets`
  (`src/optimizing/metadata/class-table.ts:1002-1008`) filtering on `SCALAR_POINTER`, and
  covered behaviourally only by the collection-while-parked cases above.
