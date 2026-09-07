# Part IX — The other road: ahead of time

> **Status:** outline

**Length.** 2 pages

## What this part is

Part VIII took the optimized `CFGFunction` of Part VII, ran
`targetLegalizationPipeline` against `wasmTarget`, and wrote WebAssembly bytes for a
running process to instantiate.

Part IX takes the **same graph, through the same middle end, through the same
legalization pipeline**, and hands it to a target that cannot deoptimize, cannot box,
cannot ask a value what it is at run time, and will not exist as a process until
someone runs the file it produced. Everything that is hard about ahead-of-time
compilation here follows from removing one capability — `deopt` — and one runtime
service: the interpreter itself.

Nine chapters. The first two are the rules; the next four are how a dynamic program
is made static enough to obey them; the last three are the runtime that makes the
result a program rather than a pile of functions.

## What this stage owes everything downstream

- **One options object decides which compiler you are running.** `staticCompilerOptions`
  (`src/optimizing/optimizer.ts:36-40`) is three fields wide:
  `{ ...base, sinkAllocations: false, deoptimizes: false }`. That single `deoptimizes`
  flag is read by `middleEndPhases` (`src/optimizing/pipeline.ts:110`) to *enable* loop
  unswitching, by `elideFrameStates` to strip every deopt snapshot, and by
  `capabilityCheck` to refuse a graph that still carries a guard. Part X's machine
  backends never see a `frameState` because of these three lines.
- **`AotScalar` is the type system the backends actually implement.** Seven kinds
  (`src/optimizing/types/scalar.ts:10-25`), no boxing, no conversion at run time, and
  no `tagged`. Part X's register allocator classes and stack slots come from
  `MachineTargetModel.locationOf(scalar)`; Part XI's debugger sees these and not
  `Representation`.
- **The class table is the object model.** `ClassTable`
  (`src/optimizing/metadata/class-table.ts`) is computed once from checker types and is
  the *only* description of memory a compiled program has. Part X emits it twice —
  as a C array and as machine data — from `TERA_CLASS_RECORD`, and Part XI's collector
  walks it.
- **The runtime layout is one file.** `src/optimizing/target/runtime-layout.ts`
  declares `tera_context` (28 fields), five fixed arrays, three tables, the block flag
  bits and every runtime symbol name. Two entirely independent implementations —
  `src/optimizing/backends/c/emit.ts` and `src/optimizing/backends/x64/heap.ts` — read
  it, so an offset cannot drift between them.
- **Refusal is prose, not a status code.** Where the JIT swallows a
  `BackendLoweringError` into a trace line and falls back
  ([Ch 51 § refusal-is-an-outcome]), the AOT driver prints it. `AotSkippedFunction`
  carries `{ name, reason }` and the reason is a full English sentence ending in
  "…, or keep this part interpreted". Part XIII's agreement story is built on the fact
  that a refused function still *runs* — in the interpreter.

## The chapters

| Ch | Title | Tiers | Pages |
| --- | --- | --- | --- |
| 55 | The same graph, with no way out | ⟨ J · N ⟩ | 12 |
| 56 | Legality, and the art of refusing well | ⟨ I · N ⟩ | 14 |
| 57 | Objects without a runtime type | ⟨ N ⟩ | 14 |
| 58 | Making the program static | ⟨ N ⟩ | 16 |
| 59 | Strings without a runtime tag | ⟨ N ⟩ | 14 |
| 60 | A runtime written in its own language | ⟨ I · N ⟩ | 16 |
| 61 | The arena, the shadow stack, and why nothing moves | ⟨ N ⟩ | 16 |
| 62 | Generations Without Moving | ⟨ N ⟩ | 14 |
| 63 | The event loop, and a rejection nobody awaited | ⟨ I · N ⟩ | 12 |

## Which of the four machines this part constrains

- **Interpreter ⟨ I ⟩** — constrained in exactly two ways, both of them as *oracle*.
  Every refusal sentence ends by naming it ("keep this part interpreted"), and every
  e2e test in `tests/e2e/optimizing/aot/` asserts the binary's stdout equals the
  interpreter's. Chapter 60 goes further: the interpreter's `Math.exp(1)` is what the
  fdlibm prelude is corrected *to*.
- **Baseline ⟨ B ⟩** — **not constrained by this part at all.** The baseline compiler
  emits JavaScript from bytecode and never sees a `CFGFunction`, a `ClassTable` or an
  `AotScalar`. It does not appear in any chapter here.
- **JIT ⟨ J ⟩** — constrained by chapter 55 only, and by contrast: the chapter's whole
  method is to put `wasmTarget` and the native targets side by side and read the one
  options object that separates them.
- **Native ⟨ N ⟩** — the whole subject. Three backends: `cBackend` (portable,
  `platform: null`, emits source only), the x64 backends (linux and windows, which
  write executables themselves), and riscv64-linux (source only). `node dist/cli.js
  targets` prints exactly this table.

## What the running example can and cannot reach here

`docs/example/stats.tera` reaches most of this part and compiles clean:

```
$ node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe
$ /tmp/stats.exe
latency mean=15.70
throughput mean=898.19
```

It carries chapter 55's `CheckSmi` (via `insertDeclaredParameterGuards` on
`_FixedDigits.shrink`), chapter 57's class layout and shape table, chapter 59's static
string buffers (`sb0`, `sb1`), chapter 60's `to_fixed` prelude, and chapter 61's root
frames. It does **not** reach:

- the collector actually collecting — five floats and two objects never fill a 1 GB
  arena, so chapters 61 and 62 use their own allocation-heavy programs, as
  `docs/CONVENTIONS.md` rule 2 requires;
- coroutines or the event loop — that is `stats-async.tera`, which also compiles;
- a refusal — that is `stats-refused.tera`, chapter 56;
- polymorphic dispatch, because `stats-poly.tera` declares `fn report(s)` with no
  parameter type and is refused before dispatch is reached (see [Ch 57 § honesty-items]);
- higher-order monomorphisation, because `stats-closure.tera` calls `values.map(...)`,
  which no backend implements (see [Ch 58 § honesty-items]). Its `scaler`/`scale` half
  *does* compile, and is chapter 58's closure-conversion example.

## Verify it yourself

```bash
node dist/cli.js targets
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe
node dist/cli.js compile docs/example/stats-async.tera -o /tmp/async.exe && /tmp/async.exe
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe; echo "exit=$?"
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
```
