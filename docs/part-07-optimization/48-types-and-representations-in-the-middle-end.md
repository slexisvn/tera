# 48. Types and representations in the middle end   ⟨J · N⟩ narrowing · ⟨J⟩ representation selection

> **Status:** outline

**Thesis.** A representation may be narrowed by a proof about the value, never by the absence
of a demand — and a function returns one scalar with one whole-function interpretation.

**What arrived.** The smallest graph the middle end will produce: no unreachable block, no
trivial phi, no phi nothing reads, no node whose value nothing observes, `Int32Mul` by a small
constant rewritten into a shift and at most one add, and every `Int32Add`/`Sub`/`Mul` either
stamped `noOverflow` or already widened to `Float64*`. What it does *not* carry is any
statement about how each surviving value is held in a machine
([Ch 47 § what-leaves](47-simplification-dead-code-and-the-identities-that.md)).

**What leaves.** Two artifacts, produced at opposite ends of the compile. From
`type-narrowing` (ordinal 8, both tiers): the same graph with `GenericAdd`/`Sub`/`Mul`/`Mod`/
`Compare` rewritten to `Int32*` or `Float64*` wherever a guard or a `typeof` edge proved the
operands numeric, `noOverflow` stamped where every reader truncates, and every `x == null`
that a *declared* type settles folded to a constant. From `representation-selection` (a
target-legalization pass, wasm only): every node carrying `props._rep`, `Box`/`Unbox`
conversions inserted on the edges where producer and consumer disagree, and
`graph.returnRepresentation` set to the join over every `IR_RETURN` operand. Plus one thing
the graph does not hold: the cached `TypeInference` result, which chapter 49 opens on.

**New ideas.** Flow sensitivity, and a refinement *trail* that makes a fact true only inside
a subtree; a *representation* (how a value is held in a machine) as a separate axis from a
*type* (what values it can be); boxing, unboxing and tagging; a **backward demand** analysis
beside a **forward assignment** one; the unique exit block as a virtual phi; a return ABI.

**Length.** 14 pages

## Anchors

### Narrowing

- `src/optimizing/passes/type-narrowing.ts` — the whole file, 331 lines. `GENERIC_TO_INT32`
  (22-28) and `GENERIC_TO_FLOAT64` (56-62), the two rewrite tables; `GUARD_FACTS` (64-68) —
  three entries, `CheckSmi → smiType()`, `CheckNumber → numberType()`,
  `CheckMap → objectType(expectedMapId)`; `Narrower` (122-291) with `refinements`, `refine`
  (149-152), `undo` (154-160), `walk` (276-290); `applyEdgeFacts` (162-179);
  `typeofComparison` (108-120); `specialize` (188-207); `settleInt32Arithmetic` (218-238);
  `truncates` (240-245); `TRUNCATES_ITS_INPUTS` (36-44) and `CARRIES_ITS_INPUTS` (46);
  `widenUnprovenInt32Arithmetic` (300-318).
- `src/optimizing/types/lattice.ts` — `TypeKind` (14-27, eleven kinds),
  `SingletonType`/`ObjectType`/`ArrayType` (35-51), `joinTypes` (217), `narrowType` (265),
  `excludeType` (308), `typeFromTypeof` (347), `acceptsNull` (158), `isSubtype` (181).
  Note what the shape does **not** have room for: provenance ([Ch 49 § the-taint-set]).
- `src/optimizing/analyses/type-inference.ts` — `TypeSolver.solve` (91-106), the worklist
  whose `typeOf` the narrower falls back to when it has no local refinement
  (`typeAt`, type-narrowing.ts:145-147).
- `src/optimizing/types/declared.ts` — `DECLARED_INT`, `nominalLatticeType`,
  `latticeFromDeclaredType`: how a *source* annotation becomes a lattice element.

### Representation

- `src/optimizing/types/representation.ts` — 40 lines, the whole vocabulary. Six constants
  `REP_INT32`/`FLOAT64`/`TAGGED_NUMBER`/`HANDLE`/`TAGGED`/`BOOL`, `representationFrom`
  (a total function that answers `REP_HANDLE` for anything unrecognised), `AbiRepresentation`
  (only three of the six can cross a call boundary) and `abiRepresentationOf`.
- `src/optimizing/passes/repr-selection.ts` — `representationSelection` (63-631), read as
  five phases in order: the backward demand worklist (95-130) with `joinDemand` (77-85) and
  `demandOfUse` (87-93); the forward assignment loop (223-319) plus the parameter pass
  (321-338); `reflowPhiRepresentations` (340-377); the return join (379-389);
  `getExpectedInputRep` (393-472) and `makeConversion` (474-545) inserting `Box`/`Unbox`;
  the final stamping loop (625-628). Also `producesNumber` (41-61),
  `isProvablyNumericOperand` (149-168), `joinIncomingReps` (185-218), `constantRep` (170-183),
  `isOpaqueIntrinsicResult` (633-640).
- `src/optimizing/ir/operations.ts` — `RESULT_NONE`/`INT32`/`FLOAT64`/`BOOL`/`TAGGED_NUMBER`/
  `HANDLE`/`CONTEXTUAL` (158-164), `resultClassOf` (1035), `operandClassOf` (1039),
  `overloadOf` (1043), and **`[IR_RETURN]: terminator(ONE_INPUT, RESULT_CONTEXTUAL)`** (991) —
  the declaration that says a return's operand class is decided per graph, not per opcode.
- `src/optimizing/ir/index.ts` — `CFGFunction.returnRepresentation` (262, initialised `null`
  at 297): the graph field that carries the whole-function answer.
- `src/optimizing/validation/graph-validator.ts` — `validateRepresentations` (51-76): the
  enforcement. Two errors: `"<where> v<id> <opcode> has no representation"` (every node whose
  `resultClassOf` is not `RESULT_NONE` must carry `_rep`) and
  `"B<n> v<id> returns <abi> but the graph declares <abi>"`.
- `src/optimizing/target/legalization.ts:94,100-103` — the two const-hoisted passes
  `representation-selection` and `representation-check`, spliced in only when the target has
  `tagged-values` ([Ch 51 § capabilities]).
- `src/optimizing/backends/wasm/graph-support.ts` — `boxedNumericReturns` (759-771),
  `hotBlocks` (774-786) reading `terminator.props.hotSuccessor`, and
  `hotBoxedReturnRejection` (788-803); called from
  `src/optimizing/backends/wasm/codegen.ts:510`, and `codegen.ts:1448` consuming
  `abiRepresentationOf(graph.returnRepresentation ?? REP_HANDLE)`.

## Worked example

Two functions with the *same* shape and different answers, from the tree's own regression
test (`tests/e2e/optimizing/representation.test.ts`):

```
g = {x: "hello"}
fn step(i):
  return g.x            # -> REP_HANDLE
fn scaled(a, i):
  return g.x + a        # -> REP_TAGGED_NUMBER, legitimately
```

`return g.x` is a `LoadField` whose representation is decided by `acceptsUnboxedNumber` —
that is, by **what its consumers ask for**. `return g.x + a` is unboxed because a `CheckSmi`
is on the path, i.e. because something **proved** it numeric. Relaxing `demandOfUse` so that
`IR_RETURN` demands less than `REP_HANDLE` collapses the two cases: the first `LoadField`
becomes `tagged-number`, and the JS wrapper reads the raw scalar as a number. **Measured
2026-08-18:** the program above printed **`"56"`** — the string's handle index — instead of
`"hello"`. Today it prints `hello` on all four tiers.

```
$ node dist/cli.js --opt-threshold 10 --baseline-threshold 5 --print-ir --filter step rep56.tera
fn step params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = LoadGlobal [name="g"]
    v2 = CheckMap v1 [expectedMapId=85, expectedMapVersion=0] !fs
    v3 = LoadField v2 [offset=0]
    v4 = Return v3
}
hello
```

Note what the dump does *not* show: no `rep=` on any node and no `returnRepresentation` on
the graph line. `--print-ir` fires from `onOptimize` (`src/cli/main.ts:93-96`), and the
representation stamps are added later, by the target legalization pipeline. The chapter says
this plainly — the reader who goes looking for `_rep` in a dump will not find it.

## Outline

- [ ] **`> **New idea.**` Flow sensitivity, and the price of it.** Establish the difference
      between "what can `x` hold anywhere in this function" (the `TypeInference` analysis, one
      answer per node, [Ch 42 § type-inference]) and "what can `x` hold *here*". Establish
      that the second needs a *scope*: a fact learned from `CheckSmi v6` is true only in the
      blocks that `CheckSmi` dominates, and false the moment the walk leaves that subtree.
- [ ] **The undo trail is the whole mechanism.** Quote the walk:

      ```ts
      private walk(block: ir.CFGBlock): void {
        const trail: Trail = [];
        for (const node of [...block.nodes]) {
          this.applyGuardFact(node, trail);
          if (this.foldDefinedComparison(node)) continue;
          this.specialize(node);
        }
        for (const child of this.dominance.childrenOf(block) as readonly ir.CFGBlock[]) {
          const edgeTrail: Trail = [];
          this.applyEdgeFacts(block, child, edgeTrail);
          this.walk(child);
          this.undo(edgeTrail);
        }
        this.undo(trail);
      }
      ```
      — src/optimizing/passes/type-narrowing.ts:276-290

      Establish `Trail = Array<[id, previousTypeOrUndefined]>` and `undo` replaying it
      backwards, so nesting is handled by construction. Establish the two trails per block —
      one for facts the block's own guards create, one per outgoing dominator edge — and why
      they must be undone in that order. Pin with `"propagates type facts to dominated blocks"`.
- [ ] **Two sources of facts: a guard node, and a branch edge.** `GUARD_FACTS` is three
      entries long and each is a *node* fact — reaching the guard is enough. `applyEdgeFacts`
      is an *edge* fact — it fires only for a `Branch` whose condition is an `Int32Compare`
      with `==`/`===` between a `Typeof` and a string constant, and it applies `narrowType` on
      the true edge and `excludeType` on the false one. Establish the asymmetry with
      `"does not narrow false branch to the same type as true"`: excluding `number` from `Any`
      does not leave you with `number`. Pin the positive cases with
      `"narrows true branch of typeof == 'number' to float64 arithmetic"` and
      `"narrows true branch with === operator"`.
- [ ] **Specialization is a two-tier ladder, and it fails closed.** Establish `specialize`:
      both operands `Smi` → `GENERIC_TO_INT32`; else both merely *numeric* (`Smi`, `Double` or
      `Number`) → `GENERIC_TO_FLOAT64`; else nothing happens and the generic node survives to
      be lowered by the target ([Ch 51 § speculation-lowering]). Establish that a single
      unproven operand kills the rewrite —
      `"does NOT specialize when only one input has type facts"` — and that a Smi/Number mix
      lands on float64, not int32 (`"specializes to float64 when one input is smi and other is number (both numeric)"`).
      Pin the base cases with the four `specializes …` titles.
- [ ] **`settleInt32Arithmetic`, read backwards.** This is the pass's subtlest piece and
      chapter 47 already depends on its output. Establish the question it answers: an
      `Int32Add` that *might* leave the int32 range is only safe to keep as int32 if **nobody
      can tell**. Establish the fixpoint: start by optimistically assuming every candidate
      (`this.widened` — the `Int32Add`/`Sub`/`Mul` just created) plus every phi and `Select`
      (`carriers()`) wraps; then repeatedly remove any node one of whose uses does *not*
      truncate, and push its inputs back on. Establish `truncates`: a bitwise op, another
      still-wrapping node, a `range()` call (`COUNTS_IN_INT32`), or a `Return` in a function
      whose declared return type is `int`. Establish the two outcomes — `noOverflow = true`,
      or the flag deleted **and a frame state grafted on from an input**
      (`frameStateFromInputs`), so the JIT can deopt on overflow instead. Then
      `widenUnprovenInt32Arithmetic` at ordinal 19: anything still unproven **and without a
      frame state** becomes `Float64*`. Pin the four-way split with
      `"wraps in int32 when every reader of the sum truncates it"`,
      `"settles a sum a range counts with, whatever the function answers"`,
      `"leaves the sum unproven when its reader keeps the whole number"`,
      `"answers a double for an unproven sum nothing can deoptimize"`,
      `"keeps a sum a bounds proof settled"`.
- [ ] **`> **New idea.**` Representation is not type.** Establish the second axis: a value of
      *type* `Smi` can be *held* as a raw 32-bit integer, a raw double, a tagged number, or a
      handle into a side table. Establish the six names in
      `src/optimizing/types/representation.ts` and the informal order
      `int32 < float64 < tagged-number < handle` that `joinDemand` implements. Establish
      `REP_TAGGED` as the sixth name **that this pass never assigns** (see Honesty items) and
      `AbiRepresentation` as the three that can cross a call.
- [ ] **Phase one: demand, computed backwards.** Establish the worklist over
      `node.uses` computing, per node, the *weakest* representation every consumer can live
      with, joined by `joinDemand` with an early `break` at `REP_HANDLE`. Establish
      `demandOfUse` as five lines and a default:

      ```ts
      const demandOfUse = (use: ReprNode): Demand => {
        if (use.type === ir.IR_CHECK_SMI) return REP_INT32;
        if (use.type === ir.IR_CHECK_NUMBER) return REP_FLOAT64;
        if (use.type === ir.IR_GENERIC_MOD || use.type === ir.IR_GENERIC_COMPARE)
          return REP_TAGGED_NUMBER;
        return REP_HANDLE;
      };
      ```
      — src/optimizing/passes/repr-selection.ts:87-93

      **This is the chapter's central listing.** Establish that a phi's demand is read from
      `nodeDemand` rather than from `demandOfUse`, which is what makes the loop a fixpoint
      rather than a single pass, and that only phis re-enqueue their inputs (127-129).
- [ ] **The soundness rule: `IR_RETURN` has no case here, on purpose.** Establish that the
      absence is load-bearing. A return falls to `return REP_HANDLE`, so anything a function
      returns is demanded as a handle, so an unguarded `LoadField` feeding a return stays a
      handle. Then the worked example: `return g.x` vs `return g.x + a`, and the `"56"`
      measurement. **General rule:** *demand is not proof.* A representation narrowed because
      nothing asked for the wide one is a representation narrowed on no evidence; the only
      sound narrowing is type-driven — something proved the value numeric. Cross-reference
      [Ch 49 § speculative-taint], which is the same rule stated about a different currency.
      Pin with `"keeps an unguarded field return a handle"`.
- [ ] **Phase two: assignment, computed forwards.** Establish the long `else if` chain
      (223-319) as three kinds of rule, and say so rather than reproducing it: (a) *the opcode
      decides* — `resultClassOf` gives `REP_INT32`/`FLOAT64`/`BOOL` outright; (b) *the input
      decides* — `CheckMap`/`CheckArray`/`CheckElementsKind`/`CheckBounds` inherit their
      operand's rep, `Neg` maps int32/bool to int32 and everything else to float64;
      (c) *the demand decides* — `LoadField`, `PolymorphicLoad`, `GenericCall`,
      `CallKnownFunction` and overloadable arithmetic all consult `acceptsUnboxedNumber` or
      `unboxedRepForDemand`. Establish that (c) is the only place demand feeds assignment, and
      therefore the only place the rule above can be violated. Pin the table-driven half with
      `"assigns REP_INT32 to int32 arithmetic producers"`,
      `"assigns REP_TAGGED_NUMBER to generic sub/mul/div/mod producers"`,
      `"infers constant rep from value type (int→INT32, float→FLOAT64, bool→BOOL, string→HANDLE)"`,
      `"assigns CheckNumber rep based on consumer: FLOAT64 if consumed by float64 op, else INT32"`,
      `"unboxes bitwise or, xor and not to int32"`,
      `"keeps unsigned shift as a tagged number because it can exceed int32"`.
- [ ] **Phase three: the phi reflow, and why a loop counter stays unboxed.** Establish the
      problem: a loop-header phi is visited before its back-edge input exists as an answer, so
      the forward pass would give it `REP_HANDLE` and box the counter every iteration.
      Establish the fix: `reflowPhiRepresentations` **deletes** every phi's rep, re-derives it
      with `joinIncomingReps(inputs, false)` — where `unknownIsHandle: false` means an
      undecided input is *skipped* rather than treated as a handle — and re-enqueues phi users
      on change; only afterwards does anything still unknown default to `REP_HANDLE`.
      Establish `joinIncomingReps`'s two "give up" rules: any handle wins, and a `bool` mixed
      with any number kind gives a handle. Pin with
      `"keeps loop-carried int32 phis unboxed after backedge reps are known"` and
      `"keeps a boolean merged across an if/else a boolean"`.
- [ ] **Phase four: the exit is a virtual phi.** Establish the shape of the problem — the wasm
      calling convention returns **one** scalar with **one** interpretation, so a function with
      a `string` return and an `a + 1` return has no legal signature until the two are
      reconciled. Establish the fix as literally the phi rule applied to a block that does not
      exist: collect every `IR_RETURN` operand, `joinIncomingReps(returnedValues, true)`, store
      it on `graph.returnRepresentation`, and make `getExpectedInputRep` answer it for every
      return (400) so `makeConversion` inserts the `Box`. **Why the obvious design fails:**
      the pass originally let `IR_RETURN` echo its producer's own rep, so no conversion was
      ever inserted and the wasm backend bailed out with the rejection
      `returns disagree on value representation (X vs Y)` — meaning any function mixing a
      handle return with a numeric one was silently never optimized past baseline. **That
      message is no longer in the tree** (`grep` finds it nowhere under `src/`): the backend
      check was deleted when the join landed, and the failure mode it guarded became the
      fail-fast `representation-check` error below. Quote it as history, not as something the
      reader can reproduce.
      **Measured 2026-08-18:** 61/144 mixed-return shapes compiled before, 144/144 after, zero
      differential mismatches. Pin with
      `"boxes an int32 return so every return of a function shares one representation"`,
      `"leaves returns alone when they already share one representation"`,
      `"does not truncate a float return when another return is an integer"`,
      `"keeps mixed integer and float returns exact"`.
- [ ] **Invariant → enforcement → test.** State it: *every node with a result carries a
      representation, and every return's ABI representation equals the graph's declared one.*
      Enforcement is `validateRepresentations` (`graph-validator.ts:51-76`), run as the
      `representation-check` step immediately after `representation-selection`
      (`legalization.ts:94-104`), which throws a `GraphValidationError` naming the block, the
      node and both representations. Establish that this replaced a *silent* backend rejection
      with a fail-fast internal error, and pin the ordering with
      `"never grows the graph after representation selection"`,
      `"gives every surviving node a representation once wasm lowering finishes"`,
      `"selects representations only for targets that have tagged values"`,
      `"leaves no boxing ceremony for an untagged target to strip"`.
- [ ] **The cost the fix created, and the one decline that pays for it.** Establish
      honestly: boxing a numeric return costs one wasm→JS runtime-stub call *per return*, so
      the 144/144 win makes some programs slower. Establish `hotBoxedReturnRejection` as the
      answer — a return whose operand is an inserted `Box→handle` over a numeric value, sitting
      in a block **dominated by the hot successor of a branch that has bias feedback**
      (`props.hotSuccessor`), declines the whole compile with
      `"boxes a numeric return into a handle on a hot path"`. Establish the design rule stated
      in the tree's own tests: **decline only on positive evidence** — no bias means compile —
      which is why `"still optimizes when the boxed numeric return is the cold path"` exists
      beside the three `declines …` titles. Establish that this rule can only fire on graphs
      the return-join created (a single-return function never gets a `Box` at its return), so
      it cannot regress anything older. Cross-reference [Ch 34 § branch-bias] for where
      `hotSuccessor` comes from.
- [ ] **Where this leaves the two roads.** Close by naming the split: narrowing runs for both
      targets; representation selection is spliced into the pipeline **only** when
      `target.capabilities` has `tagged-values`, which today means wasm alone. The native
      backends never see a `_rep`, never see a `Box`, and reach the same values by a different
      route — [Ch 51 § capabilities] and [Ch 59 § machine-ir].

## Honesty items

> **Unfinished.** `REP_TAGGED` is declared in `src/optimizing/types/representation.ts:5`,
> included in the `Representation` union and in the `REPRESENTATIONS` set, and is never
> assigned by `representationSelection` and never tested for anywhere in
> `src/optimizing/passes/repr-selection.ts`. `abiRepresentationOf` folds it into
> `REP_TAGGED_NUMBER` by falling through. Cost of removing it: one union member and one set
> entry, plus checking that no parsed IR fixture stamps the literal string `"tagged"`.

> **Unenforced.** Nothing states or checks the rule this chapter's thesis is about — that a
> representation may only be narrowed on a proof, never on a demand. `demandOfUse`
> (`repr-selection.ts:87-93`) encodes it by *omission*: `IR_RETURN` falls through to the
> `REP_HANDLE` default. There is no assertion, no `satisfies` constraint and no comment; the
> only thing standing between the tree and the `"56"` bug is one e2e test
> (`"keeps an unguarded field return a handle"`) and the memory note that records the
> measurement. A future reader who reads `demandOfUse` as a performance table rather than a
> soundness table will "fix" it again.

> **Unfinished.** `makeConversion` (`repr-selection.ts:474-545`) returns `null` for four
> producer/expected pairs — bool↔int32 in both directions, and every pair it does not list —
> and the two call sites both `continue` silently on `null`. So a disagreement the pass cannot
> bridge does not fail here; it fails one pass later, in `representation-check`, as an
> internal compiler error naming a node. The fail-fast is real, but the diagnostic names the
> symptom rather than the missing conversion.

> **Measured worse.** The return join makes strictly more functions compile and some of them
> slower. On the adversarial shape (`if i == 400000: return "x"` else `return a + 1`, 800k
> iterations) the newly-compiled version measured **5.8–13.8s against 2.2s** for the baseline
> tier it used to fall back to (min-of-five, one case per fresh process —
> [Ch 80 § bench-methodology]). `hotBoxedReturnRejection` recovers the case where branch bias
> is available (**3.6–7.0s declined vs 13.1–13.9s compiled**, true baseline 6.8s); where no
> bias has been recorded, the slow compile stands.

> **Unfinished.** `producesNumber` (`repr-selection.ts:41-61`) and `isProvablyNumericOperand`
> (149-168) are two overlapping answers to "is this numeric", and `isProvablyNumericOperand`
> calls the first as one of its four clauses. Neither consults `TypeInference`, which is the
> component that actually knows — so a value the type solver has proved `Smi` is still read as
> non-numeric here unless it happens to have a `CheckSmi` use or a numeric result class.

## Verify it yourself

```bash
printf 'g = {x: "hello"}\nfn step(i):\n  return g.x\nfn run(n):\n  last = 0\n  i = 0\n  while i < n:\n    last = step(i)\n    i = i + 1\n  return "" + last\nprint(run(200))\n' > /tmp/rep56.tera
node dist/cli.js --opt-threshold 10 --baseline-threshold 5 --print-ir --filter step /tmp/rep56.tera
grep -n "IR_RETURN" src/optimizing/passes/repr-selection.ts
grep -n "RESULT_CONTEXTUAL" src/optimizing/ir/operations.ts | head -3
grep -n "representation-selection\|representation-check" src/optimizing/target/legalization.ts
npx vitest run --project unit tests/optimizing/passes/repr-selection.test.ts tests/optimizing/passes/type-narrowing.test.ts
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts
```

(`rep56.tera` is the Worked example's `step`, wrapped in the `run(n)` driver loop the
regression test uses so the JIT tiers up. The book ships it as a listing rather than as a
ninth `docs/example` variation because `stats.tera` has no polymorphic return and cannot
reach this — [Conventions § 2](../CONVENTIONS.md).)

## Tests that pin this

- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes GenericAdd to Int32Add when both inputs pass CheckSmi"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes GenericSub to Int32Sub when both inputs are smi-narrowed"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes GenericCompare to Int32Compare when both inputs are smi"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes GenericAdd to Float64Add when both inputs pass CheckNumber (not smi)"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"does NOT specialize when inputs have no type checks"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"does NOT specialize when only one input has type facts"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"specializes to float64 when one input is smi and other is number (both numeric)"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"narrows integer constant + CheckSmi parameter to int32 arithmetic"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"propagates type facts to dominated blocks"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"narrows true branch of typeof == 'number' to float64 arithmetic"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"narrows true branch with === operator"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"does not narrow false branch to the same type as true"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"wraps in int32 when every reader of the sum truncates it"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"settles a sum a range counts with, whatever the function answers"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"leaves the sum unproven when its reader keeps the whole number"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"answers a double for an unproven sum nothing can deoptimize"`
- `tests/optimizing/passes/type-narrowing.test.ts` > `"keeps a sum a bounds proof settled"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_INT32 to int32 arithmetic producers"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_FLOAT64 to float64 arithmetic producers"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_BOOL to comparison producers"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"infers constant rep from value type (int→INT32, float→FLOAT64, bool→BOOL, string→HANDLE)"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_HANDLE to NewObject"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_INT32 to CheckSmi"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns CheckNumber rep based on consumer: FLOAT64 if consumed by float64 op, else INT32"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"assigns REP_TAGGED_NUMBER to generic sub/mul/div/mod producers"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"inserts Box when int32 producer feeds tagged-number consumer"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"does not insert box/unbox when reps already match"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"keeps loop-carried int32 phis unboxed after backedge reps are known"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"hoists constant phi input boxes to the constant block"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"boxes an int32 return so every return of a function shares one representation"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"leaves returns alone when they already share one representation"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"unboxes bitwise or, xor and not to int32"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"keeps unsigned shift as a tagged number because it can exceed int32"`
- `tests/optimizing/passes/repr-selection.test.ts` > `"unboxes float power to float64"`
- `tests/e2e/optimizing/representation.test.ts` > `"keeps an unguarded field return a handle"`
- `tests/e2e/optimizing/representation.test.ts` > `"does not read a numeric result as a constant-pool handle"`
- `tests/e2e/optimizing/representation.test.ts` > `"does not read a numeric result as an object handle"`
- `tests/e2e/optimizing/representation.test.ts` > `"does not read a numeric result as an array handle"`
- `tests/e2e/optimizing/representation.test.ts` > `"does not truncate a float return when another return is an integer"`
- `tests/e2e/optimizing/representation.test.ts` > `"keeps mixed integer and float returns exact"`
- `tests/e2e/optimizing/representation.test.ts` > `"still optimizes a function whose returns share one representation"`
- `tests/e2e/optimizing/representation.test.ts` > `"declines a hot numeric return that a string return forces into a handle"`
- `tests/e2e/optimizing/representation.test.ts` > `"declines a hot numeric return that an object return forces into a handle"`
- `tests/e2e/optimizing/representation.test.ts` > `"declines a hot numeric return that a boolean return forces into a handle"`
- `tests/e2e/optimizing/representation.test.ts` > `"still optimizes when the boxed numeric return is the cold path"`
- `tests/e2e/optimizing/representation.test.ts` > `"keeps a boolean merged across an if/else a boolean"`
- `tests/e2e/optimizing/representation.test.ts` > `"keeps a number flowing out of a logical operator away from the handle table"`
- `tests/optimizing/pipeline-order.test.ts` > `"never grows the graph after representation selection"`
- `tests/optimizing/pipeline-order.test.ts` > `"gives every surviving node a representation once wasm lowering finishes"`
- `tests/optimizing/pipeline-order.test.ts` > `"selects representations only for targets that have tagged values"`
- `tests/optimizing/pipeline-order.test.ts` > `"leaves no boxing ceremony for an untagged target to strip"`
- `tests/optimizing/ir/operations.test.ts` > `"separates machine representation from lattice type for instanceof and in"`
