# 36. The baseline compiler   ⟨I · B · J⟩

Tier 1 of this engine is a compiler whose output is a string. Not machine code, not
bytecode, not an intermediate representation — a few thousand characters of JavaScript source
text, handed to `new Function` and compiled by whatever JIT the host happens to have. There
is no register allocator, no analysis, no optimization pass and no instruction selector in
`src/optimizing/baseline/`, because all four of those already exist inside V8 and this
compiler's whole strategy is to reach them.

What it does bring is a translation. Every bytecode becomes a `case` in a `switch` inside a
labelled `while(1)`, so the generated function's control flow is an exact image of the
bytecode's. Every register becomes an element of a plain JavaScript array laid out at exactly
the indices `RegisterFrame` uses, so the collector and the on-stack-replacement machinery can
read a baseline frame with the same code they use on an interpreted one. And the arithmetic —
the reason the tier is worth having at all — exploits one accident of the value
representation: because `CODE_SMI` is `0`, a tagged small integer is its payload times
sixteen, and *the sum of two tagged Smis is the tagged sum*. Adding two integers in
baseline-compiled code costs a tag test, a `+`, and a range check. There is no untag and no
retag.

The costs are real and this chapter names them one by one. Leaving the interpreter's
abstraction means the generated code has to do by hand everything the abstraction was doing
for it: root its own accumulator, count its own safepoints, and decline any function it
cannot translate rather than mistranslate it.

**What arrived.** From [Ch 35 § callmode], a `RegisterCompiledFunction` whose
`invocationCount` has reached `baselineThreshold` — 8 by default, 1 or 2 under the flags this
chapter uses — and which `requiresInterpreterOnly` did not veto. It carries an instruction
array, a constant pool, a `registerCount`, a `paramCount`, and a `feedbackVector` that
[Ch 33] filled during the interpreted calls that came before. `Engine.baselineCompile`
(`src/api/engine.ts:1684-1704`) is the entry point; it returns early if `baselineCode` is
already set, and calls `updateCallMode` on success.

## Why emit source   *(Why the obvious design fails)*

Two designs come to mind before this one, and both are better ideas in a different engine.

**Write a second interpreter with a better dispatch.** Unroll the dispatch switch, specialize
the hot opcodes, thread the dispatch. This is a real technique, but what it attacks is the
*dispatch overhead*, and dispatch is not where this interpreter's work goes. The work is that
every operation goes through a tagged-value protocol: fetch
the operand, test the tag, unwrap the payload, compute, rewrap. A second interpreter still
pays all of that. It also costs a second complete implementation of every opcode, which must
then agree with the first one about everything in [Ch 25 § the-three-answer-contract].

**Go straight to the optimizing compiler.** Skip tier 1; when a function is hot, build SSA
and emit WebAssembly. The problem is what the optimizing compiler needs in order to be worth
running: speculation, and speculation needs observations. [Ch 33] recorded those observations
during interpretation, and a function that jumps from the interpreter to the JIT on its
fiftieth call has had exactly forty-nine interpreted calls to fill its vector — during which
it ran in the dispatch loop. Tier 1 exists to get that middle period out of the dispatch loop
*while still recording*, which is why `BaselineRuntime` writes into the same feedback vector
(§ where-feedback-comes-from-here). There is a second reason, and it is the more decisive one
here: the optimizing compiler cannot compile everything. `label` and `mean` in
`stats.tera` are both refused by the wasm backend — `Wasm: graph not compilable: property
access on this receiver` — and without a tier between, those two functions would spend the
program's whole life in the dispatch loop.

So the engine wants a compiler that is small to *write*, applies to almost every function, and
produces something the machine can run without a dispatch loop. It is hosted on Node, which
means the only instruction selector available to it is the host's own JIT, and the only
portable way to reach that selector is to hand the host a string:

```ts
      const fn = new Function("args", "tv", "$", "pc", "env", body) as (
```
— `src/optimizing/baseline/compiler.ts:86`

`body` is a string this compiler built character by character. The five parameter names are
the whole calling convention: `args` is the argument array, `tv` is `this`, `$` is the
`BaselineRuntime` instance, `pc` is the entry offset (always `0` from a normal call), and
`env` is the closure environment.

What that buys, free: register allocation, inlining, constant folding, and instruction
selection, done by an optimizing compiler that has been worked on for fifteen years. What it
costs:

- **No control over the result.** There is no way to ask the host to inline something, to
  keep a value in a register, or to not deoptimize. The generated text is a hint, and the
  host is under no obligation.
- **A `try`/`catch` around compilation.** `new Function` parses at call time and can throw —
  a malformed emission, or a body past some host limit. `compile` catches it, traces
  `Baseline failed: <message>`, and returns `null` (`compiler.ts:127-131`). One interpreted
  call is the cost of being wrong.
- **Nothing to show.** There is no flag anywhere in the CLI that prints the generated
  JavaScript, and `machineTracer` — the other place a compiler string could have a sink —
  has none either. This chapter's central listing is obtained by monkey-patching
  `generateBody` from a script, and the command that does it is in § verify-it-yourself.

## Goto in a language without goto

Bytecode jumps to an absolute offset ([Ch 19 § absolute-targets-and-what-a-back-edge-is]).
JavaScript has no `goto`. The translation is a labelled infinite loop around a switch on the
program counter:

```ts
    c += `$.enter(r,function(){return[${ROOTED_LOCALS.join(",")}];});\ntry{\n`;
    c += `L:while(1){switch(pc){\n`;

    for (let i = 0; i < instrs.length; i++) {
      const nextInstr = i + 1 < instrs.length ? instrs[i + 1] : null;
      const emitted = this.emitOp(instrs[i], i, compiledFn, hasClosures, nextInstr);
      if (emitted === null) return null;
      c += `case ${i}:`;
      c += emitted;
      c += "\n";
    }

    c += `default:return $.u;}}\n`;
    c += `}finally{$.leave();}\n`;
```
— `src/optimizing/baseline/compiler.ts:155-168`

Every bytecode index is a `case` label. Every jump is `pc = target; continue L;` — the
`continue` re-enters the `while`, the `switch` re-dispatches on the new `pc`, and the effect
is a jump to an arbitrary bytecode offset expressed entirely in structured control flow
[t: `tests/optimizing/baseline/compiler.test.ts > "generates switch/case dispatch loop"`,
`> "emits jump as pc assignment + continue"`].

Two details of that skeleton are worth stopping on.

**Fall-through is not a bug, it is the semantics.** None of the `case` bodies ends in
`break`. Consecutive bytecodes fall from `case 7` into `case 8` exactly as the interpreter
falls from one loop turn to the next, because in a register machine an instruction that is
not a jump *is* followed by its successor. Deleting a `break` from a JavaScript switch is
usually a defect; here, adding one would be.

**`default: return $.u` is the right terminator.** A `pc` that names no instruction can only
arise from running off the end of the instruction array, which in the interpreter ends
`runFrame`'s `while (frame.pc < instructions.length)` loop and answers `undefined`. The
generated function answers `$.u`, which is `mkUndefined()`, for the same reason.

The consequence for later chapters is that the generated function's control-flow graph is an
*exact image* of the bytecode's, one `case` per offset, with jump targets that are still
bytecode offsets. That is what makes it possible for a compiled OSR entry, produced from the
same bytecode offsets, to take over from a running baseline frame — [Ch 37 § the-baseline-side].

## A frame the interpreter would recognise

The generated prologue builds a frame that matches `RegisterFrame`'s layout element for
element:

```ts
    let c = "";
    c += `var acc,${SCRATCH_LOCALS.join(",")},sp=0;\n`;
    c += `var r=new Array(${nRegs});\n`;
    c += `for(var i=0;i<${nRegs};i++)r[i]=$.u;\n`;
    c += `for(var i=0;i<args.length&&i<${nParams};i++)r[i]=args[i];\n`;
    c += `acc=$.u;\n`;
    c += `$.cf.lastExecutionTime=Date.now();\n`;
```
— `src/optimizing/baseline/compiler.ts:145-151`

For `Series.mean`, five registers and no parameters, that emits:

```
var acc,t,t2,t3,t4,osr,sp=0;
var r=new Array(5);
for(var i=0;i<5;i++)r[i]=$.u;
for(var i=0;i<args.length&&i<0;i++)r[i]=args[i];
acc=$.u;
$.cf.lastExecutionTime=Date.now();
$.enter(r,function(){return[acc,t,t2,t3,t4,osr];});
```
— generated by `src/optimizing/baseline/compiler.ts:145-155`

Now the constructor it is imitating:

```ts
    const regCount = compiledFn.registerCount;
    this.registers = new Array<RegisterValue>(regCount).fill(CODE_UNDEFINED);
```
— `src/bytecode/register/interpreter/frame.ts:61-62`

```ts
    for (let i = 0; i < args.length && i < compiledFn.paramCount; i++) {
      this.registers[i] = args[i];
    }
```
— `src/bytecode/register/interpreter/frame.ts:77-79`

Same count, same undefined-fill, same argument-copy loop written out character for character
in a different language. The invariant is: **a baseline frame's `r[i]` holds the same value
the interpreter's `frame.registers[i]` would hold at the same bytecode offset.** Everything
downstream depends on it. `visitFrameRoots` (`src/gc/roots.ts:73-93`) reads
`frame.registers || frame.locals` without asking which tier produced it. `$.backEdge` hands
`r` straight to `enterOsr` as `(slot) => registers[slot]`, and the compiled OSR entry reads
its arguments out of it by slot number.

Invariant → enforcement → test: **nothing enforces it.** The two layouts are built by
unrelated files, in unrelated languages, with no shared constant and no assertion.

> **Unenforced.** The register-compatibility invariant is stated nowhere and checked nowhere.
> `RegisterFrame`'s constructor (`src/bytecode/register/interpreter/frame.ts:51-80`) and
> `BaselineCompiler.generateBody`'s prologue (`src/optimizing/baseline/compiler.ts:145-151`)
> agree by inspection and by nothing else — two expressions over two register counts, in two
> languages, with no shared constant, no assertion and no test that compares them. Cost of
> enforcing: derive both layouts from one function, or assert in `$.enter` that every element
> of `r` is a number. [unpinned]

They already differ in one respect, and the difference is observable.

> **Broken.** The interpreter seeds `TDZ_UNINITIALIZED` — a JavaScript object, not a tagged
> value — into every slot named by `uninitializedLocalSlots`
> (`src/bytecode/register/interpreter/frame.ts:63-67`, [Ch 20 § tdz-is-a-value-not-a-flag]);
> `BaselineCompiler.generateBody`'s prologue (`src/optimizing/baseline/compiler.ts:148`) has no
> equivalent and fills every slot with `$.u`. So a baseline-compiled function that reads such a
> slot answers `undefined` where the interpreter throws. tera spells neither `let` nor `const`
> ([Ch 2 § declaring-a-name]), which is what makes this look unreachable — but
> `_declareLocal` defaults to `"let"` (`src/bytecode/register/compiler/scope.ts:139`) and
> `setLocalBindingKind` adds every `"let"`, `"const"` and `"class"` slot to the set
> (`src/bytecode/register/ops/bytecode.ts:554-558`), so an ordinary **type-annotated**
> declaration lands there. Measured 2026-09-08 by instrumenting `generateBody` over all 22
> `.tera` files under `docs/example/` and `examples/`: two of them baseline-compile a function
> with a non-empty set — `stats-closure.tera`'s `<script>` (slots 0 and 1, `values` and
> `scaled`) and `stats-deopt.tera`'s `<script>` (slot 0, `clean`) — all three of them
> `name: type = value` declarations. On an eight-line probe that reads such a slot on a branch
> above its declaration, `--no-opt` prints `Cannot access 'y' before initialization` and exits
> 1 while `--baseline-threshold 1 --opt-threshold 1000000 --no-osr` prints `undefined` and
> exits 0. Cost of fixing: emit a `TDZ` fill in the prologue for
> `compiledFn.uninitializedLocalSlots`, or add those slots to `compile`'s refusal scan.
> [unpinned]

Neither divergence is caught by anything that names either file. The register-count half would
surface only indirectly, as an OSR or GC-roots end-to-end failure; the TDZ half surfaces as a
wrong answer and no failure at all.

## Tagged arithmetic

Here is the emitted `ADD`, one line in the source and one line in the output:

```ts
      case bytecode.ROP_ADD:
        return `t=r[${o[0]}];if((acc&${TAG_MASK})===0&&(t&${TAG_MASK})===0){t2=acc+t;if(t2>=${TAGGED_SMI_MIN}&&t2<=${TAGGED_SMI_MAX})acc=t2;else acc=$.add(acc,t,${o[1]});}else{acc=$.add(acc,t,${o[1]});}`;
```
— `src/optimizing/baseline/compiler.ts:222-223`

and, substituted, from `mean`'s bytecode 24 (`Add r2 r6`):

```
case 24:t=r[2];if((acc&15)===0&&(t&15)===0){t2=acc+t;if(t2>=-17179869184&&t2<=17179869168)acc=t2;else acc=$.add(acc,t,6);}else{acc=$.add(acc,t,6);}
```
— generated by `src/optimizing/baseline/compiler.ts:222-223`

There is no untagging in that line, and that is the point.

> **New idea. Adding without unwrapping.** [Ch 22 § four-bits-inside-a-double] established
> the representation: every runtime value is a JavaScript number whose low four bits are a
> type code, and `CODE_SMI` is `0`. So a tagged small integer is exactly `payload × 16` — the
> code contributes nothing, because the code is zero. Now write out the sum of two of them:
> `(a × 16) + (b × 16)` is `(a + b) × 16`, which is *the tagged form of `a + b`*. The
> arithmetic and the tagging distribute over each other. Nothing has to be unwrapped, added,
> and wrapped again; the tagged values can be added directly and the answer is already
> tagged. This works because multiplication by a positive constant is the tagging, and
> addition is linear. It is the single reason `CODE_SMI === 0` rather than some other value,
> and it is why [Ch 22]'s tag table is not an arbitrary ordering.

The emitted code therefore has three parts.

**The tag test.** `(acc&15)===0 && (t&15)===0` asks whether both operands are Smis, in two
mask-and-compare operations. `TAG_MASK` is `0xf` (`src/core/value/index.ts:46`). The
interpreter asks the same question through `areBothSmi`, which folds it into one `|` and one
`&` ([Ch 21 § fast-and-slow-paths-on-rop_add]); the generated code spells it out because a
helper call would defeat the purpose.

**The raw add.** `t2 = acc + t`. One host addition on two ordinary JavaScript numbers.

**The range check.** `t2 >= -17179869184 && t2 <= 17179869168`. Those constants are
`TAGGED_SMI_MIN` and `TAGGED_SMI_MAX` — `SMI_MIN × 16` and `SMI_MAX × 16`
(`compiler.ts:18-19`), which is `-0x40000000 × 16` and `0x3fffffff × 16`. The check is
performed *in tagged space*, on the already-tagged sum, so it too needs no shifting. If it
fails, the sum has overflowed the Smi range and the slow path `$.add` re-does the addition
properly, producing a heap double
[t: `tests/optimizing/baseline/runtime.test.ts > "smi + smi → smi when result fits"`,
`> "smi + smi → double on overflow"`].

Subtraction is identical with a `-` (`compiler.ts:225-226`), for the same reason: subtraction
is linear too.

Comparison needs even less, because it needs no arithmetic at all:

```ts
      case bytecode.ROP_LT:
        return `t=r[${o[0]}];if((acc&${TAG_MASK})===0&&(t&${TAG_MASK})===0)acc=acc<t?$.t:$.f;else acc=$.cmp(acc,t,0,${o[1]});`;
```
— `src/optimizing/baseline/compiler.ts:243-244`

`acc < t` on two tagged Smis is `(a × 16) < (b × 16)`, and multiplying both sides of an
inequality by a positive constant preserves it. So the tagged comparison *is* the payload
comparison, with no adjustment. `$.t` and `$.f` are pre-made tagged booleans held on the
runtime object (`runtime.ts:197-198`), so even the answer costs no allocation. `EQ` and `NEQ`
follow the same shape with `===` and `!==` (`compiler.ts:237-241`) — two tagged values are
strictly equal exactly when their tags and payloads are, which for two Smis is one number
comparison
[t: `tests/optimizing/baseline/runtime.test.ts > "eq: null === undefined → false (strict equality does not conflate them)"`].

## Why multiplication cannot

Multiplication breaks the trick, and the way it breaks it is instructive.

`(a × 16) × (b × 16)` is `a × b × 256`, not `a × b × 16`. The tag factor appears twice, so
the product of two tagged Smis is the tagged product *scaled by another sixteen*, which is not
a valid tagged value. Multiplication is not linear, and the tagging is a linear map.

So `MUL` has to untag, and once it has untagged it has to retag:

```ts
      case bytecode.ROP_MUL:
        return `t=r[${o[0]}];if((acc&${TAG_MASK})===0&&(t&${TAG_MASK})===0){t2=(acc/${TAG_SHIFT_MULT})*(t/${TAG_SHIFT_MULT});if((t2|0)===t2&&t2>=${SMI_MIN}&&t2<=${SMI_MAX}&&(t2!==0||1/t2>0))acc=t2*${TAG_SHIFT_MULT};else acc=$.mul(acc,t,${o[1]});}else{acc=$.mul(acc,t,${o[1]});}`;
```
— `src/optimizing/baseline/compiler.ts:228-229`

Two divisions, a multiply, four guards, and a multiply back. Compare that to `ADD`'s one
addition and two comparisons: seven operations against three, and the inline path no longer
avoids the untag it was invented to avoid. Nothing in this tree measures whether the `MUL`
path still pays for itself; `DIV` and `MOD` do not attempt one at all and go straight to
`$.div` / `$.mod` (`compiler.ts:231-235`).

Three of the four guards are the ones you would predict. `(t2|0) === t2` asks whether the
product is a 32-bit integer at all; the `SMI_MIN` / `SMI_MAX` pair asks whether it fits the
30-bit Smi range. The fourth is the interesting one: `(t2!==0||1/t2>0)`.

> **New idea. There are two zeros.** IEEE-754 stores a sign bit separately from the
> magnitude, so `-0` and `+0` are distinct bit patterns. They compare equal — `-0 === 0` is
> `true`, which is why the guard cannot just test `t2 !== -0` — and the only way to tell them
> apart in JavaScript is by division: `1 / -0` is `-Infinity` and `1 / +0` is `+Infinity`.
> Multiplication produces `-0` readily: `-1 * 0` is `-0`, and so is `0 * -5`. Now tag it.
> `-0 × 16` is `-0`, and a tagged value is a number whose low nibble is a type code — but
> `-0` has the same low nibble as `+0`, and `getPayload` on it yields `-0 / 16`, which is
> `-0` again. Nothing is lost at the tagging step; what is lost is that `mkSmi` would have
> stored it as the integer `0`, sign gone forever. [Ch 22 § negative-zero-comes-first] shows
> the same test as the *first* line of `mkNumber`, for the same reason: run the range check
> first and `-0` becomes `+0` before anyone can object.

So the guard sends `-0` to the slow path, where `$.mul` calls `mkNumber` (`runtime.ts:552`),
which recognises negative zero and keeps it on the heap as a real double.

The general rule this earns: **a fast path may only skip work it can prove is redundant, and
the sign of zero is not redundant.** Every one of the four guards on `MUL` is there because
some input makes the fast answer differ from the slow one, and a fast path that differs from
the slow path for even one input is not a fast path, it is a bug with better timing
[t: `tests/optimizing/baseline/runtime.test.ts > "mul: smi * smi → smi when fits"`].

## The five refusals

`compile` declines rather than mis-compiles. Its refusals, in the order they are checked
(`src/optimizing/baseline/compiler.ts:59-82`):

1. **An empty instruction list** — `instrs.length === 0`
   [t: `tests/optimizing/baseline/compiler.test.ts > "rejects empty instructions"`].
2. **More than `MAX_BASELINE_INSTRUCTIONS`** — 1000 (`compiler.ts:33`)
   [t: `tests/optimizing/baseline/compiler.test.ts > "rejects functions with > 1000 instructions"`].
   The limit is on the emitted string's size, indirectly: every bytecode becomes one `case`
   and some become two hundred characters.
3. **Any of `ROP_TRY_START` / `ROP_TRY_END` / `ROP_THROW`**
   [t: `tests/optimizing/baseline/compiler.test.ts > "rejects functions containing try/throw"`].
4. **Any of `ROP_CALL_SPREAD` / `ROP_REST_ARGS` / `ROP_SPREAD_ARRAY` /
   `ROP_DEFINE_ACCESSOR` / `ROP_ASSERT_CLASS_CONTRACTS`**
   [t: `tests/optimizing/baseline/compiler.test.ts > "rejects functions containing spread/rest/defineAccessor"`].
   Four of those five are spread, rest and accessor opcodes; the fifth,
   `ROP_ASSERT_CLASS_CONTRACTS`, is none of the three and sits in the list with them.
5. **An unhandled opcode**, which makes `emitOp` fall to `default: return null`
   (`compiler.ts:455-456`) and propagates out of `generateBody` (`:161`) and out of `compile`
   (`:82`).

And a sixth that is not a refusal but a catch: `new Function` throwing, handled at
`compiler.ts:127-131`.

Read those five against the rest of the tree and the layering is stranger than it looks.
`emitOp` returns `null` for `ROP_TRY_START`, `ROP_TRY_END` and `ROP_THROW` at
`compiler.ts:450-453`, so refusal 3 is already implied by refusal 5. `ROP_DEFINE_ACCESSOR`
and `ROP_ASSERT_CLASS_CONTRACTS` have no `emitOp` case at all, so half of refusal 4 is
implied by refusal 5 too. And one level further out, `requiresInterpreterOnly`
(`src/bytecode/register/interpreter/helpers.ts:82-89`) vetoes any function containing
`ROP_TRY_START`, `ROP_TRY_END`, `ROP_THROW` or `ROP_ASSERT_CLASS_CONTRACTS` *before*
`baselineCompile` is ever called (`interpreter/index.ts:1011` and `:515`), so those four
opcodes are refused three separate times by three separate mechanisms.

Which leaves exactly three opcodes for which the up-front scan is load-bearing —
`ROP_CALL_SPREAD`, `ROP_REST_ARGS` and `ROP_SPREAD_ARRAY` — and they are load-bearing
precisely because `emitOp` *can* compile them:

> **Dead.** `BaselineCompiler.emitOp` has working cases for `ROP_REST_ARGS`
> (`src/optimizing/baseline/compiler.ts:432-433`), `ROP_SPREAD_ARRAY` (`:435-436`) and
> `ROP_CALL_SPREAD` (`:444-445`), emitting `$.restArgs`, `$.spreadArray` and `$.callSpread`.
> `compile`'s second opcode scan (`:70-80`) refuses any function containing one of those
> three before `generateBody` runs, so none of the three cases can ever execute, and the three
> `BaselineRuntime` methods behind them (`runtime.ts:1039`, `:1047` and `:1076`)
> are unreachable from baseline code. This is a decision recorded twice in opposite
> directions. Cost of resolving: delete three `case` arms and three runtime methods, or delete
> three names from the refusal list and find out whether the emitters are correct.

The design rule the refusals share with [Ch 56 § refusing-well] is the one that makes a
tiering engine possible at all: **returning `null` costs one interpreted execution; guessing
costs correctness.** A tier that can decline is allowed to be incomplete. That is the whole
reason there can be four of them.

## The runtime surface

Every emitted line is one of two things: an operation on tagged values the host can do
directly, or a one- or two-character call into `BaselineRuntime` through `$`. Reading
`mean`'s body top to bottom, the entire non-inline half is `$.c`, `$.gp`, `$.gi`, `$.cmp`,
`$.toBool`, `$.branch`, `$.add`, `$.div`, `$.backEdge`, `$.u` and `$.enter` / `$.leave`.

The surface groups into six families:

| family | members | what they answer |
| --- | --- | --- |
| constants | `u` `n` `t` `f` `c` `wc` | pre-made undefined/null/true/false; decoded constants |
| globals | `lg` `sg` | read and write a global cell |
| properties | `gp` `sp` | named property load and store |
| elements | `gi` `si` | indexed load and store |
| arithmetic | `add` `sub` `mul` `div` `mod` `eq` `neq` `cmp` `not` `neg` `bitand` … `pow` | every slow path the inline fast paths fall out of |
| frames and calls | `enter` `leave` `backEdge` `invokeCall` `invokeCall0/1/2` `callMethod` `rcn` `closure` `loadUpvalue` `storeUpvalue` | everything that touches a frame or crosses one |

The names are not laziness. Every one of these appears once per emitted instruction, in a
string the host must parse before it can run anything, and a function at the 1000-instruction
limit emits thousands of them. `gp` instead of `getProperty` is 12 characters saved per
property access. It is the same reasoning that produces minified JavaScript, applied by a
compiler to its own output — and it is worth noting that nothing measures whether it matters,
because there is no benchmark harness in this tree.

One duplication inside the surface is worth a sentence, because a reader will trip on it.
Binary feedback is recorded by two nearly identical methods: `rfb` (`runtime.ts:998-1003`),
called by `add`, `sub`, `mul`, `div`, `mod`, `eq`, `neq` and `cmp`, and `_recordBinaryFb`
(`:767-772`), called by the nine bitwise and `pow` and `instanceof` and `in` methods. They
differ in one condition — `_recordBinaryFb` skips when `fbSlot < 0`, `rfb` does not — which is
harmless today only because `FeedbackVector.getSlot` (`src/feedback/vector/index.ts:824-826`)
is a bare array index and `slots[-1]` is `undefined`.

## Three caches in front of a cache

[Ch 34] built an `InlineCacheManager`: one `InlineCache` per site key, each a chain of
handlers that re-check map id, map version and deprecation on every hit. `BaselineRuntime`
uses it — and puts three of its own caches in front of it.

**Constants.** `c(idx)` memoises the decoded tagged value per constant-pool index, and pins
the heap slot so the collector cannot sweep something that is reachable only from a plain
array on the runtime object (`runtime.ts:228-236`;
[Ch 32 § case-the-baseline-accumulator] takes the pinning apart)
[t: `tests/optimizing/baseline/runtime.test.ts > "c() caches constants — same index returns same tagged value"`,
`> "wraps integer constants beyond the smi range without truncating"`].

**Globals.** `lg(nameIdx)` caches `{cell, writeCount, value}` per constant index and validates
by comparing the cell's write counter:

```ts
  lg(nameIdx: number) {
    const name = constantString(this.consts, nameIdx);
    const cached = this.globalCaches[nameIdx];
    if (cached && cached.cell.writeCount === cached.writeCount)
      return cached.value;
```
— `src/optimizing/baseline/runtime.ts:238-242`

`GlobalCell.write` increments `writeCount` on every write (`src/runtime/intrinsics/global-cells.ts:48-49`),
so a write from *anywhere* — another baseline function, the interpreter, an intrinsic —
invalidates the cache without knowing it exists. `sg` also nulls its own entry by hand
(`runtime.ts:259`), which is belt and braces: the version check would have caught it.

**Properties.** `loadCaches` and `storeCaches` are arrays indexed by *feedback slot*, each
holding `{hiddenClassId, version, offset}`, validated by three comparisons:

```ts
      const cached = this.loadCaches[fbSlot];
      if (
        cached &&
        jsObj.hiddenClass.id === cached.hiddenClassId &&
        jsObj.hiddenClass.version === cached.version &&
        !jsObj.hiddenClass.isDeprecated
      ) {
        if (cached.offset < 10) {
          const slotValue = jsObj.slots[cached.offset];
          const val = typeof slotValue === "number" ? slotValue : undefined;
          return val !== undefined ? val : this.u;
        }
```
— `src/optimizing/baseline/runtime.ts:285-296`

Those are the same three checks `FieldHandler.matches` makes in [Ch 34 § what-each-handler-verifies],
and the `offset < 10` split is the same inline-slots-versus-overflow-map split
[Ch 23 § ten-in-object-slots] established. Why does this exist when the shared IC already does it?
Because the shared IC is a string key, a `Map` lookup, a chain walk and a virtual `matches`
call, and this is one array index. The accessor early-outs above it (`runtime.ts:271-284`) are
what make the fast path safe: an accessor property, or an absent property with a prototype,
bails to `runtimeGetProperty` before the cache is consulted at all.

The cost is a fourth independent statement of the map-version protocol, in a file that imports
none of the other three, kept in step by nothing.

> **Unfinished.** `BaselineRuntime.gp`'s cache hit reads a slot and filters it with
> `typeof slotValue === "number" ? slotValue : undefined`, then answers `$.u` when that is
> `undefined` (`src/optimizing/baseline/runtime.ts:293-295`, and the same shape at `:297-299`
> for the overflow map). Tagged values *are* JavaScript numbers, so the filter is testing the
> representation rather than the program — but its failure mode is wrong for a cache. A slot
> holding something that is not a number means the cache's assumption about the object's
> layout is broken, and the correct response is to fall through to the slow path and re-look
> it up. Instead the method substitutes `undefined`, which is a value the program can observe.
> Cost of fixing: replace the two `return`s with a fall-through to the `icManager` lookup
> eight lines below. [unpinned]

## Where feedback comes from here

The baseline is a full feedback citizen. Every recorder [Ch 33] described has a caller in
`BaselineRuntime`:

- `gp` and `sp` call `slot.recordPropertyAccess` (`runtime.ts:310` and `:387`), including the
  prototype-depth variant (`:324`);
- `gi` calls `slot.recordIndexedAccess` (`:445`) and `si` calls `slot.recordArrayAccess`
  (`:491` and again at `:506` after the integer-index check) — two different recorders for the
  two directions of the same site;
- `rfb` and `_recordBinaryFb` call `slot.recordBinaryOp` (`:1001`, `:770`);
- `invokeCall` calls `slot.recordCallTarget` (`:801` and `:809`) and `slot.recordReturnType`
  (`:823`);
- `branch` calls `slot.recordBranch` (`:777`).

The last of those is the one that matters, because **nothing else in the engine ever calls
`recordBranch`.** Grepping `src/` finds the definition in
`src/feedback/vector/index.ts:259` and exactly one call site,
`src/optimizing/baseline/runtime.ts:777`. The interpreter's `ROP_JUMP_IF_FALSE` and
`ROP_JUMP_IF_TRUE` cases do not record which way a branch went; the baseline's emitted
versions do:

```
case 14:if(!$.toBool(acc)){$.branch(3,true);pc=32;continue L;}$.branch(3,false);
```
— generated by `src/optimizing/baseline/compiler.ts:267-270`, from `mean`'s bytecode 14

[t: `tests/optimizing/baseline/runtime.test.ts > "records a taken branch as taken"`,
`> "reports an evenly split branch as mixed"`]

The consequence reaches a long way forward. [Ch 46 § loop-shape]'s `hotSuccessorOf` asks a
feedback slot which way a branch usually goes, and gets an answer only for functions that
spent time in baseline-compiled code. So `--always-opt`'s `baselineThreshold: 2` is not a
rounding choice about warm-up; it is what makes branch bias *exist at all* for a function that
would otherwise have gone interpreter → JIT with the branch slots untouched
([Ch 35 § why-not-one]).

Then the counter-fact, which points the other way. `invokeCall0`, `invokeCall1` and
`invokeCall2` try `fastOptimizedCall` and `fastBaselineCall` *first*, and only fall back to
`invokeCall` — the one that records — if both decline:

```ts
  invokeCall1(callee: TaggedValue, a0: TaggedValue, fbSlot: number) {
    const optimized = this.fastOptimizedCall(callee, [a0]);
    if (optimized !== null) return optimized;
    const fast = this.fastBaselineCall(callee, 1);
    if (fast) return fast(a0, this.u, this.interp);
    return this.invokeCall(callee, [a0], this.u, fbSlot, null);
  }
```
— `src/optimizing/baseline/runtime.ts:840-846`

Neither fast path records a call target, a return type, or an IC hit. So the hotter a call
site becomes — the more likely its callee already has baseline or optimized code — the *less*
feedback it produces about itself. A monomorphic call site that warms up quickly can end up
with a call slot that saw the callee two or three times and then went quiet, which is exactly
the shape [Ch 34 § calls-and-the-dependency-bridge]'s `SETTLED_CALL_THRESHOLD` is counting
towards. Nothing in the tree flags the interaction.

## The fast call path is also a tier-up site

`fastBaselineCall` looks like a lookup and is not. It has five refusals and one side effect:

```ts
    fn.compiled.invocationCount = (fn.compiled.invocationCount || 0) + 1;
    if (
      this.interp.tieringPolicy &&
      fn.compiled.invocationCount === this.interp.tieringPolicy.jitThreshold &&
      !fn.compiled.optimizedCode &&
      !fn.compiled.disableOptimization &&
      this.interp.jitEngine &&
      typeof this.interp.jitEngine.optimizeFunction === "function"
    ) {
      this.interp.jitEngine.optimizeFunction(fn.compiled);
      if (fn.compiled.optimizedCode) {
        return null;
      }
    }
```
— `src/optimizing/baseline/runtime.ts:930-943`

It refuses a constructor, a closure (`fn.closure` — the `_call*` wrappers pass `null` for the
environment, so a closure cannot be entered through them), a callee whose
`disableOptimization` is set, a callee with no `baselineCode`, and a callee containing
`ROP_CALL_METHOD` (`hasMethodCalls`, `:923`). Then it **increments the callee's
`invocationCount` and may promote it to the JIT** — so a function can be tiered up by a caller
that is about to return through it, without the interpreter's `execute` or `tryTierUp` ever
being involved. It is a third tier-up site, alongside the two [Ch 35 § the-two-policies]
described, and it consults no policy method and prints no trace line.

The comparison is `===`, not `>=`. That is not sloppiness — an inequality here would call
`optimizeFunction` on every call after the threshold, and the guards below it
(`!optimizedCode`) would stop the compile but not the check. The equality means **exactly one
attempt, ever, from this path**: if the compile fails, the counter has already moved past
`jitThreshold` and this site will never ask again. Recovery, if there is any, comes from
`execute` or `tryTierUp`, whose comparisons *are* `>=`.

And when the compile succeeds, `fastBaselineCall` returns `null` — declining its own fast
path so that the caller falls through to `invokeCall`, which reaches
`interp.callFunctionValue` and dispatches to the freshly installed optimized code.

> **Dead.** `BaselineCode._call3` is created in `compile` (`src/optimizing/baseline/compiler.ts:116-124`)
> and returned by `fastBaselineCall`'s `case 3:` arm (`runtime.ts:951-952`), but
> `fastBaselineCall`'s only callers are `invokeCall0`, `invokeCall1` and `invokeCall2`
> (`:835`, `:843`, `:851`), which pass argument counts 0, 1 and 2. A three-argument `ROP_CALL`
> is emitted as the generic `$.invokeCall(callee,[a,b,c],$.u,slot,null)` array path
> (`compiler.ts:292-297`). The `case 3:` arm and the `_call3` wrapper never run. Outside its
> declaration (`src/bytecode/register/ops/bytecode.ts:146`) and the type alias
> `BaselineCall3` (`runtime.ts:131`), the only thing that mentions `_call3` anywhere is
> [t: `tests/optimizing/baseline/compiler.test.ts > "creates fast-call variants (_call0, _call1, _call2, _call3)"`],
> which asserts it exists. Cost of closing the gap: an `invokeCall3` in the runtime and one
> more branch in `emitOp`'s `ROP_CALL` case.

## Two things generated code must do by hand

The interpreter gets two services from being an ordinary object graph inside an ordinary
interpreter loop. Generated JavaScript gets neither, and has to re-implement both.

**Roots.** An interpreter frame is a `RegisterFrame` object; the collector walks its
`registers` array and its `acc` field because they are fields. A baseline frame's registers
live in a plain JavaScript array — passable, because an array is an object — but its
accumulator and four temporaries live in `var` declarations inside a host function, and there
is no way to hand a JavaScript local variable to anything. Passing `acc` passes its value *at
that moment*; the collector needs its value at collection time, which is later.

So the prologue exports a *reader*:

```
$.enter(r,function(){return[acc,t,t2,t3,t4,osr];});
```
— generated by `src/optimizing/baseline/compiler.ts:155`

`ROOTED_LOCALS` is `["acc", ...SCRATCH_LOCALS]` (`compiler.ts:34-35`) and the closure returns
exactly those names. `BaselineRuntime.enter` pushes `{registers, readLocals}` onto
`interp.baselineFrames` (`runtime.ts:404-406`); `leave` pops it in the `finally`
(`:408-410`); `visitFrameRoots` calls the closure on every walk
(`src/gc/roots.ts:81`). [Ch 32 § case-the-baseline-accumulator] tells this from the
collector's side, including what it costs — one closure call and one six-element allocation
per live baseline frame per collection, unmeasured. Delete the closure and every value that
lives only in `acc` between two allocations is swept
[t: `tests/e2e/optimizing/gc-roots.test.ts > "keeps an object held only in a baseline register alive across allocation"`,
`> "keeps an array held only in a baseline register alive across allocation"`,
`> "keeps a string held only in a baseline register alive across allocation"`,
`> "keeps a nested object reachable after a nested allocation"`].

> **Unenforced.** Nothing checks that every `var` `generateBody` declares appears in
> `ROOTED_LOCALS`. The prologue emits `var acc,${SCRATCH_LOCALS.join(",")},sp=0`
> (`src/optimizing/baseline/compiler.ts:146`) and the closure emits `ROOTED_LOCALS`
> (`:155`) — two expressions over two constants, related by a spread and by nothing a compiler
> or a test can see. Adding a sixth scratch temporary to the prologue and forgetting it here
> produces an unrooted slot, which is exactly the use-after-free the four `gc-roots` tests
> exist to catch, and they would catch it only if a value happened to live in *that*
> temporary across an allocation. Note that `sp` is deliberately excluded and must stay
> excluded: it is a plain counter, not a tagged value. Cost of enforcing: emit the prologue
> from `ROOTED_LOCALS` instead of from `SCRATCH_LOCALS`.

**Safepoints.** The interpreter reaches `onBackEdge` on every backward jump because `runFrame`
tests `target < frame.pc` on every jump ([Ch 35 § one-hook-two-jobs]). Generated code has no
such loop, so the compiler emits the counter itself, at compile time, before every backward
jump and only before backward ones:

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

`target > from` returns the empty string, so a forward jump gets nothing at all — the check is
static, which is the one thing generated code can do that an interpreter cannot. For `mean`
the single back edge produces:

```
case 31:if(++sp>=1024){sp=0;osr=$.backEdge(4,r,tv,env,28);if(osr!==null)return osr;}pc=4;continue L;
```
— generated by `src/optimizing/baseline/compiler.ts:44-52` and `:264-265`

with the loop span 28 that [Ch 35 § the-budget-is-not-a-counter] computed by hand from the
disassembly. `sp` is declared in the prologue, so it counts per invocation, not per function —
a consequence [Ch 35 § the-baseline-polls-differently] takes apart — and `if(osr!==null)return
osr;` is the whole of the baseline's participation in on-stack replacement, which is
[Ch 37 § the-baseline-side].

The general rule both halves teach: **leaving an abstraction gets you the host's compiler and
takes away everything the abstraction was doing for you, item by item, and it does not tell
you which items.** The interpreter was rooting the accumulator and polling the back edges. Neither is
visible in a list anywhere; both were discovered by their absence.

## What leaves

`compiledFn.baselineCode` — a JavaScript function with `_isBaseline` set, four fast entry
points `_call0` … `_call3` attached (of which three are reachable), closed over one
`BaselineRuntime` instance that holds this function's constant cache, global caches and
property caches. `callMode` is updated to `CALL_BASELINE`, which as
[Ch 35 § callmode] established nothing reads; the dispatch that actually happens is
`callFunction`'s bare `if (compiled.baselineCode)` at
`src/bytecode/register/interpreter/index.ts:631`.

The generated function writes into the *same* `FeedbackVector` the interpreter was writing
into, so [Ch 39 § one-walk-no-dominators] and the speculation chapters after it cannot tell which tier
filled a slot — with one exception, branch bias, which only this tier records.

And it carries, before every backward jump and only before backward ones, the emitted line
`if(++sp>=1024){sp=0;osr=$.backEdge(target,r,tv,env,loopSpan);if(osr!==null)return osr;}`.
That line is [Ch 37]'s entry point: it is where a baseline frame asks whether the loop it is
running should be replaced by compiled code, and it is the only place in generated JavaScript
where the engine can take the frame away.

## Verify it yourself

```bash
# the 43 bytecodes generateBody walks
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# all three of the example's compiled functions reach baseline; none reaches wasm
node dist/cli.js --always-opt --trace-opt docs/example/stats.tera

# baseline then wasm for report, in one run
node dist/cli.js --baseline-threshold 1 --opt-threshold 2 --trace-opt docs/example/stats-poly.tera

# the generated JavaScript for Series.mean - no CLI flag prints it, so patch generateBody
node --input-type=module -e "
import { Engine } from './dist/index.node.js';
import fs from 'node:fs';
const e = new Engine({ output: () => {}, tieringPolicy: { baselineThreshold: 1, jitThreshold: 1e12 } });
const bc = e.baselineCompiler, gen = bc.generateBody.bind(bc);
bc.generateBody = (cf) => { const s = gen(cf); if (cf.name === 'mean') console.log(s); return s; };
e.run(fs.readFileSync('docs/example/stats.tera', 'utf8'));
"

# the TDZ divergence. Save these eight lines as tdz.tera outside the repository -
# with your editor, not a shell heredoc. The blank line is load-bearing:
#   fn f(b: bool) -> int:
#     if b:
#       return y
#     y: int = 5
#     return y
#   <blank>
#   print(f(false))
#   print(f(true))
# the interpreter throws and exits 1; baseline prints undefined and exits 0
node dist/cli.js --no-opt tdz.tera
node dist/cli.js --baseline-threshold 1 --opt-threshold 1000000 --no-osr tdz.tera

# the emitted shapes, asserted on generateBody's string directly (28 tests)
npx vitest run --project unit tests/optimizing/baseline/compiler.test.ts

# the runtime behind $ (57 tests)
npx vitest run --project unit tests/optimizing/baseline/runtime.test.ts

# delete the readLocals closure and these fail (9 tests)
npx vitest run --project e2e tests/e2e/optimizing/gc-roots.test.ts
```

The fourth command is the only way to see this chapter's central artifact. Run it and the
listings in § a-frame-the-interpreter-would-recognise, § tagged-arithmetic,
§ where-feedback-comes-from-here and § two-things-generated-code-must-do-by-hand are lines 1-7,
`case 24`, `case 14` and `case 31` of its output.

## Tests that pin this

- `tests/optimizing/baseline/compiler.test.ts > "generates switch/case dispatch loop"` — the
  `L:while(1){switch(pc){` skeleton.
- `tests/optimizing/baseline/compiler.test.ts > "emits jump as pc assignment + continue"` —
  goto in a language without goto.
- `tests/optimizing/baseline/compiler.test.ts > "emits conditional branch for JUMP_IF_FALSE"`.
- `tests/optimizing/baseline/compiler.test.ts > "emits SMI fast path for ADD with tag check"`
  — the tag test, asserted on the emitted string.
- `tests/optimizing/baseline/compiler.test.ts > "emits return acc for ROP_RETURN"`.
- `tests/optimizing/baseline/compiler.test.ts > "rejects empty instructions"`,
  `> "rejects functions with > 1000 instructions"`,
  `> "rejects functions containing try/throw"`,
  `> "rejects functions containing spread/rest/defineAccessor"` — four of the five refusals.
  The fifth, an unhandled opcode reaching `emitOp`'s `default`, is `[unpinned]`.
- `tests/optimizing/baseline/compiler.test.ts > "compiles functions containing ROP_CALL_METHOD"`
  — method calls are compiled, even though `fastBaselineCall` refuses callees that contain
  them.
- `tests/optimizing/baseline/compiler.test.ts > "compiles closures with upvalues"` and
  `> "compiles closure bodies that require a closure environment"` — the `_ouv` / `_ce` pair.
- `tests/optimizing/baseline/compiler.test.ts > "compiles simple return-constant function and returns callable with _isBaseline flag"`
  — the artifact that leaves this chapter.
- `tests/optimizing/baseline/compiler.test.ts > "creates fast-call variants (_call0, _call1, _call2, _call3)"`
  — the only exercise `_call3` gets, and the reason its honesty item is fact.
- `tests/optimizing/baseline/compiler.test.ts > "wraps the answer of a call in tail position, which never reaches ROP_RETURN"`
  — `returnExpression` and `declaredInt32Return`, applied where a tail call would otherwise
  skip the `-> int` wrap.
- `tests/optimizing/baseline/runtime.test.ts > "smi + smi → smi when result fits"` and
  `> "smi + smi → double on overflow"` — both sides of the range check.
- `tests/optimizing/baseline/runtime.test.ts > "mul: smi * smi → smi when fits"` — the only
  test of the multiplication fast path; the negative-zero guard specifically is `[unpinned]`.
- `tests/optimizing/baseline/runtime.test.ts > "c() caches constants — same index returns same tagged value"`
  and `> "wraps integer constants beyond the smi range without truncating"`.
- `tests/optimizing/baseline/runtime.test.ts > "records a taken branch as taken"` and
  `> "reports an evenly split branch as mixed"` — the branch bias only this tier produces.
- `tests/optimizing/baseline/runtime.test.ts > "eq: null === undefined → false (strict equality does not conflate them)"`
  — the inline `===` on two tagged values is real strict equality.
- `tests/e2e/optimizing/gc-roots.test.ts > "keeps an object held only in a baseline register alive across allocation"`,
  `> "keeps an array held only in a baseline register alive across allocation"`,
  `> "keeps a string held only in a baseline register alive across allocation"`,
  `> "keeps a nested object reachable after a nested allocation"` — the four that fail if the
  `readLocals` closure is deleted.
- `tests/e2e/gc/heap-payload-sweep.test.ts > "keeps the slab bounded once the loop runs in baseline-compiled code"`
  — the emitted safepoint, from the collector's side.
- The register-compatibility invariant is `[unpinned]`: no test compares a baseline frame's
  layout to a `RegisterFrame`'s directly, and the two are built by unrelated files.
- `tests/bytecode/register/interpreter/frame.test.ts > "marks uninitializedLocalSlots with TDZ sentinel"`
  and `> "getReg throws on TDZ-uninitialized slot"` — the interpreter half of the divergence,
  and the only half anything pins. Every `tests/` hit for `uninitializedLocalSlots`,
  `TDZ_UNINITIALIZED` or `before initialization` is under `tests/bytecode/register/`; nothing
  runs the same before-initialization read through baseline-compiled code, so the divergence
  itself is `[unpinned]`.
