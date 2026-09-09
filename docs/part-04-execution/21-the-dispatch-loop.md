# 21. The dispatch loop   ⟨I⟩

Everything before this chapter was preparation. A lexer turned columns into `Indent` and
`Dedent`, a parser turned tokens into a tree, a checker turned the tree into type facts, and
a bytecode compiler turned all of it into a flat array of instructions with integer
operands. Nothing has run. This chapter is where a number is finally produced, and the
machine that produces it is smaller than anything upstream of it: one method, `runFrame`, a
`while` over an integer, and a `switch` with eighty-nine cases.

The thesis is that the loop is uninteresting on purpose and interesting in exactly two
places. It is uninteresting because it does the obvious thing — read the instruction at
`frame.pc`, increment `frame.pc`, switch on the opcode, `break` to fall through to the next
instruction or `continue` to take a jump. It is interesting, first, because there is a
`try` around *every single instruction*, which is how a language-level `throw` becomes a
host-language `throw` and back again without the loop ever knowing which opcodes can raise;
and second, because two boolean fields on the frame — `hasUpvalues` and `hasTDZ` — exist for
no reason except to let a register read be a bare array index. Those two booleans are the
whole performance story of tier zero, and one of them is also the reason the baseline
compiler in [Ch 36] is allowed to emit `r[3]` instead of a function call.

Tier zero is also the only tier that is always correct. It never speculates, so it never
deoptimizes; it has no representation choices to get wrong. Everything the other three
machines do is measured against what this loop answers, which is why [Ch 79 § differential]
can treat it as an oracle rather than as one implementation among four.

**What arrived.** From [Ch 20 § what-leaves]: a finished `RegisterCompiledFunction` per
function. It carries `instructions` (an array of `{opcode, operands}` records with all jump
targets already resolved to absolute indices), a `constants` pool, `registerCount`,
`paramCount`, `localNames`, `localBindingKinds`, `uninitializedLocalSlots` (the temporal
dead zone set), `upvalues`, `hoistedVarNames`, `classBindingSlots`, `selfBindingSlot`, and a
`feedbackVector` field that is still `null`. Nested inside the constant pool is one more
`RegisterCompiledFunction` per inner function, per class method and per static-field
initializer. `node dist/cli.js --print-bytecode` prints it. This chapter takes that object,
wraps it in a `RegisterFrame`, and executes it.

## The dispatch loop: `runFrame` in fifteen lines

> **New idea.** *Program counter, dispatch, frame.* A **program counter** (pc) is an index
> into the instruction array saying which instruction runs next. **Dispatch** is the act of
> choosing the code that implements the instruction the pc points at — here, a `switch` on
> an integer opcode. A **frame** is the per-call scratch space an executing function owns:
> its registers, its accumulator, its `this`, its pc. One `RegisterCompiledFunction` is
> shared by every call to that function; one `RegisterFrame` belongs to exactly one call.
> Recursion works because each call gets its own frame over the same compiled function.

The whole loop fits on a screen. The prologue is five lines:

```typescript
  runFrame(frame: RegisterFrame): TaggedValue {
    const { compiledFn } = frame;
    const instructions = compiledFn.instructions;
    const funcName = compiledFn.name || "<anonymous>";
    let loopCounter = 0;

    this.callStack.push(funcName);
    this.activeFrames.push(frame);

    try {
      while (frame.pc < instructions.length) {
        try {
```
— `src/bytecode/register/interpreter/index.ts:1386-1397`

Two stacks are pushed, not one. `callStack` is an array of strings and `activeFrames` is an
array of frames; they are pushed together and popped together in the same `finally`, and
they exist for different consumers. The instruction array is hoisted into a local because
the loop reads it on every iteration.

Then the body, in outline: read `instructions[frame.pc]`, pull out `opcode` and `operands`,
emit a trace line if tracing is on, **increment `frame.pc`**, and switch. The increment
comes *before* the switch, which is the single most load-bearing ordering decision in the
file. Because the pc has already advanced, an opcode that wants to fall through to the next
instruction does nothing at all — it just `break`s out of the switch and the `while`
condition re-tests against the already-advanced pc. An opcode that wants to jump assigns
`frame.pc = target` and `continue`s, skipping the rest of the iteration; because the
increment happened before the switch and the `continue` skips nothing that would undo it,
the assignment is final. Jump targets are therefore **absolute instruction indices**, never
relative offsets, which is exactly the representation [Ch 19] delivered.

The pre-increment also means the currently-executing instruction is at `frame.pc - 1`, and
every error message in the loop that wants to name a location has to say so explicitly.
The `default:` case does; the tracer, which runs before the increment, does not need to.

The epilogue is the other half of the invariant:

```typescript
      frame.closeUpvalues();
      return mkUndefined();
    } finally {
      if (
        this.tieringPolicy &&
        typeof this.tieringPolicy.recordLoopIterations === "function"
      ) {
        this.tieringPolicy.recordLoopIterations(compiledFn, loopCounter);
      }
      this.callStack.pop();
      this.activeFrames.pop();
    }
```
— `src/bytecode/register/interpreter/index.ts:2508-2519`

Falling off the end of the instruction array is an implicit `return undefined`, and it
closes upvalues first — the frame is about to become unreachable, so any cell still pointing
into its register array has to copy the value out ([Ch 20 § open-cells-alias-the-frame]). The `finally` runs
on *every* exit: normal return, `ROP_RETURN`, an escaping exception, or an on-stack
replacement jump into compiled code. That is why `loopCounter` is reported there rather than
at the return sites — there are too many return sites to trust.

> `tests/bytecode/register/interpreter.test.ts > "implicit return"` builds a function whose
> only instruction is `LdaConst` and asserts the result is `undefined`, pinning the
> fall-off-the-end path.

## The frame is thirteen fields

`RegisterFrame` lives in `src/bytecode/register/interpreter/frame.ts`, which is 141 lines
long — the smallest file in this part and the most quoted. Thirteen instance fields, one
getter, four methods. The constructor is where the compiled function's static description
becomes a running function's mutable state:

```typescript
    this.compiledFn = compiledFn;
    this.pc = 0;
    this.acc = CODE_UNDEFINED;
    this.suspendable = compiledFn.isAsync || compiledFn.isGenerator;
    const regCount = compiledFn.registerCount;
    this.registers = new Array<RegisterValue>(regCount).fill(CODE_UNDEFINED);
    this.hasTDZ = compiledFn.uninitializedLocalSlots?.size > 0;
    if (this.hasTDZ) {
      for (const slot of compiledFn.uninitializedLocalSlots) {
        this.registers[slot] = TDZ_UNINITIALIZED;
      }
    }
```
— `src/bytecode/register/interpreter/frame.ts:57-68`

`registers` is a plain JavaScript array filled with `CODE_UNDEFINED`, which is not a
sentinel object but a small integer — the tagged value for `undefined`, opened in
[Ch 22 § four-bits-inside-a-double]. `acc` is the accumulator.

> **New idea.** *Accumulator.* tera's bytecode is a register machine, but not a pure one:
> almost every instruction has one implicit operand, a distinguished register called the
> **accumulator**, which is where the previous instruction left its result. `Add r2 r6`
> means "add register 2 to the accumulator, leave the sum in the accumulator". This is why
> the disassembly of `mean` is full of `Ldar`/`Star` pairs — `Ldar r1` loads register 1 into
> the accumulator, `Star r0` stores the accumulator into register 0. [Ch 18] explains why
> the compiler emits them in that shape; here the accumulator is just `frame.acc`, one more
> field.

Then the rest of the constructor:

```typescript
    this.thisValue = thisValue || CODE_UNDEFINED;
    this.closureEnv = closureEnv || null;
    this.openUpvalues = null;
    this.hasUpvalues = false;
    this.originalArgs = args;
    this.exceptionHandlers = null;
    this.locals = this.registers;

    for (let i = 0; i < args.length && i < compiledFn.paramCount; i++) {
      this.registers[i] = args[i];
    }
```
— `src/bytecode/register/interpreter/frame.ts:69-79`

Three facts fall out of those eleven lines.

**Parameters are just registers.** There is no separate argument area. Argument `i` becomes
register `i`, for `i` below `paramCount`, copied in an ordinary loop
[t: `tests/bytecode/register/interpreter.test.ts > "sets params from args"`]. A parameter is
therefore indistinguishable from a local after instruction zero, which is why the optimizing
tier's frame states in [Ch 53] can describe both with one array.

**Surplus arguments are dropped, not collected.** The loop's second bound is
`compiledFn.paramCount`, so calling a one-parameter function with two arguments discards the
second — it is not reachable, not stored, and not an error
[t: `tests/bytecode/register/interpreter.test.ts > "limits param count to fn.paramCount"`].
A function that wants them asks for `arguments`, which compiles to `ROP_LOAD_ARGUMENTS` and
reads `originalArgs`, the untruncated array kept alongside. That opcode is in
`INTERPRETER_ONLY_OPS`, so asking for `arguments` pins the function to tier zero forever
([Ch 27]).

**`locals` is an alias, not a copy.** `this.locals = this.registers` makes the two names
refer to the same array. Nothing reads `frame.locals` inside the interpreter, but the
deoptimizer writes through it: `src/deopt/frame-materializer.ts:410-419` walks
`frame.locals[i]` filling in values recovered from a frame state, and because it is an
alias, those writes land in `registers` where `getReg` will find them. The alias exists so
the deopt path can talk about "locals" without owning the register array.

`exceptionHandlers` starts `null` and stays `null` for any function containing no `try`,
which matters because the per-instruction `catch` checks it first. `suspendable` records
whether this frame can be parked and resumed ([Ch 30]).

## `getReg` is three implementations wearing one signature

Reading a register is the most frequent operation in the engine. It is also, in principle,
three different operations, because a local can have been captured by a closure (in which
case the authoritative copy lives in a heap cell, not in the array) or can be in its
temporal dead zone (in which case reading it is an error, not a value).

> **New idea.** *Upvalue cell.* When an inner function captures an outer function's local,
> the two must share one storage location — assigning in either place has to be visible in
> the other. The interpreter's answer is a **cell**: a one-slot heap object that the
> register array's slot is *replaced by* as far as reads and writes are concerned. While the
> outer frame is alive the cell reads through to the register (an *open* upvalue); when the
> frame dies, `closeUpvalues` copies the value into the cell (a *closed* upvalue). [Ch 20 §
> upvalues] built them; here they are only a branch.

> **New idea.** *Temporal dead zone.* A binding that is declared but not yet initialized
> exists — its slot is allocated, its name resolves — but reading it is an error rather than
> `undefined`. tera marks such slots with a distinct sentinel object, `TDZ_UNINITIALIZED`,
> rather than with a parallel flag array, so the check is a reference comparison against a
> value no program can produce.

All three cases wear one signature:

```typescript
  getReg(idx: number): TaggedValue {
    if (this.hasUpvalues && this.openUpvalues?.has(idx)) {
      return throwIfTDZ(
        this.openUpvalues.get(idx)!.get(),
        this.compiledFn.localNames[idx],
      ) as TaggedValue;
    }
    const val = this.registers[idx];
    if (this.hasTDZ && val === TDZ_UNINITIALIZED) {
      throw new VMReferenceError(
        `Cannot access '${this.compiledFn.localNames[idx] || "<binding>"}' before initialization`,
      );
    }
    return (val === undefined ? CODE_UNDEFINED : val) as TaggedValue;
  }
```
— `src/bytecode/register/interpreter/frame.ts:87-101`

The order is the design. Both `hasUpvalues` and `hasTDZ` are plain booleans read before the
expensive test that follows them, and both are `false` for almost every function in a
typical program. `hasUpvalues` starts `false` and is only ever set by
`getOrCreateUpvalueCell` — that is, at the moment a closure is actually built, not when the
compiler notices one might be. `hasTDZ` is set once in the constructor from
`uninitializedLocalSlots.size > 0`, and that set is populated only for bindings whose kind
is `let`, `const` or `class` (`src/bytecode/register/ops/bytecode.ts:554-557`). Implicit
bindings — `total = 0.0` and `i = 0` in `Series.mean` — are declared `var` by
`_declareImplicitLocals` (`src/bytecode/register/compiler/scope.ts:380-389`), so they carry
no TDZ and `mean`'s frame has `hasTDZ === false`.

So the common path through `getReg` is: one boolean test that fails, one array index, one
boolean test that fails, one comparison against `undefined`, return. No map lookup, no
allocation, no call. The two booleans buy exactly that.

The final `val === undefined ? CODE_UNDEFINED : val` guard is for reads of registers past
the ones the compiler allocated — a hole in the array reads as host `undefined`, which is
*not* a tagged value, and handing it onward would break every downstream tag test. It is
converted at the boundary instead.

The error message is worth quoting because it is the specification of the TDZ:

```
Cannot access 'myVar' before initialization
```

[t: `tests/bytecode/register/interpreter.test.ts > "TDZ uninitialized slots throw on read"`]
pins the throw, [t: `> "TDZ slot becomes readable after setReg"`] pins that a single write
clears it — `setReg` does not test the sentinel, it just overwrites — and
[t: `> "throwIfTDZ throws on TDZ sentinel"`] with
[t: `> "throwIfTDZ passes through normal values"`] pins the helper the upvalue branch uses.

`setReg` is the same shape minus the TDZ check: if the slot has a cell, write the cell,
otherwise write the array
[t: `tests/bytecode/register/interpreter.test.ts > "setReg and getReg"`].

## `directRegisters`, the invariant the compiled tiers rely on

There is a getter on the frame that states, in four lines, the condition under which the
register array *is* the whole truth about the function's locals:

```typescript
  get directRegisters(): RegisterValue[] | null {
    if (!this.hasUpvalues && !this.hasTDZ) return this.registers;
    return null;
  }
```
— `src/bytecode/register/interpreter/frame.ts:82-85`

This is the invariant the baseline compiler is built on. `BaselineCompiler.generateBody`
emits straight-line JavaScript in which a tera register is a slot of a JavaScript array
named `r`, and it decides once, per function, whether that array can be indexed bare:

```typescript
      case bytecode.ROP_LDA_REG:
        if (hasClosures) {
          return `acc=_ouv.has(${o[0]})?_ouv.get(${o[0]}).get():r[${o[0]}];`;
        }
        return `acc=r[${o[0]}];`;

      case bytecode.ROP_STAR:
        if (hasClosures) {
          return `if(_ouv.has(${o[0]}))_ouv.get(${o[0]}).set(acc);else r[${o[0]}]=acc;`;
        }
        return `r[${o[0]}]=acc;`;
```
— `src/optimizing/baseline/compiler.ts:186-196`

`acc=r[3];` is what tier one exists to produce. The whole of [Ch 36] is about earning that
line, and it is earned by the same condition `directRegisters` names.

Except that it is not the same condition, and nothing checks that it is. `hasClosures` is
computed by scanning the instruction stream for three opcodes:

```typescript
    const hasClosures = instrs.some(
      (i) =>
        i.opcode === bytecode.ROP_MAKE_CLOSURE ||
        i.opcode === bytecode.ROP_LDA_UPVALUE ||
        i.opcode === bytecode.ROP_STA_UPVALUE,
    );
```
— `src/optimizing/baseline/compiler.ts:138-143`

That is a static, conservative approximation of `hasUpvalues`, which is fine — it can only
err towards the guarded form. But it says nothing about `hasTDZ`, and
`grep -rn "TDZ" src/optimizing/baseline/` returns nothing. The baseline compiler has no
concept of a temporal dead zone at all: its prologue fills `r` with `$.u` (undefined) and
its `ROP_LDA_REG` case reads the slot bare. A function whose `let` binding is read before
its initializer runs therefore throws `Cannot access 'x' before initialization` in the
interpreter and answers `undefined` once the same function has been baselined.

> **Unenforced.** The agreement between `RegisterFrame.directRegisters`
> (`src/bytecode/register/interpreter/frame.ts:82-85`) and `BaselineCompiler`'s
> `hasClosures` (`src/optimizing/baseline/compiler.ts:138-143`) is asserted nowhere.
> `directRegisters` requires `!hasUpvalues && !hasTDZ`; the baseline requires only the
> absence of three closure opcodes. Closing it costs one line — route the baseline's
> decision through the getter, or add `uninitializedLocalSlots.size === 0` to `hasClosures`
> and rename it.

> **Never runs.** `RegisterFrame.directRegisters` has no callers. `grep -rn directRegisters
> src/ tests/ tools/ data/` returns exactly one hit: the declaration itself. It documents a
> contract that a second file depends on and that nothing consults. Finishing it means
> either deleting it or making `BaselineCompiler` ask it.

## Fast and slow paths on `ROP_ADD`

`Add r2 r6` appears twice in `mean` — once for `total += this.values[i]` and once for
`i += 1`. One case in the switch serves both, and it has four tiers inside it:

```typescript
            case bytecode.ROP_ADD: {
              const { left, right } = getBinaryOperands(
                frame,
                operands,
                compiledFn,
              );
              if (areBothSmi(left, right)) {
                const result = smiPayload(left) + smiPayload(right);
                frame.acc =
                  result >= SMI_MIN && result <= SMI_MAX
                    ? mkSmi(result)
                    : mkDouble(result);
              } else if (areBothNumber(left, right)) {
                frame.acc = mkDouble(this.toNumberValue(left) + this.toNumberValue(right));
              } else {
                const overloaded = applyBinaryOverload("add", left, right, this);
                if (overloaded !== null) {
                  frame.acc = overloaded;
                  break;
                }
```
— `src/bytecode/register/interpreter/index.ts:1496-1515`

and then the general case:

```typescript
                const lp = this.toPrimitiveValue(left);
                const rp = this.toPrimitiveValue(right);
                if (isString(lp) || isString(rp)) {
                  frame.acc = mkString(toString(lp) + toString(rp));
                } else {
                  frame.acc = mkDouble(toNumber(lp) + toNumber(rp));
                }
              }
              break;
            }
```
— `src/bytecode/register/interpreter/index.ts:1516-1525`

Four paths, tested in decreasing frequency: both operands small integers; both operands
numbers of any kind; a user-defined `add` overload on a class; and finally the general
coercion, which converts both sides to primitives and then decides between string
concatenation and numeric addition by asking whether *either* side is a string. All four are
pinned: [t: `tests/bytecode/register/interpreter.test.ts > "ADD integers"`],
[t: `> "ADD doubles"`], [t: `> "ADD strings"`], [t: `> "ADD string + number coercion"`].

The line to notice is the range re-check. `smiPayload(left) + smiPayload(right)` is host
double arithmetic on two integers, so it cannot overflow silently — but it can leave Smi
range, and a Smi is only thirty-one bits wide. The case therefore tests `result >= SMI_MIN
&& result <= SMI_MAX` explicitly and falls back to `mkDouble`. That re-check is not
defensive tidiness; it is the *proof obligation* that lets `mkSmi` skip checking its
argument at all, and [Ch 22 § mksmi-does-not-check-mknumber-does] shows what `mkSmi` does when handed a
value nobody proved. `ROP_SUB` (`index.ts:1527-1545`) does the same. `ROP_MUL`
(`index.ts:1547-1561`) does not — it calls `mkNumber`, the checked constructor, because a
product of two Smis can exceed the double integer range in a way the two-comparison test
would not catch.

> The test titled `"SUB overflow to double"`
> (`tests/bytecode/register/interpreter.test.ts:404-407`) does not execute `ROP_SUB`. Its
> body runs `ROP_MUL` on `100000 * 100000` and asserts `10000000000`, which exercises
> `mkNumber`, not the `SMI_MIN`/`SMI_MAX` re-check on `ROP_ADD`/`ROP_SUB`. Nothing in
> `tests/` mentions `SMI_MAX`. The Smi range re-check is therefore `[unpinned]`.

## Feedback is recorded in exactly one place

Every one of the arithmetic cases opens by calling `getBinaryOperands`, and that helper does
two jobs. It fetches the operands, and it is the *only* place in the interpreter where
binary-operation feedback is recorded.

```typescript
export function getBinaryOperands(
  frame: BinaryFrameLike,
  operands: RegisterOperand[],
  compiledFn: CompiledFunctionWithFeedback,
): { left: TaggedValue; right: TaggedValue } {
  const left = frame.acc;
  const right = frame.getReg(operands[0] as number);
  const fv = compiledFn.feedbackVector;
  if (fv && !fv.saturated) {
    const slot = fv.getSlot(operands[1] as number);
    if (slot && !slot.isStable) slot.recordBinaryOp(getTag(left), getTag(right));
  }
  return { left, right };
}
```
— `src/bytecode/register/interpreter/helpers.ts:91-104`

The operand order is fixed and asymmetric: the left operand is always the accumulator, the
right is always a register named by `operands[0]`
[t: `tests/bytecode/register/interpreter.test.ts > "reads acc as left and register as right"`].
`operands[1]` is not a register at all — it is a feedback slot index. In the disassembly of
`mean`, `Add r2 r6` means "add register 2 to the accumulator, recording into feedback slot
6", and the second `Add r2 r7` uses a different slot because it is a different site.

Three conditions gate the recording, and each one turns it off permanently once satisfied.
`fv` is `null` until `initFeedbackVector` runs, which happens on the first call through
`interpretCall`. `fv.saturated` goes true when the whole vector has stopped teaching
anything. `slot.isStable` goes true when this particular site has seen enough of the same
thing. So the interpreter pays for feedback only while the answer is still changing; a loop
that has run a million times is recording nothing. [Ch 33] opens the vector and says what
`isStable` means.

The observable is `--trace-feedback`:

```
$ node dist/cli.js --trace-feedback docs/example/stats-poly.tera | head -8
[FB] Slot #0: property — uninitialized → monomorphic
[FB] Slot #0: property — uninitialized → monomorphic
[FB] Slot #0: property — uninitialized → monomorphic
[FB] Slot #0: property — uninitialized → monomorphic
[FB] Slot #0: call — uninitialized → monomorphic
[FB] Slot #0: call — uninitialized → monomorphic
[FB] Slot #0: property — uninitialized → monomorphic
[FB] Slot #0: call — uninitialized → monomorphic
```

Every line says `Slot #0`, including the ones that are not slot zero. That label is wrong,
for a reason told in [Ch 33]; what the flag does prove here is that the transitions happen
at all, and that they are driven from the interpreter's own execution rather than from a
separate analysis pass.

## Why property and index opcodes were lifted into `handlers.ts`

Ten cases in the switch are one-line delegations:

```typescript
            case bytecode.ROP_LDA_PROP: {
              frame.acc = handleLdaProp(
                this,
                frame,
                operands,
                compiledFn,
                funcName,
              );
              break;
            }
```
— `src/bytecode/register/interpreter/index.ts:1454-1463`

`handleLdaProp`, `handleStaProp`, `handleLdaIndex`, `handleStaIndex`,
`handleLdaKeyedSlice`, `handleNew`, `handleDefineAccessor`, `handleInstanceof`, `handleIn`
and `handleDeleteProp` live in `src/bytecode/register/interpreter/handlers.ts`, a 709-line
file. Those ten opcodes are the ones that consult an inline cache, walk a prototype chain,
check an elements kind, or ask a proxy — the ones with real logic. Keeping them inline would
have roughly doubled `runFrame` and buried the loop's shape.

The split bought two things. `runFrame`'s switch stays readable, and the handlers are
callable from somewhere other than the interpreter — which [Ch 24] uses when it walks the
same property-access path from the baseline tier's runtime support.

It cost one thing, and the cost is visible in the file. Because `handlers.ts` must not
import the interpreter (that would be a cycle), it declares a structural type describing the
interpreter's surface:

```typescript
type InterpreterLike = {
  callFunctionValue(
    fn: TaggedValue,
    args: TaggedValue[],
    thisValue: TaggedValue,
  ): TaggedValue;
  constructFunctionValue(fn: TaggedValue, args: TaggedValue[]): TaggedValue;
  execute(
    compiledFn: RegisterCompiledFunction,
    args?: TaggedValue[],
    thisValue?: TaggedValue | null,
  ): TaggedValue;
  runFrame(frame: RegisterFrame): TaggedValue;
  initFeedbackVector(compiledFn: RegisterCompiledFunction): void;
```
— `src/bytecode/register/interpreter/handlers.ts:77-91`

and it continues for another ten lines through `getConstructorStub`,
`_lookupBuiltinPrototype`, `icManager`, `builtinPrototypes`, `microtaskQueue`,
`suspendedFrames` and `exceptionToValue` (`handlers.ts:77-101`). That is a hand-maintained
duplicate of a quarter of `RegisterInterpreter`'s public surface. It is checked structurally
— passing `this` where an `InterpreterLike` is wanted fails to compile if the real class
drifts — so it does not rot silently, but every method added to the interpreter that a
handler needs must be added twice.

## Jumps and the back edge

Three opcodes move the pc. All three do the same three things when the target is behind the
current position:

```typescript
            case bytecode.ROP_JUMP: {
              const target = operands[0];
              if (target < frame.pc) {
                loopCounter++;
                const osr = this.onBackEdge(compiledFn, frame, target, loopCounter);
                if (osr !== null) return osr;
              }
              frame.pc = target;
              continue;
            }
```
— `src/bytecode/register/interpreter/index.ts:1775-1784`

`ROP_JUMP_IF_FALSE` (`index.ts:1786-1798`) and `ROP_JUMP_IF_TRUE`
(`index.ts:1800-1812`) wrap the identical block in a `toBool(frame.acc)` test and `break`
when the branch is not taken
[t: `tests/bytecode/register/interpreter.test.ts > "JUMP unconditional"`,
`> "JUMP_IF_FALSE skips when false"`, `> "JUMP_IF_FALSE falls through when true"`,
`> "JUMP_IF_TRUE jumps when true"`].

> **New idea.** *Back edge.* A jump whose target is *earlier* in the instruction stream is a
> **back edge**: the only way an instruction can execute twice. `target < frame.pc` is the
> whole test, and it is exact, because the pc has already been incremented past the jump
> itself. Every loop in every tera program crosses a back edge once per iteration, and
> nothing else does. That makes it the natural — and here, the only — place to poll for
> anything that has to happen "occasionally but not per instruction".

In `mean`, the back edge is instruction 31, `Jump r4`. (The disassembler prints jump targets
with an `r` prefix; see the note under [§ the-default-case](#the-default-case).) It carries
three unrelated responsibilities at once:

```typescript
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

The first is the value-heap sweep. `_sweepTick` is a 16-bit counter, so
`_maybeSweepHeapPayloads` is *considered* once every 65,536 back edges, and even then it
returns immediately unless the live-byte estimate has passed a growing threshold
(`MIN_HEAP_SWEEP_BYTES = 1 << 18`, growth factor 4 — `index.ts:173-174`). [Ch 31 §
back-edge-sweep] explains what it sweeps and why the boxed-primitive slab needs it.

The second is loop budget. If the function has a feedback vector, the vector is charged the
*size of the loop body* (`frame.pc - target`) rather than one unit, so a long loop reaches
"hot" in fewer iterations than a short one. Without a vector, the fallback is a bare
equality test against `loopOsrThreshold` — equality, not `>=`, so it fires exactly once.

The third is on-stack replacement: when `hot`, `onBackEdge` calls `enterOsr` and, if that
produces a value, `runFrame` returns it immediately, abandoning the interpreted frame
mid-loop. [Ch 37] is the whole story.

`stats.tera` never triggers any of the three. Its inner loop runs five and then four times,
`node dist/cli.js --trace-opt docs/example/stats.tera` emits no `[JIT]` line at all, and
`--stats` reports `"compilations": 0` and `"minorGCCount": 0`. The example reaches the back
edge; it does not reach what the back edge is for. That is not a gap in the example — it is
the reason the interpreter can be the oracle.

## Host recursion: a tera call is a host JS call

> **New idea.** *Host language.* The interpreter is itself a program, written in TypeScript
> and run by Node. The language it is written in is the **host language**; the language it
> executes is the **guest**. Most of the time the distinction is invisible. It becomes
> visible precisely where a guest-level resource is implemented by borrowing a host-level
> one — and tera borrows the host's *call stack* for the guest's call stack.

There is no explicit stack of frames to return into. A tera call builds a frame and calls
`runFrame` on it:

```typescript
function interpretCall(
  compiled: CompiledFunctionLike,
  fn: FunctionPayloadLike,
  callee: TaggedValue,
  args: TaggedValue[],
  thisValue: TaggedValue,
  interpreter: InterpreterLike,
): TaggedValue {
  const closureEnv = fn.closure || null;
  const callFrame = new RegisterFrame(compiled, args, thisValue, closureEnv);
  if (compiled.selfBindingSlot !== undefined) {
    callFrame.setReg(compiled.selfBindingSlot, callee);
  }
  if (!compiled.feedbackVector) interpreter.initFeedbackVector(compiled);
  return interpreter.runFrame(callFrame);
}
```
— `src/bytecode/register/interpreter/index.ts:461-476`

`interpreter.runFrame(callFrame)` is ordinary host recursion. `runFrame` calls
`callFunction` calls `interpretCall` calls `runFrame`. Guest recursion depth is host
recursion depth times a constant, and the constant is greater than one.

`interpretCall` is also where the feedback vector is finally allocated — the `null` that
arrived from Part III becomes a real vector on the first call, and only on the first call.

`callFunction` (`index.ts:529-646`) sits above it and decides *which* machine runs the
callee, using a `callMode` computed once per function:

```typescript
export function updateCallMode(compiled: CompiledFunctionLike): void {
  if (compiled.isGenerator) compiled.callMode = CALL_GENERATOR;
  else if (compiled.isAsync) compiled.callMode = CALL_ASYNC;
  else if (compiled.optimizedCode) compiled.callMode = CALL_OPTIMIZED;
  else if (compiled.baselineCode) compiled.callMode = CALL_BASELINE;
  else compiled.callMode = CALL_INTERPRETED;
}
```
— `src/bytecode/register/interpreter/index.ts:232-238`

Six mode constants are declared (`index.ts:177-182`). Five are assigned here. Three are ever
compared against: `CALL_OPTIMIZED`, `CALL_GENERATOR` and `CALL_ASYNC`
(`index.ts:587, 601, 610`). The baseline and interpreted cases are decided by testing
`compiled.baselineCode` directly rather than by reading the mode that was just computed for
them.

> **Dead.** `CALL_NATIVE` (`src/bytecode/register/interpreter/index.ts:180`). Declared,
> exported, never assigned by `updateCallMode`, never compared anywhere in `src/` or
> `tests/`. There is no path by which `callMode` can hold it. `CALL_BASELINE` and
> `CALL_INTERPRETED` are assigned but never read. Finishing costs one line — delete
> `CALL_NATIVE`, or make `callFunction`'s baseline branch test the mode instead of the
> field.

Now the consequence of borrowing the host stack. Nothing counts guest frames. There is no
depth limit, no `RangeError: Maximum call stack size exceeded` of tera's own, and no
configuration knob. What there is, is the host's limit, reached without warning:

```
$ node dist/cli.js --no-opt /tmp/deeprec.tera
Maximum call stack size exceeded
$ echo $?
1
```

The program was five lines — `fn down(n: int) -> int` returning `1 + down(n - 1)`, called
with a million. The message names no tera function, no bytecode offset, no source line, and
no recursion depth. It is the host's `RangeError.message`, printed by the CLI's top-level
error path with nothing added.

> **Unenforced.** There is no stack-depth guard anywhere on the call path.
> `interpretCall` (`src/bytecode/register/interpreter/index.ts:461-476`) recurses in the
> host language, so guest recursion depth is bounded by the Node process's stack size and
> surfaces as a host `RangeError` carrying no tera context. A counter on
> `RegisterInterpreter` beside `activeFrames.length`, tested in `interpretCall`, would cost
> one comparison per call and would let the message name a function. Nothing in `tests/`
> covers this. `[unpinned]`

## What `callStack` is actually for

Given that message, an obvious question is why `runFrame` bothers to push a function name
onto `this.callStack` on entry and pop it in the `finally`. It looks like error-reporting
machinery. It is not.

`callStack` is declared at `index.ts:651`, initialized at `:670`, pushed at `:1392` and
popped at `:2517`. It is read in exactly one place in the tree:
`src/debugger/runtime.ts:327`, which does `callStack: runtime.callStack.slice()` while
building the snapshot the debugger hands to `tera debug`. Nothing in the exception path
consults it, which is precisely why the `RangeError` above carries no tera frames — the
information exists, in an array, on the interpreter, at the moment the throw happens, and no
code path reads it.

`activeFrames`, pushed and popped alongside it, has a different and much heavier job: it is
part of the root set. [Ch 32 § what-a-frame-exports] is about what that means.

## The `default:` case

```typescript
            default: {
              throw new Error(
                `Unknown register opcode 0x${op.toString(16)} (${bytecode.rOpcodeName(op)}) ` +
                  `at pc=${frame.pc - 1} in "${funcName}"`,
              );
            }
```
— `src/bytecode/register/interpreter/index.ts:2449-2454`

`frame.pc - 1` because of the pre-increment. This is the only place in the loop that has to
undo it, and it is the only place that reports a bytecode offset at all.

The switch is not exhaustively typed. `op` is a `number`, the `ROP_*` constants are
`number`s, and TypeScript has nothing to check against. Adding an opcode to
`src/bytecode/register/ops/bytecode.ts` and forgetting `runFrame` compiles cleanly and fails
at run time, on the first program that reaches the instruction.

That is not hypothetical. There are ninety `ROP_*` constants exported from `bytecode.ts` and
eighty-nine `case` labels in `runFrame`. The missing one is `ROP_TEST_FEEDBACK = 0x55`
(`bytecode.ts:76`). It has a display name in the opcode table (`bytecode.ts:254`), an entry
in the register-effects table (`src/bytecode/register/ops/register-effects.ts:181`), and a
case in the **baseline** compiler that emits the empty string — a no-op
(`src/optimizing/baseline/compiler.ts:384-385`). It has no case in the interpreter, and
nothing in the tree emits it, so the disagreement has never been observed.

> **Dead.** `ROP_TEST_FEEDBACK` (`src/bytecode/register/ops/bytecode.ts:76`). No compiler
> path emits it. `BaselineCompiler.emitOp` treats it as a no-op; `runFrame` would throw
> `Unknown register opcode 0x55 (TestFeedback)` on it. Finishing costs one line: delete the
> constant and its three table entries, or add the interpreter case that makes the two tiers
> agree.

> **Unenforced.** The opcode switch in `runFrame` has no exhaustiveness check, which is how
> the gap above went unnoticed. A `satisfies Record<Opcode, Handler>` dispatch table, or a
> `default` branch whose parameter is typed `never`, would move it from run time to build
> time. The eighty-nine-case switch would have to become a table of functions first, which
> is the cost.

One more wart is visible in every disassembly this chapter has printed, and it belongs here
because it is the same failure of typing at the display layer. `RegisterCompiledFunction.
disassemble` special-cases constant-pool operands and property-name operands, and prints
everything else as a register:

```typescript
        } else {
          parts.push(`r${op}`);
        }
```
— `src/bytecode/register/ops/bytecode.ts:648-650`

So `JumpIfFalse r32 r3` is a jump to instruction **32** recording into feedback slot **3**,
`Jump r4` is a jump to instruction **4**, and `Add r2 r6` reads register 2 and feedback slot
6. Only the first operand of the three is ever a register.

> **Broken.** `RegisterCompiledFunction.disassemble`
> (`src/bytecode/register/ops/bytecode.ts:599-657`) prints every operand it does not
> recognise with an `r` prefix, including absolute jump targets and feedback-slot indices,
> so `--print-bytecode` renders `Jump r4` for a jump to instruction 4. The `register-effects`
> table (`src/bytecode/register/ops/register-effects.ts`) already knows which operands are
> registers. Finishing costs a lookup into it per operand.

The `--trace` output does not have this problem, because it prints raw operand lists and
claims nothing:

```
$ node dist/cli.js --trace docs/example/stats.tera | grep '^\[INTERP\] mean' | sed -n '14,16p'
[INTERP] mean: TestLessThan [3, 2]
[INTERP] mean: JumpIfFalse [32, 3]
[INTERP] mean: LdaThis
```

Between the two commands you can read one iteration of `mean`'s loop instruction by
instruction: `--print-bytecode` gives the operand *meanings*, `--trace` gives the executed
*stream*. Neither prints the accumulator, so the accumulator column of any hand trace has to
be reconstructed from the disassembly — the engine does not offer it.

## What leaves

A `TaggedValue`. For `report(latency)` that is a heap string, for `Series.mean` a double,
and for the program as a whole two lines on stdout: `latency mean=15.70` and
`throughput mean=898.19`, produced with no compilation of any kind. That is the oracle
[Ch 79 § differential] measures the other three tiers against.

Two things leave as side effects that nobody asked for. A populated `FeedbackVector` per
called function, filled one slot at a time by `getBinaryOperands` and by the ten handlers in
`handlers.ts`, plus warm inline-cache entries in `icManager` — [Ch 33] and [Ch 34] read
them, [Ch 48] speculates on them, [Ch 54] deoptimizes when they lie. And a `loopCounter`,
handed to `tieringPolicy.recordLoopIterations` in the `finally` of every frame, which is one
of the two inputs to the tier decision in [Ch 35].

What leaves *unopened* is the thing this chapter moved on every line and never looked
inside. `frame.acc`, `frame.registers[]`, `frame.thisValue` and the return value are all
`TaggedValue`, and this chapter used `areBothSmi`, `smiPayload`, `mkSmi`, `mkDouble`,
`mkNumber`, `CODE_UNDEFINED`, `SMI_MIN` and `SMI_MAX` without saying what any of them is. It
also called `_maybeSweepHeapPayloads` on a back edge without naming the `ValueHeap` it
sweeps. [Ch 22 § tagged-values] opens the representation: a tera value is a JavaScript
number with a four-bit type code in its low nibble, which is why `frame.registers` can be a
plain array and why the `SMI_MIN`/`SMI_MAX` re-check above is a proof obligation rather than
a courtesy.

## Verify it yourself

```bash
# The operand meanings for one loop: constants, locals, and the 43 instructions of mean.
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# The executed stream. Instructions 4..31 are one iteration; 31 is the back edge.
node dist/cli.js --trace docs/example/stats.tera | grep '^\[INTERP\] mean' | head -32

# Feedback is recorded from inside the loop, not by a separate pass.
node dist/cli.js --trace-feedback docs/example/stats-poly.tera | head -8

# No stack-depth guard: guest recursion is host recursion, and the host reports it.
printf 'fn down(n: int) -> int:\n  if n <= 0:\n    return 0\n  return 1 + down(n - 1)\nprint(down(1000000))\n' > /tmp/deeprec.tera
node dist/cli.js --no-opt /tmp/deeprec.tera; echo "exit=$?"

# The 94 opcode-level tests for this file.
npx vitest run --project unit tests/bytecode/register/interpreter.test.ts

# The opcode that has a baseline case and no interpreter case.
grep -rn "ROP_TEST_FEEDBACK" src/ --include=*.ts
```

The fourth command prints `Maximum call stack size exceeded` and `exit=1`. The last prints
four hits — a constant, a name-table entry, an effects-table entry, and a `BaselineCompiler`
case — and none in `src/bytecode/register/interpreter/`.

## Tests that pin this

- `tests/bytecode/register/interpreter.test.ts > "sets params from args"` — argument `i`
  becomes register `i`.
- `tests/bytecode/register/interpreter.test.ts > "limits param count to fn.paramCount"` —
  surplus arguments are dropped, not collected.
- `tests/bytecode/register/interpreter.test.ts > "setReg and getReg"` — the plain path
  through both accessors.
- `tests/bytecode/register/interpreter.test.ts > "TDZ uninitialized slots throw on read"`
  and `> "TDZ slot becomes readable after setReg"` — the `hasTDZ` branch, and that a single
  write clears it.
- `tests/bytecode/register/interpreter.test.ts > "throwIfTDZ throws on TDZ sentinel"` and
  `> "throwIfTDZ passes through normal values"` — the helper the upvalue branch calls.
- `tests/bytecode/register/interpreter.test.ts > "ADD integers"`, `> "ADD doubles"`,
  `> "ADD strings"`, `> "ADD string + number coercion"` — the four `ROP_ADD` paths.
- `tests/bytecode/register/interpreter.test.ts > "reads acc as left and register as right"`
  — `getBinaryOperands`' fixed operand order.
- `tests/bytecode/register/interpreter.test.ts > "JUMP unconditional"`,
  `> "JUMP_IF_FALSE skips when false"`, `> "JUMP_IF_FALSE falls through when true"`,
  `> "JUMP_IF_TRUE jumps when true"` — the three pc-moving opcodes.
- `tests/bytecode/register/interpreter.test.ts > "implicit return"` — falling off the end of
  the instruction array answers `undefined`.
- `tests/bytecode/register/interpreter.test.ts > "LDA_GLOBAL throws on undefined variable"`
  — `missingGlobalMessage` (`index.ts:240-258`), the one diagnostic the loop itself owns.
- The `SMI_MIN`/`SMI_MAX` re-check on `ROP_ADD` and `ROP_SUB` is `[unpinned]`. The test
  titled `"SUB overflow to double"` runs `ROP_MUL`, and no test in `tests/` mentions
  `SMI_MAX`.
- The absence of a stack-depth limit, the `default:` opcode throw, and the
  interpreter/baseline disagreement on `ROP_TEST_FEEDBACK` are all `[unpinned]`.
