# 49. Speculative Types Are Not Facts   ⟨J · N⟩

> **Status:** outline

**Thesis.** A type derived from a guard is only true where the guard survives, and one of the
four engines deletes every guard.

**What arrived.** From [Ch 48](48-types-and-representations-in-the-middle-end.md): the graph
after `type-narrowing`, plus the thing that pass consulted and the graph does not hold — the
cached `TypeInference` result under `typeInferenceAnalysisId`. It answers two questions per
node, not one: `typeOf(value)` and `isSpeculative(value)`.

**What leaves.** The same graph and the same analysis, with one new fact established about
every fold, guard removal and branch rewrite still to come: **ask `isSpeculative` before you
ask anything else.** Chapter 50's inliner is the first pass downstream that copies guarded
values into a caller where the guard's dominance no longer holds.

**New ideas.** *Provenance* — the difference between "this value is a number" and "this value
is a number **because** a check said so"; a *taint set* propagated in the same worklist as a
dataflow analysis; *discharging* a guard (proving it and deleting it) as opposed to
*executing* it.

**Length.** 12 pages

## Anchors

- `src/optimizing/analyses/type-inference.ts` — the whole file, 162 lines.
  `SPECULATIVE_SOURCES` (30-38, exactly seven opcodes); the `TypeInference` interface (25-28)
  with **two** methods; `TypeSolver.speculative` (52); `solve` (91-106) — one worklist
  advancing types *and* taint; `propagateSpeculation` (120-128); the key line in `solve`:
  `if (!this.propagateSpeculation(node) && !grew) continue;` (103), which is what makes taint
  spread even when the type has stopped growing; `observersOf` (108-118);
  `seedParameters` (75-83).
- `src/optimizing/types/lattice.ts` — `SingletonType` (35-38), `ObjectType` (40-44),
  `ArrayType` (46-49). Read these three shapes as **the reason the taint set has to exist
  separately**: a lattice element is `{kind, nullable?}` or `{kind, map, nullable}` or
  `{kind, elementsKind}`, and there is nowhere in any of them to record *where the fact came
  from*.
- `src/optimizing/passes/type-narrowing.ts` — `definedComparison` (247-259), the **only**
  caller of `isSpeculative` in the tree; `NULLISH_COMPARISONS` (78-83) and `DEFINED_KINDS`
  (85-93); `foldDefinedComparison` (261-274). The guard order in `definedComparison` is the
  chapter's rule made executable:
  `isSpeculative` → `acceptsNull` → `DEFINED_KINDS.has(kind)`.
- `src/optimizing/ir/operations.ts` — `SPECULATION_NONE` / `SPECULATION_BASE_GUARD` /
  `SPECULATION_NATIVE_GUARD` (197-204) and `speculationRoleOf`; the eight `guard(...)` entries
  at 839, 846, 852, 858, 864, 871, **878**, 884; `guardTransfer` (383-385), which is literally
  `narrowType(inputType(node,0), fact(node))` — every guard opcode narrows, which is why every
  guard opcode is a provenance source.
- `src/optimizing/passes/speculation-lowering.ts` — `STRATEGIES` (172-176) mapping the three
  `SpeculationKind`s; `proveOrGeneric` (110-164); the `passthrough` list (123-124) and the
  loop at 141-145 that replaces each guard with its own input and removes it; `isProven`
  (102-104) reading `noOverflow`; `DESPECIALIZE` (61-70); `GENERIC_LOWERINGS` (74-94).
- `src/optimizing/target/speculation.ts` — 16 lines. Three kinds
  (`deopt-to-interpreter`, `guard-with-slowpath`, `prove-or-generic`) and two exported
  strategies. `deoptToInterpreter` is wasm's; `proveOrGeneric` is C's and x64's.
- `src/optimizing/passes/parameter-guards.ts` — `GUARD_BY_KIND` (8-14): the pass at **ordinal
  0** that turns a declared parameter type into a guard node, including
  `TypeKind.String → irCheckPrimitive(param, "string")`. This is where the bug in the Honesty
  items is born.
- `src/optimizing/pipeline.ts:156-166` — `type-narrowing` at ordinal 8, requiring
  `dominanceId` and `typeInferenceId`; `src/optimizing/target/legalization.ts` —
  `speculation-lowering` at legalization ordinal 13.

## Worked example

`return n == null` compiled to native C, in a function where every ingredient is present.
The three ingredients, from the tree's own regression test
(`tests/e2e/optimizing/aot/null.test.ts` > `"answers a nullable parameter compared against null, beside a null store"`):

```
class Box:
  public link: Box | null = null
  public constructor(v: int):
    this.v = v

fn probe(n: int | null, b: Box) -> bool:
  b.link = null
  return n == null
```

1. a **nullable declared parameter**, so `parameter-type-guards` inserts a guard at ordinal 0;
2. a **comparison against `null`**, so `definedComparison` is asked the question at all;
3. a **second null store into a reference field**, which is what stops the whole thing being
   simplified away before it gets interesting — without `b.link = null` nothing forces the
   value into the shape that wraps it in a check.

Correct output today, from the C backend:

```c
int32_t probe(double p0, unsigned char *p1) {
  ...
  const int32_t v3 = tera_f64_absent(p0) == tera_f64_absent(v1);
  ...
  return v3;
}
```
— a real runtime test. The historical bug emitted a *constant*:

```c
  const int32_t v1 = 0;
  ...
  return v1;
```

The interpreter answers `true` then `false`; the binary answered `false` twice. The chapter
shows both C listings side by side, because the second is what "a speculative type treated as
a fact" looks like after it has passed through every downstream pass and a code generator.

## Outline

- [ ] **`> **New idea.**` Provenance: two ways to know the same thing.** Establish the
      distinction with two functions the reader can hold at once:
      `fn f(n: int) -> bool: return n == null` — `n` is not null *because the source says so*;
      and the same body where `n`'s only claim to being an `int` is a `CheckSmi` a pass
      inserted. Establish that the lattice answers both with the identical element
      `{kind: "Smi"}`, and that this is not a defect of the lattice: a lattice element is a
      *set of values*, and provenance is not a set of values. It needs a second channel.
- [ ] **The second channel is one `Set`, filled by the same worklist.** Establish
      `SPECULATIVE_SOURCES` — seven opcodes, all checks — and then quote the propagation:

      ```ts
      private propagateSpeculation(node: ir.CFGInstruction): boolean {
        if (this.speculative.has(node)) return false;
        const tainted =
          SPECULATIVE_SOURCES.has(node.type) ||
          node.inputs.some((input) => this.speculative.has(input));
        if (!tainted) return false;
        this.speculative.add(node);
        return true;
      }
      ```
      — src/optimizing/analyses/type-inference.ts:120-128

      Establish the three properties that make this cheap: it is *monotone* (a node is only
      ever added), it is *transitive through inputs*, and it rides the type worklist rather
      than needing one of its own. Then establish the line that makes it correct:
      `if (!this.propagateSpeculation(node) && !grew) continue;` — the solver keeps pushing
      observers when taint spreads even though the type stopped changing. Without that
      conjunct, taint would stop at the first node whose type had already converged.
- [ ] **`> **New idea.**` Why the JIT would have been fine.** Establish the asymmetry that is
      this book's hinge, stated for the first time as a *soundness* argument rather than a
      capability one. In the JIT the `CheckSmi` is still in the emitted code; a value that
      reaches the fold has passed the check, or control never got there. So `n` really is a
      number at that program point and folding `n == null` to `false` is correct. In the
      native compiler the check is **gone by the time the code is emitted** — so the fold is a
      claim about a value nothing tested. Establish that this is not "AOT is more
      conservative"; it is "the same graph means two different things depending on what
      happens to the guards".
- [ ] **Where the guards go: `speculationLowering`.** Establish the three strategies and which
      target picks which (`deopt-to-interpreter` for wasm — a no-op that returns 0 —
      `prove-or-generic` for C and x64). Then quote the deletion:

      ```ts
      for (const node of passthrough) {
        editor.replaceAllUses(node, node.inputs[0]!);
        editor.remove(node);
        changed++;
      }
      ```
      — src/optimizing/passes/speculation-lowering.ts:141-145

      Establish `passthrough`'s membership test — `SPECULATION_BASE_GUARD` always,
      `SPECULATION_NATIVE_GUARD` too when `lowerGenerics` — so under `prove-or-generic`
      **every** guard opcode in the graph is replaced by its own input. Establish the second
      half of the pass as the thing that makes deletion safe: an `Int32Add` without
      `noOverflow` is *despecialized* to `Float64Add` rather than left to wrap, and a
      `GenericAdd` whose operands may be numeric is lowered to `Float64Add`. Cross-reference
      [Ch 55 § no-way-out] and [Ch 56 § refusing-well].
- [ ] **The single consumer.** Establish that `isSpeculative` has exactly **one** call site in
      `src/` — `definedComparison` (`type-narrowing.ts:255`) — and quote the four lines in
      order:

      ```ts
      if (value === null) return null;
      if (this.types.isSpeculative(value)) return null;
      const type = this.typeAt(value);
      if (acceptsNull(type)) return null;
      return DEFINED_KINDS.has(type.kind) ? result : null;
      ```
      — src/optimizing/passes/type-narrowing.ts:254-258

      Establish that the `isSpeculative` test comes **before** `acceptsNull`, and why the order
      is not cosmetic: `acceptsNull` reads `this.typeAt(value)`, which prefers the narrower's
      own refinement map — the very map the guard just wrote into. Asking `acceptsNull` first
      would answer using the fact whose provenance you were about to check.
- [ ] **The three tests that draw the line.** Establish them as one experiment with one
      variable. All three build `fn test(p0: <declared>) -> bool: return p0 == null`; only the
      declared type and the presence of a `CheckSmi` change:
      - `"folds it away when the value is declared as one that cannot be null"` — declared
        `int`, no guard: folded, `compare.block` is `null`.
      - `"keeps it when the value is declared as one that can be null"` — declared
        `int | null`, no guard: kept.
      - `"keeps it when only a speculation says the value cannot be null"` — declared
        `int | null`, **wrapped in `checkSmi`**: kept.

      Establish that the third test is the entire chapter in nine lines, and that it fails —
      by folding — the moment the `isSpeculative` line is deleted.
- [ ] **War story, told as engineering.** Symptom: `print(probe(null, b))` printed `false`
      from a native binary and `true` from the interpreter, with no diagnostic anywhere.
      Mechanism: `parameter-type-guards` (ordinal 0) wrapped the nullable parameter in a check;
      `type-narrowing` (ordinal 8) read the narrowed type as a fact and folded the comparison
      to a constant; `speculation-lowering` deleted the guard; the C backend emitted
      `const int32_t v1 = 0`. Fix: `SPECULATIVE_SOURCES` plus one line in `definedComparison`.
      Regression test: the three `comparing against null` unit tests plus the three e2e ones in
      `tests/e2e/optimizing/aot/null.test.ts`. **General rule** — and this is what the chapter
      exists to install: *any* fold, guard elimination or branch removal that reads a type must
      ask `isSpeculative` first; a type is only usable as a fact if the target keeps the thing
      that established it.
- [ ] **Why the obvious design fails: put `speculative` in the lattice.** Stage it — add
      `speculative?: boolean` to `SingletonType` and let `narrowType` set it. Establish why
      the tree did not: `LatticeType` values are **interned frozen singletons**
      (`SINGLETONS`, `lattice.ts:53-…`), compared with `typeEquals` and used as map keys, and
      `joinTypes` is a pure function of two elements. A provenance bit would double the
      singleton table, make `typeEquals` provenance-sensitive (so the solver's `grew` test
      would start reporting changes that are not type changes), and put a *path* property
      inside a *value* property. The set is the cheaper and more honest structure.
- [ ] **What the taint set does not cover, and what that costs.** See Honesty items. Establish
      the shape of the gap in one sentence — the set is a hand-maintained list of opcode
      names, while `guardTransfer` is a *derived* property of the operation table, and the two
      have already drifted by one entry — and then establish the fix that would make drift
      impossible: derive `SPECULATIVE_SOURCES` from the operation table the way
      `ALWAYS_BOOLEAN` is derived ([Ch 47 § producesboolean]), e.g. every opcode whose
      `speculation` role is not `SPECULATION_NONE`.
- [ ] **Invariant → enforcement → test.** State it: *a value in the speculative set may not
      have its type used to remove code.* Enforcement: one `if` in one pass. Test: the three
      titles above. Then earn the `> **Unenforced.**` — nothing prevents a new pass from
      calling `types.typeOf` and folding, and there is no lint, no wrapper type and no
      assertion. Establish the one structural mitigation that does exist: `TypeInference` is an
      *interface* with two methods, so a consumer that takes the interface has
      `isSpeculative` in scope whether or not it calls it.
- [ ] **Closing: this is the hinge, in miniature.** Establish the summary the rest of the book
      reuses: **one** builder emits `CheckSmi`; the JIT treats that node as a *bailout point*
      and keeps it; the native compiler treats it as an *assertion to be discharged* and
      deletes it. Every difference between the two roads out of the middle end is a
      consequence of that one sentence, and this chapter is where it first has a wrong answer
      attached to it. Forward-reference [Ch 55 § no-way-out], [Ch 56 § refusing-well] and
      [Ch 83 § agreement].

## Honesty items

> **Broken.** `IR_CHECK_PRIMITIVE` is the eighth guard opcode and it is **not** in
> `SPECULATIVE_SOURCES` (`src/optimizing/analyses/type-inference.ts:30-38`), so the bug this
> chapter documents as fixed is still live for `string` and `boolean` parameters. Guard
> entries carrying a narrowing `guardTransfer` sit at `operations.ts` lines 839, 846, 852,
> 858, 864, 871, **878** and 884; the taint set names seven of the eight, and 878 —
> `[IR_CHECK_PRIMITIVE]: guard(ONE_INPUT, RESULT_CONTEXTUAL, guardTransfer(primitiveTypeNamed(...)), SPECULATION_BASE_GUARD)`
> — is the one it omits. `GUARD_BY_KIND` in `src/optimizing/passes/parameter-guards.ts:8-14`
> maps `TypeKind.String` and `TypeKind.Boolean` to exactly that opcode, so a declared
> `string | null` parameter reaches `definedComparison` with a speculative type the analysis
> reports as clean. **Measured 2026-09-07**, same three ingredients as the worked example:
>
> ```
> fn probe(s: string | null, b: Box) -> bool:
>   b.link = null
>   return s == null
> ```
>
> The interpreter prints `true` then `false`. The PE binary and the C backend both print
> `false` twice. `--print-after-all` names the pass and the node:
> `*** IR after #8 type-narrowing [changed] ***` turns
> `v5 = GenericCompare v7, v4 [op="loose=="]` — where `v7 = CheckPrimitive v0 [primitive="string"]` —
> into `v9 = Constant [value=false]`, and the C backend emits `const int32_t v1 = 0; … return v1;`
> with `(void)p0;` above it. Substituting `int | null` (a `CheckSmi`, which *is* in the set)
> gives the right answer, which isolates the taint set as the difference. `bool | null` does
> not reproduce. Cost of fixing: one entry in `SPECULATIVE_SOURCES`, or — better, and the
> reason this belongs in the book — deriving the set from the operation table's `speculation`
> role so the eighth guard cannot be forgotten again. No test covers a nullable `string`
> parameter compared against null; `tests/e2e/optimizing/aot/null.test.ts` tests `int | null`
> only.

> **Unenforced.** Nothing checks that a consumer of `TypeInference.typeOf` has asked
> `isSpeculative`. `isSpeculative` has exactly one call site in `src/`
> (`type-narrowing.ts:255`), while `typeOf` has many, and the interface is the only thing
> putting the second method in front of a reader. The general rule this chapter states is
> carried by prose and three tests, not by a type or an assertion.

> **Unenforced.** `SPECULATIVE_SOURCES` is a hand-written `Set<string>` of opcode names, while
> the property it is trying to name — "this opcode narrows its input's type" — is already a
> derived fact of the operation table (`guardTransfer`, `operations.ts:383-385`) and is already
> spelled a second way as the `speculation: SpeculationRole` field. Three spellings of one
> idea, one of them manual; the `IR_CHECK_PRIMITIVE` bug is what that costs.

> **Unfinished.** `guard-with-slowpath` is one of the three `SpeculationKind`s
> (`src/optimizing/target/speculation.ts:1-4`) and no target in the tree selects it: the wasm
> target uses `deoptToInterpreter` and the C, x64 and riscv64 targets use `proveOrGeneric`.
> `proveOrGeneric(…, lowerGenerics = false)` — the branch it would take — is therefore
> reachable only from a hand-built `TargetModel`. Finishing it would mean a backend that keeps
> the guard and emits a generic slow path beside the fast one, which is the design the book
> names but does not have.

## Verify it yourself

```bash
grep -n "SPECULATIVE_SOURCES" -A 10 src/optimizing/analyses/type-inference.ts
grep -rn "isSpeculative" src/ | grep -v "analyses/type-inference.ts"
grep -n "guard(" src/optimizing/ir/operations.ts | sed -n '1,12p'
printf 'class Box:\n  public link: Box | null = null\n  public constructor(v: int):\n    this.v = v\n\nfn probe(s: string | null, b: Box) -> bool:\n  b.link = null\n  return s == null\n\nb = Box(1)\nprint(probe(null, b))\nprint(probe("hi", b))\n' > /tmp/strnull.tera
node dist/cli.js /tmp/strnull.tera
node dist/cli.js compile /tmp/strnull.tera -o /tmp/strnull.exe && /tmp/strnull.exe
npx vitest run --project unit tests/optimizing/passes/type-narrowing.test.ts
```

## Tests that pin this

- `tests/optimizing/passes/type-narrowing.test.ts` > `"folds it away when the value is declared as one that cannot be null"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"keeps it when the value is declared as one that can be null"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"keeps it when only a speculation says the value cannot be null"`
- `tests/e2e/optimizing/aot/null.test.ts` > `"answers a nullable parameter compared against null, beside a null store"`
- `tests/e2e/optimizing/aot/null.test.ts` > `"answers it the same way through the C backend"`
- `tests/e2e/optimizing/aot/null.test.ts` > `"branches on a nullable parameter beside a null store"`
- `tests/e2e/optimizing/aot/null.test.ts` > `"refuses returning null where a number is declared"`
- `tests/e2e/optimizing/aot/null.test.ts` > `"still refuses a reference whose type admits both absences, since they share one pointer"`
- `tests/optimizing/ir/operations.test.ts` > `"keeps the effect classifications mutually exclusive"`
- `tests/optimizing/ir/operations.test.ts` > `"declares an entry for every exported opcode constant"` — the closest thing
  in the tree to a table-completeness check, and the model for the fix the Honesty items
  propose.
- **No test covers a nullable `string` or `boolean` parameter compared against `null`.**
  `[unpinned]` — that gap is exactly the shape of the live bug above.
