# Glossary

Every term names the file that defines it. Where the same English word means different
things in different tiers, both meanings are given — that collision is the single most
common way to misread this engine.

> **Status:** scaffold. Terms are added as chapters are written; each entry must name a
> real file. See [Conventions § 18](CONVENTIONS.md).

## The words that mean two things

**handle**
1. *Interpreter/JIT.* An index into the `ValueHeap` side table — every non-Smi value is a
   monotonically increasing integer id, shifted and tagged. `src/core/value/index.ts`
2. *Optimizing IR.* `REP_HANDLE`, the representation a value must have at a `return`.
   `src/optimizing/types/representation.ts`
3. *AOT.* A **root slot** is deliberately **not** a handle. It mirrors a pointer rather than
   naming one, which is exactly why the native collector cannot move objects.
   `src/optimizing/target/runtime-layout.ts`

**map**
1. *Interpreter.* A hidden class — the shape descriptor an object points at, including its
   prototype. `src/objects/maps/hidden-class.ts`
2. *AOT.* A **class-table entry** — a static layout with no runtime shape at all.
   `src/optimizing/metadata/class-table.ts`
3. *The language.* `Map`, the collection, compiled ahead of time as a generated tera hash
   table. `src/optimizing/prelude/collections.ts`

**type**
1. *Checker.* A normalized **string**. Type equality is string equality.
   `src/frontend/checker/type-system.ts`, `src/core/type-text.ts`
2. *Middle end.* A point in the `LatticeType` abstract lattice.
   `src/optimizing/types/lattice.ts`
3. *Backend.* An `AotScalar` — a native machine kind that cannot convert.
   `src/optimizing/types/scalar.ts`

## Values and objects

**Smi** — a small integer that rides inline in the tagged word instead of being heap
allocated. `src/core/value/index.ts`

**tagged value** — the four-bit tag plus payload that every runtime value is.
`src/core/value/index.ts`

**hidden class / shape / map** — the descriptor that says where an object's fields live, so
a field read can be an offset instead of a hash lookup. Its identity includes the
prototype. `src/objects/maps/hidden-class.ts`

**transition tree** — the graph of hidden classes, edged by "add this property", that lets
objects built the same way share a shape. `src/objects/maps/hidden-class.ts`

**elements kind** — how an array's storage is packed (packed doubles, holey, tagged), as a
lattice that only ever widens. `src/objects/elements/elements-kind.ts`

**exotic object** — an object whose property access does not follow the ordinary rules:
proxies, function members, symbol-keyed properties. `src/objects/exotic/`

## Learning from execution

**feedback vector** — the per-function side table where the interpreter records what it
actually saw at each site. `src/feedback/vector/index.ts`

**inline cache (IC)** — a per-site cache of "last time, the receiver had this shape and the
answer was at this offset", with states uninitialized → monomorphic → polymorphic →
megamorphic. `src/feedback/ic/index.ts`

**tiering** — the policy that decides when a function is hot enough for the next compiler.
`src/runtime/tiering/defaults.ts`, `src/runtime/tiering/adaptive.ts`

**on-stack replacement (OSR)** — entering a compiled version of a loop that is *already
running*, without waiting for the call to return. `src/runtime/tiering/osr.ts`,
`src/optimizing/passes/osr.ts`

**safepoint** — a point where the collector is allowed to run because the machine state is
describable. `src/runtime/tiering/defaults.ts` (`BACK_EDGES_PER_SAFEPOINT`)

## Speculating, and taking it back

**speculation** — compiling a fast path that is only correct if a guess holds, plus a guard
that checks the guess. `src/optimizing/passes/speculation-lowering.ts`

**guard** — the check that makes a speculation safe. The JIT inserts one; the native
compiler must instead prove the fact or refuse. `src/optimizing/passes/guards.ts`

**frame state** — a description of the interpreter frame that *would* exist, carried
alongside optimized code so a bailout can rebuild it. Frame states count as **uses** of a
value. `src/deopt/frame-state.ts`, `src/optimizing/ir/frame-state-values.ts`

**deoptimization** — abandoning optimized code mid-execution and resuming in the
interpreter from a frame state. `src/deopt/deoptimizer.ts`

**dependency** — a promise the runtime makes to compiled code (e.g. "this elements kind
will not change"), which the runtime must invalidate if it breaks.
`src/deopt/dependencies.ts`

**speculative type** — a type that is only true because a guard says so. It is **not a
fact**: folding on one is unsound in AOT, where the guard is dropped.
`src/optimizing/analyses/type-inference.ts`

## The intermediate representation

**basic block** — a run of instructions with one entry and one exit.
`src/optimizing/ir/index.ts`

**control-flow graph (CFG)** — blocks plus the edges between them. tera uses a CFG, *not* a
sea of nodes. `src/optimizing/ir/index.ts`

**SSA** — static single assignment: every value is written exactly once, so "where did this
come from" has one answer. `src/optimizing/builder/ir-builder.ts`

**phi** — the node at a merge point that says "this value is whichever one arrived". Its
inputs are parallel to the block's predecessors — that parallelism is the sole source of
truth. `src/optimizing/ir/index.ts`

**dominator** — block A dominates B if every path to B goes through A. Computed by
Cooper–Harvey–Kennedy iteration. `src/optimizing/analyses/dominance-core.ts`

**def-use edge** — the link from a definition to each place that reads it, kept as a
multiset so `add(v, v)` counts twice. `src/optimizing/ir/graph-edit.ts`

**OperationSpec** — the one table that gives every IR opcode its arity, effects, result
class and type transfer function. `src/optimizing/ir/operations.ts`

## The middle end

**pass** — one transformation over the graph. `src/optimizing/passes/` (60 files)

**analysis** — a cached computation passes ask for, invalidated when a pass says it changed
something. `src/optimizing/analyses/` (11), `src/optimizing/infra/analysis-manager.ts`

**pass manager** — what runs passes in order, tracks what each preserves, and verifies the
graph after each one. `src/optimizing/infra/pass-manager.ts`

**opt-bisect** — LLVM's `-opt-bisect-limit`: run only the first N passes, to find the one
that broke your program. Only `optional` passes may be skipped.
`src/optimizing/infra/opt-bisect.ts`

**lattice** — an ordered set of abstract types with a join, so an analysis can merge facts
from two branches and always terminate. `src/optimizing/types/lattice.ts`

**fixpoint** — iterating an analysis until nothing changes.
`src/optimizing/analyses/type-inference.ts`

**representation selection** — deciding, for each value, whether it is held tagged,
untagged, or as a handle. `src/optimizing/passes/repr-selection.ts`

**escape analysis** — proving an object never outlives its function, so it can be replaced
by scalars or never allocated. `src/optimizing/passes/escape-analysis.ts`

**points-to analysis** — inclusion-based (Andersen) reasoning about which allocation sites a
value can hold. `src/optimizing/analyses/points-to.ts`

**legalization** — rewriting an opcode a target cannot emit into ones it can, instead of
refusing. `src/optimizing/passes/operation-legalization.ts`, `src/optimizing/target/legalization.ts`

## The machine

**MachineIR** — the target-independent instruction layer below SSA: physical and virtual
registers, memory operands, stack slots. `src/optimizing/machine/ir.ts`

**instruction selection** — choosing machine instructions for IR nodes, via a dispatch
table rather than a tree matcher. `src/optimizing/machine/select.ts`

**linear scan** — register allocation over live intervals sorted by start point, rather
than by graph colouring. `src/optimizing/machine/linear-scan.ts`

**live range splitting** — cutting an interval so part of it can live in a register.
Implemented, measured, and **switched off** because the numbers said so.
`src/optimizing/machine/linear-scan.ts`, `src/optimizing/options.ts`

**ABI** — the calling convention: which registers carry arguments, who saves what, how the
stack is shaped. `src/optimizing/target/abi.ts`

**relocation** — a hole in emitted code that the linker (or the self-linker) fills once an
address is known. `src/optimizing/mc/assembler.ts`

**unwind table** — the data a debugger or exception mechanism uses to walk back up the
stack: `.pdata`/`.xdata` on PE, `.eh_frame` on ELF. `src/optimizing/mc/dwarf/eh-frame.ts`

## Ahead of time

**AOT legality** — the analysis that decides whether a function can be compiled natively at
all. `src/optimizing/analyses/aot-legality.ts`

**refusal** — a first-class answer. The native compiler declines a function, names why, and
still ships a binary where it can. `src/optimizing/drivers/aot.ts`

**scalar** — a native machine kind in AOT (`SCALAR_TEXT`, `SCALAR_CODE`, …). Unlike a
representation, it does not convert. `src/optimizing/types/scalar.ts`

**prelude** — the parts of the AOT runtime written **in tera source** and compiled with the
program: hash tables, number parsing, transcendentals, fixed-point text.
`src/optimizing/prelude/`

**shadow stack** — the explicit list of live references the native collector walks, since
there is no VM to ask. `src/optimizing/target/runtime-layout.ts`

**arena** — the AOT heap: mark-sweep with a coalescing free list, and a young generation
that does not move. `src/optimizing/backends/c/emit.ts`

**string boxing** — copying a produced string into a one-field object so it can outlive the
call that made it. `src/optimizing/passes/string-boxing.ts`

**monomorphisation** — compiling one specialized copy of a higher-order function per
function argument, because there are no code pointers.
`src/optimizing/passes/function-argument-specialization.ts`

**two absences** — `null` and `undefined` are distinct in AOT, carried as two NaN payloads.
References carry only `null`. `src/optimizing/types/scalar.ts`
