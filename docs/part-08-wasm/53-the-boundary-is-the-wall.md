# 53. The boundary is the wall   ⟨ I · J ⟩

tera's heap is made of JavaScript objects. WebAssembly linear memory is one `ArrayBuffer`
of bytes. There is no pointer from the second into the first and no way to make one. So
every heap value that a compiled function touches is *copied* into linear memory before the
call and copied back out after it, and the copy is a second object that can drift out of
agreement with the original while the call is still running.

That single fact decides everything about how the JIT performs. A function whose values are
all numbers pays nothing: the numbers go in as wasm parameters and come back as a wasm
result. A function that reads one field of one object pays a graph walk in, a graph walk
back, and — if anything in that function can call out to the interpreter — a call back
across the boundary for *every* heap access it makes, whether or not that access had
anything to do with the call. This chapter is the cost model. It is also the reason
chapter 54 has a section about three tiering refusals that were built on that cost, shipped,
and then deleted.

`docs/example/stats.tera` reaches only the shallow end of this. Its `Series.mean` is refused
by the wasm backend outright — `Wasm: graph not compilable: property access on this
receiver` — and only `report` compiles, at 419 bytes with two runtime stubs. The programs
that show the machinery working are the ones the engine's own tests use, and per
[Conventions § 2](../CONVENTIONS.md) they appear here as quoted test sources and as commands
under "Verify it yourself", never as book listings beside the running example.

**What arrived.** From [Ch 52 § five-sections](52-emitting-webassembly-by-hand.md): a
`Uint8Array` of wasm module bytes, already handed to `new WebAssembly.Module` and
`new WebAssembly.Instance`, with an exported function named `opt`. Alongside it, the
`analyzeGraph` result that decided every byte in that module — `nodeValueRep` (what
representation each value has), `runtimeStubTable` (which nodes could not be compiled),
`globalCellOffsets`, `memoryLayout`, and three booleans that the wrapper will read on every
single call: `needsMemory`, `mutatesHeapObjects`, `hasInlineAlloc`.

## Two heaps

A tera value at run time is a `TaggedValue`: a JavaScript number whose bits carry a
four-bit tag, and whose payload — for anything that is not a small integer — is an index
into a side table from which `getPayload` hands back a `JSObject` or a `JSArray`
([Ch 22 § four-bits-inside-a-double](../part-04-execution/22-values-four-bits-inside-a-double.md)).
Those objects live in V8's heap. They have JavaScript property slots, a `hiddenClass`
pointer, an elements kind, and identity.

Wasm linear memory has none of that. It is a flat, growable byte array. It has no tags, no
object headers it did not put there itself, no garbage collector, and no way to name a
JavaScript object. A wasm function's parameters and results are `i32`, `i64`, `f32` and
`f64`, and nothing else.

> **New idea. Marshalling.** When two runtimes cannot share a representation, a value that
> crosses between them must be *translated* — read out of one representation and written
> into the other. The translation produces a **copy**, and from that instant there are two
> versions of the same value in two places. Everything difficult about a foreign-function
> boundary follows from that one sentence: how much does the copy cost, who is allowed to
> write to which version, and what happens when they disagree.

The whole of this chapter is that paragraph applied to one boundary. tera calls the copy-in
direction *serialization* and the copy-back direction *deserialization*, and the two
functions have those names.

## Object layout

The copy needs a layout, and the layout is four numbers. `serializeObject` writes a
JavaScript object as a header plus a run of doubles, and writes a JavaScript array with a
different header:

```
object at ptr:
offset  width  contents                       written by
------  -----  -----------------------------  --------------------------
+0      4      hiddenClass.id (0 if none)     serializeObject
+4      4      slots.length                   serializeObject
+8      8      slot[0]  as f64                serializeObject / f64.store
+8+8i   8      slot[i]  as f64                       "

array at ptr:
+0      4      -1  (the "this is an array" mark)
+4      4      elements.length
+8      4      elementsKindId(kind)   1..6, 0 = unknown
+12     4      (padding)
+16     8      element[0] as f64
+16+8i  8      element[i] as f64
```

An array is distinguished from an object by a *negative* map id in the first word — the
literal `-1` — because no hidden class ever has a negative id. The elements-kind word is
six ids from `ELEMENTS_KIND_IDS` in `src/optimizing/backends/wasm/object-layout.ts:12-19`,
numbered 1 through 6 (`PACKED_SMI`, `PACKED_DOUBLE`, `PACKED_TAGGED`, `HOLEY_SMI`,
`HOLEY_DOUBLE`, `HOLEY_TAGGED`), with `elementsKindId` answering `0` for anything it does
not recognise.

Those four numbers are what makes the layout an *invariant* rather than a private detail of
one function, because the emitted wasm hard-codes them a second time. A field load compiles
to a single `f64.load` at `8 + offset * 8`:

```ts
        const memOffset = 8 + offset * 8;
        bytes.push(wasmFormat.OP_LOCAL_GET, ...wasmFormat.encodeU32(objLocal));
        if (analysis.nodeWasmType.get(node.id) === wasmFormat.TYPE_I32) {
          bytes.push(
            wasmFormat.OP_F64_LOAD,
            ...wasmFormat.encodeU32(3),
            ...wasmFormat.encodeU32(memOffset),
          );
```
— `src/optimizing/backends/wasm/codegen.ts:3545-3552`

An array length is an `i32.load` at offset `4` with alignment 2
(`codegen.ts:3206-3211`). An element load computes `ptr + 16 + index * 8` with explicit
`i32.const 16`, `i32.const 8`, `i32.mul`, `i32.add` and then an `f64.load` at offset 0
(`codegen.ts:3724-3751`). And the elements-kind word at `+8` is read by exactly one emitted
instruction in the whole backend: the `IR_CHECK_ELEMENTS_KIND` guard loads it with
`i32.load align=2 offset=8`, compares it against `elementsKindId(kindName)`, and bails out
if it differs (`codegen.ts:3109-3145`). That guard is what produces the
`elements-kind-check-failed` line in chapter 54's worked example, so every number in the
table above is live.

> **Unenforced.** The offsets `8`, `16`, `4` and the array's `-1` mark are literals in
> `emitNode` and, independently, literals again in `serializeObject` and
> `deserializeObject` (`runtime-support.ts:1194-1234`). Nothing derives one from the other,
> and no test asserts that the writer's layout and the reader's layout agree. A changed
> header size is a silent miscompile that only an end-to-end differential would catch, and
> then only for a shape it happens to cover. Cost to fix: one exported
> `objectHeaderBytes` / `arrayHeaderBytes` pair that both files import, about ten lines,
> plus a unit test that round-trips one object of each kind.

## Every slot is an f64

The layout has one width. Whatever a slot held in JavaScript, it becomes eight bytes of
IEEE-754 double. `serializeObject` decides what to write with a four-way test:

```ts
    const val = slots[i];
    let numVal = 0;
    if (typeof val === "number" && isNumber(val)) numVal = toNumber(val);
    else if (typeof val === "number" && isBool(val)) numVal = getPayload(val) ? 1 : 0;
    else if (
      typeof val === "number" &&
      val !== undefined &&
      allocateTaggedValue &&
      (isObject(val) ||
        isArray(val) ||
        isFunction(val) ||
        isString(val) ||
        isNull(val) ||
        isUndefined(val))
    ) {
      numVal = allocateTaggedValue(val);
    }
    liveView().setFloat64(basePtr + (isJsArray ? 16 : 8) + i * 8, numVal, true);
```
— `src/optimizing/backends/wasm/runtime-support.ts:1217-1234`

A number is written as itself. A boolean is written as `1` or `0`. An object, array,
function, string, `null` or `undefined` is written as **a pointer, as a double** — the
recursive `allocateTaggedValue` call copies that value into linear memory too and answers
the byte offset it landed at. And a slot the test does not recognise is written as `0`.

So a slot holding the number `15.7` and a slot holding a reference to a string are, in
linear memory, both eight bytes of double, and nothing in those eight bytes says which is
which. Worse, the pointers are small. `wasmMemoryLayout` stacks three fixed regions —
deopt snapshot, global cells, constant pointers — and puts the object arena immediately
after them (`src/optimizing/backends/wasm/memory-layout.ts:45-60`); for a function with no
deopt slots, no mirrored globals and no non-primitive constants, all three regions are
empty and `arenaBase` is `DEOPT_SNAPSHOT_BASE`, which is `8`. The first object copied into
such a function has the address `8`. As a double in a slot, that is indistinguishable from
the integer eight.

The distinction lives entirely outside the bytes, in `analysis.nodeValueRep`: a value whose
representation is `REP_HANDLE` is a pointer, and a value with a numeric representation is a
number. That table was computed at compile time by representation selection
([Ch 48 § representation](../part-07-optimization/48-types-and-representations-in-the-middle-end.md)),
it is not written into memory anywhere, and it is consulted by every function on both sides
of the boundary that has to turn a raw `f64` back into a value.

**The boundary is untyped, and the compiler's representation choice is the only thing that
keeps it honest.** That claim is the spine of this chapter and of the next one. It is why
`runtimeArg` asks `analysis.nodeValueRep.get(input.id)` before deciding whether a raw
number is a handle; it is why `deserializeObject` refuses to write back into a slot whose
tag it does not understand; and it is why the deopt reader in
[Ch 54 § reading-it-back](54-deoptimizing-out-of-wasm-and-when-the.md) would rather record
nothing at all than record a pointer it cannot resolve.

The cost of getting it wrong is visible in the one place the code guesses. `getTagged(ptr)`
looks a pointer up in `objPtrs`, and if it finds nothing and inline allocation is off, its
last line is `return mkNumber(ptr)` (`codegen.ts:4685`). An address that fell out of the map
comes back as the integer that address happens to be.

## allocateTagged

`allocateTagged` is the copy-in function. It is built fresh inside every activation, closing
over that activation's maps, and it does three things beyond the obvious recursion.

**Identity memoization.** `ptrByIdentity: Map<HeapPayload, number>` remembers the address
each JavaScript payload was copied to. The same `JSObject` reached twice through two
different fields gets the same pointer both times.

> **New idea. Identity map.** A naive recursive copy of a value graph treats it as a
> *tree*: it follows every edge and copies whatever it finds at the end. But an object graph
> is a directed graph, not a tree. If `v = {b: g1, c: g1}` and `g1` in turn has two fields
> both pointing at `g0`, a tree copy reaches `g0` four times, `g0`'s children eight times,
> and so on: `2^depth` work for a graph with `depth` nodes. An identity map — keyed by
> object *identity*, not by value — turns the tree walk back into a graph walk by answering
> "I have already copied this one, here is where it went". It also preserves the thing the
> program can observe: after the copy, `v.b === v.c` is still true, because both slots hold
> the same address.

**A per-pass cycle set.** Memoizing the pointer is not enough, because a cyclic graph would
still recurse forever: the cached pointer exists, but the slots at that pointer have not
been filled in yet, so the copy re-enters. `serializedThisPass: Set<HeapPayload>` records
which payloads have been *written*, not merely assigned an address, during the current
top-level copy:

```ts
      const allocateTagged = (tagged: TaggedValue, skipSlotSerialization = false, maxSlots = -1) => {
        serializeDepth++;
        try {
          if (serializeDepth > MAX_SERIALIZE_DEPTH) throw new SerializeTooDeep();
          return allocateTaggedImpl(tagged, skipSlotSerialization, maxSlots);
        } finally {
          if (--serializeDepth === 0) serializedThisPass.clear();
        }
      };
```
— `src/optimizing/backends/wasm/codegen.ts:4447-4455`

The set is cleared when `serializeDepth` returns to zero. That is a deliberate second
behaviour, not just bookkeeping: within one top-level copy a payload is written at most
once, so a cycle terminates; but a *second* top-level copy in the same activation — a stub
call marshalling another argument, say — starts with an empty set and therefore re-reads
every object it touches, picking up any mutation the interpreter made in between.

**A depth guard.** `MAX_SERIALIZE_DEPTH` is 512 (`codegen.ts:186`). Past it,
`allocateTagged` throws `SerializeTooDeep`, a private `Error` subclass declared on
`codegen.ts:189`. The argument-marshalling loop is wrapped in a `try` that catches exactly
that class:

```ts
      } catch (e) {
        if (e instanceof SerializeTooDeep) {
          recordWasmDeopt(DEOPT_GUARD_FAILURE, 0);
          return interpreter.resumeAt(
            new RegisterFrame(compiledFn, args, thisValue, closureEnv),
          );
        }
        throw e;
      }
```
— `src/optimizing/backends/wasm/codegen.ts:4605-4613`

Nothing has executed yet — this is the entry path, before the wasm call — so the frame it
resumes into is a fresh `RegisterFrame` at offset zero, and the function simply runs in the
interpreter this time.

The general rule is worth stating plainly, because chapter 54 depends on it: **a would-be
stack overflow becomes a deopt.** A `RangeError` thrown from the middle of marshalling
would escape into the caller as a language-level exception the program never wrote; a deopt
is a *defined outcome* with a defined resumption point. Given a choice between an undefined
failure and a slower correct answer, the boundary takes the slower correct answer every
time.

Both halves are pinned.
[t: tests/e2e/optimizing/gc-roots.test.ts > "does not blow up exponentially on a diamond chain, and deopts past the depth guard"]
runs a self-referential chain at 120 and at 2000 iterations and requires both to agree with
the oracle — the first proves the identity map, the second walks past 512 and proves the
deopt.
[t: tests/e2e/optimizing/gc-roots.test.ts > "materializes a single object shared by many fields exactly once"]
builds `o = {a: shared, b: shared, c: shared, d: shared, m: (s) => (o)}` and checks that the
value read back through two hops is still the one object.

## Arena and capacity

The copies go into a bump-allocated arena that starts at `analysis.memoryLayout.arenaBase`
and is managed by two closures:

```ts
      const takeObjPtr = () => {
        if (analysis.hasInlineAlloc && memory) {
          const inlinePtr = new DataView(memory.buffer).getInt32(0, true);
          if (inlinePtr > nextObjPtr) nextObjPtr = inlinePtr;
        }
        if (nextObjPtr > arenaTop) arenaTop = nextObjPtr;
        return nextObjPtr;
      };

      const releaseObjPtr = (end: number) => {
        nextObjPtr = end;
        arenaTop = end;
        if (analysis.hasInlineAlloc && memory) {
          new DataView(memory.buffer).setInt32(0, end, true);
        }
      };
```
— `src/optimizing/backends/wasm/codegen.ts:4417-4432`

> **New idea. Bump allocation.** The cheapest possible allocator: keep one pointer at the
> top of a region, and allocate `n` bytes by answering the pointer and adding `n` to it.
> There is no free list, no size class and no per-object bookkeeping. The catch is that
> nothing can ever be freed individually — the only way to reclaim is to move the pointer
> back, which frees everything above it at once. That is exactly the discipline an
> activation can afford, because an activation has a well-defined end.

Address `0` is the shared top-of-arena word when the function does inline allocation, so
the wasm side and the JavaScript side bump the same counter through the same four bytes.

Sizes differ by kind. An array gets slack — `capacity = Math.max(slots * 2, 4)` — so that a
`push` performed *inside* wasm has somewhere to go; an object gets exactly `slots` doubles
and no more (`codegen.ts:4483-4528`). `ensureMemory(newEnd)` grows the `WebAssembly.Memory`
by `pagesToGrow(needed, currentSize)` = `ceil((needed - current) / 65536)` pages when the
region would run off the end.

Reclamation is a single assignment in a `finally`. The outer `optimizedCode` wrapper is
nothing but a save-and-restore around `runActivation`:

```ts
      const enclosingArenaTop = arenaTop;
      try {
        const answered = runActivation(args, thisValue, rawInterpreter, closureEnv);
        return wrapsDeclaredInt ? asDeclaredInt32(answered) : answered;
      } finally {
        arenaTop = enclosingArenaTop;
        if (analysis.hasInlineAlloc && memory) {
          new DataView(memory.buffer).setInt32(0, enclosingArenaTop, true);
        }
      }
```
— `src/optimizing/backends/wasm/codegen.ts:4836-4845`

A nested activation — a compiled function that calls out and ends up in another compiled
function — allocates above the outer one's top and gives all of it back on return, whether
it returned or threw. `serializedCount` on each `ObjectPointerInfo` records how many array
elements were written, so a re-serialization of a grown array copies only its new tail
rather than the whole thing.

> **Unfinished.** `ensureMemory` (`codegen.ts:4436-4445`) calls `memory.grow(...)` inside a
> `try { } catch (e) { }` whose body is empty. A refused growth is silently ignored and the
> `serializeObject` that follows writes past the end of the buffer, where
> `DataView.setFloat64` throws a `RangeError` that nothing converts into a deopt — it
> propagates out of the wrapper as a language exception. Cost to finish: convert the failed
> grow into the same `SerializeTooDeep` path that already exists ten lines below, which is
> two lines in the `catch` and a comment's worth of thought about whether a partially grown
> memory is safe to keep using.

## Copy-back

When the call returns, `commitTrackedObjects` walks `objPtrs` and calls `deserializeObject`
on each entry, reading the doubles back out and writing them into the JavaScript slots. This
is the direction where the copy can do damage, and it is guarded by a rule that is easier to
see than to state:

```ts
  for (let i = 0; i < limit; i++) {
    const numVal = view.getFloat64(basePtr + (isArray ? 16 : 8) + i * 8, true);
    const current = slots[i];
    if (typeof current === "number") {
      const tag = getTag(current);
      if (tag === TAG_SMI) {
        if (Number.isInteger(numVal) && numVal === (numVal | 0)) {
          slots[i] = mkSmi(numVal);
        } else {
          slots[i] = mkDouble(numVal);
        }
      } else if (tag === TAG_DOUBLE) {
        slots[i] = mkDouble(numVal);
      } else if (tag === "bool") {
        slots[i] = mkBool(numVal !== 0);
      }
    }
  }
```
— `src/optimizing/backends/wasm/runtime-support.ts:1256-1273`

> **New idea. Tag.** A tag is the few bits a runtime value carries that say what *kind* of
> thing it is — small integer, double, boolean, string, object — as distinct from what its
> value is. `getTag` reads those bits. In an untagged representation like linear memory
> there is nowhere to put them, which is why they have to be recovered from somewhere else.

Read the switch for what it does *not* contain. There is no `else`. A slot whose current
tag is a string, an object, a function, `null` or `undefined` is left exactly as it was,
and the eight bytes wasm wrote there are discarded. That absence is deliberate and it is
the most load-bearing thing in the file: the f64 image of such a slot is *a pointer into
linear memory*, and writing it back as a number would silently replace a string with the
integer 8.

The general rule: **the copy-back is allowed to update a value, never to change its kind.**
Which means a compiled function cannot, through the copy-back path, store a string into a
field that held a number, or a number into a field that held an object. Anything that
changes a slot's kind has to go through a runtime stub instead, which writes the JavaScript
slot directly — and that is the next section.

Two details of the same shape. `deserializeObject` honours `maxSlots` only for objects
(`!isArray && maxSlots >= 0`), so an array is always committed in full up to its length; and
the `TAG_SMI` branch re-canonicalises, answering a Smi when the double happens to be an
exact int32 and a double otherwise, which is what keeps a field that was a small integer
from silently becoming a boxed double after one round trip.

## Runtime stubs

Compiled code meets operations it cannot perform. A generic `+` between two values whose
types were never narrowed; a property load on a receiver whose shape was never pinned; a
call to something the compiler could not identify. Wasm has no instruction for any of them,
and there is no library to link against. The answer is one import.

```ts
      const runtimeStubTypeIdx = builder.addType(
        [
          wasmFormat.TYPE_I32,
          wasmFormat.TYPE_I32,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
          wasmFormat.TYPE_F64,
        ],
        [wasmFormat.TYPE_F64],
      );
```
— `src/optimizing/backends/wasm/codegen.ts:4006-4020`

The five lines after that register it as `builder.addFuncImport("env", "runtimeStub",
runtimeStubTypeIdx)`. So `env.runtimeStub` takes two `i32` — a stub id and a frame-state id
— followed by eight `f64` operands, and answers one `f64`. One signature, for every
operation the backend cannot compile.

`emitRuntimeStubCall` (`codegen.ts:2232-2290`) writes the call in a fixed order. First the
deopt snapshot, because the stub may bail out and the snapshot has to already be in memory
when it does ([Ch 54 § the-snapshot](54-deoptimizing-out-of-wasm-and-when-the.md)). Then
`i32.const stub.id` and `i32.const fsId`. Then exactly eight operands, each either a
`local.get` (with an `f64.convert_i32_s` if the operand's wasm type is `i32`) or an
`f64.const 0` for the ones that do not exist. Then the call. Then, if the node's result has
a local, a conversion of the returned `f64` back to the node's own wasm type — through
`emitCheckedInt64FromF64`, which can itself deopt, when the result is an `i32`.

On the JavaScript side, `imports.env.runtimeStub` looks the stub up in `RuntimeStubTable`,
finds the IR node it stands for, and calls `executeRuntimeStub`. If anything inside that
throws something other than a `DeoptSignal`, the import converts it into a
`DEOPT_RUNTIME_STUB_FAILURE` bailout rather than letting it escape (`codegen.ts:4200-4210`)
— the same instinct as the depth guard: an undefined failure becomes a defined one.

## The list is the lesson

Which nodes become stubs is a set literal, `RUNTIME_STUB_NODES`, at
`src/optimizing/backends/wasm/graph-support.ts:71-107`. It has forty-two members. Written
out, with the two spreads expanded:

`IR_GENERIC_ADD`, `IR_GENERIC_SUB`, `IR_GENERIC_MUL`, `IR_GENERIC_DIV`, `IR_GENERIC_MOD`,
`IR_GENERIC_COMPARE`, `IR_GENERIC_GET_PROP`, `IR_GENERIC_SET_PROP`,
`IR_GENERIC_DELETE_PROP`, `IR_GENERIC_CALL`, `IR_GENERIC_GET_INDEX`,
`IR_GENERIC_SET_INDEX`, `IR_GENERIC_BITAND`, `IR_GENERIC_BITOR`, `IR_GENERIC_BITXOR`,
`IR_GENERIC_SHL`, `IR_GENERIC_SHR`, `IR_GENERIC_USHR`, `IR_GENERIC_BITNOT`,
`IR_GENERIC_POW`, `IR_GENERIC_INSTANCEOF`, `IR_GENERIC_IN`, `IR_LOAD_GLOBAL`,
`IR_STORE_GLOBAL`, `IR_LOAD_CONTEXT_SLOT`, `IR_STORE_CONTEXT_SLOT`, `IR_NEW_OBJECT`,
`IR_NEW_ARRAY`, `IR_MAKE_CLOSURE`, `IR_NEW_REGEX`, `IR_TYPEOF`, `IR_NOT`, `IR_NEG`,
`IR_UNBOX`, `IR_CALL_BUILTIN`, `IR_CALL_INTRINSIC`, `IR_CALL_KNOWN_FUNCTION`,
`IR_CHECK_CALL_TARGET`, `IR_DISPATCH_MAP`, `IR_MEGAMORPHIC_LOAD`, `IR_MEGAMORPHIC_STORE`,
`IR_FLOAT64_POW`.

The length is the argument. Every `IR_GENERIC_*` opcode is here, which means every
arithmetic, comparison, property and index operation that speculation failed to narrow. All
four call opcodes are here — including `IR_CALL_KNOWN_FUNCTION`, where the target *is*
known. Global loads and stores are here. Object and array creation is here. `typeof`, `!`
and unary minus are here. So is `IR_UNBOX`, which is nothing more than taking a value out
of its box.

**The JIT compiles numbers.** Everything else a dynamic language does is a call back into
the interpreter under a different calling convention. That is not a criticism of this
backend; it is what "JIT-compiling a dynamic language without a runtime written in the
target language" means. The AOT compiler answers the same list a completely different way —
by *lowering the operation into tera source* and compiling that
([Ch 51 § lowering-to-tera-not-to-c](51-legalizing-for-a-target.md)) — which is why it can
have no equivalent of `env.runtimeStub` and also why it refuses so much more.

The counts are observable. `docs/example/stats.tera` compiles `report` to 419 bytes with
two stubs. `docs/example/stats-closure.tera`, whose top level allocates an array, calls
`values.map` with a closure, and formats a float, compiles to 4243 bytes with **28** stubs:

```
$ node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats-closure.tera
[JIT] Compiling "<script>": Wasm module compiled: 4243 bytes, 4 blocks
[JIT] Compiling "<script>": Runtime stubs lowered: 28
[JIT] Compiling "<script>": Wasm installed in 24.63ms
[JIT] Compiling "scaler": Wasm module compiled: 409 bytes, 1 blocks
[JIT] Compiling "scaler": Runtime stubs lowered: 2
```

## A second interpreter

`executeRuntimeStub` is `switch (node.type)` over IR opcodes, and it runs from
`runtime-support.ts:590` to `:1176` — 587 lines, with fifty `case IR_*` labels. It is worth
naming what that is: a **second evaluator**. The first one dispatches on bytecode opcodes
over a `RegisterFrame` ([Ch 21 § the-dispatch-loop](../part-04-execution/21-the-dispatch-loop.md));
this one dispatches on IR opcodes over an argument array. They share the runtime underneath
— `toPrimitiveOperand`, `applyBinaryOverload`, `getRuntimeProperty`, `callBuiltinMethod`,
`callBuiltinGlobal` — so the *semantics* have one implementation even though the dispatch
has two.

The interesting three lines are at the top:

```ts
  const args = node.inputs.map((input, i: number) =>
    runtimeArg(rawArgs[i], input, analysis, runtime),
  );
```
— `src/optimizing/backends/wasm/runtime-support.ts:600-602`

`rawArgs` is eight raw `f64` values with no type information whatsoever. `runtimeArg`
recovers the type from the *input node's* representation:

```ts
  const rep = analysis.nodeValueRep.get(input.id);
  const type = analysis.nodeWasmType.get(input.id);
  if (rep === REP_HANDLE) {
    return runtime.getTagged(raw);
  }
  if (rep === REP_TAGGED) {
    return (isTaggedValue(raw) ? raw : mkNumber(raw)) as TaggedValue;
  }
  if (rep === REP_BOOL) return mkBool(Math.trunc(raw) !== 0);
  if (type === TYPE_I32) return mkSmi(Math.trunc(raw));
  if (type === TYPE_F64) return mkNumber(raw);
  return mkNumber(raw);
```
— `src/optimizing/backends/wasm/runtime-support.ts:355-366`

and `runtimeReturn` (`:369-399`) does the inverse using the *stub's* recorded `outputRep`,
allocating a fresh pointer through `runtime.allocateTagged` when the answer has to go back
as a handle. This is the second place in the chapter — after § every-slot-is-an-f64 — where
`nodeValueRep` is the only type information in the system. Get the table wrong and the raw
number `8` becomes either the small integer eight or the object at address eight, with no
diagnostic either way.

Not every operation reaches the stub. `MATH_INTRINSICS` gives some `Math` calls a real wasm
opcode when their operands are raw doubles, and falls back to a stub when they are not:
[t: tests/optimizing/backends/wasm/math-intrinsics.test.ts > "inlines the wasm opcode when the operand is a raw double"]
and
[t: tests/optimizing/backends/wasm/math-intrinsics.test.ts > "falls back to a runtime stub when the operand is a boxed handle"].
The pair is the whole boundary in miniature: the same source operation is a single
instruction or a re-entry, decided by a representation.

## The eight-operand limit

*(Bugs are told as engineering.)*

**Symptom.** A tera function taking nine parameters, called in a loop until it tiers up,
answers `45` in the interpreter and `28` under the JIT.

```
$ node dist/cli.js --no-opt nine.tera
45
$ node dist/cli.js --opt-threshold 1 nine.tera
28
```

`45` is `1+2+…+9`. `28` is `1+2+…+7`. Two arguments went missing. The same program with
seven parameters answers `28` under both, so the defect is arity-dependent and the boundary
is somewhere between seven and nine. (These are single runs, one case per fresh process; the
full program is in "Verify it yourself".)

**Mechanism.** The import takes eight `f64`. `emitRuntimeStubCall` writes exactly eight:

```ts
    for (let i = 0; i < 8; i++) {
      const input = node.inputs[i];
```
— `src/optimizing/backends/wasm/codegen.ts:2247-2248`

An `IR_GENERIC_CALL` spends input 0 on the callee, so seven arguments fit and the eighth and
ninth are never pushed. On the other side, `executeRuntimeStub` maps over **all** of
`node.inputs` — not over `rawArgs` — so for a ten-input node it reads `rawArgs[8]` and
`rawArgs[9]`, which are `undefined`, and hands them to `runtimeArg` anyway. The
`IR_GENERIC_CALL` case then slices `args.slice(1, 1 + argCount)`
(`runtime-support.ts:910-937`), so the callee is invoked with nine arguments of which the
last two came from nothing. They arrive as zero: the same program with body `return h`
answers `8` under `--no-opt` and `0` under `--opt-threshold 1`, one run per fresh process.
Nothing throws, nothing is traced, and `45` becomes `28`.

**Fix.** Not applied. `compileRejectionForNode` (`graph-support.ts:331-406`) checks arity
for fixed-arity opcodes through `FIXED_INPUT_COUNTS` (`graph-support.ts:228-303`) and has a
special case for `IR_DISPATCH_MAP` and `IR_GENERIC_DELETE_PROP`, but the variadic call
opcodes are not in the table at all, so no bound is ever applied to them.

**Regression test.** None exists. The behaviour is `[unpinned]`, and that is the finding.

**General rule.** *An encoder with a fixed operand window needs a rejection, not a loop
bound.* The `for (let i = 0; i < 8; i++)` is exactly where the refusal should have been:
the encoder knows it cannot represent this node, and it has a well-defined vocabulary for
saying so — `unsupported(...)` — which would have made the JIT fall back to the interpreter
and produce the right answer slowly. Truncating instead converts an expressiveness limit
into a wrong answer.

> **Broken.** `emitRuntimeStubCall` (`src/optimizing/backends/wasm/codegen.ts:2247`) emits
> exactly eight `f64` operands, while `executeRuntimeStub`
> (`src/optimizing/backends/wasm/runtime-support.ts:600`) maps over the node's full input
> list, so `rawArgs[8]` and beyond are `undefined`. Nothing in `compileRejectionForNode`
> bounds the arity of a variadic stub node. **Measured:** a nine-argument call answers `45`
> under `--no-opt` and `28` under `--opt-threshold 1`, one run per fresh process; a
> seven-argument call answers `28` under both; and a nine-parameter function whose body is
> `return h` answers `8` and `0`. Cost to fix: one clause in
> `compileRejectionForNode` — `if (RUNTIME_STUB_NODES.has(node.type) &&
> node.inputs.length > 8) return unsupported(...)` — plus the regression test that does not
> exist. Cost to fix *properly*, so that wide calls still compile: spill the extra operands
> through linear memory, roughly thirty lines across the emitter and the import.

## staleHeapAccess

The bluntest analysis in the backend is eleven lines, and it is the reason object-heavy code is
slow.

```ts
    const heapAccessNodes: AnyNode[] = [];
    let reentersInterpreter = false;
    for (const block of graph.blocks) {
      for (const node of block.nodes) {
        if (HEAP_MEMORY_ACCESS_NODES.has(node.type)) heapAccessNodes.push(node);
        else if (HEAP_REENTRANT_STUB_NODES.has(node.type)) reentersInterpreter = true;
      }
    }
    const staleHeapAccess = new Set<number>(
      reentersInterpreter ? heapAccessNodes.map((node) => node.id) : [],
    );
```
— `src/optimizing/backends/wasm/codegen.ts:635-645`

`HEAP_MEMORY_ACCESS_NODES` is the seven opcodes that read or write an object in linear
memory. `HEAP_REENTRANT_STUB_NODES` is the thirty opcodes whose stub can end up back in the
interpreter — every generic operation, both polymorphic accessors, both megamorphic ones,
`IR_DISPATCH_MAP`, and all four call opcodes. There is no location in the test, no
dominance, no alias reasoning: if **any** node **anywhere** in the function can re-enter,
then **every** heap access in that function is marked stale, and `needsHeapRuntimeStub`
turns each one into a runtime stub call.

One call demotes the function's entire memory traffic.

That is a deliberate choice rather than a shortcut, and the alternative is unsound: there is
a program in the tree that proves it. `tests/e2e/optimizing/heap-reentry.test.ts` builds a
module-level array and a helper that writes into it:

```ts
          "cells: int[] = [0, 0, 0]",
          "count: int = 0",
          "fn put(index: int, value: int) -> void:",
          "  cells[index] = value",
          "fn shrink(whole: int) -> void:",
          "  i: int = 0",
          "  while i + whole < count:",
          "    put(i, cells[i + whole])",
          "    i += 1",
          "  count -= whole",
          "  i = count - 1",
          "  while i >= 0:",
          "    cells[i] = cells[i] + 1000",
          "    i -= 1",
```
— `tests/e2e/optimizing/heap-reentry.test.ts:12-25`

`shrink` reads `cells`, calls `put`, and reads `cells` again. `put` is a separate function;
its store lands in the real `JSArray` in the JavaScript heap. If `shrink`'s wasm code were
allowed to read its own copy of `cells` from linear memory after that call, it would read
the value from before the call, and the program would answer something other than `1009`.

`shrink` does tier up at default thresholds, and its trace is the cost model stated in four
lines:

```
$ node dist/cli.js --trace-opt reentry.tera
[JIT] Compiling "shrink": CFG built: 7 blocks, 20 frame states
[JIT] Compiling "shrink": Wasm module compiled: 3246 bytes, 7 blocks
[JIT] Compiling "shrink": Runtime stubs lowered: 12
```

Twelve stubs in a seven-block function whose heap traffic is three array reads and one array
write. Every one of them was demoted by a single call node, and the answer is `1009` under
`--no-opt` and `1009` under the JIT.

There is a paired flag. `mutatesHeapObjects` is computed as "some heap store exists that is
**not** in `staleHeapAccess`" (`codegen.ts:1364-1372`), so in the re-entrant case it is
`false`, and `commitTrackedObjects()` is skipped on the normal return path — the stubs
already wrote through to the JavaScript objects, and copying the stale linear-memory image
back over them would undo exactly the writes the stubs made. The two facts are one
mechanism seen from two ends.

Invariant, enforcement, test. The invariant: *a heap access compiled to a direct memory
operation must be unreachable from any operation that can mutate the same object behind the
compiler's back.* The enforcement: the eleven lines above, conservatively over the whole
function. The tests:
[t: tests/optimizing/backends/wasm/heap-reentry.test.ts > "reads and writes wasm memory directly when nothing can call out"]
asserts `stubbed(loadId)` and `stubbed(storeId)` are both `false` and `mutatesHeapObjects`
is `true`;
[t: tests/optimizing/backends/wasm/heap-reentry.test.ts > "goes through runtime stubs once a call can mutate the same object"]
adds a single `irGenericCall` to the identical graph and asserts all three flip. And
[t: tests/e2e/optimizing/heap-reentry.test.ts > "sees a store a callee made to a module-level array"]
is the program that breaks without it, run against the interpreter oracle at four tiering
configurations.

## What stays inside

The other half of the story is what compiled code is allowed to do *without* asking, because
a backend that stubbed everything would be a slow interpreter with extra steps. Three
mechanisms buy back the common cases, and each is gated.

**Inline numeric field store.** A store to `obj.f` can become a bare `f64.store` into linear
memory — no stub, no commit — but only under three conditions computed in
`codegen.ts:599-633`. The value being stored must have a numeric representation. The same
slot key, from `slotKeyFor(receiver, offset)`, must appear in `inlineNumericLoadSlots`,
meaning every load of that slot in this function is also numeric — if any load reads it as a
handle, the slot might hold something a double cannot represent. And if the key names a
*global* object rather than a local one — `slotKeyFor` returns `g:<name>:<mapId>:<offset>`
when the receiver is an `IR_LOAD_GLOBAL` under a map check — then additionally no
`GLOBAL_INLINE_HAZARDS` node may exist anywhere in the function, and the slot must never
appear in `stubLoadSlots`. `GLOBAL_INLINE_HAZARDS` is the twelve opcodes that could reassign
the global out from under the cached reference.

Three gates, and each has a test:
[t: tests/e2e/optimizing/inline-field-access.test.ts > "mutates a local object field in a loop (lowers to inline f64.store)"]
is the case that works;
[t: tests/e2e/optimizing/inline-field-access.test.ts > "does not treat a property-adding (transitioning) store as an inline in-bounds write"]
is a store that grows the object;
[t: tests/e2e/optimizing/inline-field-access.test.ts > "stays correct when the same global slot is also read as a handle (return q.c)"]
is the `stubLoadSlots` gate; and
[t: tests/e2e/optimizing/inline-field-access.test.ts > "stays correct with a call in the loop (hazard, no hoist)"]
is `GLOBAL_INLINE_HAZARDS`.

**Inline bump allocation.** When `hasInlineAlloc` is set, wasm allocates objects itself: it
reads the top-of-arena `i32` at address 0, checks it, bumps it and stores it back. The check
is `emitHeapLimitGuard` (`codegen.ts:2468-2495`), which compares `top + objSize` against
`memory.size × 65536` and, if short, grows by `ceil(objSize / 65536) + 1` pages inline —
`memory.grow` is a wasm instruction, so no import is needed. That is the same
`releaseObjPtr` word the JavaScript side writes, which is why `takeObjPtr` starts by
re-reading address 0: the wasm side may have moved the top since the last time JavaScript
looked.
[t: tests/e2e/optimizing/inline-field-access.test.ts > "survives a long chain of escaping allocations past a memory page"]
and
[t: tests/e2e/optimizing/inline-field-access.test.ts > "keeps escaping object fields exact across the growth boundary"]
are the pins on the growth path.

**Promoted global cells.** A global that only ever holds a number gets a mirror: an f64 slot
in the `globalCells` region, filled by `loadGlobalCells()` immediately before the wasm call
and written back by `storeGlobalCells()` immediately after (`codegen.ts:4626-4643`). Inside
the function, reads and writes of that global are `f64.load` / `f64.store` at a fixed
offset instead of `IR_LOAD_GLOBAL` stubs. The entry path pre-checks the assumption: if any
mirrored cell no longer holds a number, the wrapper deopts at offset 0 before marshalling
anything at all.
[t: tests/e2e/optimizing/inline-field-access.test.ts > "inlines a global numeric slot mutated and read only numerically"]
is the case; the negative case is
[t: tests/e2e/optimizing/inline-field-access.test.ts > "does not hoist when the global is reassigned in the loop (would read stale)"].

These three are why the reverted declines of
[Ch 54 § declines-that-were-reverted](54-deoptimizing-out-of-wasm-and-when-the.md) were
reverted. Three tiering declines built on the premise that object-mutating loops always pay
the marshalling cost stopped being true once the inline numeric store and the global-load
LICM fix landed, and the tree now carries a `describe` block whose only job is to assert
those declines do not fire.

> **Measured worse.** Three marshalling-shaped tiering declines were added, shipped, and
> reverted; `tests/e2e/optimizing/tiering-declines.test.ts:270-307` is a `describe` block
> named `"functions that should still tier up are not over-declined"` whose entire purpose
> is to assert that they no longer fire. The full account is in
> [Ch 54 § declines-that-were-reverted](54-deoptimizing-out-of-wasm-and-when-the.md); what
> this chapter needs from it is only that the copy cost was real enough, for a while, to
> make "refuse to compile it at all" look like the right answer.

## objPtrs is a GC root

The last thing the boundary owes is to the collector.

During an activation, `objPtrs` may be the only place a `TaggedValue` is reachable from. The
JavaScript variable that held it can be dead; the value survives as an integer in linear
memory; and the collector cannot follow an integer, because an integer in a byte array is
not a field. So the codegen registers a provider at module load:

```ts
registerExternalRootProvider((visit) => {
  const m = threadLocal.currentObjPtrs;
  if (!m) return;
  for (const info of m.values()) visit(info.value);
});
```
— `src/optimizing/backends/wasm/codegen.ts:177-181`

> **New idea. External GC root.** Most roots are found: the collector walks structures it
> knows about — frames, globals, the handle table — and discovers references. An *external*
> root is one the collector is **told** about by a component it has never heard of. The
> whole mechanism is `src/gc/external-roots.ts`, fifteen lines and one `Set`, called from
> three places in `src/gc/roots.ts` (`:152`, `:248`, `:316`). Note what it can and cannot
> do: a provider can say "this value is live", but it cannot be handed a *new* address for
> that value. A copying collector, which moves objects and rewrites the references to them,
> has nothing to rewrite here — the reference it would need to fix is an integer inside a
> `Uint8Array`. That is the same reason the native runtime cannot move objects either
> ([Ch 61 § nothing-moves](../part-09-ahead-of-time/61-the-arena-the-shadow-stack-and-why.md)),
> arrived at from the opposite direction.

[Ch 32 § case-the-jit-serialized-objects](../part-04-execution/32-what-is-a-root.md) tells
this case in full, including why `threadLocal.currentObjPtrs` is saved and restored around
each activation rather than set and cleared. One consequence of that design belongs here.

> **Unenforced.** The provider visits only `threadLocal.currentObjPtrs` — the innermost
> activation's map. During a nested wasm activation, the *outer* activation's `objPtrs` is
> not visited at all. Nothing checks that the outer map's values are rooted somewhere else;
> in practice they usually are, because they are typically also arguments, globals, or
> values held by the interpreter's own frames — but "usually" is the whole of the guarantee,
> and it is not stated anywhere or tested. Cost to fix: make the provider walk a stack of
> maps rather than one slot, which is a handful of lines but adds a push and a pop to a
> path taken on every optimized call.

And that is the cost model, complete. Per activation, a compiled function pays: a recursive
graph walk to copy its heap arguments in, bounded by an identity map and a depth guard; a
walk back to copy them out, restricted to slots whose kind cannot change; one call across
the boundary for every operation the backend could not compile; and, if any single one of
those operations can re-enter the interpreter, one more call for every heap access in the
function. Numeric code pays none of it. Object code pays most of it. Nothing in the four
chapters of Part VIII changes that arithmetic — the most any of them can do is make the
gates in § what-stays-inside open more often.

## What leaves

An `OptimizedCode` closure: a JavaScript function of `(args, thisValue, interpreter,
closureEnv)` that the interpreter installs in place of the bytecode and calls exactly as it
would call anything else. Inside it is one `runActivation` per call, and inside that is
everything this chapter described — the arena, `objPtrs` and `ptrByIdentity`, the runtime
object published to `threadLocal.currentRuntime`, `loadGlobalCells` before and
`storeGlobalCells` after, `commitTrackedObjects` on the way out. The closure also carries
`_dispose`, which drops the memory reference, and — only when the graph was compiled for
on-stack replacement — `_declinesEntry`.

Chapter 54 takes the same closure and asks the remaining question: what happens when, in the
middle of all this, a guard fails. The values are in wasm locals that no JavaScript API can
read, the arena is half full of copies, some of them written to, and the interpreter needs a
`RegisterFrame` it can resume. See
[Ch 54 § the-problem](54-deoptimizing-out-of-wasm-and-when-the.md).

## Verify it yourself

```bash
# The demotion rule, in isolation: one added call flips both flags.
npx vitest run --project unit tests/optimizing/backends/wasm/heap-reentry.test.ts

# The programs that break without the demotion, and the three inline gates.
npx vitest run --project e2e tests/e2e/optimizing/heap-reentry.test.ts tests/e2e/optimizing/inline-field-access.test.ts

# Stub count as a cost proxy: 28 stubs for a closure + map + float format.
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats-closure.tera 2>&1 | grep -i "wasm\|stub"

# stats.tera reaches wasm only through report; Series.mean is refused.
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera 2>&1 | grep -i "wasm\|stub"

# The eight-operand limit. These print 45 and 28.
node dist/cli.js --no-opt -e 'fn nine(a,b,c,d,e,f,g,h,i):
  return a+b+c+d+e+f+g+h+i
fn driver(n):
  t = 0
  k = 0
  while k < n:
    t = nine(1,2,3,4,5,6,7,8,9)
    k += 1
  return t
print(driver(50))'
node dist/cli.js --opt-threshold 1 -e 'fn nine(a,b,c,d,e,f,g,h,i):
  return a+b+c+d+e+f+g+h+i
fn driver(n):
  t = 0
  k = 0
  while k < n:
    t = nine(1,2,3,4,5,6,7,8,9)
    k += 1
  return t
print(driver(50))'
```

The last two print `45` and `28`. Replacing `nine` with a seven-parameter `seven` makes both
print `28`.

## Tests that pin this

- `tests/optimizing/backends/wasm/heap-reentry.test.ts` > `"reads and writes wasm memory directly when nothing can call out"` — direct memory access when no node can re-enter, and `mutatesHeapObjects` true.
- `tests/optimizing/backends/wasm/heap-reentry.test.ts` > `"goes through runtime stubs once a call can mutate the same object"` — one `irGenericCall` demotes every heap access and clears `mutatesHeapObjects`.
- `tests/e2e/optimizing/heap-reentry.test.ts` > `"sees a store a callee made to a module-level array"` — the program that answers wrong without the demotion.
- `tests/e2e/optimizing/heap-reentry.test.ts` > `"sees a store a callee made to an array it received as an argument"` — the same, through a parameter rather than a global.
- `tests/e2e/optimizing/heap-reentry.test.ts` > `"shows a callee the array stores the caller already made"` — the other direction: the caller's wasm writes must be visible to the interpreter.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"mutates a local object field in a loop (lowers to inline f64.store)"` — the inline numeric store fires.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"mutates multiple fields of the same object"` — several slot keys at once.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"does not treat a property-adding (transitioning) store as an inline in-bounds write"` — a store that changes the shape is not an in-bounds write.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"keeps a global-object field mutation loop correct (invariant global reference)"` — the global slot key.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"does not hoist when the global is reassigned in the loop (would read stale)"` — the mirrored-cell negative case.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"stays correct with a call in the loop (hazard, no hoist)"` — `GLOBAL_INLINE_HAZARDS`.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"inlines a global numeric slot mutated and read only numerically"` — the promoted cell.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"stays correct when the same global slot is also read as a handle (return q.c)"` — `stubLoadSlots`.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"stays correct when the mutating function also calls out (callee re-reads JS)"` — inline store plus re-entry.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"keeps local object numeric mutation correct (unchanged path)"` — the control.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"survives a long chain of escaping allocations past a memory page"` — `ensureMemory` growth.
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"keeps escaping object fields exact across the growth boundary"` — object contents across a `memory.grow`.
- `tests/e2e/optimizing/gc-roots.test.ts` > `"does not blow up exponentially on a diamond chain, and deopts past the depth guard"` — `ptrByIdentity` and `MAX_SERIALIZE_DEPTH`.
- `tests/e2e/optimizing/gc-roots.test.ts` > `"materializes a single object shared by many fields exactly once"` — identity preserved across the copy.
- `tests/optimizing/backends/wasm/math-intrinsics.test.ts` > `"inlines the wasm opcode when the operand is a raw double"` — representation decides instruction vs. stub.
- `tests/optimizing/backends/wasm/math-intrinsics.test.ts` > `"falls back to a runtime stub when the operand is a boxed handle"` — the same call, the other way.
- The eight-operand limit — **[unpinned]**, and that is the finding.
- `serializeObject` / `deserializeObject` as a unit, including the tag-preserving write-back — **[unpinned]**; covered only transitively by the `inline-field-access` and `heap-reentry` end-to-end differentials.
- The layout offsets agreeing between `emitNode` and `serializeObject` — **[unpinned]**; nothing asserts it.
