# 18. Compiling expressions: the accumulator protocol   ⟨I · B · J · N⟩

Every instruction in this engine implicitly reads or writes one distinguished value. Nothing
names it, because it is never an operand. That decision buys a compact encoding and an
emitter where the common case is a single line of generated JavaScript, and it costs
*shuffle instructions* — `Star` to park a value out of the accumulator's way, `Ldar` to bring
it back.

This chapter counts that cost exactly. A binary operator, whatever its operands, is four
instructions of scaffolding around them. `total += this.values[i]` is eleven instructions in
`Series.mean`, of which four are pure shuffle. That is not a rounding error, and it is not
hidden: it is right there in the listing.

It is also not permanent. The whole trade is set up to be cashed later. When the SSA builder
of [Ch 39] walks these instructions it does not *emit* anything for `Star` and `Ldar` — it
interprets them at build time, recording that register 2 now holds the value node the
accumulator was holding, and moving on. Every shuffle instruction this chapter emits
disappears before the first optimization pass runs. The interpreter and the baseline
compiler pay for them; the two optimizing tiers do not. Knowing which tiers pay is the point
of counting.

**What arrived.** From [Ch 17 § what-leaves]: ninety `ROP_*` constants with ninety
mnemonics; `RegisterInstruction`, an opcode plus an untyped `number[]` in which nothing
distinguishes a register index from a constant-pool index from a feedback slot from a jump
target; an empty `RegisterCompiledFunction` that is simultaneously the unit of compilation
and the unit of tiering; and the rule that operand positions mean whatever
`register-effects.ts` says they mean — a table read by four files in the shared middle end
and by neither of the two tiers that execute bytecode directly.

## The protocol in one page {#the-protocol-in-one-page}

Before any code, the rule.

Exactly one value is implicit. Call it the accumulator. Every `Lda…` opcode writes it:
`LdaConst` from the constant pool, `LdaGlobal` from a global cell, `LdaThis` from the
frame's receiver, `LdaNamedProperty` from a property of a register. `Star r` copies it *out*
to register `r`. `Ldar r` copies register `r` back *in*. And every binary operator takes its
left operand from the accumulator, its right operand from the one register it names, and
writes the result back to the accumulator.

From that rule follows the sentence to hold on to for the rest of the chapter:

> **A register exists only to hold a value while the accumulator is busy with another one.**

That is why `mean` has five registers for a function with two named locals. `total` and `i`
are `r0` and `r1` because a local outlives any single expression. `r2`, `r3` and `r4` exist
because `this.values.length` has to be computed while `i` is waiting to be compared against
it, and there is only one accumulator.

The two halves of the protocol are two four-line methods, and they are the only place in the
expression compiler that knows how a *binding* is reached:

```ts
  emitLoadToAcc(resolved: ScopeResolution) {
    if (resolved.type === "local") {
      this.func.emit(bytecode.ROP_LDA_REG, resolved.slot);
    } else if (resolved.type === "upvalue") {
      this.func.emit(bytecode.ROP_LDA_UPVALUE, resolved.slot);
    }
  },

  emitStoreAcc(resolved: ScopeResolution) {
    if (resolved.type === "local") {
      this.func.emit(bytecode.ROP_STAR, resolved.slot);
    } else if (resolved.type === "upvalue") {
      this.func.emit(bytecode.ROP_STA_UPVALUE, resolved.slot);
    }
  },
```
— src/bytecode/register/compiler/expressions.ts:315-329

Note what they do *not* handle: a resolution that is neither local nor upvalue falls through
silently, emitting nothing. That case is a global, and every caller checks for it first by
testing `this.scope.resolve(name) !== null` before calling in. [Ch 20] is where scope
resolution earns those three answers.

## Four mixins over one mutable object

`RegisterBytecodeCompiler` is a class with state and almost no methods of its own. Its
methods live in four plain objects that are `Object.assign`ed onto its prototype at module
load:

```ts
Object.assign(RegisterBytecodeCompiler.prototype, scopeMethods);
Object.assign(RegisterBytecodeCompiler.prototype, statementMethods);
Object.assign(RegisterBytecodeCompiler.prototype, expressionMethods);
Object.assign(RegisterBytecodeCompiler.prototype, functionMethods);
```
— src/bytecode/register/compiler/index.ts:195-198

`expressionMethods` is the largest of the four: 1,345 lines in
`src/bytecode/register/compiler/expressions.ts`, of which one method
(`compileCallExpression`, 513-761) is 249 lines.

Each mixin is typed against its own hand-written `this` type — `ExpressionCompilerThis`
(`expressions.ts:144-190`) lists the fields and the sibling methods that file actually
calls, and nothing else. So `expressions.ts` declares that it needs `compileForOfStatement`
(from `statements.ts`) and `compileArrowFunction` (from `functions.ts`) without importing
either. The class file then declares a matching `interface RegisterBytecodeCompiler`
alongside the `class` of the same name (`index.ts:30-40`), which TypeScript merges, so the
prototype-assigned methods typecheck at call sites outside the mixins.

What this buys is real: four files of manageable size instead of one four-thousand-line one,
and a written record — the `…CompilerThis` type — of exactly which cross-file surface each
mixin depends on.

What it costs is also real, and both halves show up when you try to read the code. The
mixins are mutually recursive at run time: `compileExpression` calls
`compileCallExpression`, which calls `compileExpression` on the arguments, which may reach
`compileArrowFunction` in a different file, which calls back into `compileStatement` in a
third. No file can be read alone. And the `this` type is a hand-maintained duplicate of the
real one — add a method to `statements.ts` and call it from `expressions.ts` and you must
also add its signature to `ExpressionCompilerThis`, with nothing checking that the two
agree beyond the call itself failing to typecheck.

## Why the whole compiler state is saved by hand

There is no context object and no stack of them. `this.func` (the
`RegisterCompiledFunction` currently being emitted into), `this.scope`, `this.temps` and
`this._currentSuperClassName` *are* the compiler. Compiling an inner function means pointing
all four at new values and then putting them back.

That is written out longhand, five times, in `functions.ts`:

| site | line | what it compiles |
| --- | --- | --- |
| `compileFunctionDeclaration` | 744 | `fn scale(x) …` inside `scaler` |
| `compileFunctionExpression` | 825 | a named function expression |
| `compileArrowFunction` | 880 | `x => …` |
| the class-method loop | 1053 | `Series.mean`, `Series.label` |
| the static-field initializer loop | 1117 | `static x = …` |

Each begins with a block of the form `const outerFunc = this.func; const outerScope =
this.scope; const outerTemps = this.temps;` — the first, fourth and fifth also save
`_currentSuperClassName` — and ends by assigning all of them back. Name it as the pattern it
is: an explicit save/restore discipline standing in for recursion over an environment.

The risk it carries is exactly proportional to the number of sites. A new piece of compiler
state must be added to five save/restore blocks, or it leaks across a function boundary —
and the failure is not a crash, it is an inner function compiled against an outer
function's scope. `_yieldStarCount` (`expressions.ts:965`) is a counter that is deliberately
*not* saved, because it mints globally unique synthetic names and wants to keep counting
across boundaries. That the two cases look identical in the source is the cost of having no
context object to put them in.

## What `a + b` costs {#what-a-plus-b-costs}

`compileBinaryExpression` is twenty-two lines and it is the whole protocol in miniature:

```ts
  compileBinaryExpression(node: CompilerNode) {
    const tmp = this.temps.alloc();
    this.compileExpression(node.left);
    this.func.emit(bytecode.ROP_STAR, tmp);

    this.compileExpression(node.right);

    const tmp2 = this.temps.alloc();
    this.func.emit(bytecode.ROP_STAR, tmp2);
    this.func.emit(bytecode.ROP_LDA_REG, tmp);

    const opcode = BINARY_OP_MAP[node.op];
    …
    const fbSlot = this.func.allocFeedbackSlot();
    this.func.emit(opcode, tmp2, fbSlot);

    this.temps.free(tmp2);
    this.temps.free(tmp);
  },
```
— src/bytecode/register/compiler/expressions.ts:348-369, with the
unknown-operator throw at 360-362 elided

Read the emissions in order: `Star tmp` (park the left operand), then the right operand's
own instructions, then `Star tmp2` (park the right one), then `Ldar tmp` (bring the left one
back), then the operator. Three shuffle instructions plus the operator, wrapped around
whatever the two operands themselves cost — and the operator instruction itself is the
fourth, since it names `tmp2` rather than computing anything into a destination.

Note the temporary allocation order. `tmp` is allocated *before* the left operand compiles,
so it is held across the whole left subtree. `tmp2` is allocated *after* the right operand
compiles, so it is not held across the right subtree. That asymmetry is what keeps nesting
from exploding: `a + b + c + d` allocates one temporary per level for the left spine and
returns each right-hand temporary immediately
[t: tests/bytecode/register/compiler.test.ts > "compiles nested binary expressions"].

`BINARY_OP_MAP` (`expressions.ts:195-219`) is the operator table: 23 entries mapping source
spellings to opcodes, including both `===`/`!==` and `==`/`!=`, and `@` → `ROP_MATMUL`. It
is exhaustive by refusal rather than by type — an unmapped operator throws
`[RegCompiler] Unknown binary operator '…'`
[t: tests/bytecode/register/compiler.test.ts > "throws on unknown binary operator"].

Now check the shape against the real listing. `i < this.values.length` in `mean` is
instructions 4 through 13:

```
     4  Ldar r1
     5  Star r2
     6  LdaThis
     7  Star r4
     8  LdaNamedProperty r4 [1] (values) r0
     9  Star r3
    10  LdaNamedProperty r3 [2] (length) r1
    11  Star r3
    12  Ldar r2
    13  TestLessThan r3 r2
```
— output of `node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera`

Instruction 5 is `Star tmp` with `tmp = r2`. Instructions 6-10 are the right operand.
Instruction 11 is `Star tmp2` with `tmp2 = r3`, 12 is `Ldar tmp`, and 13 is
`TestLessThan tmp2, fbSlot` — which prints as `TestLessThan r3 r2` because the trailing
feedback slot 2 is rendered as a register ([Ch 17 § an-opcode-and-an-untyped-number-array]).

The loop body is the second measurement. `total += this.values[i]` is instructions 15
through 25 — eleven instructions:

```
    15  LdaThis
    16  Star r4
    17  LdaNamedProperty r4 [1] (values) r4
    18  Star r3
    19  Ldar r1
    20  Star r4
    21  LdaKeyedProperty r3 r4 r5
    22  Star r2
    23  Ldar r0
    24  Add r2 r6
    25  Star r0
```
— same command

Five instructions do work the source asked for: 15 loads the receiver, 17 loads `values`, 21
indexes it, 24 adds, 25 stores back into `total`. Two more read variables — 19 loads `i`, 23
loads `total` — which a three-address machine would also have to do. The remaining four,
16, 18, 20 and 22, exist *only* because there is one accumulator and four values in flight
at once. That is the tax, and it is 36% of this statement's instructions.

[Ch 39 § the-accumulator-and-the-slot-map] is where that 36% is refunded for ⟨J⟩ and ⟨N⟩ — the
SSA builder maintains a register-to-value map while walking the instruction list, and `Star
r2` is a map update rather than an emitted node. The interpreter and the baseline compiler
have no such option: `Star r2` is `r[2]=acc;` in generated JavaScript
(`src/optimizing/baseline/compiler.ts:197`), and it runs.

## `TempAllocator` is the whole register allocator

Thirty-one lines. One array.

```ts
export class TempAllocator {
  func: TempAllocatingFunction;
  freeTemps: number[];

  constructor(func: TempAllocatingFunction) {
    this.func = func;
    this.freeTemps = [];
  }

  alloc(): number {
    if (this.freeTemps.length > 0) {
      return this.freeTemps.pop()!;
    }
    return this.func.allocTemp();
  }
```
— src/bytecode/register/compiler/temp-allocator.ts:6-20

`alloc()` pops the free list or, if it is empty, calls `func.allocTemp()`, which is
`return this.registerCount++`. `free(reg)` pushes onto the free list. That is the entire
register allocator for the interpreter, the baseline compiler, and the input to both
optimizing tiers.

> **New idea. Register allocation.**
> A real machine has a fixed, small number of registers — sixteen on x64 — so a compiler
> targeting one must decide which values live in registers and which get pushed to memory
> ("spilled"). Doing that well requires knowing which values are *live* at each point, which
> requires a dataflow analysis, and choosing between them requires an interference graph or
> a linear scan over live intervals. [Ch 66] is that chapter, for the native backend.
>
> None of that applies here. A frame's registers are a plain JavaScript array sized once by
> `registerCount`, so there is no fixed budget and nothing is ever spilled. Allocation
> reduces to "hand out a number, take it back when done", and a LIFO stack of returned
> numbers is a complete implementation.

LIFO is not an accident of using an array. It is what makes the reuse pattern match the
nesting pattern: expressions are trees compiled depth-first, so the last temporary freed is
the one whose subtree just finished, and it is the right one to hand to the next sibling
[t: tests/bytecode/register/compiler/temp-allocator.test.ts > "free returns register to pool, alloc reuses it (LIFO)"].
Two independent binary expressions in sequence therefore occupy the same registers as one
[t: tests/bytecode/register/compiler.test.ts > "reuses freed temp registers"].

You can watch it work in `mean`. The condition at instructions 4-13 uses `r2`, `r3` and
`r4`, and frees all three. The body at 15-25 uses `r2`, `r3` and `r4` again. The trailing
`return total / this.values.length` at 32-41 uses them a third time. Five registers, three
statements, no growth.

## Why `allocContiguous` has to cheat {#why-alloccontiguous-has-to-cheat}

There is one thing a LIFO free list cannot promise, and a call needs exactly that thing.

`ROP_CALL`'s operands are `(callee, firstArg, argCount, feedbackSlot)`, and
`register-effects.ts` turns the middle pair into a window: the registers read are
`operands[1]` through `operands[1] + operands[2] - 1`
([Ch 17 § the-effects-table]).

> **New idea. The argument window.**
> Instead of listing every argument register in the instruction, a call names the *first*
> one and how many there are. That keeps `Call` at four operands regardless of arity — which
> matters here because `RegisterInstruction` is an object with a variable-length array and
> a caller reading `operands[3]` has to know where to look. The price is that the arguments
> must be **adjacent** in the register file. Not merely available: consecutive, in order.

A free list that hands back `r7`, then `r3`, then `r9` cannot satisfy that. So
`allocContiguous` does not consult it:

```ts
  allocContiguous(count: number): number {
    const base = this.func.registerCount;
    this.func.registerCount += count;
    return base;
  }
```
— src/bytecode/register/compiler/temp-allocator.ts:22-26

It bumps the high-water mark by `count` and returns the base, ignoring `freeTemps`
entirely. It is the only method in the compiler that does.

`Series.label` shows the cost in one function. The source is
`return this.name + " mean=" + this.mean().to_fixed(2)`, and the header says
`registers=5`:

```
    11  LdaNamedProperty r2 [2] (mean) r2
    12  Star r3
    13  Ldar r3
    14  CallMethod r2 r0 r0 r3
    15  Star r1
    16  LdaNamedProperty r1 [3] (to_fixed) r4
    17  Star r2
    18  LdaConst [4] (2)
    19  Star r4
    20  Ldar r2
    21  CallMethod r1 r4 r1 r5
```
— output of `node dist/cli.js --print-bytecode --filter label docs/example/stats.tera`

The `this.mean()` call at instruction 14 takes no arguments — its operands are
`(recv=r2, firstArg=0, argCount=0, fbSlot=3)`, and the printed `r0` in the second position
is an argument-window base that means nothing because the count is zero
[t: tests/bytecode/register/compiler.test.ts > "compiles call with no arguments"]. When it
tears down, it frees its method register `r3` and its receiver register `r2`.

Then `.to_fixed(2)` needs a one-element window. `r3` is sitting on the free list. It is not
used: `allocContiguous(1)` returns `registerCount`, which is 4, and instruction 19 stores
the argument into `r4`. `registerCount` goes from 4 to 5, and the header reports
`registers=5` for a function that never holds more than four values at once.

Array literals take the same path, because `ROP_NEW_ARRAY`'s elements are a window too
(`compileArrayExpression`, `expressions.ts:914`). In `stats.tera`'s module-level code the
effect compounds:

```
    16  LdaConst [10] (12.5)
    17  Star r4
   … r5, r6, r7 …
    24  LdaConst [14] (18)
    25  Star r8
    26  CreateArray r4 r5
   …
    34  LdaConst [16] (880)
    35  Star r11
```
— output of `--print-bytecode --filter '<script>' docs/example/stats.tera`, abridged

The first array's five elements take `r4`–`r8`, and instruction 26's `CreateArray r4 r5`
is base `r4`, count 5 — the second number is not a register. All five are then freed. The
second array's four elements nonetheless take `r11`–`r14`. The script's header reports
`registers=19`.

Nothing ever compacts these. There is no pass that walks the finished instruction list and
renumbers registers downward, so a function with many distinct call arities accumulates a
register file it never uses all of at once. For the interpreter that is one oversized
JavaScript array per frame; for the baseline compiler it is a larger `r` array in the
generated function. It is not measured, and this tree has no benchmark harness to measure
it with.

Note also what the tests do *not* cover. All three tests in
`tests/bytecode/register/compiler/temp-allocator.test.ts` exercise `alloc`, `free` and their
interaction. None of them exercises `allocContiguous`. Its behaviour is pinned only
indirectly, by end-to-end tests that happen to compile calls with arguments. [unpinned]

## Member and index access

Property access comes in two shapes, and which one you get is decided by whether the
property is a string in the AST:

```ts
    if (typeof node.property === "string") {
      const propIdx = this.func.addConstant(node.property);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_LDA_PROP, objReg, propIdx, fbSlot);
    } else {
      const idxReg = this.temps.alloc();
      this.compileExpression(node.property);
      this.func.emit(bytecode.ROP_STAR, idxReg);
      const fbSlot = this.func.allocFeedbackSlot();
      this.func.emit(bytecode.ROP_LDA_INDEX, objReg, idxReg, fbSlot);
      this.temps.free(idxReg);
    }
```
— src/bytecode/register/compiler/expressions.ts:797-808

A *named* property is a constant-pool index plus a feedback slot; the name is baked into the
instruction, which is what lets an inline cache key on it ([Ch 34]). A *computed* one costs
an extra register and an extra `Star`, and the cache has nothing static to key on. Both
appear in `mean`: `LdaNamedProperty r4 [1] (values) r0` at instruction 8 and
`LdaKeyedProperty r3 r4 r5` at instruction 21
[t: tests/bytecode/register/compiler.test.ts > "compiles named property access"]
[t: tests/bytecode/register/compiler.test.ts > "compiles computed property access"].

`compileIndexExpression` (`expressions.ts:812-845`) is a different thing that looks similar.
It compiles tera's multidimensional slice syntax — `a[i, 1:2:3]` — and it is the reason
`RegisterEffects.readsFrom` exists. Each dimension contributes a token to a descriptor array
that goes in the constant pool (`"i"` for a plain index, `"s110"` for a slice with a start
and a stop and no step) and zero or more registers holding the bound expressions. The
emission is a spread:

```ts
    const descIdx = this.func.addConstant(tokens);
    this.func.emit(bytecode.ROP_LDA_KEYED_SLICE, objReg, descIdx, ...boundRegs);
```
— src/bytecode/register/compiler/expressions.ts:841-842

so the instruction's arity depends on the subscript. It is the only opcode in the set whose
operand count is not fixed, and `readsFrom: 2` is the table's way of saying "everything from
position 2 onward is a register"
[t: tests/bytecode/register/ops/register-effects.test.ts > "reads every trailing index register of a keyed slice"].
`docs/example/*.tera` contains no slice, so this one is read from source rather than from a
listing.

## Template literals, `??` and `?.`

Three lowerings, and the thing they have in common is that there is no opcode for any of
them.

> **New idea. Lowering.**
> Rewriting a source form into simpler forms the machine already has, before emission.
> A compiler that "supports" template literals need not have a template-literal
> instruction; it needs a rule that turns one into instructions it already has. The rule is
> the feature.

A **template literal** becomes a fold of `ROP_ADD` over the parts
(`expressions.ts:987-1021`). A result register is seeded with the first literal part, and
then for each interpolated expression: park the expression, `Ldar` the result, `Add`. If the
literal part that follows is not the empty string, do it again with that part. The
`if (node.parts[i + 1] !== "")` guard at line 1002 is a real saving —
`` `${a}${b}` `` has empty parts between its expressions and emits no adds for them
[t: tests/bytecode/register/compiler.test.ts > "compiles template literal with expressions"].

**`??`** becomes a five-instruction diamond (`expressions.ts:1023-1035`): compile the left,
`Star leftReg`, `IsNullish`, `JumpIfTrue` to the right-hand side, `Ldar leftReg`, `Jump` to
the end. Both jumps are emitted with a placeholder target of `0` and patched by
`patchJump` as soon as the destination is known — the technique [Ch 19] is about, appearing
here for the first time because a short-circuit *expression* has to patch for itself.

**`?.`** is the same shape with one difference worth stopping on
(`expressions.ts:1037-1061`). The absent path emits `LdaNull`:

```ts
    const jumpToEnd = this.func.emit(bytecode.ROP_JUMP, 0);
    this.func.patchJump(jumpToAbsent, this.func.instructions.length);
    this.func.emit(bytecode.ROP_LDA_NULL);
    this.func.patchJump(jumpToEnd, this.func.instructions.length);
```
— src/bytecode/register/compiler/expressions.ts:1056-1059

So `a?.b` where `a` is absent answers **null**, not `undefined`. That is an observable
difference, not an internal detail: the two absence values are distinguishable in this
language and the AOT backend treats them differently — a reference may hold `null` and may
not hold `undefined` ([Ch 22 § two-absence-values]). The optional-call form
(`compileOptionalCall`, `:1063-1141`) makes the same choice, and so does the
optional-receiver branch inside `compileCallExpression` at `:705-710`.

`&&` and `||` are the fourth member of this family and the simplest:
`compileLogicalExpression` (`:429-443`) compiles the left, emits one conditional jump with a
placeholder, compiles the right, and patches. Nothing is parked, because the accumulator
already holds the left value and the jump reads it
[t: tests/bytecode/register/compiler.test.ts > "compiles && with short-circuit jump"].

## Update and compound assignment

`compileUpdateExpression` is 114 lines (`:1143-1256`) and `compileCompoundAssignment` is 87
(`:1258-1344`), which for `x++` and `x += 1` looks like a lot. The length is the cross
product: prefix versus postfix, identifier versus member target, named versus computed
member, local versus global binding. Four ways of two, all written out longhand, with no
shared helper.

One detail is visible in every one of those branches. There is no immediate form of
`ROP_ADD` — its right operand is a register, always — so the constant `1` has to be
materialized:

```ts
        const oneReg = this.temps.alloc();
        const oneIdx = this.func.addConstant(1);
        this.func.emit(bytecode.ROP_LDA_CONST, oneIdx);
        this.func.emit(bytecode.ROP_STAR, oneReg);
        this.func.emit(bytecode.ROP_LDA_REG, origReg);
```
— src/bytecode/register/compiler/expressions.ts:1158-1162

Four instructions to add one. The same block appears four more times in the same method
[t: tests/bytecode/register/compiler.test.ts > "compiles postfix ++"]
[t: tests/bytecode/register/compiler.test.ts > "compiles prefix --"].
`i += 1` in `mean` compiles to exactly this, instructions 26-30.

The computed-member branch has a bug.

> **Broken.** `compileUpdateExpression` on a computed member target — `a[f()]++` —
> compiles the key expression **twice** and stores the wrong value.
>
> **Symptom.** With `calls` counted by an `idx()` that increments it and returns `0`:
>
> ```
> $ node dist/cli.js update-index.tera
> calls = 2
> a[0] = 0
> ```
>
> for the program `a: int[] = [10, 20]` then `a[idx()]++`. The key expression ran twice,
> and the element was overwritten with the key's result rather than the increment. The same
> program written `a[idx()] += 1` prints `calls = 1` and `a[0] = 11`.
>
> **Mechanism.** The load path compiles `argument.property` into `idxReg`
> (`expressions.ts:1213-1215`), then frees `idxReg` at `:1218`. The store path, having
> nothing left, compiles `argument.property` a *second* time
> (`expressions.ts:1241-1243`). But by then the accumulator holds the incremented value,
> and `compileExpression` on the key overwrites it. The disassembly shows both failures in
> five instructions:
>
> ```
>     21  Add r3 r2
>     22  LdaGlobal [1] (idx)
>     23  Star r5
>     24  Call r5 r0 r0 r3
>     25  Star r4
>     26  StaKeyedProperty r1 r4 r4
> ```
>
> Instruction 21 computes 11 into the accumulator; 22-25 recompute `idx()` over it;
> 26 stores whatever is left. The identifier path is unaffected, and the *named*-member path
> is unaffected because it only re-adds a constant-pool index (`:1236-1239`) and emits no
> instructions.
>
> **Fix.** Keep `idxReg` alive across the read-modify-write and reuse it for the store —
> which is exactly the shape `compileCompoundAssignment` already has at `:1316-1341`, and is
> why that path is correct.
>
> **Regression test.** None exists. Reproducing this from the tree needs a new variation
> file — proposed `docs/example/update-index.tera`, added to
> `tests/e2e/docs/book-examples.test.ts` — plus an entry in [Ch 82] and Appendix D.
> [unpinned]
>
> **General rule.** *A lowering may not evaluate a sub-expression twice, and may not emit
> into the accumulator after the operator has written it.* Both halves of that rule are
> violated by the same four lines, which is why one bug produced two wrong answers.

There is a second, smaller irregularity in the unary path.

> **Unfinished.** `compileUnaryExpression`'s unary-plus case emits `ROP_NEG` twice
> (`expressions.ts:408-412`) and allocates two feedback slots to do it:
>
> ```ts
>       case "+": {
>         this.func.emit(bytecode.ROP_NEG, this.func.allocFeedbackSlot());
>         this.func.emit(bytecode.ROP_NEG, this.func.allocFeedbackSlot());
>         break;
>       }
> ```
>
> It is correct for numbers — double negation is how the numeric coercion happens — but it
> means `+x` is two feedback sites while `-x` is one, which skews anything that counts
> them. Cost of fixing: a `ROP_TO_NUMBER`, which is a ninety-first opcode and therefore
> four new consumers ([Ch 17 § the-coverage-matrix]).

## The six call forms — really eight opcodes over five branches {#the-six-call-forms}

`compileCallExpression` is the longest method in the file for a reason that is not
accidental complexity: three independent properties of a call site each force a different
instruction shape.

It dispatches in this order (`expressions.ts:513-761`):

1. **runtime-intrinsic callee**, no spread, no named args → `CallIntrinsic` (`:523-538`)
2. **spread present, member callee** → `CallMethodSpreadNamed` or `CallWithSpread` (`:540-…`)
3. **spread present, plain callee** → `CallSpreadNamed` or `CallWithSpread`
4. **member or optional-member callee** → `CallMethodNamed` or `CallMethod` (`:…-714`)
5. **anything else** → `CallNamed` or `Call` (`:715-760`)

plus `ROP_NEW` from `compileNewExpression` (`:763-780`).

What forces the split is arity and shape, not taste. A plain call knows its argument count
at compile time and can pass a window. A spread call does not — `f(...xs)` has as many
arguments as `xs` has elements at run time — so `_buildSpreadArgs` (`:495-511`) emits a
`CreateArray`, then an `ArrayPush` per ordinary argument and a `SpreadArray` per spread one,
and the call receives *one* register holding an array instead of a window. Named arguments
need a second contiguous window plus a names array in the constant pool, so that the callee
can bind them Python-style
[t: tests/e2e/language/functions.test.ts > "binds named arguments with Python-style rules"].
When both apply you get the seven-operand `CallMethodSpreadNamed`
[t: tests/e2e/language/functions.test.ts > "mixes spread positional arguments with named arguments"].

Branch 4 is the one `stats.tera` actually reaches, and it is worth reading against a
listing. Here it is:

```ts
      const methodReg = this.temps.alloc();
      this.func.emit(bytecode.ROP_STAR, methodReg);

      const argCount = parts.positional.length;
      const firstArgReg =
        argCount > 0 ? this.temps.allocContiguous(argCount) : 0;
      for (let i = 0; i < argCount; i++) {
        this.compileExpression(parts.positional[i]!);
        this.func.emit(bytecode.ROP_STAR, firstArgReg + i);
      }

      this.func.emit(bytecode.ROP_LDA_REG, methodReg);
      const fbSlot = this.func.allocFeedbackSlot();
```
— src/bytecode/register/compiler/expressions.ts:662-674

and, when there are no named arguments,
`emit(ROP_CALL_METHOD, recvReg, firstArgReg, argCount, fbSlot)` at `:696-702`. Match that
against `label`'s instructions 16-21. Instruction 16 loaded `to_fixed` off `r1` — the
receiver register — into the accumulator. Instruction 17 is `Star r2`: that is `methodReg`.
Instructions 18-19 are the argument loop for `argCount = 1`, storing the literal `2` into
`firstArgReg = r4`. Instruction 20 is `Ldar r2`, bringing the method back into the
accumulator. Instruction 21 is
`CallMethod r1 r4 r1 r5` — receiver `r1`, window base `r4`, count 1, feedback slot 5.

Two of those six instructions are shuffle, and the `Ldar methodReg` at 20 is a shuffle whose
only purpose is that `ROP_CALL_METHOD` expects the callable in the accumulator even though
it already names the receiver.

## `yield*` is desugared into a `for-of` mid-emission

The oddest move in the file is nine lines long. `compileYieldExpression`, on seeing
`node.delegate` — that is, `yield*` rather than `yield` — does not emit anything. It
*constructs AST nodes* and hands them to the statement compiler:

```ts
  compileYieldExpression(node: CompilerNode) {
    if (node.delegate) {
      this._yieldStarCount = (this._yieldStarCount || 0) + 1;
      const varName = "_yieldStar$" + this._yieldStarCount;
      const loop = ForOfStatement(
        varName,
        requireExpressionNode(node.argument, "yield*"),
        BlockStatement([
          ExpressionStatement(YieldExpression(Identifier(varName), false)),
        ]),
        "let",
      );
      this.compileForOfStatement(loop);
      this.func.emit(bytecode.ROP_LDA_UNDEFINED);
      return;
    }
```
— src/bytecode/register/compiler/expressions.ts:963-978

`yield* xs` becomes `for _yieldStar$1 of xs: yield _yieldStar$1`, built out of AST
constructors at emission time, with the binding name minted from a counter so that nested
`yield*`s do not collide. The loop then compiles by the ordinary path, emitting
`GetIterator`, `IterNext`, `IterDone`, `IterValue` and `Yield` like any other `for-of`.

This is an instance of a general rule that is worth stating once, because it explains
something readers hit later: **this compiler rewrites trees, not just emits from them.**
Three more instances live in `functions.ts` — `injectInstanceFields` (`:503`) splices field
initializers into a constructor body, `forwardingConstructorOf` (`:237`) synthesizes a
constructor for a subclass that declares none, and `lowerModelDeclaration` (`:525`) turns a
`model` declaration into a `ClassNode` before `compileClassDeclaration` ever sees it
(`:965`). [Ch 20] walks all three.

The consequence: `--print-ast` and `--print-bytecode` can legitimately disagree about what a
program contains. The AST has a `YieldExpression` with `delegate: true`; the bytecode has a
`for-of` loop over a variable whose name appears nowhere in the source.

There is one place where the protocol simply runs out, and it is worth quoting because the
refusal is the specification:

```
[RegCompiler] Bare super is not supported
```

That is `compileExpression`'s `NodeType.SuperExpression` case (`expressions.ts:231-232`), and
it is reachable: write `y = super` inside a method of a `class B extends A` and the program
exits with that message and nothing else. There is no accumulator value a bare `super` could
load, because `super` is not a value in this compiler. It is resolved structurally by
`emitLoadSuperPrototypeProperty` (`:129-142`) against a synthetic binding named by
`superClassBinding(className)`, which [Ch 20] introduces. Note also that the message names
the compiler stage and not the source position — the diagnostic pattern [Ch 81] catalogues.

## Feedback slots are allocated here, by convention only

A feedback slot is a numbered place in a per-function side table where the interpreter
records what it saw at one site: which hidden classes an object had, whether an addition
was always integers, which function a call site actually reached. [Ch 33] spends them; this
chapter allocates them.

The allocator is one line — `allocFeedbackSlot()` is `return this.feedbackSlotCount++`
(`src/bytecode/register/ops/bytecode.ts:565-567`) — and the emitter appends the returned
number as the **last operand**, into the same untyped `number[]` that holds register
indices.

Count them in `mean`. Eleven slots, numbered 0 through 10:

| slot | instruction | site |
| --- | --- | --- |
| 0 | 8 | `LdaNamedProperty` — `this.values` |
| 1 | 10 | `LdaNamedProperty` — `.length` |
| 2 | 13 | `TestLessThan` |
| 3 | 14 | `JumpIfFalse` |
| 4 | 17 | `LdaNamedProperty` — `this.values` |
| 5 | 21 | `LdaKeyedProperty` — `[i]` |
| 6 | 24 | `Add` — `total +=` |
| 7 | 29 | `Add` — `i += 1` |
| 8 | 36 | `LdaNamedProperty` — `this.values` |
| 9 | 38 | `LdaNamedProperty` — `.length` |
| 10 | 41 | `Div` |

Three separate `values` loads get three separate slots even though they are textually the
same property of the same object, because a slot is a *site*, not a name. That is the whole
point: [Ch 34]'s inline caches key on `getICKey(name, slot)` = `"mean#5:4"`, and two sites
that see different shapes must not pollute each other.

Note that the unconditional `Jump` at instruction 31 has no slot — it has one operand, the
target. Only the conditional jumps take feedback, because only they have a branch bias worth
recording ([Ch 35]).

Now the fragility. The slot number goes into the operand array, in a position that
`register-effects.ts` must independently know to skip. `ROP_ADD` reads operand 0 and only
operand 0; if that entry were `READS_FIRST_TWO`, then `Add r2 r6` in `mean` would tell
[Ch 39]'s liveness analysis that register 6 is live — in a function with five registers.

> **Unenforced.** Nothing checks that the operand a compiler method appends as a feedback
> slot sits in the position `register-effects.ts` expects to ignore. The producer
> (`expressions.ts`) and the description (`register-effects.ts`) are two files that agree by
> inspection and by nothing else. This is the same seam [Ch 17 § who-actually-reads-the-table-and-who-does-not]
> opened, seen from the producing side. Cost of enforcing: a test that compiles a corpus and
> asserts `feedbackSlotCount` equals the number of distinct trailing operands the table
> skips.

## What leaves

A straight-line instruction sequence per expression. The only jumps in it are the
short-circuit ones this chapter emitted itself — `&&`, `||`, `?:`, `??`, `?.` and an
optional call's absent path — and every one of those was patched by the method that emitted
it, before it returned. Everything else in the program's control flow is still missing.

Three side effects ride along on the `RegisterCompiledFunction`. `registerCount` is a
high-water mark, bumped by `allocTemp` and by `allocContiguous` and never lowered; it is
read once, to size `RegisterFrame.registers`. `feedbackSlotCount` is a count of allocated
slots, read once to size the feedback vector of [Ch 33], and its numbers are already sitting
in trailing operands where only the effects table knows to skip them. And `sourceMap` has
one entry per emitted instruction, written by `emit` whenever
`activeSourcePosition` is set — which `_withSourceNode` (`compiler/index.ts:183-192`) sets
around every expression that carries a line and column, so that a deoptimization ([Ch 48])
or a stack trace can name a source position.

Plus the constant pool, in which primitives are shared and objects are not.

[Ch 19 § the-problem-stated-once] takes it from here, with the statements: loops, conditionals,
`switch`, `try` and labelled statements, all of which become absolute instruction indices in
operand 0 of `Jump`, `JumpIfTrue`, `JumpIfFalse` and `TryStart` — and one of which, in this
tree, is not always patched.

## Verify it yourself

```bash
# The binary shape and the loop body. Instructions 4-13 are the four-instruction
# scaffolding of `i < this.values.length`; instructions 15-25 are the eleven of
# `total += this.values[i]`, of which 16, 18, 20 and 22 are pure shuffle.
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# allocContiguous ignoring the free list: r3 is free when `.to_fixed(2)`'s
# argument window is allocated, and the window still takes r4 — which is why
# the header says registers=5.
node dist/cli.js --print-bytecode --filter label docs/example/stats.tera

# Also demonstrates --filter's substring matching: this prints BOTH `scaler`
# and `scale`, because matchesFilter is name.includes(filter)
# (src/cli/main.ts:44-47).
node dist/cli.js --print-bytecode --filter scale docs/example/stats-closure.tera

# The register allocator, entire. Three tests, none of them for allocContiguous.
npx vitest run --project unit tests/bytecode/register/compiler/temp-allocator.test.ts

# The expression compiler. 67 tests.
npx vitest run --project unit tests/bytecode/register/compiler.test.ts
```

The two test files pass together:

```
 Test Files  2 passed (2)
      Tests  70 passed (70)
```

The `> **Broken.**` item above is not reproducible from `docs/example/` — it needs a
variation file that does not exist yet. Until one is added, reproduce it from a scratch
file:

```
calls = 0

fn idx() -> int:
  calls += 1
  return 0

a: int[] = [10, 20]
a[idx()]++
print("calls = " + calls.to_string())
print("a[0] = " + a[0].to_string())
```

which prints `calls = 2` and `a[0] = 0`. Changing `a[idx()]++` to `a[idx()] += 1` prints
`calls = 1` and `a[0] = 11`.

## Tests that pin this

- `tests/bytecode/register/compiler.test.ts > "allocates and frees temp registers for operands"`
  — the two `Star`s of the binary shape.
- `tests/bytecode/register/compiler.test.ts > "uses feedback slot"`
  — a binary operator always allocates one.
- `tests/bytecode/register/compiler.test.ts > "compiles all arithmetic operators"`
- `tests/bytecode/register/compiler.test.ts > "compiles comparison operators"`
- `tests/bytecode/register/compiler.test.ts > "compiles bitwise operators"`
- `tests/bytecode/register/compiler.test.ts > "throws on unknown binary operator"`
  — `BINARY_OP_MAP` is exhaustive by refusal, not by type.
- `tests/bytecode/register/compiler.test.ts > "maps each operator to the correct opcode"`
  — the same for unary.
- `tests/bytecode/register/compiler.test.ts > "compiles && with short-circuit jump"`
- `tests/bytecode/register/compiler.test.ts > "compiles || with short-circuit jump"`
- `tests/bytecode/register/compiler.test.ts > "patches jump target correctly for &&"`
  — the self-patching an expression does, before [Ch 19] generalizes it.
- `tests/bytecode/register/compiler.test.ts > "compiles simple function call"`
- `tests/bytecode/register/compiler.test.ts > "compiles method call"`
- `tests/bytecode/register/compiler.test.ts > "compiles call with no arguments"`
  — the `firstArgReg = 0` case, where operand 1 is a base that means nothing.
- `tests/bytecode/register/compiler.test.ts > "compiles named property access"`
- `tests/bytecode/register/compiler.test.ts > "compiles computed property access"`
- `tests/bytecode/register/compiler.test.ts > "compiles template literal with expressions"`
- `tests/bytecode/register/compiler.test.ts > "compiles postfix ++"`
- `tests/bytecode/register/compiler.test.ts > "compiles prefix --"`
- `tests/bytecode/register/compiler.test.ts > "compiles +="`
- `tests/bytecode/register/compiler.test.ts > "compiles nested binary expressions"`
  — the allocation asymmetry that keeps nesting from exploding.
- `tests/bytecode/register/compiler.test.ts > "registerCount grows with locals"`
- `tests/bytecode/register/compiler.test.ts > "reuses freed temp registers"`
  — two independent binary expressions occupy the same registers as one.
- `tests/bytecode/register/compiler/temp-allocator.test.ts > "alloc returns fresh registers from the function when pool is empty"`
- `tests/bytecode/register/compiler/temp-allocator.test.ts > "free returns register to pool, alloc reuses it (LIFO)"`
- `tests/bytecode/register/compiler/temp-allocator.test.ts > "mixed alloc/free pattern avoids growing registerCount when possible"`
  — note what all three omit: there is no test for `allocContiguous`.
- `tests/e2e/language/functions.test.ts > "mixes spread positional arguments with named arguments"`
  — the branch of `compileCallExpression` that needs both windows.
- `tests/e2e/language/functions.test.ts > "binds named arguments with Python-style rules"`
  — what the names array in the constant pool is for.
