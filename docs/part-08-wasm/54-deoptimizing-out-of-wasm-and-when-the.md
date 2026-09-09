# 54. Deoptimizing out of wasm, and when the JIT says no   ⟨ I · J ⟩

Every fast path in the optimizing tier is a bet. `total_of` is compiled on the evidence that
its argument has been a `PACKED_DOUBLE` array two hundred times running, and the compiled
code has no branch for anything else — no string case, no boxing, no `toPrimitive`, just
`f64.load` and `f64.add` in a loop. The bet is not hedged. It is *guarded*: a check in front
of the fast path, and behind the check, a way out.

This chapter is the way out, and it is the reason the bet is allowed at all. Chapter 49
established that a speculative type is not a fact — it is a **licence**, held on the strength
of a guard that is still executing. What buys that licence is deoptimization: the ability to
stop mid-execution, reconstruct the interpreter frame the optimizer deleted, and resume the
same activation at the same bytecode offset with the same values. A compiler that can do that
may guess. A compiler that cannot must prove or refuse, which is the whole subject of Part
IX. So the machinery here is not a recovery path bolted onto a fast one. It is the thing the
fast one is made of.

The difficulty is specific to this backend. When baseline code gives up, the values it needs
to hand back are JavaScript variables, and the host can just read them. When *wasm* gives up,
the values are in wasm locals, and a JavaScript host has no API to read a wasm local — not
from an import, not from a trap handler, not at all. So everything the bailout will need has
to be pushed into linear memory by the wasm code itself, before it calls out. That constraint
produces the snapshot format, the slot discipline, and the one refusal this chapter turns on:
a value the reader cannot resolve is recorded as *nothing*, because a deopt that invents a
value is worse than one that gives up.

**What arrived.** From [Ch 53 § what-leaves](53-the-boundary-is-the-wall.md): a live
`OptimizedCode` closure, mid-call. Its arguments have been marshalled into linear memory,
`threadLocal.currentObjPtrs` points at this activation's pointer map, the mirrored global
cells have been filled, and the wasm export `opt` is executing with the program's values in
wasm locals the host cannot see. Alongside it, from
[Ch 40 § what-leaves](../part-06-ssa/40-frame-states-describing-a-frame-you-no.md), the
`frameStates` array: for each guard in the graph, a description of the interpreter frame that
*would* exist at that point — which locals hold which SSA values, what is on the stack, what
`this` was, and which bytecode offset it all corresponds to.

## The problem

A frame state names SSA values. At run time those values live in wasm locals, which are the
private property of the wasm instance. `WebAssembly.Instance` exposes exports; it does not
expose locals. `WebAssembly.Memory` is the *only* channel through which a running wasm
function can hand a JavaScript host something the host did not already have.

So the bailout has to be planned at compile time. Before any instruction that can fail, the
emitter writes the whole frame state into a fixed region of linear memory. If the guard
passes, those stores are wasted work and nothing reads them. If it fails, the region is the
only surviving description of a frame that is about to cease to exist.

> **New idea. Deoptimization.** Abandoning optimized code in the middle of an execution and
> continuing the *same* activation in a slower tier, at the same program point, with the same
> values. It is not "call the interpreter version instead" — that would re-run the work
> already done and re-run any side effects with it. It is: rebuild the interpreter's frame as
> it would have been, set its program counter to the offset the guard corresponds to, and let
> the interpreter carry on from there. Done correctly, a program cannot tell it happened. The
> loop in `total_of` that has already added three elements resumes having added three
> elements.

## Three ways to stop

Optimized code stops being valid in three different ways, at three different times, and the
mechanisms have almost nothing in common.

| | when it fires | what reads the frame state | what it costs |
| --- | --- | --- | --- |
| **Entry guard** | in JavaScript, before one byte is marshalled | nothing, if the guard's frame state is at offset 0 | one loop over `entryGuards`, then a fresh `RegisterFrame` |
| **In-wasm deopt** | mid-execution, from inside the compiled loop | `readDeoptSnapshot`, over the snapshot region | the snapshot stores already emitted, plus a `throw` through the wasm frames |
| **Lazy deopt** | while the function is *not* running | nothing — no frame exists | `optimizedCode = null` and a recompile later |

The first is `failingEntryGuard`. The second is the `env.deopt` import and `DeoptSignal`. The
third is `LazyDeoptMarker` driven by `dependencyRegistry.invalidate`. Only the middle one
needs any of the snapshot machinery, and it is the only one where the program is in the
middle of something when the news arrives.

## Entry guards

The cheapest bailout is the one that happens before anything has been done. `analyzeGraph`
collects every `IR_CHECK_SMI` and `IR_CHECK_NUMBER` node in the graph into `entryGuards`
(`codegen.ts:1109-1115`), plus the map checks on parameters it decided to pass in place. The
wrapper then re-checks the subset of those whose input is a parameter, in plain JavaScript,
against the actual arguments:

```ts
    const failingEntryGuard = (args: TaggedValue[]): AnyNode | null => {
      for (const guard of entryGuards) {
        const input = guard.inputs[0];
        if (!input || input.type !== ir.IR_PARAMETER) continue;
        const paramIdx = metadataNumber(input.props.index);
        if (paramIdx === null) continue;
        const arg = paramIdx < args.length ? args[paramIdx] : mkUndefined();
        if (guard.type === ir.IR_CHECK_SMI && !isSmi(arg)) return guard;
        if (guard.type === ir.IR_CHECK_NUMBER && !isNumber(arg)) return guard;
        if (guard.type === ir.IR_CHECK_MAP) {
          const expected = metadataNumber(guard.props.expectedMapId);
          const payload = isObject(arg) ? getPayload(arg) : null;
          const mapId =
            payload && payload.hiddenClass ? payload.hiddenClass.id : -1;
          if (expected !== null && mapId !== expected) return guard;
        }
      }
      return null;
    };
```
— `src/optimizing/backends/wasm/codegen.ts:4301-4319`

The same check exists twice on purpose. It is compiled into the wasm module — the guard node
emits a real instruction with a real deopt edge — *and* it is evaluated here in JavaScript
before the call. The duplication is not redundancy, it is placement. Failing before
`allocateTagged` runs costs a loop over three or four guards. Failing after it has recursively
copied an object graph into linear memory costs that entire graph walk, and then the walk
back, and then a bailout anyway. [Ch 53 § allocatetagged](53-the-boundary-is-the-wall.md) is
the bill this avoids.

Just above it sits a second pre-check of the same shape, for the mirrored global cells: if any
global the compiled code promoted to an f64 slot no longer holds a number, the wrapper records
a `number-check-failed` deopt at offset 0 and resumes in the interpreter without marshalling
anything (`codegen.ts:4363-4373`).

When an entry guard does fail, the resumption is deliberately simple. If the guard has no
frame state, or its frame state's `bytecodeOffset` is not 0, the wrapper builds a plain
`new RegisterFrame(compiledFn, args, thisValue, closureEnv)` and resumes at the top
(`codegen.ts:4380-4398`). Nothing has run, so nothing has to be reconstructed.

The same function is reused as `optimizedCode._declinesEntry`, but only when the graph was
compiled for on-stack replacement:

```ts
    if (analysis.isOsr) {
      optimizedCode._declinesEntry = (args: TaggedValue[]) =>
        failingEntryGuard(args) !== null;
    }
```
— `src/optimizing/backends/wasm/codegen.ts:4853-4856`

`src/runtime/tiering/osr.ts:59` reads it — `if (entry.code._declinesEntry?.(args)) return null;`
— so an OSR entry that would immediately bail is simply not taken.

> **Unfinished.** `_declinesEntry` is installed only under `analysis.isOsr`. A non-OSR
> optimized function has no way to say "do not enter me with these arguments" other than
> entering and bailing out. That is inexpensive — `failingEntryGuard` runs before marshalling
> — but it still calls `recordWasmDeopt`, which still increments `deoptCount`, which still
> walks the function toward `maxDeoptCount` and permanent `disableOptimization`. A caller that
> alternates between two argument shapes therefore burns its deopt budget on a condition that
> was detectable without executing anything. Cost to fix: install `_declinesEntry`
> unconditionally and consult it in the interpreter's entry path alongside the
> `optimizedCode` check, which is a handful of lines but changes the tiering accounting.
> **[unpinned]**

## The snapshot

The spill format is a run of `f64` slots at a fixed base. `DEOPT_SNAPSHOT_BASE` is 8 and
`DEOPT_SNAPSHOT_SLOT_BYTES` is 8 (`src/optimizing/backends/wasm/wasm-format.ts:307-308`), so
slot *n* lives at byte `8 + n * 8` — the very bottom of linear memory, below the global cells,
below the constant pointers, below the object arena
([Ch 53 § arena-and-capacity](53-the-boundary-is-the-wall.md)).

`emitDeoptSnapshot` writes it. It opens with `let slot = 0` and a `writeValue` callback whose
first line computes `const offset = DEOPT_SNAPSHOT_BASE + slot * DEOPT_SNAPSHOT_SLOT_BYTES`;
the rest is this:

```ts
      const node = frameNode(val);
      if (node) {
        const loc = resolveNodeLocal(node.id, analysis);
        if (loc !== undefined) {
          const type = analysis.nodeWasmType.get(node.id);
          bytes.push(wasmFormat.OP_I32_CONST, ...wasmFormat.encodeS32(offset));
          bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(loc));
          if (type === wasmFormat.TYPE_I32)
            bytes.push(wasmFormat.OP_F64_CONVERT_I32_S);
          bytes.push(
            wasmFormat.OP_F64_STORE,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(0),
          );
        }
      }
      slot++;
    };

    visitDeoptSnapshotValues(fs, writeValue);
```
— `src/optimizing/backends/wasm/codegen.ts:2157-2176`

Read the last line first. The emitter does not walk the frame state itself; it hands a
callback to `visitDeoptSnapshotValues` and counts. **The slot number is a running counter, not
a name.** Nothing in the eight bytes says which value they hold. The only thing that makes the
format decodable is that the writer and the reader walk the same sequence in the same order,
and the only thing that guarantees *that* is that both of them call one function:

```ts
function visitOneDeoptSnapshot(
  frameState: FrameState,
  visit: (value: FrameValue | null | undefined) => void,
): void {
  const maxSlot = Math.max(...frameState.localValues.keys(), -1);
  for (let slot = 0; slot <= maxSlot; slot++) {
    visit(frameState.localValues.get(slot));
  }

  for (const value of frameState.stackValues) visit(value);

  for (const allocation of frameState.sunkAllocations?.values() ?? []) {
    for (const value of allocation.props?.values() ?? []) visit(value);
    for (const value of allocation.fields?.values() ?? []) visit(value);
  }

  visit(frameState.thisValue);
}
```
— `src/optimizing/ir/frame-state-values.ts:37-54`

Locals `0` through the highest occupied index — including the gaps, which visit `undefined`
and therefore still consume a slot. Then the stack values, in order. Then, for each sunk
allocation, its props followed by its fields. Then `thisValue`. And `visitDeoptSnapshotValues`
(`:55-65`) wraps that in a walk up the `callerFrameState` chain, with a `seen` set, so an
inlined function's snapshot is its own frame followed by every caller's — one flat sequence
for the whole chain. Position matters and nothing else does.

`maxDeoptSnapshotSlots(graph)` (`:77-86`) then takes the maximum slot count over every frame
state in the function and sizes the region once (`codegen.ts:1497`), so every guard in the
function writes into the same bytes. Only one guard can be failing at a time, so the region is
reused rather than partitioned.

> **Unenforced.** The slot numbering is positional and shared by convention only.
> `emitDeoptSnapshot` (`codegen.ts:2151`) and `readDeoptSnapshot` (`codegen.ts:4101`) each
> declare their own `let slot = 0` and each call `visitDeoptSnapshotValues`. If a pass ever
> mutated a frame state between the two, or if one of them skipped a value the other counted,
> the reader would silently attribute one node's value to another node — a wrong answer with
> no diagnostic anywhere. Nothing asserts that the counts match; there is not even a slot-count
> word written into the region. Cost to fix: write `deoptSnapshotSlotCount(fs)` into a header
> slot and check it on read, about six lines plus one more slot of memory.

## Reading it back

`readDeoptSnapshot` is the mirror, over a `Float64Array` view of the same buffer, and its
per-value decision is the sharpest thing in this chapter:

```ts
            const rawF64 = buffer[offsetIndex];
            const rawInt = Math.trunc(rawF64);
            const objInfo =
              analysis.nodeValueRep.get(node.id) === REP_HANDLE &&
              threadLocal.currentObjPtrs
                ? threadLocal.currentObjPtrs.get(rawInt)
                : null;
            if (objInfo) {
              runtimeValues.set(node.id, objInfo.value);
              slot++;
              return;
            }
            if (analysis.nodeValueRep.get(node.id) === REP_HANDLE) {
              slot++;
              return;
            }
            if (type === wasmFormat.TYPE_I32) {
              runtimeValues.set(node.id, mkSmi(rawInt));
            } else if (type === wasmFormat.TYPE_F64) {
              runtimeValues.set(node.id, mkDouble(rawF64));
```
— `src/optimizing/backends/wasm/codegen.ts:4117-4136`

Four cases. If the value's representation is `REP_HANDLE` and the truncated integer is a
pointer this activation's `objPtrs` recognises, record the **real `TaggedValue`** it stands
for. If the representation is `REP_HANDLE` and the pointer is *not* recognised — record
nothing, and move to the next slot. If the wasm type is `i32`, record `mkSmi(rawInt)`. If it
is `f64`, record `mkDouble(rawF64)`.

The second case is four lines with no `set` call in them, and it is the chapter's thesis. The
slot holds a number that is, by the representation table, a pointer — and this activation
cannot say what it points at. The tempting move is to record `mkNumber(rawF64)` and let the
interpreter sort it out. That is a silent miscompile, and a cheap-looking one: arena addresses
are small integers — the first object in a function with no snapshot slots and no mirrored
globals lands at byte 8 ([Ch 53 § every-slot-is-an-f64](53-the-boundary-is-the-wall.md)) — so
the interpreter would resume holding the number eight where the program has an object, and the
wrong answer would surface somewhere else entirely, with no trace connecting it to a bailout.
**Recording nothing is a choice to fail loudly or not at all** — the value's absence from
`runtimeValues` means it will be re-derived from the graph by `materializeFrameValue`, and if
that cannot be done either, the resume throws with the node id in the message.

The pin is
[t: tests/e2e/optimizing/deopt.test.ts > "resumes a guarded method call without inventing a numeric callee"],
which is exactly the shape the case exists for: a callee whose value is a handle, on a path
that bails out.

The catch block that receives the throw is written as though there were a second chance at
this case; § catching-it, step 5 is why there is not.

## The signal

The in-wasm bailout is two integers and a `throw`.

```ts
      imports.env.deopt = (reasonId: number, frameStateId: number) => {
        const reason = deoptReasonFromId(reasonId);
        const fs = frameStates ? frameStates[frameStateId] : null;
        const bcOffset = fs ? fs.bytecodeOffset : 0;

        throw new DeoptSignal(
          reason,
          bcOffset,
          frameStateId,
          readDeoptSnapshot(fs),
        );
      };
```
— `src/optimizing/backends/wasm/codegen.ts:4148-4159`

The reason is an index, not a string, because wasm can push an `i32.const` and cannot push a
string. `DEOPT_REASON_LIST` in `src/optimizing/backends/wasm/deopt-reasons.ts:18-31` has twelve
entries in a fixed order — `guard-failure`, `smi-check-failed`, `number-check-failed`,
`map-check-failed`, `array-check-failed`, `elements-kind-check-failed`,
`bounds-check-failed`, `integer-overflow`, `division-by-zero`, `minus-zero`,
`wrong-call-target`, `runtime-stub-failure` — and `deoptReasonId` / `deoptReasonFromId` are the
two directions of that index. `deoptReasonForNode` maps each guard opcode to its reason, so
`IR_CHECK_ELEMENTS_KIND` produces `elements-kind-check-failed` and nothing else has to be
decided at run time.

A `throw` is the right mechanism for a reason that has nothing to do with error handling: it
unwinds the wasm frames for free. There is no way for JavaScript to pop a wasm activation
except by throwing through it, and the wasm frames hold nothing the bailout needs — everything
it needs is already in linear memory. The emitter makes that a promise to the validator:

```ts
    bytes.push(wasmFormat.OP_IF, wasmFormat.TYPE_VOID);
    this.emitDeoptSnapshot(node.frameState, analysis, bytes);
    bytes.push(
      wasmFormat.OP_I32_CONST,
      ...wasmFormat.encodeS32(deoptReasonId(reason)),
    );
    bytes.push(
      wasmFormat.OP_I32_CONST,
      ...wasmFormat.encodeS32(node.frameState?.id ?? 0),
    );
    bytes.push(wasmFormat.OP_CALL, ...wasmFormat.encodeU32(deoptImportIdx));
    bytes.push(wasmFormat.OP_UNREACHABLE);
    bytes.push(wasmFormat.OP_END);
```
— `src/optimizing/backends/wasm/codegen.ts:2186-2198`

Twelve lines, and that is the entire in-wasm bailout: open a void `if`, dump the snapshot,
push the two ids, call the import, then `unreachable`. The `unreachable` is what lets the
block typecheck — the validator has no idea the import always throws, so without it the arm
would have to produce whatever the surrounding block produces. The same shape appears inside
`emitCheckedInt64FromF64` (`codegen.ts:2579-2588`), which is how a double that will not fit in
an `i32` becomes an `integer-overflow` bailout rather than a wrapped value; the *other* choice
available at that point is [Ch 52 § tointeger](52-emitting-webassembly-by-hand.md)'s
saturating conversion, and which one the emitter picks depends on whether a deopt import
exists at all.

## Catching it

`runActivation` wraps the wasm call in a `try`, and the `catch` is an ordered list where the
order is the correctness argument.

1. **`wasmCallDepth--`, restore `threadLocal.currentObjPtrs` and `currentRuntime`.** First,
   before anything can re-enter. Everything after this line can call back into the
   interpreter, and the interpreter must not see this activation's pointer map.
2. **`commitTrackedObjects()`.** Copy every tracked object out of linear memory and back into
   its JavaScript slots. The partial execution's writes are real: the loop that bailed out on
   element four already stored elements zero through three.
3. **`storeGlobalCells()`.** The same for the mirrored numeric globals.
4. **`recordWasmDeopt(e.reason, e.bytecodeOffset, null, e.frameStateId)`.** Count it, set
   `lastDeoptReason`, unregister the function's dependencies, null `optimizedCode`, trace it,
   tell the tiering policy, and set `disableOptimization` once `deoptCount` reaches
   `maxDeoptCount` (`codegen.ts:4328-4361`).
5. **Patch `e.runtimeValues`.** For every entry whose node representation is `REP_HANDLE`,
   look the recorded value up in `objPtrs` as if it were a pointer and, on a hit, replace it
   with that entry's `TaggedValue` (`codegen.ts:4738-4750`). The intent is a second chance at
   the unresolvable-handle case of § reading-it-back: by the time the catch runs, objects
   created *during* the wasm execution are in the map, so a pointer that could not be resolved
   when the snapshot was read might be resolvable now.
6. **Resume.** If the frame state is an inlined frame, `resumeFrameStateChain` rebuilds and
   resumes each frame from the innermost outward, threading each answer into the next frame's
   accumulator (`src/deopt/frame-materializer.ts:444-480`). Otherwise
   `materializeFrameFromState` builds one `RegisterFrame` and `interpreter.resumeAt` runs it.

Step 2 before step 6 is not an optimization. **Committing before resuming is the correctness
condition**, because the interpreter is about to re-read exactly those objects, and if it read
them before the commit it would see the state from before the wasm call. The deopt path
commits unconditionally, unlike the normal return path, which skips the commit when
`mutatesHeapObjects` is false ([Ch 53 § staleheapaccess](53-the-boundary-is-the-wall.md)) — a
partially executed function has no guarantee about which of its writes went through stubs and
which went through memory.

Step 5 is the odd one out, because its precondition no longer exists.

> **Unfinished.** The `REP_HANDLE` patch loop (`codegen.ts:4738-4750`) is a second-chance pass
> over values that no longer need one. `readDeoptSnapshot` records, for a `REP_HANDLE` node,
> either the real `TaggedValue` or *nothing at all* (§ reading-it-back) — it never records a
> raw linear-memory pointer — and every other producer of a `DeoptSignal` in the tree passes
> either an empty `Map` or an already-resolved value
> (`src/optimizing/backends/wasm/runtime-support.ts:565`, `:655`, `:830`, `:857`, `:1051`).
> So the entries the loop visits are already correct, and `objPtrs.get(val)` is asking an
> address-keyed map about a tagged word. Cost to fix: either delete the loop, or give
> `readDeoptSnapshot` a side map of node id to unresolved pointer so that the pass has
> something to resolve — the second is the version that would make the comment the code
> does not have true. **[unpinned]**

## Materialization

`materializeFrameFromState` builds a `RegisterFrame`, fills `frame.locals[i]` from the frame
state's local *i*, sets `frame.acc` from the last stack value, sets `frame.thisValue`, and
sets `frame.pc = frameState.bytecodeOffset`
(`src/deopt/frame-materializer.ts:393-441`). Every one of those fills goes through
`materializeFrameValue`, which answers the question the snapshot could not: *what was this
value?*

Its first move is to check `runtimeValues` — if the snapshot recorded something for this node,
that is the answer. Everything after that is re-derivation from the graph.

> **New idea. Materialization.** The optimizer deletes values. A field load that was hoisted
> out of a loop, a constant that was folded, an addition whose only consumer was another
> addition — none of them exist as machine values any more. But SSA still records *how they
> were made*: the node is in the graph, with its opcode and its inputs. So a value that was
> never stored anywhere can be recomputed on demand by walking backwards through the graph and
> re-executing the operation on materialized inputs. Materialization is what makes it
> affordable for the optimizer to delete anything at all — without it, every value mentioned
> by a frame state would have to be kept alive in a register or a stack slot to the end of its
> frame state's reach.

The strategies, in the order the function tries them
(`src/deopt/frame-materializer.ts:92-380`):

- `IR_PARAMETER` indexes into `args`, which the wrapper still has.
- `IR_LOAD_FIELD` and `IR_POLYMORPHIC_LOAD` materialize the receiver and then **re-read the
  object** — `getPropertyByOffset` for the first, a map-index lookup then the offset for the
  second. This is why step 2 of § catching-it has to run first: the re-read must see the
  committed state.
- `IR_GENERIC_GET_PROP` materializes the receiver and calls `getRuntimeProperty`.
- The pass-through set — `IR_CHECK_SMI`, `IR_CHECK_NUMBER`, `IR_CHECK_MAP`, `IR_CHECK_ARRAY`,
  `IR_CHECK_ELEMENTS_KIND`, `IR_CHECK_BOUNDS`, `IR_CHECK_CALL_TARGET`, `IR_BOX`, `IR_UNBOX`,
  `IR_LOAD_LOCAL`, `IR_STORE_CONTEXT_SLOT` — recurses to input 0. A guard's answer is its
  argument.
- `IR_LOAD_GLOBAL` re-reads the global cell. `IR_CONSTANT` rebuilds by JavaScript type.
- The arithmetic and comparison cases *re-execute*: materialize both inputs, then perform the
  add, subtract, multiply, divide, modulo or compare on them.

And then the refusals, which are the interesting half.

```ts
    if (value.type === ir.IR_PHI) {
      const input = ir.trivialPhiInput(value);
      if (input) {
        return materializeFrameValue(
          input,
          runtimeValues,
          args,
          interpreter,
          thisValue,
        );
      }
      throw new Error(ir.missingPhiRuntimeValueMessage(value));
    }
```
— `src/deopt/frame-materializer.ts:179-191`

`missingPhiRuntimeValueMessage` produces `Cannot materialize non-trivial Phi v<id> without
runtime value` (`src/optimizing/ir/index.ts:198-200`). A phi with one distinct input can be
followed; a phi at a loop header cannot. There is no single answer to "what is the loop
accumulator" — that is what a phi *means*, that the value depends on which edge you arrived
on, and guessing one would resume the loop with the wrong running total. `IR_LOAD_CONTEXT_SLOT`
and `IR_MAKE_CLOSURE` throw outright for the same reason: a context cell's contents and a
closure's identity are not recoverable from the opcode alone.

So a loop accumulator must be in the snapshot, and it is: it has a wasm local, so
`emitDeoptSnapshot` stores it, so `readDeoptSnapshot` records it, so `materializeFrameValue`
finds it in `runtimeValues` and never reaches the phi case.
[t: tests/e2e/optimizing/deopt.test.ts > "resumes with the current loop accumulator after a late type miss"]
is that path end to end.

> **Unenforced.** The refusals cover three opcodes. Every *other* unhandled node type falls
> off the end of `materializeFrameValue` and returns `mkUndefined()`
> (`src/deopt/frame-materializer.ts:379`). An opcode that reaches a frame state without a
> runtime value and without a re-derivation case therefore produces `undefined` silently,
> where a phi in the same position produces a loud throw naming the node. The two treatments
> disagree about the same situation. Cost to fix: make the fallback throw the same
> `Cannot materialize ${type} v${id} without runtime value` the context-slot case already
> uses, which is one line — and then find out, from the test suite, which opcodes were quietly
> relying on `undefined`. **[unpinned]**

## Attribution

A bailout can name the guard that caused it, and sometimes it cannot, and the difference is
worth being explicit about.

At compile time, `collectDeoptSites(graph)` walks every node for which `canDeoptimize(node)`
holds and records a `DeoptSite`: `nodeId`, `opcode`, `reason` (from `deoptReasonForNode`),
`blockId`, `frameStateId`, `bytecodeOffset` and source `line`
(`src/optimizing/backends/wasm/deopt-sites.ts:10-19`, `:45-53`). The table is stashed on the
compiled function as `optimizedDeoptSites`.

At bailout time all the runtime has is a reason and a frame-state id — two integers pushed by
wasm. `DeoptSiteTable.resolve` tries three things in order:

```ts
  resolve(reason: string, frameStateId: number): readonly DeoptSite[] {
    const sharing = this.byFrameState.get(frameStateId);
    if (sharing !== undefined) {
      const exact = sharing.filter((site) => site.reason === reason);
      return exact.length > 0 ? exact : sharing;
    }
    const anywhere = this.sites.filter((site) => site.reason === reason);
    return anywhere.length > 0 ? anywhere : NONE;
  }
```
— `src/optimizing/backends/wasm/deopt-sites.ts:35-43`

Sites sharing the frame state *and* the reason; failing that, all sites sharing the frame
state; failing that, all sites with that reason anywhere in the function. Then
`deoptOriginData` reports the specifics **only when exactly one candidate survives**:

```ts
  const candidates = candidatesFor(input);
  const guard = candidates.length === 1 ? candidates[0]! : null;
```
— `src/deopt/origin.ts:34-35`

`nodeId`, `opcode`, `blockId` and `line` are `null` unless the answer is unambiguous — and the
full `candidates` array of node ids is reported either way. *A diagnostic that narrows to one
guard says which; a diagnostic that cannot says how many.* Three tests draw exactly those
three lines:
[t: tests/optimizing/backends/wasm/deopt-sites.test.ts > "resolves a bailout to the single guard that shares its frame state and reason"],
[t: tests/optimizing/backends/wasm/deopt-sites.test.ts > "returns every guard sharing a frame state when the reason does not single one out"],
and
[t: tests/optimizing/backends/wasm/deopt-sites.test.ts > "falls back to matching on reason alone when the frame state is unknown"].

> **Broken.** `--stats` reports zero deopts for a wasm bailout. `Deoptimizer.recordDeoptReason`
> and `Deoptimizer.getStats` (`src/deopt/deoptimizer.ts:384-398`) are the source of the
> `deoptStats` block in the `--stats` JSON, but the wasm wrapper never routes through
> `Deoptimizer` at all: `createWrapper`'s local `recordWasmDeopt` calls `tracer.jitDeopt` and
> `policy.recordDeopt` directly. **Measured:** `node dist/cli.js --stats
> docs/example/stats-deopt.tera` prints `"jit_deopts": 1` inside `tracerStats` and
> `"deoptStats": { "total": 0, "reasons": {} }` four lines later, in the same JSON object, for
> the same single bailout. Cost to fix: give the wrapper the `Deoptimizer` it already has an
> interpreter reference for, or move the counters onto the tracer — a handful of lines either
> way, but it has to pick one owner, because two counters for one event is how this happened.

## Lazy deopt

The third way is the one with no frame involved. Optimized code can become invalid while it is
not running: a hidden class transitions, an array's elements kind widens, a call target is
rebound.

At compile time the graph accumulates a list of things it assumed, tagged by kind —
`DEP_MAP`, `DEP_ELEMENTS_KIND`, `DEP_CALL_TARGET`, `DEP_PROTO_VALIDITY`
(`src/deopt/dependencies.ts:7-10`) — and on installation `engine.ts:1798-1801` calls
`dependencyRegistry.register(compiledFn, graph.dependencies)`. Registration logs one line per
dependency, which is what the running example's first trace line is.

When the assumption breaks, the object that breaks it says so. `JSArray.setElement`, on
widening a kind, calls `dependencyRegistry.invalidate(DEP_ELEMENTS_KIND, oldKind, null,
"elements-kind:<old>-><new>")` (`src/objects/heap/js-array.ts:123-130`). `invalidate` looks up
every function registered under that key and hands each to `LazyDeoptMarker.markForDeopt`,
which nulls `optimizedCode`, calls `updateCallMode`, and records why
(`src/deopt/deoptimizer.ts:118-134`). No snapshot is read and no frame is rebuilt, because
there is no frame: the function is not on the stack. The next call picks it up — the
interpreter's entry path calls `consumePendingLazyDeopt(compiledFn, -1, "at function entry")`
*before* it checks for `optimizedCode` (`src/bytecode/register/interpreter/index.ts:943`), so a
marked function simply runs its bytecode.

Both halves are pinned:
[t: tests/e2e/optimizing/speculation-deopt.test.ts > "dependency invalidation marks function for lazy deopt"]
and
[t: tests/e2e/optimizing/speculation-deopt.test.ts > "two functions sharing same map dependency both get marked for lazy deopt"].

The running example shows both mechanisms in one program.
`docs/example/stats-deopt.tera` runs `total_of` two hundred times over
`clean: float[]`, so the JIT speculates `PACKED_DOUBLE`, registers the dependency and compiles
the loop to `f64` arithmetic; then it hands the same function `tainted`, which has a string in
it.

```
$ node dist/cli.js --trace-deopt docs/example/stats-deopt.tera
[DEOPT] Dependency registered: total_of -> elements-kind:PACKED_DOUBLE
warm  total=78.50
[DEOPT] DEOPT "total_of": elements-kind-check-failed at bytecode:8
taint total=21.531.257.7518
```

The first line is registration, printed at install time, long before anything goes wrong. The
third line is a real in-wasm bailout: the `IR_CHECK_ELEMENTS_KIND` guard read the elements-kind
word at `+8` of the array's copy ([Ch 53 § object-layout](53-the-boundary-is-the-wall.md)),
found something other than `PACKED_DOUBLE`, wrote its snapshot, and called `env.deopt`. `total`
and `i` came back out of the snapshot region, `frame.pc` was set to 8, and the interpreter
finished the loop.

The fourth line is the proof. `21.531.257.7518` is what the *interpreter* produces for that
array: `+` between a number and a string is concatenation, so `12.5 + 9.0` is `21.5`, then
`"31.25"` concatenates, then `7.75`, then `18`. It is not a plausible float — it is exactly the
sequence of concatenations the un-optimized program performs, which is the point. The same
command with `--no-opt` prints the same two lines:

```
$ node dist/cli.js --no-opt docs/example/stats-deopt.tera
warm  total=78.50
taint total=21.531.257.7518
```

> **Unfinished.** `Deoptimizer.deoptimizeFromSignalState` (`src/deopt/deoptimizer.ts:275-289`)
> is declared `: never` and throws `Deoptimization without FrameState not fully supported yet`.
> It is reached from `Deoptimizer.deoptimize` whenever `signal.frameStateId` is negative or
> the frame state is missing. The wasm tier never gets there — its bailouts either carry a
> frame state or take the `resumeAt(new RegisterFrame(...))` branch inside the wrapper — so
> the message describes the `Deoptimizer` class rather than the backend. Cost to finish:
> nothing in this tier needs it; the honest move is to delete the branch and let the wrapper's
> fresh-frame path be the documented answer for "no frame state".

> **Never runs.** `IC_FAILURE_REASONS` (`src/deopt/deoptimizer.ts:173-180`) is a six-element
> `Set` of reason strings — `map-check-failed`, `smi-check-failed`, `number-check-failed`,
> `array-check-failed`, `elements-kind-check-failed`, `wrong-call-target` — constructed at
> module load and read nowhere. `grep -rn "IC_FAILURE_REASONS" src/ tests/` returns exactly
> one line, its definition. Cost to remove: one deletion. Cost to *use*: it is the beginning
> of a policy that would count inline-cache-shaped bailouts differently from arithmetic ones —
> a function that deopts three times on a map check has a polymorphism problem, while one that
> deopts three times on integer overflow has a range problem, and the two deserve different
> `maxDeoptCount` treatment. That is a real design, not a cleanup.

## When the JIT says no

Turn from bailing out to never starting. The backend can refuse a graph outright, and the
refusal carries a kind:

```ts
export type RejectionKind = "unsupported" | "speculation" | "malformed";

export interface CompileRejection {
  readonly kind: RejectionKind;
  readonly reason: string;
}
```
— `src/optimizing/target/jit.ts:8-13`

Three kinds, and they are not severities — they are three different *futures* for the same
struct. `WasmBackend.jitCompile` answers `{ code: null, rejection }`, and
`Engine.optimizeFunction` reads the kind:

```ts
        const rejection = jitResult.rejection.compileRejection;
        const malformedGraph = rejection?.kind === "malformed";
        this.recordCompileFailure(
          compiledFn,
          malformedGraph
            ? `internal compiler error: ${rejection.reason}`
            : rejection?.reason || jitResult.rejection.analysisFailure || "not-compilable",
          malformedGraph,
        );
        tracer.jitCompile(
          functionName(compiledFn),
          "Wasm compilation skipped — cooldown",
        );
```
— `src/api/engine.ts:1808-1820`

**`malformed`** means *the compiler is wrong*: a graph with a missing return, a node with the
wrong input count, a use list that disagrees with the inputs. It is prefixed
`internal compiler error:` and passed as `unrecoverable`, which sets
`compiledFn.disableOptimization = true` permanently (`engine.ts:1839-1859`). The function will
never be compiled again in this process, because there is no reason to think the second attempt
would produce a different graph.

**`unsupported`** means *this program shape is outside the backend's domain*: an opcode with no
wasm lowering, a closure constant with upvalues, a compare operator the emitter has no case
for. It sets `optimizationCooldownUntil` instead, so the function is retried later.

**`speculation`** means *the feedback is not good enough yet*. Same cooldown mechanism, but the
retry is genuinely likely to succeed: by the time it comes round again the caller may have
warmed up, the feedback may have sharpened, and the graph may be different. The one narrow
decline of this kind still in the tree is `hotBoxedReturnRejection`
(`src/optimizing/backends/wasm/graph-support.ts:788-804`), which refuses a function that boxes
a numeric return into a handle on a block the branch bias marked hot, with the reason
`boxes a numeric return into a handle on a hot path`.

The user sees the same line for all three:

```
$ node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera 2>&1 | grep -i "cooldown\|Bailout\|not compilable"
[JIT] Compiling "<script>": Bailout: unhandled opcode DefineClassMember (0xb) at bc:9
[JIT] Compiling "<script>": Bailout: unhandled opcode DefineClassMember (0xb) at bc:11
[JIT] Compiling "<script>": Wasm compilation skipped — cooldown
[JIT] Compiling "label": Wasm: graph not compilable: property access on this receiver
[JIT] Compiling "label": Wasm compilation skipped — cooldown
[JIT] Compiling "mean": Wasm: graph not compilable: property access on this receiver
[JIT] Compiling "mean": Wasm compilation skipped — cooldown
```

Three functions of the running example are declined and the trace says only "cooldown" for
each. The *reason* is recorded on `compiledFn.lastCompileFailureReason`, and it is the earlier
line — `graph not compilable: property access on this receiver` for `mean` and `label` — that
says what actually happened. Two of the three tests that draw the classification line are
[t: tests/optimizing/backends/wasm/rejection.test.ts > "reports a missing return as a malformed graph, not an unsupported one"]
and
[t: tests/optimizing/backends/wasm/rejection.test.ts > "separates a supported-but-unprofitable shape from a malformed one"].

## Declines that were reverted

*(What was tried and rejected.)*

[Ch 53 § objptrs-is-a-gc-root](53-the-boundary-is-the-wall.md) closed on the arithmetic:
per activation, object code pays a graph walk in, a graph walk back, and a stub call per
dynamic operation. Faced with that, the obvious response is to refuse to compile the functions
that pay it — to decide, at tier-up time, that a function whose shape guarantees heavy
marshalling is better left in the interpreter.

That was done. Three marshalling-shaped tiering declines were added: a loop that mutates a
global object and calls a heap-passing helper; a loopless leaf that allocates and returns a
heap value; a function that stores a fresh object into a global each iteration. They were
correct — those functions really did pay the copy cost — and they shipped.

They were then reverted, because the premise stopped being true underneath them. The inline
numeric field store and the global-load LICM fix of
[Ch 53 § what-stays-inside](53-the-boundary-is-the-wall.md) removed most of the marshalling
from exactly those shapes. A global-object mutation loop with no calls no longer copies
anything per iteration; it reads and writes an `f64` slot in place. The decline was betting
that the cost was structural, and the cost turned out to be a missing optimization.

What the tree has instead is a test file with two `describe` blocks that make opposite
assertions about the same three programs. `"heap-marshalling object code tiers up through
runtime stubs"` and `"escaping global heap stores tier through runtime stubs"` assert that the
three formerly declined shapes now compile and that `lastCompileFailureReason` is `null`
(`tests/e2e/optimizing/tiering-declines.test.ts:17-70`). And
`"functions that should still tier up are not over-declined"`
(`:270-307`) asserts the same thing for three narrower shapes, one of which —
`"JITs a global-object mutation loop with no calls (LICM keeps it fast)"` — names the
optimization that made the decline unnecessary in its own title.

**The general rule: a decline is a bet that the cost is structural; when the cost turns out to
be a missing optimization, the decline is the thing to delete.** And the way to keep that
honest is a test that asserts a refusal is *absent*. A test suite naturally accumulates
assertions that things happen; nothing accumulates assertions that things stop happening, so a
decline that has outlived its reason will sit in the tree indefinitely, quietly making the
engine slower, with every test still green.

> **Measured worse.** Three marshalling-based tiering declines were added, shipped, and
> reverted, on numbers that changed underneath them. They are the book's clearest example of a
> change that was complete, correct, tested, and removed — not because it was wrong when it
> was written, but because the code it was measuring against improved. The evidence left
> behind is `tests/e2e/optimizing/tiering-declines.test.ts`, whose
> `"functions that should still tier up are not over-declined"` block exists for no other
> purpose than to assert that they do not fire.

## What leaves

Either a `TaggedValue` — the optimized answer, marshalled back out — or a `RegisterFrame`
handed to `interpreter.resumeAt` with `frame.locals`, `frame.acc` and `frame.thisValue`
materialized and `frame.pc` set to the exact bytecode offset the speculation was taken at,
plus `compiledFn.optimizedCode = null` so the next call starts over from the bytecode. Either
way the program's observable behaviour is identical. That is the JIT's contract, and it is
worth saying plainly that it is not "fast": **it is "indistinguishable"**.

Every mechanism in Part VIII exists to keep that promise. Chapter 51's capability check
refuses a graph the target cannot express rather than approximating it. Chapter 52's encoder
refuses opcodes it has no bytes for. Chapter 53's copy-back declines to change a slot's kind,
and its depth guard turns a stack overflow into a defined bailout. This chapter's snapshot
reader declines to invent a value it cannot resolve, and its materializer throws rather than
guess a loop accumulator. Six refusals, all of the same shape: *when the fast path cannot be
justified, stop being fast rather than stop being right.*

And that is what buys the licence [Ch 49](../part-07-optimization/49-speculative-types-are-not-facts.md)
named. The optimizer is allowed to fold on a type it only believes because a guard says so,
because the guard is a real instruction with a real failure edge, and behind that edge is
everything in this chapter. The licence is not free and it is not abstract: it costs twelve
lines of emitted wasm per guard, a snapshot region sized to the largest frame state, a second
copy of every entry check in JavaScript, a dependency registry, and a materializer that knows
how to re-execute arithmetic. Part IX takes the identical graph to a target that declares no
`deopt` capability at all
([Ch 55 § a-target-describes-itself](../part-09-ahead-of-time/55-the-same-graph-with-no-way-out.md)).
There, `frame-state-elision` sets every `frameState` to `null`
([Ch 51 § frame-state-elision](51-legalizing-for-a-target.md)), the snapshot has nowhere to go,
`env.deopt` does not exist, and there is no interpreter underneath to resume into. Every guard
in this chapter has to become either a proof or a refusal.

## Verify it yourself

```bash
# Registration, then a real in-wasm bailout, then the interpreter's answer.
node dist/cli.js --trace-deopt docs/example/stats-deopt.tera

# The same two lines with no optimizing tier at all: the deopt is invisible.
node dist/cli.js --no-opt docs/example/stats-deopt.tera

# One bailout, counted once in tracerStats and zero times in deoptStats.
node dist/cli.js --stats docs/example/stats-deopt.tera 2>&1 | grep -B 5 -A 4 '"deoptStats"'

# Three-tier fallback in DeoptSiteTable.resolve, in isolation.
npx vitest run --project unit tests/optimizing/backends/wasm/deopt-sites.test.ts

# The declines that were reverted: a suite asserting refusals are absent.
npx vitest run --project e2e tests/e2e/optimizing/tiering-declines.test.ts

# Three of stats.tera's functions declined; the trace says only "cooldown".
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera 2>&1 | grep -i "cooldown\|Bailout\|not compilable"
```

## Tests that pin this

- `tests/e2e/optimizing/deopt.test.ts` > `"resumes a guarded method call without inventing a numeric callee"` — the unresolvable-handle case records nothing.
- `tests/e2e/optimizing/deopt.test.ts` > `"keeps a mirrored global correct across a deopt resume"` — `storeGlobalCells` in the catch.
- `tests/e2e/optimizing/deopt.test.ts` > `"keeps an optional call on a changing global consistent"` — repeated bailouts on the same site.
- `tests/e2e/optimizing/deopt.test.ts` > `"does not throw when a failing return stub coincides with a dead optional chain"` — `runtime-stub-failure` on a dead path.
- `tests/e2e/optimizing/deopt.test.ts` > `"still short-circuits the optional chain to null when its result is used"` — the same shape, live.
- `tests/e2e/optimizing/deopt.test.ts` > `"resumes with the current loop accumulator after a late type miss"` — the phi that must be in the snapshot.
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"records one site per node that can bail out, and skips the ones that cannot"` — `canDeoptimize` decides the table.
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"resolves a bailout to the single guard that shares its frame state and reason"` — first fallback tier.
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"returns every guard sharing a frame state when the reason does not single one out"` — second tier.
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"falls back to matching on reason alone when the frame state is unknown"` — third tier.
- `tests/optimizing/backends/wasm/deopt-sites.test.ts` > `"finds nothing in a graph whose arithmetic was proven not to overflow"` — no guard, no site.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"CheckSmi frameState has correct compiledFunction, Deoptimizer restores pc from it"` — `frame.pc = frameState.bytecodeOffset`.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"frameState locals are materialized into RegisterFrame by Deoptimizer"` — the locals fill.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"frameState with stack values: Deoptimizer sets acc from last stack entry"` — the accumulator fill.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"each CheckSmi guard has a distinct frameState ID matching frameStates array"` — the id the wasm side pushes really indexes the array.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"deopt from CheckMap guard vs CheckSmi guard restore to different bytecodeOffsets"` — attribution reaching the resume point.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"Deoptimizer sets deoptCount and clears optimizedCode via handleDisableOptimization"` — step 4 of § catching-it.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"reaching maxDeoptCount via speculation frameState disables optimization"` — the budget.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"disableOptimization triggers exactly at maxDeoptCount boundary"` — the boundary, not one either side of it.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"dependency invalidation marks function for lazy deopt"` — the third way.
- `tests/e2e/optimizing/speculation-deopt.test.ts` > `"two functions sharing same map dependency both get marked for lazy deopt"` — one key, many dependents.
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"optimizes a loop that mutates a global object and calls a heap-passing helper"` — reverted decline 1.
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"optimizes a loopless leaf that allocates and returns a heap value"` — reverted decline 2.
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"optimizes a function that stores a fresh object into a global each iteration"` — reverted decline 3.
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"JITs a global-object mutation loop with no calls (LICM keeps it fast)"` — the absent refusal, naming its own cause.
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"JITs a local object mutation loop (no global, no call)"` — the same for a local receiver.
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"JITs a loopless function that only returns strings (no alloc, no dynamic access)"` — the same for a leaf.
- `tests/e2e/optimizing/tiering-declines.test.ts` > `"resumes deoptimized closure bodies with their captured environment"` — `closureEnv` survives the resume.
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"reports a missing return as a malformed graph, not an unsupported one"` — malformed means the compiler is wrong.
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"separates a supported-but-unprofitable shape from a malformed one"` — speculation is not malformed.
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"reports an opcode the backend cannot emit as unsupported"` — the third kind.
- The snapshot writer and reader agreeing on slot order — **[unpinned]**; guaranteed only by both calling `visitDeoptSnapshotValues`.
- `hotBoxedReturnRejection` by name — **[unpinned]**; reached only through `compileRejection` in the end-to-end tiering suites.
- `tests/e2e/docs/book-examples.test.ts` > `"stats-deopt.tera prints what the book says it prints"` — the two printed lines, at production thresholds, so the bailout really happens under the pin.
- `materializeFrameValue`'s `mkUndefined()` fallback for unhandled opcodes — **[unpinned]**.
- The `--no-opt` run agreeing with the optimized run on `stats-deopt.tera` — **[unpinned]**; `differential()` refuses any source whose last non-blank line starts with `print(`, which this one's does, so no differential test can be handed it.
- The `REP_HANDLE` patch loop in the deopt catch — **[unpinned]**.
