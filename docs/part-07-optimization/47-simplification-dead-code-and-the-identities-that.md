# 47. Simplification, dead code, and the identities that are wrong   ⟨J · N⟩

> **Status:** outline

**Thesis.** In a language whose numbers are IEEE doubles, the textbook algebraic identity
list is mostly a list of bugs — and this tree's own test titles are where the reasoning is
written down.

**What arrived.** The graph at ordinal 10, immediately after `sccp` at 9: constants folded,
constant branches already `rewriteBranchAsJump`'d with their dead edges dropped, and the
now-unreachable blocks still sitting in `graph.blocks`. For `strength-reduction` at ordinal
18: the same graph after `bounds-check-elimination` at 17, carrying whatever `noOverflow`
could be proved ([Ch 46 § minus-zero-and-nooverflow]). For the DCE family at ordinals 22–32:
the graph after `loop-check-peeling` has duplicated guards into preheaders and
`redundant-checks-after-peeling` has taken the originals back out.

**What leaves.** The smallest graph the middle end will produce: no unreachable block, no
trivial phi, no phi nothing reads, no node whose value nothing observes, `Int32Mul` by a
small constant rewritten into a shift and at most one add, and every `Int32Add`/`Sub`/`Mul`
either stamped `noOverflow` or already widened to `Float64*` by ordinal 19. What it does
**not** carry is any statement about how each surviving value is held in a machine — that is
[Ch 48](48-types-and-representations-in-the-middle-end.md).

**New ideas.** Algebraic identity as a *rewrite rule* and what makes one unsound; IEEE-754
signed zero and NaN (first need in the book for the actual bit-level consequence, not just
the name); strength reduction; mark-and-sweep liveness; a *trivial* phi (Braun et al.);
reachability as a graph walk from the entry.

**Length.** 10 pages

## Anchors

- `src/optimizing/passes/simplify.ts` — the whole file is 217 lines and the chapter uses most
  of it. `producesBoolean` (16-20), `constantInput` (22-25), `identityOperand` (27-32),
  `involution` (34-38), `simplified` (40-53, the entire shipped identity list — four rules),
  `algebraicSimplification` (55-78, an outer `while (changed)` over `graph.blocks`),
  `MultiplierDecomposition` (80-83), `strengthReduction` (85-217), `isPowerOf2` (88-95),
  `log2` (97-101), `decomposeMultiplier` (103-118), `replaceInPlace` (120-130),
  `replaceWithSequence` (132-143), the `noOverflow === true` gate (149-153), the `x - x → 0`
  rule (204-212).
- `src/optimizing/passes/dce.ts` — `deadCodeElimination` (10-55), `isRequiredEffect` (57-59),
  `eliminateTrivialPhis` (61-107), `eliminateDeadPhis` (109-139),
  `eliminateUnreachableBlocks` (141-176).
- `src/optimizing/ir/operations.ts` — `hasObservableEffect` (1208-1213) and its
  `spec.terminator || !spec.removableWhenUnused` first clause; `isMovable` (1215-1220) for
  contrast; `ALWAYS_BOOLEAN` (1078-1085) and `alwaysProducesBoolean` (1087-1089), a set
  *derived* by running every opcode's type transfer rather than hand-listed.
- `src/optimizing/ir/graph-edit.ts` — `replaceValueUses` (9), `detachUsesOf` (27),
  `detachUsesOfAll` (33), `detachInputs` (46), `detachNode` (51), `retainNodes` (56).
  These are the only sanctioned ways to unhook a node; a pass that edits `inputs` or `uses`
  by hand corrupts def-use ([Ch 39 § replaceinput]).
- `src/optimizing/ir/frame-state-values.ts` — `markFrameStateValues` (200) used by DCE's
  worklist, `visitFrameStateValues` (101) used by dead-phi elimination.
- `src/optimizing/ir/cfg-edit.ts` — `removePhis` (161), `disconnect` (138),
  `rewriteBranchAsJump` (143, called from `sccp.ts:341` — this is what *creates* the
  unreachable blocks that ordinal 30 removes).
- `src/optimizing/target/integer.ts` — `INT32_SHIFT_MASK` (= 31), the upper bound on a legal
  shift amount, and `withinInt32`.
- `src/optimizing/passes/type-narrowing.ts` — `Narrower.specialize` (188-207) and
  `settleInt32Arithmetic` (218-238). **The second producer of `noOverflow`**, and on
  `stats.tera` the *only* one that fires (see Worked example).
- `src/optimizing/pipeline.ts` — the ordinals: `trivial-phi-elimination-early` (124, ordinal
  3), `algebraic-simplification` (170, ordinal 10) and
  `algebraic-simplification-after-escape` (199, ordinal 14), `strength-reduction` (217,
  ordinal 18), `trivial-phi-elimination` (239) / `dead-phi-elimination` (240),
  `dead-code-elimination-after-late-escape` (256), `dead-code-elimination` (270),
  `unreachable-block-elimination` (271), and the two cleanups after it (272-273).

## Worked example

`stats.tera` itself, through the AOT driver. Twelve of the thirty-three middle-end passes
change something on this program — ordinals 0, 3, 4, 5, 8, 9, 11, 16, 18, 19, 23 and 27.
`algebraic-simplification` (10 and 14) is **not** among them, and `strength-reduction` (18)
fires **exactly once** — inside `_FixedDigits.width`, the prelude class that `.to_fixed(2)`
pulls in ([Ch 63 § to-fixed-prelude]). (Reading that list off a dump takes care: the
legalization pipeline reuses several pass *names* with its own ordinals, so `#27
builtin-method-lowering` and `#27 dead-code-elimination-after-late-escape` are two different
pipelines — [Ch 51 § the-second-pipeline].)

```
*** IR after #17 bounds-check-elimination [unchanged, nodes 38 -> 38 (+0)] ***
    v33 = Int32Sub v31, v32 [noOverflow=true]
    v34 = Constant [value=4]
    v35 = Int32Mul v33, v34 [noOverflow=true]
    v36 = Int32Add v35, v29 [noOverflow=true]

*** IR after #18 strength-reduction [changed, nodes 38 -> 39 (+1)] ***
    v38 = Constant [value=2]
    v39 = Int32Shl v33, v38
    v36 = Int32Add v39, v29 [noOverflow=true]
```
— `node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c`

Two things to establish from this listing. First, the node count goes **up** by one: the
constant `2` is a new node, and `v34 = Constant 4` is left behind for DCE at ordinal 27 to
collect. Second — and this is the beat the intended story gets slightly wrong — the
`noOverflow` on `v35` was **not** stamped by range analysis at ordinal 17. Grepping the
per-pass dumps shows it present from ordinal 8, `type-narrowing`: `settleInt32Arithmetic`
proved it, because every use of `v35` chains into a `Return` in a function whose
`declaredSignature.returns` is `int`, and a declared-int return truncates
(`type-narrowing.ts:244`). Range analysis is *a* producer of `noOverflow` and it does sit
immediately before `strength-reduction`; on the book's own program it is not the one that
paid.

## Outline

- [ ] **`> **New idea.**` An algebraic identity is a rewrite rule, and a rewrite rule is a
      claim about every input.** Establish the shape: `simplified(node)` returns a
      *replacement node*, and `algebraicSimplification` then does
      `replaceValueUses` → `detachInputs` → `retainNodes`. Establish that the rule is only
      correct if the replacement is indistinguishable from the original **for every value the
      input can hold**, including the ones a reader never thinks about.
- [ ] **The four identities that ship.** Quote `simplified` whole — it is 14 lines and it is
      the complete list:

      ```ts
      function simplified(node: SimplifyNode): SimplifyNode | null {
        if (node.type === ir.IR_INT32_ADD || node.type === ir.IR_FLOAT64_ADD) {
          return identityOperand(node, 0);
        }
        if (node.type === ir.IR_INT32_MUL || node.type === ir.IR_FLOAT64_MUL) {
          return identityOperand(node, 1);
        }
        if (node.type === ir.IR_NEG) return involution(node, ir.IR_NEG);
        if (node.type === ir.IR_NOT) {
          const inner = involution(node, ir.IR_NOT);
          return inner !== null && producesBoolean(inner) ? inner : null;
        }
        return null;
      }
      ```
      — src/optimizing/passes/simplify.ts:40-53

      Establish `identityOperand`'s symmetry (it checks operand 1 then operand 0, so
      `0 + x` folds too) and that it compares with `===` against a `number`, so the constant
      must be an actual JS number.
- [ ] **`> **New idea.**` IEEE-754 has two zeros and a value that is not equal to itself.**
      First place in the book that needs the *consequences* rather than the name: `-0 === 0`
      is `true` but `1/-0` is `-Infinity`; `NaN !== NaN`; `Infinity * 0` is `NaN`. Establish
      that tera's `float` is a double and the interpreter's numbers are JS numbers, so all
      three are reachable from source.
- [ ] **`!` is guarded on a derived set, and `-` is not guarded at all.** Establish the
      asymmetry inside `simplified`: double negation (`Neg(Neg(x))`) folds unconditionally,
      but double *not* folds only when `producesBoolean(inner)`, because `!!x` on a
      non-boolean is a coercion, not an involution. Then establish that `producesBoolean`
      does not consult a hand-written list — `ALWAYS_BOOLEAN` is computed by running every
      opcode's own type transfer under `UNCONSTRAINED_CONTEXT` and keeping the ones that
      answer `TypeKind.Boolean` (`operations.ts:1078-1085`). **Invariant → enforcement →
      test:** the invariant is "the boolean set tracks the transfer functions"; the
      enforcement is that the set is derived, not declared; the test is
      `"derives the boolean-producing operations from their type transfers"`.
      Pin the behaviour with `"cancels double not over a boolean-producing value"` and
      `"keeps double not over a non-boolean value (it coerces to boolean)"`.
- [ ] **The identities that are deliberately absent, read off their own test titles.**
      This is the chapter's spine. Three refusals, each with the reason encoded in the title
      the author wrote:
      - `x * 0 → 0` — `"does NOT reduce x * 0 to 0 (unsound: negative x yields -0, NaN and Infinity yield NaN)"`.
      - `x / 2^k → x >> k` — `"does NOT reduce divide by power of 2 to shift (unsound for negative dividends)"`
        (`-1 / 2` is `-0.5`, `-1 >> 1` is `-1`; the shift rounds toward −∞, division truncates
        toward zero).
      - `x % 2^k → x & (2^k - 1)` — `"does NOT reduce mod by power of 2 to bitwise-and (unsound for negative dividends)"`
        (`-3 % 8` is `-3`, `-3 & 7` is `5`).

      Establish the general rule the three share: **every one of them is a theorem about the
      integers that stops being true about IEEE doubles or about two's-complement negatives.**
      In a zero-comment codebase, the test title *is* the derivation
      ([Conventions § 8](../CONVENTIONS.md)).
- [ ] **Why the obvious design fails: an identity table.** Stage the design a reader reaches
      for — a `Map<opcode, (node) => node|null>` of forty canonical rules ported from a
      textbook — and establish why this tree cannot have one. Every entry would need a
      per-opcode proof obligation about `-0`, `NaN`, `±Infinity` and negative dividends, and
      there is no place to *state* that obligation: `simplified` returns a node or null and
      carries no witness. The tree's answer is to ship four rules and write the proofs in the
      test names.
- [ ] **Strength reduction, and the flag it will not move without.** Establish the gate,
      three conditions deep: `IR_INT32_MUL`, exactly two inputs, and
      `node.props.noOverflow === true` (`simplify.ts:149-153`). Establish why: `Int32Shl` in
      this IR wraps at 32 bits, `Int32Mul` without `noOverflow` does not, so the rewrite is
      only value-preserving where overflow has been excluded. Pin with the two
      titles that isolate exactly this — `"does NOT reduce multiply by power of 2 to shift when overflow is possible"`
      and `"does NOT decompose multiply by 3 when overflow is possible"` — noting that both
      build a graph identical to the passing case except for the missing flag.
- [ ] **`decomposeMultiplier`, and the two shapes it knows.** Establish the rule: for a
      constant `c > 1` that is *not* a power of two, if `c - 1` is a power of two answer
      `(x << log2(c-1)) + x`; if `c + 1` is, answer `(x << log2(c+1)) - x`. So 3, 5, 9, 17 …
      and 7, 15, 31 … reduce and 6, 11, 13 do not. Establish `replaceWithSequence` splicing
      *two* nodes where one stood, and that the synthesized `Int32Add`/`Int32Sub` is stamped
      `noOverflow = true` by hand (`simplify.ts:191`) and inherits `node.frameState` — the
      rewrite must not lose the deopt point ([Ch 40 § frame-states-are-uses]). Also establish
      the shift-legality guard `shift > 0 && shift < INT32_SHIFT_MASK`, which is why `c = 2`
      reduces but a hypothetical `c = 2^31` would not. Pin with
      `"decomposes multiply by 3 to (x << 1) + x"`, `"decomposes multiply by 7 to (x << 3) - x"`,
      `"reduces multiply by 2 to shift left 1"`, `"handles constant on left side of multiply"`.
- [ ] **Bookkeeping is a separate correctness problem from the rewrite.** Establish that
      `strengthReduction` has a *third* describe block in its test file
      (`strengthReduction def-use bookkeeping`) devoted entirely to whether the replaced node
      leaves its inputs' `uses` arrays. Establish the three titles as three distinct exit
      paths through the pass: shift replacement, sequence replacement, `x - x → 0`. **General
      rule:** in a graph IR, "did the rewrite produce the right value" and "did the rewrite
      leave the graph consistent" are two tests, not one.
- [ ] **`> **New idea.**` Dead code elimination is a mark-and-sweep over the def-use graph.**
      Establish the shape of `deadCodeElimination`: seed a worklist from every node that
      `isRequiredEffect`, pull inputs transitively, then sweep everything unmarked.
      Establish the two subtleties in the marking loop. (1) `hasObservableEffect` returns
      `true` for `spec.terminator || !spec.removableWhenUnused` *before* it even looks at
      effects — so **DCE never removes a branch or a jump**, whatever the condition says;
      removing control flow is ordinal 30's job, not this pass's. (2) The loop marks through
      frame states:

      ```ts
      if (node.frameState) {
        markFrameStateValues(node.frameState, liveNodes, worklist);
      }
      ```
      — src/optimizing/passes/dce.ts:33-35

      Establish the failure this prevents: a value used only by a deopt snapshot has an empty
      `uses` list and looks dead, but deleting it leaves a hole in the interpreter frame the
      bailout rebuilds. Cross-reference [Ch 40 § frame-states-are-uses] and
      [Ch 54 § materialization]. Pin with
      `"drives dead code elimination: stores survive, unused loads and arithmetic do not"` and
      `"keeps an unused call that declares unknown effects but drops a pure one"`.
- [ ] **`> **New idea.**` A trivial phi, and Braun's re-enqueue.** Establish the definition
      from the code: a phi all of whose inputs, ignoring `null` and self-references, are the
      same node. Establish the worklist: seed with every phi in the graph; on a fold, collect
      the phi's *phi users* **before** `replaceValueUses` rewrites them and re-enqueue those
      (`dce.ts:93-96`), because folding one phi can make its consumers trivial. Establish that
      the removal is deferred to a second sweep over `block.phis` so the map is stable while
      the worklist runs, and that the pass ends with `graph.rebuildUses()`.
- [ ] **Why it runs at ordinal 3, before LICM.** Establish the pipeline-order pair as a proof
      that pass order is load-bearing, not stylistic: LICM's invariance worklist demands that
      every input be defined outside the loop, and a loop-header phi whose inputs all name the
      same outside value *is* defined outside the loop — but LICM cannot see that, because it
      reasons about nodes and the phi is a node inside the loop. Pin with
      `"cannot hoist a value carried through an untouched loop-header phi"` and
      `"hoists that same value once trivial phis have been eliminated first"`
      ([Ch 46 § licm-worklist]). **General rule:** a canonicalization pass earns its place in
      the pipeline by what it unblocks, not by what it removes.
- [ ] **The other two sweepers.** `eliminateDeadPhis`: a phi with no uses **and not named by
      any frame state** — the same frame-state rule again, this time as a pre-computed
      `frameStateReferenced` set built by `visitFrameStateValues` over the whole graph.
      Establish that it loops `while (changed)` because removing one phi can orphan another.
      `eliminateUnreachableBlocks`: a plain BFS from `graph.entry`, an early `return 0` when
      every block is reachable, `detachUsesOfAll` on the dead nodes and `disconnect` on every
      edge from a dead block into a live one — the order matters, because the live successor's
      phis must lose their input for that predecessor. Establish the pairing with SCCP: it is
      `sccp.ts:341`'s `rewriteBranchAsJump` that strands the block in the first place, pinned
      by `"rewrites the constant branch to a jump and drops the dead edge"`, and nothing
      collects it until ordinal 30. Pin the sweeper with
      `"removes blocks not reachable from entry"`, `"disconnects unreachable block from successors"`,
      `"returns 0 when all blocks are reachable"`, `"returns 0 for graph without entry"`.
- [ ] **The DCE family is ten of the thirty-three passes.** Close by listing the ordinals —
      3, 22, 23, 25, 26, 27, 29, 30, 31, 32 — and establishing *why* the same four functions
      appear so many times: every one of them follows a pass that is allowed to leave litter
      (escape analysis, peeling, unswitching, SCCP). Establish the cost side honestly: these
      are whole-graph sweeps, they are re-run unconditionally, and the pass manager's
      `optional: true` plus `--opt-bisect` is the only lever for skipping them
      ([Ch 41 § opt-bisect]).

## Honesty items

> **Broken.** `x + 0 → x` is unsound for `Float64Add` when `x` is `-0`, and the disagreement
> is observable in two of the four tiers. `simplified` (`src/optimizing/passes/simplify.ts:41-43`)
> applies `identityOperand(node, 0)` to `IR_FLOAT64_ADD` as well as `IR_INT32_ADD`, but IEEE
> addition is not the identity on signed zero: `(-0) + (+0)` is `+0`, so replacing the sum
> with its operand turns `+0` back into `-0`. **Measured 2026-09-07** on a five-line probe —
> `docs/example/` cannot reach this, so it needs a file outside the example set
> ([Conventions § 2](../CONVENTIONS.md)):
>
> ```
> fn f(x: float) -> float:
>   return x + 0.0
> print(1.0 / f(-0.0))
> ```
>
> The interpreter prints `Infinity`. `--opt-threshold 1 --baseline-threshold 1` prints
> `-Infinity`. The native binary prints `-Infinity`. `--print-after-all` names the culprit:
> `*** IR after #10 algebraic-simplification [changed, nodes 4 -> 3 (-1)] ***`, and the C
> backend emits `double f(double p0) { return (double)p0; }`. Cost of fixing: one condition —
> restrict the `0` identity to `IR_INT32_ADD`, or require the non-constant operand to be
> proved not-`-0` the way `mayBeMinusZero` already does for `noOverflow`
> (`src/optimizing/passes/checks.ts`). The `-0` reasoning is already present in this same test
> file for `x * 0`; it was not applied to `x + 0`.

> **Unenforced.** Nothing in the tree states, checks or tests the invariant that an entry in
> `simplified` must be sound over IEEE doubles. The three refusals are recorded only as
> `it("does NOT …")` titles in `tests/optimizing/passes/simplify.test.ts`; a fifth rule added
> to `simplified` would be pinned by whatever test its author wrote and by nothing else. The
> `Float64Add` bug above is what that costs.

> **Unfinished.** `algebraicSimplification` (`simplify.ts:55-78`) re-scans **every block and
> every node** on each iteration of its outer `while (changed)` loop, and sets `changed` from
> any single rewrite anywhere in the graph. On a graph where each fold exposes the next, this
> is quadratic in the number of folds. It is not measured, and it never fires at all on
> `stats.tera`.

> **Unfinished.** `strengthReduction` handles only `IR_INT32_MUL`. `Int32Div` and `Int32Mod`
> are excluded on purpose and correctly (see the two `does NOT` titles), but the
> *sound* versions — a power-of-two divide guarded by a proved-non-negative range, which
> `checks.ts`'s `nonNegative` already computes — are not implemented either. Cost of
> finishing: threading the `Range` map out of `rangeAnalysisAndBoundsCheckElimination`
> (ordinal 17) into `strengthReduction` (ordinal 18); today the two adjacent passes share
> nothing but the graph.

> **Never runs.** `algebraic-simplification` and `algebraic-simplification-after-escape`
> (ordinals 10 and 14) report `unchanged` for **all twenty-one** functions a
> `docs/example/stats.tera` compile produces — the `Series` constructor and its two methods,
> `report`, the sixteen `_FixedDigits` / `_FixedText` / `_fixed_text` prelude functions, and
> `tera_program`. The pass is live and tested; the running example simply contains no `+ 0`,
> `* 1`, `- -x` or `!!b`. State this in the chapter opener rather than implying the example
> exercises it.

## Verify it yourself

```bash
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep '^\*\*\* IR after' | grep '\[changed' | sed 's/, nodes.*//' | sort | uniq -c | sort -rn
node dist/cli.js compile docs/example/stats.tera --emit source --print-after-all -o /tmp/stats.c 2>&1 \
  | grep -n "Int32Mul v33\|Int32Shl v33"
printf 'fn f(x: float) -> float:\n  return x + 0.0\n\nprint(1.0 / f(-0.0))\n' > /tmp/negzero.tera
node dist/cli.js /tmp/negzero.tera; node dist/cli.js --opt-threshold 1 --baseline-threshold 1 /tmp/negzero.tera
node dist/cli.js compile /tmp/negzero.tera --emit source --target c --print-after-all -o /tmp/nz 2>&1 \
  | grep '^\*\*\* IR after' | grep '\[changed' | grep -i simplif
npx vitest run --project unit tests/optimizing/passes/simplify.test.ts tests/optimizing/passes/dce.test.ts
npx vitest run --project unit tests/optimizing/pipeline-order.test.ts
```

## Tests that pin this

- `tests/optimizing/passes/simplify.test.ts` > `"x + 0 => x"`
- `tests/optimizing/passes/simplify.test.ts` > `"0 + x => x"`
- `tests/optimizing/passes/simplify.test.ts` > `"x * 1 => x"`
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT reduce x * 0 to 0 (unsound: negative x yields -0, NaN and Infinity yield NaN)"`
- `tests/optimizing/passes/simplify.test.ts` > `"still reduces x * 1 to x"`
- `tests/optimizing/passes/simplify.test.ts` > `"cancels double negation"`
- `tests/optimizing/passes/simplify.test.ts` > `"cancels double not over a boolean-producing value"`
- `tests/optimizing/passes/simplify.test.ts` > `"keeps double not over a non-boolean value (it coerces to boolean)"`
- `tests/optimizing/passes/simplify.test.ts` > `"reduces multiply by power of 2 to shift"`
- `tests/optimizing/passes/simplify.test.ts` > `"reduces multiply by 2 to shift left 1"`
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT reduce multiply by power of 2 to shift when overflow is possible"`
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT decompose multiply by 3 when overflow is possible"`
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT reduce divide by power of 2 to shift (unsound for negative dividends)"`
- `tests/optimizing/passes/simplify.test.ts` > `"does NOT reduce mod by power of 2 to bitwise-and (unsound for negative dividends)"`
- `tests/optimizing/passes/simplify.test.ts` > `"decomposes multiply by 3 to (x << 1) + x"`
- `tests/optimizing/passes/simplify.test.ts` > `"decomposes multiply by 7 to (x << 3) - x"`
- `tests/optimizing/passes/simplify.test.ts` > `"reduces x - x to 0"`
- `tests/optimizing/passes/simplify.test.ts` > `"handles constant on left side of multiply"`
- `tests/optimizing/passes/simplify.test.ts` > `"drops the replaced multiply from the use lists of its inputs"`
- `tests/optimizing/passes/simplify.test.ts` > `"drops the replaced multiply when it decomposes into a shift and an add"`
- `tests/optimizing/passes/simplify.test.ts` > `"drops a subtraction of a value from itself from that value's use list"`
- `tests/optimizing/passes/dce.test.ts` > `"removes unused pure computation"`
- `tests/optimizing/passes/dce.test.ts` > `"keeps used computation"`
- `tests/optimizing/passes/dce.test.ts` > `"keeps side-effecting nodes even without uses"`
- `tests/optimizing/passes/dce.test.ts` > `"removes chains of dead nodes"`
- `tests/optimizing/passes/dce.test.ts` > `"removes unused phis and their inputs"`
- `tests/optimizing/passes/dce.test.ts` > `"keeps phis that a live node uses"`
- `tests/optimizing/passes/dce.test.ts` > `"removes blocks not reachable from entry"`
- `tests/optimizing/passes/dce.test.ts` > `"returns 0 when all blocks are reachable"`
- `tests/optimizing/passes/dce.test.ts` > `"disconnects unreachable block from successors"`
- `tests/optimizing/passes/dce.test.ts` > `"returns 0 for graph without entry"`
- `tests/optimizing/ir/operations.test.ts` > `"drives dead code elimination: stores survive, unused loads and arithmetic do not"`
- `tests/optimizing/ir/operations.test.ts` > `"keeps an unused call that declares unknown effects but drops a pure one"`
- `tests/optimizing/ir/operations.test.ts` > `"derives the boolean-producing operations from their type transfers"`
- `tests/optimizing/ir/operations.test.ts` > `"stops requiring a frame state once overflow is proven impossible"`
- `tests/optimizing/pipeline-order.test.ts` > `"cannot hoist a value carried through an untouched loop-header phi"`
- `tests/optimizing/pipeline-order.test.ts` > `"hoists that same value once trivial phis have been eliminated first"`
- `tests/optimizing/passes/sccp.test.ts` > `"rewrites the constant branch to a jump and drops the dead edge"`
- **No test pins the `Float64Add` `-0` identity in either direction.** `[unpinned]` — the
  honesty item above is a measurement, not a regression test.
