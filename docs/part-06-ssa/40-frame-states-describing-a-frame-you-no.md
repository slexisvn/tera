# 40. Frame states: describing a frame you no longer have   ⟨I · · J · N⟩

Run `docs/example/stats-deopt.tera` with the deoptimization tracer on and you can watch a
compiled function give up in the middle of a loop:

```
$ node dist/cli.js --trace-deopt docs/example/stats-deopt.tera
[DEOPT] Dependency registered: total_of -> elements-kind:PACKED_DOUBLE
warm  total=78.50
[DEOPT] DEOPT "total_of": elements-kind-check-failed at bytecode:8
taint total=21.531.257.7518
```

`total_of` was compiled on the strength of having seen an array of packed doubles on every
one of its first two hundred and one calls — two hundred in the warm-up loop, one more
inside the first `print`. The two hundred and second call hands it
`[12.5, 9.0, "31.25", 7.75, 18.0]`, the guard fails, and the optimized code stops. What
happens next is the whole subject of this chapter. The interpreter picks the function up
**at bytecode offset 8, in the middle of the third iteration**, with `total` holding `21.5`
and `i` holding `2`, and finishes the loop there — which is why the second line reads
`21.531.257.7518`: the interpreter concatenated the string it found instead of adding it.
Nothing was recomputed. Nothing was lost. An interpreter frame that had not existed for two
hundred calls was rebuilt exactly.

It could be rebuilt because the compiled code was carrying a description of it the whole
time. That description is a **frame state**, and the fact that it is written in the *new*
representation — its slots hold pointers to nodes in the SSA graph — has one consequence
that costs more than anything else in this book: the graph has a second, invisible use
relation, and `node.uses.length === 0` does not mean a node is dead. A pass that believes
otherwise deletes a value that a frame state still names, and the deoptimized frame comes
back with a hole in it.

**What arrived.** The `CFGFunction` chapter 39 built and populated: blocks discovered, phis
placed and closed, feedback turned into explicit guard nodes, runtime dependencies
registered, and — on the native tier — every recoverable call followed by a pending-throw
test. Hanging off every node in that graph that can give up is a `FrameState` the builder's
walk captured as it went, and the walk also pushed each one into a flat array the compiler
holds as `this.frameStates`. Chapter 40 takes those frame states; Part VII takes the graph
itself.

## The contract

The JIT is allowed to guess. It compiles `total += values[i]` as an unchecked double
addition on the evidence of the last fifty calls, and inserts a guard that checks the
evidence still holds. That trade is the entire reason tier 2 exists
[Ch 1 § the-hinge]. But it is only a trade if the "no" branch of the guard leads
somewhere.

> **New idea. Deoptimization as a contract, not a mechanism.** It is tempting to think of
> deoptimization as a piece of machinery — a stub, a signal, a jump back into the
> interpreter. It is easier to reason about as an *obligation the compiler takes on before
> it is allowed to speculate*. The obligation is: **for every point where I might give up,
> I can name every value the interpreter's frame would have held there, and the exact
> bytecode offset it would have been about to execute.** A compiler that can discharge that
> obligation may guess as wildly as it likes, because a wrong guess costs time and nothing
> else. A compiler that cannot must prove or refuse. The machinery that *acts* on the
> obligation — spilling the snapshot, reading it back, materializing the frame — is
> [Ch 54 § the-snapshot]. This chapter is only about carrying the description, and about
> what carrying it does to every pass that runs afterwards.

Two things follow immediately, and both are visible in the trace above.

First, the description has to name a **resume point**, not just a set of values. `at
bytecode:8` is not decoration: the deoptimizer reads `frameState.bytecodeOffset` and
`frameState.compiledFunction` and starts the interpreter there
(`src/deopt/deoptimizer.ts:230-231`). Half an expression cannot be resumed, so the points
where a frame state may be captured are exactly the points where the bytecode program
counter is a real offset and no instruction is half-executed — the same three properties
that make a back edge the only place a loop can be replaced [Ch 35 § why-a-back-edge].

Second, the description has to be written *now*, while the graph is being built, and it has
to survive every pass that runs afterwards. That is where the difficulty is. The values it
names are SSA nodes, and passes exist to delete SSA nodes.

## What a frame state holds

`FrameState` is a plain class, ten fields, in `src/deopt/frame-state.ts`:

```ts
export class FrameState {
  compiledFunction: CompiledFunctionLike | null;
  bytecodeOffset: number;
  localValues: Map<number, FrameValue>;
  stackValues: FrameValue[];
  thisValue: FrameValue | null;
  id: number;
  callerFrameState: FrameState | null;
  isInlinedFrame: boolean;
  safepoint: boolean;
  sunkAllocations: SunkAllocations | null;
```
— `src/deopt/frame-state.ts:22-32`

They divide cleanly. `compiledFunction` and `bytecodeOffset` say **where to resume**.
`localValues`, `stackValues` and `thisValue` say **with what**. `id` is the frame state's
index in the compiler's flat `frameStates` array — the wasm backend cannot pass an object
across the module boundary, so a deopt signal carries two integers, a reason code and this
`id`, and the deoptimizer looks the frame state back up by it
(`src/deopt/deoptimizer.ts:210`). `callerFrameState` and `isInlinedFrame` chain frames when
the builder inlined. `safepoint` and `sunkAllocations` belong to later chapters —
allocation sinking rewrites a frame state so that an object which never escaped is
described by its *fields* rather than by a pointer, and is rebuilt only if the deopt
actually happens [Ch 45].

The typing of a slot is the part worth slowing down for:

```ts
type IRNodeLike = {
  id?: number;
  type?: string;
  name?: string | null;
};

export type FrameValue =
  | RuntimeValue
  | IRNodeLike;
```
— `src/deopt/frame-state.ts:7-15`

A slot holds *either* a concrete tagged runtime value *or* something node-shaped — in
practice a `CFGInstruction` from the graph being built. That union is the whole design.
The snapshot is expressed in the **new** representation and describes the **old** one.
Local slot 0 of the interpreter frame does not hold a number; it holds "whatever `v13`
evaluates to at the moment the guard fails". The optimizing compiler never has to know what
that value *is*; it only has to keep `v13` alive and be able to say where it lives when the
deopt stub asks.

`localValues` is a `Map<number, FrameValue>`, not an array, and it is sparse on purpose —
the next section is about what is missing from it. `stackValues` is a dense array because
an operand stack has no holes. `thisValue` is separate because the receiver is not a
numbered register.

Two traversals of that structure exist side by side in
`src/optimizing/ir/frame-state-values.ts`, and confusing them is a real hazard.
`visitOneDeoptSnapshot` (`:37-54`) walks locals **densely**, from slot 0 to the highest
slot present, visiting `undefined` for every hole — that is the layout the wasm backend
spills, so the holes have to occupy their slots. `visitFrameStateValues` (`:101-125`) walks
the `Map` **sparsely**, and only for values that are actually there. The first is a
description of a frame; the second is the use relation this chapter is about.

## Liveness at capture

If a frame state named every register the function has, at every point it might give up,
the description would be enormous and mostly useless. Most registers at most offsets hold
values nothing will ever read again. So the builder filters, and it filters through a real
analysis. All of `captureFrameStateWithCaller` that matters is nine lines:

```ts
  const fs = new FrameState(compiledFn, bytecodeOffset);

  if (regs instanceof Map) {
    const liveness = registerLiveness(compiledFn);
    for (const [slot, node] of regs) {
      if (liveness && !liveness.isLive(bytecodeOffset, slot)) continue;
      fs.setLocal(slot, node);
    }
  }
```
— `src/optimizing/builder/frame-state.ts:32-40`

`regs` is the builder's current map from bytecode register slot to the SSA node that
currently defines it. Every slot in it is offered; only the live ones are recorded.

> **New idea. Liveness, and a backward dataflow.** A register is **live** at a point if
> some execution starting there reads it before overwriting it. That is a statement about
> the *future*, so it cannot be computed by walking forwards. It is computed backwards: at
> the very end of the program nothing is live; an instruction that *reads* slot `s` makes
> `s` live just before it; an instruction that *writes* slot `s` makes `s` dead just before
> it, whatever came after. Written as one equation per instruction, with `out` meaning "the
> union of what is live at every place control can go next":
>
> ```
> live(i) = (out(i) \ written(i)) ∪ read(i)
> ```
>
> Branches make this circular — a loop body's `out` depends on the header, whose `out`
> depends on the body — so the equations are solved by iteration: start every point at
> "nothing live", apply the equation everywhere, repeat until nothing changes. That
> repeat-until-nothing-changes is a **fixpoint**, and because the equation only ever adds
> to `live`, and there are finitely many slots, it must terminate. A **worklist** just
> avoids re-solving points nothing changed underneath.

`src/optimizing/builder/register-liveness.ts` is that analysis in 154 lines, over the
bytecode array rather than over the SSA graph, because it has to answer questions in
bytecode-offset terms. Each of `read`, `written` and `live` is one `Uint32Array` with
`ceil(slotCount / 32)` words per instruction, so a slot is one bit and the whole equation is
a few word operations:

```ts
    const base = index * width;
    let changed = false;
    for (let word = 0; word < width; word++) {
      const next =
        ((outgoing[word]! & ~written[base + word]!) | read[base + word]!) >>> 0;
      if (next === live[base + word]) continue;
      live[base + word] = next;
      changed = true;
    }
    if (!changed) continue;
```
— `src/optimizing/builder/register-liveness.ts:128-137`

The successor relation it iterates over is built by `successorsOf` (`:46-65`) from the
opcode table: an explicit jump target, the fall-through unless the opcode is a `jump` or a
`terminate`, and — when the function contains any `enter-handler` opcode — every handler
that could catch from this instruction, from `handlerStacksOf`. Results are memoized in a
`WeakMap` keyed by the `RegisterCompiledFunction` and invalidated by instruction count
(`:28-44`), so a function that is compiled at baseline, then at tier 2, then again for OSR
pays for the analysis once.

Three escapes are deliberate, and all three fail in the same direction.

**A captured slot is always live.** `closureCapturedSlots(compiledFn)` seeds a separate
`captured` bitset (`:86-89`), and that bitset is OR-ed into the answer at query time rather
than into the dataflow:

```ts
  return {
    isLive(offset: number, slot: number): boolean {
      if (offset < 0 || offset >= count) return true;
      if (!inRange(slot)) return true;
      const word = wordOf(slot);
      const held = live[offset * width + word]! | captured[word]!;
      return (held & bitOf(slot)) !== 0;
    },
  };
```
— `src/optimizing/builder/register-liveness.ts:145-153`

A closure reads its captured variables from a context, not from the bytecode, so the
bytecode reads say nothing about whether the value is needed. Keeping every captured slot
unconditionally is the only correct answer the bytecode alone can support
`[t: tests/optimizing/builder/frame-state.test.ts > "keeps a register a closure captured, however dead the bytecode reads"]`,
and the end-to-end consequence is pinned by
`[t: tests/e2e/optimizing/frame-state-liveness.test.ts > "still reads a loop local that a closure captured"]`,
which builds a loop whose body writes `x`, captures it in an arrow, then overwrites `x` —
so the bytecode's own reads would say the captured version is dead — and asserts the answer
is the same at every tier.

**An unmodellable opcode turns the filter off entirely.** `analyze` walks the instruction
array first and returns `null` if any opcode has no entry in `registerEffectsOf` (`:76-78`).
`registerLiveness` then answers `null`, and the `if (liveness && …)` in the capture is
simply skipped: every offered slot is recorded
`[t: tests/optimizing/builder/frame-state.test.ts > "keeps every register when the bytecode holds an opcode liveness cannot model"]`.

**Out of range answers `true`.** Both guards at the top of `isLive` return live for an
offset or a slot the analysis has no bit for.

All three fail *toward* a bigger frame. A frame state that carries a slot nothing will read
costs bytes in the wasm snapshot and a wasted local; a frame state that is missing a slot
something *will* read is a wrong answer after a deopt. The asymmetry is total, and the code
is written to respect it.

The precision that survives is real. A register can be dropped at one offset and kept at
another in the same function
`[t: tests/optimizing/builder/frame-state.test.ts > "decides per offset, so one register is dropped at one point and kept at another"]`,
and a value whose only reader is the *next* iteration, across the back edge, is kept
`[t: tests/optimizing/builder/frame-state.test.ts > "keeps a register the loop reads again only after the backedge"]` —
which is exactly the case a forward walk would get wrong, and which
`[t: tests/e2e/optimizing/frame-state-liveness.test.ts > "still reads a local only the next iteration goes back for"]`
checks all the way through a real deopt.

## Who must own one

Which nodes need a frame state is not decided by any pass. It is read off chapter 38's
operation table, and the whole predicate is four lines:

```ts
export function irRequiresFrameState(node: IRValueLike) {
  if (!(node instanceof CFGInstruction)) return false;
  return canDeoptimize(node);
}
```
— `src/optimizing/ir/index.ts:116-119`

```ts
export function canDeoptimize(node: CFGInstruction): boolean {
  const deopt = effectsOf(node).deopt;
  if (deopt === DEOPT_ALWAYS) return true;
  return deopt === DEOPT_ON_OVERFLOW && node.props.noOverflow !== true;
}
```
— `src/optimizing/ir/operations.ts:1168-1172`

`DeoptMode` has exactly three values — `DEOPT_NEVER`, `DEOPT_ALWAYS`, `DEOPT_ON_OVERFLOW`
(`operations.ts:149-151`) — and each is baked into the twenty shared effect records the
table is built from (`operations.ts:258-278`). Ten of the twenty are `DEOPT_ALWAYS`:
`GUARD`, `CONTROL_GUARD`, `ALLOCATES`, `UNKNOWN_CALL`, `DECLARED_WRITE`,
`DECLARED_ALLOCATE`, and the four whose names end in `_DEOPTS` — `READS_HEAP_DEOPTS`,
`WRITES_HEAP_DEOPTS`, `READS_CONTEXT_DEOPTS`, `WRITES_CONTEXT_DEOPTS`. Exactly one,
`PURE_OVERFLOWING`, is `DEOPT_ON_OVERFLOW`. The remaining nine — `PURE`, `READS_HEAP`,
`WRITES_HEAP`, `READS_GLOBALS`, `WRITES_GLOBALS`, `READS_FRAME`, `WRITES_FRAME`, `CONTROL`
and `IMMUTABLE_READ` — are `DEOPT_NEVER`. The `_DEOPTS` suffix is the whole difference
between the two halves of each pair: `READS_HEAP` cannot bail out, `READS_HEAP_DEOPTS` can.

Two things make that more interesting than a static lookup.

**A node can lose the obligation.** `DEOPT_ON_OVERFLOW` covers `Int32Add`, `Int32Sub`,
`Int32Mul` and friends: they need a way out because an int32 result that does not fit has
to become a double, and becoming a double at run time means bailing out. But if a pass
*proves* the result fits, the way out is never taken. `bounds-check-elimination` —
pass #17 in the middle end, `rangeAnalysisAndBoundsCheckElimination` in
`src/optimizing/passes/checks.ts` — does exactly that: when range analysis bounds a node
inside int32 and rules out negative zero, it writes `node.props.noOverflow = true`
(`checks.ts:449-464`), and `canDeoptimize` immediately answers `false`
`[t: tests/optimizing/ir/operations.test.ts > "stops requiring a frame state once overflow is proven impossible"]`.
An analysis result turns directly into a smaller frame. Ten source files under
`src/optimizing/passes/` set that flag, most of them lowerings that know the arithmetic they
just emitted is a length or an index.

**Effects can be per-node, not per-opcode.** `effectsOf` consults `spec.effects`, which for
call-shaped opcodes is a *function* of the node rather than a constant
(`operations.ts:1018-1021`). `IR_CALL_BUILTIN` resolves its effects from
`node.props.declaredEffects` (`operations.ts:318-320`), so an ordinary `CallBuiltin`
inherits `UNKNOWN_CALL` and must carry a frame state
`[t: tests/optimizing/ir/call-builtin.test.ts > "still requires a frame state so deoptimization can rebuild the frame"]`,
while one declared `immutable-read` resolves to `IMMUTABLE_READ`, which is `DEOPT_NEVER`,
and needs nothing
`[t: tests/optimizing/ir/operations.test.ts > "derives call effects from the effects the caller declared"]`.
That is not a corner case: it is why two of `stats.tera`'s twenty-one graphs turn out to
have no frame states at all, which the last third of this chapter comes back to.

The invariant is *every node for which `irRequiresFrameState` is true carries a frame state
that belongs to this compilation*, and it is enforced by `validateFrameStates`, which
reports three distinct errors:

```ts
    for (const node of block.nodes) {
      if (!irRequiresFrameState(node)) continue;
      if (!node.frameState) {
        errors.push(
          `B${block.id} v${node.id} ${node.type} missing frame state`,
        );
        continue;
      }
      if ((node.frameState.id ?? -1) < 0) {
        errors.push(
          `B${block.id} v${node.id} ${node.type} has unassigned frame state`,
        );
      }
      if (frameStates.length > 0 && !frameStateSet.has(node.frameState)) {
        errors.push(
          `B${block.id} v${node.id} ${node.type} references foreign frame state`,
        );
      }
    }
```
— `src/optimizing/validation/graph-validator.ts:313-331`

`[t: tests/optimizing/validation/graph-validator.test.ts > "throws when deopt-capable node lacks frame state"]`
and
`[t: tests/optimizing/validation/graph-validator.test.ts > "passes when deopt-capable node has frame state"]`
pin the first. The third — *references foreign frame state* — exists because
`frameStates` is a per-compilation array and a frame state that came from some other
compilation would be indexed by an `id` that means something else entirely.

You can see the obligation in the printed IR. `!fs` after a node means it carries one:

```
$ node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
    --filter mean docs/example/stats.tera
  B2 succs=B3 preds=B3:
    v11 = GenericGetProp v10 [propName="values"] !fs
    v12 = GenericGetIndex v11, v4 !fs
    v13 = GenericAdd v3, v12
    v15 = Float64Add v4, v14
    v22 = Jump [targetBlock=3]
```

Two of the five carry one; the property read and the indexed read can both bail out, the
generic add and the float add cannot. The marker is one constant,
`FRAME_STATE_MARK = "!fs"` at `src/optimizing/ir/text.ts:32`.

> **Unfinished.** `--print-ir` shows *that* a node carries a frame state and never *what* it
> holds. `FrameState.toString` (`src/deopt/frame-state.ts:178-198`) and `toCompact`
> (`:169-176`) render the locals, the stack, the caller and the inline marker exactly as a
> reader would want, and `formatIRValue` (`:210-226`) already knows how to print a node as
> `v27` and a tagged value by its tag. Neither is reachable from any command: `toCompact` is
> called only from `FrameStateBuilder.dump` (`:284-290`), which nothing in `src/` calls, and
> `toString` has no caller at all. Wiring it up costs one branch in
> `src/optimizing/ir/text.ts` and a flag in `src/cli/spec.ts`; until then, the contents of
> a frame state can only be inspected from a test.
>
> `FrameState.safepoint` is in the same condition, one step further along: nothing anywhere
> in `src/` ever sets it. `markAsSafepoint` (`:83-85`) has no callers, `clone` copies the
> field (`:101`), and the two printers render `[safepoint]` for a flag that is always
> `false`. Finishing it costs one call to `markAsSafepoint` from wherever a collector
> safepoint is decided; deleting it costs the field, its initializer, the setter, the clone
> line and the two render branches — six lines, plus the three tests in
> `tests/deopt/frame-state.test.ts` that exercise a flag nothing in `src/` sets.

## The second use graph

Here is the sentence the rest of this book depends on.

`CFGInstruction.uses` holds one entry per input **edge**, and nothing else. It is
maintained by exactly three operations — `addInput` pushes the user onto the producer's
`uses`, `replaceInput` drops one entry from the old producer and pushes onto the new, and
`rebuildUses` recomputes the whole thing from the inputs (`src/optimizing/ir/index.ts`).
Every one of those is about the `inputs` array. A frame state naming a node is not an
input, does not go through `addInput`, and is invisible in `uses`.

> **New idea. A second use graph.** A use-def graph answers "who consumes this value?" and
> is the basis of nearly every optimization: a value with no consumers can be deleted, a
> value with one consumer can be fused into it, a value's consumers are what you rewrite
> when you replace it. tera's graph has **two** such relations over the same nodes. The
> first is the value graph — `inputs` and `uses` — and it is the one every textbook
> describes. The second is the frame-state graph: a set of edges from *deoptimizing nodes*
> to *every value the interpreter frame would hold at that point*, reachable only by
> walking each node's `frameState` chain. The two relations are almost disjoint in
> practice, which is precisely what makes the second one easy to forget. A node can have
> zero consumers in the first and five in the second.
>
> The consequence is not subtle, and it is the reason this chapter exists:
> **`node.uses.length === 0` does not mean the node is dead.** A liveness predicate that
> consults only the value graph will delete a node the frame states still name. Nothing
> crashes at compile time — the frame state's slot still holds a `CFGInstruction` object,
> and JavaScript is perfectly happy to keep a reference to a node that is no longer in any
> block. It crashes, or answers wrongly, at *deoptimization* time, when the machinery goes
> to look up where that value lives and there is no such value. It is a use-after-free with
> the free and the use separated by a compile and a run.

The correct predicate is six lines, and it is the only one this book allows on the JIT path:

```ts
  removeIfDead(node: CFGInstruction | null | undefined): boolean {
    if (!node || node.uses.length > 0) return false;
    if (frameStateReferences(this.graph, node)) return false;
    this.remove(node);
    return true;
  }
```
— `src/optimizing/ir/editor.ts:31-36`

Two questions, both relations, one answer.
`[t: tests/optimizing/ir/editor.test.ts > "removes an unused node that no frame state names"]`
and
`[t: tests/optimizing/ir/editor.test.ts > "keeps an unused node a frame state still names"]`
are the same graph with and without the second edge, and they differ in the answer.

One pass got this right from the start, before there was a predicate to share.
`eliminateDeadPhis` (`src/optimizing/passes/dce.ts:109-139`) builds a `frameStateReferenced`
set by walking every node's frame state through `visitFrameStateValues`, and then removes
only phis for which `phi.uses.length === 0 && !frameStateReferenced.has(phi)`. It is worth
noticing why dead-phi elimination was the one place the rule was obvious: phis at a loop
header are *exactly* the values a frame state in the loop body names, so getting it wrong
there fails immediately rather than occasionally.

## The bug that taught it

*(Bug as engineering.)*

**Symptom.** A function containing a `print` could not be optimized. `--print-ir` showed a
graph that looked correct, and the JIT quietly fell back to the baseline tier without
naming a reason a user would recognise; with graph validation on, the failure surfaced as a
frame-state value with no definition.

**Mechanism.** Look at the top-level graph of the running example.

```
$ node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera
    v27 = LoadGlobal [name="print"]
    v28 = LoadGlobal [name="report"]
    v29 = LoadGlobal [name="latency"]
    v30 = GenericCall v28, v29 [argCount=1] !fs
    v31 = GenericCall v27, v30 [argCount=1] !fs
```

`v31` is `print(report(latency))`. Its callee is `v27`, a `LoadGlobal` of the name `print`.
`global-builtin-lowering` recognises that shape and rewrites it: it emits a `CallBuiltin`
for the intrinsic, re-homes the original's frame state onto the replacement, redirects
every use, removes the `GenericCall`, and then retires the now-unused `LoadGlobal`:

```ts
  if (irRequiresFrameState(replacement)) replacement.frameState = node.frameState;
  editor.insertBefore(node, replacement);
  editor.replaceAllUses(node, replacement);
  editor.remove(node);
  editor.removeIfDead(callee);
```
— `src/optimizing/passes/global-builtin-lowering.ts:253-257`

The last line used to read `if (callee.uses.length === 0) editor.remove(callee)`. And
`print`, at that point in the bytecode, is also sitting in a live bytecode register — it
was loaded into one before the call — so the frame states captured at that offset name
`v27` in a local slot. After the rewrite, `v27` has no *value* consumers, because its only
consumer was the `GenericCall` that was just removed. It has a frame-state consumer. The
old predicate saw the first and deleted it.

This was never about the top level, though the top level is where it was easiest to see: a
module's last statement is usually a call whose arguments are still live, so the shape
occurs there every time. Any function calling any global builtin hit it.

**Scope.** The predicate was not in one place. Ten lowering passes had each copy-pasted the
same three-token test after their own rewrite, because "the callee has no uses now, so
retire it" is the obvious thing to write and it is right in the value graph.

**Fix.** One predicate, `GraphEditor.removeIfDead`, and a companion for the cascading case,
`removeDeadChain`. Every lowering pass now calls one of the two; `removeIfDead` has eighteen
call sites across twelve files. `grep -rn "uses.length === 0" src/` returns twenty hits, and
none of them is a lowering pass deleting a node: they are backend emission choices ("this
call's result is unused, so emit it as a statement"), analysis questions that answer `false`
or `continue`, two builder-time shape tests on nodes that were created moments earlier, and
`eliminateDeadPhis` at `dce.ts:127`, which pairs the test with its own frame-state set.

**Regression test.** `tests/e2e/optimizing/global-builtins.test.ts`, read in detail in
§ the-second-bug-behind-the-first, plus the seven-case predicate suite in
`tests/optimizing/ir/editor.test.ts`.

**General rule.** *Never decide a node is dead from `uses.length` alone.* More generally: if
a data structure carries two relations over the same objects, no predicate may consult one
of them. Put the predicate in one place so that "consult both" is the only thing anyone can
call.

There is a postscript that matters more than the story, because it is about today's tree
rather than a fixed bug.

> **Unenforced.** The symptom above — a validator error naming a frame-state value with no
> definition — would not surface from the optimizer today. `repairFrameStateDominance`
> (`src/optimizing/passes/osr.ts:276-306`) runs at `src/optimizing/optimizer.ts:192`,
> between the middle end and `validateOptimizedGraph` at `:199`, and it *silently repairs*
> exactly that condition:
>
> ```ts
>       if (!node.frameState) continue;
>       const sunkIds = sunkAllocationIds(node.frameState);
>       visitFrameStateValues(node.frameState, (value, replace) => {
>         if (!(value instanceof CFGInstruction)) return;
>         if (value.type === ir.IR_PARAMETER || value.type === ir.IR_CONSTANT) {
>           return;
>         }
>         if (sunkIds.has(value.id)) return;
>         const defBlock = blockOf.get(value);
>         if (defBlock && dominates(idom, defBlock, block)) return;
>         if (!placeholder) placeholder = ir.irConstant(undefined);
>         replace(placeholder as FrameValue);
>         repaired++;
>       });
> ```
> — `src/optimizing/passes/osr.ts:288-301`
>
> A frame-state value whose definition does not dominate the use — including one that has
> no definition at all, because `blockOf.get(value)` is then `undefined` — is replaced by a
> shared `Constant undefined`. `validateInputAvailable` exempts `IR_CONSTANT` from
> availability checking (`graph-validator.ts:599`), so the repaired frame state passes the
> validator by construction. The pass exists for a good reason — the OSR transform and the
> code motion passes legitimately move definitions, and a deopt frame that names a value the
> optimized code no longer computes has to say *something* — but the count it returns is
> discarded at the call site, so nothing anywhere reports how often a deopt frame is being
> rebuilt with a hole in it. The bet is that liveness already dropped the slots that
> mattered. Closing this costs reading the return value and either tracing it or refusing on
> it; the honest version is a remark per repair naming the slot.

## The second bug behind the first   ⟨J⟩

Unblocking the JIT for functions containing `print` exposed a second bug that had been
hiding underneath it for as long as the first one existed.

Compiled wasm code cannot call a tera builtin directly; it traps out to a runtime stub,
which reads the opcode and does the call on the host side [Ch 53 § runtime-stubs]. The stub's
`IR_CALL_BUILTIN` case looked up the name in the *method* registry, then in the *namespace*
registry, and if neither matched fell through to `return runtimeReturn(mkUndefined(), …)`.
There is a third registry. `GLOBAL_BUILTIN_DECLARATIONS`
(`src/optimizing/metadata/builtin-methods.ts:138-147`) holds eight entries — `print`,
`input`, `throw`, `parse_int`, `parse_float`, `tera_now`, `tera_wait` and
`String.fromCharCode` — and none of them was consulted. In optimized code, every one of
them was a no-op that answered `undefined`. `print` printed nothing. `parse_float`
answered `undefined`.

That bug was invisible for a simple reason: nothing containing a `print` ever reached the
JIT, because the first bug refused it. The fix is `callBuiltinGlobal`, which reads the
global cell and calls what it finds the way `callBuiltinNamespace` already did:

```ts
function callBuiltinGlobal(
  intrinsic: BuiltinIntrinsic,
  args: TaggedValue[],
  runtime: RuntimeLike,
  compiledFn: RegisterCompiledFunction,
  frameStateId: number,
  frameStates: FrameState[],
): TaggedValue {
  const cell = runtime.interpreter.globalCells.get(intrinsic.name);
  const callee = cell ? cell.read() : undefined;
```
— `src/optimizing/backends/wasm/runtime-support.ts:485-494`

and the third lookup that calls it, at `runtime-support.ts:996-1010`.

**General rule.** *A bug that blocks a code path hides every bug on that path.* When you
unblock one, the differential test for the newly-reachable path is part of the fix, not a
follow-up — the code behind the block has never run, and "it compiled" is not evidence.

`tests/e2e/optimizing/global-builtins.test.ts` is that test. It builds a twelve-hundred
iteration loop around a function that calls the builtin, runs it twice at two tiering
policies — `{ jitThreshold: 1e12, baselineThreshold: 1e12 }` and
`{ jitThreshold: 30, baselineThreshold: 3 }` — asserts that the first optimized *nothing*
and the second optimized the hot function by name, and only then compares the printed
lines. Asserting that the tier was actually reached is what makes it a regression test
rather than a coincidence.
`[t: tests/e2e/optimizing/global-builtins.test.ts > "prints every line the interpreter prints"]`
covers `print` (1,201 lines, compared element by element) and
`[t: tests/e2e/optimizing/global-builtins.test.ts > "answers what the builtin answers in the interpreter"]`
covers `parse_float`.

## The index and what it costs

`frameStateReferences` is called once per candidate removal, and answering it by rescanning
every frame state in the graph would make each removal proportional to the size of the whole
function. So there is an index:

```ts
export function frameStateReferences(
  graph: FrameStateGraph,
  value: FrameValue | null | undefined,
): boolean {
  if (!value || typeof value !== "object") return false;
  if (!graph._frameStateIndex) buildFrameStateIndex(graph);
  return graph._frameStateIndex!.has(value);
}
```
— `src/optimizing/ir/frame-state-values.ts:191-198`

`buildFrameStateIndex` (`:165-185`) walks every node's frame state once and records, for
each node-shaped value it finds, the list of *locations* that hold it — where a location is
just the `replace` closure `visitFrameStateValues` hands the visitor. The result is
`Map<FrameValue, { replace }[]>`, stored on the graph as `_frameStateIndex`. Membership is
then a single map lookup
`[t: tests/optimizing/ir/frame-state-values.test.ts > "builds index mapping node → replacement locations, clearFrameStateIndex nulls it"]`.

The same index doubles as the fast path for the other operation over this relation.
`replaceGraphFrameStateValue` (`:140-163`) is what a pass calls when it replaces a value
everywhere: with an index it looks up the old node's locations, calls each `replace`,
deletes the old key, and *migrates the entries to the new key* so the index stays correct
for the value that took its place; with no index it falls back to a full
`visitGraphFrameStateValues` scan
`[t: tests/optimizing/ir/frame-state-values.test.ts > "uses indexed fast path when _frameStateIndex is built"]`.

Two properties are worth stating plainly, because everything in the next two sections
follows from them.

The index is a **cache over a relation the graph already holds**. It is never the source of
truth; `visitGraphFrameStateValues` always is. And `clearFrameStateIndex` — a one-line
function that nulls the field (`:187-189`) — is the only way for a caller to say *I no
longer trust it*.

Rebuilding is the pass manager's job. `cfgPassManager` installs one maintenance hook, and
frame states are half of it:

```ts
export function maintainGraph(graph: CFGFunction): void {
  homeFloatingValues(graph);
  buildFrameStateIndex(graph);
}
```
— `src/optimizing/pipeline.ts:70-73`

`homeFloatingValues` re-attaches any value a pass left with no block to the entry block;
`buildFrameStateIndex` rebuilds the relation from scratch. The same manager runs the middle
end and the backend lowering pipeline, so both roads get it.

## Stale within one pass

The hook fires *between* passes, and there is a second condition on it that the pipeline
does not advertise:

```ts
    if (outcome.changed && this.maintain !== null) this.maintain(graph);
```
— `src/optimizing/infra/pass-manager.ts:103`

Only after a pass that reported `changed`. Chapter 41's thesis — that everything hinges on
a pass reporting truthfully whether it changed anything — has its sharpest instance right
here: a pass that removes a frame-state-carrying node and returns `changed: false` leaves a
stale index for every pass that follows it.

Inside a single pass, staleness is not a corner case; it is the normal condition. The moment
a pass removes a node that *carried* a frame state, every value that frame state named keeps
its entries in the index, because nothing told the index the frame state went away. The
index now over-reports. `frameStateReferences` answers `true` for a node nothing names any
more, and `removeIfDead` **over-refuses**: it declines to remove a node that is genuinely
dead.

Over-refusal is the safe direction, and in most lowering passes it is harmless. Refusing to
retire one `LoadGlobal` leaves one dead node in the graph, and dead-code elimination — which
has the same predicate available — collects it later. Nothing is wrong; one removal was
skipped.

It is not harmless in `promise-surface`, and that is where the invalidation policy came
from. `src/optimizing/passes/promise-surface.ts` rewrites the whole `Promise.resolve` /
`.then` / `.catch` surface into synthetic async functions, and each rewrite has to retire a
*chain*: the `LoadGlobal` for `Promise`, the `GenericGetProp` for the member, the receiver
call that produced the promise. If any link in that chain survives, the original generic
calls survive with it, and the AOT legality check refuses the entire entry function with

```
the promise tera_promise$resolve$0 returns is used as a plain value here; await it before using it, or keep this part interpreted
```
— the message built at `src/optimizing/drivers/aot.ts:355-356`

which is a refusal with no relation at all to what actually went wrong. A pass that over-
refuses one removal in a hundred leaves one dead node behind in a JIT lowering and causes a
compile failure here, because `promise-surface` runs on the module before anything can clean up
after it and its output feeds a legality gate that is looking for exactly the nodes it
failed to remove.

## Where the invalidation lives, and why not elsewhere

The answer is `removeDeadChain`, and it invalidates twice:

```ts
  removeDeadChain(node: CFGInstruction | null | undefined): number {
    if (!node) return 0;
    clearFrameStateIndex(this.graph);
    let removed = 0;
    const worklist = [node];
    while (worklist.length > 0) {
      const candidate = worklist.pop()!;
      if (candidate.block === null) continue;
      const inputs = [...candidate.inputs];
      const carried = candidate.frameState !== null && candidate.frameState !== undefined;
      if (!this.removeIfDead(candidate)) continue;
      removed++;
      if (carried) clearFrameStateIndex(this.graph);
      for (const input of inputs) worklist.push(input);
    }
    return removed;
  }
```
— `src/optimizing/ir/editor.ts:38-54`

Once on entry, so the cascade starts from ground truth however stale the caller left things.
And again after removing any node that *carried* a frame state, because that removal is
precisely the event that orphans index entries. `frameStateReferences` rebuilds lazily on
the next query, so each step of the cascade sees the relation as it actually is.

The cost is one full rebuild per orphaning removal. That is acceptable *in this cascade*
because the passes that call `removeDeadChain` already call `graph.rebuildUses()` once per
rewrite site — `promise-surface`'s `swap` does exactly that
(`promise-surface.ts:338-350`) — so the per-site work is already linear in the function.

The deliberate part is where the invalidation is **not**. It is not in `remove`, and it is
not in `removeIfDead`. Putting it there would be the obvious "correct by construction"
choice, and it would make every JIT lowering pass quadratic: those passes remove
frame-state-carrying nodes at nearly every site, and each removal would trigger a rebuild
proportional to the size of the function.

So the policy lives in the cascade, not in the primitive. `removeIfDead` triggers no rebuild
and may therefore be stale in the over-refusing direction; `removeDeadChain` is exact and
pays a rebuild for it. A caller
that needs exactness asks for the cascade. This is a decision, not an oversight, and the
book states it as one because from the outside the two functions look like they should have
the same invalidation behaviour.

> **Unenforced.** `graph._frameStateIndex` has no staleness marker, no generation counter
> and no assertion. `frameStateReferences` cannot distinguish a fresh index from one four
> removals out of date; it answers from whatever is in the field. The only defences are the
> `maintain` hook and the discipline inside `removeDeadChain`, and the only way to discover
> that a pass got it wrong is a refusal much further downstream, in a message that names
> something else. Closing it costs a version counter on `CFGFunction` bumped by `remove`,
> compared on every index query.
>
> The field is also declared **twice, in two shapes**:
> `Map<FrameValue, { replace(next: FrameValue): void }[]> | null` on
> `src/optimizing/ir/index.ts:280`, and `Map<FrameValue, FrameStateIndexLocation[]>` on
> `src/optimizing/ir/frame-state-values.ts:24`. They are structurally compatible today, so
> nothing catches a future divergence, and the underscore-prefixed name is a public
> property that any code may write.

## What was tried and rejected

*(What was tried and rejected.)*

The rebuild walks every frame state in the function, and it is tempting to avoid it. The
design that suggests itself is
to make the index self-invalidating: tag each entry with the node that *owns* the frame
state it came from, and when an owner is removed, treat that owner's entries as gone. No
rebuild, no `clearFrameStateIndex`, no discipline required from callers.

It is unsound, and the reason is a pattern that runs through every lowering pass in the
tree. A pass that replaces a node does not build a new frame state; it **re-homes the
existing one**:

```ts
  if (irRequiresFrameState(replacement)) replacement.frameState = node.frameState;
```
— `src/optimizing/passes/global-builtin-lowering.ts:253`

and then removes `node`. The identical two-step appears in `array-methods`,
`array-shapes`, `class-member-lowering`, `string-split`, `builtin-domains`,
`builtin-method-lowering`, `text-method-calls` and `iterator-lowering`. One `FrameState`
object is now owned by a different node, and the old owner is about to disappear.

Under the owner-tagging scheme, removing the old owner would mark that frame state's entries
dead — and the very next `removeIfDead` would delete values the *live, re-homed* frame state
still names. That is the bug § the-bug-that-taught-it fixed, reintroduced by the
optimization meant to spare the rebuild. Only a rebuild sees the re-homing, because
re-homing changes which node points at a `FrameState`, not the `FrameState` itself, and an
index keyed by identity has no way to observe it.

**General rule.** *An index over a relation that other code rewrites in place cannot be
invalidated by identity.* Either the rewriters tell the index (which is the same discipline
problem one level down), or the index is rebuilt. tera rebuilds.

## Caller chains

When the builder inlines a callee — decided and performed during construction, chapter 39 —
the callee's frame states are not free-standing. A deoptimization from inlined code has to
rebuild **N interpreter frames**, one per level of inlining, because the interpreter has no
idea the inlining happened and expects a real call stack. So
`captureFrameStateWithCaller` links them:

```ts
  setCallerFrame(callerFS: FrameState): void {
    this.callerFrameState = callerFS;
    this.isInlinedFrame = true;
  }
```
— `src/deopt/frame-state.ts:78-81`

`[t: tests/optimizing/builder/frame-state.test.ts > "marks a frame given a caller as an inlined one"]`
pins the marking, and `src/deopt/deoptimizer.ts:259` and `:300-301` are where the chain is
walked to build the outer frames.

The chain has a consequence for every visitor in `frame-state-values.ts`: each of them
recurses through `callerFrameState`, so each of them can loop forever if the chain ever
becomes cyclic. All but one carry a `seen` set — `visitFrameStateValues` takes it as a
defaulted third parameter (`:101-106`), `visitDeoptSnapshotValues` builds one locally
(`:60`), `validateFrameStateValues` threads one through (`graph-validator.ts:486-548`), and
`repairFrameStateDominance` inherits it from
`visitFrameStateValues`. A cycle should be impossible — the builder links a callee's frames
to a caller's, and calls do not nest into themselves — but "should be impossible" and
"hangs the compiler with no output" is a bad pair, and the guard is pinned directly
`[t: tests/optimizing/ir/frame-state-values.test.ts > "does not infinite-loop on circular callerFrameState"]`
alongside
`[t: tests/optimizing/ir/frame-state-values.test.ts > "recursively visits callerFrameState"]`.

> **Unenforced.** `sunkAllocationIds` (`src/optimizing/ir/frame-state-values.ts:27-35`) is
> the exception, and it is the awkward one. It walks the same caller chain with a bare
> `for (let state = frameState; state; state = state.callerFrameState)` at `:31` and carries
> no `seen` set at all, so on the cycle the sibling visitors survive it spins forever. Its
> two callers are exactly the two places this chapter has already been: the validator
> (`graph-validator.ts:497`, inside the `seen`-guarded `validateFrameStateValues`) and
> `repairFrameStateDominance` (`osr.ts:289`, just before the `seen`-guarded
> `visitFrameStateValues`). The guard the tests pin therefore protects the walk *after*
> the unguarded one has already returned. Closing it costs the three lines its sibling at
> `:56-66` already has: a local `Set`, a `has` test, an `add`.

> **Never runs.** `FrameState.getInlineChain` (`src/deopt/frame-state.ts:133-141`) and
> `getInlineDepth` (`:143-151`) return the caller chain as an array and its length. Both
> have zero call sites in `src/`; every consumer — the deoptimizer, the frame materializer,
> escape analysis, the wasm codegen, the validator — writes its own
> `for (let s = fs; s; s = s.callerFrameState)` loop instead. They have two tests
> `[t: tests/deopt/frame-state.test.ts > "getInlineChain returns chain from inner to outer"]`.
> `getLocalsArray` (`:124-131`) is in the same position. Deleting all three costs 27 lines
> and one `describe` block; adopting them costs six loop rewrites.

Two more parts of `src/deopt/frame-state.ts` are reachable only from tests.

> **Never runs.** `FrameStateBuilder` (`src/deopt/frame-state.ts:228-291`) is a
> `capture` / `getState` / `count` / `dump` façade over `FrameState`, with nine tests and
> zero call sites in `src/`. The builder path uses the free functions in
> `src/optimizing/builder/frame-state.ts` and pushes into a plain array that
> `src/optimizing/optimizer.ts` owns as `this.frameStates`. Deleting it costs 64 lines and
> one `describe` block.
>
> **Never runs.** `FrameState.matches` (`:153-167`) has eight tests and no callers — every
> `.matches(` in `src/` belongs to `src/feedback/ic/index.ts`. It is also incomplete if
> anyone did adopt it: it compares `compiledFunction`, `bytecodeOffset`, locals and stack,
> but not `thisValue`, `callerFrameState` or `sunkAllocations`, so two frames differing only
> in the receiver or in the inline chain compare equal. Adopting it — for instance to
> deduplicate identical frame states in the flat array — costs three more comparisons first.

## Eighteen lines that say what a frame state is for   ⟨N⟩

The whole of `src/optimizing/passes/frame-state-elision.ts`:

```ts
export function elideFrameStates(
  graph: CFGFunction,
  target: TargetModel,
): number {
  if (target.capabilities.has("deopt")) return 0;
  let elided = 0;
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!node.frameState) continue;
      node.frameState = null;
      elided++;
    }
  }
  return elided;
}
```
— `src/optimizing/passes/frame-state-elision.ts:4-18`

The argument is one sentence. A frame state exists so that a speculating compiler can undo a
speculation; a target that cannot deoptimize never undoes anything; therefore on such a
target the description is pure weight.

`deopt` is one of eleven entries in `Capability`
(`src/optimizing/target/capabilities.ts:1-11`), and exactly one target in the tree declares
it: `capabilitySet("deopt", "osr", "tagged-values", "float-text")` in
`src/optimizing/backends/wasm/target.ts:7`. The C backend, the x64 backend and the riscv64
backend declare `terminating-throw`, `float-text` and various codegen capabilities, and
none declares `deopt` — which is the same fact as [Ch 1 § the-hinge]'s "there is nothing
underneath it", expressed as a capability set. `frame-state-elision` is registered as an
ordinary pass in the backend lowering pipeline, `preserves: { kind: "all" }`, at
`src/optimizing/target/legalization.ts:409-413`, so it runs through the same pass manager as
everything else and its outcome is visible in the pass trace.

Which is how the claim is measured. `stats.tera` compiles to twenty-one graphs, and the
native road reports:

```
$ node dist/cli.js compile docs/example/stats.tera -o stats.exe --print-after-all \
    | grep -c "frame-state-elision \[changed"
19
```

Nineteen graphs changed; the other two report `[unchanged]`, and they are named in the trace:
`_FixedDigits.div` and `_FixedDigits.mod`, both from the `to_fixed` prelude. Neither had a
single frame state to delete, and § who-must-own-one already said why — by the time
`frame-state-elision` sees it, `div` is three parameters and a single block of three nodes:

```
    v422 = Float64Div v1, v2
    v9 = CallBuiltin v422 [builtin=true, target={…}, declaredEffects=["immutable-read"], readonly=true, name="Math.floor", argCount=1]
    v7 = Return v9
```
— block `B0` of `fn _FixedDigits.div` in the same `--print-after-all` trace, with the
`target={declaredSignature: …}` record elided

A float divide is `DEOPT_NEVER`, a `CallBuiltin` declared `immutable-read` resolves to
`IMMUTABLE_READ` which is also `DEOPT_NEVER`, and a return cannot bail out. There was nothing
to elide because nothing in that function was ever allowed to guess.

Every `[changed]` line reads `nodes N -> N (+0)`. Elision removes no nodes; it nulls
pointers. What it removes is an entire relation.

That is the tier consequence, and it holds from here to the end of Part X: **on the native
road, past this pass, `uses.length === 0` really is death** — there is no second graph left
to consult, and `removeIfDead` and `removeDeadChain` degenerate to exactly the naive
predicate the JIT road may never use. On the JIT road, they never do.

> `elideFrameStates` is `[unpinned]` — there is no unit test for the pass itself. It is
> observed through `--print-after-all` and through the native end-to-end suites, which
> would fail loudly if it deleted a frame state on a target that had `deopt`.

## What checks this, and what does not

Two validators exist and they check different things.

`validateGraphInvariants` (`graph-validator.ts:109-118`) runs the structural checks:
opcodes, node identity, ownership, phi arity, control flow, use-def dominance, use lists.
It does not look at frame states at all.

`validateOptimizedGraph` (`:120-135`) runs the same structural checks *plus*
`validateFrameStates` (every deopt-capable node has one, and it belongs to this compilation)
and `validateFrameStateValueDominanceWith` (`:464-484`), which walks every frame-state value
through the same availability rules as an ordinary input and rewrites the error to name the
slot:

```
B3 v12 frame state local 1 B3 v12 uses v9 with no definition
```

The block and node appear twice because the rewrite (`graph-validator.ts:571-574`) prepends
`B<block> v<node> frame state <slot>` to a message `validateInputAvailable` had already
prefixed with `B<block> v<node>`. Nothing consumes the string but a human, so nothing has
forced the duplication out.

The gap is in which one runs where. `--verify` on `tera compile`, and
`CompilerOptions.verifyEachPass` generally, install `verifyAfterPass`
(`src/optimizing/pipeline.ts:291-299`), and that calls **`validateGraphInvariants`**. So the
per-pass verifier — the instrument [Ch 78] is about, and the one you
reach for when a pass is suspected — is blind to frame states by construction. Running
`node dist/cli.js compile docs/example/stats.tera -o stats.exe --verify` checks thirty-plus
passes and never once asks whether a frame state still names a value that exists.

`validateOptimizedGraph` has exactly two call sites, and which roads reach them is easy to
get backwards, so it is worth being precise:

- `src/optimizing/optimizer.ts:199`, at the end of `build()`. `build()` is shared: the JIT
  reaches it through `compile`, and the AOT road reaches it through `compileStatic`
  (`optimizer.ts:107-120`), which `Engine.compileAotUnit` calls once per function
  (`src/api/engine.ts:1156`). **Both roads validate here**, once per function, with frame
  states intact — elision is much later, in backend legalization.
- `src/optimizing/backends/wasm/codegen.ts:3955`, at the top of `compile`, JIT only. A
  failure there is turned into a compile rejection rather than an exception, and reported as
  `Wasm: graph validation failed: …`.

That second one is worth reading correctly when you meet it. Backend legalization runs
*after* the optimizer's own `validateOptimizedGraph`, so a graph that passed at
`optimizer.ts:199` and fails at `codegen.ts:3955` was broken by a **legalization pass**, not
by the builder and not by the middle end.

So what is actually unchecked is narrower than "the AOT road", and sharper:

> **Unenforced.** Frame states survive `build()`'s validation and then go through the entire
> module-level AOT pipeline in `src/optimizing/drivers/aot.ts` — `closure-conversion`,
> `promise-surface`, `argument-specialization`, `adopt-inferred-types`, and
> `inlineModuleCalls`, which calls `runMiddleEnd(graph, …)` a second time on any graph it
> rewrote (`aot.ts:657`) — and **nothing validates them again**. Every one of those passes
> can orphan a frame-state value. The damage is then invisible for two independent reasons:
> `frame-state-elision` deletes the evidence during legalization, and the native target
> could not have deoptimized anyway, so the wrong description is never read. It is still a
> graph invariant being broken silently, and the same passes run on graphs whose frame
> states matter when the module pipeline is used for anything speculative. Closing it costs
> calling `validateOptimizedGraph` (or at minimum `validateFrameStateValueDominanceWith`)
> after each module stage, and threading the per-unit `frameStates` array to it — the units
> already carry it as `unit.frameStates`.
>
> Adding the frame-state checks to `verifyAfterPass` (`pipeline.ts:291-299`) would close the
> per-pass half of the same gap, and needs the same threading: `verifyAfterPass` receives
> only the graph, and `validateFrameStates`' third error depends on the frame-state list.

## What leaves

Two graphs, one shape — and from here, two roads that have different numbers of them.

**To the JIT:** the same `CFGFunction`, every frame state intact, `_frameStateIndex` built
and maintained by the pass manager's `maintain` hook after any pass that reported a change,
and a validator at the end of `build()` that refuses any deoptimizing node which lost its
frame state. Everything Part VII does to this graph, it does under one rule:
`GraphEditor.removeIfDead` is the only correct liveness predicate, `removeDeadChain` is the
only correct cascade, and `uses.length === 0` is not death. The rule is not advice; it is
the reason `src/optimizing/ir/editor.ts` exists as a class instead of three free functions.

**To the native compiler:** the same `CFGFunction`, and — after `frame-state-elision` fires
during backend legalization — *every* frame state set to `null`, because no native target
declares the `deopt` capability. On that road, and only on that road, the second use graph is
empty and the two predicates collapse into the naive one. That is not a licence to write the
naive one: the passes are shared, and a pass written for the native road runs on the JIT road
too.

Part VII takes whichever of the two it was handed and starts folding. The first thing it
needs is a way to run thirty-four passes over a mutable graph while keeping track of which
analyses each one invalidated, which is [Ch 41]'s subject — and the frame-state index is one
of the two things its `maintain` hook rebuilds.

## Verify it yourself

```bash
# the JIT keeps them: !fs on every node that can give up
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  --filter mean docs/example/stats.tera

# the print-lowering shape the bug lived in: v27 = LoadGlobal "print" feeding v31
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 \
  docs/example/stats.tera | sed -n '31,35p'

# the native compiler deletes them: 19 of stats.tera's 21 graphs changed, 2 had none
node dist/cli.js compile docs/example/stats.tera -o stats.exe --print-after-all \
  | grep -c "frame-state-elision \[changed"
node dist/cli.js compile docs/example/stats.tera -o stats.exe --print-after-all \
  | grep -c "frame-state-elision \[unchanged"

# and the binary that comes out still agrees with the interpreter
node dist/cli.js compile docs/example/stats.tera -o stats.exe --verify && ./stats.exe

# the two liveness predicates, the cascade, and the index (24 tests)
npx vitest run --project unit tests/optimizing/ir/editor.test.ts \
  tests/optimizing/ir/frame-state-values.test.ts

# the capture filter, per offset (13 tests)
npx vitest run --project unit tests/optimizing/builder/frame-state.test.ts

# the two regressions: the liveness filter, and the global builtins it unblocked (6 tests)
npx vitest run --project e2e tests/e2e/optimizing/frame-state-liveness.test.ts \
  tests/e2e/optimizing/global-builtins.test.ts

# a frame state actually used, end to end: resume point, and the value it resumed with
node dist/cli.js --trace-deopt docs/example/stats-deopt.tera
```

The last one prints `[DEOPT] DEOPT "total_of": elements-kind-check-failed at bytecode:8`
between the two answers. `bytecode:8` is `frameState.bytecodeOffset`, and
`taint total=21.531.257.7518` is the arithmetic the interpreter finished with the values
`frameState.localValues` handed it: `12.5 + 9.0` had already happened in compiled code,
`"31.25"` and everything after it happened in the interpreter.

Two commands that do **not** show what a reader might expect, stated so nobody spends an
afternoon on them. `--print-ir` on default thresholds prints nothing for `stats.tera`,
because `stats.tera` never gets hot enough to tier up — the explicit `--opt-threshold 1
--baseline-threshold 1` above is doing the work. And no flag in this engine prints the
*contents* of a frame state; see the `> **Unfinished.**` note in § what-a-frame-state-holds.

## Tests that pin this

- `tests/optimizing/ir/editor.test.ts` > `"removes an unused node that no frame state names"`
  and > `"keeps an unused node a frame state still names"` — the same graph with and without
  the second edge; the whole chapter in two assertions.
- `tests/optimizing/ir/editor.test.ts` > `"removes a chain of inputs stranded by the root"`
  and > `"stops the chain at an input another node still uses"` — `removeDeadChain`'s value-graph
  behaviour.
- `tests/optimizing/ir/editor.test.ts` > `"stops the chain at a node a live frame state names"`
  — the cascade honours the second relation too.
- `tests/optimizing/ir/editor.test.ts` > `"frees inputs named only by a frame state the chain itself removed"`
  — the invalidation policy, directly: the chain removes a frame-state-carrying node, clears
  the index, and the *next* step then correctly sees the freed input as dead.
- `tests/optimizing/ir/editor.test.ts` > `"leaves unhomed inputs such as parameters in place"`
  — a parameter is detached from its block but stays in `graph.parameters`.
- `tests/optimizing/ir/frame-state-values.test.ts` > `"visits locals, stack, and thisValue with replacement callbacks"`
  — the visitor covers all three storage kinds and hands back a working `replace`.
- `tests/optimizing/ir/frame-state-values.test.ts` > `"recursively visits callerFrameState"`
  and > `"does not infinite-loop on circular callerFrameState"` — the inline chain and the `seen` guard.
- `tests/optimizing/ir/frame-state-values.test.ts` > `"uses indexed fast path when _frameStateIndex is built"`
  and > `"builds index mapping node → replacement locations, clearFrameStateIndex nulls it"`
  — the index and the two operations over it.
- `tests/optimizing/ir/frame-state-values.test.ts` > `"adds frame state values to liveNodes set and worklist"`
  — `markFrameStateValues`, the hook any mark-and-sweep pass needs to see the second graph.
- `tests/optimizing/builder/frame-state.test.ts` > `"carries a register the resume point still reads"`
  and > `"leaves out a register nothing reads before it is overwritten"` — the filter, both ways.
- `tests/optimizing/builder/frame-state.test.ts` > `"decides per offset, so one register is dropped at one point and kept at another"`
  — liveness is per offset, not per function.
- `tests/optimizing/builder/frame-state.test.ts` > `"keeps a register the loop reads again only after the backedge"`
  — the case a forward walk gets wrong.
- `tests/optimizing/builder/frame-state.test.ts` > `"keeps a register a closure captured, however dead the bytecode reads"`
  and > `"keeps every register when the bytecode holds an opcode liveness cannot model"`
  — two of the three escapes, both failing toward a bigger frame.
- `tests/optimizing/builder/frame-state.test.ts` > `"marks a frame given a caller as an inlined one"`
  — `setCallerFrame` sets both fields.
- `tests/optimizing/validation/graph-validator.test.ts` > `"throws when deopt-capable node lacks frame state"`
  and > `"passes when deopt-capable node has frame state"` — `validateFrameStates`' first error.
- `tests/optimizing/ir/call-builtin.test.ts` > `"still requires a frame state so deoptimization can rebuild the frame"`
  — a plain `CallBuiltin` inherits `UNKNOWN_CALL`.
- `tests/optimizing/ir/operations.test.ts` > `"derives call effects from the effects the caller declared"`
  — and one declared `immutable-read` does not, which is why two of `stats.tera`'s graphs
  have no frame states at all.
- `tests/optimizing/ir/operations.test.ts` > `"stops requiring a frame state once overflow is proven impossible"`
  — `props.noOverflow` retires a `DEOPT_ON_OVERFLOW` obligation.
- `tests/e2e/optimizing/frame-state-liveness.test.ts` > `"still reads a loop local that a closure captured"`,
  > `"still deoptimizes correctly after the loop temporaries were pruned"`,
  > `"still reads a local only the next iteration goes back for"` and
  > `"still resumes with the current value of a reassigned parameter"`
  — four programs run through `differential()` at every tier, each shaped so that a
  wrongly-pruned slot changes the answer.
- `tests/e2e/optimizing/global-builtins.test.ts` > `"prints every line the interpreter prints"`
  and > `"answers what the builtin answers in the interpreter"` — the second bug's regression
  test, which also asserts the JIT tier was actually reached.
- `tests/deopt/frame-state.test.ts` > `"getInlineChain returns chain from inner to outer"`
  — a test for a method with no callers in `src/`; see the `> **Never runs.**` note in
  § caller-chains.
- `elideFrameStates` itself is `[unpinned]`: no unit test, observed only through
  `--print-after-all` and the native end-to-end suites.
- That `repairFrameStateDominance` substitutes `undefined` rather than reporting is
  `[unpinned]`: no test asserts a repair count, and the count is discarded at the call site.
