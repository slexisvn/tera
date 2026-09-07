# 27. Exceptions, iteration, and the eleven opcodes that pin a function to tier zero   ⟨I · ~~B~~ · ~~J~~ · ~~N~~⟩

> **Status:** outline

> **Title correction.** `INTERPRETER_ONLY_OPS`
> (`src/bytecode/register/interpreter/helpers.ts:67-80`) currently holds **twelve**
> opcodes, and `requiresInterpreterOnly` adds a thirteenth disqualifier that is not an
> opcode at all (`compiledFn.isAsync`). The registered title in
> [SUMMARY.md](../SUMMARY.md) says eleven. The chapter opens by counting them, and the
> title should be renamed to "the twelve opcodes" when the prose is written — or, better,
> to a form that does not encode a number the tree can change.

**Thesis.** A dynamic handler stack pushes the cost of unwinding onto every non-local
exit, and twelve opcodes disqualify a function from three of the four tiers for the life
of the process.

**What arrived.** From [Ch 26 § what-leaves]: the completed *read* surface — named members,
subscripts, slices, class lineage, exotic hooks. One of those reads,
`ROP_LDA_KEYED_SLICE` (`a[1:3]`, `m[i, j]`), is already in `INTERPRETER_ONLY_OPS`, so
chapter 26 handed this chapter its first casualty without saying so: writing a slice
anywhere in a function costs that function baseline, JIT and OSR forever.

**What leaves.** A function's *tier verdict* — the third artifact the part opener promises
— plus the exception and iteration protocols every later tier must either implement or
refuse. Chapter 28 receives it and asks what a call actually reaches: builtins with one
implementation for three tiers, and the fourth compiler's parallel name table.

**New ideas.** *Unwinding* and why a handler *stack* is a different design from a handler
*table*. *Non-local exit* — `break`, `continue`, `return` and `throw` as one family.
*Iterator protocol* as a contract (`next` → `{value, done}`) rather than a language
feature. *Coroutine resumption*: what it means to throw a value *into* a frame that is not
running.

**Length.** 14 pages

## Anchors

### Exceptions

- `src/bytecode/register/interpreter/index.ts:2168-2196` — `ROP_TRY_START` pushes
  `{ catchPC }` onto `frame.exceptionHandlers` (allocating the array lazily);
  `ROP_TRY_END` pops it; `ROP_THROW` reads `takeCatchPC(frame)` and either jumps or
  rethrows a `RegisterException` after `frame.closeUpvalues()`.
- `src/bytecode/register/interpreter/index.ts:2456-2504` — the `catch` around the **entire
  opcode switch**. Three thrown shapes, in order:
  1. `RegisterException` → `frame.acc = thrown.value` (a tera value re-entering tera);
  2. `VMError` → `vmErrorToTagged(...)` (an engine error given a tera shape);
  3. a host `Error` → reshaped by `/^([A-Z][A-Za-z]*Error):\s*([\s\S]*)$/` against
     `thrown.message`, then rebuilt as a `JSObject` with `name`, `message`, `stack`,
     `__isError__` and a synthesized `constructor`.
- `src/bytecode/register/interpreter/helpers.ts` — `RegisterException` (`:107+`),
  `takeCatchPC`, `errorToTaggedValue`.
- `src/runtime/iteration/iterator.ts:182` — `throw new Error("TypeError: value is not
  iterable")`. This is the *producer* for shape 3 above: a host `Error` whose message is
  parsed back apart into a name and a message by a regular expression. Show both halves
  side by side; it is the clearest single example in the tree of a type crossing a
  boundary it should not have crossed.
- `src/bytecode/register/compiler/statements.ts:561-634` — `compileTryStatement`. The
  `finally` lowering emits **two** `ROP_TRY_START`s (`:570-571`): the inner one guards the
  try block and lands on the catch clause; the outer one guards *try and catch together*
  and lands on a rethrowing epilogue. The finalizer body is compiled **twice** — once on
  the normal path (`:597`) and once on the exceptional path (`:603`) — and the exceptional
  copy stashes the in-flight exception in a temp, runs the finalizer, reloads it and
  re-throws (`:601-605`).
- `src/bytecode/register/compiler/statements.ts:461-471` — the other reason `finally` is
  hard: `_finallyBlocks` is a compile-time stack so that a `break`, `continue` or `return`
  crossing a `finally` emits `ROP_TRY_END` and an inline copy of each enclosing finalizer
  before it jumps.
- `src/bytecode/register/compiler/statements.ts:640-641` — `compileThrowStatement`: one
  expression, one `ROP_THROW`.

### Iteration

- `src/runtime/iteration/iterator.ts:47-62` — `IteratorRecord`: a `source` field and a
  `next` closure. `nextValue(interpreter)` is the whole protocol.
- `src/runtime/iteration/iterator.ts:101-183` — `getIterator`'s five branches, in order:
  already an iterator (`:105`), a generator (`:107-114`, resumed via
  `interp.generatorNext`), an array (`:116-130`), a string (`:132-145`, iterating by
  **code point**, not code unit — `String.fromCodePoint` plus `index += ch.length`), and a
  `JSObject` (`:147-180`) whose `@@iterator` symbol *or* string-named `"@@iterator"`
  property is called and whose result is adapted. Then `throw`.
- `src/runtime/iteration/iterator.ts:64-99` — `createIteratorResult`, `wrapValueIterator`,
  `wrapEntryIterator` (the adapters `Map`/`Set` methods hand back, from [Ch 26 §
  collections]).
- `src/runtime/iteration/iterator.ts:185-195` — `iteratorDone` / `iteratorValue`, both
  written to answer for a non-object result rather than throw.
- `src/gc/roots.ts:222` — `if (p.source !== undefined) seedTagged(p.source)`. This is the
  *only* reader of `IteratorRecord.source`; the field exists so a live iterator keeps its
  iterable alive. Also `:296-297` and `:343`.
- `src/bytecode/register/compiler/functions.ts:1335-1405` — `compileForOfStatement`:
  `GetIterator`, then a loop of `IterNext` / `IterDone` / `IterValue`. Four of the twelve.
- `src/bytecode/register/compiler/functions.ts:1238-1292` — `compileForInStatement`:
  `GetKeys` into a `_keys$` local, `GetLength` into `_len$`, then an ordinary counted loop
  with `LdaIndex`. **None** of these are in the interpreter-only set.
- `src/bytecode/register/interpreter/generator-members.ts:33-92` — `generatorMemberValue`.
  `next` (`:39`) resumes a `GEN_NEWBORN` or `GEN_SUSPENDED` frame and passes the sent
  value in via `gen.frame.acc`; `return` (`:54-65`) completes the generator and fabricates
  a result; `throw` (`:66-88`) is the interesting one — it pops a handler *off the
  suspended frame's own* `exceptionHandlers`, sets `acc` and `pc`, and resumes into the
  catch clause. Anything else answers `mkUndefined()`.
- `src/bytecode/register/interpreter/generator-members.ts:22-31` —
  `asGeneratorMemberInterpreter`, the structural probe [Ch 25 § coroutine-exception]
  already met.

### The verdict

- `src/bytecode/register/interpreter/helpers.ts:67-80` — `INTERPRETER_ONLY_OPS`, twelve
  entries: `ROP_AWAIT`, `ROP_GET_ITERATOR`, `ROP_ITER_NEXT`, `ROP_ITER_DONE`,
  `ROP_ITER_VALUE`, `ROP_YIELD`, `ROP_LOAD_ARGUMENTS`, `ROP_TRY_START`, `ROP_TRY_END`,
  `ROP_THROW`, `ROP_LDA_KEYED_SLICE`, `ROP_ASSERT_CLASS_CONTRACTS`.
- `src/bytecode/register/interpreter/helpers.ts:82-89` — `requiresInterpreterOnly`:
  `compiledFn.isAsync || instructions.some(...)`. A linear scan, recomputed on every call.
- The five gates that consult it:
  `src/bytecode/register/interpreter/index.ts:503` (JIT, call path), `:515` (baseline,
  call path), `:975` (JIT, loop-budget path), `:1011` (baseline, loop-budget path), and
  `src/runtime/tiering/osr.ts:41` (OSR).

## Worked example

Two files already in `docs/example/`, neither of which can leave tier zero — and the
chapter should say so plainly rather than reach for a ninth spine file:

```bash
node dist/cli.js --print-bytecode docs/example/labeled.tera | grep -nE "GetIterator|Iter"
#   27  GetIterator      <- for r of rows
#   30  IterNext
#   33  IterDone
#   36  IterValue
#   39  GetIterator      <- for v of r
node dist/cli.js --print-bytecode --filter mean_of docs/example/stats-async.tera | grep Await
#    5  Await
```

`labeled.tera` is pinned by its two `for … of` loops; `stats-async.tera` is pinned twice
over, by `isAsync` and by `ROP_AWAIT`. The spine, `stats.tera`, contains none of the
twelve and is free to tier up — which is why every earlier chapter could follow it into
baseline and the JIT.

**The cost, measured.** The chapter's second half is a before/after on one loop: a purely
numeric `while` loop reaches OSR, and the identical loop with one `try` / `catch` inside
it never does. The categorical half is reproducible from `--trace` — the plain loop prints
`[JIT] OSR "hot" at loop offset 4` and the wrapped loop prints no tiering line at all. The
*speed* half must be re-measured, one case per fresh process, per [Conventions § 9]; the
project's recorded figure for OSR on numeric loops is ~145x and its provenance belongs in
[Ch 53 § osr]. Do not restate it here as a benchmark.

## Outline

- [ ] **Count them.** Open by reading `INTERPRETER_ONLY_OPS` out loud: twelve opcodes,
  plus `isAsync`. Establish immediately that the title's "eleven" is stale and that this
  is the kind of number a book should not encode — [Conventions § 6], honestly applied to
  the book itself.
- [ ] **> New idea: unwinding.** Establish what has to happen when control leaves a
  region abnormally: find the handler, restore the machine to a state the handler expects,
  jump. Then the two classic designs — a *static handler table* (a side table mapping
  `pc` ranges to catch targets, paid for only when something throws) and a *dynamic
  handler stack* (push on entry, pop on exit, paid for on every entry and exit).
- [ ] **Why the obvious design fails — inverted.** tera picks the *dynamic* stack, which
  is the design most engines avoid. Establish honestly why it works here: the interpreter
  already has a `frame` object, `exceptionHandlers` is lazily allocated (`:2169`), and the
  static table would have to be computed by a bytecode compiler that also has to emit two
  overlapping regions for `finally`. Establish the cost — two extra dispatched
  instructions per `try` entry/exit — and the real cost, which is not speed: the opcodes
  exist, so the function is pinned to tier zero.
- [ ] **The catch is per instruction.** Show that the host `try` wraps the whole `switch`,
  not the whole `run` (`:2456`). Establish the consequence: any opcode implementation that
  throws — a `VMTypeError` from [Ch 26 § indexing], a JavaScript `TypeError` from a bad
  cast inside the engine — becomes catchable tera-side, whether or not that was intended.
- [ ] **Three thrown shapes, one accumulator.** Walk `RegisterException`, `VMError`, host
  `Error`. Establish the third as a defect that works: the engine formats a name into a
  message string and then parses it back out with a regex, and reconstitutes a
  `constructor` as `mkFunction({ name, properties: {} })` — a function object that exists
  only so `e.constructor.name` answers.
- [ ] **The producer of shape three.** `getIterator`'s
  `throw new Error("TypeError: value is not iterable")`. Establish the round trip in full,
  and state the general rule: a boundary that encodes structure into a string will
  eventually need a parser, and the parser is where the information loss shows up.
- [ ] **`finally` costs two regions and two copies.** Walk `compileTryStatement`'s
  finalizer branch instruction by instruction: outer `TryStart`, inner `TryStart`, body,
  `TryEnd`, jump over catch, catch clause (or a bare `ROP_THROW` when there is no catch),
  `TryEnd`, finalizer copy #1, jump past outer, outer catch target, stash to a temp,
  finalizer copy #2, reload, `ROP_THROW`. Establish that duplication — not a subroutine —
  is the standard answer, and name what it buys: no return-address register, no
  `finally`-block calling convention.
- [ ] **Non-local exits pay too.** `_finallyBlocks` and `statements.ts:461-471`: a
  `break`, `continue` or `return` crossing a `finally` emits `TryEnd` plus an inline copy
  of every enclosing finalizer. Establish that `throw` is not special — it is one member
  of a family of four, and the compiler treats them uniformly.
- [ ] **> New idea: the iterator protocol.** Establish `IteratorRecord` as a two-field
  record — a `source` and a `next` closure — and `{value, done}` as the contract.
  Establish that tera's `for … of` never sees a "protocol"; it sees four opcodes.
- [ ] **`getIterator`'s five branches.** Walk them in the order the function tests them,
  and establish what each one costs. Call out the string branch iterating **code points**
  (so `for c of s` and `s[i]` disagree on astral characters — connect to
  [Ch 68 § utf16]) and the object branch's *two* spellings, the well-known symbol and the
  literal `"@@iterator"` property name.
- [ ] **`source` exists for the collector.** Establish that `IteratorRecord.source` is
  written by every constructor and read by exactly one place, `gc/roots.ts:222`. Tell the
  bug as engineering ([Conventions § 15]): an iterable reachable only through its
  iterator's JavaScript closure was invisible to the collector and got swept mid-loop;
  the fix was to give the record an explicit field the root scan can see; the general rule
  is that a closure is not a root set, and forward to [Ch 32 § what-is-a-root].
- [ ] **Generators: `next`, `return`, `throw`.** Establish resumption via `gen.frame.acc`
  and the `GEN_NEWBORN` / `GEN_SUSPENDED` / `GEN_COMPLETED` states, then the
  interesting case: `gen.throw(e)` reaches *into a frame that is not running*, pops that
  frame's own handler stack, and resumes at its `catchPC`. Establish why the handler stack
  being *in the frame* is what makes this a five-line operation.
- [ ] **The verdict, and the five gates.** `requiresInterpreterOnly` is consulted at two
  JIT gates, two baseline gates and OSR. Establish that the answer is recomputed by
  scanning the instruction stream each time, that nothing caches it on the compiled
  function, and that "for the life of the process" is therefore a property of the
  bytecode, not a flag anyone sets.
- [ ] **What was tried and rejected — or rather, never needed.** The asymmetry that saves
  the set: `for x in y` lowers to `GetKeys` + `GetLength` + `LdaIndex` and stays
  optimizable, while `for x of y` lowers to four interpreter-only opcodes. Establish the
  practical consequence with the running example — the spine's `mean` uses a counted
  `while`, so nothing in `stats.tera` is pinned — and be honest that this is a
  *coincidence of style*, not a mitigation anyone designed.
- [ ] **What it would cost to shrink the set.** Take the twelve one at a time and say what
  each would need: `ROP_LDA_KEYED_SLICE` needs the baseline to call `indexValue`;
  `ROP_TRY_START`/`END`/`THROW` need a static handler table or a JavaScript `try` in the
  emitted baseline source; the four iterator opcodes need `IteratorRecord` reachable from
  generated code; `ROP_AWAIT` and `ROP_YIELD` need the frame to be suspendable in a tier
  that has no frame. Establish which of these the AOT compiler already solved for its own
  road ([Ch 63 § coroutines], [Ch 66 § generators]) — and that none of that work came
  back to help the JIT.
- [ ] **What leaves.** The tier verdict, and the handover to chapter 28.

## Honesty items

- [ ] > **Unfinished.** `INTERPRETER_ONLY_OPS`
  (`src/bytecode/register/interpreter/helpers.ts:67-80`) is a permanent capability gap,
  not a bug: twelve opcodes cost a function baseline, JIT and OSR forever. Cheapest
  removal is `ROP_LDA_KEYED_SLICE` — the baseline runtime could call
  `src/runtime/indexing.ts` `indexValue` directly, as it already calls
  `getRuntimeProperty`.
- [ ] > **Unenforced.** Nothing keeps `INTERPRETER_ONLY_OPS` in step with the tiers'
  actual capabilities. It is a hand-maintained `Set`; a baseline that learned to emit an
  opcode would still be refused, and an opcode added to the baseline's blind spot would
  still be attempted. `tests/bytecode/register/interpreter/helpers.test.ts` samples the
  set, it does not derive it.
- [ ] > **Dead.** `src/bytecode/register/compiler/statements.ts:564-565` — `hasFinally`
  and `hasCatch` are computed and never read; the function branches on `finalizer` and
  `handler` directly.
- [ ] > **Unfinished.** `requiresInterpreterOnly` rescans the whole instruction array at
  every one of its five call sites; `RegisterCompiledFunction` carries no cached flag.
  Not measured — [Conventions § 9] — but the answer cannot change after compilation, so
  the recomputation is unconditional work with a known-constant result.
- [ ] > **Unenforced.** The host-`Error` reshaping at
  `src/bytecode/register/interpreter/index.ts:2479-2492` depends on every engine-internal
  error message beginning with `SomethingError: `. A message that does not match keeps
  `thrown.name` and the full message, silently; a *tera* string that happens to match the
  pattern is re-split. No test covers a mismatching or falsely-matching message.
- [ ] > **Unenforced.** `generatorMemberValue`'s `throw` branch pops the suspended frame's
  handler without checking that the popped `catchPC` belongs to a region containing the
  suspension point. [unpinned] — no test throws into a suspended generator.
- [ ] Naming note per [Conventions § 4]: `IteratorRecord.source` is not the iterator's
  source *code* and is never read by the iteration logic; it is a GC root anchor. Keep the
  name, say what it does.

## Verify it yourself

```bash
grep -n "INTERPRETER_ONLY_OPS" -A 14 src/bytecode/register/interpreter/helpers.ts
node dist/cli.js --print-bytecode docs/example/labeled.tera | grep -nE "GetIterator|Iter"
node dist/cli.js --print-bytecode --filter mean_of docs/example/stats-async.tera | grep Await
npx vitest run --project unit tests/bytecode/register/interpreter/helpers.test.ts
npx vitest run --project unit tests/runtime/iteration/iterator.test.ts
npx vitest run --project e2e tests/e2e/language/async-generator.test.ts
```

`docs/example/labeled.tera` is safe to run: its labelled `continue` used to loop forever
and no longer does ([`docs/example/README.md` § labeled-tera-and-the-jump-nobody-patched],
[Ch 19 § the-fix]).

## Tests that pin this

- `tests/bytecode/register/interpreter/helpers.test.ts` > "requiresInterpreterOnly" >
  "returns true for async functions", "returns true when instructions contain
  interpreter-only ops (await, yield, iterators)", "returns true when instructions contain
  exception-handling ops (try/throw)", "returns false for normal sync functions without
  special ops".
- `tests/bytecode/register/interpreter/helpers.test.ts` > "errorToTaggedValue" > "unwraps
  RegisterException to its inner value", "converts plain Error to tagged string with
  message".
- `tests/bytecode/register/interpreter.test.ts` > "helpers" > "requiresInterpreterOnly" >
  "returns true for function with await", "returns true for iterator ops", "returns false
  for plain function".
- `tests/bytecode/register/interpreter.test.ts` > "RegisterInterpreter" > "runFrame -
  exception handling" > "THROW without handler propagates", "TRY_START/TRY_END catches
  exception".
- `tests/runtime/iteration/iterator.test.ts` > "getIterator" > "iterates array elements in
  order", "array iterator handles empty array", "iterates string characters", "string
  iterator handles empty string", "throws for non-iterable value", "array iterator yields
  undefined for holes", "iterator is single-pass (not restartable)".
- `tests/runtime/iteration/iterator.test.ts` > "IteratorRecord" > "custom next function
  drives iteration"; > "createIteratorResult" > "produces object with value and done
  fields", "done=true signals completion"; > "iteratorDone" > "returns true for non-object
  values"; > "iteratorValue" > "returns undefined for non-object values".
- `tests/e2e/language/control-flow.test.ts` > "catches thrown values and always runs
  finally", "surfaces an uncaught thrown value with a readable message, not [object
  Object]" — the second is the host-`Error` reshaping observed from the outside.
- `tests/e2e/language/async-generator.test.ts` > "Tera async and generators" > "runs
  generator yield and iterator next", "bridges async function results to native values".
- Not pinned, and named as such: no test asserts that a function containing one of the
  twelve opcodes fails to reach baseline, JIT or OSR *end to end* — the set is tested at
  the predicate, not at the gate. [unpinned]
