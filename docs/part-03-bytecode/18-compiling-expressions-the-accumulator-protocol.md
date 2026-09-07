# 18. Compiling expressions: the accumulator protocol   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Every instruction implicitly reads or writes one distinguished value; that
buys a compact encoding and a one-line emitter per opcode, and it costs shuffle
instructions — and recovering those is precisely what the SSA builder in [Ch 39] does when
it drops `Ldar`/`Star` on the floor.

**What arrived.** From [Ch 17]: 90 opcodes, `RegisterInstruction` with an untyped
`number[]`, an empty `RegisterCompiledFunction`, and the rule that operand positions mean
whatever `register-effects.ts` says they mean.

**What leaves.** A straight-line instruction sequence per expression — no jumps except the
short-circuit ones this chapter emits itself — plus two side effects the later tiers live
on: a `registerCount` high-water mark and a numbered sequence of feedback slots.

**New ideas.** lowering / desugaring (a source form rewritten into simpler forms before
emission); short-circuit evaluation; register allocation, and what a LIFO free list is;
the argument window (why call arguments must be contiguous).

**Length.** 14 pages

## Anchors

- `src/bytecode/register/compiler/expressions.ts` (1345 lines) — `expressionMethods`, the
  largest mixin. `compileExpression`'s 26-case dispatch (line 222), `BINARY_OP_MAP`
  (line 195, 23 entries), `compileBinaryExpression` (348), `compileUnaryExpression` (371),
  `compileLogicalExpression` (429), `compileAssignment` (445), `_buildSpreadArgs` (495),
  `compileCallExpression` (513 — 249 lines, the longest method in the file),
  `compileNewExpression` (763), `compileMemberExpression` (782),
  `compileIndexExpression` (812), `compileObjectExpression` (847),
  `compileArrayExpression` (907), `compileConditionalExpression` (948),
  `compileAwaitExpression` (958), `compileYieldExpression` (963),
  `compileTemplateLiteral` (987), `compileNullishCoalescing` (1023),
  `compileOptionalMember` (1037), `compileOptionalCall` (1063),
  `compileUpdateExpression` (1143), `compileCompoundAssignment` (1258); plus the two
  helpers that carry the accumulator protocol, `emitLoadToAcc` (315) and
  `emitStoreAcc` (323), and the free function `emitLoadSuperPrototypeProperty` (129).
- `src/bytecode/register/compiler/temp-allocator.ts` — 31 lines, the entire register
  allocator: `TempAllocator`, `freeTemps: number[]`, `alloc()`, `allocContiguous(count)`,
  `free(reg)`.
- `src/bytecode/register/compiler/index.ts` — `RegisterBytecodeCompiler`'s mutable state
  (`func`, `scope`, `temps`, `_breakJumps`, `_continueJumps`, `_finallyBlocks`), the
  four `Object.assign(prototype, …)` installs at lines 189-192, `compile()` (137),
  `_withSourceNode` (177), `globalCellName` / `globalNameIndex` / `exportedCellName`,
  and `foldModuleMember` (96).
- `src/bytecode/register/ops/bytecode.ts` — `emit` (569), `addConstant` (527),
  `allocTemp` (561), `allocFeedbackSlot` (565), `withSourcePosition` (584).
- `tests/bytecode/register/compiler.test.ts` (950 lines, 63 tests) and
  `tests/bytecode/register/compiler/temp-allocator.test.ts` (3 tests).

## Worked example

`docs/example/stats.tera`, line 10 (`total += this.values[i]`) and line 15
(`this.name + " mean=" + this.mean().to_fixed(2)`).

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --print-bytecode --filter label docs/example/stats.tera
```

`total += this.values[i]` is instructions 15-25 of `mean` — eleven instructions, of which
four are pure shuffle. `label` is the allocator example: its header says `registers=5`,
and the single argument of `.to_fixed(2)` lands in `r4` at instruction 19 even though `r3`
was returned to the free list when the `this.mean()` call at instruction 14 tore down. That
is `allocContiguous` bypassing `freeTemps` — the only place in the compiler that does.

## Outline

- [ ] **The protocol in one page.** Establish the rule before any code: exactly one value
      is implicit. `LdaX` writes it, `Star r` copies it out to a register, `Ldar r` copies
      one back in, and every operator reads it as its left operand and writes its result
      back. Nothing in the opcode names it, because it is never an operand. Then the
      consequence to hold onto for the whole chapter: *a register only ever exists to hold
      a value while the accumulator is busy with another one*.
- [ ] **Four mixins over one mutable object.** Establish the architecture:
      `RegisterBytecodeCompiler` is a class with state and no methods; `scopeMethods`,
      `statementMethods`, `expressionMethods` and `functionMethods` are plain objects
      `Object.assign`ed onto the prototype (`index.ts:189-192`), each typed by its own
      `…CompilerThis` interface plus a `declare`-style `interface RegisterBytecodeCompiler`
      merge (lines 30-40). Establish what this buys — four files instead of one 4000-line
      one, and each mixin declaring exactly the surface it uses — and what it costs: the
      mixins are mutually recursive at run time, so no file can be read alone, and the
      `this` type is a hand-maintained duplicate of the real one.
- [ ] **Why the whole compiler state is saved by hand.** Establish that `this.func`,
      `this.scope`, `this.temps` (and `this._currentSuperClassName`) *are* the compiler:
      there is no context object and no stack of them. Every nested function therefore does
      `const outerFunc = this.func; …; this.func = outerFunc;` — verified in five places:
      `compileFunctionDeclaration` (functions.ts:742), `compileFunctionExpression` (823),
      `compileArrowFunction` (878), the class-method loop (1051), and the static-field
      initializer loop (1115). Name it as the pattern it is (an explicit save/restore
      discipline in place of recursion over an environment), and say what it risks: a new
      piece of compiler state must be added to five save/restore sites or it leaks across
      a function boundary.
- [ ] **What `a + b` costs.** Read `compileBinaryExpression` (348-369) line by line:
      `alloc tmp` → compile left → `Star tmp` → compile right → `alloc tmp2` →
      `Star tmp2` → `Ldar tmp` → `Op tmp2, fbSlot` → `free tmp2` → `free tmp`. Establish
      the count: four instructions of scaffolding around the two operands, whatever they
      are. Cross-check against the listing: in `mean`, `i < this.values.length` is
      instructions 4-13, of which `Star r2`, `Star r3`, `Ldar r2` and `TestLessThan r3 r2`
      are exactly that shape. Then set up the payoff explicitly — [Ch 39] builds SSA by
      *interpreting* `Star`/`Ldar` at build time into value edges, so every one of these
      four disappears before any optimization runs. This is the chapter's central trade,
      stated once and cashed there.
- [ ] **`TempAllocator` is the whole register allocator.** Establish the size of the thing:
      31 lines, one array. `alloc()` pops `freeTemps` or calls `func.allocTemp()` (which is
      `registerCount++`); `free(reg)` pushes. It is LIFO, it has no liveness analysis, no
      interference graph, and no notion of a register being live across a call — it does
      not need one, because a frame's registers are a plain JS array sized by
      `registerCount` and never spilled. `> **New idea.**` register allocation, and why
      this tier can get away with the naive version when [Ch 66] cannot.
- [ ] **Why `allocContiguous` has to cheat.** Establish the exception and the reason for
      it: `ROP_CALL`'s operands are `(callee, firstArg, argCount, feedbackSlot)`, and
      `register-effects.ts` expands that into `argCount` reads starting at `firstArg`
      ([Ch 17 § the-effects-table]). So the arguments must be *adjacent*, and a LIFO free
      list cannot promise adjacency. `allocContiguous` therefore ignores `freeTemps`
      entirely and bumps `registerCount` by `count` (temp-allocator.ts:22-26). Show the
      cost from the listing: in `label`, `r3` is free when `.to_fixed(2)`'s argument window
      is allocated, and the window still takes `r4`, taking `registers` from 4 to 5. Then
      note what nothing does — nothing ever compacts these, so a function with many
      distinct call arities grows a register file it never uses at once.
      `> **New idea.**` the argument window.
- [ ] **Member and index access.** Establish the two-shape rule: a *named* property is a
      constant-pool index plus a feedback slot (`LdaNamedProperty obj, nameIdx, fb`), a
      *computed* one is a second register (`LdaKeyedProperty obj, idxReg, fb`) — the two
      halves of `compileMemberExpression` (782-810). Then `compileIndexExpression`
      (812-845), which is a different thing entirely: tera's `a[i, 1:2:3]` slice syntax
      compiles to a token descriptor (`"i"`, `"s110"`, …) in the constant pool plus a
      variable-length tail of bound registers, emitted with the spread
      `emit(ROP_LDA_KEYED_SLICE, objReg, descIdx, ...boundRegs)`. This is the one opcode
      whose arity is not fixed, and the reason `RegisterEffects.readsFrom` exists.
- [ ] **Template literals, `??` and `?.`.** Three lowerings, one page each, all of them
      "there is no opcode for this":
      a template literal is a fold of `ROP_ADD`s over the parts, with a skip when the
      literal part is `""` (987-1021);
      `??` is `Star left; IsNullish; JumpIfTrue → right; Ldar left; Jump → end` (1023-1035);
      `?.` is the same shape with `LdaNull` on the absent path (1037-1061), which is worth
      stopping on — the optional-member lowering answers **null**, not `undefined`, which
      is a real observable and connects to [Ch 22 § two-absence-values].
- [ ] **Update and compound assignment.** Establish why these are 110 and 87 lines rather
      than two: `x++` must be lowered differently for prefix and postfix, for identifier
      and member targets, for local and global bindings — four ways of two, all written
      out. Show the constant `1` being materialized into a register every time
      (`LdaConst oneIdx; Star oneReg`) because `ROP_ADD`'s right operand is a register and
      there is no immediate form. Note the duplicated computed-key evaluation in
      `compileUpdateExpression` (1213-1218 and 1241-1246): `a[f()]++` compiles `f()`
      **twice**. Flag it below.
- [ ] **The six call forms — really eight opcodes over five branches.**
      `compileCallExpression` dispatches on: runtime-intrinsic callee → `CallIntrinsic`;
      spread + member callee → `CallMethodSpreadNamed` or `CallWithSpread`;
      spread + plain callee → `CallSpreadNamed` or `CallWithSpread`;
      member/optional-member callee → `CallMethodNamed` or `CallMethod`;
      anything else → `CallNamed` or `Call`. Plus `ROP_NEW` from `compileNewExpression`.
      Establish what forces the split: named arguments need a second contiguous window and
      a names array in the constant pool; spread needs an array built at run time by
      `_buildSpreadArgs`, so the count is not a compile-time number. Read one branch in
      full (the plain member call, 662-703) against `label`'s instructions 16-21.
- [ ] **`yield*` is desugared into a `for-of` mid-emission.** Establish the oddest move in
      the file: `compileYieldExpression` (963-985), seeing `node.delegate`, *constructs AST
      nodes* — `ForOfStatement(varName, node.argument, BlockStatement([ExpressionStatement(
      YieldExpression(Identifier(varName), false))]), "let")` — and calls
      `this.compileForOfStatement(loop)` on them. A synthetic binding name
      `_yieldStar$N` is minted from the counter `this._yieldStarCount`. Establish the
      general rule this is an instance of, and where else the compiler does it
      (`injectInstanceFields`, `forwardingConstructorOf`, `lowerModelDeclaration` in
      [Ch 20]): *this compiler rewrites trees, not just emits from them* — which is why
      `--print-ast` and `--print-bytecode` can disagree about what the program contains.
- [ ] **Feedback slots are allocated here, by convention only.** Establish the mechanism
      and its fragility together: `func.allocFeedbackSlot()` is `feedbackSlotCount++`, and
      the emitter appends the returned number as the *last* operand — into the same
      untyped `number[]` that holds register indices. Count them in `mean`: slots 0-10 for
      two property loads, a length load, a comparison, an index load, an add, an add, a
      property load, a length load, a divide, and two jumps. Then the invariant, and who
      keeps it: `register-effects.ts` must independently know that `ROP_ADD` reads only
      operand 0, or [Ch 39] would treat slot number 6 as register 6. That is the same
      `> **Unenforced.**` seam [Ch 17] opened, seen from the producing side.
- [ ] **What leaves.** `registerCount` as a high-water mark (sized once into
      `RegisterFrame.registers`), `feedbackSlotCount` (sized once into the feedback vector
      of [Ch 33]), a `sourceMap` entry per instruction from `_withSourceNode` /
      `withSourcePosition`, and a constant pool in which primitives are shared and objects
      are not.

## Honesty items

- > **Broken.** `compileUpdateExpression` recompiles a computed member target's key
  expression for the store — once at `expressions.ts:1213-1218` for the load, again at
  `1241-1246` for the store — and that second compilation *overwrites the accumulator*,
  which at that point is holding the incremented value. Two failures for the price of one:
  the key expression runs twice, and the value written is the key's result rather than the
  increment. Measured, not inferred: with `calls` counted by an `idx()` that returns `0`,
  `a = [10, 20]; a[idx()]++` prints `calls = 2` and `a[0] = 0`; the same program written
  `a[idx()] += 1` prints `calls = 1` and `a[0] = 11`. The disassembly shows the mechanism
  exactly — `21 Add r2 r2` computes 11 into the accumulator, `22-25` recompute `idx()`
  over it, `26 StaKeyedProperty r0 r3 r4` stores what is left. The identifier and
  named-member paths are unaffected (the named path only re-adds a constant-pool index).
  Cost of fixing: keep `idxReg` alive across the read-modify-write and reuse it, which is
  the shape `compileCompoundAssignment` already has at `1316-1341` and is why that path is
  correct. Tell it as engineering — symptom, mechanism, fix, regression test, general rule
  ("a lowering may not evaluate a sub-expression twice, and may not emit into the
  accumulator after the operator has written it"). Needs a new variation file to be
  reproducible from the tree — proposed `docs/example/update-index.tera`, added to
  `tests/e2e/docs/book-examples.test.ts` — and an entry in [Ch 82] / Appendix D. [unpinned]
- > **Unfinished.** `compileUnaryExpression`'s unary-plus case emits `ROP_NEG` twice
  (`expressions.ts:408-412`) and burns two feedback slots to do it. It is correct for
  numbers and it is how the coercion happens, but it means `+x` is two feedback sites and
  `-x` is one, which skews anything that reads slot counts. Cost of fixing: a
  `ROP_TO_NUMBER`, i.e. a 91st opcode and four new consumers.
- > **Unenforced.** Nothing checks that the operand a compiler method appends as a feedback
  slot is in the position `register-effects.ts` expects it to be ignored at. The two
  files agree by inspection. Cost of enforcing: a test that compiles a corpus and asserts
  `feedbackSlotCount` equals the number of distinct trailing operands the table skips.
- Not an honesty item but a refusal worth quoting, because it is where the accumulator
  protocol runs out: `compileExpression`'s `NodeType.SuperExpression` case
  (`expressions.ts:231-232`) says, verbatim,
  `[RegCompiler] Bare super is not supported`. Verified reachable — the parser accepts
  `y = super` inside a method of a `class B extends A`, and this is the message. There is
  no accumulator value a bare `super` could load, because `super` is not a value here: it
  is resolved by `emitLoadSuperPrototypeProperty` (129) against a synthetic binding named
  by `superClassBinding(className)`, which [Ch 20] introduces. Note the diagnostic names
  the compiler stage, not the source position — the pattern [Ch 81] catalogues.

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --print-bytecode --filter label docs/example/stats.tera
node dist/cli.js --print-bytecode --filter scale docs/example/stats-closure.tera
npx vitest run --project unit tests/bytecode/register/compiler/temp-allocator.test.ts
npx vitest run --project unit tests/bytecode/register/compiler.test.ts
```

The third command also demonstrates `--filter`'s substring matching: `scale` prints both
`scaler` and `scale`, because `matchesFilter` is `name.includes(filter)`
(`src/cli/main.ts:44`).

## Tests that pin this

- `tests/bytecode/register/compiler.test.ts > "allocates and frees temp registers for operands"`
  — the two `Star`s of the binary shape.
- `tests/bytecode/register/compiler.test.ts > "uses feedback slot"`
  — a binary operator always allocates one.
- `tests/bytecode/register/compiler.test.ts > "compiles all arithmetic operators"`
- `tests/bytecode/register/compiler.test.ts > "compiles comparison operators"`
- `tests/bytecode/register/compiler.test.ts > "compiles bitwise operators"`
- `tests/bytecode/register/compiler.test.ts > "throws on unknown binary operator"`
  — `BINARY_OP_MAP` is exhaustive by refusal, not by type.
- `tests/bytecode/register/compiler.test.ts > "maps each operator to the correct opcode"`
  — unary.
- `tests/bytecode/register/compiler.test.ts > "compiles && with short-circuit jump"`
- `tests/bytecode/register/compiler.test.ts > "compiles || with short-circuit jump"`
- `tests/bytecode/register/compiler.test.ts > "compiles simple function call"`
- `tests/bytecode/register/compiler.test.ts > "compiles method call"`
- `tests/bytecode/register/compiler.test.ts > "compiles call with no arguments"`
  — the `firstArgReg = 0` case, where operand 1 is a base that means nothing.
- `tests/bytecode/register/compiler.test.ts > "compiles named property access"`
- `tests/bytecode/register/compiler.test.ts > "compiles computed property access"`
- `tests/bytecode/register/compiler.test.ts > "compiles template literal with expressions"`
- `tests/bytecode/register/compiler.test.ts > "compiles postfix ++"`
- `tests/bytecode/register/compiler.test.ts > "compiles prefix --"`
- `tests/bytecode/register/compiler.test.ts > "compiles +="`
- `tests/bytecode/register/compiler.test.ts > "compiles nested binary expressions"`
- `tests/bytecode/register/compiler.test.ts > "registerCount grows with locals"`
- `tests/bytecode/register/compiler.test.ts > "reuses freed temp registers"`
  — two independent binary expressions occupy the same registers as one.
- `tests/bytecode/register/compiler/temp-allocator.test.ts > "alloc returns fresh registers from the function when pool is empty"`
- `tests/bytecode/register/compiler/temp-allocator.test.ts > "free returns register to pool, alloc reuses it (LIFO)"`
- `tests/bytecode/register/compiler/temp-allocator.test.ts > "mixed alloc/free pattern avoids growing registerCount when possible"`
  — note what all three omit: there is no test for `allocContiguous`.
- `tests/e2e/language/functions.test.ts > "mixes spread positional arguments with named arguments"`
  — the branch of `compileCallExpression` that needs both windows.
- `tests/e2e/language/functions.test.ts > "binds named arguments with Python-style rules"`
