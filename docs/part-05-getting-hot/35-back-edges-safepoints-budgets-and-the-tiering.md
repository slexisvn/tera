# 35. Back edges: safepoints, budgets, and the tiering policy   ⟨I · B · J⟩

A loop gets hot without anyone calling anything. That is the whole problem this chapter
solves, and the engine solves it in one place: the jump backwards. Every iteration of every
tera loop crosses one, and `onBackEdge` is what runs there. It does two jobs that have
nothing to do with each other — it ticks a garbage-collection counter, and it charges a
compilation budget — and it does them together only because a back edge happens to be the
one program point where both are safe, reached from a single line of code.

The interesting half is the budget, because it is not a counter. Nothing anywhere in this
engine counts loop iterations to decide when a loop is hot. What it counts is *bytecodes
executed inside the loop*, against an allowance sized from the length of the whole function:
`3000 × instructions.length`, drawn down by the span of each back jump. So the number of
iterations it takes to go hot is not a property of the loop. It is a ratio — the size of the
function divided by the size of the loop — and it means a five-instruction loop buried in a
four-hundred-instruction function takes eighty times longer to attract the optimizing
compiler than the same loop would if it were the whole function. That inversion of the
obvious intuition is this chapter's thesis.

The rest is policy: which of two unrelated objects decides when to compile, why the default
engine runs the *fallback* expression rather than the policy, what `callMode` caches, and
what happens after a bailout. `docs/example/stats.tera` reaches none of it on its own — the
running example never gets hot, and this chapter says so rather than implying otherwise. It
is reached the way the engine's own instrument reaches it, by lowering the thresholds from
the command line.

**What arrived.** From [Ch 34 § no-global-invalidation], an `InlineCacheManager` holding one
`InlineCache` per site key, each a chain of handlers that re-check map id, map version and
deprecation on every hit. And, underneath it, the artifact this chapter actually spends:
the `FeedbackVector` that [Ch 33 § typing-the-vector] installed, whose `loopBudget` and
`loopBudgetSize` were both set by `FeedbackVector.fromCompiledFunction` to
`INVOCATION_COUNT_FOR_OPTIMIZATION × instructions.length`, whose `loopBudgetExhausted` is
`false`, and whose `osrUrgency` is `0`. Nothing has charged any of them yet.

## Why a back edge

A back edge is a jump whose target is earlier in the instruction stream — the only way an
instruction can execute twice. [Ch 21 § jumps-and-the-back-edge] established the test
(`target < frame.pc`, exact because the pc has already been advanced past the jump) and
[Ch 31 § the-collector-that-actually-runs] established what a *safepoint* is and why loop
back edges are the classic place to put one. This chapter takes both as given and asks the
narrower question: why is the back edge the right place to ask *"should this function be
compiled?"*

Three properties, all of them true at a back edge and at almost nowhere else.

The frame is complete. Every register holds a tagged value, the accumulator holds a tagged
value, and no instruction is half executed — the interpreter has finished the jump's
predecessor and has not started its successor. Nothing is in a host temporary that the
engine cannot name.

The pc is a real bytecode offset. Not a host instruction pointer, not an offset into a
switch table: an index into `compiledFn.instructions` that the bytecode compiler produced
and that the SSA builder can look up. That is what makes the point *addressable* from
outside the interpreter.

And the loop is guaranteed to come back. A back edge that executes once will, on the
overwhelming majority of paths, execute again, so a decision taken there pays off; a
decision taken at an arbitrary instruction might be the last thing the function ever does.

Those three properties are exactly the ones that make a back edge the only place a frame can
be *described* — that is what a frame state is, [Ch 40 § what-a-frame-state-holds] — and the
only place a frame can be *replaced*, which is [Ch 37]. The collector wants the first property,
the tiering machinery wants all three, and both are polled from the same line of code. It
saves a poll. It is also the reason a reader of `onBackEdge` sees two unrelated subsystems
in a fourteen-line function.

## One hook, two jobs

Here is the whole hook.

```ts
  onBackEdge(
    compiledFn: bytecode.RegisterCompiledFunction,
    frame: RegisterFrame,
    target: number,
    loopCounter: number,
  ): TaggedValue | null {
    if ((this._sweepTick = (this._sweepTick + 1) & 0xffff) === 0) {
      this._maybeSweepHeapPayloads();
    }
    const policy = this.tieringPolicy;
    const feedback = compiledFn.feedbackVector;
    const hot = feedback
      ? feedback.decrementLoopBudget(Math.max(frame.pc - target, 1))
      : policy
        ? loopCounter === policy.loopOsrThreshold
        : false;
    if (!hot) return null;
```
— `src/bytecode/register/interpreter/index.ts:1358-1374`

**Job one** is the first three lines. `_sweepTick` is a field on the *interpreter*, not on
the function — one counter for every back edge every tera function takes — incremented and
masked to sixteen bits, so `_maybeSweepHeapPayloads` is *considered* once every 65,536 back
edges. Considered, not run: the sweep itself begins with a size check and returns
immediately unless the live estimate has passed `_heapSweepThreshold`, which it then re-arms
to `max(1 << 18, live × 4)`. [Ch 31 § the-collector-that-actually-runs] takes the sweep
apart; what matters here is only that the mask is a *rate limiter on a rate limiter*, and
that it has nothing whatever to do with the next four lines.

**Job two** is the hotness poll. If the function has a feedback vector — and it always does,
which § the-thresholds-that-decide-nothing returns to — the vector is charged the span of
the back jump, and `decrementLoopBudget` answers whether that charge emptied the budget.
If it did, `onBackEdge` calls `enterOsr` (`:1376-1383`), and if that returns a value,
`runFrame` abandons the interpreted frame and returns it. That path is [Ch 37]'s subject
entirely.

The two jobs share the call site and nothing else. They have different periods (one fixed at
65,536 back edges, one variable and function-sized), different owners (the interpreter
instance versus the compiled function), and different consequences (a collection versus a
compilation). This is a coupling of convenience. It is defensible — a back edge is a good
place for both, and a second poll would be a second branch on a path every loop iteration
crosses — but a reader should not go looking for a design that unifies them, because
there isn't one. Nothing in this tree measures what the second branch would cost.

## The budget is not a counter

`FeedbackVector.fromCompiledFunction` sizes the allowance:

```ts
  static fromCompiledFunction(compiledFn: {
    feedbackSlotCount: number;
    instructions?: { length: number };
  }): FeedbackVector {
    const bytecodeLength = compiledFn.instructions?.length ?? 0;
    return new FeedbackVector(
      compiledFn.feedbackSlotCount,
      bytecodeLength > 0
        ? INVOCATION_COUNT_FOR_OPTIMIZATION * bytecodeLength
        : DEFAULT_LOOP_BUDGET,
    );
  }
```
— `src/feedback/vector/index.ts:911-922`

`INVOCATION_COUNT_FOR_OPTIMIZATION` is `3000` and `DEFAULT_LOOP_BUDGET` is `1000`
(`vector/index.ts:778-779`). The name of the first constant is a fossil — it is not an
invocation count and nothing compares an invocation count to it — but it is the code's name,
so this book keeps it (`docs/CONVENTIONS.md` rule 4).

> **New idea. A budget, not a counter.** A counter answers "how many times has this
> happened?" A **budget** answers "how much work has this done?", by starting at an
> allowance and subtracting a *cost* at each event. The two are the same thing only when
> every event costs one. Here they are not: the event is a back edge and the cost is the
> number of bytecodes the loop body spans, so a fat loop draws the budget down faster than a
> thin one. The reason to prefer a budget is that what you actually want to know is how much
> time the program is spending in this loop, and bytecodes executed is a far better proxy
> for that than iterations completed.

The charge is `Math.max(frame.pc - target, 1)`. By the time the jump case runs, `frame.pc++`
has already happened (`index.ts:1411`), so `frame.pc` is one past the jump instruction and
`frame.pc - target` is exactly the number of bytecode slots the loop occupies, jump
included. The `max(..., 1)` guards a self-jump.

So the arithmetic that decides when a loop goes hot is:

```
iterations to exhaustion  ≈  3000 × (instructions in the whole function)
                             ─────────────────────────────────────────
                                  (bytecodes the loop body spans)
```

Work it on the running example. `report` disassembles to seven instructions:

```
$ node dist/cli.js --print-bytecode --filter report docs/example/stats.tera
=== report (params=1, locals=1, registers=3, constants=1) ===
Constants:
  [0] "label"
Locals: r0=s
Instructions:
     0  Ldar r0
     1  Star r1
     2  LdaNamedProperty r1 [0] (label) r0
     3  Star r2
     4  Ldar r2
     5  CallMethod r1 r0 r0 r1
     6  Return
```

Seven, so `report`'s budget is `3000 × 7 = 21 000`. It is never charged a single unit,
because `report` contains no back edge at all. That is the first thing the formula tells
you and it is worth saying plainly: the budget is a *loop* mechanism, and a function without
a loop tiers up on invocation count or not at all.

`Series.mean` is 43 instructions, so its budget is `3000 × 43 = 129 000`. Its only back edge
is instruction 31, `Jump r4`; the pc is 32 when the charge is computed, and the target is 4,
so each iteration costs 28. That is 4,607 iterations to exhaustion. `stats.tera` runs the
loop five times for `latency` and four for `throughput` — nine iterations, 252 units out of
129,000 — so `loopBudgetExhausted` is never set anywhere in the running example. The example
reaches the mechanism and does not reach what the mechanism is for.

Now the consequence that corrects the obvious intuition. Consider a loop that *is* the whole
function: the span is roughly the instruction count, the ratio is about one, and the loop
goes hot in roughly 3,000 iterations no matter how large the function is. Now bury the same
loop in a function that also does four hundred instructions of setup: the numerator grows and
the denominator does not, and the same loop needs tens of thousands of iterations. **Fatness
does not accelerate tier-up. The loop's share of the function does.** A programmer's instinct
— "a big loop body means more work per iteration, so it should go hot sooner" — is right
about the loop and wrong about this formula, because the formula divides by the loop's span
and multiplies by the function's length, and both numbers move when you fatten the body.

Whether that is the right policy is not something this tree measures. It is not obviously
wrong: sizing the allowance to the function keeps a small helper from being optimized on the
strength of one tight loop, and a loop that dominates its function is exactly the shape OSR
exists for. But there is no benchmark harness here, no recorded comparison against a plain
iteration count, and nothing in the tree that explains why 3,000 rather than 300 or 30,000.

Two smaller facts follow from the same code. The budget is per *function*, not per loop — two
loops in one function share one allowance and charge it with their own spans. And a function
with zero instructions falls back to `DEFAULT_LOOP_BUDGET = 1000`, which is unreachable in
practice because a function with no instructions has no back edge either.

## Sticky, and two strikes

`decrementLoopBudget` is five lines and does three things:

```ts
  decrementLoopBudget(amount = 1): boolean {
    this.loopBudget -= amount;
    if (this.loopBudget > 0) return false;
    this.loopBudget = this.loopBudgetSize;
    this.loopBudgetExhausted = true;
    return true;
  }
```
— `src/feedback/vector/index.ts:801-807`

It **returns `true` once per budget**, because on exhaustion it immediately refills
`loopBudget` from `loopBudgetSize`
[t: `tests/feedback/vector.test.ts > "decrements and returns false while positive"`,
`> "returns true when budget exhausted"`, `> "only fires exhaustion once"`]. And it sets a
**sticky flag**, `loopBudgetExhausted`, which nothing clears except `resetLoopBudget`
[t: `tests/feedback/vector.test.ts > "resetLoopBudget restores budget"`].

That flag is read by a completely different decider, at a completely different time. Back in
`execute`, at *function entry*, `loopBudgetTriggered` is an alternative to the invocation
count:

```ts
      const loopBudgetTriggered =
        compiledFn.feedbackVector &&
        compiledFn.feedbackVector.loopBudgetExhausted;

      const shouldJIT = this.tieringPolicy.shouldOptimize
        ? this.tieringPolicy.shouldOptimize(compiledFn)
        : (compiledFn.invocationCount >= this.tieringPolicy.jitThreshold ||
            loopBudgetTriggered) &&
          !compiledFn.optimizedCode &&
          !compiledFn.disableOptimization &&
          Date.now() >= (compiledFn.optimizationCooldownUntil || 0);
```
— `src/bytecode/register/interpreter/index.ts:961-971`

So a loop that got hot but could not be entered on stack — because the OSR compile was
refused, or the warm-up ate the first exhaustion, or `--no-osr` was passed — still causes the
*whole function* to be optimized the next time anybody calls it, and the trace says which
reason fired: `loop budget exhausted (invocations=N)` rather than `invocation count = N`
(`index.ts:978-980`). The tier-up is not lost, only deferred to the next entry. Whoever
takes that path calls `resetLoopBudget()` first (`:982-984`), which clears the flag so it
cannot fire twice.

The second delay is in `enterOsr`, and it is a two-strikes rule:

```ts
  const feedback = compiledFn.feedbackVector;
  if (feedback && feedback.osrUrgency === 0) {
    feedback.incrementOsrUrgency();
    return null;
  }
```
— `src/runtime/tiering/osr.ts:29-33`

The *first* time a loop exhausts its budget, nothing happens except that a counter leaves
zero. The second exhaustion is the first one that can compile anything. What that buys is one
full budget of running time — for `mean`, another 4,607 iterations — during which the
feedback vector keeps filling in, so the speculation the optimizing compiler is about to make
rests on more than a cold loop's first pass. [Ch 37 § enterosr-in-full] reads the rest of
that function.

## `callMode`

Once a function has been compiled, the dispatch decision could be recomputed on every call —
does it have optimized code? baseline code? is it a generator? — or it could be cached.
`updateCallMode` caches it:

```ts
export function updateCallMode(compiled: CompiledFunctionLike): void {
  if (compiled.isGenerator) compiled.callMode = CALL_GENERATOR;
  else if (compiled.isAsync) compiled.callMode = CALL_ASYNC;
  else if (compiled.optimizedCode) compiled.callMode = CALL_OPTIMIZED;
  else if (compiled.baselineCode) compiled.callMode = CALL_BASELINE;
  else compiled.callMode = CALL_INTERPRETED;
}
```
— `src/bytecode/register/interpreter/index.ts:232-238`

The order is the design. `isGenerator` and `isAsync` outrank any compiled code, so a
coroutine is never dispatched to baseline or optimized code even if it somehow acquired
some — the suspension machinery of [Ch 30 § runasyncwithsuspension] needs a `RegisterFrame`
it can park, and neither compiled tier produces one.

It is recomputed in three places: lazily when `callMode` is `undefined`
(`index.ts:584`), after every successful tier-up (`:506`, `:521`, and in the Engine at
`src/api/engine.ts:1787`), and defensively — a `callMode` of `CALL_OPTIMIZED` whose
`optimizedCode` is null re-runs `updateCallMode` and falls through rather than asserting
(`index.ts:587-599`). That last one matters because deoptimization nulls `optimizedCode` from
outside this file; the cache is allowed to be stale, and the reader is written to survive it.

Two honest notes about the cache, because a reader will assume more of it than is there.

> **Dead.** `CALL_NATIVE = 3` (`src/bytecode/register/interpreter/index.ts:180`) is exported
> and never assigned by `updateCallMode`, never compared anywhere, and never imported by any
> file in `src/` or `tests/`. It is a slot reserved for a tier that dispatches through a
> different door entirely — the native compiler produces a standalone binary, not a callee
> the interpreter can enter. Cost of removing it: one line, plus renumbering nothing, because
> the constants are only ever compared to each other.

> **Never runs.** `CALL_BASELINE` and `CALL_INTERPRETED` are written by `updateCallMode` and
> never read. Grepping `src/` and `tests/` for either name finds the definition, the
> assignment, and nothing else. `callFunction` only tests `CALL_OPTIMIZED`, `CALL_GENERATOR`
> and `CALL_ASYNC` (`index.ts:587`, `:601`, `:610`); everything else falls through to
> `tryTierUp` and then to a bare `if (compiled.baselineCode)` check (`:631`), which asks the
> field directly rather than the cached mode. So the "cached dispatch decision" is really a
> cached answer to one question — *is there optimized code, or is this a coroutine* — and the
> baseline arm of the cache decides nothing. Cost of finishing: replace `:631` with a
> `CALL_BASELINE` comparison, which is also the only thing that would make [Ch 36]'s
> `callMode` handover mean anything at run time.

## The two policies

`createTieringPolicy` returns one of two entirely unrelated kinds of object.

```ts
export function createTieringPolicy(overrides: TieringPolicyOptions = {}): TieringPolicy {
  if (
    overrides === "adaptive" ||
    (overrides && overrides.mode === "adaptive")
  ) {
    return new AdaptiveTieringPolicy(overrides);
  }
  return Object.freeze({
    ...DEFAULT_TIERING_POLICY,
    ...overrides,
  });
}
```
— `src/runtime/tiering/policy.ts:13-24`

The default branch is a **frozen plain record of seven numbers with no methods at all**
[t: `tests/runtime/tiering/adaptive.test.ts > "returns frozen defaults with no args"`,
`> "takes every unset threshold from DEFAULT_TIERING_POLICY"`,
`> "honours a threshold of zero instead of falling back to a default"` — the last of which
pins that an explicit `0` is not treated as absent]. The adaptive branch is a class with
profiles, cooldowns and gates.

Because the default has no methods, every call site in the interpreter has to ask before it
calls. The shape is always the same:

```
policy.shouldOptimize ? policy.shouldOptimize(fn) : <inline threshold expression>
```

and there are two of them: `execute` (`index.ts:965-971`, quoted above) and `tryTierUp`
(`index.ts:496-501`). **In a default engine the policy branch never runs.** Everything the
`AdaptiveTieringPolicy` knows about feedback stability, settle windows and deopt history is
inert unless somebody constructs the engine with `mode: "adaptive"`, which nothing in `src/`
and no CLI flag does.

That leaves the fallback expression as the real policy — and it is stated twice, differently.
`execute`'s version admits `loopBudgetTriggered` as an alternative to the invocation count;
`tryTierUp`'s version does not:

```ts
  const shouldJIT = policy.shouldOptimize
    ? policy.shouldOptimize(compiled)
    : compiled.invocationCount >= policy.jitThreshold &&
      !compiled.optimizedCode &&
      !compiled.disableOptimization &&
      Date.now() >= (compiled.optimizationCooldownUntil || 0);
```
— `src/bytecode/register/interpreter/index.ts:496-501`

So which door a call arrives through changes whether an exhausted loop budget can promote the
function. `callFunction`'s ordinary `ROP_CALL` path reaches `tryTierUp` and cannot;
`callFunctionValue` (`:1188`) and therefore every call made from *baseline-compiled code*
reaches `execute` and can. Nothing states that this difference is intentional.

> **Unenforced.** Three independent statements of "should this function be optimized?" exist
> — `AdaptiveTieringPolicy.shouldOptimize` (`src/runtime/tiering/adaptive.ts:112-155`), the
> fallback in `execute` and the fallback in `tryTierUp` — and they already disagree: the
> adaptive one adds a feedback-stability gate the fallbacks do not have, and the two
> fallbacks disagree with each other about `loopBudgetTriggered`. Nothing compares them and
> no test asserts that a program tiers up at the same point through both doors. Cost of
> enforcing: give the frozen policy the two methods and delete both fallbacks, which is a
> larger change than it looks because the frozen object is also what `tests/helpers/tiers.ts`
> hands the engine.

There is a second, quieter consequence of the two doors. The tier-up *trace* line —
`[JIT] Compiling "report": invocation count = 2` — is emitted only by `execute`
(`index.ts:981`). `tryTierUp` compiles without announcing a reason. So `--trace-opt` shows a
reason line for a function promoted from inside baseline code and none for the same function
promoted from the interpreter's own call opcode, which is why the two commands in
§ why-not-one print different-looking traces for the same tier-up.

## The adaptive gates

For completeness, and because the numbers in `DEFAULT_TIERING_POLICY` are only meaningful
against them, here is the policy that does not run by default.
`AdaptiveTieringPolicy.shouldOptimize` refuses nine ways, in order
(`src/runtime/tiering/adaptive.ts:112-155`):

| # | refusal | source |
| --- | --- | --- |
| 1 | already has `optimizedCode` | `:113` |
| 2 | `disableOptimization` set | `:114` |
| 3 | inside `optimizationCooldownUntil` | `:117-119` |
| 4 | four or more compile failures (`MAX_COMPILE_FAILURES`) | `:123-125` |
| 5 | has deopted **and** feedback has not settled for `feedbackSettleMs` | `:127-129` |
| 6 | has deopted **and** feedback is not stable | `:131-133` |
| 7 | ten consecutive deopts for the same reason | `:135-143` |
| 8 | `invocationCount < jitThreshold` | `:145-148` |
| 9 | feedback is not stable — now unconditionally | `:150-152` |

Rules 5 and 6 are the interesting pair, because they cost nothing until the function has
already been given up on once
[t: `tests/runtime/tiering/adaptive.test.ts > "ignores the settle window for a function that has never deopted"`,
`> "declines while a slot changed shape inside the settle window"`,
`> "allows once the settle window has passed"`]. A function that has never deoptimized is
optimized as soon as it is hot; a function that *has* must first hold still for
`feedbackSettleMs` (100 ms) with no slot changing shape, and must then also pass the
stability test. The reasoning is that a deopt is evidence the speculation was wrong, and
recompiling against feedback that is still moving would produce the same wrong speculation
again.

`hasStableFeedback` (`adaptive.ts:228-236`) is worth reading closely, because its default is
permissive:

```ts
function hasStableFeedback(fn: TieringFunctionRecord): boolean {
  const stats = fn.feedbackVector ? fn.feedbackVector.getSummaryStats() : null;
  if (!stats || stat(stats, "initializedSlots") === 0) return true;
  if (stat(stats, "megamorphicSlots") > 0) return false;
  return (
    stat(stats, "stableSlots") === stat(stats, "initializedSlots") ||
    stat(stats, "monomorphicSlots") === stat(stats, "initializedSlots")
  );
}
```
— `src/runtime/tiering/adaptive.ts:228-236`

An **uninitialized** vector passes. A function that has recorded nothing at all is treated as
stable, which is the right answer for a function whose sites are all in cold branches and the
wrong answer for a function that tiered up before it executed anything — which is exactly the
situation § why-not-one is about.

The remaining thresholds are pinned by the ordinary pair
[t: `tests/runtime/tiering/adaptive.test.ts > "returns false when invocation count below jitThreshold"`,
`> "returns true when invocation count meets threshold"`,
`> "returns false during cooldown period"`,
`> "returns false after too many compile failures"`,
`> "compile success resets failure count"`].

## The cooldown

> **New idea. Exponential backoff.** When an operation fails, retrying immediately is
> usually wrong: whatever made it fail is probably still true, and a tight retry loop turns
> one failure into a permanent cost. **Backoff** waits before retrying; **exponential**
> backoff multiplies the wait by a constant factor each time, so a transient problem costs
> two attempts and a permanent one stops costing anything at all after a handful. The
> alternative — a fixed retry limit — is simpler but throws away the case where the fact
> genuinely does change later.

This engine has two backoff schemes, on two different events, with two different shapes and
two different failure counters.

**Deopt backoff, exponential.** `AdaptiveTieringPolicy.recordDeopt` computes
`500 × 4^min(deoptCount - 1, 5)` milliseconds — `COOLDOWN_BASE_MS = 500`,
`COOLDOWN_FACTOR = 4` (`adaptive.ts:6-7`) — so the sequence is 500 ms, 2 s, 8 s, 32 s, 128 s,
512 s, and then flat forever, because the exponent is clamped rather than the product
[t: `tests/runtime/tiering/adaptive.test.ts > "multiple deopts increase cooldown exponentially"`].
It also does something the name does not suggest:

```ts
    fn.optimizationCooldownUntil = Date.now() + cooldownMs;
    fn.optimizedCode = null;
```
— `src/runtime/tiering/adaptive.ts:85-86`

The policy is the thing that *deoptimizes*, not merely the thing that decides
[t: `tests/runtime/tiering/adaptive.test.ts > "recordDeopt clears optimizedCode and sets cooldown"`].
And, like everything else on this object, it runs only in adaptive mode; the default engine's
deopt path is [Ch 54 § deoptimizing-out-of-wasm]'s.

**Compile-failure backoff, linear.** `compileCooldownUntil` in `defaults.ts` is
`now + min(maxCompileCooldownMs, compileCooldownStepMs × failureCount)` — 250 ms per failure,
capped at 5 s:

```ts
export function compileCooldownUntil(
  policy: CompileCooldown,
  failureCount: number,
  now: number,
): number {
  return (
    now + Math.min(policy.maxCompileCooldownMs, policy.compileCooldownStepMs * failureCount)
  );
}
```
— `src/runtime/tiering/defaults.ts:28-36`

This one *is* wired, and it is the one the default engine actually uses.
`Engine.recordCompileFailure` (`src/api/engine.ts:1839-1859`) calls it at `:1849` whenever
the wasm backend declines a graph, then prints the second of these two lines. They are the
thirty-eighth and thirty-ninth lines of
`node dist/cli.js --baseline-threshold 1 --opt-threshold 2 --trace-opt docs/example/stats-poly.tera`
— a plain `--trace-opt` run of that file prints no `[JIT]` line at all, because nothing in it
reaches a default threshold:

```
[JIT] Compiling "mean": Wasm: graph not compilable: property access on this receiver
[JIT] Compiling "mean": Wasm compilation skipped — cooldown
```

The two schemes never interact. They use different counters —
`compiledFn.compileFailureCount`, a field on the function record, versus
`profile.compileFailureCount`, a field on the adaptive policy's own `ExecutionProfile` — and
different events. `AdaptiveTieringPolicy.recordCompileFailure` (`adaptive.ts:98-103`)
increments its counter and sets no cooldown at all, relying on refusal #4 in the table above
to stop after four; the Engine's method sets the cooldown and relies on nothing to stop. A
reader who finds only one of the two will conclude the other does not exist.

## Why not one

`--always-opt` does not set the thresholds to 1. It sets them to 2 and 3:

```ts
  } else if (config.optMode === "always") {
    policy.baselineThreshold = 2;
    policy.jitThreshold = 3;
    policy.loopOsrThreshold = 3;
  }
```
— `src/cli/main.ts:54-58`

At 1 the very first call would tier up *before any instruction of the function had executed*.
The feedback vector would be entirely uninitialized, every `FeedbackNexus` question would
answer `generic` ([Ch 33 § the-nexus]), and the optimizing compiler would emit fully generic
code — no map guards, no `Float64Add`, no `LoadField(offset=…)`, because it would have
observed nothing to speculate on. The flag would exercise the pipeline while destroying the
thing the pipeline exists for. Worse, it would do it silently: `hasStableFeedback` returns
`true` for an uninitialized vector, so even the adaptive policy would wave it through.

Two and three buy one interpreted call to fill the vector and one baseline call to fill the
branch bias that only the baseline records ([Ch 36 § where-feedback-comes-from-here]) before
the JIT reads either. You can watch the difference:

```
$ node dist/cli.js --baseline-threshold 1 --opt-threshold 2 --trace-opt docs/example/stats-poly.tera
[JIT] Compiling "<script>": Baseline compiled: 86 bytecodes
[JIT] Compiling "report": Baseline compiled: 7 bytecodes
[JIT] Compiling "label": Baseline compiled: 26 bytecodes
[JIT] Compiling "mean": Baseline compiled: 43 bytecodes
latency mean=15.70
[JIT] Compiling "report": invocation count = 2
[JIT] Compiling "report": Starting speculative compilation
[JIT] Compiling "report": Inline skipped for method at bc:5: cold-call-site
[JIT] Compiling "report": CFG built: 1 blocks, 2 frame states
[JIT] Compiling "report": Wasm module compiled: 419 bytes, 1 blocks
[JIT] Compiling "report": Runtime stubs lowered: 2
[JIT] Compiling "report": Wasm installed in 16.76ms
```

That is the first twelve of forty output lines. `report` walks interpreter → baseline →
optimized in one run, on a file that calls it three times. The twenty-eight that follow include the
`mean` compile, whose speculations — `GetProp "values" at bc:8 → LoadField(offset=1)
(monomorphic, map=HC89)` and `Add at bc:24 → Float64Add (number speculation)` — exist *only
because* the vector was filled first.

The `--always-opt` run of the same file reaches the same place by a different door, and its
whole trace is twelve lines, because `<script>` does not reach a `baselineThreshold` of 2 and
so `report`'s promotion goes through `tryTierUp`, which emits no reason line:

```
$ node dist/cli.js --always-opt --trace-opt docs/example/stats-poly.tera
latency mean=15.70
[JIT] Compiling "report": Baseline compiled: 7 bytecodes
baseline mean=10.00
[JIT] Compiling "report": Starting speculative compilation
[JIT] Compiling "report": Inline skipped for method at bc:5: cold-call-site
[JIT] Compiling "report": CFG built: 1 blocks, 2 frame states
[JIT] Compiling "report": Wasm module compiled: 419 bytes, 1 blocks
[JIT] Compiling "report": Runtime stubs lowered: 2
[JIT] Compiling "report": Wasm installed in 16.57ms
[JIT] Compiling "label": Baseline compiled: 26 bytecodes
[JIT] Compiling "mean": Baseline compiled: 43 bytecodes
throughput mean=898.19
```

The installation figure is wall-clock time from one run on one machine, taken one case per
fresh process; it varies run to run and nothing in this book depends on it.

And `--no-opt`, which sets `jitThreshold` and `loopOsrThreshold` to
`Number.MAX_SAFE_INTEGER` and leaves `baselineThreshold` at 8 (`main.ts:51-53`), prints three
lines of program output and nothing else — `report` is called three times, which is fewer
than eight.

## The baseline polls differently   ⟨B⟩

Generated JavaScript has no dispatch loop to hang a poll off, so the baseline compiler emits
its own, at compile time, before every backward jump and only before backward ones:

```ts
function safepointBefore(target: bytecode.RegisterOperand, from: number): string {
  if (typeof target !== "number" || target > from) return "";
  const loopSpan = from + 1 - target;
  return (
    `if(++sp>=${BACK_EDGES_PER_SAFEPOINT}){sp=0;` +
    `osr=$.backEdge(${target},r,tv,env,${loopSpan});` +
    `if(osr!==null)return osr;}`
  );
}
```
— `src/optimizing/baseline/compiler.ts:44-52`

`BACK_EDGES_PER_SAFEPOINT` is 1024 (`src/runtime/tiering/defaults.ts:1`). Note `loopSpan =
from + 1 - target`, computed at compile time from the same two numbers the interpreter
computes at run time — `from + 1` is what the interpreter's `frame.pc` holds after the
increment, so the two spans are identical by construction.

The runtime side then charges the accumulated span in one lump:

```ts
  backEdge(
    target: number,
    registers: TaggedValue[],
    thisValue: TaggedValue,
    closureEnv: Environment | null,
    loopSpan: number,
  ): TaggedValue | null {
    this.interp._maybeSweepHeapPayloads();
    const feedback = this.cf.feedbackVector;
    if (
      feedback &&
      !feedback.decrementLoopBudget(loopSpan * BACK_EDGES_PER_SAFEPOINT)
    )
      return null;
```
— `src/optimizing/baseline/runtime.ts:416-429`

Two consequences, and they are not the same consequence.

**The budget rate is meant to match, and mostly does.** One thousand and twenty-four back
edges each costing `span` in the interpreter is `span × 1024` — the same number the baseline
charges once. That is deliberate: a function must not become hot at a different point just
because it moved tiers. But the match is approximate in two ways the code does not
acknowledge. First, `loopSpan` is the span of *the back edge that happened to be the 1024th*,
and the preceding 1,023 may have belonged to a different loop in the same function with a
different span. Second, and larger: `sp` is declared in the function prologue as
`var acc,t,t2,t3,t4,osr,sp=0` (`compiler.ts:146`), so it is **per invocation**. A
baseline-compiled function whose loop runs fewer than 1,024 iterations per call never reaches
a safepoint at all, however many times it is called, while the interpreted version of the
same function charges every single back edge. Below 1,024 iterations per call the two tiers
do not draw the budget down at the same rate; they draw it down at rates that differ by
everything.

**The sweep rate does not match, and nothing explains why.** `BaselineRuntime.backEdge` calls
`_maybeSweepHeapPayloads()` *unconditionally* — outside the budget check, on every
thousand-and-twenty-fourth back edge. The interpreter reaches the same method once per 65,536
back edges. That is a factor of 64, in the same engine, for the same collector, and the tree
contains no comment, constant, or test relating the two numbers.
[t: `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the boxed-primitive slab bounded under a double-heavy loop"`]
and
[t: `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the slab bounded once the loop runs in baseline-compiled code"`]
assert that each tier keeps the slab bounded; neither asserts anything about how often.
[t: `tests/e2e/gc/heap-payload-sweep.test.ts > "still reaches a safepoint when the back edge is a conditional jump"`]
pins that `JumpIfTrue` and `JumpIfFalse` get the poll too.

> **Unenforced.** Two separate relationships here are stated nowhere and checked nowhere.
> The first is the one the code intends: the baseline's budget charge
> (`loopSpan * BACK_EDGES_PER_SAFEPOINT`, `src/optimizing/baseline/runtime.ts:427`) is meant
> to reproduce what the interpreter charges per back edge, and it does so only when a
> baseline invocation actually crosses 1,024 back edges — below that it charges nothing at
> all, while the interpreter charges every edge. Nothing asserts that a loop reaches
> `loopBudgetExhausted` at a comparable point in both tiers, and below 1,024 iterations per
> call it does not. The second is the sweep rate: `BACK_EDGES_PER_SAFEPOINT` (1024,
> `src/runtime/tiering/defaults.ts:1`) and the interpreter's `0xffff` mask
> (`src/bytecode/register/interpreter/index.ts:1364`) are unrelated literals in unrelated
> files that between them set how often each tier considers a sweep, sixty-four apart, with
> no constant, comment or test relating them. Changing either silently changes one tier's
> behaviour and not the other's. Cost of enforcing: name a single constant for the sweep
> period and use it on both sides, and add a test that runs one loop through both tiers and
> compares the point at which each sets `loopBudgetExhausted`. [unpinned]

There is one more asymmetry in those two listings. When the feedback vector is missing, the
interpreter falls back to `loopCounter === policy.loopOsrThreshold`; the baseline's `if`
simply evaluates false and *falls through to `enterOsr` unconditionally*. The two tiers
disagree about what to do with a function that has no vector. In practice neither branch is
reachable, which is the next section.

## The thresholds that decide nothing

Three of the seven numbers in `DEFAULT_TIERING_POLICY` are load-bearing:
`baselineThreshold: 8` is compared at `index.ts:512` and `:1010`, `jitThreshold: 50` at
`:498` and `:967` and inside `fastBaselineCall` (`baseline/runtime.ts:933`), and
`maxDeoptCount: 3` governs [Ch 54]'s give-up rule. `feedbackSettleMs`,
`compileCooldownStepMs` and `maxCompileCooldownMs` are read by the adaptive policy and by
`Engine.recordCompileFailure` respectively.

The seventh is `loopOsrThreshold: 30`, and `docs/README.md` describes it as "loop iterations
before entering a running loop". It is not that, because nothing counts loop iterations
against it on any reachable path.

> **Dead.** The `loopOsrThreshold` arm of `RegisterInterpreter.onBackEdge`
> (`src/bytecode/register/interpreter/index.ts:1371-1373`) —
> `policy ? loopCounter === policy.loopOsrThreshold : false` — is evaluated only when
> `compiledFn.feedbackVector` is falsy. It never is. Every path that can produce a
> `RegisterFrame` calls `initFeedbackVector` first: `execute` at `:958`, `interpretCall` at
> `:474`, the generator and async arms of `callFunction` at `:603` and `:613`, the closure
> arm of `callFunctionValue` at `:1185`, `resumeAt` at `:1116`, `constructFunctionValue` at
> `:1270`, and the `ROP_NEW` handler at `src/bytecode/register/interpreter/handlers.ts:538`
> and `:549`. The threshold is settable from `--always-opt`, from `--no-opt`, and through
> `tieringPolicy` in the test helper, and through this path it changes nothing. Cost of
> removing: delete the ternary's middle arm and the field; cost of *connecting* it is
> [Ch 37]'s honesty item, because the policy method that would use it never runs either.
> [unpinned]

The `AdaptiveTieringPolicy` carries three more methods in the same condition. None of them
has a caller anywhere in `src/`; the only callers of any of them are in
`tests/runtime/tiering/adaptive.test.ts`.

> **Never runs.** `AdaptiveTieringPolicy.shouldOSR` (`src/runtime/tiering/adaptive.ts:172-187`)
> is a complete OSR admission policy — cooldown, compile-failure count, an
> `hasOSRReadyFeedback` check, the `loopOsrThreshold` comparison and a graded urgency from
> `getOSRUrgency`. It has a declared slot on the interpreter's policy interface
> (`src/bytecode/register/interpreter/index.ts:198`) so that it *could* be called, and it is
> unit-tested
> [t: `tests/runtime/tiering/adaptive.test.ts > "shouldOSR returns false without optimized OSR entry"`].
> `onBackEdge` decides OSR from the loop budget alone and never consults it. `getOSRUrgency`
> (`:163-170`), `hasOSRReadyFeedback` (`:217-222`) and `hasOptimizedOSREntry` (`:224-226`)
> exist only to serve it. Cost of connecting: one call in `onBackEdge`; cost of deleting: 25
> lines and two tests.

> **Never runs.** `AdaptiveTieringPolicy.shouldBaselineCompile` (`adaptive.ts:157-161`) has
> no caller in `src/`. Both `execute` (`index.ts:1009-1015`) and `tryTierUp` (`:511-517`)
> inline the `invocationCount >= baselineThreshold` comparison instead, and both add
> conditions the method does not have (`requiresInterpreterOnly`, `!optimizedCode`).

> **Never runs.** `AdaptiveTieringPolicy.getProfileStats` (`adaptive.ts:189-206`) computes
> thirteen fields including `feedbackSettled`, `feedbackStable`, `osrFeedbackReady` and
> `osrEntryReady` — precisely the diagnostic a reader would want when a function refuses to
> tier up — and has no caller in `src/`. `--stats` does not surface it; its
> `"tracerStats"` block reports `jit_compilations` and `jit_osr` counts and nothing about
> why a compilation did not happen. Cost of surfacing: one branch in the `--stats` printer,
> conditional on the policy being adaptive.

The pattern across all four is the same, and it is worth naming once. A policy object that is
*optional* invites every caller to write a fallback, and a fallback that works is a fallback
nobody removes. The result is a well-tested policy that describes the engine's intentions and
a set of inline expressions that describe its behaviour, drifting apart with nothing to
notice.

## What leaves

A tier decision, taken at one of two doors and cached in `callMode`.

Either the function keeps running interpreted; or `compiledFn.baselineCode` is installed and
`callMode` becomes `CALL_BASELINE`, which is [Ch 36]'s subject; or
`compiledFn.optimizedCode` is installed and `callMode` becomes `CALL_OPTIMIZED`; or the
budget ran out mid-loop and [Ch 37 § enterosr-in-full] takes over without the function ever
returning.

What goes forward with it, concretely: a `FeedbackVector` whose `loopBudget` has been charged
`frame.pc - target` per back edge, whose `loopBudgetExhausted` is sticky until somebody calls
`resetLoopBudget`, and whose `osrUrgency` has left zero if a budget has ever emptied. The
thresholds that governed all of it — 8, 50, 3, and a `loopOsrThreshold` of 30 that governs
nothing. And the poll site itself, `onBackEdge` in the interpreter and the emitted
`if(++sp>=1024)` in baseline code, which [Ch 37] uses as its entry point.

[Ch 36 § why-emit-source] takes the first of those outcomes — a function whose
`invocationCount` has reached `baselineThreshold` and which `requiresInterpreterOnly` did not
veto — and compiles it, to JavaScript source text.

## Verify it yourself

```bash
# report is 7 bytecodes, so its budget is 21,000 - and it has no back edge to charge it
node dist/cli.js --print-bytecode --filter report docs/example/stats.tera

# mean is 43 bytecodes with a back edge at 31 targeting 4: budget 129,000, span 28
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# interpreter -> baseline -> optimized in one run, with the reason line
node dist/cli.js --baseline-threshold 1 --opt-threshold 2 --trace-opt docs/example/stats-poly.tera

# the same tier-up through the other door, which prints no reason line
node dist/cli.js --always-opt --trace-opt docs/example/stats-poly.tera

# neither threshold is reached: three lines of output and no [JIT] line at all
node dist/cli.js --no-opt --trace-opt docs/example/stats-poly.tera

# the policy that does not run, tested anyway (30 tests)
npx vitest run --project unit tests/runtime/tiering/adaptive.test.ts

# both poll sites keep the payload slab bounded (7 tests, ~50s)
npx vitest run --project e2e tests/e2e/gc/heap-payload-sweep.test.ts
```

`docs/example/stats.tera` itself is deliberately absent from that list.
`node dist/cli.js --trace-opt docs/example/stats.tera` emits no `[JIT]` line: `report` and
`label` are called twice each, `mean` runs nine loop iterations in total, and nothing in the
file comes within three orders of magnitude of any threshold in this chapter. Every command
above that shows a tier-up either lowers a threshold or uses `stats-poly.tera`, which calls
`report` three times.

## Tests that pin this

- `tests/feedback/vector.test.ts > "decrements and returns false while positive"` — the
  charge is subtractive, not a decrement of one.
- `tests/feedback/vector.test.ts > "returns true when budget exhausted"` — and sets the
  sticky `loopBudgetExhausted`.
- `tests/feedback/vector.test.ts > "only fires exhaustion once"` — the budget refills
  immediately, so the next charge answers false.
- `tests/feedback/vector.test.ts > "resetLoopBudget restores budget"` — the only thing that
  clears the sticky flag.
- `tests/feedback/vector.test.ts > "creates vector with correct slot count"` — the vector's
  other half, from [Ch 33].
- `tests/runtime/tiering/adaptive.test.ts > "returns false when invocation count below jitThreshold"`
  and `> "returns true when invocation count meets threshold"` — refusal #8.
- `tests/runtime/tiering/adaptive.test.ts > "returns false during cooldown period"` — refusal #3.
- `tests/runtime/tiering/adaptive.test.ts > "returns false after too many compile failures"`
  and `> "compile success resets failure count"` — refusal #4 and its release.
- `tests/runtime/tiering/adaptive.test.ts > "recordDeopt clears optimizedCode and sets cooldown"`
  — the policy deoptimizes, it does not only decide.
- `tests/runtime/tiering/adaptive.test.ts > "multiple deopts increase cooldown exponentially"`
  — 500 × 4ⁿ, clamped at the exponent.
- `tests/runtime/tiering/adaptive.test.ts > "declines while a slot changed shape inside the settle window"`,
  `> "allows once the settle window has passed"` and
  `> "ignores the settle window for a function that has never deopted"` — refusal #5, and the
  fact that it costs nothing before the first deopt.
- `tests/runtime/tiering/adaptive.test.ts > "shouldOSR returns false without optimized OSR entry"`
  — the only exercise `shouldOSR` gets anywhere, and the reason its honesty item can be
  stated as fact rather than as suspicion.
- `tests/runtime/tiering/adaptive.test.ts > "returns frozen defaults with no args"`,
  `> "takes every unset threshold from DEFAULT_TIERING_POLICY"` and
  `> "honours a threshold of zero instead of falling back to a default"` — the non-adaptive
  branch of `createTieringPolicy` is a frozen record, and `0` is a value, not an absence.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the boxed-primitive slab bounded under a double-heavy loop"`
  — the interpreter's poll site.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the slab bounded once the loop runs in baseline-compiled code"`
  — the baseline's poll site, at 64 times the rate.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "still reaches a safepoint when the back edge is a conditional jump"`
  — `JumpIfTrue` and `JumpIfFalse` carry the poll too.
- `tests/e2e/optimizing/osr.test.ts > "does not disturb loops that never reach the OSR budget"`
  — the negative control: a loop below the budget behaves exactly as it did.
- The relationship between `BACK_EDGES_PER_SAFEPOINT` and the interpreter's `0xffff` mask is
  `[unpinned]`, as is the claim that the two tiers charge the budget at the same rate — and
  below 1,024 iterations per baseline call, they do not.
