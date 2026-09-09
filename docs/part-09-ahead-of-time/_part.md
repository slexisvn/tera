# Part IX — The other road: ahead of time   ⟨I · · · N⟩

> **Status:** written

**What arrived.** Not Part VIII's output. **The same `CFGFunction` Part VII produced** — one
per function, canonical-phi SSA, typed by `typeInferenceAnalysisId`, a `frameState` on every
node that can give up — handed to the *same* `targetLegalizationPipeline` chapter 51 described,
against a different `TargetModel`. Part VIII and Part IX are two readings of one array of
passes, and the reading is decided by a set of strings.

**What leaves.** A file. Not an artifact a running process installs, not a closure an
interpreter calls — an ELF or PE executable, or C source a host compiler will link, that
contains its own object model, its own string storage, its own coroutine machinery, its own
allocator, its own generational collector and its own event loop, and that runs with nothing
underneath it at all:

```
$ node dist/cli.js docs/example/stats.tera
latency mean=15.70
throughput mean=898.19
$ node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe
latency mean=15.70
throughput mean=898.19
```

Beside the file, for every function the compiler declined: an `AotSkippedFunction` carrying one
English sentence, which `tera compile` renders as a warning, a note, or the text of an
entry-point error depending on whether the program needed the function at all.

## The structural hinge, from the other side

Part VIII stated it; this part is the nine chapters of paying for it.

**The JIT may guess, because a failed guess deoptimizes into the interpreter.** A guard there is
a real wasm instruction with a real failure edge, and behind that edge is a snapshot, a
materializer and a frame to resume ([Ch 54 § the-problem](../part-08-wasm/54-deoptimizing-out-of-wasm-and-when-the.md)).

**The native compiler may not, because there is nothing underneath it.** No native target
declares the `deopt` capability, so `speculationLowering` selects `prove-or-generic` and deletes
seven of the eight guard opcodes; `elideFrameStates` nulls every frame state at legalization
`#36`; and `capabilityCheck` at `#40` refuses any node that would still have needed one
([Ch 51 § frame-state-elision](../part-08-wasm/51-legalizing-for-a-target.md),
[Ch 51 § the-final-check](../part-08-wasm/51-legalizing-for-a-target.md)). On `stats.tera` that
is **two hundred and six frame states deleted between pass `#35` and pass `#36`, and no guard
node surviving pass `#40`.**

Read the two sentences together and the whole part follows. Every fact the JIT would have
guarded, this compiler must *prove*. Every value the JIT would have boxed, this compiler must
give one storage class, forever, with no conversion node to fall back on. Every question the JIT
would have asked at run time — what class is this receiver, where do this string's characters
live, which function does this value name, is this word a number or a pointer — has to be
answered at compile time or not asked.

And there is a third sentence, which is what makes this a compiler rather than a rejection
machine: **where it cannot prove, it refuses one function and says why in the user's
vocabulary — and the refused function still runs, in the interpreter.** That is the option the
book has been building toward since chapter 1, and `src/optimizing/analyses/aot-legality.ts` is
1,995 lines of paying for it: **49 places where the analysis stops and writes a sentence
instead of an answer** ([Ch 56 § an-analysis-that-writes-prose]).

## What this stage owes everything downstream

- **One options object, three fields wide, decides which compiler you are running.**
  `staticCompilerOptions` (`src/optimizing/optimizer.ts:36-40`) is
  `{ ...base, sinkAllocations: false, deoptimizes: false }`. `sinkAllocations` removes a pass.
  `deoptimizes` has exactly one reader in `src/` and reads *backwards*: it is the gate that
  turns loop unswitching **on**, because unswitching and speculation are substitutes and each
  road buys specialization with the currency it has ([Ch 55 § three-fields-wide],
  [Ch 55 § why-unswitching-needs-no-deopt]). The work a reader expects that flag to do is done
  by a second, independent switch — the target's capability set — and **nothing checks that the
  two agree**.
- **`AotScalar` is the type system the backends actually implement.** Seven kinds
  (`src/optimizing/types/scalar.ts:10-16`): no `tagged`, no `bool`, no boxing and no runtime
  conversion. A *representation* is a form a value currently has and may be converted from; a
  *scalar* is the only form it will ever have ([Ch 55 § seven-scalars-against-six-representations]).
  Part X's register classes and stack slots come from `MachineTargetModel.locationOf(scalar)`;
  `SCALAR_TEXT` has no machine location on any target and no C type, which is not an oversight
  but the definition of what text is on this road.
- **The class table is the object model, and it is the only description of memory a compiled
  program has.** `ClassTable` (`src/optimizing/metadata/class-table.ts`) is computed once from
  checker types; every object carries an eight-byte header — a `u32` shape id and a `u32` size
  whose low three bits are the collector's flags, free because every block is eight-byte
  aligned ([Ch 57 § eight-bytes-and-three-spare-bits]). Part X emits the table twice, as a C
  array and as machine data, from one `TERA_CLASS_RECORD` declaration; [Ch 61 § marking] reads
  it at run time as the only thing standing between the collector and undifferentiated bytes.
- **Dispatch cones are structural, not nominal.** tera's checker assigns object types by
  *surface*, so a compiler that built its hierarchy out of `parent` links would be answering a
  different question from the one the program's assignments obey — and devirtualization is only
  ever justified by "nothing else can be here". [Ch 57 § structural-not-nominal] is the
  twenty-one-line program in the tree that proved it, and the general rule it produced: **a
  compiler's class hierarchy must be built from the same relation its type checker uses, or
  devirtualization is unsound.**
- **The runtime layout is one file, and two independent implementations read it.**
  `src/optimizing/target/runtime-layout.ts` declares `tera_context` (28 fields, 13 of them the
  event loop's), the class record, the tables, the block flag bits and every runtime symbol
  name. `src/optimizing/backends/c/emit.ts` and `src/optimizing/backends/x64/heap.ts` are
  entirely separate programs that both read it, so an offset cannot drift between them
  ([Ch 61 § one-file-two-implementations]). What that guarantee does *not* cover is the subject
  of several honesty items: one layout, three implementations is a much narrower claim than one
  collector.
- **Nothing moves.** The shadow stack looks exactly like the handle table a moving collector
  needs, and it is not one: its slots are **mirrors**, and every use reads the register or C
  local rather than the slot. A collector that relocated an object would have to rewrite both
  and can only reach one ([Ch 61 § nothing-moves]). That single property closes off half the
  garbage-collection literature — including, measurably, the textbook generational design
  ([Ch 62 § why-the-obvious-design-fails-the-address-range-nursery]).
- **A compiled tera program contains exactly one indirect call.** Closures become frame objects
  and direct calls; higher-order functions are monomorphised into a clone per function argument;
  interface dispatch is a comparison ladder over a `u32`, not a vtable. The one exception is
  `tera_drain` reading a `SCALAR_CODE` field off a suspended frame it popped from a queue, which
  is the *definition* of a ready queue ([Ch 58 § the-one-code-pointer],
  [Ch 63 § the-one-indirect-call]). That single site is the last thing this part hands Part X.
- **Refusal is prose, not a status code.** Where the JIT swallows a `BackendLoweringError` into
  a trace line and falls back ([Ch 51 § refusal-is-an-outcome](../part-08-wasm/51-legalizing-for-a-target.md)),
  the AOT driver prints it. Every sentence has three parts — what the program did, why that
  cannot be compiled, and at least one way out — and the closing clause is always the same
  contract: *"…, or keep this part interpreted"* ([Ch 56 § the-shape-of-a-refusal]).

## Which of the four machines this constrains

| Ch | Title | Badge | Why |
| --- | --- | --- | --- |
| 55 | [The same graph, with no way out](55-the-same-graph-with-no-way-out.md) | ⟨· · J · N⟩ | the method is to put `wasmTarget` and the native targets side by side |
| 56 | [Legality, and the art of refusing well](56-legality-and-the-art-of-refusing-well.md) | ⟨I · · · N⟩ | every refusal ends by naming the interpreter as the way out |
| 57 | [Objects without a runtime type](57-objects-without-a-runtime-type.md) | ⟨· · · N⟩ | a static table replaces the transition tree ⟨I⟩ built at run time |
| 58 | [Making the program static](58-making-the-program-static.md) | ⟨· · · N⟩ | closures, higher-order calls and `await` become ordinary functions |
| 59 | [Strings without a runtime tag](59-strings-without-a-runtime-tag.md) | ⟨· · · N⟩ | a string is an address; nothing at run time can be asked about it |
| 60 | [A runtime written in its own language](60-a-runtime-written-in-its-own-language.md) | ⟨I · · · N⟩ | the interpreter's `Math.exp(1)` is what the fdlibm port is corrected *to* |
| 61 | [The arena, the shadow stack, and why nothing moves](61-the-arena-the-shadow-stack-and-why.md) | ⟨· · · N⟩ | the program collects its own garbage, in code the compiler wrote |
| 62 | [Generations without moving](62-generations-without-moving.md) | ⟨· · · N⟩ | C and x64 only; riscv64 keeps the full collector by capability |
| 63 | [The event loop, and a rejection nobody awaited](63-the-event-loop-and-a-rejection-nobody.md) | ⟨I · · · N⟩ | the binary's stdout must match the interpreter's rejection report byte for byte |

**The baseline compiler ⟨B⟩ is not constrained by this part at all.** It emits JavaScript from
bytecode and never sees a `CFGFunction`, a `ClassTable` or an `AotScalar`; it appears in no
chapter here. **The JIT ⟨J⟩ appears in chapter 55 only, and by contrast**: the chapter's whole
method is to read the one options object and the one capability set that separate the two roads.
**The interpreter ⟨I⟩ is constrained in exactly two ways, both as *oracle*.** Every refusal
sentence ends by naming it, and every e2e test under `tests/e2e/optimizing/aot/` asserts the
binary's stdout equals the interpreter's. Chapter 60 goes furthest: the transcendental prelude is
an fdlibm port, and the number it must agree with is the number the interpreter prints.

Three backends carry ⟨N⟩: `cBackend` (portable, `platform: null`, source only), the x64 backends
for Linux and Windows (which write ELF and PE bytes themselves, with no `cc` anywhere), and
riscv64-linux (source only). `node dist/cli.js targets` prints exactly that table.

## The chapters

**55 and 56 are the rules.** [Ch 55] establishes that there is no second compiler:
`Optimizer.build` is one method with two public entry points, `compile()` throws without a
feedback vector and `compileStatic()` passes `null` deliberately, and there is no
`if (feedback === null)` anywhere downstream ([Ch 55 § one-build-two-callers]). Around that one
method it assembles a *driver* — because an ahead-of-time compiler has no partner tier, so its
unit of work is the whole module graph and its job is "compile all of these, and account for
every one you could not". Seventeen named module-level stages run before any function is
lowered ([Ch 55 § seventeen-module-stages]), and three of the questions the backend needs
answered are whole-program properties that force the emitter to be the *last* thing to run
rather than the natural next step ([Ch 55 § then-per-function-then-again]). **[Ch 56] is this
part's load-bearing chapter.** Its subject is an analysis whose output is a *diagnostic*: it
answers a fact or a sentence, first failure wins, and the vocabulary of that sentence is the
user's rather than the compiler's ([Ch 56 § an-analysis-that-writes-prose]). Its central
mechanism is **demand** — a backwards join over uses, because asking "what scalar is this bare
`null`?" is the wrong question and "what does every use of it require?" is the right one
([Ch 56 § demand-is-a-join-over-uses]) — and its absence model is two quiet-NaN payloads and one
null address, which is why a number position can carry both absences and a reference position
can carry one ([Ch 56 § two-absence-values-one-payload-each]).

**57 through 60 are how a dynamic program is made static enough to obey those rules.**
[Ch 57] replaces the transition tree with a numbered table of layouts and an eight-byte header,
and spends its length on the harder half — *which classes are related to which* — where the
structural/nominal mismatch produced a real wrong answer ([Ch 57 § structural-not-nominal]). It
also shows why an array has to be **two** objects, header and buffer, in a runtime where nothing
can be forwarded ([Ch 57 § an-array-is-two-objects]). [Ch 58] is four payments: a captured
variable becomes a global or a field of a synthetic class; a function passed as an argument
becomes a *clone of the receiving function* with the argument deleted
([Ch 58 § a-parameter-that-is-only-ever-called]); and an `await` becomes a heap frame, a state
number and a resume function called by name ([Ch 58 § the-state-dispatch-chain]). Every frame it
invents is a row in chapter 57's table, laid out by the same function and collected by the same
loop — which is why none of it needs new runtime support
([Ch 57 § minting-into-the-same-table]). [Ch 59] removes the last runtime question from a value:
a string is eight bytes holding an address, so **the compiler alone is responsible for the claim
that the bytes are still there when they are read** ([Ch 59 § the-proof]), and where it cannot
make that claim there is a legalization pass that performs, automatically, exactly the remedy
the refusal message recommends ([Ch 59 § the-pass-that-takes-its-own-advice]). [Ch 60] is the
answer to "where does the implementation live?", and it is the one a reader least expects:
`_FixedDigits`, `_FixedText`, `_m_exp` and `Error` are **tera source**, generated on demand,
appended to the entry module, re-parsed and re-typechecked beside the user's declarations, and
then compiled by exactly the passes that compiled `Series.mean` — including its refusals
([Ch 60 § what-a-runtime-usually-is]). A twenty-four-line program compiles to twenty-one
functions because of it.

**61, 62 and 63 are the runtime that makes the result a program rather than a pile of
functions.** [Ch 61] is a reserve-then-commit arena, a shadow stack whose slots are mirrors, and
the one property that closes off half the literature ([Ch 61 § nothing-moves]). [Ch 62] is the
part's clearest measurement: the textbook nursery was built here, measured at **400 ms → 630 ms**
and deleted, for a reason that is not tuning — a collector that cannot move an object cannot get
survivors *out* of a nursery ([Ch 62 § why-the-obvious-design-fails-the-address-range-nursery]).
What shipped keeps the generational idea and throws away the geometry: an explicit young list,
promotion as a bit flip, and two flag bits that cost nothing
([Ch 62 § the-explicit-young-list]). [Ch 63] closes the part on the event loop — a ready queue, a
wait set, a rejection list and the loop that drains them — and on the one thing a compiled
program still cannot resolve at compile time: which coroutine a frame popped off a queue belongs
to ([Ch 63 § the-one-indirect-call]). It ends where the interpreter's chapter 30 ended, on a
rejection nobody awaited, reported byte for byte the same way
([Ch 63 § rejections-nobody-awaited]).

## What this part deliberately is not

- **Not a second compiler.** Where the two roads genuinely diverge, the divergence is always a
  value read out of `CompilerOptions` or out of `TargetModel.capabilities`, never a fork in the
  control flow of the compiler itself ([Ch 55 § one-build-two-callers]).
- **Not a whole-program rejector.** A refusal here is *per function*, and that is only a sound
  outcome because a refused function still runs. A compiler with no interpreter under it would
  have to reject `stats-refused.tera` whole — one grain coarser, and one worse answer for the
  person holding it ([Ch 56 § refusing-well]).
- **Not a moving collector, and not by omission.** [Ch 61 § nothing-moves] prices the change at
  three backends' code generators plus the register allocator of [Ch 66], and
  [Ch 62 § the-numbers] is the measurement that says what the property cost.
- **Not managed by a pass manager at the module level.** `stage()` in the AOT driver is nine
  lines and, with no tracer configured, is `run()` and nothing else: no `preserves`, no
  `requires`, no invalidation, and no order test beside it
  ([Ch 55 § seventeen-module-stages]).

## Where the running example cannot reach

`docs/example/stats.tera` reaches more of this part than of any other — it compiles clean to a
real PE executable, and it carries chapter 55's declared-parameter `CheckSmi`, chapter 57's
class layout (`Series` is 1,040 bytes: `name` as 1,024 bytes of inline text at offset 8,
`values` as one pointer at 1,032), chapter 59's static string buffers `sb0`/`sb1`, chapter 60's
whole `_FixedDigits` prelude and chapter 61's root frames. What it cannot reach, each chapter
states in its own opener rather than inventing a tenth spine file
([Conventions § 2](../CONVENTIONS.md)):

- **Polymorphic dispatch.** `docs/example/stats-poly.tera` is nominated by
  `docs/example/README.md` and **does not reach dispatch at all**: `fn report(s)` declares no
  parameter type, so `requireDeclaredParameters` throws before the class table is consulted.
  [Ch 57] uses `examples/design-pattern/20_state.tera`, already in the tree, and both chapters
  carry the finding as a `> **Broken.**`.
- **Higher-order monomorphisation.** `docs/example/stats-closure.tera` calls `values.map(...)`,
  which no backend implements, so the entry point is left out entirely. Its `scaler`/`scale`
  half *does* compile and is [Ch 58]'s closure-conversion listing; monomorphisation itself
  appears only as a probe.
- **The collector actually collecting.** Five floats and a handful of prelude objects will not
  fill a one-gigabyte arena, and no variation file would. [Ch 61] and [Ch 62] use
  allocation-heavy programs of their own and say so.
- **Coroutines and the event loop.** That is `docs/example/stats-async.tera`, which also
  compiles clean and prints the same two lines. Timers are out of reach even for it — nothing in
  the example set sleeps — and an unhandled rejection is out of reach because every example
  succeeds.
- **A refusal.** That is `docs/example/stats-refused.tera`, [Ch 56]'s worked example: one
  problem, three messages, three registers. Its two *repaired* versions are deliberately not in
  the example set, because `tests/e2e/docs/book-examples.test.ts` pins one expected output per
  file and a file whose whole point is to stop being refused has two.
- **Non-ASCII text and a refused string lifetime.** `stats.tera` contains no non-ASCII character
  and nothing it builds outlives its storage, so [Ch 59]'s second half works from named scratch
  programs, one of them copied character for character out of a test so it cannot rot silently.

## Verify it yourself

```bash
# which backends exist, their platforms, and which one writes its own bytes
node dist/cli.js targets

# the whole road, twice, one answer
node dist/cli.js docs/example/stats.tera
node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe && /tmp/stats.exe

# every pass dumped. NOTE: --emit source writes a DIRECTORY at -o, not a file
node dist/cli.js compile docs/example/stats.tera --emit source --target c \
  -o /tmp/stats-c --print-after-all > /tmp/stats-passes.txt 2>&1

# 21 graphs, and 72 distinct pass names: ir-builder + 33 middle end + 38 more
grep -c '^\*\*\* IR after #-1 ir-builder' /tmp/stats-passes.txt
grep -o '\*\*\* IR after #[0-9-]* [a-z0-9-]*' /tmp/stats-passes.txt | sed 's/.* //' | sort -u | wc -l

# 206 frame states, then none, at legalization #36 frame-state-elision
for p in 35 36; do printf "after #%s: " "$p"; awk -v P="*** IR after #$p " \
  'index($0,P)==1{on=1;next} index($0,"*** IR after")==1{on=0} on' \
  /tmp/stats-passes.txt | grep -c '!fs'; done

# and no guard node survives #40 capability-check
awk -v P="*** IR after #40 " 'index($0,P)==1{on=1;next} index($0,"*** IR after")==1{on=0} on' \
  /tmp/stats-passes.txt | grep -c '= Check'

# 49 places the legality analysis can refuse; the promised closing clause appears 25 times
grep -c "this.fail(" src/optimizing/analyses/aot-legality.ts
grep -c "keep this part interpreted" src/optimizing/analyses/aot-legality.ts

# one problem, three messages, three registers, exit 1
node dist/cli.js compile docs/example/stats-refused.tera -o /tmp/refused.exe; echo "exit=$?"

# refused before the class table is ever consulted, and not for polymorphism
node dist/cli.js compile docs/example/stats-poly.tera -o /tmp/poly.exe; echo "exit=$?"

# coroutines, the drain loop and the one indirect call
node dist/cli.js compile docs/example/stats-async.tera -o /tmp/async.exe && /tmp/async.exe

# structural dispatch: the interpreter and the binary agree
node dist/cli.js examples/design-pattern/20_state.tera
node dist/cli.js compile examples/design-pattern/20_state.tera -o /tmp/state.exe && /tmp/state.exe

npx vitest run --project unit tests/optimizing/analyses/aot-legality.test.ts \
  tests/optimizing/metadata/class-table.test.ts
```

Run on this tree, one command per fresh process, 2026-09-09. The two `stats` runs print
`latency mean=15.70` and `throughput mean=898.19`; so does the `stats-async` binary. The counts
print `21`, `72`, `206`, `0`, `0`, `49` and `25`. `stats-refused` prints two warnings and an
entry-point error and exits 1; `stats-poly` prints the two-line undeclared-parameter refusal and
exits 1. Both `20_state` runs print `state: published | already published`.

Three flag traps are worth naming, because each one costs an afternoon.
`--print-after-all` and `--verify` are **compile-only**. `--emit source -o PATH` writes a
**directory** at `PATH`. And on a Windows host with no `--platform`, an emitted `.s` carries
COFF/PE directives — pass `--platform linux` if you want ELF ones.

## What Part X receives

The program complete, as `ModuleIR`: many `CFGFunction`s, every `frameState` nulled, every guard
gone, `graph.emits` and `graph.capabilities` stamped from the chosen `AotBackend`, the
whole-module `stringEscapes` and `wideText` summaries stamped back on, one `AotLegality` per
admitted function carrying a scalar for every value, a dense root-slot numbering, a set of
`AotStringBuffer`s and a parameter/return signature — and the `ClassTable` beside it, which
Part X emits twice, as `tera_classes[]` in C and as a `TERA_CLASS_RECORD`-shaped machine data
section.

Four of those functions were written by this part rather than by the user — `tera_drain`,
`tera_report_rejections`, and, when the program sleeps, `tera_wake` and `sleep` — and they
arrive with **no special status whatever**. Part X selects, schedules, allocates and encodes them
with the machinery that handles `report`, and cannot tell them apart
([Ch 63 § what-leaves]).

One obligation goes with them, and it is a single opcode. `IR_GENERIC_CALL` applied to a value
whose scalar is `SCALAR_CODE` — `tera_drain`'s `call *%rax` — is the one site in a compiled tera
program where the backend must lower a call whose target is a register rather than a symbol.
Everything else this part touched became a name: a closure became a frame plus a direct call, an
interface method became a comparison ladder, a higher-order argument became a clone. That one
indirect call is what a ready queue *is*, and it is the last thing Part IX hands over, to
[Ch 64](../part-10-bytes/64-machineir-and-instruction-selection.md).
