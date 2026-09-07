# 52. Emitting WebAssembly by hand   ⟨ J ⟩

> **Status:** outline

**Thesis.** No toolchain, no library: LEB128 bytes, five sections, three imports —
and wasm has no `goto`, so the control-flow graph has to be rebuilt as nested scopes.

**What arrived.** A `CFGFunction` legalized for `wasmTarget` by chapter 51: every
node in `SUPPORTED_GRAPH_NODES`, every value stamped with a `_rep`, `frameState`
edges intact because `wasmTarget` has the `deopt` capability.

**What leaves.** A `Uint8Array` of wasm module bytes and a `WasmMemoryLayout`
describing the linear-memory regions the module assumes — handed to
`new WebAssembly.Module` / `new WebAssembly.Instance`, whose exported `opt` function
chapter 53 wraps.

**New ideas.** *LEB128* (variable-length integer encoding); *section* (as a wasm
module's top-level structure); *linear memory*; *structured control flow* and why a
stack machine cannot express an arbitrary CFG; *reverse postorder*; *label stack* and
*branch depth*; *post-dominator* and *lowest common post-dominator*;
*parallel copy* and the swap problem.

**Length.** 16 pages

## Anchors

- `src/optimizing/backends/wasm/wasm-format.ts` — `encodeU32`, `encodeS32`,
  `encodeS64`, `encodeF64`, `encodeString`; `WASM_MAGIC`, `WASM_VERSION`; the five
  section ids `SEC_TYPE=1`, `SEC_IMPORT=2`, `SEC_FUNCTION=3`, `SEC_EXPORT=7`,
  `SEC_CODE=10`; the `TYPE_*` and `OP_*` opcode table; `WasmModuleBuilder` with
  `addType`, `addFuncImport`, `addMemoryImport`, `addFunction`, `addExport`,
  `setCode`, `toBytes`; `DEOPT_SNAPSHOT_BASE = 8`,
  `DEOPT_SNAPSHOT_SLOT_BYTES = 8`, `WASM_PAGE_BYTES = 65536`.
- `src/optimizing/backends/wasm/memory-layout.ts` — `wasmMemoryLayout`,
  `WasmMemoryRegion`, `region`, `slotAddress`, `pagesToGrow`, `exceedsAddressSpace`;
  `GLOBAL_CELL_BYTES = 8`, `CONST_POINTER_BYTES = 64`,
  `WASM_MEMORY_MAX_PAGES = 256`.
- `src/optimizing/backends/wasm/structured-control-flow.ts` — `StructuredLabel`,
  `findLabelDepth`, `MergeResolver`, `buildMergeResolver`, and the file-local
  `computePostDominators` (Lengauer–Tarjan: `semi`, `vertex`, `ancestor`, `label`,
  `bucket`, `compress`, `evalNode`, `linkNode`).
- `src/optimizing/backends/wasm/graph-support.ts` — `computeBlockOrder`,
  `SUPPORTED_GRAPH_NODES`, `VALUE_PRODUCING`, `FIXED_INPUT_COUNTS`,
  `compileRejectionForNode`, `RuntimeStubTable`.
- `src/optimizing/backends/wasm/codegen.ts` — `WasmCodegen.compileRejection`,
  `canCompile`, `analyzeGraph` (locals: `nodeLocal`, `localAlias`,
  `additionalLocals`, `toInt32ScratchLocal`, `_allocTempLocal`,
  `phiUpdateTempLocal`), `generateBody` (`labelStack`, `emitted`, `emitPhiUpdates`,
  `emitBlockNodes`, `failEmit`), `emitNode`, `emitToInt32FromF64`,
  `emitCheckedInt64FromF64`, `compile`.
- `src/optimizing/backends/wasm/backend.ts` — `WasmBackend`, `loweringPipeline`,
  `jitCompile`, `legalize`.
- `src/optimizing/backends/wasm/target.ts` — `wasmTarget`.
- `tests/optimizing/backends/wasm/structured-control-flow.test.ts`,
  `memory-layout.test.ts`, `rejection.test.ts`.

## Worked example

`total_of` from `docs/example/stats-deopt.tera` — the same counted loop as
`Series.mean`, in free-function form so it is called two hundred times and actually
reaches wasm. The optimizer builds it as four blocks; the encoder rebuilds those
four blocks as a `block` containing a `loop` with a `br_if` back edge.

```bash
node dist/cli.js --print-ir --filter total_of --opt-threshold 1 docs/example/stats-deopt.tera
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats-deopt.tera 2>&1 | grep -i wasm
```

The trace line the chapter builds toward, taken verbatim from that run:

```
[JIT] Compiling "total_of": CFG built: 4 blocks, 2 frame states
[JIT] Compiling "total_of": Wasm module compiled: 1159 bytes, 4 blocks
[JIT] Compiling "total_of": Runtime stubs lowered: 6
```

`Series.mean` in `docs/example/stats.tera` has the identical shape but runs only
twice, so the trace shows `Wasm compilation skipped — cooldown` instead. Say this
once, in the chapter opener.

## Outline

- [ ] **§ no-toolchain** — Establish the constraint the whole chapter follows from:
      there is no `wabt`, no `binaryen`, no dependency. `wasm-format.ts` is 310 lines
      and produces the module byte by byte. `WasmModuleBuilder` holds six arrays and a
      nullable memory import; `toBytes()` is one function that walks them in section
      order. **`> **New idea.** LEB128** — why a byte-oriented format encodes integers
      seven bits at a time with a continuation bit, and why `encodeS32` needs the sign
      dance around `byte & 0x40` that `encodeU32` does not.
- [ ] **§ five-sections** — Walk `toBytes()`: magic, version, then Type (1), Import
      (2), Function (3), Export (7), Code (10) — each emitted only if non-empty, each
      length-prefixed. **`> **New idea.** Section.** Then land the omission: there is
      no Data section and no Memory section. The module *imports* its memory
      (`addMemoryImport("env", "memory")`) and can therefore not initialise a single
      byte of it.
- [ ] **§ constants-arrive-as-pointers** — The direct consequence of the missing Data
      section. A string, a `null`, a closure constant, a compiled-function constant —
      none can be written into the module. Instead `analyzeGraph` assigns each
      non-primitive constant a slot in the `constPointers` region via
      `slotAddress(memoryLayout.constPointers, index)`, stores that integer in
      `constNode._constPtrIndex`, and `generateBody` emits `i32.const <ptr>;
      local.set`. The *value* is put there from JavaScript, by the wrapper's
      `analysis._nonPrimitiveConstants` loop. Establish the shape: **wasm sees an
      integer; JavaScript knows what it means.** Forward-reference [Ch 53 § objptrs].
- [ ] **§ the-memory-map** — `wasmMemoryLayout(counts)` stacks three fixed regions
      from address 8 upward with no gaps, then `arenaBase` is whatever is left.
      Fixed-width ASCII table (per convention, not a diagram):

      ```
      offset  size          region             stride  written by
      ------  ------------  -----------------  ------  ---------------------------
      0       4             inline alloc top   -       wasm (bump) / JS (release)
      8       8 * n         deoptSnapshot      8       wasm f64.store, JS reads
      +       8 * g         globalCells        8       JS loadGlobalCells, wasm r/w
      +       64 * c        constPointers      64      JS wrapper, wasm reads
      +       ...           arena              -       objects copied in by JS
      ```

      `DEOPT_SNAPSHOT_BASE = 8` is why the region starts at 8 and not 0 — address 0 is
      the inline-allocation bump pointer. Cite `exceedsAddressSpace` as the refusal
      when the fixed regions alone need more than 256 pages.
      `[t: tests/optimizing/backends/wasm/memory-layout.test.ts > "stacks every region
      above the deopt snapshot without gaps"]`
      `[t: tests/optimizing/backends/wasm/memory-layout.test.ts > "keeps the arena clear
      of the fixed regions no matter how many entries they hold"]`
- [ ] **§ three-imports** — Every import, its exact type, and why it exists. All are
      declared conditionally from `analysis.needs*` flags, and `importFuncCount` is
      what the exported function's index is computed from
      (`builder.addExport("opt", importFuncCount)`).

      | import | type | declared when | chapter |
      | --- | --- | --- | --- |
      | `env.deopt` | `(i32, i32) -> ()` | `needsDeoptImport` | 54 |
      | `env.runtimeStub` | `(i32, i32, f64×8) -> f64` | `needsRuntimeStubImport` | 53 |
      | `env.allocObj` | `(i32) -> i32` | `needsAllocObjImport` | 53 |
      | `env.memory` | memory | `needsMemory` | 53 |

      Establish the reading: **the three function imports are the three ways compiled
      code admits it cannot finish the job alone** — bail out, ask the interpreter, ask
      for an object.
- [ ] **§ locals** — `analyzeGraph`'s second job after typing: give every value a wasm
      local. `nodeLocal` maps node id → local index; `localAlias` lets a pass-through
      node (a check, a box) share its input's local instead of copying; parameters take
      the first `paramTypes.length` indices; then `additionalLocals` declares the rest
      by type in runs. Name the four special locals and what each is for:
      `toInt32ScratchLocal` (§ tointeger), `_allocTempLocal` (bump allocation),
      `phiUpdateTempLocal` (§ parallel-copy), and the i64 scratch pushed when
      `emitCheckedInt64FromF64` is reachable. **`> **New idea.** Register allocation is
      not needed here** — wasm locals are unlimited, so this is naming, not allocation;
      contrast forward to [Ch 65 § linear-scan].
- [ ] **§ no-goto** — The central problem. State it plainly: a CFG has arbitrary edges;
      wasm has `block`, `loop`, `if` and `br <depth>`, where depth counts *outward
      through enclosing scopes*, and a `br` can only leave a scope, never enter one.
      **`> **New idea.** Structured control flow** — with the standard picture: `br` to
      a `block` label jumps to its *end*, `br` to a `loop` label jumps to its *start*.
      Mermaid fence showing `total_of`'s four blocks (B0 pre-header, B3 loop header,
      B2 body, B1 exit) beside the nesting that must reproduce them.
- [ ] **§ order-and-labels** — `computeBlockOrder(graph)` is a post-order DFS from
      `graph.entry` with an unvisited sweep afterwards, then `order.reverse()` —
      reverse postorder. **`> **New idea.** Reverse postorder** — every block appears
      after at least one predecessor except loop headers, which is exactly the property
      a linear emission needs. Then `labelStack: StructuredLabel[]` (`{type, targetId}`)
      is pushed as scopes open, and `findLabelDepth(labelStack, type, targetId)` walks
      it *backwards* returning `labelStack.length - 1 - i` — the br depth — or `-1`.
      Show the whole function; it is 12 lines and it is the hinge of the chapter.
      `[t: tests/optimizing/backends/wasm/structured-control-flow.test.ts > "counts
      depth from the innermost label outwards"]`
      `[t: tests/optimizing/backends/wasm/structured-control-flow.test.ts > "reports a
      missing label rather than guessing a depth"]`
      `[t: tests/optimizing/backends/wasm/structured-control-flow.test.ts > "matches the
      innermost label when a target repeats"]`
- [ ] **§ loop-versus-block** — In `emitBlockNodes`, a jump is resolved in a fixed
      order: if the target is a loop header and a `"loop"` label for it is on the stack,
      emit phi updates then `br` to that depth (a back edge); otherwise look for a
      `"block"` label (a forward edge); otherwise `failEmit`. Establish that
      `loopInfoMap` (built from `forest.loops()`, carrying `loopBlocks` and
      `exitBlockIds` sorted by `orderIndex`) is what tells the emitter where a loop's
      scope must close. Note the `order.length === 1` fast path: a single-block function
      emits its nodes straight out with no scopes at all — which is what `report` and
      `label` in `stats.tera` actually hit.
- [ ] **§ finding-the-merge** — A branch's two arms have to rejoin *inside* a scope, and
      the emitter has to know where before it can open one. `buildMergeResolver(order,
      orderIndex)` answers `find(trueBlockId, falseBlockId)`. Explain the construction:
      reverse the CFG (predecessor lists become successor lists), add a synthetic exit
      node at index `blockCount` with an edge to every terminator block, run
      Lengauer–Tarjan from it, then the merge is the lowest common ancestor in the
      resulting immediate-post-dominator tree. **`> **New idea.** Post-dominator** —
      "every path from here to the end goes through there", the mirror of the dominance
      chapter 42 established, computed by reversing the graph. Then the three rejections
      that make the answer *usable* rather than merely correct: the merge may not be one
      of the arms, may not be the synthetic exit, and must sit later in emission order
      than both arms.
      `[t: tests/optimizing/backends/wasm/structured-control-flow.test.ts > "finds the
      join point of a diamond"]`
      `[t: tests/optimizing/backends/wasm/structured-control-flow.test.ts > "refuses a
      merge that is one of the arms itself"]`
      `[t: tests/optimizing/backends/wasm/structured-control-flow.test.ts > "refuses arms
      that never rejoin"]`
- [ ] **§ parallel-copy** — A phi is not an instruction; it is an assignment that
      happens *on the edge*. `emitPhiUpdates(targetBlockId, predecessor)` finds the
      predecessor's index in `targetBlock.predecessors`, collects one `pending` entry
      per phi, and then emits **two loops**: every input is read into its
      `phiUpdateTempLocal`, and only then is every temp written to its phi local.
      **`> **New idea.** Parallel copy** — why `a, b = b, a` cannot be emitted as two
      sequential assignments, and why a temp per phi is the blunt-but-total answer
      (rather than a cycle-breaking algorithm that would need a temp only sometimes).
      Note the representation fix-ups folded into the same loop: `f64.convert_i32_s`
      when the phi is f64 and the input i32, and a full `emitToInt32FromF64` the other
      way.
- [ ] **§ what-is-refused** — *Why the obvious design fails*, in the form the code
      actually takes: rather than a general relooper, `compileRejection` refuses two
      shapes outright and the JIT falls back to baseline.
      (a) `forest.irreducible` → `unsupported("irreducible control flow")` — a loop with
      two entries has no single `loop` scope to be.
      (b) a block with more than two predecessors, any of which ends in `IR_BRANCH` →
      `unsupported("short-circuit edge into multi-way merge")` — `a && b || c` produces
      exactly this, and `buildMergeResolver`'s two-argument `find` cannot describe it.
      Establish the general rule: **a code generator is allowed to have a domain, as
      long as saying "no" is cheap and total.** Then list the rest of
      `compileRejection`'s refusals (phi input representation mismatch, inconsistent
      mono/poly shape speculation, `holdsTheReceiver`, missing return) as the same move.
      `[t: tests/optimizing/backends/wasm/rejection.test.ts > "reports an opcode the
      backend cannot emit as unsupported"]`
      `[t: tests/optimizing/backends/wasm/rejection.test.ts > "reports a missing return
      as a malformed graph, not an unsupported one"]`
- [ ] **§ tointeger** — The close. `emitToInt32FromF64` is thirty-odd `bytes.push`
      calls where a compiler with a trapping conversion would emit one opcode. Walk it:
      `local.tee` into the scratch; test `x == x` (NaN) and `|x| != Infinity`; if either
      fails answer 0; otherwise, if `|x| >= 2^63`, reduce modulo 2^32 by hand
      (`trunc`, `/ 2^32`, `trunc`, `* 2^32`, `sub`) so the following
      `i64.trunc_sat_f64_s` cannot saturate; then `i32.wrap_i64`. Land the reason: wasm
      has `i32.trunc_f64_s`, and it **traps**. A trap inside JIT-compiled code cannot be
      caught and resumed — there is no frame state at the trap, only a
      `RuntimeError` — so the encoder pays thirty instructions to guarantee an answer.
      Contrast `emitCheckedInt64FromF64`, which is the *other* choice: it checks the
      same range and, when it fails, calls `env.deopt` with a real snapshot. Establish
      the rule this book will use again: **a wrong-but-total answer is a silent
      miscompile; a slow-but-total answer is a design.** Hand over to chapter 53, which
      is about everything the emitted code cannot do by itself.

## Honesty items

- `> **Broken.**` — `WasmModuleBuilder.toBytes` in
  `src/optimizing/backends/wasm/wasm-format.ts:264` encodes the imported memory as
  `IMPORT_MEMORY, 0x00, ...encodeU32(1)`: flags byte 0 (no maximum) and a hardcoded
  minimum of **1 page**, regardless of `wasmMemoryLayout(...).initialPages`. The
  module therefore under-declares what it needs. It happens to work because
  `codegen.ts:4093` hands the instance a `WebAssembly.Memory` whose `initial` *is*
  `analysis.memoryLayout.initialPages` — so the declared minimum is satisfied by
  accident of the host always over-supplying. A module built here and instantiated
  against a 1-page memory would fault on its first `constPointers` access with no
  diagnostic. Cost to fix: two lines in `toBytes` plus threading the layout into the
  builder; `exceedsAddressSpace` already computes the number.
- `> **Unenforced.**` — nothing checks that the memory `WasmCodegen.compile` creates
  and the memory `wasmMemoryLayout` describes agree. `exceedsAddressSpace` is the only
  guard and it is a *ceiling* test (`initialPages > 256`), not an equality test
  against the declared import.
- `> **Unfinished.**` — `encodeS64` in `wasm-format.ts:29` converts through `BigInt`
  on every 7-bit group (`Number(BigInt(n) & 0x7fn)`) and is the only encoder written
  that way. `OP_I64_*` opcodes are declared and the i64 path is reached from
  `emitCheckedInt64FromF64`, but no caller passes a value outside the double-safe
  range, so the BigInt round-trip has never had to be right for a true 64-bit constant.
  **[unpinned]** — no test in `tests/optimizing/backends/wasm/` covers `encodeS64`.
- `> **Never runs.**` — `OP_SELECT`, `OP_NOP`, `OP_I64_LOAD`, `OP_I64_STORE`,
  `OP_F64_NEAREST` and several other constants in `wasm-format.ts` are exported and
  never referenced by `codegen.ts`. Carried in the opcode table for completeness; the
  chapter should say so once rather than leaving the reader to assume they are live.
  (See [Ch 51 § honesty-items] for the one — `OP_SELECT` — where the absence is a
  functional hole rather than an unused constant.)
- `> **Unenforced.**` — `computeBlockOrder` and `computePostDominators` are both
  recursive (`dfs`, `compress`, `depthOf`). Nothing bounds the recursion against the
  JS stack, and `MAX_WASM_CALL_DEPTH = 1000` in `codegen.ts` guards a completely
  different thing (wasm activation nesting, not compile-time graph depth). A graph
  deeper than the host stack throws a `RangeError` out of `analyzeGraph` rather than
  producing a `CompileRejection`. **[unpinned]**

## Verify it yourself

```bash
node dist/cli.js --print-ir --filter total_of --opt-threshold 1 docs/example/stats-deopt.tera
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats-deopt.tera 2>&1 | grep -i "wasm\|CFG built"
node dist/cli.js --trace --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera 2>&1 | grep -i "wasm\|cooldown"
npx vitest run --project unit tests/optimizing/backends/wasm/structured-control-flow.test.ts
npx vitest run --project unit tests/optimizing/backends/wasm/memory-layout.test.ts tests/optimizing/backends/wasm/rejection.test.ts
```

## Tests that pin this

- `tests/optimizing/backends/wasm/structured-control-flow.test.ts` > `"counts depth from the innermost label outwards"`
- `tests/optimizing/backends/wasm/structured-control-flow.test.ts` > `"reports a missing label rather than guessing a depth"`
- `tests/optimizing/backends/wasm/structured-control-flow.test.ts` > `"matches the innermost label when a target repeats"`
- `tests/optimizing/backends/wasm/structured-control-flow.test.ts` > `"finds the join point of a diamond"`
- `tests/optimizing/backends/wasm/structured-control-flow.test.ts` > `"refuses a merge that is one of the arms itself"`
- `tests/optimizing/backends/wasm/structured-control-flow.test.ts` > `"refuses arms that never rejoin"`
- `tests/optimizing/backends/wasm/structured-control-flow.test.ts` > `"reports nothing for blocks outside the emitted order"`
- `tests/optimizing/backends/wasm/memory-layout.test.ts` > `"stacks every region above the deopt snapshot without gaps"`
- `tests/optimizing/backends/wasm/memory-layout.test.ts` > `"keeps the arena clear of the fixed regions no matter how many entries they hold"`
- `tests/optimizing/backends/wasm/memory-layout.test.ts` > `"reserves enough initial pages to hold the fixed regions"`
- `tests/optimizing/backends/wasm/memory-layout.test.ts` > `"always reserves at least one page for an empty program"`
- `tests/optimizing/backends/wasm/memory-layout.test.ts` > `"refuses a layout whose fixed regions overflow the maximum memory"`
- `tests/optimizing/backends/wasm/memory-layout.test.ts` > `"addresses each slot inside its own region"`
- `tests/optimizing/backends/wasm/memory-layout.test.ts` > `"rejects a slot index past the end of its region instead of writing into the next one"`
- `tests/optimizing/backends/wasm/memory-layout.test.ts` > `"grows by whole pages covering the shortfall"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"accepts a graph the backend can lower"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"reports a missing return as a malformed graph, not an unsupported one"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"reports a wrong input count as malformed"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"reports an opcode the backend cannot emit as unsupported"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"separates a supported-but-unprofitable shape from a malformed one"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"declines a function whose answer is the receiver"`
- `tests/optimizing/backends/wasm/rejection.test.ts` > `"keeps compiling a function that only mentions the receiver"`
- `tests/optimizing/backends/wasm/result-abi.test.ts` > `"answers a raw number when the return is a raw number, whatever the graph declares"`
- `tests/optimizing/backends/wasm/result-abi.test.ts` > `"answers a handle when the return really is one"`
- `tests/optimizing/pipeline-order.test.ts` > `"gives every surviving node a representation once wasm lowering finishes"`
- Irreducible control flow — **[unpinned]**. `compileRejection` returns
  `unsupported("irreducible control flow")` on `forest.irreducible` and
  `generateBody` calls `failEmit` on the same condition, but no test in
  `tests/optimizing/backends/wasm/rejection.test.ts` constructs an irreducible graph.
- `encodeU32` / `encodeS32` / `encodeF64` / `encodeString` — **[unpinned]**. The
  encoders have no direct unit test; they are covered only through whole-module
  instantiation in the e2e suites.
