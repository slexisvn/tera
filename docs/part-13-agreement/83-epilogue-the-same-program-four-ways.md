# 83. Epilogue: the same program, four ways   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Twenty-four lines, four execution strategies, one answer they must all agree
on — and four completely different sets of costs.

**What arrived.** From [Ch 82]: `appendix/d-inventory.md`, and the method that built it —
read the codebase, not its notes. This chapter applies that method one last time, to the
book's own headline claim. Also, from the whole book: four working machines, and the two
harnesses that compare them, `differential` (`tests/helpers/tiers.ts:44`) and `peAgrees`
(`tests/helpers/aot-agreement.ts:32`).

**What leaves.** Nothing downstream — this is the end of the pipeline and the end of the
book. What leaves the reader is one table of measured artifacts and counts, four sentences
naming the single design decision each road is built on, and a short list of the places
where the headline claim is currently unproved or false.

**New ideas.** Two, both small, both first needed here.
- `> **New idea.** Break-even.` A compiler is a *loan*: it spends time now to save time on
  every later run. The question is never "is compiled code faster" but "after how many runs
  has the compile paid for itself". For `stats.tera` the answer is measured below, and it
  is two.
- `> **New idea.** Claim id.` Every number in this chapter's table carries a tag like
  `[E83-4]`. The ids are local to this chapter and are what `appendix/d-inventory.md`
  cites, so a number that goes stale can be found by grep rather than by rereading prose.

**Length.** 8 pages

## Anchors

- `src/api/engine.ts:695` — `Engine`, the one object all four roads hang off:
  `interpreter`, `baselineCompiler`, `optimizer`, `jitBackend` and `backends` as sibling
  fields (`:698-702`). The four entry points the table's columns use: `compile` (`:940`),
  `baselineCompile` (`:1684`), `optimizeFunction` (`:1758`), `compileAot` (`:944`), and
  `run`/`runNative` (`:1502`, `:1523`).
- `src/api/engine.ts:1981` — `getStats()`. Its `compilations`, `executions`,
  `totalCompileTimeMs`, `totalExecTimeMs` and `gc` are the engine's own instrumentation,
  and on `stats.tera` three of those are `0`. That is a fact about the program, not the
  timers; the chapter says so and then measures at the process level instead.
- `src/optimizing/target/legalization.ts:108` — `targetLegalizationPipeline(target,
  options)`. Line `:112` is the whole hinge: `const tagged =
  target.capabilities.has("tagged-values")`. That one boolean forks the shared pipeline at
  exactly four points — `:154` (`zero-divisor`), `:206` (`parse-number-surface`), `:344`
  (`builtin-domains`), `:400` (`representation-selection` + `representation-check`). The
  JIT gets the last pair; the native road gets the first three faults.
- `src/optimizing/target/capabilities.ts:1` — the `Capability` union, eleven strings, and
  `capabilitySet` (`:15`). `src/optimizing/target/speculation.ts:1` — `SpeculationKind`,
  three strings; `deoptToInterpreter` (`:10`) and `proveOrGeneric` (`:14`).
- The four target models, each about ten lines, each the entire declaration of what its
  machine may assume: `src/optimizing/backends/wasm/target.ts:5` `wasmTarget`
  (`deopt`, `osr`, `tagged-values`, `float-text`; `deoptToInterpreter`);
  `src/optimizing/backends/c/target.ts:5` `cTarget` (seven capabilities, none of them
  `deopt`; `proveOrGeneric`); `src/optimizing/backends/x64/target.ts:75` (the same minus
  `select-float`, plus `timers` only when the platform supplies `now` and `wait`);
  `src/optimizing/backends/riscv64/target.ts:42` (two capabilities).
- `src/bytecode/register/interpreter/frame.ts:39` — `RegisterFrame.acc`. One field. The
  accumulator, and the reason the bytecode is as short as it is [Ch 18].
- `src/optimizing/baseline/compiler.ts:134` — `generateBody`. Its output opens
  `var acc,t,t2,t3,t4,osr,sp=0;` and is a fall-through `switch` inside `L:while(1)`: the
  accumulator protocol survives verbatim into JavaScript. `:86` — `new Function("args",
  "tv", "$", "pc", "env", body)`.
- `src/feedback/vector/index.ts:781` — `FeedbackVector`. The decision the JIT road is
  built on: the interpreter writes down what it saw so a later tier can bet on it.
- `src/deopt/frame-state.ts:228` — `FrameStateBuilder`. The decision that makes the bet
  revocable, and therefore makes betting legal at all.
- `src/optimizing/analyses/aot-legality.ts:846` — `isRootedPointer`; `:852` —
  `rootSlotsOf`. `src/optimizing/backends/c/emit.ts:2526` — `rootFrame()`, which reserves
  `n` slots on entry and zeroes them; `:1939` — `rootStore`, which writes
  `roots[base + slot] = (unsigned char *)v17;`. The slot is a **copy** of the C local.
  `rootsBase` is read at only two sites in the whole tree (`:1561`, `:1585`), both inside
  the mark loops. Nothing ever reads a slot back into a value — which is why the native
  collector can never move an object [Ch 61].
- `src/optimizing/target/runtime-layout.ts:106,112,113` — `TERA_ROOT_CAPACITY = 1 << 14`,
  `TERA_HEAP_RESERVE_BYTES = 1 << 30`, `TERA_HEAP_COMMIT_BYTES = 1 << 20`: the native
  binary's declared memory, all three of them compile-time constants.
- `src/optimizing/backends/wasm/codegen.ts:100` — `READS_A_RECEIVER` (five IR node types);
  `:108` — `holdsTheReceiver`, true when the value is an `IR_CONSTANT` with
  `props.isThis`; `:476` — the refusal `unsupported("property access on this receiver")`.
  This is the sentence that keeps four of `stats.tera`'s five functions out of wasm.
  `:4076` — `const wasmBytes = builder.toBytes()`, the only place the module's size exists.
- `src/optimizing/builder/ir-builder.ts:141` — the other decline the running example hits:
  `unhandled opcode ${rOpcodeName(op)} (0x${op.toString(16)}) at bc:${bytecodeIdx}`.
- `src/cli/compile.ts:360` — `runCompile`; `:55` `FORMATS` (`exe`/`obj`/`source`); `:73`
  `warnSkipped` and `:79` `noteLeftOut`, the two voices [Ch 81 § warning-versus-note];
  `:259` `writeDirect` and `:277` `linkWithCompiler`, the two ways a binary appears.
- `tests/helpers/tiers.ts:10` — `TIERS`, seven named threshold settings (`oracle`,
  `baseline`, `jit`, `osr`, `eager`, `baselineOsr`, `production`); `:44` `differential`;
  `:35` `PRINTS_INSTEAD_OF_ANSWERING`, the guard that — see Honesty items — excludes every
  file in `docs/example/` from the only tier-agreement harness the tree has.

## Worked example

`docs/example/stats.tera`, run four ways. One probe script produces the tier-0, tier-1 and
tier-2 columns in a single process; two CLI invocations produce the tier-3 column. Every
number below was produced by the commands in *Verify it yourself*, on Windows 11, node
v24.9.0, one case per fresh process, 2026-09-07.

**The answer** `[E83-1]` — identical in all four, and byte-identical from the binary:

```
latency mean=15.70
throughput mean=898.19
```

**The work done to get there:**

| | Tier 0 · interpreter | Tier 1 · baseline | Tier 2 · JIT | Tier 3 · native (x64-windows) |
| --- | --- | --- | --- | --- |
| artifact | 151 register bytecodes `[E83-2]` | 211 lines of generated JavaScript `[E83-3]` | 419 bytes of wasm `[E83-4]` | 4,689 x64 instructions `[E83-5]` |
| covers | 5 of 5 functions | 5 of 5 | **1 of 5** `[E83-6]` | 5 of 5, plus one synthesized `_fixed_text` |
| declines | none | none | 4, in 2 sentences `[E83-7]` | none, for *this* file |
| shipped size | — | 5,448 chars of source text | 419 B | 28,714-byte PE `[E83-8]` |

**Where the 4,689 instructions go** `[E83-9]` — the program is the small part:

```
report          16      Series_label     84
_fixed_text    117      tera_program    218
Series          33      -------------------
Series_mean     88      the program     556
                        the runtime   4,133
```

Only five symbols are `.globl` (`report`, `Series`, `Series_mean`, `Series_label`,
`tera_program`); the file has 60 top-level labels. The other 4,133 instructions are the
arena allocator, the mark-sweep collector, the string routines and the Dragon4 float→text
formatter [Ch 60, Ch 64] — the runtime a program with no VM under it has to carry itself.

**Time** `[E83-10]`, whole-process wall clock, three runs each, idle machine:

```
node -e ""                                          69–74 ms   (the node floor)
node dist/cli.js docs/example/stats.tera           351–358 ms
node dist/cli.js compile ... -o stats.exe          605–608 ms  (once)
stats.exe                                           39–43 ms
```

Break-even `[E83-11]`: `355n` against `605 + 41n` crosses at `n ≈ 1.93`. **From the second
run onward the native road is cheaper**, and it stays 8.6× cheaper per run thereafter.

**Memory** `[E83-12]`. The engine's own counters say the interpreter allocated 15 objects
into a young generation with `oldGenCapacity: 16384`. The binary's figures are compile-time
constants, not measurements: 1 GiB of reserved address space, 1 MiB committed, 16,384 root
slots, 16 KiB of text buffer per producing site. Process resident memory was **not**
measured; the chapter says so rather than guessing.

## Outline

- [ ] **§ the-answer-first** — Establish `[E83-1]` before anything else, and establish what
      makes it identical rather than similar: not four implementations that happen to
      agree, but one front end, one bytecode and one middle end, forked as late as
      possible. Show `targetLegalizationPipeline`'s `const tagged =
      target.capabilities.has("tagged-values")` (`legalization.ts:112`) and the four places
      it forks. One boolean is the entire difference between the two roads out of the
      middle end. Cross-reference [Ch 38], [Ch 80 § the-one-sentence].
- [ ] **§ the-table** — The chapter's spine, and the only place in the book where all four
      columns stand side by side. Present `[E83-2]` through `[E83-9]`, each with the
      command that produced it. Establish the shape of the result before interpreting it:
      the artifacts differ by three orders of magnitude (151 bytecodes → 4,689
      instructions) while the answer differs by nothing.
- [ ] **§ four-hundred-and-nineteen-bytes** — *What was tried and rejected*, in the tree,
      visible on the running example. The JIT compiles **one** of `stats.tera`'s five
      functions. `mean` — the only numeric loop in the book's spine, the function the whole
      JIT road exists for — is declined with `unsupported("property access on this
      receiver")` (`wasm/codegen.ts:476`), because `this` is folded into the graph as an
      `IR_CONSTANT` with `props.isThis` (`:108`) and the backend refuses to read through it
      rather than hand back a stale copy [Ch 51]. `label` is declined for the same reason;
      `<script>` for `unhandled opcode DefineClassMember (0xb) at bc:9`
      (`ir-builder.ts:141`). Establish the honest consequence: **the book's running example
      cannot demonstrate the JIT's central claim**, and a chapter that pretended otherwise
      would be inventing a measurement. Name what the example *does* prove — that a
      declined function is a silent, correct fall-back to baseline, which is the whole
      point of [Ch 81].
- [ ] **§ what-the-interpreter-bought** — Startup, and the exact size of it. 351 ms to a
      correct answer with nothing built, no toolchain, no output file; `getStats()` reports
      `compilations: 0`. Establish the cost it pays: it is the only tier that must ask a
      question at every single operation, and [Ch 21]'s dispatch loop is what that costs.
      The design decision: **the accumulator** (`RegisterFrame.acc`,
      `interpreter/frame.ts:39`) — one implicit operand, chosen so the common instruction
      needs one register field instead of three [Ch 17, Ch 18].
- [ ] **§ what-the-baseline-bought** — 151 bytecodes become 211 lines of JavaScript
      `[E83-3]`, and every one of them keeps the accumulator: read
      `generateBody`'s output for `report` aloud (19 lines, and it is `var acc` and
      `L:while(1){switch(pc){`). Establish what the baseline is buying — the removal of the
      dispatch *decision*, not of the work — and what it is not: this chapter measured a
      string-concatenation loop under `--baseline-threshold 1000000000` against
      `--baseline-threshold 1` and got **1.10×**, not the fivefold the project's notes
      claim. State the number, state the command, and state that the claim is withdrawn
      until someone re-measures it. Rule 9 of `docs/CONVENTIONS.md` is what this section is
      for. The design decision: **the same accumulator protocol**, which is why a function
      can be promoted mid-flight without translating its state [Ch 36 § what-leaves].
- [ ] **§ what-the-jit-bought** — And what it paid. 419 bytes of wasm for `return
      s.label()`. Establish the *shape* of the bargain from the tier model rather than from
      a benchmark this tree cannot run: `wasmTarget` is the only target that declares
      `deopt` and `osr` (`wasm/target.ts:7`) and the only one whose speculation strategy is
      `deoptToInterpreter`. It may guess because it can take the guess back. The bill
      arrives at the marshalling boundary — recall [Ch 51]: an object-heavy function
      serialises its graph into linear memory, and the tree's own record says that is
      20–30× slower, which is why `escaping-alloc` declines exist at all. The design
      decision: **the feedback vector** (`feedback/vector/index.ts:781`) — the interpreter
      writing down what it saw so a later tier has something to bet on — and **the frame
      state** (`deopt/frame-state.ts:228`), without which the bet would be illegal.
- [ ] **§ what-aot-bought** — A file. 28,714 bytes, no VM under it, 39 ms to run, and
      `cTarget`/`x64` declare no `deopt` and no `osr` at all. Establish the price in the two
      currencies the book has already spent: **refused programs** — of the eight files in
      `docs/example/`, the interpreter runs all eight and the x64 backend produces a binary
      for three (`stats.tera`, `stats-async.tera`, `labeled.tera`), refusing the other five
      with five *different* sentences `[E83-13]` — and **a collector that cannot move
      anything**. Read `rootStore` (`c/emit.ts:1939`): the root slot receives a *copy* of
      the C local, and `rootsBase` is read at exactly two sites in the tree, both inside
      the mark loops. A compacting collector would fix the slot and leave every local
      pointing at the old address. The design decision, and the most expensive one in the
      book: **the shadow-stack root slot mirrors, it does not indirect** [Ch 61].
- [ ] **§ the-four-decisions** — Half a page. Put the four side by side and establish that
      each is *one* thing, taken early, that the rest of a tier follows from: the
      accumulator (tier 0 and 1), the feedback vector (tier 1 → 2), the frame state
      (tier 2's licence to guess), the mirroring root slot (tier 3's ceiling). Establish
      the general rule the book has been arguing for eighty-two chapters: an execution tier
      is not a bag of optimizations, it is one commitment plus its consequences.
- [ ] **§ where-the-sentence-is-false** — *Why the obvious design fails*, aimed at this
      chapter's own thesis. Four machines, one answer is the book's claim; here is where it
      is not currently proved. (1) `differential` (`tiers.ts:44`) throws
      `PRINTS_INSTEAD_OF_ANSWERING` for any source whose last line starts `print(` —
      **every file in `docs/example/` does**, so the book's spine is structurally excluded
      from the one harness that compares tiers. (2) Nothing compares `stats.tera`'s binary
      against its interpretation; `peAgrees` is never called on an example file. (3) The
      divergence from [Ch 82 § broken-tier-divergence] still reproduces, so the sentence
      has a live counterexample. Establish the cost of closing each: a `tiers`-shaped
      variant that answers instead of printing; one `peAgrees` call per compilable example;
      and the `--opt-bisect` run nobody has done.
- [ ] **§ one-entry-leaves-the-inventory** — Short, and the chapter's last use of [Ch 82]'s
      method. `labeled.tera` **terminates**. `--print-bytecode` now shows `57  Jump r64`,
      not `Jump r0`; `compileLabeledStatement` (`statements.ts:668-688`) publishes the
      label through `_pendingLoopLabels` so the loop compiler owns and patches the continue
      list, and throws `Label 'outer' does not name a loop` if nothing claims it — which is
      exactly the structural fix [Ch 82] predicted would be needed. The general rule it
      produced, and the one the section teaches: **a jump can only be patched by the
      construct that owns its target** — a labelled statement owns no latch, so it hands
      the label to the loop instead of resolving it where it is written. The prose caught
      up afterwards, in every chapter that had raised the bug, which is the second rule:
      **an entry leaves the inventory when a command reproduces nothing, and prose is the
      last thing to find out.**
- [ ] **§ close** — Half a page, no new material. Twenty-four lines. One answer. Four
      artifacts whose sizes span 151 to 4,689. The book's only remaining job is to have
      made each of those four numbers legible.

## Honesty items

- > **Unenforced.** Nothing in the tree compares `stats.tera`'s four executions against
  each other. `differential` (`tests/helpers/tiers.ts:44`) rejects any source whose last
  non-blank line starts with `print(` — `PRINTS_INSTEAD_OF_ANSWERING`, `:35` — and every
  file in `docs/example/` ends in a `print`. `tests/e2e/docs/book-examples.test.ts` runs
  each example through `engine.runModule` in the default tier only. `peAgrees`
  (`tests/helpers/aot-agreement.ts:32`) is never called on an example file. Cost of
  closing: one answering variant of `stats.tera` for `differential`, and one `peAgrees`
  call each for the three examples that compile.
- > **Broken.** The optimizing tier still answers differently from `--no-opt` on the
  bignum reproducer carried in [Ch 82 § broken-tier-divergence]; re-reproduced 2026-09-07,
  command in *Verify it yourself*. `--no-opt` ends `...,1,1,1,1,`; the optimizing tier ends
  `...,1,0,0,0,0,0,`. No file or symbol can be named. This is a live counterexample to this
  chapter's thesis and is stated as one.
- > **Unfinished.** `READS_A_RECEIVER` / `holdsTheReceiver`
  (`src/optimizing/backends/wasm/codegen.ts:100`, `:108`) make the wasm backend refuse
  every property read through a receiver that was folded into the graph as an
  `IR_CONSTANT` with `props.isThis`. That is a correct refusal — the alternative was
  handing back a stale receiver [Ch 51] — but it declines `Series.mean` and
  `Series.label`, so the running example puts 1 of 5 functions into wasm. Cost of
  finishing: stop constant-folding the receiver and marshal it like any other object, into
  the boundary the tree already measured at 20–30× slower.
- > **Unfinished.** `src/optimizing/builder/ir-builder.ts:141` — `DefineClassMember` has no
  IR builder case, so any top level that declares a class is declined whole
  (`unhandled opcode DefineClassMember (0xb) at bc:9` on `stats.tera`). Cost: one builder
  case, or a decision that module top levels are never worth optimizing.
- > **Unenforced.** Nothing reads a shadow-stack root slot back into a value.
  `rootStore` (`src/optimizing/backends/c/emit.ts:1939`) writes a copy; `rootsBase` appears
  as a read only at `:1561` and `:1585`, both inside mark loops. The invariant "the
  collector must never move an object" is therefore enforced by absence, not by a check —
  a compacting collector added later would produce silently wrong pointers with no
  verifier objecting. Cost of enforcing: an assertion in the emitter, or a `TargetModel`
  capability the collector has to declare.

Two items that are not markers but are corrections this chapter must carry:

- **Claim withdrawn.** The plan for this chapter asserted "the baseline bought a fivefold
  speedup for a string concatenation". Measured 2026-09-07 on a 200 × 2,000-iteration
  concatenation loop, `--baseline-threshold 1000000000` against `--baseline-threshold 1`
  under `--no-opt`: 794/832 ms against 737/726 ms — **1.10×**, not 5×. Nothing in `docs/`
  or `src/` records where the fivefold figure came from. The chapter states the measured
  number and withdraws the claim.
- **Entry closed.** The book was outlined while labeled `continue` never terminated, and
  several chapters carried it as a `> **Broken.**` marker. It terminates:
  `docs/example/labeled.tera` prints `1 2 3 5 6 7` in the interpreter *and* from its native
  binary, and `--print-bytecode` shows `57  Jump r64`. `compileLabeledStatement`
  (`src/bytecode/register/compiler/statements.ts:668-688`) now hands the continue list to
  the loop compiler through `_pendingLoopLabels` and raises
  `Label '<name>' does not name a loop` if nothing claims it. `[Appendix D § inventory]`
  lets an item leave only once the chapters that raised it are updated as well, and this
  correction is the chapter-side half of that.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats.tera
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe && ls -l /tmp/stats.exe
node dist/cli.js --print-bytecode docs/example/stats.tera | grep -cE "^ +[0-9]+  [A-Z]"
node dist/cli.js compile docs/example/stats.tera --emit source --target x64 -o /tmp/statsasm && grep -cE "^[[:space:]]+[a-z]" /tmp/statsasm/stats.s && grep -c "\.globl" /tmp/statsasm/stats.s
node dist/cli.js --stats docs/example/stats.tera | head -6
for f in docs/example/*.tera; do printf "%-22s " "$(basename $f)"; node dist/cli.js compile "$f" -o /tmp/x.exe 2>&1 | head -1 | cut -c1-96; done
```

The tier-0/1/2 columns come from one script — it prints per-function bytecode and generated
JavaScript line counts, then every JIT decision with its reason and every wasm module's
size:

```bash
cat > /tmp/four-ways.cjs <<'EOF'
const fs = require("node:fs");
const source = fs.readFileSync("docs/example/stats.tera", "utf8");
const Real = WebAssembly.Module; const wasm = []; let who = "?";
WebAssembly.Module = function (b) { wasm.push([who, b.length]); return new Real(b); };
WebAssembly.Module.prototype = Real.prototype;
const { Engine } = require(require("node:path").resolve("dist/index.node.js"));
const cold = new Engine({ typecheck: "off", output: () => {} });
const script = cold.compile(source); const fns = []; const seen = new Set();
(function walk(f) { if (!f || seen.has(f)) return; seen.add(f); fns.push(f);
  for (const c of f.constants ?? []) if (c && Array.isArray(c.instructions)) walk(c); })(script);
for (const f of fns) console.log(`${(f.name || "<script>").padEnd(9)} bytecodes=${f.instructions.length}` +
  `  jsLines=${cold.baselineCompiler.generateBody(f)?.split("\n").length ?? "-"}`);
const hot = new Engine({ typecheck: "off", output: () => {},
  tieringPolicy: { baselineThreshold: 1, jitThreshold: 1, loopOsrThreshold: 1 } });
const optimize = hot.optimizeFunction.bind(hot);
hot.optimizeFunction = (fn) => { who = fn.name || "<script>"; const r = optimize(fn);
  console.log(`jit ${who.padEnd(9)} ${fn.optimizedCode ? "compiled" : "DECLINED: " + fn.lastCompileFailureReason}`);
  return r; };
hot.run(source);
console.log("wasm modules " + JSON.stringify(wasm));
EOF
node /tmp/four-ways.cjs
```

Its output, verbatim, 2026-09-07:

```
<script>  bytecodes= 65  jsLines= 77
report    bytecodes=  7  jsLines= 19
Series    bytecodes= 10  jsLines= 22
mean      bytecodes= 43  jsLines= 55
label     bytecodes= 26  jsLines= 38
TOTAL     bytecodes=151  jsLines=211
jit <script>  DECLINED: unhandled opcode DefineClassMember (0xb) at bc:9
jit report    compiled
jit label     DECLINED: property access on this receiver
jit mean      DECLINED: property access on this receiver
wasm modules [["report",419]]
```

Timing, break-even, and the two honesty items — run each on an idle machine, one case per
fresh process:

```bash
for k in 1 2 3; do s=$(date +%s%N); node dist/cli.js docs/example/stats.tera >/dev/null; e=$(date +%s%N); echo "interp $(( (e-s)/1000000 ))ms"; done
for k in 1 2 3; do s=$(date +%s%N); /tmp/stats.exe >/dev/null; e=$(date +%s%N); echo "native $(( (e-s)/1000000 ))ms"; done
node dist/cli.js --print-bytecode docs/example/labeled.tera | grep -n "Jump" && node dist/cli.js docs/example/labeled.tera
npx vitest run --project e2e tests/e2e/docs/book-examples.test.ts
```

The `Jump` line to look for is `57  Jump r64`, and `labeled.tera` prints `1 2 3 5 6 7` and
stops. The bignum divergence reproducer is [Ch 82 § broken-tier-divergence]'s, unchanged
and still reproducing.

## Tests that pin this

- The answer, in the interpreter, for every example file:
  `tests/e2e/docs/book-examples.test.ts` >
  `"stats.tera prints what the book says it prints"` (one of eight titles generated from
  the `EXPECTED` table at `:35`), and
  `"covers every example file, so a new one cannot be added untested"`, which is what stops
  a file being quietly dropped from the set. Also
  `"stats.tera is the twenty-four lines the book claims"` — the chapter's title is a test.
- The two refusals the book opens and closes on:
  `tests/e2e/docs/book-examples.test.ts` >
  `"queue.tera runs in the interpreter but is refused ahead of time"` and
  `"stats-refused.tera runs in the interpreter but is declined by the backend"`.
- Labeled `continue` is now pinned *correct*, not broken:
  `tests/e2e/docs/book-examples.test.ts` >
  `"labeled.tera resumes the outer loop instead of restarting the program"`, asserting
  `["1", "2", "3", "5", "6", "7"]`.
- Tier agreement, on sources that answer rather than print:
  `tests/e2e/optimizing/decimal-formatter.test.ts` >
  `"prints what toFixed prints, at every tier"` (`differential` over `baseline`, `jit`,
  `osr`, `eager`), and `tests/e2e/optimizing/member-access.test.ts` >
  `"function member access agrees across every tier when hot"`.
- That the AOT surface is compiled by two backends from the same source:
  `tests/e2e/optimizing/aot/feature-matrix.test.ts` > `"runs <feature> in the interpreter"`
  and `"compiles <feature> for the c backend"` / `"compiles <feature> for the x64-windows
  backend"` — titles generated from the `FEATURES` table at `:30` and `BACKENDS` at `:93`,
  with `verifyEachPass: true`.
- The four-way agreement on `stats.tera` itself is **`[unpinned]`**. No test in the tree
  runs the running example through more than one tier, and none compares its binary against
  its interpretation. See Honesty items.
