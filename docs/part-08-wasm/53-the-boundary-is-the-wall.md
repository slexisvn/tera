# 53. The boundary is the wall   ⟨ I · J ⟩

> **Status:** outline

**Thesis.** tera's heap lives in JavaScript objects and wasm can only see linear
memory, so every heap value crossing the boundary is copied in and copied back — and
that cost, per activation, is the entire performance story of object code.

**What arrived.** A wasm module from chapter 52, plus the `analyzeGraph` result that
built it: `nodeValueRep`, `runtimeStubTable`, `globalCellOffsets`, `memoryLayout`,
`needsMemory`, `mutatesHeapObjects`, `hasInlineAlloc`.

**What leaves.** An `OptimizedCode` closure — the JavaScript function the interpreter
actually calls in place of the bytecode. Everything in this chapter happens inside
one call to it.

**New ideas.** *Marshalling* / *serialization boundary*; *identity map* and why a
DAG copied without one is exponential; *tag* (as the runtime type bits a `TaggedValue`
carries); *re-entrancy* and *aliasing*; *bump allocation*; *GC root* — specifically an
*external* root, a live reference the collector cannot find on its own.

**Length.** 18 pages

## Anchors

- `src/optimizing/backends/wasm/codegen.ts` — `WasmCodegen.createWrapper` and the
  `runActivation` closure inside it: `objPtrs`, `ptrByIdentity`, `serializedThisPass`,
  `serializeDepth`, `takeObjPtr`, `releaseObjPtr`, `ensureMemory`, `allocateTagged`,
  `allocateTaggedImpl`, `commitTrackedObject`, `commitTrackedObjects`,
  `loadGlobalCells`, `storeGlobalCells`, `threadLocal.currentRuntime` (with
  `getTagged` / `syncTagged` / `allocateTagged`), `wasmCallDepth`,
  `MAX_WASM_CALL_DEPTH = 1000`, `MAX_SERIALIZE_DEPTH = 512`, `SerializeTooDeep`,
  `isInsideWasmExecution`. Plus `analyzeGraph`'s `staleHeapAccess` construction
  (lines 635-646), `needsHeapRuntimeStub`, the inline-store gates
  (`slotKeyFor`, `objRootFor`, `GLOBAL_INLINE_HAZARDS`, `inlineNumericLoadSlots`,
  `stubLoadSlots`, `globalInlineUnsafe`, `node._inlineNumericStore`),
  `emitRuntimeStubCall`, `emitHeapLimitGuard`, `emitGlobalCellAccess`, and the
  `IR_LOAD_FIELD` / `IR_STORE_FIELD` / `IR_LOAD_ELEMENT` / `IR_STORE_ELEMENT` /
  `IR_LOAD_ARRAY_LENGTH` cases in `emitNode`.
- `src/optimizing/backends/wasm/runtime-support.ts` — `serializeObject`,
  `deserializeObject`, `executeRuntimeStub`, `runtimeArg`, `runtimeReturn`,
  `runtimeTaggedReturn`, `getRuntimeIndex`, `setRuntimeIndex`, `setRuntimeProperty`,
  `callBuiltinMethod`, `callBuiltinGlobal`, `executeRuntimeCall`,
  `OVERLOAD_BY_NODE_TYPE`, `RuntimeInterpreterLike`.
- `src/optimizing/backends/wasm/graph-support.ts` — `RUNTIME_STUB_NODES`,
  `HEAP_REENTRANT_STUB_NODES`, `HEAP_MEMORY_ACCESS_NODES`, `HEAP_MEMORY_STORE_NODES`,
  `RuntimeStubTable` (`register`, `getById`, `getByNodeId`).
- `src/optimizing/backends/wasm/object-layout.ts` — `ELEMENTS_KIND_IDS`,
  `elementsKindId`, `elementsKindName`. Six kinds, ids 1-6, 0 meaning "unknown".
- `src/gc/external-roots.ts` — `registerExternalRootProvider`, `visitExternalRoots`
  (16 lines, one `Set` of providers), and its three call sites in `src/gc/roots.ts`
  (lines 152, 248, 316).
- `tests/optimizing/backends/wasm/heap-reentry.test.ts` — `analyzeTouching`, and the
  two assertions on `stubbed(loadId)` / `mutatesHeapObjects`.
- `tests/e2e/optimizing/inline-field-access.test.ts`,
  `tests/e2e/optimizing/heap-reentry.test.ts`, `tests/e2e/optimizing/gc-roots.test.ts`.

## Worked example

`shrink()` calling `put()`, which writes `cells[index]` in the real JavaScript array
— the program that proves the wasm copy is only valid while nothing else can touch
the original. Source: `tests/e2e/optimizing/heap-reentry.test.ts:8-42`, run here as a
file so the trace is readable:

```
cells: int[] = [0, 0, 0]
count: int = 0

fn put(index: int, value: int) -> void:
  cells[index] = value

fn shrink(whole: int) -> void:
  i: int = 0
  while i + whole < count:
    put(i, cells[i + whole])
    i += 1
  ...
```

— tests/e2e/optimizing/heap-reentry.test.ts:12-25 (12 of the 30 lines)

`shrink` tiers up and its trace reads:

```
[JIT] Compiling "shrink": CFG built: 7 blocks, 20 frame states
[JIT] Compiling "shrink": Wasm module compiled: 3246 bytes, 7 blocks
[JIT] Compiling "shrink": Runtime stubs lowered: 12
```

Twelve stubs in a seven-block function whose only heap operations are three array
reads and one array write. Every one of them was demoted by a single call node.
Answer: `1009` under `--no-opt` and `1009` under the JIT.

## Outline

- [ ] **§ two-heaps** — Establish the geometry before anything else. tera's heap is
      JavaScript: a `TaggedValue` is a number whose bits carry a tag, and `getPayload`
      hands back a `JSObject` or `JSArray` living in the V8 heap. Wasm linear memory is
      one `ArrayBuffer` of bytes with no pointers, no tags and no way to reach a JS
      object. **`> **New idea.** Marshalling** — when two runtimes cannot share
      representations, every value that crosses is *copied*, and the copy is a second
      object that can drift out of agreement with the first. This one paragraph is the
      chapter.
- [ ] **§ object-layout** — The byte layout, as a fixed-width table so a moved offset
      shows up in a diff:

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

      Then show where each number reappears in the emitted code, because that is the
      real invariant: `IR_LOAD_FIELD` emits `f64.load align=3 offset=8+offset*8`;
      `IR_LOAD_ARRAY_LENGTH` emits `i32.load align=2 offset=4`; `IR_LOAD_ELEMENT`
      emits `i32.const 16; i32.add; …; i32.const 8; i32.mul; i32.add; f64.load
      offset=0`. **`> **Unenforced.**` — `8` and `16` are literals in `emitNode` and
      literals again in `serializeObject`; nothing derives one from the other.**
- [ ] **§ every-slot-is-an-f64** — Consequence of the layout: a slot is eight bytes of
      double, whatever it held. `serializeObject` writes `toNumber(val)` for a number,
      `1`/`0` for a bool, and for an object, array, function, string, `null` or
      `undefined` it writes **the pointer, as a double**, by recursing through
      `allocateTaggedValue`. So wasm sees `15.7` and `4194304` in slots of the same
      width and cannot tell them apart. The distinction lives entirely in
      `analysis.nodeValueRep` — `REP_HANDLE` versus a numeric rep — decided at compile
      time. Land the stake: **the boundary is untyped, and the compiler's
      representation choice is the only thing that keeps it honest.** Forward-reference
      [Ch 48 § representation] and [Ch 54 § snapshot-refusal].
- [ ] **§ allocatetagged** — The copy-in function, in three moves.
      (a) *Identity memoization*: `ptrByIdentity: Map<HeapPayload, number>` — the same
      `JSObject` reached twice gets the same pointer. Without it, `{b: g1, c: g1}`
      copied recursively is `2^depth` work. **`> **New idea.** Identity map**, with the
      diamond picture.
      (b) *Per-pass cycle set*: `serializedThisPass: Set<HeapPayload>`, cleared when
      `serializeDepth` returns to zero. A cached pointer whose payload is already in the
      set is returned immediately without re-serializing — which is what stops a cycle,
      and also what makes a *second* top-level copy in the same activation re-read a
      mutated object.
      (c) *Depth guard*: `MAX_SERIALIZE_DEPTH = 512` throws `SerializeTooDeep`, caught
      by the argument-marshalling `try` and turned into `recordWasmDeopt(DEOPT_GUARD_FAILURE, 0)`
      plus `interpreter.resumeAt(new RegisterFrame(...))`. Establish the rule: **a
      would-be stack overflow becomes a deopt**, because a deopt is a defined outcome
      and a `RangeError` out of the middle of marshalling is not.
      `[t: tests/e2e/optimizing/gc-roots.test.ts > "does not blow up exponentially on a
      diamond chain, and deopts past the depth guard"]`
      `[t: tests/e2e/optimizing/gc-roots.test.ts > "materializes a single object shared
      by many fields exactly once"]`
- [ ] **§ arena-and-capacity** — Where the copies go. `takeObjPtr` / `releaseObjPtr`
      run a bump pointer from `analysis.memoryLayout.arenaBase`, `ensureMemory` grows
      the `WebAssembly.Memory` by `pagesToGrow(needed, currentSize)` and swallows a
      failed grow. Arrays are copied with slack — `capacity = Math.max(slots * 2, 4)` —
      so a `push` inside wasm has somewhere to go; objects get exactly `slots`. The
      outer `optimizedCode` wrapper restores `arenaTop` in a `finally`, which is what
      makes a nested activation's arena use disappear on return. Note that
      `info.serializedCount` lets a re-serialized array copy only its *new* tail.
- [ ] **§ copy-back** — `deserializeObject(payload, memory, ptr, maxSlots)` reads the
      f64 back out and writes it into the JS slot — **but only if the slot's current tag
      says it is safe.** Show the rule verbatim: the switch on `getTag(current)` handles
      `TAG_SMI` (integral f64 → `mkSmi`, otherwise `mkDouble`), `TAG_DOUBLE`
      (→ `mkDouble`), `"bool"` (→ `mkBool(numVal !== 0)`), **and nothing else**. A slot
      holding a string, an object or a function is left exactly as it was. Establish
      why: the f64 image of that slot is a *pointer into linear memory*; writing it back
      as a number would replace the string with the integer 4194304. This one `else`
      that is not written is the most load-bearing absence in the file.
      **`> **New idea.** Tag** — and the general rule this produces: *the copy-back is
      allowed to update a value, never to change its kind.*
- [ ] **§ runtime-stubs** — What compiled code does when it meets an operation it
      cannot perform. One import, `env.runtimeStub`, typed
      `(i32 stubId, i32 frameStateId, f64 a0…a7) -> f64`. `emitRuntimeStubCall` writes
      the deopt snapshot first (chapter 54), pushes the two ids, converts up to eight
      operands to f64, calls, and converts the f64 answer back. On the JS side
      `imports.env.runtimeStub` looks the node up in `RuntimeStubTable` and calls
      `executeRuntimeStub`.
- [ ] **§ the-list-is-the-lesson** — `RUNTIME_STUB_NODES` in `graph-support.ts:71-107`
      is ~40 opcodes long: every `IR_GENERIC_*`, `IR_LOAD_GLOBAL`, `IR_STORE_GLOBAL`,
      the context-slot pair, `IR_NEW_OBJECT`, `IR_NEW_ARRAY`, `IR_MAKE_CLOSURE`,
      `IR_NEW_REGEX`, `IR_TYPEOF`, `IR_NOT`, `IR_NEG`, `IR_UNBOX`, all three call
      opcodes, `IR_DISPATCH_MAP`, the megamorphic pair, `IR_FLOAT64_POW`. Print the
      whole set — its *length* is the argument. Then land it: the JIT compiles numbers.
      Everything else in a dynamic language is a call back into the interpreter with a
      different calling convention. Cross-reference [Ch 51 § lowering-to-tera-not-to-c]:
      the AOT compiler answers the same list by *lowering to tera source*; the JIT
      answers it by re-entering.
- [ ] **§ a-second-interpreter** — `executeRuntimeStub` is 590 lines of `switch (node.type)`
      in `runtime-support.ts`. Establish what it actually is: a second evaluator, over IR
      nodes instead of bytecode, sharing the runtime (`toPrimitiveOperand`,
      `applyBinaryOverload`, `getRuntimeProperty`, `callBuiltinMethod`) with the first
      one. Show the argument path — `node.inputs.map((input, i) => runtimeArg(rawArgs[i],
      input, analysis, runtime))` — where `runtimeArg` re-tags each raw f64 using the
      *input node's* representation, and `runtimeReturn` un-tags the answer using the
      *stub's* `outputRep`. This is the second place (after § every-slot-is-an-f64)
      where the representation table is the only type information in the system.
- [ ] **§ eight-operand-limit** — *Bugs are told as engineering.* Symptom: a call with
      nine arguments answers 45 in the interpreter and 28 under the JIT. Mechanism:
      `emitRuntimeStubCall` writes exactly `for (let i = 0; i < 8; i++)` operands, and
      an `IR_GENERIC_CALL` spends operand 0 on the callee, so seven arguments fit;
      `executeRuntimeStub` then maps over **all** of `node.inputs`, reading
      `rawArgs[8]` and beyond as `undefined`. Fix: not applied — `compileRejectionForNode`
      checks `FIXED_INPUT_COUNTS` for fixed-arity opcodes and has no arity bound at all
      for the variadic ones. Regression test: **none exists.** General rule: **an
      encoder with a fixed operand window needs a rejection, not a loop bound** — the
      `for` loop is where the refusal should have been.
      See § honesty-items; the reproducer is in § verify-it-yourself.
- [ ] **§ staleheapaccess** — The bluntest analysis in the backend, in six lines
      (`codegen.ts:635-646`): collect every `HEAP_MEMORY_ACCESS_NODES` node; set
      `reentersInterpreter` if *any* node anywhere in the function is in
      `HEAP_REENTRANT_STUB_NODES`; if so, put **every** heap access in
      `staleHeapAccess`, which `needsHeapRuntimeStub` then turns into a stub. One call
      demotes the whole function's memory traffic. Present it as a deliberate choice
      rather than a shortcut, then justify it with the two tests that make the blunt
      version *necessary*: the unit test shows the exact demotion, and the e2e test
      shows the program that breaks without it — `put()` writes `cells[index]` in the JS
      array while `shrink()`'s wasm copy sits in linear memory. Note the paired flag:
      `mutatesHeapObjects` is `false` in the re-entrant case, so `commitTrackedObjects`
      is skipped on return — the stubs already wrote through.
      `[t: tests/optimizing/backends/wasm/heap-reentry.test.ts > "reads and writes wasm
      memory directly when nothing can call out"]`
      `[t: tests/optimizing/backends/wasm/heap-reentry.test.ts > "goes through runtime
      stubs once a call can mutate the same object"]`
      `[t: tests/e2e/optimizing/heap-reentry.test.ts > "sees a store a callee made to a
      module-level array"]`
- [ ] **§ what-stays-inside** — The other half: what compiled code is allowed to do
      without asking. Three mechanisms, each with its gates.
      (a) **Inline numeric field store.** `node._inlineNumericStore` is set only when
      the stored value's rep is numeric, *and* the same `slotKeyFor(receiver, offset)`
      appears in `inlineNumericLoadSlots` (so the slot is only ever read numerically);
      and if the key is a global (`g:name:mapId:offset`), additionally only when no
      `GLOBAL_INLINE_HAZARDS` node exists anywhere in the function and the slot is never
      loaded as a handle. Three gates, and each one has a test.
      (b) **Inline bump allocation.** `hasInlineAlloc` — read the top-of-arena i32 at
      address 0, `emitHeapLimitGuard` compares against `memory.size * 65536` and grows
      by `ceil(size/65536) + 1` pages if short, then store the bumped top back.
      (c) **Promoted global cells.** `globalCellOffsets` mirrors a numeric global into
      an f64 slot; `loadGlobalCells` fills them before the call, `storeGlobalCells`
      writes them back after — and the entry path deopts before marshalling anything if
      a mirrored cell no longer holds a number.
      `[t: tests/e2e/optimizing/inline-field-access.test.ts > "mutates a local object
      field in a loop (lowers to inline f64.store)"]`
      `[t: tests/e2e/optimizing/inline-field-access.test.ts > "does not treat a
      property-adding (transitioning) store as an inline in-bounds write"]`
      `[t: tests/e2e/optimizing/inline-field-access.test.ts > "stays correct when the
      same global slot is also read as a handle (return q.c)"]`
      `[t: tests/e2e/optimizing/inline-field-access.test.ts > "survives a long chain of
      escaping allocations past a memory page"]`
- [ ] **§ objptrs-is-a-gc-root** — The last thing the boundary owes. During an
      activation, `objPtrs` may be the only place a `TaggedValue` is reachable from —
      the JS variable that held it can be dead, the value lives on as an integer in
      linear memory, and the collector cannot follow an integer. `codegen.ts:177`
      registers a provider with `registerExternalRootProvider` that visits every
      `info.value` in `threadLocal.currentObjPtrs`, and `src/gc/roots.ts` calls
      `visitExternalRoots` in three places. **`> **New idea.** External GC root** — a
      root the collector is *told about* rather than one it finds, and why a copying
      collector could not use this at all (cross-reference [Ch 71 § no-moving-collector]).
      Close on the cost model this whole chapter has been building: per activation, the
      JIT pays a graph walk in, a graph walk back, and a stub call per dynamic
      operation — which is why numeric code is fast here and object code is not.
      Hand over to chapter 54: what happens when, in the middle of all this, a guard
      fails.

## Honesty items

- `> **Broken.**` — `emitRuntimeStubCall`
  (`src/optimizing/backends/wasm/codegen.ts:2247`) emits exactly eight f64 operands
  (`for (let i = 0; i < 8; i++)`), while `executeRuntimeStub`
  (`src/optimizing/backends/wasm/runtime-support.ts:600`) maps over the node's *full*
  input list, so `rawArgs[8]` and beyond are `undefined`. Nothing in
  `compileRejectionForNode` bounds the arity of a variadic stub node. **Measured:** a
  nine-argument call answers `45` under `--no-opt` and `28` under `--opt-threshold 1`
  (the reproducer is in § verify-it-yourself). A seven-argument call agrees at `28`.
  Cost to fix: one rejection in `compileRejectionForNode` —
  `if (RUNTIME_STUB_NODES.has(node.type) && node.inputs.length > 8) return
  unsupported(...)` — plus the regression test that does not exist. Cost to fix
  *properly*: spill the extra operands through linear memory, ~30 lines across the
  emitter and the import.
- `> **Unenforced.**` — the object and array offsets are magic numbers in two files.
  `serializeObject` / `deserializeObject` compute `basePtr + (isJsArray ? 16 : 8) + i * 8`;
  `emitNode` independently writes `8 + offset * 8`, `i32.const 16`, `offset=4`. Nothing
  derives one from the other and nothing asserts they agree. A changed header size is a
  silent miscompile until an e2e differential catches it.
- `> **Unenforced.**` — `registerExternalRootProvider` visits only
  `threadLocal.currentObjPtrs`, a single global slot saved and restored around each
  activation. During a nested wasm activation, the *outer* activation's `objPtrs` is
  not visited. Nothing checks that the outer map's values are rooted elsewhere; in
  practice they usually are (arguments, globals, the interpreter's own frames), but
  "usually" is the whole of the guarantee. Cost: make the provider walk a stack of
  maps rather than one — a handful of lines, but it changes an allocation-hot path.
- `> **Unfinished.**` — `ensureMemory` (`codegen.ts:4436`) calls `memory.grow(...)`
  inside a `try { } catch (e) { }` with an empty body. A failed growth is silently
  ignored and the following `serializeObject` writes past the end of the buffer,
  where `DataView.setFloat64` throws a `RangeError` that nothing converts into a
  deopt. Cost to finish: turn the failure into the same `SerializeTooDeep` path
  § allocatetagged already has.
- `> **Measured worse.**` — three marshalling-based tiering declines were added,
  shipped, and then reverted. `tests/e2e/optimizing/tiering-declines.test.ts` now
  contains a `describe` block whose entire purpose is to assert that they do **not**
  fire. See [Ch 54 § declines-that-were-reverted] for the full story; this chapter
  only needs to note that the copy cost is real enough to have made "refuse to compile
  it at all" look like the right answer for a while.
- `> **Never runs.**` — `elementsKindName` in
  `src/optimizing/backends/wasm/object-layout.ts:25` is exported and imported by
  `graph-support.ts`, but the reverse mapping it provides is used only for reading a
  metadata string back; the ids it writes into the array header at `+8` are never read
  by any emitted wasm instruction. The elements-kind word is written on every array
  copy and consumed by nothing on the wasm side. **[unpinned]**

## Verify it yourself

```bash
npx vitest run --project unit tests/optimizing/backends/wasm/heap-reentry.test.ts
npx vitest run --project e2e tests/e2e/optimizing/heap-reentry.test.ts tests/e2e/optimizing/inline-field-access.test.ts
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats-closure.tera 2>&1 | grep -i "wasm\|stub"
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

The last two print `45` and `28`.

## Tests that pin this

- `tests/optimizing/backends/wasm/heap-reentry.test.ts` > `"reads and writes wasm memory directly when nothing can call out"`
- `tests/optimizing/backends/wasm/heap-reentry.test.ts` > `"goes through runtime stubs once a call can mutate the same object"`
- `tests/e2e/optimizing/heap-reentry.test.ts` > `"sees a store a callee made to a module-level array"`
- `tests/e2e/optimizing/heap-reentry.test.ts` > `"sees a store a callee made to an array it received as an argument"`
- `tests/e2e/optimizing/heap-reentry.test.ts` > `"shows a callee the array stores the caller already made"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"mutates a local object field in a loop (lowers to inline f64.store)"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"mutates multiple fields of the same object"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"does not treat a property-adding (transitioning) store as an inline in-bounds write"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"keeps a global-object field mutation loop correct (invariant global reference)"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"does not hoist when the global is reassigned in the loop (would read stale)"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"stays correct with a call in the loop (hazard, no hoist)"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"inlines a global numeric slot mutated and read only numerically"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"stays correct when the same global slot is also read as a handle (return q.c)"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"stays correct when the mutating function also calls out (callee re-reads JS)"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"keeps local object numeric mutation correct (unchanged path)"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"survives a long chain of escaping allocations past a memory page"`
- `tests/e2e/optimizing/inline-field-access.test.ts` > `"keeps escaping object fields exact across the growth boundary"`
- `tests/e2e/optimizing/gc-roots.test.ts` > `"does not blow up exponentially on a diamond chain, and deopts past the depth guard"`
- `tests/e2e/optimizing/gc-roots.test.ts` > `"materializes a single object shared by many fields exactly once"`
- `tests/optimizing/backends/wasm/math-intrinsics.test.ts` > `"inlines the wasm opcode when the operand is a raw double"`
- `tests/optimizing/backends/wasm/math-intrinsics.test.ts` > `"falls back to a runtime stub when the operand is a boxed handle"`
- The eight-operand limit — **[unpinned]**, and that is the finding.
- `serializeObject` / `deserializeObject` tag-preserving write-back — **[unpinned]**
  as a unit; covered only transitively by the `inline-field-access` and
  `heap-reentry` e2e differentials.
