# 27. Exceptions, iteration, and the eleven opcodes that pin a function to tier zero   ⟨I · ~~B~~ · ~~J~~ · ~~N~~⟩

Every chapter so far has followed a value. This one follows a *disqualification*. There is
a `Set` of twelve opcode numbers in the interpreter's helper file, and a function whose
instruction stream contains any one of them will never be compiled by the baseline, never
be compiled by the JIT, and never be entered by on-stack replacement — not because those
tiers tried and failed, but because five separate gates ask one predicate and take its
answer as final. Two of the language's most ordinary constructs put opcodes in that set:
`try` and `for … of`. Writing either one anywhere in a function costs that function three
of the four machines this book is about, for the life of the process.

The mechanism behind the first of them is a *dynamic handler stack*: `ROP_TRY_START`
pushes a record onto the running frame, `ROP_TRY_END` pops it, and `ROP_THROW` reads it.
That design is the one most production engines avoid, and this chapter argues that here it
is the right call — and then shows the bill, which is not paid in dispatch cycles but in
tiering. The mechanism behind the second is an `IteratorRecord`: a two-field object holding
a value and a closure, produced by a five-branch dispatch and consumed by four opcodes that
generated code has no way to reach.

The title says *eleven*. It is a number the tree changed and the title did not, and the
chapter opens by counting.

**What arrived.** From [Ch 26 § what-leaves]: the completed *read* surface — named members,
subscripts, slices, class lineage, and the exotic hooks that opt out of the map machinery.
Chapter 26 handed this chapter a casualty without naming it as one. `ROP_LDA_KEYED_SLICE`,
the opcode behind `a[1:3]` and `m[i, j]`, is already in `INTERPRETER_ONLY_OPS`. A slice
anywhere in a function body costs that function baseline, JIT and OSR forever, and nothing
in chapter 26's account of slicing said so, because at that point the set had not been
read yet.

`docs/example/stats.tera` contains no `try`, no `throw`, no `for … of` and no slice. Nor
does any of the seven variations except `labeled.tera` (two `for … of` loops) and
`stats-async.tera` (`await`, and `isAsync`). The spine is not merely uninvolved here — its
*non*-involvement is the reason chapters 33 through 54 could follow it into feedback,
baseline and wasm at all. Where this chapter needs a `try` or a `finally` to disassemble,
it uses a purpose-built probe and says so, per [Conventions § 2].

## Eleven opcodes, which are twelve

Here is the set, in the order the file writes it.

```ts
export const INTERPRETER_ONLY_OPS: Set<number> = new Set([
  bytecode.ROP_AWAIT,
  bytecode.ROP_GET_ITERATOR,
  bytecode.ROP_ITER_NEXT,
  bytecode.ROP_ITER_DONE,
  bytecode.ROP_ITER_VALUE,
  bytecode.ROP_YIELD,
  bytecode.ROP_LOAD_ARGUMENTS,
  bytecode.ROP_TRY_START,
  bytecode.ROP_TRY_END,
  bytecode.ROP_THROW,
  bytecode.ROP_LDA_KEYED_SLICE,
  bytecode.ROP_ASSERT_CLASS_CONTRACTS,
]);
```
— src/bytecode/register/interpreter/helpers.ts:67-80

Twelve. The chapter's registered title, in [SUMMARY.md](../SUMMARY.md) and in this part's
opener, says eleven, and so does chapter 26's handover paragraph. The count was right when
those were written. Per [Conventions § 4] the code's name — and here the code's *number* —
wins: this book will say twelve, keep the stale title so cross-references from
[Ch 37 § enterosr-in-full] and [Ch 81] do not break, and record the mismatch rather than quietly
renaming the file. The deeper lesson is about the book, not the engine: a chapter title
should not encode a cardinality that a one-line commit can change. `INTERPRETER_ONLY_OPS`
is a hand-maintained `Set` literal. Adding a thirteenth entry is one line and no test
failure.

And there is a thirteenth disqualifier that is not an opcode at all.

```ts
export function requiresInterpreterOnly(compiledFn: RegisterCompiledFunction): boolean {
  return (
    compiledFn.isAsync ||
    compiledFn.instructions.some((instr) =>
      INTERPRETER_ONLY_OPS.has(instr.opcode),
    )
  );
}
```
— src/bytecode/register/interpreter/helpers.ts:82-89

`compiledFn.isAsync` is a flag the bytecode compiler sets from the declaration, not
something the instruction stream implies. An `async fn` with an empty body — no `await`,
therefore no `ROP_AWAIT` — is still pinned. So `stats-async.tera`'s `mean_of` is pinned
twice over, once by the flag and once by the opcode
[t: tests/bytecode/register/interpreter/helpers.test.ts > "returns true for async functions"].

## Unwinding, and two designs for it

> **New idea.** *Unwinding* is what has to happen when control leaves a region abnormally.
> A normal exit — falling off the end of a block, or a `return` — leaves the machine in a
> state the next instruction expects. An abnormal exit does not: the value being thrown is
> somewhere, the program counter is in the middle of a region, and there may be several
> nested regions between the throw and the code that wants to handle it. Unwinding is the
> three-step answer: **find** the handler that claims this program counter, **restore** the
> machine to the state that handler expects, and **jump** there. Every language with
> exceptions does those three things. They differ only in where the "find" step gets its
> information.

There are two classic places to keep it.

A **static handler table** is a side table, built at compile time, mapping ranges of
program counters to catch targets. Nothing is emitted into the instruction stream at all;
entering a `try` costs zero instructions. When something throws, the runtime binary-searches
the table for a range containing the current `pc`, and walks outward through enclosing
ranges until one matches. This is what C++ and Java implementations do, and it is what
tera's *native* backend does when it emits `.pdata` / `.xdata` and `.eh_frame`
([Ch 71 § eh-frame-cie-and-fde]). Its selling point is a slogan: you pay nothing until you throw.

A **dynamic handler stack** pushes a record when control enters a protected region and pops
it when control leaves. Finding the handler is then trivial — it is the top of the stack —
but every entry and every exit costs real work whether or not anything ever throws.

tera's interpreter picks the dynamic stack, and it is worth being precise about how small
the machinery is.

```ts
            case bytecode.ROP_TRY_START: {
              if (!frame.exceptionHandlers) frame.exceptionHandlers = [];
              frame.exceptionHandlers.push({
                catchPC: operands[0],
              });
              break;
            }

            case bytecode.ROP_TRY_END: {
              frame.exceptionHandlers?.pop();
              break;
            }
```
— src/bytecode/register/interpreter/index.ts:2168-2179

The record type has four fields — `catchPC`, `finallyPC`, `endPC`, `stackDepth`
(`src/bytecode/register/interpreter/frame.ts:9-14`) — and `ROP_TRY_START` writes exactly
one of them. [Ch 21 § the-frame-is-thirteen-fields] has already flagged the other three as never written and
never read. Everything below rests on the single number `catchPC`.

## Why the obvious design fails — inverted

The obvious design here is the *static* table, because it is the one every serious runtime
uses and because "pay nothing until you throw" is the correct trade for a program that
almost never throws. Staging it honestly is the point of this section, because on this
occasion the obvious design is the one that fails.

To build a static table, the bytecode compiler must know, for every instruction it emits,
which protected regions contain it — and must record those regions as `[startPC, endPC)`
intervals after all jump patching is done. That is not hard for a plain `try`/`catch`. It
is hard for `finally`, because as the next section shows, tera lowers a `finally` into
**two overlapping regions**: an inner one covering the try block, and an outer one covering
the try block *and* the catch clause. Overlapping intervals mean the table cannot be a
sorted flat list searched once; it needs nesting depth or an interval tree, and the compiler
needs a second pass to compute the `endPC` of each region after every `patchJump` has run.
Against that, the dynamic stack needs nothing: the compiler emits `TryStart` where the
region opens and `TryEnd` where it closes, and the *bytecode's own control flow* keeps the
stack correct for free — as long as control actually reaches the `TryEnd`.

Three things make the dynamic stack cheap enough here to win.

First, the interpreter already has a `frame` object. There is no separate stack to allocate
and no register to reserve; `exceptionHandlers` is one more field on a structure that
already exists.

Second, it is lazily allocated. `if (!frame.exceptionHandlers) frame.exceptionHandlers = []`
at `index.ts:2169` means a function with no `try` in it never allocates the array. The
overwhelming majority of frames pay literally nothing.

Third, the interpreter is already a dispatch loop. Two extra dispatched instructions per
`try` entry and exit is a rounding error against a `switch` that dispatches every operation
in the program. This is not measured — there is no benchmark harness in this tree
([Conventions § 9]) — but the structural argument does not need a number: the alternative
design's saving is measured against a baseline that is already interpretation.

So the cost of the dynamic stack is not speed. The cost is the two opcodes. `ROP_TRY_START`
and `ROP_TRY_END` are instructions, and instructions are what `requiresInterpreterOnly`
scans for. A static table would have been *invisible* to that scan — it would have lived in
a side field, not the instruction stream — and a function with a `try` in it could have
been handed to the baseline unchanged, because the baseline emits JavaScript source and
JavaScript has `try`. The design that is right for the interpreter is precisely the design
that makes the function unliftable. That is the real bill, and nothing in either file says
so.

## The catch is per instruction

The interpreter's host-language `try` does not wrap `runFrame`. It wraps the opcode
`switch`, inside the dispatch loop, at `src/bytecode/register/interpreter/index.ts:2456`.
The `catch` runs, inspects `frame.exceptionHandlers`, and — if it can handle the throw —
sets `frame.pc` and executes `continue`, resuming the *same* dispatch loop at the catch
target. Only if no branch matches does it re-throw and let the exception leave the frame.

That placement has a consequence worth stating plainly: **any** failure inside **any**
opcode implementation becomes catchable from tera. The `VMTypeError` a bad subscript raises
([Ch 26 § indexing-two-subscripts-one-file]), the `VMReferenceError` a TDZ read raises ([Ch 21 § getreg-is-three-implementations-wearing-one-signature]), a
`RangeError` thrown by a host array method, a `TypeError` from a null dereference inside an
engine helper — all of them are raised while the dispatch loop is inside its own `try`, so
all of them land in the same three-way analysis, and a tera `catch` clause can see them.

Some of that is deliberate: the engine wants `throw Error("db down")` from tera and a
runtime type error to be catchable the same way
[t: tests/e2e/language/control-flow.test.ts > "surfaces an uncaught thrown value with a readable message, not [object Object]"].
Some of it is not: an internal invariant failure inside an opcode handler is also a host
`Error`, and it is also catchable, and it will be reshaped into a tera object with a
plausible-looking `name` and `message`. There is no marker distinguishing "an error the
language defines" from "the engine broke". The next section is where that gets expensive.

## Three thrown shapes, one accumulator

The `catch` around the switch tests three shapes, in order, and every one of them ends by
putting a `TaggedValue` in `frame.acc` and jumping to `catchPC` — so from tera's point of
view a `catch` clause always binds one ordinary value.

**Shape one, `RegisterException`.** This is a tera value on its way out. `RegisterException`
is a two-line class holding a single `TaggedValue`
(`src/bytecode/register/interpreter/helpers.ts:106-112`); the handler unwraps it with
`frame.acc = thrown.value` and continues. Nothing is converted. A tera `throw "kaboom"`
caught by a tera `catch` binds the same string object it threw
[t: tests/bytecode/register/interpreter/helpers.test.ts > "unwraps RegisterException to its inner value"].

**Shape two, `VMError`.** An engine error with a declared structure. `vmErrorToTagged`
builds a tera object from it, taking the six value constructors as parameters so the
conversion module does not have to import the value module. Structure in, structure out.

**Shape three, a host `Error`.** This is the interesting one, and it is a defect that
works.

```ts
              let name = thrown.name || "Error";
              let message = thrown.message || "";
              const m = /^([A-Z][A-Za-z]*Error):\s*([\s\S]*)$/.exec(message);
              if (m) {
                name = m[1];
                message = m[2];
              }
              const errObj = createJSObject();
              errObj.setProperty("name", mkString(name));
              errObj.setProperty("message", mkString(message));
              errObj.setProperty("stack", mkString(thrown.stack || ""));
              errObj.setProperty("__isError__", mkBool(true));
              errObj.setProperty(
                "constructor",
                mkFunction({ name, properties: {} }),
              );
```
— src/bytecode/register/interpreter/index.ts:2483-2498

Read the regular expression, then read what it is for. The engine takes a message string,
tests whether it *begins with a word ending in `Error` followed by a colon*, and if so
splits that prefix off and promotes it to the error's `name`. It then fabricates a
`constructor` property: `mkFunction({ name, properties: {} })` is a function value with a
name, no `call`, no `compiled`, and no body. It exists for exactly one purpose — so that
`e.constructor.name` answers something. Calling it fails.

> **Unenforced.** The reshaping at
> `src/bytecode/register/interpreter/index.ts:2480-2502` assumes every engine-internal
> error message begins with `SomethingError: `. A message that does not match keeps
> `thrown.name` (usually the bare `"Error"`) and the whole message, silently — no
> diagnostic, no marker. Worse in the other direction: a *tera* string that happens to
> match the pattern is re-split, so `throw Error("RangeError: index")` from tera source
> arrives in the `catch` clause with `name === "RangeError"`. No test in `tests/` covers a
> mismatching or a falsely-matching message. Cost to enforce: carry the name in a field on
> a wrapper type instead of inside the text, which means touching every producer.

## The producer of shape three

The clearest producer of a shape-three throw in the tree is one line, and it sits at the
end of the iteration module this chapter is about to spend several pages inside.

```ts
  throw new Error("TypeError: value is not iterable");
```
— src/runtime/iteration/iterator.ts:182

Put the two halves side by side. `getIterator` has a structured fact — *this value has no
iterator* — and one channel to report it through: a host `Error`, which carries a string.
So it encodes the structure into the string: the word `TypeError`, a colon, a space, the
message. Thirty milliseconds and 2,300 lines later, the dispatch loop's `catch` receives
that string and runs a regular expression over it to get the structure back out
[t: tests/runtime/iteration/iterator.test.ts > "throws for non-iterable value"].

The round trip works. It also loses. The regex accepts anything matching
`[A-Z][A-Za-z]*Error`, so it cannot tell an engine-defined error name from a coincidence,
and it cannot represent a name with a digit or an underscore in it, and it cannot carry a
source position, a node, or a value — because none of those survive `String`. The general
rule, and it recurs on the AOT road in [Ch 63], where a thrown `Error` is carried as the
text it reports: **a boundary that encodes structure into a string will
eventually need a parser, and the parser is where the information loss becomes visible.**

## Double TryStart, and two copies of the finalizer

`finally` is the construct that shapes the whole design, so it is worth walking through the
bytecode. `docs/example/` contains no `try` at all, so this section uses a probe (per
[Conventions § 2]); its source is six lines and its full disassembly is in
[§ verify-it-yourself](#verify-it-yourself).

```
fn f(n: int) -> int:
  try:
    n = n + 1
  finally:
    n = n + 10
  return n
```

The first half of what `--print-bytecode` prints for `f`:

```
     0  TryStart r21
     1  TryStart r11
     2  Ldar r0
     3  Star r1
     4  LdaConst [0] (1)
     5  Star r2
     6  Ldar r1
     7  Add r2 r0
     8  Star r0
     9  TryEnd
    10  Jump r12
    11  Throw
```

Two `TryStart`s open the function. The disassembler prints their operands as `r21` and
`r11` because the operand formatter renders every unrecognized operand as a register
(`src/bytecode/register/ops/bytecode.ts:648`); these are instruction indices, not registers
— the point [Ch 24 § the-second-hop-thisvalueslength] already makes once about jump targets. So the
outer region's catch target is instruction 21 and the inner region's is instruction 11.

Instruction 11 is a bare `Throw`. That is the "no catch clause" case: the inner region
exists purely so that a throw inside the try block has somewhere to land, and all it does
is re-raise, which drops through to the outer region. Instruction 10 jumps over it on the
normal path.

The second half is where the duplication lives:

```
    12  TryEnd
    13  Ldar r0
    14  Star r1
    15  LdaConst [1] (10)
    16  Star r2
    17  Ldar r1
    18  Add r2 r1
    19  Star r0
    20  Jump r31
    21  Star r3
    22  Ldar r0
    ...
    28  Star r0
    29  Ldar r3
    30  Throw
    31  Ldar r0
    32  Return
```

Instructions 13-19 are the finalizer on the normal path. Instructions 22-28 are the
finalizer *again*, on the exceptional path, bracketed by `Star r3` (stash the in-flight
exception in a temp) at 21 and `Ldar r3` / `Throw` at 29-30 (reload it and re-raise). The
compiler emits the same statements twice.

The compiler code that does it is fourteen lines:

```ts
      this.func.emit(bytecode.ROP_TRY_END);
      this.compileStatements(blockBody(finalizer.body));
      const jumpPastOuter = this.func.emit(bytecode.ROP_JUMP, 0);

      const outerCatchStart = this.func.instructions.length;
      this.func.patchJump(outerTryStart, outerCatchStart);
      const exReg = this.func.allocTemp();
      this.func.emit(bytecode.ROP_STAR, exReg);
      this.compileStatements(blockBody(finalizer.body));
      this.func.emit(bytecode.ROP_LDA_REG, exReg);
      this.func.emit(bytecode.ROP_THROW);

      const afterAll = this.func.instructions.length;
      this.func.patchJump(jumpPastOuter, afterAll);
```
— src/bytecode/register/compiler/statements.ts:596-609

`this.compileStatements(blockBody(finalizer.body))` appears twice, seven lines apart.
Duplication — not a subroutine — is the standard answer to `finally` in every bytecode
compiler that does not want to invent a calling convention for a block, and it is worth
naming what the duplication buys. A subroutine version needs a return-address value, a
place to keep it that survives the finalizer body, an opcode to jump to it, an opcode to
jump back, and a rule for what happens when the finalizer itself throws while a return
address is live. The JVM tried it (`jsr`/`ret`) and eventually stopped. Duplication costs
code size and nothing else, and code size here is instruction-array length in a process
that already holds the AST.

> **Dead.** `src/bytecode/register/compiler/statements.ts:564-565` computes
> `const hasFinally = !!finalizer` and `const hasCatch = !!handler`, and neither is ever
> read — the function branches on `finalizer` and `handler` directly, and a repository-wide
> grep for both names returns only these two lines. Cost to remove: deleting two lines.

## Non-local exits pay too — except when they do not

> **New idea.** A *non-local exit* is any transfer of control that leaves a region without
> running to its end. `break`, `continue`, `return` and `throw` are one family: each of
> them can jump out of the middle of a `try` block, and each of them therefore has to
> answer the same question — what still has to run on the way out, and what has to be
> popped off the handler stack.

The compiler keeps a compile-time stack, `_finallyBlocks`
(`src/bytecode/register/compiler/statements.ts:129`), holding the body of every enclosing
`finally`. `compileTryStatement` pushes onto it at `:568` and pops at `:610`. Anything that
wants to leave the region reads it and inlines what it finds:

```ts
    if (this._finallyBlocks.length > 0) {
      var retReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, retReg);
      var saved = this._finallyBlocks;
      for (var i = saved.length - 1; i >= 0; i--) {
        this.func.emit(bytecode.ROP_TRY_END);
        this._finallyBlocks = saved.slice(0, i);
        this.compileStatements(saved[i].body);
      }
      this._finallyBlocks = saved;
      this.func.emit(bytecode.ROP_LDA_REG, retReg);
```
— src/bytecode/register/compiler/statements.ts:461-471

That is `compileReturnStatement`. It stashes the return value, then walks the enclosing
finalizers outermost-last, emitting a `TryEnd` and a full inline copy of each, then reloads
the value and returns. It even truncates `_finallyBlocks` as it goes (`:467`) so a `return`
*inside* a finalizer does not re-run the finalizer it is already inside. This is careful,
correct code, and it is the reason the `guard()` probe in
[§ verify-it-yourself](#verify-it-yourself) contains the finalizer body four times — two
from `compileTryStatement`, one per `return`.

`_finallyBlocks` is read in exactly one place. `compileReturnStatement`. That is the whole
list.

### The break that skips the finalizer

```ts
  compileBreakStatement(node) {
    if (node.label && this._labeledBreaks && this._labeledBreaks[node.label]) {
      this._labeledBreaks[node.label].push(
        this.func.emit(bytecode.ROP_JUMP, 0),
      );
    } else if (this._breakJumps) {
      this._breakJumps.push(this.func.emit(bytecode.ROP_JUMP, 0));
    }
  },
```
— src/bytecode/register/compiler/statements.ts:551-559

One `ROP_JUMP`. No `TryEnd`, no finalizer copy, no consultation of `_finallyBlocks`.
`compileContinueStatement` (`:654-666`) is the same shape. Two of the family of four do not
pay, and the consequence is two distinct wrong answers.

> **Broken.** `break` and `continue` do not run enclosing `finally` blocks and do not pop
> the handlers they jump out of. `compileBreakStatement`
> (`src/bytecode/register/compiler/statements.ts:551-559`) and `compileContinueStatement`
> (`:654-666`) emit a bare `ROP_JUMP`; only `compileReturnStatement` (`:461-471`) reads
> `_finallyBlocks`. Cost of a fix: hoist the finalizer-inlining loop from
> `compileReturnStatement` into a shared helper and call it from all three, plus a way for
> break/continue to know how many `TryEnd`s to emit for regions they exit that have no
> `finally` at all.

Told as engineering, per [Conventions § 15]:

**Symptom, part one — the finalizer never runs.** A `break` out of a `try`/`finally` inside
a loop silently skips the finalizer for that iteration. The probe
`scratch/brk.tera` — a `while` loop whose `try` breaks on the second iteration and whose
`finally` prints — prints `fin` **once**. JavaScript, and every language with `finally`,
prints it twice.

**Symptom, part two — the handler outlives the region.** This is the worse half, because
the finalizer is not merely skipped, it is *deferred onto an unrelated throw*. The
`TryStart` pushed a record that no `TryEnd` ever pops, so `frame.exceptionHandlers` is left
non-empty after the loop. Here is a probe that terminates:

```
fn f() -> int:
  i = 0
  while i < 3:
    try:
      if i == 1:
        break
      i = i + 1
    catch e:
      print("caught by the loop's handler")
      return 99
  print("out of the loop")
  throw "boom"
  return i
print(f())
```

It prints:

```
out of the loop
caught by the loop's handler
99
```

The `throw "boom"` — outside the loop, outside the `try`, three lines after the loop closed
— is caught by the loop body's `catch` clause, because that handler is still on the frame's
stack. Replace `return 99` with anything that falls through and the program **hangs**: the
catch clause is inside the loop, so control resumes at the loop latch, `i` is still 1,
`break` fires again, the throw is reached again, and the stale handler catches it again,
forever.

**Mechanism.** `ROP_TRY_START` pushes unconditionally (`index.ts:2169-2172`); the only pops
are `ROP_TRY_END` (`:2177`), `takeCatchPC` (`:456-459`) on an actual throw, and two
coroutine paths covered below. Balance is therefore a property of the *emitted control
flow*, not of the opcode. `compileTryStatement` emits a `TryEnd` on every path it controls.
A `break` jumps past all of them.

**Fix.** Not applied — this is a documentation task, and the fix is a compiler change with
a nontrivial design question in it (how many regions a labelled `break` crosses). Recorded
here and in `docs/appendix/d-inventory.md` § Broken.

**Regression test.** None exists.
`tests/e2e/language/control-flow.test.ts > "catches thrown values and always runs finally"`
is the only end-to-end `finally` test, and its `try` is at the top level of the script with
no loop and no `break`, so it cannot see this. `[unpinned]`

**The general rule.** *A dynamic handler stack makes balance a property of emitted control
flow, and a compiler that has more than one way to leave a region must pay the balancing
cost at every one of them.* This is precisely the class of bug a static handler table
cannot have: a table keyed on `pc` ranges is correct no matter how control got to the `pc`.
It is the price of the trade [§ why-the-obvious-design-fails-inverted](#why-the-obvious-design-fails--inverted)
argued was worth making, and it is fair to say the argument is now one bug more expensive
than it looked.

## The iterator protocol

> **New idea.** An *iterator protocol* is a contract, not a language feature. It says: an
> iterable can hand you an object; that object answers a `next` request; each answer is a
> pair — a `value` and a `done` flag; when `done` is true the sequence is over. That is the
> whole protocol. Anything that answers `next` that way can be looped over, which is why a
> language can add `for … of` without knowing about arrays, strings, generators, or the
> collection types someone will write next year.

tera's representation of the contract is one class.

```ts
export class IteratorRecord {
  source: TaggedValue;
  next: (interpreter: IteratorInterpreter | null) => TaggedValue;

  constructor(
    source: TaggedValue,
    next: (interpreter: IteratorInterpreter | null) => TaggedValue,
  ) {
    this.source = source;
    this.next = next;
  }

  nextValue(interpreter: IteratorInterpreter | null): TaggedValue {
    return this.next(interpreter);
  }
}
```
— src/runtime/iteration/iterator.ts:47-62

A value and a closure. `nextValue` is the entire protocol, and it is a one-line forward
[t: tests/runtime/iteration/iterator.test.ts > "custom next function drives iteration"].
The result is built by `createIteratorResult(value, done)` (`:64-69`), which allocates a
`JSObject` with two properties, and read back by `iteratorDone` (`:185-189`) and
`iteratorValue` (`:191-195`) — both of which answer for a non-object result rather than
throwing: `iteratorDone` of a non-object is `true` (stop) and `iteratorValue` of a
non-object is `undefined`
[t: tests/runtime/iteration/iterator.test.ts > "returns true for non-object values"].
A misbehaving user iterator ends the loop; it does not crash it.

The `source` field is not part of the contract. It is dealt with in
[§ source-exists-for-the-collector](#source-exists-for-the-collector) below.

What tera's `for … of` sees is not a protocol at all. It sees four opcodes.
`compileForOfStatement` (`src/bytecode/register/compiler/functions.ts:1335-1406`) emits
`ROP_GET_ITERATOR` once, stores the result in a synthetic local named `_iter$`, and then
loops: `ROP_ITER_NEXT` into `_iterResult$`, `ROP_ITER_DONE` and a conditional exit,
`ROP_ITER_VALUE` into the loop variable, the body, jump back. Four of the twelve, all in
one construct.

## getIterator's five branches

`getIterator` (`src/runtime/iteration/iterator.ts:101-183`) is a linear cascade of five
type tests. Order matters, because the earlier branches are the ones that avoid work.

**1. Already an iterator** (`:105`). `if (isIterator(value)) return value` — one line. This
is what makes `for x of someIterator` legal and what guarantees an `IteratorRecord` is
never given another `IteratorRecord` as its `source`.

**2. A generator** (`:107-114`). Wraps the generator payload in a record whose `next` calls
`interp.generatorNext(gen, mkUndefined())`. Every step resumes a suspended frame; the
result object is built by the generator machinery, not here.

**3. An array** (`:116-130`). Closes over an integer `index` and the array payload, and
walks `getLength()` / `getIndex(index++)`. A hole reads back as `undefined`, so an array
literal with a gap iterates the gap as a value rather than skipping it
[t: tests/runtime/iteration/iterator.test.ts > "array iterator yields undefined for holes"].
The index lives in the closure, which is what makes an iterator single-pass: exhaust it and
it stays exhausted
[t: tests/runtime/iteration/iterator.test.ts > "iterator is single-pass (not restartable)"].

**4. A string** (`:132-145`), and this branch has a consequence worth its own paragraph.

```ts
  if (isString(value)) {
    let index = 0;
    const str = getPayload(value) as string;
    return mkIterator(
      new IteratorRecord(value, () => {
        if (index >= str.length)
          return createIteratorResult(mkUndefined(), true);
        const cp = str.codePointAt(index);
        const ch = String.fromCodePoint(cp!);
        index += ch.length;
        return createIteratorResult(mkString(ch), false);
      }),
    );
  }
```
— src/runtime/iteration/iterator.ts:132-145

`codePointAt` and `String.fromCodePoint`, and `index += ch.length` — not `index++`. This
iterates by **code point**. A character outside the Basic Multilingual Plane is two UTF-16
code units, so `str.length` counts it twice but this loop yields it once and advances by
two. `s[i]`, which goes through the subscript path of [Ch 26 § indexing-two-subscripts-one-file], counts code
*units*. So `for c of s` and `s[i]` disagree about astral characters — the same string has
one length for indexing and a different count for iteration. The disagreement is deliberate
in JavaScript and inherited here; [Ch 59 § what-a-character-is] takes it up on the native road, where the
two counts have to be materialized in different runtimes
[t: tests/runtime/iteration/iterator.test.ts > "iterates string characters"].

**5. A `JSObject`** (`:147-180`), which is the branch with two spellings. It first asks for
the well-known `Symbol.iterator` property, and if the object does not have it, walks the
prototype chain asking each prototype (`:153-159`). If that finds nothing, it falls back to
a *string-named* property literally called `"@@iterator"` (`:162`), looked up through
`getPropertyInChain`. Both spellings are live: a tera class can write
`this["@@iterator"] = () => this` in its constructor and be iterable without touching
symbols at all
[t: tests/e2e/language/control-flow.test.ts > "iterates user-defined objects with @@iterator and prototype next"].
Whatever the method returns is then adapted: if it is already an iterator, it is used
directly; if it is an object with a `next` in its prototype chain, a fresh `IteratorRecord`
is built around a call to that `next`.

Then, and only then, the `throw` from
[§ the-producer-of-shape-three](#the-producer-of-shape-three).

`wrapValueIterator` and `wrapEntryIterator` (`:71-99`) are the two adapters `Map` and `Set`
methods hand back ([Ch 26 § collections-opt-out-by-a-side-field]); both take a JavaScript `Iterator` and a `source`
value and produce a record. `wrapEntryIterator` additionally packs each `[key, value]` pair
into a two-element tera array.

## source exists for the collector

Every one of those five branches passes something as the first constructor argument. Branch
3 passes the array. Branch 4 passes the string. Branch 5 passes the object the `next`
method came from. `wrapValueIterator` and `wrapEntryIterator` take it as a parameter and
pass it through. Nothing in `iterator.ts` ever reads it.

The only readers are in the collector:

- `src/gc/roots.ts:222` — `if (p.source !== undefined) seedTagged(p.source)`, in the
  mark-reachable worklist.
- `src/gc/roots.ts:296-297` — the same follow, in `collectLiveHeapIds`.
- `src/gc/roots.ts:343` — `extractHeapObject` follows `source` when a payload has no
  `gcHeader`, which is what the scavenger needs, since an `IteratorRecord` is not itself
  GC-allocated and can never be a scavenger root.

Told as engineering:

**Symptom.** This program printed `last: undefined` instead of `last: 999999`:

```
last = 0
for j of range(1000000):
  last = j
print("last:", last)
```

Assigning the array to a named variable first — `arr = range(1000000)` then `for j of arr` —
made it correct. So did adding almost any extra statement to the loop body, which is the
kind of clue that means register allocation is involved and the real cause is elsewhere.

**Mechanism.** Before the fix, `IteratorRecord` held only the `next` closure. That closure
captured the array *in the host language*: the `arr` binding at `iterator.ts:118` is a
JavaScript `const`, and a JavaScript closure is not something `gc/roots.ts` can walk. A
`for … of` over a temporary keeps only the *iterator* in a tera register — no tera-visible
value still referenced the array. The first scavenge therefore swept the array's value-heap
slot, and every subsequent `getIndex` read back `undefined`.

**Fix.** `IteratorRecord` gained the explicit `source: TaggedValue` field, set at every
construction site, and `gc/roots.ts` learned to follow it in all three of the places listed
above.

**Regression test.**
`tests/e2e/gc/heap-payload-sweep.test.ts > "an iterable reachable only through its iterator is a collection root" > "keeps a temporary array alive for the whole for-of loop"`.
It needs the default GC configuration and about a million iterations: with a small young
generation an early scavenge runs while the array is still rooted, *promotes* it to the old
generation, and the sweep can never touch it again — so the test passes with or without the
fix.

**The general rule.** *A closure is not a root set.* Any value that must survive a
collection has to be reachable from a field the root walk enumerates, and "the host
language is holding it" is not that. The identical shape appears in
[Ch 32 § case-the-suspended-frame], where a suspended coroutine frame was in no root set at all.

> Naming note, per [Conventions § 4]: `IteratorRecord.source` is not the iterator's source
> *code*, and no iteration logic ever reads it. It is a GC root anchor with a misleading
> name. The book keeps the name.

## Generators: next, return, throw

A generator object is not an iterator record; it is a suspended `RegisterFrame` plus a
state, reached by name. `generatorMemberValue`
(`src/bytecode/register/interpreter/generator-members.ts:33-92`) answers exactly three
property names and `mkUndefined()` for everything else. It is reached through the
structural probe `asGeneratorMemberInterpreter` (`:22-31`) that [Ch 25 § the-coroutine-exception]
already met — the member lookup does not know it has an interpreter, it checks for a
`runFrame` function and a `suspendedFrames` map.

**`next`** (`:39-53`). If the state is `GEN_COMPLETED`, answer `{value: undefined, done:
true}` forever. If it is `GEN_NEWBORN` or `GEN_SUSPENDED`, resume the frame. The sent value
arrives by assignment: `if (args.length > 0 && !wasNewborn) gen.frame.acc = args[0]`. The
frame was suspended at a `ROP_YIELD` whose next action is to read the accumulator, so
"passing a value into a suspended coroutine" is a field write
[t: tests/e2e/language/async-generator.test.ts > "runs generator yield and iterator next"].

**`return`** (`:54-65`). Completes the generator and fabricates a result object from the
argument. The frame is not resumed; nothing in the generator body runs, including any
`finally` it was suspended inside.

**`throw`** (`:66-88`) is the interesting one, because it reaches *into a frame that is not
running*.

```ts
        if (
          gen.frame.exceptionHandlers &&
          gen.frame.exceptionHandlers.length > 0
        ) {
          const handler = gen.frame.exceptionHandlers.pop() as { catchPC: number };
          gen.frame.acc = error;
          gen.frame.pc = handler.catchPC;
          return runGeneratorFrame(interp, gen);
        }
```
— src/bytecode/register/interpreter/generator-members.ts:75-83

Five lines. Pop the *suspended frame's own* handler stack, put the thrown value in that
frame's accumulator, point that frame's program counter at the catch target, and resume.
The generator wakes up inside its own `catch` clause with the value bound.

This is the payoff for keeping the handler stack **in the frame**. Under a static handler
table the operation would be: find the table for the generator's function, binary-search it
for a region containing the suspended `pc`, resolve the target, and — crucially — decide
what to do about intervening `finally` regions, all from outside the frame. Under the
dynamic stack the frame is carrying its own answer, and a caller that is not the frame can
read it. The same trick appears a third time: `resumeAfterSuspend`
(`src/bytecode/register/interpreter/helpers.ts:156-187`) does exactly this when an awaited
promise rejects — pops the suspended async frame's handler, sets `acc`, sets `pc`, resumes;
and if there is no handler, rejects the outer capability instead. Three readers of one
field, only one of which is the opcode that wrote it.

> **Unenforced.** The `throw` branch pops the top handler without checking that its
> `catchPC` belongs to a region that actually contains the suspension point. A generator
> suspended *outside* any `try` but whose frame still carries a handler from a region a
> `break` left unbalanced — see
> [§ non-local-exits-pay-too](#non-local-exits-pay-too--except-when-they-do-not) — resumes
> at a catch target it never entered. `[unpinned]`: no test in `tests/` throws into a
> suspended generator at all. Cost to enforce: store `endPC` alongside `catchPC` — the
> field already exists in `ExceptionHandlerRecord` and is never written — and range-check
> before popping.

## The verdict, and the five gates

`requiresInterpreterOnly` is consulted in exactly five places, and they are the five
doorways out of tier zero:

| Where | What it gates |
| --- | --- |
| `src/bytecode/register/interpreter/index.ts:503` | JIT, on the call-count path |
| `src/bytecode/register/interpreter/index.ts:515` | baseline, on the call-count path |
| `src/bytecode/register/interpreter/index.ts:975` | JIT, on the loop-budget path |
| `src/bytecode/register/interpreter/index.ts:1011` | baseline, on the loop-budget path |
| `src/runtime/tiering/osr.ts:41` | on-stack replacement ([Ch 37 § enterosr-in-full]) |

Three observations follow from that table.

**The answer is recomputed every time.** `requiresInterpreterOnly` is a linear scan over
`compiledFn.instructions` with a `Set` membership test per instruction. Nothing caches it.
`RegisterCompiledFunction` carries no flag for it, and no gate memoizes the result.

> **Unfinished.** `requiresInterpreterOnly`
> (`src/bytecode/register/interpreter/helpers.ts:82-89`) rescans the entire instruction
> array at each of its five call sites, on every tiering decision, for the life of the
> process. The instruction array is immutable after bytecode compilation, so the answer
> cannot change. This is not measured ([Conventions § 9]) and the fix is not obviously
> worth doing — but it is unconditional work with a known-constant result, and the cheapest
> version is one nullable boolean field on `RegisterCompiledFunction`.

**"For the life of the process" is a property of the bytecode, not a flag.** Nobody sets a
"do not optimize" bit. There is no state to reset and nothing to invalidate. The function's
instruction stream is the record, and it never changes, so the answer is stable by
construction — which is a genuinely good property, and the reason the recomputation is
harmless rather than a correctness risk.

**Nothing derives the set from the tiers' actual capabilities.** This is the important one.

> **Unenforced.** `INTERPRETER_ONLY_OPS` is a hand-maintained `Set` literal, and nothing
> keeps it in step with what the baseline and the JIT can actually emit. A baseline that
> learned to compile `ROP_TRY_START` would still be refused; an opcode added to the
> baseline's blind spot but not to this set would still be attempted and would fail
> downstream. `tests/bytecode/register/interpreter/helpers.test.ts` *samples* the set — it
> asserts that three named opcodes return `true` and that a plain function returns `false`
> — it does not derive it from anything. The duplication is already visible:
> `src/optimizing/baseline/compiler.ts:61-69` re-checks `ROP_TRY_START`, `ROP_TRY_END` and
> `ROP_THROW` on its own, after `requiresInterpreterOnly` has already excluded them, and
> `:70-79` lists five more opcodes the baseline declines that are *not* in
> `INTERPRETER_ONLY_OPS` at all — four spread/rest/accessor opcodes plus
> `ROP_ASSERT_CLASS_CONTRACTS`, which appears in both lists ([Ch 36 § the-five-refusals]).
> Cost to enforce: derive both lists from one table of per-opcode tier support, which means
> a per-opcode capability record the tree does not have.

There is also nothing that tests the gate end to end.

> **Unenforced.** No test asserts that a function containing one of the twelve opcodes
> fails to *reach* baseline, the JIT or OSR. The set is tested at the predicate, never at
> the gate. `[unpinned]` — the closest observable is `--trace-opt`, which prints a full
> compilation trace and `[JIT] OSR "hot" at loop offset 4` for a plain numeric loop and
> prints nothing at all when the identical loop body is wrapped in a `try`
> ([§ verify-it-yourself](#verify-it-yourself)).

## What was tried and rejected — or rather, never needed

There is an asymmetry in the language that saves the set from being much worse than it is,
and it was not designed as a mitigation.

`for x of y` lowers to four interpreter-only opcodes. `for x in y` lowers to none.
`compileForInStatement` (`src/bytecode/register/compiler/functions.ts:1238-1333`) emits
`ROP_GET_KEYS` into a synthetic local `_keys$`, `ROP_GET_LENGTH` into `_len$`, a constant
zero into `_i$`, and then an entirely ordinary counted loop: `ROP_LT`, `ROP_JUMP_IF_FALSE`,
`ROP_LDA_INDEX` to read `_keys$[_i$]`, the body, `ROP_ADD` to increment, `ROP_JUMP` back.
Every one of those is an opcode the baseline and the JIT already handle. A function that
only ever enumerates with `for … in` stays fully optimizable
[t: tests/e2e/language/control-flow.test.ts > "enumerates array indices"].

The reason is not a policy about iteration. It is that `for … in` enumerates *keys* — which
`ROP_GET_KEYS` can materialize eagerly into an array — while `for … of` enumerates *values*
lazily through a protocol that may call user code, resume a coroutine, or advance a host
`Iterator`. Eager materialization is expressible in ordinary opcodes; lazy user-driven
advance is not.

The practical consequence for the running example is a coincidence, and it should be named
as one. `Series.mean` in `docs/example/stats.tera` walks its array with a counted `while`
loop and an index, in the style the whole spine is written in. Had it been written
`for v of self.values:` — which is the more natural spelling, and the one a reader would
reach for — `mean` would contain `ROP_GET_ITERATOR`, `ROP_ITER_NEXT`, `ROP_ITER_DONE` and
`ROP_ITER_VALUE`, would be pinned to tier zero, and Parts V through VIII of this book would
have had nothing to follow. Nothing enforces that style, nothing warns about it, and no
diagnostic anywhere tells a programmer that a loop shape just cost them three tiers.

## What it would cost to shrink the set

Twelve entries, four distinct amounts of work.

**`ROP_LDA_KEYED_SLICE` — the cheapest, by a wide margin.** Its handler is twenty-three
lines (`src/bytecode/register/interpreter/handlers.ts:436-458`): read the receiver register,
read a token array out of the constant pool, decode each token into an `IndexDim`, and call
`indexValue(obj, dims)` from `src/runtime/indexing.ts`. Nothing in it is
interpreter-specific except `frame.getReg` and `compiledFn.constants`, both of which the
baseline runtime already provides. The baseline calls `memberLookupValue` for property
access through `src/optimizing/baseline/runtime.ts:338` ([Ch 28 § builtins-are-three-kinds-in-one-union]); it could call
`indexValue` the same way. This is a small, self-contained piece of work, and it would
un-pin every function that slices.

**`ROP_TRY_START` / `ROP_TRY_END` / `ROP_THROW` — needs a design decision.** The baseline
emits JavaScript source and runs it through `new Function`
(`src/optimizing/baseline/compiler.ts:86`), and JavaScript has `try`/`catch`/`throw`. The
baseline could plausibly emit a real JavaScript `try` and let the host do the unwinding —
but then a tera `catch` would be catching host exceptions in a frame the interpreter's
three-shape analysis never sees, and the two would have to be reconciled. The JIT is
harder: WebAssembly's exception-handling proposal is a different model again, and
`recordWasmDeopt` ([Ch 54 § deoptimizing]) already owns the "leave wasm abruptly" path. The
static handler table [§ unwinding-and-two-designs-for-it](#unwinding-and-two-designs-for-it)
staged is what all three tiers would need to share.

**The four iterator opcodes — needs `IteratorRecord` reachable from generated code.**
`GET_ITERATOR`, `ITER_NEXT`, `ITER_DONE`, `ITER_VALUE` all traffic in a host-language object
holding a host-language closure. Baseline JavaScript could hold one directly. The JIT could
not: a wasm module addresses linear memory, and a closure is not addressable ([Ch 53 §
the-boundary-is-the-wall] is the general form of this problem). The JIT's version would have
to call back out to `executeRuntimeCall` on every element, which is the boundary crossing
that chapter measures.

**`ROP_AWAIT` and `ROP_YIELD` — need a suspendable frame in a tier that has none.** The
interpreter suspends by keeping the `RegisterFrame` object alive and later writing its `acc`
and `pc`. Baseline-compiled JavaScript has no such object — its locals are JavaScript
locals in a `new Function` body — and neither does a wasm module. The AOT compiler solved
exactly this for its own road, and solved it thoroughly: [Ch 58 § what-a-suspend-costs]
splits an `async fn` into an explicit frame class plus a `$step` function driven by a state
dispatch ladder, and [Ch 58 § generators-are-the-simpler-sibling] does the same for `fn*`.
[Ch 63 § the-waiter-chain] runs the resulting frames on a real event loop. None of that work
came back to the JIT. The two roads share a middle end ([Ch 41 § the-pass-manager]); they do
not share a coroutine lowering, and the AOT one runs *before* SSA construction, on a
representation the JIT's front end never builds.

**`ROP_LOAD_ARGUMENTS` and `ROP_ASSERT_CLASS_CONTRACTS` — the leftovers.**
`ROP_LOAD_ARGUMENTS` (`index.ts:2065-2073`) materializes `frame.originalArgs` into a fresh
tera array; it needs the tier to have kept the original argument vector, which the baseline
has (`args`) and wasm does not. `ROP_ASSERT_CLASS_CONTRACTS` (`index.ts:2004`) is declined
by the baseline *twice* — once here and once in its own list — and needs the contract
machinery of [Ch 26 § classes-at-run-time-are-four-fields-and-a-name] to exist outside the interpreter.

## What leaves

The **tier verdict**: for every `RegisterCompiledFunction` in the program, one boolean,
recomputed on demand by scanning the instruction stream, that decides whether the function
may ever leave the interpreter. This is the third of the three artifacts this part's opener
promised, alongside the answer and the feedback. It is consulted at five gates and cached
nowhere, and it is stable because the thing it reads never changes.

Alongside it, the two protocols every later tier must either implement or refuse: the
**exception protocol** — a per-frame handler stack, three thrown shapes collapsing into one
accumulator value, a `finally` lowered as two overlapping regions and two copies, and a
`break` that does not balance the stack — and the **iterator protocol** — an
`IteratorRecord` carrying a value and a closure, produced by a five-branch dispatch and
consumed by four opcodes.

Chapter 28 receives the verdict and asks a question this chapter deliberately left alone:
when the interpreter reaches a `Call` or `CallMethod` whose callee is *not* a
`RegisterCompiledFunction` — a builtin, a host function, a namespace member — what does it
actually reach? The answer matters here because no builtin is in `INTERPRETER_ONLY_OPS`: a
call to `to_fixed` or `to_upper_case` cannot pin its caller to tier zero, which is why
`stats.tera` stays optimizable despite calling both. [Ch 28 § what-the-program-calls-one-shape-for-everything-callable] takes
it from there, and finds that one implementation of each builtin serves three tiers while
the fourth mirrors it by name only.

## Verify it yourself

```bash
# the set, and the count: twelve entries plus isAsync
grep -n "INTERPRETER_ONLY_OPS" -A 14 src/bytecode/register/interpreter/helpers.ts
```

```
67:export const INTERPRETER_ONLY_OPS: Set<number> = new Set([
68-  bytecode.ROP_AWAIT,
...
79-  bytecode.ROP_ASSERT_CLASS_CONTRACTS,
80-]);
```

```bash
# labeled.tera's two for-of loops, eight interpreter-only opcodes
node dist/cli.js --print-bytecode docs/example/labeled.tera | grep -nE "GetIterator|Iter"
```

```
42:    27  GetIterator
45:    30  IterNext
48:    33  IterDone
51:    36  IterValue
54:    39  GetIterator
57:    42  IterNext
60:    45  IterDone
63:    48  IterValue
```

```bash
# stats-async.tera's mean_of is pinned twice: by isAsync and by this
node dist/cli.js --print-bytecode --filter mean_of docs/example/stats-async.tera | grep Await
```

```
     5  Await
```

```bash
# finally: two TryStarts, and the finalizer body emitted twice
printf 'fn f(n: int) -> int:\n  try:\n    n = n + 1\n  finally:\n    n = n + 10\n  return n\nprint(f(1))\n' > /tmp/fin2.tera
node dist/cli.js --print-bytecode --filter f /tmp/fin2.tera
```

Prints 33 instructions: `TryStart` at 0 and 1, the try body at 2-8, `TryEnd` at 9, a bare
`Throw` at 11 (the no-catch-clause rethrow), the finalizer at 13-19 on the normal path and
again at 22-28 on the exceptional path, and `Star r3` / `Ldar r3` / `Throw` at 21, 29 and 30
stashing and re-raising the in-flight exception. Then `12`.

```bash
# the tiering cost, categorically: the same loop with and without a try
printf 'fn hot(n: int) -> int:\n  total = 0\n  i = 0\n  while i < n:\n    total = total + i\n    i = i + 1\n  return total\nprint(hot(200000))\n' > /tmp/hot.tera
printf 'fn hot(n: int) -> int:\n  total = 0\n  i = 0\n  while i < n:\n    try:\n      total = total + i\n    catch e:\n      total = total\n    i = i + 1\n  return total\nprint(hot(200000))\n' > /tmp/hot-try.tera
node dist/cli.js --trace-opt /tmp/hot.tera
node dist/cli.js --trace-opt /tmp/hot-try.tera
```

The first prints a full compilation trace ending in
`[JIT] OSR "hot" at loop offset 4`, then `-1474936480`. The second prints `-1474936480` and
nothing else — no `[JIT]` line at all. Both answer the same number; only one of them was
ever compiled. (The value is negative because a declared `int` wraps at 32 bits in every
tier — [Ch 48 § declared-int-wraps-everywhere].) The *speed* difference is deliberately not
reported here: it would have to be re-measured one case per fresh process
([Conventions § 9]), and OSR's provenance belongs to [Ch 37 § enterosr-in-full].

```bash
# the break bug: a handler that outlives its region
printf 'fn f() -> int:\n  i = 0\n  while i < 3:\n    try:\n      if i == 1:\n        break\n      i = i + 1\n    catch e:\n      print("caught by the loop's handler")\n      return 99\n  print("out of the loop")\n  throw "boom"\n  return i\nprint(f())\n' > /tmp/stale.tera
node dist/cli.js /tmp/stale.tera
```

```
out of the loop
caught by the loop's handler
99
```

```bash
npx vitest run --project unit tests/bytecode/register/interpreter/helpers.test.ts tests/runtime/iteration/iterator.test.ts
```

```
 Test Files  2 passed (2)
      Tests  18 passed (18)
```

`docs/example/labeled.tera` is safe to run: its labelled `continue` used to loop forever and
no longer does ([`docs/example/README.md` § labeled-tera-and-the-jump-nobody-patched],
[Ch 19 § the-fix]).

## Tests that pin this

- `tests/bytecode/register/interpreter/helpers.test.ts` > `"requiresInterpreterOnly"` >
  `"returns true for async functions"`, `"returns true when instructions contain
  interpreter-only ops (await, yield, iterators)"`, `"returns true when instructions contain
  exception-handling ops (try/throw)"`, `"returns false for normal sync functions without
  special ops"` — the predicate, sampled at four points.
- `tests/bytecode/register/interpreter/helpers.test.ts` > `"errorToTaggedValue"` >
  `"unwraps RegisterException to its inner value"`, `"converts plain Error to tagged string
  with message"` — the two thrown shapes that have a unit-level home.
- `tests/bytecode/register/interpreter.test.ts` > `"helpers"` > `"requiresInterpreterOnly"` >
  `"returns true for function with await"`, `"returns true for iterator ops"`, `"returns
  false for plain function"` — the same predicate, a second time, in a second file.
- `tests/bytecode/register/interpreter.test.ts` > `"RegisterInterpreter"` > `"runFrame -
  exception handling"` > `"THROW without handler propagates"`, `"TRY_START/TRY_END catches
  exception"` — the handler stack at the opcode level, on hand-built instruction arrays.
- `tests/runtime/iteration/iterator.test.ts` > `"getIterator"` > `"iterates array elements
  in order"`, `"array iterator handles empty array"`, `"iterates string characters"`,
  `"string iterator handles empty string"`, `"throws for non-iterable value"`, `"array
  iterator yields undefined for holes"`, `"iterator is single-pass (not restartable)"` —
  branches 3, 4 and the final throw.
- `tests/runtime/iteration/iterator.test.ts` > `"IteratorRecord"` > `"custom next function
  drives iteration"`; > `"createIteratorResult"` > `"produces object with value and done
  fields"`, `"done=true signals completion"`; > `"iteratorDone"` > `"returns true for
  non-object values"`; > `"iteratorValue"` > `"returns undefined for non-object values"` —
  the contract, and its two answers for a malformed result.
- `tests/e2e/language/control-flow.test.ts` > `"catches thrown values and always runs
  finally"` — `finally` on the normal and exceptional paths, from source. Its `try` is at
  script top level with no loop, so it does not reach the `break` defect.
- `tests/e2e/language/control-flow.test.ts` > `"surfaces an uncaught thrown value with a
  readable message, not [object Object]"` — the host-`Error` reshaping observed from
  outside: `throw "kaboom"`, `throw 42`, `throw Error("db down")` and a user class with
  `name` and `message` all produce readable text.
- `tests/e2e/language/control-flow.test.ts` > `"iterates user-defined objects with
  @@iterator and prototype next"` — `getIterator`'s fifth branch, using the string-named
  spelling.
- `tests/e2e/language/control-flow.test.ts` > `"for-in enumeration"` > `"enumerates array
  indices"`, `"still yields values with for-of"` — the two lowerings side by side.
- `tests/e2e/language/async-generator.test.ts` > `"Tera async and generators"` > `"runs
  generator yield and iterator next"`, `"bridges async function results to native values"` —
  `generatorMemberValue`'s `next` branch, and `isAsync` end to end.
- `tests/e2e/gc/heap-payload-sweep.test.ts` > `"an iterable reachable only through its
  iterator is a collection root"` > `"keeps a temporary array alive for the whole for-of
  loop"` — the `IteratorRecord.source` regression.
- Not pinned, and named as such: no test asserts that a function containing one of the
  twelve opcodes fails to reach baseline, the JIT or OSR *end to end* — the set is tested at
  the predicate, not at the gate. `[unpinned]`
- Not pinned: no test covers a `break` or `continue` leaving a `try` region, in either its
  skipped-finalizer form or its stale-handler form. `[unpinned]`
- Not pinned: no test throws into a suspended generator, so `generatorMemberValue`'s `throw`
  branch is uncovered. `[unpinned]`
