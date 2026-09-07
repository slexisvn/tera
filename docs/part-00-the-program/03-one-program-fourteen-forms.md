# 3. One program, fourteen forms   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** The book in one chapter: one line of `stats.tera` shown in every
representation the engine produces, each captioned with the chapter that explains it, so a
reader who opens the book anywhere knows where they are.

**What arrived.** From `[Ch 2 § what-leaves]`: a reader who can read tera, the 24 lines of
`docs/example/stats.tera`, and the eight-file example set.

**What leaves.** A map. Every later part is one arrow on it. Specifically: the names
`token`, `AST`, `semantic AST`, `bytecode`, `feedback vector`, `SSA`, `phi`, `legalization`,
`MachineIR`, `relocation` — each attached to a picture the reader has now seen — and the
fork drawn once, showing where the JIT road and the AOT road share a graph and where they
part.

**New ideas.** *Intermediate representation* (why a compiler has more than one form of the
program at all). *Basic block* and *control-flow graph* (`B0`…`B3` in the `--print-ir`
dump). *SSA and the phi node* (`v3 = Phi v0, v13` is a value that is one thing on entry and
another on the back edge). *Legalization* (the same graph rewritten until a specific target
can emit every operation in it). Each gets a `> **New idea.**` box at the form where it
first appears, not before.

## Anchors

- `src/cli/main.ts` — the dumps and how they are wired.
  `buildEngineOptions(config)` attaches `--print-bytecode` to `EngineOptions.onCompile`
  (so a function that is never compiled prints nothing) and `--print-ir` to
  `EngineOptions.onOptimize` (so a function that never reaches the JIT prints nothing) —
  both filtered by `matchesFilter(config.filter, fn.name)`. `--print-ast` is printed in
  `runModuleEntry` / `runProgram` by `printAst`, before anything runs. `buildTiering`
  turns `--no-opt` / `--always-opt` / `--opt-threshold` into a `TieringThresholds` patch.
  `dispatch` routes `compile` into `./compile.js` by dynamic import.
- `src/frontend/ast-text.ts` — `printAst`. `inlineScalars` prints every non-branch property
  of a node, which is why `_returnType` appears in the dump and `_paramInfo` (an array)
  does not print as a scalar.
- `src/frontend/checker/semantic-ast.ts` — the second tree. `SemanticNode` is a union of
  exactly thirteen kinds: `TypeAlias`, `Interface`, `Function`, `Model`, `Class`, `Block`,
  `Jump`, `For`, `Var`, `Destructure`, `Return`, `Expr`, `Import`. `BlockNode.testRole`
  distinguishes a guard from a loop; `branchChain`, `alwaysExits` and `ownExpressions` are
  the walkers every checker analysis shares.
- `src/frontend/ast/index.ts` — `adoptContextualSignature(node, positionalTypes, returns)`,
  the checker's write-back onto the parser's tree. It fills `_paramInfo` and `_returnType`
  only where the parser left them unwritten (`isUnwrittenType`), so the two producers do
  not fight. `declaredParamInfo` is the reader.
- `src/bytecode/register/ops/bytecode.ts` — 664 lines. The opcode constants
  `ROP_LDA_CONST = 0x01` through `ROP_CALL_INTRINSIC = 0x92`, the `ROPCODE_NAMES` table
  that turns them back into text, `class RegisterInstruction`,
  `class RegisterCompiledFunction` and its `disassemble()`, which is what `--print-bytecode`
  prints. `BaselineCode`, `OptimizedCode`, `OsrEntry` and `SourceMapEntry` are the slots a
  function grows as it tiers up.
- `src/feedback/vector/index.ts` — `class FeedbackVector`, `class FeedbackSlot`, the six
  `FEEDBACK_*` kinds (`property`, `binary_op`, `unary_op`, `call`, `allocation`, `branch`)
  and the four `IC_*` states (`uninitialized`, `monomorphic`, `polymorphic`, `megamorphic`).
  `INVOCATION_COUNT_FOR_OPTIMIZATION = 3000` and `DEFAULT_LOOP_BUDGET = 1000` are the two
  budgets a hot function is measured against.
- `src/optimizing/baseline/compiler.ts` — `class BaselineCompiler`. `generateBody` returns
  a JavaScript *string*; `compile` hands it to `new Function("args", "tv", "$", "pc", "env", body)`
  and wraps the result with `_call0`…`_call3` fast entries. It returns `null` — declining —
  for an empty body, for more than `MAX_BASELINE_INSTRUCTIONS`, for `ROP_TRY_START` /
  `ROP_TRY_END` / `ROP_THROW`, and for five spread/rest/accessor opcodes.
- `src/optimizing/optimizer.ts` — `class Optimizer`. `compile()` is the speculative
  (JIT) door and requires a `feedbackVector`; `compileStatic()` is the AOT door and passes
  `staticCompilerOptions`, which sets `sinkAllocations: false, deoptimizes: false`. Both
  funnel into the private `build()`: `buildIR`, `rebuildUses`, `eliminateUnreachableBlocks`,
  optional OSR transform, `buildFrameStateIndex`, `runMiddleEnd`, `validateOptimizedGraph`.
  This one method is the fork.
- `src/optimizing/pipeline.ts` — `middleEndPhases(options)` returns three phases —
  `high-level-optimization`, `canonicalization`, `late-optimization` — holding **34**
  `step(...)` passes, from `parameter-type-guards` to
  `dead-code-elimination-after-unreachable`. `maintainGraph` is the invariant repair run
  between them.
- `src/optimizing/target/legalization.ts` — `targetLegalizationPipeline(...)`, everything
  *after* the fork, plus the standalone `representation-selection` and
  `representation-check` steps. Measured: `--print-after-all` on the AOT road prints 72
  distinct pass names in all, so 38 of them belong to this file rather than to the shared
  middle end. `callee-returns`, `string-boxing`, `if-conversion`, `operation-legalization`
  and `capability-check` are the ones later chapters return to.
- `src/optimizing/ir/text.ts` — `printIR(graph)` and `parseIR(text)`. `GRAPH_FIELDS` is
  the list of graph-level attributes that survive the round trip; `OpaqueValue` is what a
  property the text form cannot represent becomes, keeping its type name.
- `src/optimizing/machine/print.ts` and `src/optimizing/machine/trace.ts` —
  `printMachineFunction(fn)` and `formatMachineTrace(record)`, driven by
  `CompilerOptions.machineTracer`.
- `src/optimizing/backends/x64/assembly.ts` — `class X64AssemblyWriter`. `functionText`
  emits `.p2align`, `.globl`, the label, CFI brackets from `annotateCfi`, and per-instruction
  `.loc` lines from `annotateLines`. `operandText` is AT&T syntax; `registerText` throws
  `"virtual register survived to assembly emission"` — the last verifier before bytes.
- `src/cli/compile.ts` — `runCompile(config)`. `resolveBackend`, `choosePlatform`,
  `usesToolchain`, `writeDirect` (x64 writes an executable itself) versus
  `linkWithCompiler` (C and riscv64 go through `cc`), `warnSkipped` / `noteLeftOut` for
  declined functions, and `selectEntry` / `mainSource` for the entry shim.

## Worked example

One line, fourteen times:

```
      total += this.values[i]
```
— `docs/example/stats.tera:10`, the loop body of `Series.mean()`

Each page is one form, captioned with the chapter that explains it. The commands that
produce each are in *Verify it yourself*; three of the fourteen have no CLI command and the
chapter says so on the page rather than in a footnote.

| # | Form | Produced by | Explained in |
| --- | --- | --- | --- |
| 1 | source text | `cat` | Ch 2 |
| 2 | token stream, with manufactured `Indent` / `Dedent` / `Newline` | *(no CLI flag)* | Ch 4, 5 |
| 3 | AST | `--print-ast` | Ch 6, 7 |
| 4 | semantic AST, thirteen kinds | *(no CLI flag)* | Ch 8 |
| 5 | AST with `_paramInfo` / `_returnType` written back | *(no CLI flag)* | Ch 9, 11 |
| 6 | register bytecode | `--print-bytecode` | Ch 17, 18 |
| 7 | feedback vector | `--trace-feedback` | Ch 33, 34 |
| 8 | generated baseline JavaScript | *(no CLI flag)* | Ch 36 |
| 9 | SSA control-flow graph, as built | `--print-ir` | Ch 38, 39 |
| 10 | the same graph after the 34 middle-end passes | `--print-after-all` | Ch 41–50 |
| 11 | legalized for wasm, and the wasm bytes | `--trace-opt` | Ch 51, 52 |
| 12 | legalized for x64, as MachineIR | *(no CLI flag)* | Ch 64, 66 |
| 13 | x64 assembly text | `compile --emit source --target x64` | Ch 69 |
| 14 | bytes inside an ELF or PE executable | `compile --target x64 --platform linux` | Ch 70, 71 |

Two of these are worth quoting now, because they are what the rest of the book is about.

Form 9, the loop as a control-flow graph — note `B3`, the loop header, and the two `Phi`
nodes that make `total` and `i` single-assignment:

```
  B2 succs=B3 preds=B3:
    v11 = GenericGetProp v10 [propName="values"] !fs
    v12 = GenericGetIndex v11, v4 !fs
    v13 = GenericAdd v3, v12
    v15 = Float64Add v4, v14
    v22 = Jump [targetBlock=3]
  B3 loop-header succs=B2,B1 preds=B0,B2:
    v3 = Phi v0, v13 [index=0]
    v4 = Phi v1, v15 [index=1]
    v6 = GenericGetProp v5 [propName="values"] !fs
    v7 = GenericGetProp v6 [propName="length"] !fs
    v8 = GenericCompare v4, v7 [op="<"]
    v9 = Branch v8 [trueBlock=2, falseBlock=1]
```
— output of `node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 --filter mean docs/example/stats.tera`

Form 13, the same loop as x64 — one `.loc 1 10 7` pointing back at source line 10:

```
.LSeries_mean_4:
	.loc 1 11 7
	movl $1, %eax
	cvtsi2sdl %eax, %xmm0
	movq 16(%rsi), %rax
	movq 32(%rsp), %rcx
	movq %rax, 32(%rcx)
	.loc 1 10 7
	movslq %r13d, %rcx
```
— `stats.s` from `compile --emit source --target x64`, function `Series_mean`

## Outline

- [ ] **§ why-more-than-one-form** — `> **New idea.**` intermediate representation.
      Establish the argument from the code, not from a textbook: the same `Series.mean()`
      must be interpretable one bytecode at a time, compilable to JavaScript in a single
      pass, optimizable against measured feedback, and provable without any feedback at
      all. No single form serves four readers. Establish the chapter's rule: every form
      shown is one the engine actually builds, and every one carries the command that
      produced it or an explicit note that it has none.
- [ ] **§ forms-1-to-3-text-to-tree** — Source, tokens, AST. The layout tokens are the
      teaching moment: three token kinds with no characters behind them. Point forward to
      `[Ch 4 § characters-to-tokens]` and `[Ch 5 § the-program-that-indents-but-does-not-nest]`.
- [ ] **§ forms-4-and-5-the-second-tree** — The semantic AST's thirteen kinds and why it
      exists beside the parser's tree: the checker's analyses (`branchChain`, `alwaysExits`,
      `ownExpressions`, and `provenTakes` from `[Ch 1 § what-a-guard-proves]`) walk a
      normalized shape, not a syntactic one. Then form 5, the write-back: the checker calls
      `adoptContextualSignature` and *mutates the parser's tree*, so the bytecode compiler
      later reads `_paramInfo` and `_returnType` off an AST node. Establish that this is a
      real coupling, not a diagram: `[Ch 8 § thirteen-node-kinds]` and
      `[Ch 11 § inference-without-hindley-milner]` pay it off.
- [ ] **§ form-6-bytecode** — The disassembly of `mean`: a constant pool, a named local
      table (`Locals: r0=total, r1=i`), and register-plus-accumulator instructions.
      `> **New idea.**` register machine versus stack machine, one paragraph, deferred to
      `[Ch 17 § why-a-register-machine]`. Point out `LdaKeyedProperty r3 r4 r5` — one
      opcode carrying a feedback slot — which is the bridge to form 7.
- [ ] **§ form-7-what-the-interpreter-learned** — A feedback vector is not a profile
      counter; it is a record of *shapes seen*, per site, with a four-state lattice
      (`uninitialized → monomorphic → polymorphic → megamorphic`). Show `--trace-feedback`
      on `stats.tera` and on `stats-poly.tera`, where the same site goes polymorphic
      because a second class answers `label()`. `[Ch 33 § feedback]`, `[Ch 34 § inline-caches]`.
- [ ] **§ form-8-javascript** — Tier 1 emits a JavaScript source string and hands it to
      `new Function`. Show the switch/case dispatch loop's shape. Establish the design
      claim honestly: the baseline is not a code generator in the usual sense, it is a
      *specializer* that unrolls the interpreter's dispatch for one function. Name the five
      opcode classes it declines. `[Ch 36 § the-baseline-compiler]`.
- [ ] **§ forms-9-and-10-ssa** — The big one. `> **New idea.**` basic block,
      control-flow graph, dominance, and the phi node, in that order, each anchored to a
      line of the `--print-ir` dump above. Then the same graph after 34 passes, from
      `--print-after-all`. Establish what to look at in a diff of two IR dumps: nodes
      disappearing, `Generic*` opcodes becoming typed ones, and blocks merging.
      `[Ch 38 § a-control-flow-graph-not-a-sea]`, `[Ch 39 § building-ssa-from-bytecode]`,
      `[Ch 41 § the-pass-manager]`.
- [ ] **§ the-fork** *(the chapter's centre)* — One mermaid diagram, drawn once and
      referenced by every later part. Both roads enter `Optimizer.build`; the JIT arrives
      through `compile()` with a feedback vector, the native compiler through
      `compileStatic()` with `deoptimizes: false`. They share `buildIR` and all 34
      middle-end passes. They part at `targetLegalizationPipeline`, and the reason they part
      is one option: whether a guard may fail. Restate the asymmetry from
      `[Ch 1 § the-hinge]` now that the reader can see the graph it applies to.
- [ ] **§ forms-11-and-12-two-legalizations** — `> **New idea.**` legalization: the same
      graph rewritten until one target can emit every operation left in it. wasm first
      (`[Ch 51 § legalizing-for-a-target]`, `[Ch 52 § emitting-webassembly-by-hand]`), then
      MachineIR (`[Ch 64 § machineir-and-instruction-selection]`). This section must carry
      the wasm honesty item below: for `stats.tera` the JIT road stops at `report`, and
      `mean` — the method the whole book follows — is refused by the wasm backend.
- [ ] **§ forms-13-and-14-bytes** — Assembly text, then an executable. Show one `.loc`
      directive and establish what it is for (`[Ch 71 § telling-the-debugger]`). Show that
      `file` reports a statically linked ELF with no section header, and say what that costs.
      `> **New idea.**` relocation and symbol, deferred to `[Ch 70 § object-files]`.
- [ ] **§ where-you-are** — The table above, reproduced as the chapter's last page, with
      chapter numbers. Establish that this table is the book's index by *artifact* rather
      than by topic, and that a reader lost in Part VII should come back to it.

## Honesty items

- `> **Unfinished.**` — the wasm JIT cannot compile `Series.mean()`, the method this book
  follows. Measured on this tree: `node dist/cli.js --trace-opt --opt-threshold 1
  --baseline-threshold 1 docs/example/stats.tera` reports
  `[JIT] Compiling "mean": Wasm: graph not compilable: property access on this receiver`,
  and repeating the call two hundred times does not change it. The refusal is
  `unsupported("property access on this receiver")` in
  `src/optimizing/backends/wasm/codegen.ts`, reached when `READS_A_RECEIVER.has(node.type)`
  and `holdsTheReceiver(node.inputs[0])`; the sibling refusal
  `"handing back this receiver"` sits three lines below it. Only `report` — which takes its
  receiver as an ordinary parameter — reaches wasm, at 419 bytes and one block. Chapter 3
  must therefore show form 11 from `report`, not from `mean`, and say why on the page.
  Finishing it costs a representation for a receiver in the wasm object layout, which is
  the same work `[Ch 53 § the-boundary-is-the-wall]` measures as marshalling cost.
- `> **Unfinished.**` — three of the fourteen forms have no CLI flag. The token stream
  (form 2), the semantic AST (form 4), the checked AST (form 5) and the generated baseline
  JavaScript (form 8) are all reachable only from the API or a test:
  `BaselineCompiler.generateBody` returns the JavaScript string and nothing prints it;
  `printMachineFunction` exists but `CompilerOptions.machineTracer` has no flag in
  `src/cli/spec.ts`, so form 12 needs a harness too. The engine is described as a d8-style
  shell (`[Ch 73 § the-shell]`), and on this axis it is four flags short. Each costs one
  entry in `ENGINE_FLAGS` and one sink.
- `> **Never runs.**` — `--print-ir` is wired to `EngineOptions.onOptimize`, which fires
  only when a function actually reaches the optimizing tier. On `docs/example/stats.tera`
  with default thresholds (`jitThreshold: 50`) nothing does, so
  `node dist/cli.js --print-ir docs/example/stats.tera` prints the program's output and
  *no IR at all*, with no diagnostic. The reader must lower the threshold by hand. The same
  trap applies to `--print-bytecode` and lazily compiled functions. A one-line "nothing
  matched" note would close it.
- The chapter's own claim needs a caveat: the 34 middle-end passes are the shared ones.
  The AOT road runs 38 more from `targetLegalizationPipeline`, so `--print-after-all` on
  `tera compile` prints 72 distinct pass names, not 34. Say the number that belongs to each
  road rather than one number for both. (`docs/README.md` currently says "60 passes,
  11 analyses" in its overview diagram; the book uses the two measured numbers instead, and
  that diagram should be reconciled or dropped.)

## Verify it yourself

```bash
# form 3 — the tree the parser built
node dist/cli.js --print-ast docs/example/stats.tera | head -40

# form 6 — the bytecode of the method this book follows
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera

# form 9 — the SSA graph, phis and all (the thresholds are required: see honesty items)
node dist/cli.js --print-ir --opt-threshold 1 --baseline-threshold 1 --filter mean docs/example/stats.tera

# form 11 — which functions reach wasm, and which are refused
node dist/cli.js --trace-opt --opt-threshold 1 --baseline-threshold 1 docs/example/stats.tera

# form 10 — every pass, on the AOT road
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-src --print-after-all | head -40

# forms 13 and 14 — assembly text, then a real ELF
node dist/cli.js compile docs/example/stats.tera --target x64 --emit source -o /tmp/stats-asm
node dist/cli.js compile docs/example/stats.tera --target x64 --platform linux -o /tmp/stats-linux
```

## Tests that pin this

- `tests/optimizing/ir/text.test.ts` > `"names every value and lists inputs in order"`,
  > `"marks a node that carries a frame state"`, > `"marks a loop header and lists both edge directions"`
  — exactly the three things the form-9 excerpt asks the reader to read.
- `tests/optimizing/ir/text.test.ts` > `"round-trips a printed function unchanged"` and
  > `"keeps phi inputs aligned with the predecessor order"` — the printed IR is a real
  form, not a debug string: it parses back.
- `tests/optimizing/ir/text.test.ts` > `"survives a graph the IR factories built the usual way"`
  — the text form is usable as a pass fixture.
- `tests/optimizing/baseline/compiler.test.ts` > `"generates switch/case dispatch loop"`,
  > `"emits jump as pc assignment + continue"`, > `"emits conditional branch for JUMP_IF_FALSE"`,
  > `"emits SMI fast path for ADD with tag check"`, > `"emits return acc for ROP_RETURN"`
  — the shape of form 8, which has no command.
- `tests/optimizing/baseline/compiler.test.ts` > `"rejects functions containing try/throw"`
  and > `"rejects functions containing spread/rest/defineAccessor"` — what tier 1 declines.
- `tests/optimizing/baseline/compiler.test.ts` > `"compiles simple return-constant function and returns callable with _isBaseline flag"`
  and > `"creates fast-call variants (_call0, _call1, _call2, _call3)"`.
- `tests/optimizing/machine/trace.test.ts` > `"reports every stage boundary in the order the pipeline runs them"`,
  > `"labels each record with the symbol it belongs to and its allocation phase"`,
  > `"renders a header naming the stage and a body of real instructions"` — form 12's only
  observable surface.
- `tests/optimizing/backends/x64/assembly.test.ts` > `"uses a scaled index addressing mode for element access"`
  — the `this.values[i]` of form 13.
- `tests/optimizing/backends/x64/assembly.test.ts` > `"describes its prologue with call frame directives"`
  and > `"follows the object format of the target it was built for"` — forms 13 and 14.
- `tests/frontend/lexer.test.ts` > `"emits layout tokens for indentation blocks"` — form 2.
- `tests/e2e/docs/book-examples.test.ts` > `"stats.tera is the twenty-four lines the book claims"`
  — the source of all fourteen forms cannot drift.
