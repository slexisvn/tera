# 33. Feedback: what the interpreter learns   ⟨I · B · J⟩

Every opcode in the running example that could possibly benefit from knowing what it saw
last time already carries an extra integer. `LdaNamedProperty r4 [1] (values) r0` has three
operands and only two of them are what they look like. The last one is not a register; it
is a *slot number*, handed out by a counter at bytecode-generation time, and it is the
address of a small mutable record where the interpreter writes down what actually showed up
at that program point.

The reason this exists is not the interpreter's. The interpreter never reads a feedback
slot to decide anything — it already has the value in front of it, and it can always ask
the object directly. The reader is the optimizing compiler, three tiers away, which will
never see the program run. When [Ch 49 § speculative-taint] emits a load at a fixed offset
instead of a hash lookup, it is emitting code that is *wrong* unless every receiver at that
site really does have the map the interpreter wrote down. So the whole of this chapter is
one machine writing evidence for another machine that has not started yet, and the shape of
that evidence is the shape of what the JIT is later allowed to guess.

Three things decide that shape. Slots are allocated as trailing operands, in emission order,
by a counter with no table behind it. They are *typed* on first entry to the function by a
separate pass that walks the instruction stream and reads each opcode's slot index from a
position it has hard-coded — a correspondence nothing checks. And each slot's state moves
through a four-point order that only ever goes up, so a site that was briefly confusing
during warm-up is confusing for the rest of the process.

**What arrived.** From [Ch 32 § what-leaves], three artifacts: the interpreter's answer
(`latency mean=15.70` / `throughput mean=898.19`, the oracle every other tier is measured
against), a filled `feedbackVector` on every function that ran together with warm
`InlineCacheManager` entries, and a per-function tier verdict from
`requiresInterpreterOnly`. Nothing has read the feedback. This chapter is what put it there
and what its shape means; [Ch 34] is the cache that sits beside it.

## The question a guess answers

`Series.mean` reads `this.values` on every entry to its loop test. In the interpreter that
read costs a hash lookup on a `HiddenClass`, a descriptor, a `kind` check, and an offset
into a `slots` array — the thirteen-step sequence of [Ch 24 § lda-prop-the-sequence-in-order]. In compiled code it
could cost one indexed load, if the compiler knew the receiver's map. It does not know. The
source says `s: Series`, which the checker believes, but the checker's `Series` is a *shape*
([Ch 12 § new-idea-a-shape]) and shapes do not pin an object's runtime map: two classes with
the same members are mutually assignable, and `stats-poly.tera` has exactly two.

There are two ways out of that, and tera takes both, in different tiers.

The ahead-of-time compiler proves. It runs the checker in strict mode, refuses the program
if the fact will not come out, and when it does come out it flattens the object into a
static layout with no map at all ([Ch 58 § one-layout-per-class]). It never asks what
happened at run time because there is no run time to ask about — the binary is produced
before the program has ever executed.

The optimizing JIT guesses. It looks at what happened, compiles code that is only correct if
that keeps happening, and inserts a guard that checks the assumption on entry. If the guard
fails the compiled code is abandoned mid-flight and execution resumes in the interpreter
([Ch 54 § deoptimizing-out-of-wasm]). That is the licence the JIT has and the native
compiler does not, and it is why the JIT can emit code a compiler that only knows what the
source says is not allowed to emit: most facts that are *true* about a running program are
not *provable* from its text.

> **New idea. Profile-guided speculation.** An optimizing compiler that runs *inside* the
> process has an input a batch compiler does not: a record of what the program has been
> doing. "This site has seen one map, four hundred times" is not a proof — the four hundred
> and first receiver may be different — but it is enough to compile against, provided you
> keep a way to undo it. The record is called a **profile**, collecting it is **profiling**,
> and compiling against it is **profile-guided**. What makes it *speculation* rather than
> optimization is the guard: the compiled code re-checks the fact it was built on, and
> bails out if the fact has stopped being true.

The interpreter pays for that licence. Every property read, every arithmetic opcode, every
call and every conditional jump does a little extra work whose only beneficiary is a
compiler that may never run — and for `stats.tera` never does, because nothing in the file
crosses `baselineThreshold` (8) or `jitThreshold` (50). The file still produces twenty-seven
lattice transitions on its way to printing two lines. Feedback is unconditional; tiering is
not.

## Slots are operands

A feedback slot is not a side table indexed by bytecode offset. It is an integer *in the
instruction*, appended by the bytecode compiler at the moment the instruction is emitted, and
the allocator that hands it out is the whole of the mechanism:

```ts
  allocFeedbackSlot(): number {
    return this.feedbackSlotCount++;
  }
```
— `src/bytecode/register/ops/bytecode.ts:565-567`

Two lines, one field. There is no registry of which opcode owns which slot, no map from slot
index back to a source position, and no record of what kind of thing the slot will hold. The
counter runs per `RegisterCompiledFunction`, so slot numbers are function-local, and the only
thing a slot number means is *how many slots had been handed out when this instruction was
emitted*.

Seventy-one call sites in the bytecode compiler ask for one — all of them under
`src/bytecode/register/compiler/`. A representative pair, from `compileMemberExpression`
(`expressions.ts:782-810`), shows both the named and the computed form allocating a slot
immediately before the emission that carries it:

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
— `src/bytecode/register/compiler/expressions.ts:797-808`

The binary-operator path does the same one operand earlier
(`expressions.ts:364-365`, `const fbSlot = this.func.allocFeedbackSlot();` then
`this.func.emit(opcode, tmp2, fbSlot)`), and the method-call path allocates the slot *before*
it decides whether it is emitting `ROP_CALL_METHOD` or `ROP_CALL_METHOD_NAMED`
(`expressions.ts:674`), so both forms end up carrying the same index in a different operand
position — a detail that costs something later, in § the-slot-that-was-never-allocated.

Because the counter increments in emission order, slot numbering follows the order the
compiler walked the tree, which is not the order a reader would number the program's
interesting sites. `Series.mean` allocates eleven, and they run 0 to 10 down the instruction
stream:

```
     8  LdaNamedProperty r4 [1] (values) r0
    10  LdaNamedProperty r3 [2] (length) r1
    13  TestLessThan r3 r2
    14  JumpIfFalse r32 r3
    17  LdaNamedProperty r4 [1] (values) r4
    21  LdaKeyedProperty r3 r4 r5
    24  Add r2 r6
    29  Add r2 r7
    36  LdaNamedProperty r4 [1] (values) r8
    38  LdaNamedProperty r3 [2] (length) r9
    41  Div r3 r10
```
— the eleven slot-carrying instructions of the forty-three printed by
`node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera`

Three separate slots — 0, 4 and 8 — for three occurrences of the single source expression
`this.values`. They are three different program points, so they get three different
histories, and the JIT may reach a different conclusion about each. That is the point of
keying on the *site* rather than on the name.

## Reading the disassembly

Every one of those slot numbers printed as `rN`, and none of them is a register.

`RegisterCompiledFunction.disassemble` (`src/bytecode/register/ops/bytecode.ts:599-657`)
special-cases exactly five things: operand 0 of `ROP_LDA_CONST` (rendered with the pooled
constant), operand 0 of `ROP_LDA_GLOBAL`, `ROP_STA_GLOBAL` and `ROP_CALL_INTRINSIC`, and
operand 1 of the three property opcodes. Everything else falls through one `else`:

```ts
        } else {
          parts.push(`r${op}`);
        }
```
— `src/bytecode/register/ops/bytecode.ts:648-650`

So `JumpIfFalse r32 r3` at offset 14 above contains no registers at all: `r32` is the
bytecode offset the jump goes to — instruction 32, which is where the loop exits — and `r3`
is feedback slot 3. `Jump r4` at offset 31 is a jump to instruction 4, the loop header.
`report`'s call is worse:

```
     5  CallMethod r1 r0 r0 r1
```
— instruction 5 of the seven printed by
`node dist/cli.js --print-bytecode --filter report docs/example/stats.tera`

Four operands, printed identically, meaning four different things: receiver register 1, first
argument register 0, argument count **0**, feedback slot **1**.

> **Broken.** `RegisterCompiledFunction.disassemble`
> (`src/bytecode/register/ops/bytecode.ts:599-657`) prints jump targets, argument counts and
> feedback slot indices as `rN`, which reads as a register number and is not one. The five
> special cases are enumerated by hand in the operand loop; there is no per-opcode
> operand-kind table anywhere in the tree, which is why the printer cannot do better. Cost to
> fix: build that table — one row per opcode naming each operand's kind — and drive both the
> printer and `initFeedbackVector` from it. That table is the same thing § the-slot-that-was-
> never-allocated ends up asking for.

This book quotes the disassembler's output anyway, because it is the only view of the
instruction stream the engine ships (`docs/CONVENTIONS.md` rule 4). Read `rN` on the last
operand of a property, arithmetic, call or conditional-jump instruction as a slot number, and
on the first operand of a jump as an instruction index.

## Typing the vector

Allocation says *how many* slots a function has. It does not say what any of them holds. That
is decided by a second pass, `RegisterInterpreter.initFeedbackVector`
(`src/bytecode/register/interpreter/index.ts:800-903`), which runs once, on the first entry
to the function, and never again
`[t: tests/bytecode/register/interpreter.test.ts > "does not recreate on second call"]`.

It builds the vector from the function's own numbers and then walks the instruction stream:

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

The first argument is the slot count; the second is a *loop budget*, `3000 ×` the number of
instructions, which has nothing to do with feedback and is the subject of
[Ch 35 § the-budget-is-not-a-counter]. The vector's `slots` array starts as that many `null`s.

The walk is a `switch` over opcode families, and each family reads the slot index from a
hard-coded operand position:

```ts
        case bytecode.ROP_LDA_PROP:
        case bytecode.ROP_STA_PROP:
        case bytecode.ROP_DEFINE_CLASS_MEMBER:
          {
            const slotIndex = operands.length >= 3 ? numericOperand(operands[2]) : null;
            if (slotIndex !== null && slotIndex < fv.slots.length) {
              fv.initSlot(slotIndex, FEEDBACK_PROPERTY);
            }
          }
          break;
```
— `src/bytecode/register/interpreter/index.ts:810-819`

Position 2 for the three property opcodes; position 1 for the twenty-two binary opcodes
(`ROP_ADD` through `ROP_IN`, `:831-859`) and for the two conditional jumps; position 0 for
the three unary ones (`ROP_NOT`, `ROP_NEG`, `ROP_BITNOT`); position 3 for `ROP_CALL` and
`ROP_CALL_METHOD`; and, for `ROP_LDA_INDEX` and `ROP_STA_INDEX`, not a position at all but a
convention — `operands[operands.length - 1]`, "the slot is last".

`initSlot` is create-if-absent:

```ts
  initSlot(index: number, kind: FeedbackKind): void {
    if (!this.slots[index]) {
      this.slots[index] = new FeedbackSlot(kind);
    }
  }
```
— `src/feedback/vector/index.ts:818-822`

So the *first* instruction in the stream that names an index fixes that slot's kind for the
life of the function
`[t: tests/feedback/vector.test.ts > "does not overwrite existing slot"]`, and a slot no
instruction names stays `null`
`[t: tests/feedback/vector.test.ts > "lazily initializes slots"]`. A `null` slot is not an
error anywhere: every recorder is reached through `getSlot(i)?.` or through a `if (!slot)
return`, so an untyped slot silently records nothing. That failure mode is quiet, and it is
the one § the-slot-that-was-never-allocated is about.

Six kinds exist — `FEEDBACK_PROPERTY`, `FEEDBACK_BINARY_OP`, `FEEDBACK_UNARY_OP`,
`FEEDBACK_CALL`, `FEEDBACK_ALLOCATION` and `FEEDBACK_BRANCH`
(`src/feedback/vector/index.ts:11-16`) — and this pass assigns five of them. Note that
indexed access is typed `FEEDBACK_PROPERTY`, not a kind of its own: `arr[i]` and `obj.name`
share a slot kind and differ only in which recorder the interpreter calls.

> **Unfinished.** `FEEDBACK_ALLOCATION` is exported as a kind and
> `FeedbackSlot.recordAllocationSite` (`src/feedback/vector/index.ts:420-423`) accumulates
> hidden-class ids into `allocationSiteHCs`, but `initFeedbackVector` never types a slot with
> it, no opcode carries one, and `FeedbackNexus` exposes no allocation hint. Its only caller
> anywhere in the tree is `tests/feedback/vector.test.ts:332-334`. Allocation-site feedback is
> a complete recorder with no producer and no consumer. Cost to finish: a slot on the
> allocation opcodes, a case in the walk, and a hint method on the nexus — after deciding what
> the optimizer would do with it, which is the part nothing in the tree has decided.

## The lattice

Each slot carries an `icState`, one of four names, and the rule that governs how it changes is
the chapter's structural claim.

> **New idea. A one-way state order.** Order the four states
> `uninitialized < monomorphic < polymorphic < megamorphic`. They are not four unrelated
> labels; they are increasing degrees of *uncertainty about what this site sees*. A site that
> has seen nothing is at the bottom. A site that has seen exactly one shape is monomorphic —
> the most useful state, because a compiler can guess that shape and be right. A site that has
> seen several is polymorphic; a site that has seen too many is megamorphic, and there is
> nothing worth guessing. The transition rule is that a slot may move **up** this order and
> never down. Monotonicity is what makes the state safe to read at any moment: the optimizer
> may sample a slot mid-run without a lock, without a snapshot, and without asking whether the
> program is still warming up, because whatever the state is now, it can only have been *more*
> specific in the past, never less.
>
> This is the third structure in this book called a lattice and it is unrelated to the other
> two. [Ch 10 § a-lattice] is the checker's assignability order over type *text*; the glossary's
> `lattice` entry points at `src/optimizing/types/lattice.ts`, the middle end's `LatticeType`
> over abstract machine values. This one is four strings and a table of integers.

The table and the step:

```ts
const LATTICE_ORDER = {
  [IC_UNINITIALIZED]: 0,
  [IC_MONOMORPHIC]: 1,
  [IC_POLYMORPHIC]: 2,
  [IC_MEGAMORPHIC]: 3,
} as const;
```
— `src/feedback/vector/index.ts:26-31`

```ts
  _advanceLattice(newState: ICState): boolean {
    const currentOrder = LATTICE_ORDER[this.icState];
    const newOrder = LATTICE_ORDER[newState];
    if (newOrder > currentOrder) {
      const prevState = this.icState;
      this.icState = newState;
      this.lastTransitionTimestamp = Date.now();
      this.stableSinceCount = 0;
      this.isStable = false;
      tracer.feedbackRecord(0, this.kind, `${prevState} → ${this.icState}`);
      return true;
    }
    return false;
  }
```
— `src/feedback/vector/index.ts:180-193`

Strictly greater, or nothing happens. There is no path in the file that lowers a state, and
the recorders do not try: they call `_advanceLattice(IC_POLYMORPHIC)` unconditionally when
they see a second shape, and the method itself decides whether that is a move
`[t: tests/feedback/vector.test.ts > "cannot go backwards from polymorphic to monomorphic"]`.

**The consequence is that warm-up noise is permanent.** A site that sees a second shape once,
during initialization, and then a million receivers of the first shape, is polymorphic
forever, and the optimizer will decline to speculate on it. The engine's only escape hatches
are wholesale: `reset()` on a slot, `resetSlot(i)` and `resetAll()` on the vector
(`src/feedback/vector/index.ts:632-665`, `:832-847`), each of which clears every array and
returns the state to `uninitialized`. They exist for deoptimization — throwing away a profile
that led to a bad guess — not for ordinary execution, and nothing in the interpreter's hot
path calls any of them.

The `stats.tera` run has exactly one such transition. Twenty-seven `[FB]` lines, twenty-six of
them `uninitialized → monomorphic`, and one:

```
[FB] Slot #0: binary_op — monomorphic → polymorphic
```
— `node dist/cli.js --trace-feedback docs/example/stats.tera`

That is the loop accumulator in `Series.mean`. `total = 0.0` is stored as a Smi, because the
engine canonicalises an integral double into one; `this.values[0]` is `12.5`, a double; so the
site's first record is the tag pair `smi|double`. From the second iteration `total` is a double
and every later record is `double|double`. Two shapes, one site, and the slot leaves
monomorphic on the second iteration of a five-iteration loop. Two four-line probes show it
directly — the first reproduces the transition, the second removes it by keeping the
accumulator off the Smi/double boundary:

```
$ node dist/cli.js --trace-feedback -e 'total = 0.0
i = 0
while i < 4:
  total += 12.5
  i += 1
print(total)'
[FB] Slot #0: binary_op — uninitialized → monomorphic
[FB] Slot #0: binary_op — uninitialized → monomorphic
[FB] Slot #0: binary_op — uninitialized → monomorphic
[FB] Slot #0: binary_op — monomorphic → polymorphic
[FB] Slot #0: call — uninitialized → monomorphic
50
```

Change `0.0` to `0.5` and `12.5` to `12.25` — so no partial sum is ever integral — and the
polymorphic line disappears. Nothing about the program's *types* changed; `total` is a
`float` throughout in both. What changed is the runtime tag, which is what feedback records.

## What each recorder stores

Twelve recorder methods write into a slot, and they do not share a shape. Each accumulates the
thing its own consumer needs, and each reaches the lattice by its own route — or not at all.

**`recordPropertyAccess(hiddenClassId, offset, mapVersion, protoDepth)`**
(`src/feedback/vector/index.ts:202-232`) keys on hidden-class id and keeps four parallel arrays
— `maps`, `mapVersions`, `offsets`, `protoDepths` — with a `_mapIndex` from id to position. Its
first branch is the one that matters:

```ts
    const idx = this._mapIndex.get(hiddenClassId);
    if (idx !== undefined) {
      this.mapVersions[idx] = mapVersion;
      this.offsets[idx] = offset;
      this.protoDepths[idx] = protoDepth;
      this._checkStability();
      return;
    }
```
— `src/feedback/vector/index.ts:209-216`

A repeat visit by a map the site has already seen **updates in place and never transitions**
`[t: tests/feedback/vector.test.ts > "updates version/offset for existing class without transition"]`.
Only a genuinely new id advances the state, which is why `Series.mean`'s three `this.values`
slots — slot 0 in the loop test, slot 4 in the body, slot 8 after the loop, recording eleven,
nine and two accesses across the two instances — all stay monomorphic. `protoDepth` is `0` for
an own property and the chain depth for an inherited one
`[t: tests/feedback/vector.test.ts > "tracks protoDepth"]`, so the tuple says not only where
the value was but how far up.

**`recordBinaryOp(lhsTag, rhsTag)`** and **`recordUnaryOp(operandTag)`**
(`:306-320`, `:251-257`) count *tag shapes*, not values. `recordBinaryOp` bumps three maps —
`lhsTypeCounts`, `rhsTypeCounts`, and `typeCounts` keyed `` `${lhsTag}|${rhsTag}` `` — and both
route the number of distinct shapes through one helper:

```ts
  _recordTypeShape(shapeCount: number): void {
    if (shapeCount === 1 && this.icState === IC_UNINITIALIZED) {
      this._advanceLattice(IC_MONOMORPHIC);
    } else if (
      shapeCount <= MAX_POLYMORPHIC_ENTRIES &&
      this.icState === IC_MONOMORPHIC
    ) {
      this._advanceLattice(IC_POLYMORPHIC);
    } else if (shapeCount > MAX_POLYMORPHIC_ENTRIES) {
      this._advanceLattice(IC_MEGAMORPHIC);
    }
  }
```
— `src/feedback/vector/index.ts:322-333`

It is called only when `prev === 0`, i.e. on the first sighting of a shape, so a site that runs
a million times with one shape reaches the lattice exactly once. `smi|double` followed by
`double|double` is what took `mean`'s accumulator to polymorphic.

**`recordCallTarget`** (`:335-402`) does the most work of any recorder. It keys targets not by
name but by object identity, through a `WeakMap` that assigns each `RegisterCompiledFunction` a
synthetic string the first time it is seen:

```ts
  _callTargetKey(targetName: string, compiledFn: RegisterCompiledFunction | null): string {
    if (!compiledFn) {
      return `builtin:${targetName}`;
    }
    let key = this._callTargetObjectKeys.get(compiledFn);
    if (!key) {
      key = `fn:${this._nextCallTargetObjectKey++}`;
      this._callTargetObjectKeys.set(compiledFn, key);
    }
    return key;
  }
```
— `src/feedback/vector/index.ts:404-414`

Two closures over the same source are two different objects and therefore two different keys —
which is correct, since they are two different compiled functions with two different feedback
vectors. Builtins fall back to the name. Alongside the keys the recorder keeps target ids,
target versions, argument-count counts, and receiver maps with their versions; and it maintains
`callTargetRef`, a direct pointer to the single target, which it **drops the moment a second
target appears** (`:396`, `this.callTargetRef = null;`). Monomorphic inlining reads that
pointer; the polymorphic case reads `getPolymorphicCallTargets`, which returns the targets
sorted by frequency and only if there are at least two
`[t: tests/feedback/vector.test.ts > "polymorphic with multiple targets"]`.

**`recordArrayAccess` / `recordIndexedAccess`** (`:433-460`, `:425-431`) are the only recorders
that jump straight to the top of the lattice. A receiver that is not an array, or an index that
is not a Smi, is not a degree of polymorphism — it is a site the elements machinery cannot
describe at all, so the `else` arm is one line, `_advanceLattice(IC_MEGAMORPHIC)`
`[t: tests/feedback/vector.test.ts > "megamorphic on non-array access"]`,
`[t: tests/feedback/vector.test.ts > "megamorphic on non-integer index"]`. When both hold, the
recorder counts elements kinds instead of maps, and the lattice tracks how many distinct kinds
the site has seen. `recordArrayLengthAccess` (`:462-488`) is the same shape for `arr.length`.

**`recordBranch(taken)`** (`:259-267`) is the exception that proves the rule: it increments
`takenCount` or `notTakenCount`, calls `_checkStability`, and **never touches the lattice**. A
branch slot is therefore permanently `uninitialized` no matter how many times it is recorded,
and never appears in `--trace-feedback` output — which is why the twenty-seven lines from
`stats.tera` are eleven `property`, nine `call` and seven `binary_op`, and not one `branch`,
even though one of `mean`'s eleven slots is a conditional jump. The read side is
`getBranchBias()` (`:269-276`), which reports `likely-true` or `likely-false` only at a ten-to-
one ratio and `mixed` otherwise
`[t: tests/optimizing/baseline/runtime.test.ts > "reports an evenly split branch as mixed"]`.

**`recordReturnType(tag)`** (`:278-283`) stores under a `return:` prefix in the same
`typeCounts` map the binary recorder uses, and `recordPrimitiveReceiver(tag)` (`:234-238`)
under a `receiver:` prefix. Neither advances the lattice. Three of the read-side predicates —
`hasOnlySmiReturns`, `hasOnlyNumberReturns`, `dominantPrimitiveReceiver` — exist to pull those
namespaced keys back out of the shared map.

## Four is the limit

The vector's polymorphic ceiling is a single private constant:

```ts
const MAX_POLYMORPHIC_ENTRIES = 4;
```
— `src/feedback/vector/index.ts:23`

Four distinct maps, four distinct tag shapes, four distinct call targets, four distinct
elements kinds. The fifth takes the slot to megamorphic and, on the property path,
`recordPropertyAccess` returns without even recording the map
(`:222-225`) — past the limit the site stops accumulating detail, because nothing will read it
`[t: tests/feedback/vector.test.ts > "transitions to megamorphic after >4 unique classes"]`.

The inline cache's ceiling is **eight**, in a different file, under a different name
(`MAX_POLY_ENTRIES`, `src/feedback/ic/index.ts`), with a third constant
`MAX_ELEMENT_POLY_ENTRIES = 4` for elements. Two numbers, two files, no shared symbol and no
comment relating them. [Ch 34 § two-limits] is where that asymmetry is argued, because the
argument belongs to the cache: a site with five to eight shapes is still being served by the
IC's linear scan while the vector has already told the optimizer to stop guessing.

## Stability and the decision to stop

Recording is not free, and the vector has a rule for when to stop. It is one counter:

```ts
  _checkStability(): void {
    this.stableSinceCount++;
    if (this.stableSinceCount >= STABILITY_SETTLE_THRESHOLD && !this.isStable) {
      this.isStable = true;
    }
  }
```
— `src/feedback/vector/index.ts:195-200`

Fifty records with no transition set `isStable`
`[t: tests/feedback/vector.test.ts > "becomes stable after 50 records without transition"]`, and
any transition resets the count to zero and clears the flag — that is the
`this.stableSinceCount = 0; this.isStable = false;` pair inside `_advanceLattice` above
`[t: tests/feedback/vector.test.ts > "resets stability on state transition"]`. So `isStable`
means "this site has been telling the same story for fifty consecutive records", not "this site
is monomorphic".

> The running example cannot demonstrate it. `STABILITY_SETTLE_THRESHOLD` is 50 and
> `Series.mean`'s loop runs nine times across both instances, so no slot in `stats.tera` — or
> in any variation — ever sets `isStable`. The rule above is stated from the code and pinned to
> the unit test, not from a run.

`isStable` is a *stop-recording* signal, and exactly three places honour it. The interpreter's
call path:

```ts
  if (!slot || slot.isStable) return;
```
— `src/bytecode/register/interpreter/index.ts:320`

the return path, `if (slot && !slot.isStable && result) slot.recordReturnType(getTag(result));`
(`:339`), and the binary path in `getBinaryOperands` (`src/bytecode/register/interpreter/helpers.ts:99-101`).
Nothing else checks it — not the property path, and not the baseline compiler's runtime, whose
recorders at `src/optimizing/baseline/runtime.ts:305-331`, `:767-772` and `:797-816` have no
`isStable` test of any kind. A settled site keeps paying full price in two of the three tiers
that record.

## The property exception

The property path is the interesting half of that, because it is the busiest.

`handleLdaProp` reaches the cache at step 10 and the feedback record at step 11
([Ch 24 § lda-prop-the-sequence-in-order]), and the record is unconditional:

```ts
    const slot = compiledFn.feedbackVector
      ? compiledFn.feedbackVector.getSlot(fbSlotIdx)
      : null;
    if (slot) {
      recordPropertyFeedback(slot, jsObj, propName);
    }
```
— `src/bytecode/register/interpreter/handlers.ts:254-259`

`recordPropertyFeedback` (`handlers.ts:121-147`) then calls
`jsObj.hiddenClass.lookupProperty(propName)` — a full descriptor lookup — and, if that misses
and the object has a prototype, `jsObj.lookupPrototypeChain(propName)` as well, before calling
`recordPropertyAccess`. Every time. A property site that has been monomorphic for a hundred
thousand accesses does that lookup on every one of them, and `recordPropertyAccess` then walks
its `_mapIndex`, finds the entry, and overwrites three array cells with the values that are
already in them.

The code gives no reason, because the code gives no reasons: there are 26 comment lines in
120,822. Closing it is the same three-line guard the call path uses. What makes it a decision
rather than an oversight is the in-place update: `recordPropertyAccess` refreshes `mapVersion`
on every repeat visit, and a stable site that stopped recording would stop refreshing it, so the
version the JIT later reads would be the version as of the fiftieth access rather than the
latest. Whether that matters depends on what a stale `mapVersion` costs a speculating compiler —
a question [Ch 49 § speculative-taint] asks and this tree does not answer.

## The nexus

The optimizer never touches a `FeedbackSlot`. It holds a `FeedbackNexus`
(`src/feedback/nexus/index.ts:93-258`) wrapping the vector, and asks it for a *hint*: one of
`binaryOp`, `unaryOp`, `property`, `elements`, `call`, `branch` or `returnType`, each returning a
small record with a `kind` field drawn from four constants — `FEEDBACK_HINT_GENERIC`,
`_MONOMORPHIC`, `_POLYMORPHIC`, `_MEGAMORPHIC` (`:24-27`). Seven queries plus `getSlot`; that is
the entire width of the contract between the running program and the compiler.

`property(index)` (`:125-159`) is the representative one. It answers `GENERIC` for a `null`
slot, `MONOMORPHIC` with a `primitiveReceiver` string if the site mostly saw primitives,
`MONOMORPHIC` with `(map, mapVersion, offset, protoDepth)` unpacked from the four parallel
arrays, `POLYMORPHIC` with all four arrays whole, or `MEGAMORPHIC` with nothing but a slot
reference. Each shape of hint is exactly what one shape of emitted code needs, which is why the
nexus exists at all: it converts "what happened" into "what may be assumed".

Two conversions in that file are worth naming. `typeFromFeedbackTag` (`:292-300`) maps the
interpreter's tag strings onto the middle end's `LatticeType` — `smi` to `smiType()`, `double` to
`doubleType()`, `null` and `undefined` both to `nullishType()`, and anything unrecognised to
`anyType()` — which is the single point where the interpreter's vocabulary becomes the
optimizer's. `observedBinaryType` (`:268-276`) then joins the tags from *both* operand maps into
one type, so a site that saw `smi|double` and `double|double` yields the join of smi and double,
not a pair.

And one widening that changes what the optimizer sees:

```ts
function isStableSlot(slot: FeedbackSlot | null): boolean {
  return (
    !!slot &&
    (slot.isStable ||
      (slot.totalRecordCount > 0 && slot.icState === IC_MONOMORPHIC))
  );
}
```
— `src/feedback/nexus/index.ts:260-266`

Every hint's `stable` field comes from this, and it is a *looser* rule than the vector's own. A
slot that is monomorphic with a single record counts as stable here, while
`FeedbackVector.isSettled` (`:937-941`) demands `isStable` **and** fifty records
`[t: tests/feedback/vector.test.ts > "true when stable with enough records"]`. The strict version
has no caller in `src/`. So the rule the optimizer actually uses is "one observation, one shape",
and that is the standard of evidence behind the speculation of Part VII.

## Two writers, one vector

The interpreter is not the only recorder. `BaselineRuntime`
(`src/optimizing/baseline/runtime.ts`) — the object the baseline tier's generated JavaScript
calls into ([Ch 36 § the-runtime-surface]) — writes into the same `FeedbackSlot` objects, through
`gp`/`sp` for properties, `gi`/`si` for elements, `_recordBinaryFb` for arithmetic, `invokeCall`
for calls and returns, and `branch` for conditional jumps. It reaches them the same way, off
`this.fv`, with the same slot indices. A function that runs in the interpreter and then in
baseline accumulates one continuous history.

One of those writers is the only one of its kind:

```ts
  branch(fbSlot: number, taken: boolean) {
    if (fbSlot >= 0 && this.fv) {
      const slot = this.fv.getSlot(fbSlot);
      if (slot) slot.recordBranch(taken);
    }
  }
```
— `src/optimizing/baseline/runtime.ts:774-779`

`FeedbackSlot.recordBranch` has exactly one caller in `src/`, and this is it. The interpreter's
`ROP_JUMP_IF_FALSE` and `ROP_JUMP_IF_TRUE` handlers do not record branch feedback, even though
`initFeedbackVector` types their slots `FEEDBACK_BRANCH`.

The consequence is structural. `hotSuccessorOf`
(`src/optimizing/builder/ir-builder.ts:232-244`) asks the nexus for a branch bias and, on
anything but `likely-true` or `likely-false`, returns `null` — no `hotSuccessor` property is set
on the `IR_BRANCH` node, and every later pass that would order blocks by it has nothing to work
with. So **a function that reaches the JIT without ever having run in baseline has no branch
bias at all.** With the default policy that cannot happen, because `baselineThreshold` (8) is
below `jitThreshold` (50). It can happen under any configuration that raises the baseline
threshold above the JIT's — which is precisely what the `jit` and `oracle` entries in
`tests/helpers/tiers.ts:10-18` do, and what `--baseline-threshold` on the command line lets you
do by hand.

## The slot that was never allocated

*(Why the obvious design fails.)*

Return to the one family `initFeedbackVector` does not read by position:

```ts
        case bytecode.ROP_LDA_INDEX:
        case bytecode.ROP_STA_INDEX:
          {
            const fbIdx = operands[operands.length - 1];
            if (fbIdx !== undefined && typeof fbIdx === "number" && fbIdx < fv.slots.length) {
              fv.initSlot(fbIdx, FEEDBACK_PROPERTY);
            }
          }
          break;
```
— `src/bytecode/register/interpreter/index.ts:821-829`

`operands[operands.length - 1]` is not a position. It is a *convention* — "the feedback slot is
the last operand" — and of the eight `ROP_LDA_INDEX` emissions in the tree the compiler holds it
in seven. (All three `ROP_STA_INDEX` emissions hold it too.) Six emissions in
`expressions.ts` (`:654`, `:806`, `:1053`, `:1089`, `:1217`, `:1322`) and one in `functions.ts`
(`:1475`) pass a freshly allocated slot as the third operand. The eighth does not:

```ts
    this.func.emit(bytecode.ROP_LDA_INDEX, keysSlot, iSlot);
```
— `src/bytecode/register/compiler/functions.ts:1290`

That is `compileForInStatement`, loading `keys[i]` for a `for ... in` loop. Two operands, no
slot. So `operands[operands.length - 1]` reads `iSlot` — a *register number* — and offers it to
`initSlot` as a slot index.

The two consequences are asymmetric, and the asymmetry is the lesson.

The mistyping is prevented, but not by anything that knows about it. `initSlot` is guarded by
`fbIdx < fv.slots.length`, a bound check written for a different purpose, so a register number
that happens to be smaller than the function's slot count creates a spurious `FEEDBACK_PROPERTY`
slot at that index — harmless only because `initSlot` is create-if-absent and the real owner of
that index will have typed it already, or will type it later as the same kind, or will type it
as something else and lose. Nothing detects any of those outcomes.

The unconditional damage is on the run-time side. `handleLdaIndex` needs an inline-cache key, and
when no slot is present it does not decline to cache — it substitutes zero:

```ts
    const icKey = compiledFn.getICKey(
      funcName,
      fbSlotIdx_idx >= 0 ? fbSlotIdx_idx : 0,
    );
```
— `src/bytecode/register/interpreter/handlers.ts:407-410`

Site keys are `funcName#fnId:slot` ([Ch 34 § what-a-cache-here-is]), so every `for ... in`
element load in a function shares an `InlineCache` bundle with whatever real slot 0 is in that
function. They use different sub-caches inside the bundle — element-load versus load — so it is
currently harmless. Nothing makes it stay harmless.

The same missing table costs something in the other direction, and this one is measurable.
Seven call opcodes carry a feedback slot: `ROP_CALL`, `ROP_CALL_METHOD`, `ROP_CALL_NAMED`,
`ROP_CALL_METHOD_NAMED`, `ROP_CALL_SPREAD`, `ROP_CALL_SPREAD_NAMED` and
`ROP_CALL_METHOD_SPREAD_NAMED`. `initFeedbackVector` types the first two. The other five get an
allocated slot index, emitted into the instruction, that is never given a `FeedbackSlot` — so
`getSlot` answers `null` and every recorder on that path returns immediately.

> **Dead.** Feedback on named and spread calls. `ROP_CALL_NAMED`
> (`src/bytecode/register/interpreter/index.ts:1872-1891`) and `ROP_CALL_METHOD_NAMED`
> (`:1893-1913`) each read `const fbSlotIdx = operands[6];` and never use the value.
> `ROP_CALL_SPREAD` (`:1915-1936`) does use it — `getSlot(fbSlotIdx)` — but
> `initFeedbackVector` has no case for the opcode, so the slot is always `null` and
> `recordCallFeedback`'s `if (!slot || ...) return` fires on every call.
> `ROP_CALL_SPREAD_NAMED` and `ROP_CALL_METHOD_SPREAD_NAMED` do not read the operand at all,
> though the compiler emits one (`expressions.ts:569-578`, `:606-614`). Observable: `add(1, 2)` records
> a call target and `add(1, b=2)` records nothing, in otherwise identical programs — the probe
> is in "Verify it yourself". Cost to fix: five `case` labels in the walk, each naming the right
> operand index, plus the two `recordCallFeedback` calls the named handlers never make.

Both defects have one cause. The correspondence between "which operand of this opcode is the
feedback slot" and "which operand the emitter put it in" is stated twice, in two files, in two
different vocabularies — once as an `emit(...)` argument order in the bytecode compiler, once as
a hard-coded index or a positional convention in the interpreter's typing walk — and nothing
compares them.

> **Unenforced.** Nothing checks that the operand position `initFeedbackVector` reads for an
> opcode is the position the bytecode compiler emitted, or that every opcode which consumes a
> slot at run time was given one, or that every slot `allocFeedbackSlot` handed out is typed by
> something. `ROP_LDA_INDEX` from `compileForInStatement` is the live counter-example in one
> direction and the four call opcodes above are the live counter-examples in the other. No test
> in `tests/` pins the correspondence. Cost to enforce: the per-opcode operand-kind table this
> chapter has now asked for twice — the same table that would fix `disassemble` — plus one
> assertion that walks a compiled function and checks that the set of typed slots equals
> `0..feedbackSlotCount-1`. [unpinned]

The general rule: **an operand layout that is a convention rather than a table has no
enforcement.** Position 2 for property opcodes, 1 for binary, 0 for unary, 3 for calls, and
"last" for indexed access is five different rules for one question, held in two places by hand.
It is exactly the argument that produces the effects-and-operands table of [Ch 41 § effects],
where the middle end refuses to let a node's operand meaning live in the reader's head.

## What leaves

A `RegisterCompiledFunction` whose `feedbackVector` is populated: one `FeedbackSlot` per
allocated index that some instruction named, each carrying an `icState` from the four-point
one-way order, the maps and versions and offsets and proto depths it observed in four parallel
arrays, the tag-shape counts, the call targets keyed by object identity with their versions and
argument counts, the elements kinds, the branch counts, and an `isStable` flag that fifty
transition-free records set. Plus a loop budget of `3000 ×` the instruction count, which is
[Ch 35 § the-budget-is-not-a-counter]'s input and nothing to do with feedback.

That vector is the entire input to two later chapters. [Ch 39 § feedback-becomes-speculation]
reads it through `FeedbackNexus` while lowering bytecode into an SSA graph, turning a
monomorphic property hint into a guarded fixed-offset load and a monomorphic call hint into an
inlining candidate.
[Ch 49 § speculative-taint] is where the consequences are tracked: every node built from a hint
is marked, and the mark decides which later folds are allowed to believe it.

The inline caches the same instructions filled are a separate artifact with a separate address
space, and the optimizer does not read them at all. [Ch 34] is the cache: a per-site handler
chain keyed `funcName#fnId:slot`, in which absence is a stronger claim than presence, and in
which nothing is ever invalidated globally because every handler re-checks its own assumptions
on every hit.

## Verify it yourself

```bash
# Eleven feedback slots on one method, all printed as if they were registers.
# In `JumpIfFalse r32 r3`, r32 is a bytecode offset and r3 is a slot; neither is a register.
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# Twenty-seven lattice steps, every one of them labelled Slot #0.
node dist/cli.js --trace-feedback docs/example/stats.tera
node dist/cli.js --trace-feedback docs/example/stats.tera 2>&1 | grep -c '\[FB\]'

# The one transition that is not uninitialized -> monomorphic.
node dist/cli.js --trace-feedback docs/example/stats.tera 2>&1 | grep -v 'uninitialized'

# The same number from the other instrument: "feedback_records": 27.
# The counter's name is misleading — its only writer is _advanceLattice, so it counts
# transitions, not records.
node dist/cli.js --stats docs/example/stats.tera

# A second class with the same member names: 41 lines and three transitions
# (property, call and binary_op) instead of one.
node dist/cli.js --trace-feedback docs/example/stats-poly.tera 2>&1 | grep -v 'uninitialized'

# The accumulator, isolated. The first prints a monomorphic -> polymorphic line; the second,
# whose partial sums are never integral, does not.
node dist/cli.js --trace-feedback -e 'total = 0.0
i = 0
while i < 4:
  total += 12.5
  i += 1
print(total)'
node dist/cli.js --trace-feedback -e 'total = 0.5
i = 0
while i < 4:
  total += 12.25
  i += 1
print(total)'

# Named calls record nothing. The first prints two `call` lines, the second one.
node dist/cli.js --trace-feedback -e 'fn add(a: int, b: int) -> int:
  return a + b
print(add(1, 2))'
node dist/cli.js --trace-feedback -e 'fn add(a: int, b: int) -> int:
  return a + b
print(add(1, b=2))'

# The recorders and the lattice: 60 tests.
npx vitest run --project unit tests/feedback/vector.test.ts
```

`--trace-feedback` on `stats.tera` prints 27 `[FB]` lines — 11 `property`, 9 `call`, 7
`binary_op`, and no `branch`, because `recordBranch` never advances the lattice and the
interpreter never calls it. On `stats-poly.tera` it prints 41. Both counts are stable across
runs. The last command reports `Test Files 1 passed (1)` / `Tests 60 passed (60)`.

> **Broken.** `--trace-feedback` labels every line `Slot #0`.
> `FeedbackSlot._advanceLattice` (`src/feedback/vector/index.ts:189`) passes a literal `0` as
> the `slotId` argument of `tracer.feedbackRecord` (`src/core/tracing/index.ts:222-225`), and
> `FeedbackSlot` carries no index field to pass instead. So no site, bytecode offset, function
> name or map reaches the trace, and the one claim the flag exists to support — *this site went
> polymorphic* — is not observable from its own output. Everything this chapter attributes to a
> particular slot was established another way: by reading the disassembly, by counting kinds, or
> by isolating the site in a `-e` probe. Cost to fix: store the index on the slot at `initSlot`
> time and thread it through the one call.

> **Never runs.** `Tracer.feedbackTransition` (`src/core/tracing/index.ts:227-229`) is a second,
> complete formatter for exactly this message — `Slot #${slotId}: ${fromState} → ${toState}` —
> with zero callers in `src/`, `tests/` or `tools/`. It takes the slot id as a parameter, so
> calling it from `_advanceLattice` in place of `feedbackRecord` is where the defect above gets
> fixed. Cost to remove: three lines. Cost to finish: the same one-line change.

> **Dead.** `getBinaryOperands` (`src/bytecode/register/interpreter/helpers.ts:91-103`) guards
> binary-op recording with `if (fv && !fv.saturated)`. `saturated` is an optional field on the
> *structural* type `FeedbackVectorLike` declared in that same file at `:39`; the real
> `FeedbackVector` class has no such property and nothing anywhere assigns one. The guard is
> always true. Cost to resolve: delete the field, or define a saturation rule — the vector
> already has `getSlotsNeedingRefresh` and `isSettled` looking for a consumer.

> **Unfinished.** `FeedbackVector.getSlotsNeedingRefresh` (`src/feedback/vector/index.ts:943-956`),
> `getPolymorphicProfile` (`:924-935`) and `isSettled` (`:937-941`) have no caller in `src/`;
> all three are exercised only by `tests/feedback/vector.test.ts`. `getPolymorphicProfile` reads
> `slot.mapCounts`, a field declared optional on `FeedbackSlot` at `:124` that no recorder ever
> writes, so its `mapDistribution` is always the empty array. Cost to finish: decide whether a
> profile-refresh policy is wanted at all, and if so write into `mapCounts` from
> `recordPropertyAccess`.

## Tests that pin this

- `tests/feedback/vector.test.ts` > `"transitions uninitialized -> monomorphic on first record"`
  — the first step of the lattice, from `recordPropertyAccess`.
- `tests/feedback/vector.test.ts` > `"transitions monomorphic -> polymorphic on second class"`
  — the second map, and the step § the-lattice is about.
- `tests/feedback/vector.test.ts` > `"transitions to megamorphic after >4 unique classes"`
  — `MAX_POLYMORPHIC_ENTRIES = 4` observed from outside the file.
- `tests/feedback/vector.test.ts` > `"updates version/offset for existing class without transition"`
  — the in-place update that keeps `Series.mean`'s loop-body `this.values` slot monomorphic
  across its nine accesses.
- `tests/feedback/vector.test.ts` > `"cannot go backwards from polymorphic to monomorphic"`
  — the one-way property of `_advanceLattice`, asserted directly.
- `tests/feedback/vector.test.ts` > `"becomes stable after 50 records without transition"`
  — `STABILITY_SETTLE_THRESHOLD`, which no example program reaches.
- `tests/feedback/vector.test.ts` > `"resets stability on state transition"`
  — the `stableSinceCount = 0` inside `_advanceLattice`.
- `tests/feedback/vector.test.ts` > `"tracks protoDepth"`
  — that the fourth parallel array records chain depth, not just presence.
- `tests/feedback/vector.test.ts` > `"megamorphic on non-array access"` and
  > `"megamorphic on non-integer index"`
  — the two straight-to-the-top paths in `recordArrayAccess`.
- `tests/feedback/vector.test.ts` > `"polymorphic with multiple targets"`
  — `getPolymorphicCallTargets` sorted by frequency, and its two-target minimum.
- `tests/feedback/vector.test.ts` > `"lazily initializes slots"` and
  > `"does not overwrite existing slot"`
  — `initSlot` is create-if-absent, so the first naming instruction fixes the kind.
- `tests/feedback/vector.test.ts` > `"creates vector with correct slot count"`
  — `fromCompiledFunction` sizes the vector from `feedbackSlotCount`.
- `tests/feedback/vector.test.ts` > `"reports the newest transition across every slot"`
  — `getSummaryStats`' `lastTransitionAt`, the only aggregate anything reads.
- `tests/feedback/vector.test.ts` > `"true when stable with enough records"`
  — `FeedbackVector.isSettled`, the *strict* stability rule, which nothing in `src/` uses.
- `tests/bytecode/register/interpreter.test.ts` > `"does not recreate on second call"`
  — `initFeedbackVector` runs once per function and is idempotent.
- `tests/optimizing/baseline/runtime.test.ts` > `"records a taken branch as taken"`
  — the only caller of `recordBranch` in the tree, exercised.
- `tests/optimizing/baseline/runtime.test.ts` > `"reports an evenly split branch as mixed"`
  — the ten-to-one ratio in `getBranchBias`.
- `tests/optimizing/baseline/runtime.test.ts` > `"ignores an unallocated slot"`
  — that a `null` slot is a silent no-op, not an error.
- `tests/feedback/profile.test.ts` > `"computes EMA — first call sets directly, subsequent weighted"`
  and > `"keeps circular buffer of recent times (max 32)"`
  — `ExecutionProfile` (`src/feedback/profile/index.ts`), the *other* profile: per-function
  timing with `EMA_ALPHA = 0.3`, read by the tiering policy of [Ch 35], not by any site.
- The correspondence between the operand position `initFeedbackVector` reads and the position
  the bytecode compiler emitted is `[unpinned]`. So is the claim that every allocated slot is
  typed by something; § the-slot-that-was-never-allocated names counter-examples in both
  directions.
