# 30. Async at run time: promises, microtasks, and a suspended frame   ⟨I⟩

> **Status:** outline

**Thesis.** Awaiting a pending value throws the frame out of the interpreter loop, and the
only thing keeping its registers alive is an entry in a `Map`.

**What arrived.** From [Ch 29]: a constructed `Engine` holding a `MicrotaskQueue`, a
`hostAsyncBinding()` whose `drain` is `engine.drainMicrotasks()`, and
`microtaskQueue.setUnhandledRejectionReporter(...)` already wired to the caller's
`onUnhandledRejection`. From [Ch 27]: `ROP_AWAIT` in `INTERPRETER_ONLY_OPS`, so nothing in
this chapter is ever compiled — and `requiresInterpreterOnly` returns `true` for *any*
`compiledFn.isAsync`, whether it awaits or not.

**What leaves.** Two data structures that reference values nothing else on any stack does, and
[Ch 31] has to explain how they survive a collection:
`interpreter.suspendedFrames: Map<RegisterFrame, ResumeOwner>` — every register of a
half-finished async function — and `microtaskQueue.pendingRejections: Map<PromiseHandle,
TaggedValue>` plus its `queue` array of not-yet-run `Microtask`s. `visitFrameRoots` walks the
first (`src/gc/roots.ts:35`); [Ch 32] asks what walks the rest.

**New ideas.** *Coroutine* and *suspension*; *state machine* (pending → fulfilled | rejected,
one-way); *job queue / microtask* and why it is not a thread; *reentrancy guard*;
*exception as control flow* (`AsyncSuspend` is thrown, and it is not an error);
*monotonic clock*; *`Atomics.wait` on a `SharedArrayBuffer`* as the only way a single-threaded
host can sleep without spinning.

**Length.** 12 pages

## Anchors

- `src/runtime/async/promise.ts` (238 lines, the whole promise implementation) —
  `PROMISE_PENDING` / `PROMISE_FULFILLED` / `PROMISE_REJECTED` (19-21); `JSPromise` (65-122)
  with its seven fields; `settle` (95-105), whose `this.reactions.splice(0)` empties the list
  before enqueueing; `reject` (86-93), which reads `reactions.length > 0` *before* settling and
  calls `queue.trackRejection` only if it was empty; `addReaction` (107-121), which calls
  `queue.trackHandle(this)` when it attaches to an already-rejected promise. Then
  `PromiseCapability` (124-134), `mkPromiseCapability` (136-139), `promiseResolve` (141-150),
  `promiseReject` (152-159), `resolvePromise` (161-203) — three cases — and `promiseThen`
  (205-238).
- `src/runtime/microtasks/microtask.ts` (478 lines) — `MicrotaskPolicy` (11-15);
  the four `Microtask` subclasses: `Microtask` (70-81) with its abstract `run` that throws,
  `PromiseReactionMicrotask` (83-105), `PromiseResolveThenableMicrotask` (107-170) with the
  `alreadyResolved` latch at 128, `CallbackMicrotask` (172-187). Then `ParkedFrame` (189-193),
  `monotonicNow` (200-202), the module-level `sleeper` IIFE (204-210) and `blockUntil`
  (214-225). `MicrotaskQueue` (227-456): fifteen fields, `enqueue` (273), `runOne` (285-302)
  with its compaction at 297-300, `park` (304-308), `earliest` (310-317), `wakeExpired`
  (319-330), `drain` (332-355), `performCheckpoint` (357-367), the suppression pair (369-375),
  and the four rejection operations `trackRejection` (381-393), `markObserved` (395-404),
  `trackHandle` (406-417), `_checkPendingRejections` (419-436). `MicrotasksScope` (458-478).
- `src/bytecode/register/interpreter/index.ts:2235-2257` — the `ROP_AWAIT` case: five
  branches in twenty lines, ending in a `VMTypeError` whose message is the most precise
  statement of the effect-inference contract in the tree.
- `src/bytecode/register/interpreter/index.ts:657, 673, 1334-1340` — `suspendedFrames:
  Map<RegisterFrame, ResumeOwner>` and `dropUnreachableSuspendedFrames(live)`, called from
  `_maybeSweepHeapPayloads`.
- `src/bytecode/register/interpreter/frame.ts:18` — `ResumeOwner = object | null`, three lines
  up from the `Map` that uses it.
- `src/bytecode/register/interpreter/helpers.ts` — `AsyncSuspend` (146-154): a class with two
  fields and no `Error` base; `resumeAfterSuspend` (156-186), the chapter's centrepiece;
  `runAsyncWithSuspension` (188-203); `completeGenerator` (119-125) and `runGeneratorFrame`
  (127-145) for the generator twin; `INTERPRETER_ONLY_OPS` (67-80) and
  `requiresInterpreterOnly` (82-89).
- `src/bytecode/register/interpreter/promise.ts` (309 lines) — `installPromiseBuiltin`
  (87-175), which registers the `Promise` global at construction time
  (`interpreter/index.ts:686`, immediately after `installBuiltinEntries`); `promiseAll`
  (185-216), `promiseAllSettled` (217-252), `promiseAny` (253-284), `promiseRace` (285-309).
- `src/runtime/builtins/index.ts:1140-1150` — `sleep`: builds a capability and calls
  `queue.park(delay, () => capability.resolve(mkUndefined()))`. Four lines, and the only
  producer of a `ParkedFrame` in the tree.
- `src/api/engine.ts:1315, 1324, 1475, 1482` — `new MicrotasksScope(...)` around module
  execution, and `markObserved(getPayload(result))`: the engine claiming a returned promise so
  a rejection it will surface as *uncaught* is not also reported as *unhandled*.
- `src/gc/roots.ts:25, 35` — `for (const [frame] of interpreter.suspendedFrames ?? []) visit(frame)`.
- `tests/e2e/language/unhandled-rejection.test.ts` (199 lines, nine cases) — the
  specification.

## Worked example

`docs/example/stats-async.tera` for the mechanism, then the rejection suite for the
bookkeeping.

```bash
node dist/cli.js --print-bytecode --filter mean_of docs/example/stats-async.tera | sed -n '1,20p'
node dist/cli.js --trace docs/example/stats-async.tera 2>&1 | grep MTASK
node dist/cli.js --stats docs/example/stats-async.tera | grep -A 7 microtasks
```

The disassembly shows the whole compiled surface of `await`:

```
     4  Call r4 r5 r1 r0
     5  Await
     6  Star r1
```

— one opcode. Everything in this chapter happens inside that opcode's twenty-line `case`.
`--trace` shows four `[MTASK] Enqueue: promise-reaction` / `Run:` pairs and `--stats` reports
`enqueued: 4, executed: 4, checkpoints: 1` — three `await`s in `main`/`mean_of` plus the
`load` resolution.

Then the wait set, which `stats-async.tera` cannot reach:

```bash
printf 'async fn go() -> void:\n  print("a")\n  await sleep(50)\n  print("b")\ngo()\nprint("main")\n' > /tmp/sleep.tera
node dist/cli.js /tmp/sleep.tera
node dist/cli.js --trace /tmp/sleep.tera 2>&1 | grep MTASK
```

`a`, `main`, `b` — in that order. The `main` between them is the proof that `go`'s frame left
the interpreter loop entirely and was re-entered from a queue.

Finally the nine cases of `tests/e2e/language/unhandled-rejection.test.ts`, read as a
specification of *who owns a rejection*, with `"does not report a rejection settled before
anything awaited it"` as the hard one.

## Outline

- [ ] **What `await` is not.** Open on the constraint. `runFrame` is a synchronous `while`
      loop in a synchronous host function ([Ch 21]); the baseline compiler emits synchronous
      JavaScript ([Ch 36]). Establish: there is no place to *pause* — so the frame is thrown
      out and re-entered later. Name `AsyncSuspend` here and note it extends nothing: it is a
      control-flow object that travels on the host's exception mechanism because that is the
      only mechanism that unwinds a `while` loop from the inside.
- [ ] **Why the obvious design fails.** Stage it: make `runFrame` an `async function` and
      `await` for real. Then the two programs that break it — every tera call becomes a
      promise, including the ninety-nine percent that are synchronous; and the baseline tier
      ([Ch 36]) emits plain JavaScript function bodies that cannot `await` a callee they
      compile as a direct call. Establish: the price actually paid instead is
      `requiresInterpreterOnly`, which returns `true` for `compiledFn.isAsync` *unconditionally*
      — an async function never reaches tier 1 or tier 2, awaits or not.
- [ ] **The five branches of `ROP_AWAIT`.** Walk `index.ts:2235-2257` in order: not a promise
      → fall through unchanged; `explicitAsync` → suspend even if already settled (so ordering
      is observable); already fulfilled → write `p.result` into `frame.acc` and keep going;
      already rejected → `trackHandle(p)` then `throw new RegisterException(p.result)`;
      pending and `frame.suspendable` → suspend. Establish the fifth branch as the interesting
      one: pending and *not* suspendable raises a `VMTypeError` naming the effect-inference gap
      ([Ch 14]) — quote it verbatim, because it is the specification.
- [ ] **`JSPromise` is a hundred lines and one rule.** `state` moves out of `pending` exactly
      once: `settle` (95-105) returns immediately if it is not pending, and `fulfill` /
      `reject` both go through it. `settle` does `this.reactions.splice(0)` *before* enqueueing
      — establish why: a reaction that adds another reaction during the drain must attach to
      the queue, not to a list that is about to be re-read. Pin idempotence with the three
      `settle is idempotent` tests.
- [ ] **A reaction never runs synchronously.** `addReaction` (107-121) either pushes onto the
      list (pending) or *enqueues a `PromiseReactionMicrotask` immediately* (settled) — never
      calls the reaction inline. Establish the invariant: **no promise callback ever runs on
      the stack that settled the promise.** Enforcement: there is no code path from `settle` or
      `addReaction` to `reaction(...)` that does not pass through `queue.enqueue`. Tests:
      `"reactions added before settle fire on settle via microtask"` and `"reactions added
      after settle fire immediately via microtask"`.
- [ ] **`resolvePromise` has three cases, and two of them are the same case.**
      (161-203): a promise value, an object with a callable `then`, or anything else. The
      first two both enqueue a `PromiseResolveThenableMicrotask`; only the third calls
      `fulfill` directly. Establish: resolving with a promise is *adoption*, and it costs a
      microtask turn — which is exactly why `await` of an already-resolved promise still
      yields.
- [ ] **The `alreadyResolved` latch.** `PromiseResolveThenableMicrotask.run`
      (126-169) builds `resolveFn` and `rejectFn` closing over one boolean, hands both to the
      thenable's `then`, and ignores every call after the first. Establish: a hostile or buggy
      thenable that calls both, or calls one twice, cannot move a settled promise — the latch,
      not `settle`'s state check, is what makes the *first* call win.
- [ ] **The queue is an array with a head index.** `enqueue` pushes; `runOne` (285-302) reads
      `queue[head]`, writes `undefined` back into the slot, increments `head`, and — when
      `head >= queue.length` — sets `queue.length = 0; head = 0`. Establish: this is a
      ring-less FIFO that never shifts, so `enqueue` and `runOne` are both constant time, and
      the array is reclaimed only when it fully empties. Pin with `"compacts the backing array
      after a full drain"` and `"preserves FIFO order across repeated drain/enqueue cycles"`.
- [ ] **`drain` is two phases, one budget, one guard.** `if (this.running) return` at 333 is
      the reentrancy guard — a nested `drain` is a no-op, not a recursion. Then
      `for(;;) { while (head < length) runOne(); if (!waiting.length) break; wakeExpired(); }`:
      run every microtask, *then* wake the earliest timers, then look for microtasks again.
      `limit = 10000` throws `Microtask queue limit exceeded`. `finally` restores the flag and
      calls `_checkPendingRejections()` — establish: **unhandled rejections are decided when
      the queue goes quiet**, not when a promise rejects.
- [ ] **The wait set is a wall clock and a spin.** `park` (304-308) records
      `{ due, order, wake }`; `earliest` is a linear scan; `wakeExpired` calls `blockUntil` and
      then wakes *every* frame whose deadline has passed, sorted by `(due, order)`.
      `blockUntil` (214-225) uses `Atomics.wait` on a four-byte `SharedArrayBuffer` allocated
      once at module load — and falls back to a busy `continue` loop when the buffer cannot be
      allocated or `Atomics.wait` throws. Establish: `sleep` is the only producer of parked
      frames, and the queue's clock is `performance.now()`. Pin with `"waits once for
      deadlines that overlap instead of once per frame"`.
- [ ] **`resumeAfterSuspend`, line by line.** `helpers.ts:156-186` is the chapter's
      centrepiece and fits in one excerpt. Read the owner dance first: it reads
      `suspendedFrames.get(frame)` into `ownerBeforeAwait`, sets the entry to `null` for the
      duration of the await, and restores it (or deletes it) inside the reaction. Establish
      what `null` means: *this frame has no owning object right now*, so
      `dropUnreachableSuspendedFrames` ([Ch 31 § handle-sweep]) — which drops entries whose
      owner is unreachable — cannot drop it while the await is outstanding. Then the two
      resumption paths: fulfilled → `frame.acc = result; runAsyncWithSuspension(...)`;
      rejected → pop one `exceptionHandler` and jump to its `catchPC`, or reject the
      capability if there is none.
- [ ] **`runAsyncWithSuspension` is the loop that isn't.** (188-203): run the frame; if it
      returns, resolve; if it throws `AsyncSuspend`, call `resumeAfterSuspend` and return; if
      it throws anything else, reject with `errorToTaggedValue`. Establish: a function with
      three `await`s executes this function four times, on four different host stacks, and the
      *only* thing carried between them is the `RegisterFrame` object.
- [ ] **Rejection ownership is decided at the instant of rejection.** The four operations:
      `trackRejection` (381) — called by `JSPromise.reject` only when the reaction list was
      empty, and skipped entirely for a promise in `observedPromises`; `trackHandle` (406) —
      called by `addReaction` on an already-rejected promise and by `ROP_AWAIT`'s rejected
      branch, deleting the pending entry; `markObserved` (395) — the engine claiming a promise
      it is about to surface as uncaught; `_checkPendingRejections` (419) — the flush, from
      `drain`'s `finally`. Establish the rule the tests encode: **a rejection is unhandled if
      nothing was listening when it happened and nothing listened before the queue went
      quiet.**
- [ ] **The nine cases, read as a specification.** Walk the suite. The two that pay for the
      chapter: `"does not report a rejection settled before anything awaited it"` — `f(1)`
      rejects during `await a`'s drain, long before `await b` exists, and is *not* reported,
      because `trackHandle` fires when the later `await` attaches; and `"surfaces a top level
      await of a rejection nobody caught as uncaught"` — same shape, but the top-level `await`
      makes it a thrown `Uncaught boom` with `rejections` empty, because `markObserved` moved
      ownership to the engine. Establish: *unhandled* and *uncaught* are two different
      outcomes with two different reporting paths, and the suite is where the boundary is
      drawn.
- [ ] **What the spine cannot reach.** `stats.tera` has no `async`, so this whole chapter runs
      on `stats-async.tera`; and `stats-async.tera` in turn never parks a frame, never resolves
      a thenable, and never rejects — so the wait set, the thenable job and the rejection
      bookkeeping are shown on `/tmp/sleep.tera` and the e2e suite, and the chapter says so.

## Honesty items

- > **Dead.** `JSPromise.asyncFunctionName` and `JSPromise.resumePc`
  (`src/runtime/async/promise.ts:70-71, 78-79`). Both are declared, initialised to `null` and
  `-1` in the constructor, and never written or read anywhere in `src/` or `tests/`. They read
  as a fossil of a design in which the *promise* remembered where to resume; what shipped is
  `AsyncSuspend` carrying the `RegisterFrame` itself. Deleting them costs two lines.
- > **Never runs.** `MicrotaskQueue.setRejectionHandler` / `this.rejectionHandler`
  (`src/runtime/microtasks/microtask.ts:238, 390-392, 413-415, 438-440`). Nothing in `src/`
  installs a handler; the only two callers in the tree are
  `tests/runtime/async/promise.test.ts > "adding reaction to already-rejected promise tracks
  handle"` and
  `tests/runtime/microtasks/microtask-queue.test.ts > "rejectionHandler receives events"`. The
  production reporting path is `unhandledRejectionReporter`, which is a different field with a
  different signature. Finishing it means either routing the engine's reporter through it or
  deleting both branches.
- > **Broken.** `PromiseResolveThenableMicrotask.run`'s catch
  (`src/runtime/microtasks/microtask.ts:166-168`) does
  `this.promiseToResolve.reject(mkUndefined())` — it discards the thrown value. A thenable
  whose `then` throws rejects the adopting promise with `undefined` instead of the reason,
  and the same happens at 163 when `then` turns out not to be callable. The fix is
  `errorToTaggedValue(asThrownValue(e))`, which the async path at `helpers.ts:201` already
  uses. `[unpinned]` — no test covers a throwing `then`.
- > **Unenforced.** `drain`'s ten-thousand-task budget throws a bare
  `new Error("Microtask queue limit exceeded")` (`microtask.ts:342-344`) with no promise, no
  function name and no bytecode offset — the same class of context-free failure as the
  host `RangeError` in [Ch 21 § host-recursion]. Pinned as behaviour by
  `tests/runtime/microtasks/microtask-queue.test.ts > "drain throws when limit exceeded"`;
  nothing pins the message being useful.
- > **Unfinished.** `blockUntil`'s fallback (`microtask.ts:214-225`) is a busy loop. When
  `new SharedArrayBuffer(4)` throws at module load, or `Atomics.wait` throws once, `blocking`
  becomes `false` for the rest of the process and every `sleep` spins on `monotonicNow()`.
  There is no diagnostic and no way to observe which mode is in effect.
- > **Never runs.** `MicrotaskPolicy.EXPLICIT` and `MicrotaskPolicy.SCOPED` are reachable only
  through `EngineOptions.microtaskPolicy` (`src/api/engine.ts:115, 776`) or
  `Engine.setMicrotaskPolicy` (1574-1576). No CLI flag sets either, `hostEngineOptions()` does not, and
  the only non-`AUTO` construction sites in the tree are in
  `tests/runtime/microtasks/microtask-queue.test.ts`. `MicrotasksScope.exit`'s `SCOPED` branch
  (470-472) therefore never runs outside tests.
- > **Unenforced.** `Microtask.run` (`microtask.ts:78-80`) throws
  `"Microtask.run() is abstract"` at run time. TypeScript would express this as an `abstract`
  class; the base is concrete, so a `new Microtask("x")` passes `enqueue`'s
  `instanceof` check and fails only when the queue reaches it.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats-async.tera
node dist/cli.js --print-bytecode --filter mean_of docs/example/stats-async.tera | sed -n '1,20p'
node dist/cli.js --trace docs/example/stats-async.tera 2>&1 | grep MTASK
node dist/cli.js --stats docs/example/stats-async.tera | grep -A 7 microtasks
printf 'async fn go() -> void:\n  print("a")\n  await sleep(50)\n  print("b")\ngo()\nprint("main")\n' > /tmp/sleep.tera && node dist/cli.js /tmp/sleep.tera && node dist/cli.js --trace /tmp/sleep.tera 2>&1 | grep MTASK
npx vitest run --project e2e tests/e2e/language/unhandled-rejection.test.ts
```

Expected: `latency mean=15.70 / throughput mean=898.19`; an `Await` at instruction 5 of
`mean_of`; four `Enqueue`/`Run` pairs of `promise-reaction`; `"enqueued": 4, "executed": 4,
"checkpoints": 1`; then `a / main / b` with a `[MTASK] Park: due in 50ms` line; then 9 passed.

## Tests that pin this

- `tests/runtime/async/promise.test.ts > "starts in pending state"`,
  `> "fulfill transitions to fulfilled with result"`,
  `> "reject transitions to rejected with reason"` — the state machine.
- `tests/runtime/async/promise.test.ts > "settle is idempotent — second fulfill is ignored"`,
  `> "settle is idempotent — reject after fulfill is ignored"`,
  `> "settle is idempotent — fulfill after reject is ignored"` — one-way, three ways.
- `tests/runtime/async/promise.test.ts > "reactions added before settle fire on settle via
  microtask"`, `> "reactions added after settle fire immediately via microtask"`,
  `> "multiple reactions all fire in order"`, `> "reactions list is cleared after settle"` —
  the `splice(0)` and the never-synchronous rule.
- `tests/runtime/async/promise.test.ts > "reject without reactions tracks unhandled
  rejection"`, `> "reject with pre-existing reaction does not track"`,
  `> "adding reaction to already-rejected promise tracks handle"` — the ownership decision, in
  isolation.
- `tests/runtime/async/promise.test.ts > "non-promise non-thenable fulfills directly"` and
  `> "promise value enqueues thenable resolution"` — `resolvePromise`'s three cases.
- `tests/runtime/microtasks/microtask-queue.test.ts > "drain executes all enqueued microtasks
  in FIFO order"`, `> "drain processes microtasks enqueued during drain"`,
  `> "compacts the backing array after a full drain"`,
  `> "preserves FIFO order across repeated drain/enqueue cycles"`,
  `> "runOne executes exactly one microtask"`,
  `> "reports pending as the not-yet-run count while draining"` — the head index and the
  compaction.
- `tests/runtime/microtasks/microtask-queue.test.ts > "drain throws when limit exceeded"` — the
  ten-thousand budget.
- `tests/runtime/microtasks/microtask-queue.test.ts > "nested drain is a no-op while already
  running"` — the `running` guard.
- `tests/runtime/microtasks/microtask-queue.test.ts > "AUTO policy drains on checkpoint"`,
  `> "EXPLICIT policy skips checkpoint"`, `> "SCOPED policy skips checkpoint"`,
  `> "setPolicy changes behavior"`, `> "SCOPED policy drains on scope exit at nesting depth
  0"`, `> "nested scopes defer drain until outermost exits"` — the three policies and
  `MicrotasksScope`.
- `tests/runtime/microtasks/microtask-queue.test.ts > "suppression blocks drain"`,
  `> "suppression depth stacks"`, `> "decrement below zero stays at zero"`.
- `tests/runtime/microtasks/microtask-queue.test.ts > "blocks until the earliest deadline
  rather than returning while a frame is parked"`, `> "wakes frames sharing a deadline in the
  order they parked"`, `> "waits once for deadlines that overlap instead of once per frame"`,
  `> "runs work a waking frame enqueues before it stops"`,
  `> "keeps draining the ready queue while nothing is parked"` — the wait set, five cases.
- `tests/runtime/microtasks/microtask-queue.test.ts > "trackRejection and trackHandle toggle
  pending state"` and `> "trackHandle on unknown promise is a no-op"`.
- `tests/e2e/language/unhandled-rejection.test.ts > "reports a fire-and-forget async rejection
  but still runs the rest of the program"`,
  `> "reports each distinct fire-and-forget rejection"`,
  `> "does not report when the rejection is observed at the top level (surfaces as uncaught)"`,
  `> "does not report when the rejection is handled with catch"`,
  `> "does not report a rejection an await raised into a try that caught it"`,
  `> "does not report a rejection settled before anything awaited it"`,
  `> "surfaces a top level await of a rejection nobody caught as uncaught"`,
  `> "surfaces the same uncaught rejection when the entry is run as a module"`,
  `> "does not report a fulfilled fire-and-forget promise"` — nine cases, not eight; the
  eighth and ninth were added when module entries acquired the same reporting path.
- Nothing pins a thenable whose `then` throws, or the `VMTypeError` text on an `await` in a
  function the effect analysis did not mark async. `[unpinned]`
