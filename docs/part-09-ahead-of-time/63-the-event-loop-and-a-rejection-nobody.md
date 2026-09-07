# 63. The event loop, and a rejection nobody awaited   ⟨I · – · – · N⟩

> **Status:** outline

**Thesis.** A compiled tera program carries an event loop of its own — a ready queue, a wait
set and a rejection list, all of them fields of `tera_context` — and the one genuine
indirect call in the entire binary is the one that loop needs to resume a frame.

**What arrived.** A generational non-moving heap: `tera_alloc` bumping into a nursery bounded
by `nurseryLimit`, `tera_minor` collecting the young list against a remembered set, and
`tera_collect` walking the arena. Crucially, both collectors already mark five runtime list
heads out of `tera_context` — `waitHead`, `sweepHead`, `queueHead`, `rejectedHead` and
`rejectedText`. This chapter is what those five fields *are*: a suspended coroutine frame is
reachable from nothing else, and the previous two chapters rooted it before naming it.

**What leaves.** A complete native program. Part X receives its `CFGFunction`s — including
the four synthetic ones this chapter builds, `sleep`, `tera_wake`, `tera_drain` and
`tera_report_rejections` — as ordinary graphs with no special status, to be selected,
scheduled, register-allocated and encoded like any other. The only thing Part X must handle
that nothing else in the program produces is `IR_GENERIC_CALL` against a `SCALAR_CODE`
value, which is § the-one-indirect-call.

**New ideas.** An event loop as a data structure rather than a service; a ready queue; a wait
set and the earliest-deadline cache; a *waiter* — the inverse of a callback list; a blocking
wait and why a compiled program must sleep rather than spin; deadlock detection versus
hanging; a LIFO list read backwards to recover insertion order without a tail pointer;
`SCALAR_CODE` and the indirect call (primer, if not already given at
[Ch 58 § monomorphisation]).

**Length.** 12 pages

## Anchors

- `src/optimizing/metadata/coroutines.ts` — 143 lines, the whole object model. Three
  synthetic base shapes built by `coroutineBaseShapes` (82-107): `tera_frame`
  (`coroutine: (tera_frame) -> int`, `state`, `next`), `tera_promise` (`state`, `waiting`,
  `waiter`, `unreported`, `nextRejected`, `error`, `errorValue`), and `tera_timer extends
  tera_promise` (`due: float`, `timer: tera_timer`). The state constants `CORO_STATE_PENDING`
  / `RESOLVED` / `REJECTED`, `CORO_NOBODY_WAITING` / `SOMEONE_WAITING`, `CORO_REPORTED` /
  `CORO_UNREPORTED` (26-33). `coroutineFrameShape` / `coroutinePromiseShape` deriving a
  per-function subclass, and `coroutineFrameName` / `coroutinePromiseName` /
  `coroutineResumeName` fixing the `f$frame` / `f$promise` / `f$resume` spelling.
  `CORO_RESUME_TYPE = "(tera_frame) -> int"` is the field that becomes `SCALAR_CODE`.
- `src/optimizing/passes/coroutines.ts` — 1378 lines. `CORO_DRAIN = "tera_drain"`,
  `CORO_WAKE = "tera_wake"`, `CORO_REPORT = "tera_report_rejections"` (118-120).
  `buildDrain(classes, timers)` (1270) — the ready-queue loop, four blocks plus three more
  when `timers`; `buildSleep(classes)` (1155); `buildWake(classes)` (1182);
  `buildReportRejections(classes)` (989); `drainBeforeExit(graph)` (970), seventeen lines
  that splice `tera_drain(); tera_report_rejections();` in front of *every* `IR_RETURN` in
  the entry graph. `splitCoroutine` (905) and the three-line ordering at 937-939 that
  § two-ordering-constraints is about; `CoroutineSplitError` (136), thrown by
  `fieldOf`-style helpers so a shape mismatch becomes a per-function refusal rather than a
  crash. `stopWhenPending` (444) raising `TERA_NEVER_SETTLED`;
  `lowerAwaitedPromises` (1350); `typeAwaitedResults`; and the private helpers `enqueue`
  (676), `appendWaiting` (1106), `nowMillis` (1096, a `CLOCK_BUILTIN` call), `waitMillis`
  (1101).
- `src/optimizing/drivers/aot.ts` — the analyses the pass depends on and which live
  *outside* it: `suspendingCallees` (282), `misusedPromise` (343) — the refusal that makes
  the one-waiter slot sound — and `sleepers` (387).
- `src/optimizing/target/faults.ts` — 9 lines carrying every user-visible sentence this
  chapter can print: `TERA_UNCAUGHT_PREFIX = "Uncaught "`,
  `TERA_REJECTED_PREFIX = "(in promise) "`,
  `TERA_REJECTED_SEPARATOR = "\nUncaught (in promise) "`,
  `TERA_NEVER_SETTLED = "awaited a promise that never settled"`,
  `TERA_EXIT_UNCAUGHT_THROW = 1`.
- `src/optimizing/drivers/aot.ts:565-575` — the wiring. `timers = plan.promises.has(sleep)`,
  then `buildDrain(classes, timers)`, `buildReportRejections(classes)`, `buildWake` only
  when `timers`, then `drainBeforeExit(entry.graph)`. And 718-733: `sleepers(module)`,
  `clocked = backend.target.capabilities.has("timers")`, `buildSleep` added only when both
  hold, and the `clockless` refusal that names the backend by id.
- `src/optimizing/target/runtime-layout.ts:133-145` — the loop's own state, thirteen
  `tera_context` fields with no other purpose: `waitHead`, `waitTail`, `waitCount`,
  `waitDue`, `sweepHead`, `sweepCount`, `queueHead`, `queueTail`, `queueCount`,
  `rejectedHead`, `rejectedCount`, `rejectedText`, `reportedCount`. Keeping loop state in
  the context rather than in SSA values is the house idiom for generated IR — it means these
  four graphs contain no phis at all.
- `src/optimizing/backends/c/emit.ts:253` — `C_WAIT = "tera_pause"`, and the platform
  routines behind it (`GetTickCount64`/`Sleep`, else `clock_gettime`/`nanosleep`) which must
  be declared in `C_RUNTIME_SUPPORT` rather than `C_HEADER_PREAMBLE`.
- `src/optimizing/backends/c/target.ts:14` and `src/optimizing/backends/x64/target.ts:79-83`
  — who declares `"timers"`. Note the x64 declaration is *conditional* on
  `io.now !== undefined && io.wait !== undefined`, so x64-windows has it and x64-linux does
  not, from one expression.
- `tests/e2e/optimizing/aot/async.test.ts`, `tests/e2e/optimizing/aot/async-suspend.test.ts`
  (`describe("AOT rejections nobody awaits")` at 1241, and the `THROUGH_C` list of 23 shapes
  at 1327 with the test that every name in it is still a real match-table entry),
  `tests/e2e/optimizing/aot/timers.test.ts` (`TICKS`, `OUTLIVES`, `OVERLAPS`, `CASES`).

## Worked example

`docs/example/stats-async.tera` is the spine here — it compiles, it agrees, and its emitted
C contains the entire loop:

```bash
node dist/cli.js docs/example/stats-async.tera
node dist/cli.js compile docs/example/stats-async.tera -o /tmp/async.exe && /tmp/async.exe
node dist/cli.js compile docs/example/stats-async.tera --emit source --target c -o /tmp/async-c
grep -n "tera_fn" /tmp/async-c/stats-async.c
```

The last command answers with five lines and they are the whole thesis:

```c
typedef void (*tera_fn)(void);                     /* line 5   */
  tera_fn v0 = (tera_fn)mean_of_resume;            /* line 1299 */
  (*(tera_fn *)(v8 + 8)) = v0;                     /* line 1324 */
  const tera_fn v16 = (*(tera_fn *)(v10 + 8));     /* line 4628 */
  ((int32_t (*)(unsigned char *))v16)(v10);        /* line 4629 */
```
— generated `stats-async.c`

A resume function's address is *stored into a frame* at the point the coroutine is created,
and read back out by `tera_drain`. Grepping the whole file for a call through a variable
finds exactly one site: line 4629. Every other call in a compiled tera program is direct.

The rejection half uses the five programs of
`tests/e2e/optimizing/aot/async-suspend.test.ts > describe("AOT rejections nobody awaits")`,
each asserted against a triple of `[status, stdout, stderr]` — the compiled binary's stderr
must equal the interpreter's byte for byte, and its exit status must be 1.

## Outline

- [ ] **§ what-the-interpreter-had** — Open by naming what is *not* here. The interpreter's
      async story [Ch 30] is `JSPromise` with a reaction list, a `MicrotaskQueue` with a head
      index and a ten-thousand-task budget, `AsyncSuspend` as a control-flow object, and a
      four-operation rejection ledger. None of it survives into a binary — there is no VM to
      host it. Establish the replacement in one sentence: thirteen fields on `tera_context`
      and four generated `CFGFunction`s.
- [ ] **§ three-shapes** — Read `coroutineBaseShapes`. `tera_frame` is the suspended
      activation: a code pointer, a resume state, and a `next` link so the ready queue needs
      no separate node type. `tera_promise` is the result: a state, one waiter slot, and the
      rejection bookkeeping. `tera_timer` extends the promise with `due` and its own `timer`
      link — establish here that inheritance is doing real work, because a timer *is* a
      promise and the whole await/park path is reused unchanged. Then the per-function
      subclasses `f$frame` and `f$promise`, one field per live value across a suspend
      [Ch 58 § coroutine-split].
- [ ] **§ the-ready-queue** — Read `buildDrain` as a diagram and then as code. Four blocks:
      `entry → test`, `test` branches on `queueCount > 0` to `body` or out, `body` pops
      `queueHead`, follows `next`, decrements the count and *resumes*, `done` returns.
      Establish that the queue is intrusive — the `next` field lives in the frame itself, so
      draining allocates nothing, which matters because a collection during a drain is
      exactly when things go wrong. Note that every value the loop needs is a context field,
      so `buildDrain` emits no phi and needs no SSA construction of its own.
- [ ] **§ the-one-indirect-call** — The chapter's centre. `> **New idea.**` A direct call
      names its target at compile time; an indirect call reads the target out of memory.
      A compiled tera program has almost none: higher-order functions are monomorphised on
      the function argument [Ch 58 § higher-order], dispatch cones become comparison chains
      [Ch 57 § structural-dispatch], and the checker refuses what neither can resolve. But
      `tera_drain` cannot know which coroutine it is resuming — that is the *definition* of a
      ready queue — so the frame carries its own resume routine in a `SCALAR_CODE` field.
      Establish `SCALAR_CODE` as a pointer-sized **non-reference** scalar the collector must
      skip, and read the three emitted lines: `(tera_fn)f$resume` stored at frame creation,
      loaded at `v10 + 8`, called. Then the alternative the tree rejected, named by its own
      test: a comparison chain over frame kinds. Pin it to
      `[t: tests/e2e/optimizing/aot/async.test.ts > "resumes a frame through the routine it
      carries rather than a comparison chain"]`.
- [ ] **§ the-waiter-chain** — *Why the obvious design fails.* The obvious design is the
      interpreter's: a promise holds a *list* of reactions, because in JavaScript any number
      of `.then`s may attach to one promise. Here a promise holds **one** waiter frame and a
      `waiting: int` flag. Establish why that is sound rather than a shortcut: `misusedPromise`
      requires every use of a suspending call to be an `IR_AWAIT` **directly**, so no phi can
      intervene, the awaited value *is* the call node, and one promise can never reach two
      coroutines — a program that would need two waiters is refused before it gets here.
      Then the protocol: suspending on a promise checks `state == RESOLVED` and either
      enqueues itself immediately or parks (`p.waiter = self; p.waiting = 1`); resolving
      wakes the parked frame by enqueueing it. One footnote worth its line: `waiting` is
      stored explicitly at every promise allocation site because `tera_alloc`'s free-list
      path does not zero a recycled block.
- [ ] **§ two-ordering-constraints** — Invariant → enforcement → test, twice, both load-bearing
      and both discovered by a broken binary. `suspendAt` must run **before** `spillInto`,
      because its new uses of the awaited promise have to go through the reload machinery or
      a resume block's entry reaches an undefined SSA value. And `exits` must be captured
      **before** `suspendAt`, which adds pending-throw returns that must not be resolved as
      ordinary exits. Both are enforced only by the order of statements in one function; see
      § honesty-items.
- [ ] **§ sleep-is-a-promise-subclass** — Read `buildSleep`: it allocates a `tera_timer`,
      stores `state = PENDING`, `waiting = NOBODY`, `unreported = REPORTED`, computes
      `due = tera_clock() + millis`, appends to the wait set, and *returns the timer*. That
      is the whole implementation — everything else (`await`, park, wake) is the promise path
      already built. Establish the design point: adding a new asynchronous source costs one
      subclass and one allocator, not a new scheduler. Note `sleep` must be listed in
      `suspendingCallees` or `await sleep()` is silently dropped and the async function is
      never split at all — a trap worth a sentence because the failure is silence.
- [ ] **§ blocking-not-spinning** — Read `buildWake`. It opens by computing
      `waitDue - now()` and calling `tera_pause` for that long — a real blocking wait, not a
      spin — then moves the entire wait list into `sweepHead`/`sweepCount`, zeroes
      `waitCount`, and re-partitions: an expired timer is resolved and its waiter enqueued,
      an unexpired one is appended back to the wait set. Establish why the list is
      *rebuilt* rather than filtered in place (no removal from the middle of a singly-linked
      list, and no allocation), and why `waitDue` is cached on the context (so the blocking
      step needs no scan to find the earliest deadline).
- [ ] **§ the-loop-with-timers** — Return to `buildDrain` and read the `timers` branch:
      when the ready queue empties, if `waitCount > 0` call `tera_wake` and go back to the
      test, otherwise finish. Establish the semantics that follow — **a pending timer keeps
      the program alive**, matching Node — and pin it to the `OUTLIVES` case. Then the trap
      that shaped the flag: `buildDrain` must take the blocking step *conditionally*, or
      every non-timer async program references a `tera_wake` that was never emitted.
- [ ] **§ deadlock-is-reported** — Establish the difference between a program that hangs and
      a program that says why. `stopWhenPending` inserts, after each await's drain, a check
      that the promise is no longer `PENDING`; if it is, the program throws
      `"awaited a promise that never settled"` and exits 1. Contrast honestly with a real
      runtime, which would simply exit 0 with the promise unresolved (Node's behaviour), and
      say which one this is: tera treats it as a fault. Note the wording lives in
      `target/faults.ts` beside every other user-visible sentence, so it is one string, not
      one per backend.
- [ ] **§ drain-before-exit** — Read `drainBeforeExit`: nine lines that find each `IR_RETURN`
      in the entry graph and splice `tera_drain(); tera_report_rejections();` in front of it.
      Establish why it is *every* return and not just the last: an entry with an early return
      would otherwise exit with work still queued. Show the generated C — two call pairs in
      `stats-async.c` at 3361 and 3382, because that entry has two exits.
- [ ] **§ rejections-nobody-awaited** — Establish the specification from the interpreter side
      first: a fire-and-forget rejection must print `Uncaught (in promise) <value>` on stderr
      and exit 1, and must *not* print when something awaited it. Then why AOT cannot decide
      this at rejection time: "nobody awaited it" is only knowable after the final drain. So
      the machinery: settling a promise as rejected LIFO-pushes it onto `rejectedHead`
      through the promise's own `nextRejected` field; the await that consumes a rejection
      clears `unreported`; `tera_report_rejections` runs from `drainBeforeExit` after the
      final `tera_drain`.
- [ ] **§ backwards-accumulation** — The nicest small idea in the chapter. Reporting *every*
      unawaited rejection with one exiting throw needs no new runtime routine and no tail
      pointer: walk the LIFO list forwards (which is reverse settle order), and concatenate
      each unreported error onto the front of the accumulator —
      `head.error = head.error + SEPARATOR + accumulator.error`, with the accumulator held in
      `tera_context.rejectedText` — then throw the accumulator once, prefixed with
      `TERA_REJECTED_PREFIX`. Because the list is LIFO and the concatenation is backwards,
      the result comes out in the interpreter's insertion order. Establish that
      `TERA_REJECTED_SEPARATOR` is literally `"\nUncaught (in promise) "`, so one thrown
      string renders as N lines of stderr — which is how a single-throw exit path reproduces
      a multi-line report.
- [ ] **§ rooted-or-swept** — Close the loop with chapter 61. `rejectedHead` and
      `rejectedText` must be marked by **all three** collectors next to `queueHead`, or an
      unobserved rejection — reachable from nothing else by construction — is swept before
      the exit walk reads it. Same for `waitHead` and `sweepHead`. State the general rule:
      **a runtime list is a root set**, and a new list means a new mark in four places
      [Ch 61 § honesty-items].
- [ ] **§ when-the-protocol-exists-at-all** — One paragraph of honest scoping. The rejection
      protocol only exists when `recoversThrows` is on, so `needsThrowRecovery` in
      `src/api/engine.ts` turns it on for a module that has an async function *and* a throw
      — not merely one that catches — because otherwise a throwing coroutine in a try-free
      program lowers straight to the exiting builtin and never rejects at all. Pin it to
      `"reports a rejection nobody catches even with no try anywhere"`.
- [ ] **§ what-leaves** — Restate the handover to Part X: four more `CFGFunction`s with no
      special status, and one opcode — `IR_GENERIC_CALL` on a `SCALAR_CODE` value — that
      nothing else in a compiled program produces.

## Honesty items

- > **Unfinished.** `timers` is declared by `cTarget` unconditionally and by the x64 target
  only when `io.now` and `io.wait` are both defined, which is true for windows and false for
  linux (`src/optimizing/backends/x64/target.ts:79-83`); riscv64 declares neither
  `timers` nor anything else beyond `terminating-throw` and `float-text`. So
  `await sleep(ms)` compiles on exactly two of the four target/platform combinations, and
  the other two decline with a sentence naming the backend id. Cost of finishing: a
  monotonic clock and a blocking wait per platform — `clock_gettime`/`nanosleep` syscalls
  for x64-linux, which is perhaps 60 lines of machine IR in `PLATFORM_IO`; riscv64 needs a
  runner first [Ch 72 § riscv-encode].
- > **Unenforced.** The two ordering constraints in § two-ordering-constraints —
  `suspendAt` before `spillInto`, `exits` captured before `suspendAt` — are enforced only by
  the order in which `splitCoroutine` calls them. Reversing either produces a graph that
  passes `validateSSA` on some programs and reaches an undefined SSA value on others, and
  the symptom appears in a resume block far from the cause. Cost of enforcing: an assertion
  in `suspendAt` that the exit set is already frozen, plus a `verifyEachPass` run over the
  coroutine pass, which today is not one of the passes the verifier sees.
- > **Unenforced.** The one-waiter invariant — "a promise can never reach two coroutines" —
  is established by `misusedPromise` requiring every use of a suspending call to be a direct
  `IR_AWAIT`, i.e. it is enforced by a *refusal in a different file* from the field it
  protects. Nothing in `coroutineBaseShapes` records that `waiter` is single-occupancy, and
  a future pass that introduced a phi between a call and its await would silently overwrite
  a parked frame. Cost of enforcing: a comment is not available (no-comment rule), so it
  wants an assertion in `appendWaiting` that `waiting == NOBODY` before storing, ≈4 lines
  of IR, paid on every park.
- > **Unenforced.** `drainBeforeExit` splices into `entry.graph` only — the single unit whose
  name matches `entryName` (`src/optimizing/drivers/aot.ts:573`). A program whose real exit
  is in another unit (an entry that tail-calls out, say) would exit without draining. No test
  covers that shape because no current lowering produces it. Cost of enforcing: assert the
  entry graph has at least one `IR_RETURN` after `drainBeforeExit` returns non-zero — one
  line — which at least turns silence into a compiler error.
- > **Unfinished.** The interpreter's unhandled-rejection suite
  (`tests/e2e/language/unhandled-rejection.test.ts`) has **nine** cases; the AOT counterpart
  (`describe("AOT rejections nobody awaits")`) has **five**, plus one deadline case in
  `timers.test.ts`. The four with no AOT twin are the ones about a rejection *observed* at
  top level and about module entry. Cost of finishing: the AOT cases are `itRunsPe`, so each
  needs a PE runner; adding them is mechanical but only runs on Windows.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats-async.tera
node dist/cli.js compile docs/example/stats-async.tera -o /tmp/async.exe && /tmp/async.exe
node dist/cli.js compile docs/example/stats-async.tera --emit source --target c -o /tmp/async-c
grep -n "tera_fn" /tmp/async-c/stats-async.c
grep -c "tera_wake" /tmp/async-c/stats-async.c
npx vitest run --project e2e tests/e2e/optimizing/aot/timers.test.ts tests/e2e/optimizing/aot/async.test.ts
```

The interpreter and the binary both print `latency mean=15.70 / throughput mean=898.19`.
The `tera_fn` grep prints five lines, one of which — the call at 4629 — is the only indirect
call in the program. The `tera_wake` count is `0`, because `stats-async.tera` never sleeps
and `buildWake` is emitted only when it is needed. The last command runs green with fourteen
of twenty-three cases skipped on a machine without a PE runner; the report says so.

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
  `"keeps a suspended frame alive across a collection"` — the last is [Ch 61]'s root set and
  this chapter's `queueHead` being the same fact.
- Timers as a data structure:
  `tests/e2e/optimizing/aot/timers.test.ts` >
  `"takes no wait set into a program that never sleeps"`,
  `"gives a program that sleeps a wait set and a blocking step"`,
  `"refuses to sleep on a backend with no clock, and says why"` — the last asserts against
  `model.capabilities.has("timers")`, not against a hard-coded backend list.
- Timer semantics, each case asserted three ways (interpreter, C binary, PE binary):
  `tests/e2e/optimizing/aot/timers.test.ts` >
  `"wakes each parked frame once its deadline passes"`,
  `"keeps the program alive while a frame is still parked"`,
  `"settles overlapping deadlines from one wait"`.
- Rejections, byte-identical to the interpreter:
  `tests/e2e/optimizing/aot/async-suspend.test.ts` >
  `"reports the rejection the way the interpreter does and fails the program"`,
  `"stays silent once the rejection has been awaited"`,
  `"reports every rejection nobody awaited, in the order they settled"`,
  `"reports the one rejection nobody awaited and keeps quiet about the rest"`,
  `"reports a rejection nobody catches even with no try anywhere"`,
  and `tests/e2e/optimizing/aot/timers.test.ts` >
  `"reports a rejection that only escapes after a deadline"`.
- The waiter chain and rejection propagation across coroutines, from the match table:
  `tests/e2e/optimizing/aot/async-suspend.test.ts` shapes
  `"a waiter parked on a promise is woken by its rejection"`,
  `"a rejection that crosses two coroutines uncaught in the middle"`,
  `"a coroutine that catches the rejection of the coroutine it awaited"`,
  `"a collection while a frame is parked on a promise"`,
  `"a collection while a frame is parked on a promise that rejects"`,
  `"a chain of four coroutines each awaiting the next"`.
- That the shape list has not rotted:
  `tests/e2e/optimizing/aot/async-suspend.test.ts` >
  `"names only shapes the match table still carries"`.
- The interpreter side this chapter is measured against:
  `tests/e2e/language/unhandled-rejection.test.ts` >
  `"reports each distinct fire-and-forget rejection"`,
  `"does not report a rejection an await raised into a try that caught it"`,
  `"does not report a rejection settled before anything awaited it"`.
