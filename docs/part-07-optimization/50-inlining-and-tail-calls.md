# 50. Inlining and tail calls   ⟨J · N⟩

Compile a three-function program ahead of time with `--print-after-all` and count how many
times the pipeline says `#-1 ir-builder`. For most programs the answer is one record per
function. For a program where one function was inlined into another, the caller gets **two**,
because the module inliner runs the entire thirty-three-pass middle end again on every caller
it changed. Pass ordinal 8 is not a unique point in a compile. That is the first surprise in
this chapter and the one most likely to make a `--print-after-all` dump unreadable if you do
not know it.

The rest is three mechanisms that have to agree with each other. A **cost model** decides
whether a callee is worth its code at a particular call site — a small piece of arithmetic
with two bonuses in it, one of which is worth three times the other for a reason the numbers
state out loud. A **splice** copies the callee's nodes into the caller and repairs the SSA
form afterwards, which for a callee with control flow means inventing a merge point the
source never wrote. And a set of **refusals** names everything splicing would break: a
context slot indexed relative to the wrong frame, a suspended coroutine that belongs to one
function, a produced string whose characters are owned by the frame that made them.

Tail calls get the last third of the chapter, and the honest headline is that tera does not
have them. `rewriteSelfTailCalls` turns a function that calls *itself* in tail position into
a loop, which is the case that matters most and the only one implemented. A tail call to a
different function is compiled as an ordinary call and grows the stack on every target.

`stats.tera` **cannot reach this chapter**, and the reason is exact rather than incidental.
Both of its cross-function calls are excluded by construction: `report(s)` calls `s.label()`,
and `callSiteOf` returns `null` for any `IR_GENERIC_CALL` carrying `props.isMethod === true`
(`src/optimizing/passes/inlining.ts:152`); `Series.label` declares `returns: string`, which
`inlinable` refuses outright (`:169`). Measured: compiling `docs/example/stats.tera` produces
exactly **21** `#-1 ir-builder` records for **21** functions — one apiece, so nothing was
re-optimized, so nothing was inlined. The three-function program this chapter uses therefore
appears as a command under "Verify it yourself" and never as a listing beside the running
example ([Conventions § 2](../CONVENTIONS.md)).

**What arrived.** From [Ch 49](49-speculative-types-are-not-facts.md): the graph after
`type-narrowing`, the cached `TypeInference` with its `speculative` set, and the rule that a
type derived from a guard is only true where the guard survives. Inlining is the first thing
downstream that *moves guarded values into a function where the guard's dominance was
established somewhere else*. It is also, for the AOT road, the first thing that runs outside
the pass manager entirely.

## Inlining

Inlining replaces a call with the callee's body. The call node goes away; the callee's
instructions appear in the caller's blocks with the caller's node ids; the argument nodes are
substituted for the callee's `Parameter` nodes; and whatever the callee returned becomes
whatever the call's users read.

> **New idea. Splicing, and why it is not textual.** In a source-to-source world inlining
> looks like substitution: paste the body, rename the variables. In SSA it is a graph
> operation with three obligations. Every copied node needs a **fresh id** in the caller's id
> space, because ids are unique per graph ([Ch 39 § one-counter-over-one-id-space]). Every
> reference to a `Parameter` has to become a reference to the corresponding **argument node**, which is a
> `replaceInput` on each copied node, not a rename. And if the callee had more than one
> `Return`, the caller now has a **merge point that the source never wrote**, which in SSA
> means a phi ([Ch 38 § canonical-phi-ssa]). The third obligation is why this chapter has two splice
> functions instead of one.

Two limits govern whether it happens at all, and they are different in kind.

> **New idea. A threshold and a budget.** A *threshold* is a per-decision score: is this
> callee worth its code **here**? A *budget* is a per-caller allowance, spent down and never
> refilled: how much extra code may this **one function** grow by in total? A callee can pass
> the threshold and still be refused because the budget ran out, and the reverse. Compilers
> need both because the first controls quality and the second controls the worst case — one
> hot function calling a hundred small helpers would otherwise grow without limit.

The tree spells them as two `CompilerOptions` fields, set per optimization level in
`src/optimizing/options.ts`:

```
level       inlineThreshold   inlineBudget
none                      0              0
baseline                  8             64
speed (default)          24            512
max                      64           2048
```
— `src/optimizing/options.ts:58-59, 72-73, 86-87, 100-101`; the levels are
`OptLevel = "none" | "baseline" | "speed" | "max"` at `:9`, defaulting to `"speed"` at `:116`.

Level `none` sets both to zero, and `inlineKnownCalls` treats a zero *budget* as the off
switch, reporting it and returning before it looks at a single call
(`inlining.ts:310-316`).

The budget is spent by a single linear scan — `for (const block of [...graph.blocks]) for
(const node of [...block.nodes])` (`:322-323`) — with no ranking and no priority queue. So
when the budget runs out, *which* call sites got inlined is decided by the order the IR
builder emitted blocks and nodes.

> **Unfinished.** There is no test that pins budget-exhaustion behaviour at all. Every test
> in `tests/optimizing/passes/inlining.test.ts` runs with a budget large enough for the
> callee, so the decision is never close, and a change to block ordering could silently
> change which functions get inlined in a real compile. Cost of fixing: one test with a
> two-callee caller and a budget that fits exactly one of them, which would also force a
> decision about whether the scan order is intended to be the policy.

## The cost model, arithmetic first

`nodeCost` is a table lookup with a default:

```ts
const COSTED: ReadonlyMap<string, number> = new Map<string, number>([
  [IR_CONSTANT, FREE],
  [IR_PHI, FREE],
  [IR_JUMP, FREE],
  [IR_RETURN, FREE],
  [IR_CALL_KNOWN_FUNCTION, CALL_COST],
  [IR_GENERIC_CALL, CALL_COST],
  [IR_CALL_BUILTIN, CALL_COST],
  [IR_INT32_DIV, ROUTINE_COST],
  [IR_INT32_MOD, ROUTINE_COST],
  [IR_FLOAT64_DIV, ROUTINE_COST],
  [IR_FLOAT64_POW, ROUTINE_COST],
]);
```
— `src/optimizing/passes/inlining.ts:70-82`

with `STEP_COST = 1`, `FREE = 0`, `CALL_COST = 8`, `ROUTINE_COST = 16` (`:62-65`). Constants,
phis, jumps and returns are free because they lower to no instruction, or to something the
register allocator absorbs. Calls cost eight. Integer and float division, modulo and `pow`
cost sixteen, because on every one of tera's targets they lower to a *routine* — a call into
a runtime helper or a multi-instruction sequence — rather than to one instruction
([Ch 64 § dispatch-table]).

`calleeBody` (`:100-118`) sums that over every non-terminator node, and also counts `size`,
the plain node count. **The two are different numbers and they are used for different
things**: `cost` feeds the threshold, `size` is what the budget is spent in. A callee full of
divisions scores high on `cost` and low on `size`.

The whole decision is five lines:

```ts
export function inlineCostOf(site: CallSite, body: CalleeBody): number {
  return (
    body.cost - CALL_COST - site.args.length * ARGUMENT_COST - foldingBonus(site)
  );
}
```
— `src/optimizing/passes/inlining.ts:137-141`

Read it as *what the body costs, minus what the call would have cost*. The `- CALL_COST`
credits the call instruction that disappears; the `- args.length * ARGUMENT_COST` (with
`ARGUMENT_COST = 1`) credits the argument setup that disappears with it. A callee whose body
is smaller than a call therefore scores **negative**, and is inlined at every level whose
threshold is `>= 0` — which is every level where inlining is on at all. The test is
`if (cost > options.inlineThreshold) continue;` (`:350`), so at the default `speed` level a
callee has to cost more than 24 above what the call cost before it is refused.

> **Unfinished.** No test pins the cost model's arithmetic, the budget, or either bonus.
> `inlineCostOf` and `foldingBonus` are both exported and neither is imported by any file
> under `tests/` — `grep -rn "inlineCostOf\|foldingBonus" tests/` returns nothing.
> **[unpinned]** Every inlining test runs with a threshold large enough that the comparison
> at `:350` never decides anything. Cost of fixing: three unit tests over `inlineCostOf`
> directly, which is already exported for exactly that purpose and never used.

## The two bonuses, and why the second is three times the first

A constant argument is worth more than a variable one, because the callee's body can be
folded around it once it is inlined. A constant argument that *decides a branch* is worth
more still, because SCCP will then prove one arm of that branch unreachable and delete it
whole ([Ch 43 § why-constants-and-reachability-must-be-solved-together]).

```ts
function foldingBonus(site: CallSite): number {
  let bonus = 0;
  site.args.forEach((argument, at) => {
    if (argument.type !== IR_CONSTANT) return;
    bonus += CONSTANT_ARGUMENT_BONUS;
    const parameter = site.callee.parameters[at];
    if (parameter !== undefined && decidesABranch(parameter)) bonus += FOLDED_BRANCH_BONUS;
  });
  return bonus;
}
```
— `src/optimizing/passes/inlining.ts:126-135`

`CONSTANT_ARGUMENT_BONUS = 4`, `FOLDED_BRANCH_BONUS = 12`. The design claim the numbers make
is explicit: **a constant that removes control flow is worth three constants that merely
remove an argument.**

`decidesABranch` is a two-level use walk and nothing more:

```ts
function decidesABranch(parameter: CFGInstruction): boolean {
  return parameter.uses.some(
    (use) => use.type === IR_BRANCH || use.uses.some((then) => then.type === IR_BRANCH),
  );
}
```
— `src/optimizing/passes/inlining.ts:120-124`

The parameter feeds a `Branch`, or feeds something that feeds a `Branch`. That is a
*syntactic* approximation of "SCCP will delete an arm of this callee once the argument is
constant" — it does not run SCCP, it does not check that the constant actually decides the
comparison, and it stops after two hops. It is deliberately a heuristic: the pass is choosing
what to attempt, not proving anything, and being wrong costs code size rather than
correctness.

## OPAQUE_TO_INLINING read as a catalogue of what splicing breaks

Seven opcodes make a callee unspliceable, and each is a different way the operation depends
on *which function it is in*:

```ts
const OPAQUE_TO_INLINING: ReadonlySet<string> = new Set<string>([
  IR_LOAD_CONTEXT_SLOT,
  IR_STORE_CONTEXT_SLOT,
  IR_DEOPTIMIZE,
  IR_AWAIT,
  IR_YIELD,
  IR_LOAD_TEXT,
  IR_STORE_TEXT,
]);
```
— `src/optimizing/passes/inlining.ts:50-58`

`LoadContextSlot` and `StoreContextSlot` name a slot **relative to their own function's
context chain** — a depth and an index, resolved by walking outward from the running
function's context ([Ch 20 § resolve-and-the-boundary]). Splice the node into a caller whose
context chain is a different depth and the same numbers name a different variable.

`Deoptimize` names a **bytecode offset in a frame that would no longer exist**. Inlining
removes the callee's frame; a bailout that says "resume at offset 12 of the callee" has
nothing to resume into ([Ch 40 § the-second-use-graph](../part-06-ssa/40-frame-states-describing-a-frame-you-no.md)).

`Await` and `Yield` mark suspension points, and a suspended frame belongs to **one**
coroutine. Splicing half a coroutine into a non-coroutine produces a function that can
suspend but has no frame to suspend into ([Ch 58 § coroutine-lowering]).

`LoadText` and `StoreText` read and write a produced string's characters, which are **owned
by the frame that made them** — the buffer is the callee's, and it is released when the
callee returns ([Ch 59 § string-buffer-lifetimes]).

`calleeBody` returns `null` on the first one it meets (`:111`), and it is also where three
structural refusals live: an entry block with predecessors or phis (`:102`) — that is a
callee whose entry a back edge re-enters, pinned by
`[t: tests/optimizing/passes/inlining.test.ts > "refuses a callee whose entry a back edge re-enters"]` —
a block with no terminator (`:108`), and a callee with no `Return` anywhere (`:117`).

## `inlinable`: read as a specification

Eight guards naming ten conditions, in the order the code asks them:

```ts
function inlinable(
  site: CallSite,
  call: CFGInstruction,
  caller: CFGFunction,
  body: CalleeBody,
): boolean {
  const callee = site.callee;
  if (call.props[NAMED_ARGUMENTS_PROP] !== undefined) return false;
  if (callee === caller) return false;
  if (callee.isAsync || callee.isGenerator || callee.recoversThrows) return false;
  if (callee.resumable) return false;
  if (callee.gatheredArguments !== null) return false;
  if (callee.declaredSignature?.returns === STRING_TYPE) return false;
  if ((callee.declaredSignature?.params ?? []).some((param) => declaredAcceptsNull(param)))
    return false;
  if (callee.parameters.length !== site.args.length) return false;
  if (call.uses.length === 0) return true;
  if (body.returns.some((returned) => returned.inputs[0] === undefined)) return false;
  return body.returns.length === 1 || mergesANumber(callee);
}
```
— `src/optimizing/passes/inlining.ts:157-176`

Named arguments, because the binding is done centrally at the call and splicing skips it.
Self-recursion, because the *other* pass in this chapter handles that case. Async, generator,
throw-recovery and resumable, because all four give the callee a frame with a lifetime of its
own. `gatheredArguments`, an `arguments`-style capture, because the captured array is the
callee's. A declared `string` return, because a returned string's buffer is the callee's
([Ch 59 § string-buffer-lifetimes] again — the same reason `LoadText` is opaque, stated at
the signature rather than at the node). Any parameter whose declared type accepts null.
Arity mismatch.

Then the return-shape rule, which is the interesting one. If the call's value is unused
(`call.uses.length === 0`), anything goes — there is nothing to merge. Otherwise every return
must return a value, and there must be **exactly one** return, **or** the callee's declared
return must be a numeric AOT scalar:

```ts
function mergesANumber(callee: CFGFunction): boolean {
  const scalar = declaredAotScalar(callee.declaredSignature?.returns, callee.classes);
  return scalar !== null && isNumericScalar(scalar);
}
```
— `src/optimizing/passes/inlining.ts:178-181`

That clause exists because `spliceRegion` is about to build a phi to merge the callee's
several answers, and a phi has to have **one** representation
([Ch 48 § the-return-join](48-types-and-representations-in-the-middle-end.md)). A numeric
scalar is the case where it demonstrably does. The pass declines the general case rather than
producing a merge it cannot represent.

Five of the refusals are pinned directly:
`[t: tests/optimizing/passes/inlining.test.ts > "leaves a call that passes the wrong number of arguments alone"]`,
`[t: … > "leaves a call whose arguments are named alone"]`,
`[t: … > "leaves a callee that answers a string alone"]`,
`[t: … > "leaves a callee that calls itself alone"]`,
`[t: … > "refuses a callee whose entry a back edge re-enters"]`.

## Splice one: a single-block callee

When the callee is one block, no control flow is created and no phi is needed:

```ts
  substituteParameters(block.nodes, copy.graph.parameters, site.args);
  const spliced = block.nodes.filter((node) => node !== terminator);
  for (const node of spliced) {
    stamp(node);
    adoptFrameState(node, call);
    editor.insertBefore(call, node);
  }
  const answered = terminator.inputs[0] ?? null;
  if (answered !== null) {
    editor.replaceAllUses(call, wraps ? wrapInInt32(answered, call, editor, stamp) : answered);
  }
  editor.remove(call);
  return true;
```
— `src/optimizing/passes/inlining.ts:249-261`

`cloneGraph(site.callee, `${caller.name}$inline`)` (`:244`) makes a private copy first, so the
callee's own graph — which is still going to be compiled and emitted as a standalone function —
is never mutated. `substituteParameters` (`:214-230`) builds a map from the clone's
`Parameter` nodes to the call's argument nodes and applies it with `replaceInput` on every
input of every spliced node; `replaceInput` is the operation that maintains both sides of the
def-use relation, and using it rather than assigning `inputs[i]` is what keeps `uses` correct
([Ch 38 § the-def-use-multiset]). `stamp` is `nodeIdStamper(graph)` over the **caller's** id space
([Ch 39 § one-counter-over-one-id-space]). Everything except the terminator moves; the
terminator's operand becomes the call's answer.

Pinned by
`[t: tests/optimizing/passes/inlining.test.ts > "splices a straight-line callee into its caller"]`
and
`[t: … > "keeps the caller answering the value the callee returned"]`.

## Splice two: a callee with control flow, and the SSA repair

A callee with several blocks needs the caller's block cut in half, because the code after the
call has to end up after the callee's blocks rather than in the middle of them.

`spliceRegion` (`:264-303`) does five things in order. `splitBlockBefore(caller, entered,
call)` cuts the caller's block at the call and produces a `continuation` holding everything
after it. `cloneBlocks` copies every callee block into the caller, stamping as it goes.
`substituteParameters` runs across all the copies at once. The block that held the call gets
a `Jump` into the clone of the callee's entry, and the edge is `link`ed. And then each cloned
`Return` is rewritten in place:

```ts
  const answers: CFGInstruction[] = [];
  for (const returned of body.returns) {
    const copy = clone.blockOf.get(returned.block!)!;
    const terminator = copy.getTerminator()!;
    const answered = terminator.inputs[0];
    detachInputs(terminator);
    terminator.type = IR_JUMP;
    terminator.props = { targetBlock: continuation.id };
    link(copy, continuation);
    if (answered !== undefined) answers.push(answered);
  }
```
— `src/optimizing/passes/inlining.ts:284-294`

The node object survives; its `type` and `props` are overwritten and its inputs detached. A
`Return` becomes a `Jump` to the continuation, and the value it was returning is collected.

Then the merge:

```ts
    const merged =
      answers.length === 1 ? answers[0]! : stamp(addPhi(continuation, answers));
```
— `src/optimizing/passes/inlining.ts:297-298`

One answer means use it directly. Several mean a phi at the continuation — which is exactly
the SSA merge rule of [Ch 38 § canonical-phi-ssa], applied to a merge point that exists only because of
this pass. The source had a function call; the graph now has a join.

Pinned by
`[t: tests/optimizing/passes/inlining.test.ts > "splices a callee that branches, and merges its answers into one phi"]`,
`[t: … > "leaves the caller reading the phi wherever it read the call"]`,
`[t: … > "keeps the code that followed the call after the spliced body"]`.

## `adoptFrameState`, and the one-line version of a hard problem

Every spliced node that can bail out has to name a frame. The callee's frame is gone. Here is
the entire answer:

```ts
function adoptFrameState(node: CFGInstruction, call: CFGInstruction): void {
  node.frameState = irRequiresFrameState(node) ? call.frameState : null;
}
```
— `src/optimizing/passes/inlining.ts:232-234`

A node that requires a frame state gets the **caller's**, taken from the call site. A node
that does not requires none and gets `null`.

This is legitimate for AOT and only for AOT. `staticCompilerOptions` sets
`deoptimizes: false` (`src/optimizing/optimizer.ts:36-40`), the native road never emits a
bailout, and `frame-state-elision` strips every frame state later in the legalization
pipeline anyway. The graft only has to keep the graph well-formed until then — well-formed
enough that the dominance validator of [Ch 40 § what-checks-this-and-what-does-not] does not
find a frame-state value with no definition, which the caller's own frame state satisfies by
construction because it dominates the call.

> **Unenforced.** Nothing in `inlining.ts` asserts that, checks `options.deoptimizes`, or is
> named for it. If this pass were run in a pipeline that deoptimizes, a bailout inside a
> spliced body would resume the interpreter **at the caller's bytecode offset with the
> callee's values** — a frame with the right shape and the wrong contents, which is the
> hardest possible failure to attribute, and there is no verifier that would catch it. The
> option is one field away (`inlineKnownCalls` already takes `options`). Cost of closing it:
> one early return and one test.

## A nested frame state

The JIT does not get to make that simplification, because the JIT *can* bail out.

> **New idea. A nested frame state.** When the JIT inlines a callee, a deoptimization inside
> the inlined body must reconstruct **two** interpreter frames, not one — the callee's, and
> the caller's underneath it — because the interpreter has no idea the inlining happened and
> expects a real call stack with a real return address. A frame state therefore has to be
> able to name another frame state. N levels of inlining means a chain of N frames rebuilt
> at the bailout ([Ch 54 § rebuilding-a-frame]).

The mechanism is one parameter and one line. `captureFrameState` is a wrapper that passes
`null` for it (`src/optimizing/builder/frame-state.ts:7-22`);
`captureFrameStateWithCaller` (`:24-57`) is the real function, and the only difference
between them is:

```ts
  if (callerFrameState) {
    fs.setCallerFrame(callerFrameState);
  }
```
— `src/optimizing/builder/frame-state.ts:48-50`

`src/optimizing/builder/inline.ts` calls it at four sites — `:350`, `:363`, `:841`, `:918` —
and every visitor in `src/optimizing/ir/frame-state-values.ts` walks `callerFrameState` as a
chain ([Ch 40 § caller-chains]).

The contrast in one sentence: **the JIT builds a chain; the AOT pass overwrites with the
caller's link and lets a later pass delete the whole thing.** Same idea, opposite direction,
and the difference is entirely whether a bailout is possible.

## `needsDeclaredIntWrap`: the callee's promise becomes the caller's problem

A function declared `-> int` truncates its answer to 32 bits, and the truncation belongs to
the **callee**, applied at one boundary per tier
([Ch 48 § declared-int-wraps-everywhere](48-types-and-representations-in-the-middle-end.md)).
Splice the body into the caller and that boundary is gone: there is no return left to wrap
at.

The pass first asks whether the wrap would have been the identity anyway:

```ts
function answersInt32(callee: CFGFunction, value: CFGInstruction | undefined): boolean {
  if (value === undefined) return false;
  if (resultClassOf(value.type) === RESULT_INT32) return true;
  if (value.type === IR_PARAMETER) {
    return callee.declaredSignature?.params[Number(value.props.index)] === DECLARED_INT;
  }
  if (value.type !== IR_CONSTANT) return false;
  const constant = value.props.value;
  return (
    typeof constant === "number" && Number.isInteger(constant) && withinInt32(constant, constant)
  );
}
```
— `src/optimizing/passes/inlining.ts:183-194`

Three ways a return operand is already an int32: its result class says so, it is a parameter
the callee itself declared `int`, or it is an integral constant inside the int32 range.
`needsDeclaredIntWrap` (`:196-199`) requires **every** return to pass; one that does not
means the wrap has to be reinstated.

The repair inserts it at the call site instead:

```ts
  const zero = stamp(irConstant(0));
  const wrapped = stamp(irInt32Or(answered, zero));
```
— `src/optimizing/passes/inlining.ts:207-208`

`Int32Or(answered, 0)` is the compiler's spelling of `x | 0`, the standard ToInt32 idiom, and
both splice functions take a `wraps` boolean that routes the answer through it before
`replaceAllUses` (`:258`, `:299`).

Three tests separate the cases:
`[t: tests/optimizing/passes/inlining.test.ts > "wraps an inlined callee whose declared int return is not proven int32"]`,
`[t: … > "leaves an inlined callee alone when every return already answers int32"]`,
`[t: … > "leaves an inlined callee alone when it does not declare an int return"]`.

The JIT solves the same problem a different way, and the difference is instructive.
`canInlineTarget` refuses to inline a `-> int` callee unless the call site's feedback slot
reports `hasOnlySmiReturns()`:

```ts
  if (declaredInt32Return(target) && !slot.hasOnlySmiReturns()) return false;
```
— `src/optimizing/builder/inline.ts:200`

If every answer seen so far was a Smi, the wrap is the identity, and `inlineCallee` guards
each spliced return with a `CheckSmi` plus a frame state so anything else deoptimizes and the
interpreter applies the real wrap. One compiler proves the wrap unnecessary and inserts it
where it is; the other speculates that it is unnecessary and keeps a way out. That is the
whole book in one field.

## Module level: bottom-up, and the pipeline that runs twice

The AOT inliner is not a pass. It is called directly by the module driver, over a call order
computed by a depth-first postorder walk:

```ts
  const visit = (graph: CFGFunction): void => {
    if (state.has(graph)) return;
    state.set(graph, "visiting");
    for (const callee of edges.get(graph) ?? []) {
      if (state.get(callee) === "visiting") continue;
      visit(callee);
    }
    state.set(graph, "placed");
    ordered.push(graph);
  };
```
— `src/optimizing/metadata/call-graph.ts:102-111`

Callees before callers. Note how recursion is handled: a callee currently marked `"visiting"`
is **skipped** rather than detected as a cycle and reported. The walk tolerates recursion by
ignoring one back edge, which is enough to produce a valid order and does not require a
strongly-connected-component analysis.

Bottom-up matters because a callee that has already been optimized is smaller. Fewer nodes
means a lower `size`, which means it fits a budget that the unoptimized version would have
blown, and a lower `cost`, which means it clears a threshold the unoptimized version would
have missed. Optimizing the leaves first is what makes the cost model see the code that will
actually be emitted.

And then the consequence that makes `--print-after-all` confusing:

```ts
  for (const graph of bottomUpCallOrder(graphs)) {
    const rewrote = inlineKnownCalls(graph, functions, options) + rewriteSelfTailCalls(graph, functions);
    if (rewrote === 0) continue;
    functions.unitOf(graph)?.analyses?.invalidateAll();
    runMiddleEnd(graph, staticCompilerOptions(options));
  }
```
— `src/optimizing/drivers/aot.ts:653-658`

**Pass ordinals are per-`runMiddleEnd`, not per-compile.** A function that was inlined into
has two ordinal-8s, two ordinal-19s and two `#-1 ir-builder` records
([Ch 41 § ordinals]). The three-function program in "Verify it yourself" makes it visible:

```
$ node dist/cli.js compile /tmp/inl.tera --emit source --target c --print-after-all -o /tmp/inl \
    | grep -A1 '^\*\*\* IR after #-1 ir-builder' | grep '^fn ' | sort | uniq -c
      1 fn scale params=2 {
      2 fn tera_program params=0 {
      2 fn total params=1 {
```

Two records for `total`, two for `tera_program`, one for `scale`. The emitted C confirms the
splice: `double total(unsigned char *p0)` contains `const double v26 = (double)v25 *
(double)v3;` inline and no call, while `double scale(double p0, double p1)` is still emitted
beside it, because a module's exported functions are compiled whether or not anything still
calls them.

The cost arithmetic that produced that decision — the `remarks.applied` line naming the
callee, its node count, its score and the budget left, and its five sibling refusal messages —
**cannot be seen from the CLI at all**.

> **Never runs.** The inliner writes seven carefully-worded explanations through
> `remarks.applied` / `remarks.missed` / `remarks.analysis`
> (`inlining.ts:311, 329, 336, 343, 351, 363, 366`), including the cost arithmetic
> (`` `${site.callee.name} scores ${cost} against a threshold of ${options.inlineThreshold}: the body is not worth the code it would add here` ``).
> None of them is reachable from the CLI. `RemarkRecorder.record`
> (`src/optimizing/infra/pass-remarks.ts:63-75`) begins `const scope = this.scope; if (scope
> === null) return;`, and a scope is opened in exactly three places:
> `PassManager.run` when tracing is on (`infra/pass-manager.ts:94`), the text driver
> (`drivers/text-driver.ts:69`), and the AOT driver's `stage` helper — which opens one **only
> when `opts.moduleTracer !== null`** (`drivers/aot.ts:676-679`). `moduleTracer` is assigned
> in exactly one place in the repository: `tools/visualizer/src/workers/compiler-worker.ts:741`.
> So the inliner's explanations exist for the compiler visualizer
> ([Ch 76 § the-recording-gate]) and nothing else. Verified: `node dist/cli.js compile
> docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c | grep -ic inlin`
> prints `0`. Cost of fixing: a `--print-remarks` flag that installs a `moduleTracer`, or
> moving `inlineKnownCalls` into the pass manager, which would also give it an ordinal.

> **Never runs.** `inlineLoweredCalls` (`drivers/aot.ts:627-642`) is the *second* place
> `inlineKnownCalls` is called, at `:823` — **outside** any `stage(...)`, so its remarks are
> discarded even in the visualizer. It is also the one of the two that does **not** re-run the
> middle end: it calls `analyses.invalidateAll()` and stops (`:638-641`), so a graph inlined
> at this late point is never re-optimized and the spliced body never sees SCCP, GVN or the
> narrowing that the splice made possible.

> **Unfinished.** `drivers/aot.ts:639-640` calls `analyses.invalidateAll();` twice in a row
> on the same object. The second call cannot do anything the first did not. Cost of removing:
> one line.

## Two inliners, one book chapter

There are two inliners in the tree and they share nothing but a name.

`src/optimizing/builder/inline.ts` inlines **bytecode at IR-build time**, driven by feedback.
`selectInlineTarget` (`:211-255`) reads an `InlineCallHint` carrying a `frequency`, either a
monomorphic `targetRef` or a polymorphic `targets` list; `buildPolymorphicDispatch` (`:90-…`)
builds a guarded multi-way dispatch when the site saw more than one callee. Its limits live
on the graph — `graph.inlining` with `maxDepth`, `maxCalleeSize`, `minCallFrequency`, plus
`graph.inlineBudgetRemaining` — and `tryInline` (`:266-276`) increments and decrements
`graph.inlineDepth` in a `finally`.

`src/optimizing/passes/inlining.ts` inlines **graph into graph** after the fact, driven by a
static cost model with no feedback at all.

Neither could be used where the other is. The JIT cannot use the module inliner because by
the time a `CFGFunction` exists the feedback has already been consumed into guard nodes, and
because the JIT compiles **one function** — there is no module and no call graph to walk
bottom-up. The AOT compiler cannot use the builder inliner because there is no feedback
vector: `canInlineTarget` returns false at `if (!target.feedbackVector) return false;`
(`builder/inline.ts:199`), and `inlineCallee` returns `null` immediately for the same reason
(`:293`).

That is the part opener's split made concrete. One middle end, two inliners, and the thing
that separates them is whether a recording of what actually happened at run time exists.

## Tail position, and a call that is a loop

> **New idea. Tail position.** A call is in *tail position* when its result is the calling
> function's result and nothing happens afterwards — `return f(x)` and nothing else. That
> matters because the caller's frame is dead the moment the call is made: nothing in it will
> be read again. A compiler that notices this can reuse the frame instead of pushing a new
> one, which turns unbounded recursion into a loop with constant stack. When the callee is
> the caller itself, the transformation is especially simple: the call becomes a back edge,
> and the parameters become loop-carried values.

`tailSiteOf` asks six questions:

```ts
  const returned = block.getTerminator();
  if (returned === null || returned.type !== IR_RETURN) return null;
  const call = block.nodes[block.nodes.indexOf(returned) - 1];
  if (call === undefined || call.props[NAMED_ARGUMENTS_PROP] !== undefined) return null;
  const site = callSiteOf(call, functions);
  if (site === null || site.callee !== graph) return null;
  if (site.args.length !== graph.parameters.length) return null;
  const answered = returned.inputs[0];
  if (answered !== undefined && answered !== call) return null;
  if (call.uses.some((use) => use !== returned)) return null;
```
— `src/optimizing/passes/tail-calls.ts:27-36`

The terminator is a `Return`; the node immediately before it is a call with no named
arguments; `callSiteOf` resolves that call to **this same graph**; the arity matches; the
returned value is either nothing or the call itself; and the call has **no other use**. That
last one is what
`[t: tests/optimizing/passes/tail-calls.test.ts > "leaves a call whose result the caller still works on alone"]`
pins: `return f(x) + 1` is not a tail call, because the frame is still needed for the add.

Note line 13 of the file: `import { callSiteOf } from "./inlining.js";`. "Is this a call to a
known function" has exactly one definition in the tree, shared by both passes.

`rewritable` (`:40-46`) refuses four whole-function properties — async, generator,
`gatheredArguments`, `recoversThrows` — plus an entry block with predecessors or phis, which
is the same structural refusal `calleeBody` makes.

The transform is shorter than the analysis. Add a `preamble` block and make it the new entry;
give the old entry one phi per parameter, seeded with that parameter; mark the old entry
`isLoopHeader`; jump from the preamble into it; and rewrite each tail site:

```ts
  for (const site of sites) {
    editor.remove(site.returned);
    editor.remove(site.call);
    connect(
      site.block,
      entry,
      site.args.map((argument) => carriedBy.get(argument) ?? argument),
    );
    site.block.addNode(stamp(irJump(entry)));
  }
```
— `src/optimizing/passes/tail-calls.ts:74-83`

`carriedBy.get(argument) ?? argument` is the subtlety the tests isolate. An argument that is
*itself a parameter* must be passed as **the loop's phi**, not as the original `Parameter`
node — because the `Parameter` still holds the value the function was originally called with,
and the second iteration would read the first iteration's input rather than the updated one.
`editor.replaceAllUses(parameter, carried)` (`:67`) redirects every existing reader to the
phi, and then `carried.addInput(parameter)` (`:68`) makes the original parameter the phi's
entry-edge input, in that order so the phi does not end up as an input to itself.

Pinned by
`[t: tests/optimizing/passes/tail-calls.test.ts > "turns a self call in tail position into a back edge"]`,
`[t: … > "carries each argument into the parameter it replaces"]`,
`[t: … > "carries an argument that is itself a parameter as the loop's own value"]`,
`[t: … > "reads every parameter through the phi that the loop updates"]`,
`[t: … > "leaves the entry as the only block without a predecessor"]`.

The whole-function refusals have their own titles:
`[t: … > "leaves a coroutine alone"]`,
`[t: … > "leaves a function that recovers throws alone"]`,
`[t: … > "leaves a call whose arguments are named alone"]`.

## What is not here: a machine tail call

No backend emits one.

`rewriteSelfTailCalls` covers the self-recursive case by turning it into a loop, and that is
all. A *mutual* tail call — `f` returning `g(x)` and `g` returning `f(y)` — or a tail call to
any function other than the caller is compiled as an ordinary call and grows the stack on
every iteration, on every target.
`[t: tests/optimizing/passes/tail-calls.test.ts > "leaves a tail call to a different function alone"]`
is the pin, and it is a pin on the *absence*: the pass leaves it alone by design, not by
oversight.

Grep the tree for a tail-call opcode and the only hit is in the **baseline** compiler:

```
$ grep -rn "TailCall\|tailCall" src/ --include=*.ts
src/optimizing/baseline/compiler.ts:282:        const isTailCall =
src/optimizing/baseline/compiler.ts:285:          isTailCall ? returnExpression(compiledFn, call) : `acc=${call};`;
src/optimizing/drivers/aot.ts:66:import { rewriteSelfTailCalls } from "../passes/tail-calls.js";
src/optimizing/drivers/aot.ts:654:    const rewrote = inlineKnownCalls(graph, functions, options) + rewriteSelfTailCalls(graph, functions);
src/optimizing/passes/tail-calls.ts:48:export function rewriteSelfTailCalls(
```

`isTailCall` at `compiler.ts:282-283` notices that the next bytecode instruction is
`ROP_RETURN` and emits `return f(...)` in the JavaScript it generates instead of
`acc = f(...)` ([Ch 36 § the-fast-call-path-is-also-a-tier-up-site]). That is a tail call in
the source language
of the baseline tier, handed to a JavaScript engine that is not obliged to eliminate it
either.

> **Unfinished.** No backend emits a machine tail call. Cost of finishing: a `TailCall`
> opcode in the operation table, a capability on `TargetModel` so a backend that cannot do it
> declines rather than miscompiles, and — for x64 and riscv64 — an epilogue that restores the
> frame *before* the jump, which interacts with the unwind tables of
> [Ch 71 § what-unwinding-is-for] because
> the frame being unwound at the destination is not the frame that was entered.

## What leaves

One optimized `CFGFunction` in canonical-phi SSA, and the end of Part VII.

It is typed by the analysis cached under `typeInferenceAnalysisId`; its generic arithmetic is
specialized where a proof allowed it; its redundant loads and stores are gone; its guards have
been hoisted out of loops where they could be proved once; its constants are folded and its
unreachable blocks removed; and — on the wasm road only — every surviving node carries a
representation and every return agrees on one ABI answer. On the AOT road it may also contain
whole callee bodies spliced in, with the caller's frame state grafted onto anything that
could bail out and the callee's `-> int` promise reinstated as an explicit `Int32Or(x, 0)`
where it was needed.

It has **no idea which of four code generators is about to read it**, and that is the point
of the part. [Ch 51 § the-second-pipeline] runs a second, target-specific pipeline over it and
then hands it either to the WebAssembly emitter of Part VIII or to the MachineIR of Part IX.
The one thing that decides which is `CompilerOptions.deoptimizes`, and everything it implies:
whether a guard is a bailout point or an assertion to be discharged
([Ch 49 § this-is-the-hinge-in-miniature](49-speculative-types-are-not-facts.md)).

## Verify it yourself

```bash
# a three-function program that does reach the inliner
printf 'fn scale(x: float, k: float) -> float:\n  return x * k\n\nfn total(values: float[]) -> float:\n  t = 0.0\n  i = 0\n  while i < values.length:\n    t += scale(values[i], 2.0)\n    i += 1\n  return t\n\nprint(total([12.5, 9.0, 31.25]))\n' > /tmp/inl.tera
node dist/cli.js /tmp/inl.tera

# two ir-builder records for the caller: the middle end ran twice on it
node dist/cli.js compile /tmp/inl.tera --emit source --target c --print-after-all -o /tmp/inl 2>&1 \
  | grep -A1 '^\*\*\* IR after #-1 ir-builder' | grep '^fn ' | sort | uniq -c

# the splice, in the emitted C: total has the multiply and no call; scale is still emitted
sed -n '/^double scale/,/^}/p;/const double v26/p' /tmp/inl/inl.c

# stats.tera reaches none of this: 21 functions, 21 ir-builder records, zero inlining lines
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep -c '^\*\*\* IR after #-1 ir-builder'
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep -ic inlin

# the remarks have exactly one consumer in the repository
grep -rn "moduleTracer" src/ tools/ --include=*.ts

# the only tail call in the tree is the baseline compiler's generated JavaScript
grep -rn "TailCall\|tailCall" src/ --include=*.ts

npx vitest run --project unit tests/optimizing/passes/inlining.test.ts tests/optimizing/passes/tail-calls.test.ts
```

The `sed` command prints the two functions side by side. `scale` survives as an ordinary
function —

```c
double scale(double p0, double p1) {
  const double v0 = (double)p0 * (double)p1;
  return (double)v0;
}
```

— and the multiply also appears inside `total`'s loop body as
`const double v26 = (double)v25 * (double)v3;`, with no call anywhere in `total`. The
`uniq -c` command prints `1 fn scale`, `2 fn tera_program`, `2 fn total`.

## Tests that pin this

- `tests/optimizing/passes/inlining.test.ts` > `"splices a straight-line callee into its caller"` — the single-block splice.
- `tests/optimizing/passes/inlining.test.ts` > `"keeps the caller answering the value the callee returned"` — `replaceAllUses` on the call.
- `tests/optimizing/passes/inlining.test.ts` > `"splices a callee that branches, and merges its answers into one phi"` — the SSA repair.
- `tests/optimizing/passes/inlining.test.ts` > `"leaves the caller reading the phi wherever it read the call"` — the merge is what the call's users see.
- `tests/optimizing/passes/inlining.test.ts` > `"keeps the code that followed the call after the spliced body"` — `splitBlockBefore` and the continuation.
- `tests/optimizing/passes/inlining.test.ts` > `"refuses a callee whose entry a back edge re-enters"` — `calleeBody`'s structural refusal.
- `tests/optimizing/passes/inlining.test.ts` > `"leaves a call that passes the wrong number of arguments alone"` — the arity refusal.
- `tests/optimizing/passes/inlining.test.ts` > `"leaves a call whose arguments are named alone"` — named binding happens at the call, not in the body.
- `tests/optimizing/passes/inlining.test.ts` > `"leaves a callee that answers a string alone"` — a returned string's buffer belongs to the callee's frame.
- `tests/optimizing/passes/inlining.test.ts` > `"leaves a callee that calls itself alone"` — self-recursion is the other pass's job.
- `tests/optimizing/passes/inlining.test.ts` > `"wraps an inlined callee whose declared int return is not proven int32"` — the `Int32Or(x, 0)` repair.
- `tests/optimizing/passes/inlining.test.ts` > `"leaves an inlined callee alone when every return already answers int32"` — `answersInt32` proving the wrap is the identity.
- `tests/optimizing/passes/inlining.test.ts` > `"leaves an inlined callee alone when it does not declare an int return"` — no promise, no repair.
- `tests/optimizing/passes/tail-calls.test.ts` > `"turns a self call in tail position into a back edge"` — the transform.
- `tests/optimizing/passes/tail-calls.test.ts` > `"carries each argument into the parameter it replaces"` — the phi seeding.
- `tests/optimizing/passes/tail-calls.test.ts` > `"carries an argument that is itself a parameter as the loop's own value"` — `carriedBy.get(argument) ?? argument`, the case that breaks a naive rewrite.
- `tests/optimizing/passes/tail-calls.test.ts` > `"reads every parameter through the phi that the loop updates"` — `replaceAllUses` before `addInput`.
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves the entry as the only block without a predecessor"` — the preamble keeps the graph well-formed.
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a call whose result the caller still works on alone"` — not tail position.
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a call whose arguments are named alone"` — same refusal as the inliner, same reason.
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a coroutine alone"` — `rewritable`'s async/generator refusal.
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a function that recovers throws alone"` — `rewritable`'s throw-recovery refusal.
- `tests/optimizing/passes/tail-calls.test.ts` > `"leaves a tail call to a different function alone"` — the pin on the absence: no machine tail call exists.
- `tests/optimizing/infra/pass-manager.test.ts` > `"puts each pass's remarks on that pass's own trace record"` — the remark scope, in the one place it is opened by default.
- `tests/optimizing/infra/pass-manager.test.ts` > `"does not leak a throwing pass's remarks into the next run"` — the scope is closed on the exception path.
- **No test pins the cost model's arithmetic, the budget, or either bonus.** `[unpinned]` —
  `inlineCostOf` and `foldingBonus` are exported and never imported by a test; every inlining
  test runs with a budget and threshold large enough that the decision is never close.
