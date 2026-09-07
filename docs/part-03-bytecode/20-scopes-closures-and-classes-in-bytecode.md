# 20. Scopes, closures, and classes in bytecode   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** A language with no binding keywords has to decide what `x = 1` *means* before
it emits a single instruction — so the bytecode compiler runs four analysis passes over a
function body before code generation starts; and a `class`, which looks like one
declaration, is the widest lowering in the compiler, turning one node into a constructor
function, a prototype walk, one closure per method, and a per-static-field function that
is called immediately and then thrown away.

**What arrived.** From [Ch 19 § the-verifier-that-does-not-exist]: a complete control-flow
shape — loops, conditionals, `switch`, `try`, labelled statements — expressed only as
absolute instruction indices in operand 0 of `Jump`, `JumpIfTrue`, `JumpIfFalse` and
`TryStart`. What [Ch 19] left open is exactly what this chapter closes: the loop
compilers emit `ROP_CLOSE_UPVALUES iterationScopeBase` when `_bodyMayCapture` says the
body contains a function, and [Ch 19 § body-may-capture] handed the *semantics* of that
one instruction here.

**What leaves.** A finished `RegisterCompiledFunction` — the artifact Part III promised
Part IV. Beyond the instruction list of [Ch 18] and [Ch 19] it now carries:
`localNames` and `localBindingKinds` (one of `temp` / `var` / `let` / `const` / `class`),
`uninitializedLocalSlots` (the TDZ set the frame constructor reads), `upvalues`
(an `UpvalueDescriptor[]` naming, per captured variable, whether it came from the
enclosing frame's registers or from the enclosing *closure*), `hoistedVarNames`
(script-scope `var`s that must exist as global cells before instruction 0 runs),
`classBindingSlots`, `selfBindingSlot`, and — nested inside the constant pool — one more
`RegisterCompiledFunction` per inner function, per class method, and per static-field
initializer. [Ch 21] takes this object and starts executing it.

**New ideas.** *binding* and *scope chain*; *lexical vs dynamic scope*, in one line;
*hoisting*; *capture*, *upvalue*, *cell*, and the open/closed distinction; *escape
analysis* in its smallest possible form (assigned-minus-escaped); *temporal dead zone*,
and the difference between a sentinel value and a flag; *prototype* as a link between two
objects, not a type (the full treatment is [Ch 23]); *desugaring* — a source construct
with no opcode of its own, rewritten into constructs that have one.

**Length.** 16 pages

## Anchors

- `src/bytecode/register/compiler/scope.ts` (397 lines) — `scopeMethods`, the whole
  pre-pass. `scanImplicitBindings` (75-114) with the `ImplicitScan` pair
  `{assigned, escaped}` and the `NESTED_SCOPE_TYPES` cut-off (64-71);
  `collectPatternNames` (116-136); `_declareLocal` (139-155); `_addHoistedVar` (157-166);
  `_declareForLoopBinding` (168-180); `_prescanLocals` (186); `_prescanBlockScopedLocals`
  (192-214); `_prescanStatement` (216-297, the 83-line switch); `_hoistVars` (299) and
  `_hoistVarsFromNode` (305-362); `_emitHoistedFunctionDeclarations` (364-378);
  `_declareImplicitLocals` (380-389); and `_prepareFunctionBody` (391-396) — six lines
  that fix the order of all four.
- `src/bytecode/register/compiler/helpers.ts` (271 lines) — `class Scope` (159-271):
  `parent`, `locals`, `bindings`, `constSlots`, `isFunctionBoundary`, `isScript`,
  `upvalues`, `upvalueMap`; `isInScriptScope` (184-192); `resolve` (194-214) — fourteen
  lines, and the only place capture happens; `captureUpvalue` (216-232);
  `define` / `defineVar` / `defineFunction` / `defineConst` (234-253); `isConst`
  (255-270). Plus `analyzeSimpleConstructor` (101-114) over `analyzeConstructor`
  (36-99), and the `SimpleConstructorField` / `SimpleConstructorSource` types.
- `src/bytecode/register/compiler/functions.ts` (1531 lines) — `_compileParams` (681);
  `compileFunctionDeclaration` (743-822); `compileFunctionExpression` (824-877, and the
  `selfBindingSlot` at 846-850); `compileArrowFunction` (879-933);
  `compileLazyFunctionDeclaration` (935); `compileClassDeclaration` (968-1152);
  `compileSuperCall` (1154-1237); `compileForInStatement` (1238) and
  `compileForOfStatement` (1335) with their narrower `ROP_CLOSE_UPVALUES` at 1315 and
  1398. The save/restore quartet `outerFunc` / `outerScope` / `outerTemps` /
  `outerSuperClassName` appears five times in this file; that repetition *is* the design.
- `src/bytecode/register/compiler/expressions.ts` — `emitLoadToAcc` (315-321) and
  `emitStoreAcc` (323-329): four lines each, and the only translation from a
  `ScopeResolution` to an opcode. `compileIdentifier` (331) and `compileAssignment`
  (445-493), whose `resolved === null` fall-through to `ROP_LDA_GLOBAL` /
  `ROP_STA_GLOBAL` is what the pre-pass exists to prevent.
- `src/bytecode/register/compiler/index.ts` — `compile` (143-175): `new Scope()` with
  `isScript = true`, `_collectInterfaceDeclarations` then `_prepareFunctionBody`, then
  statements. `Object.assign(RegisterBytecodeCompiler.prototype, scopeMethods)` at 195.
- `src/bytecode/register/ops/bytecode.ts` — `LocalBindingKind` (166); `UpvalueDescriptor`
  (182-188) with its five optional fields; `addLocal` (540-548); `setLocalBindingKind`
  (554-559), where `let` / `const` / `class` join `uninitializedLocalSlots`;
  `classBindingSlots` (448); `hoistedVarNames` (437). Opcodes: `ROP_DEFINE_CLASS_MEMBER`
  = 0x0b (28), `ROP_LDA_UPVALUE` = 0x46, `ROP_STA_UPVALUE` = 0x47, `ROP_MAKE_CLOSURE` =
  0x48 (65-67), `ROP_SET_PROTO` = 0x85, `ROP_DEFINE_ACCESSOR` = 0x86 (107-108),
  `ROP_CLOSE_UPVALUES` = 0x87 (109), `ROP_ASSERT_CLASS_CONTRACTS` = 0x91 (120).
- `src/runtime/intrinsics/environment.ts` (57 lines) — `UpvalueCell` (8-41): `frame`,
  `localSlot`, `closed`, `closedValue`, and `get` / `set` / `close`. Three branches on
  one boolean is the entire closure model. `Environment` (43-57) is a `UpvalueCell[]`
  with `getUpvalue` / `setUpvalue`.
- `src/bytecode/register/interpreter/frame.ts` (141 lines) — `TDZ_UNINITIALIZED` (16),
  `isTDZUninitialized`, `throwIfTDZ`; `RegisterFrame`'s `hasUpvalues` / `hasTDZ` /
  `openUpvalues` / `locals` aliasing `registers` (72); `getReg` / `setReg` (85-107) and
  their upvalue redirect; `getOrCreateUpvalueCell` (109-119); `closeUpvalues` (121) and
  `closeUpvaluesFrom` (127-139).
- `src/bytecode/register/interpreter/index.ts` — `ROP_MAKE_CLOSURE` (2117-2146), which
  builds the cell vector by reading `innerFunc.upvalues` and branching on
  `outerType === "local"` vs `"upvalue"`; `ROP_CLOSE_UPVALUES` (1770-1773);
  `ROP_SET_PROTO` (1986-1997) with its object/function split;
  `ROP_DEFINE_CLASS_MEMBER` (1470-1473), which is *literally* `handleStaProp`;
  `ROP_DEFINE_ACCESSOR` (1999-2002); `ROP_ASSERT_CLASS_CONTRACTS` (2004-2014);
  `getConstructorStub` (1280-1340), the consumer of `analyzeSimpleConstructor`; and the
  `hoistedVarNames` pre-creation loop (927-933).

## Worked example

Two halves, both from files in the tree, plus one shape the example set cannot reach.

**Capture, from `docs/example/stats-closure.tera`.** `scaler` returns an inner `scale`
that reads `factor`, and the whole of `scaler` compiles to four instructions:

```
=== scaler (params=1, locals=2, registers=2, constants=1) ===
Constants:
  [0] <function scale>
Locals: r0=factor, r1=scale
Instructions:
     0  MakeClosure r0
     1  Star r1
     2  Ldar r1
     3  Return
```

— `node dist/cli.js --print-bytecode --filter scaler docs/example/stats-closure.tera`

`MakeClosure` rather than `LdaConst` is the entire visible consequence of
`Scope.resolve` having crossed a function boundary once.

**A class, from `docs/example/stats.tera`.** `Series`'s constructor is the four-instruction
idiom `analyzeSimpleConstructor` recognises, twice over:

```
     0  LdaThis
     1  Star r2
     2  Ldar r0
     3  StaNamedProperty r2 [0] (name) r0
     4  LdaThis
     5  Star r2
     6  Ldar r1
     7  StaNamedProperty r2 [1] (values) r1
     8  LdaUndefined
     9  Return
```

and the class *body* is eight instructions in `<script>`:

```
     2  LdaConst [2] (<function Series>)
     3  StaGlobal [3] (Series)
     4  LdaGlobal [3] (Series)
     5  Star r0
     6  LdaNamedProperty r0 [4] (prototype) r0
     7  Star r1
     8  LdaConst [5] (<function mean>)
     9  DefineClassMember r1 [6] (mean) r1
```

**The two-answer loop**, which no file in `docs/example/` has. The chapter proposes
`docs/example/stats-closure-loop.tera`; until it exists the demonstration is reproducible
from a scratch copy, and both halves are real engine behaviour:

```bash
TMP=$(mktemp -d) && cat > "$TMP/closure-loop.tera" <<'EOF'
fn make() -> int[]:
  fns = []
  i = 0
  while i < 3:
    n: int = i
    fn answer() -> int:
      return n
    fns.push(answer)
    i += 1
  return fns

made = make()
k = 0
while k < 3:
  print(made[k]())
  k += 1
EOF
sed 's/  while i < 3:/  do:/; s/    i += 1/    i += 1\n  while (i < 3)/' \
  "$TMP/closure-loop.tera" > "$TMP/closure-dowhile.tera"
node dist/cli.js "$TMP/closure-loop.tera"      # 0 1 2
node dist/cli.js "$TMP/closure-dowhile.tera"   # 2 2 2
node dist/cli.js --print-bytecode --filter make "$TMP/closure-loop.tera" \
  | grep -E 'MakeClosure|CloseUpvalues'        # 11 MakeClosure r2 / 28 CloseUpvalues r2
node dist/cli.js --print-bytecode --filter make "$TMP/closure-dowhile.tera" \
  | grep -cE 'CloseUpvalues'                   # 0
```

The `while` loop answers `0 1 2`. The same body under `do:` / `while (…)` answers
`2 2 2`, because `compileDoWhileStatement` emits no `ROP_CLOSE_UPVALUES` at all. That is
not a teaching device — it is the honesty item at the end of this chapter, and it is the
cleanest available proof of what that one instruction does.

## Outline

- [ ] **§ no-binding-keywords** — Establish the problem this chapter exists to solve.
  tera has no `let`, `const` or `var` *keyword surface* the programmer writes at function
  scope; a binding is `name: type = value` or bare `name = value`, and a bare assignment
  is syntactically indistinguishable from a write to something declared elsewhere. Show
  `compileAssignment` (expressions.ts:445-460): it calls `this.scope.resolve(target.name)`
  and, if that answers `null`, emits `ROP_STA_GLOBAL`. One instruction, and it is
  irreversible — a single-pass emitter cannot come back and turn it into a `Star`. So the
  decision has to have been made before code generation began.
  `> **New idea.**` binding, scope chain, lexical scope.
- [ ] **§ four-phases-before-any-code** — Read `_prepareFunctionBody` whole (scope.ts:
  391-396) and establish that the *order* is the design, not an accident.
  1. `_hoistVars` — a structural walk that reaches into blocks, `if` arms, loop bodies,
     `try`/`catch`/`finally` and every `switch` case, declaring `var`s in the *function's*
     slot table no matter how deeply nested the statement is.
  2. `_prescanLocals` → `_prescanStatement` — one level only, no recursion into blocks,
     declaring `let` / `const` / destructured names / `catch` parameters / for-loop
     bindings, and the three synthetic locals each `for-in` needs (`_keys$`, `_i$`,
     `_len$`) and the two each `for-of` needs (`_iter$`, `_iterResult$`).
  3. `_declareImplicitLocals` — the analysis this chapter is named for.
  4. `_emitHoistedFunctionDeclarations` — the only phase that *emits*, so that a call to
     a function declared later in the body resolves.
  Establish the asymmetry between 1 and 2 explicitly: `var` is function-scoped so its
  pre-pass recurses; `let` is block-scoped so its pre-pass does not, and `compileBlock`
  (statements.ts:477-484) runs a *second*, block-local prescan
  (`_prescanBlockScopedLocals`) inside a fresh `Scope`. `> **New idea.**` hoisting.
- [ ] **§ assigned-minus-escaped** — The centre of the first half. Read
  `_declareImplicitLocals` (380-389) and then `scanImplicitBindings` (75-114) in full;
  it is inside the 20-line rule. Establish the algorithm as the smallest possible escape
  analysis: walk the body collecting two sets, `assigned` (names written by an
  `AssignmentExpression` whose target is a bare identifier) and `escaped` (names *read*
  as an identifier anywhere), stop at `NESTED_SCOPE_TYPES` so an inner function's body is
  not scanned, and finally declare `assigned − escaped` as function-local `var`s — but
  only after `this.scope.locals.has(name)` and `this.scope.resolve(name)` have both said
  no, so an outer binding always wins.
  `> **New idea.**` escape analysis, in one sentence and with no lattice.
- [ ] **§ the-one-continue** {#the-one-continue} — Establish the single line that makes
  the analysis correct, and stage the version without it. Line 106:
  `if (writesIdentifier && key === "target") continue;` skips the assignment's *left*
  side while recursing into every other key. So `x = 1` records a write and no read, and
  `x` becomes a local. But `x = x + 1` recurses into `value` **first** — the right-hand
  `x` is seen while `scan.assigned` is still empty, so it lands in `escaped` — and then
  line 112's guard `if (!scan.escaped.has(name)) scan.assigned.add(name)` refuses to
  claim it. The read wins, the name stays whatever the enclosing scope says it is, and
  `x = x + 1` inside a function does not silently shadow a global with `undefined`.
  Establish the general rule: *a name that is read before it is written cannot be a new
  binding*, and the entire implementation of that rule is one `continue` plus one
  negated `has`.
- [ ] **§ script-scope-is-different** *(Why the obvious design fails)* — Establish the
  carve-out and why it is not an oversight. `_declareImplicitLocals` opens with
  `if (this.scope.isScript) return;` (381); `_prescanStatement`'s `VarDeclaration` case
  routes to `_addHoistedVar` when `this.scope.isScript` (229-234); `compileLetDeclaration`
  (statements.ts:283-293) emits `ROP_STA_GLOBAL` for a script-scope `var`. So at the top
  level *every* bare assignment is a global-cell write. Stage the obvious alternative —
  make script-scope bindings registers too, they are faster — and show what it costs: the
  REPL evaluates each line as a fresh `<script>`, modules share a global cell namespace
  ([Ch 15 § two-graphs]), and `--expose-gc` and the debugger both address top-level
  names. Then the run-time half: `hoistedVarNames` is not bytecode at all, it is a list
  the interpreter walks before instruction 0 to pre-create empty cells
  (interpreter/index.ts:927-933).
- [ ] **§ resolve-and-the-boundary** — Read `Scope.resolve` (helpers.ts:194-214) whole.
  Establish the three-line core: own `locals` → a `local` resolution; otherwise ask the
  parent; and then the one conditional that creates closures —
  `if (result && this.isFunctionBoundary) return this.captureUpvalue(name, result)`.
  Establish that `isFunctionBoundary` is set at exactly five sites in `functions.ts`
  (776, 838, 895, 1069, 1125: declaration, expression, arrow, class method, static-field
  initializer) and nowhere else, so a `Scope` created by `compileBlock` or
  `compileForStatement` is transparent to capture and a function scope is not. Then
  `captureUpvalue` (216-232): dedupe through `upvalueMap`, push an
  `{name, outerType, outerSlot, kind}` record, return `{type: "upvalue", slot: idx}`.
  Note the recursion that makes deep nesting work: an inner-inner function's resolve
  reaches the middle function's `resolve`, which itself captures, so `outerType` can be
  `"upvalue"` and `outerSlot` an index into the *enclosing closure's* cell vector rather
  than into a frame.
  `> **New idea.**` capture, upvalue.
- [ ] **§ four-lines-of-codegen** — Establish how little of this reaches the instruction
  stream. `emitLoadToAcc` and `emitStoreAcc` (expressions.ts:315-329) are four lines
  each: `local` → `Ldar` / `Star`, `upvalue` → `LdaUpvalue` / `StaUpvalue`, and nothing
  else. Then the site that decides `MakeClosure` vs `LdaConst`: every one of the five
  function compilers ends with `innerFunc.upvalues = innerScope.upvalues` followed by
  `if (innerFunc.upvalues.length > 0) emit(ROP_MAKE_CLOSURE, constIdx) else
  emit(ROP_LDA_CONST, constIdx)` (809-813, 872-876, 928-932, 1100, 1136). Establish the
  consequence: a function with no captures is a *constant*, shared by every evaluation of
  the declaration — which is why `scaler`'s `scale` costs a `MakeClosure` and `report`
  in `stats.tera` costs an `LdaConst`.
- [ ] **§ open-cells-alias-the-frame** — The run-time half, and the smallest file in the
  chapter. Read `UpvalueCell` (environment.ts:8-41) whole. Establish the two states:
  *open* (`closed === false`) means `get`/`set` index straight into `frame.locals[slot]`,
  so the closure and the still-running function see one variable; *closed* means the value
  was copied into `closedValue` and `frame` was nulled, so the frame can be collected.
  Then `RegisterFrame.getOrCreateUpvalueCell` (frame.ts:109-119), which sets
  `hasUpvalues = true` — and note the consequence for [Ch 21 § directregisters]: that one
  boolean is what takes the frame off the fast `getReg` path for the rest of its life.
  Then `ROP_MAKE_CLOSURE` in the interpreter (2117-2146): for each descriptor,
  `outerType === "local"` asks the *current* frame for a cell, `"upvalue"` copies a cell
  pointer out of `frame.closureEnv.cells` — sharing, not copying, so two sibling closures
  over the same variable stay in step. Diagram: one mermaid figure, frame → cells →
  two `Environment`s.
- [ ] **§ close-upvalues** {#close-upvalues} — The pay-off [Ch 19] deferred. Establish
  `closeUpvaluesFrom(baseSlot)` (frame.ts:127-139): close and *delete* every open cell
  whose slot is `>= baseSlot`, and clear `hasUpvalues` if none are left. Then where the
  base comes from: `iterationScopeBase = this.func.registerCount` read **before** the loop
  is compiled (statements.ts:386, 410), so every slot the body allocates is at or above
  it. Walk the worked example instruction by instruction: `MakeClosure` at 11 creates a
  cell aliasing `r4`; `Star r4` at 14 writes *through* the cell because `setReg` redirects;
  `CloseUpvalues r2` at 28 snapshots it and detaches; the next iteration's `MakeClosure`
  finds no open cell for `r4` and makes a fresh one. Then the counterfactual, from the
  same worked example: the `do:` form, which emits none, and answers `2 2 2`. Establish
  the general rule: *a loop body is a scope only if something explicitly ends it.*
- [ ] **§ tdz-is-a-value-not-a-flag** — Establish the design choice and price it.
  `setLocalBindingKind` (bytecode.ts:554-559) puts `let`, `const` and `class` slots into
  `uninitializedLocalSlots`; `RegisterFrame`'s constructor (frame.ts:62-67) fills those
  registers with the singleton object `TDZ_UNINITIALIZED` instead of `CODE_UNDEFINED`.
  Establish why a sentinel beats a per-slot flag here: the check rides along on a read
  that had to happen anyway, and `frame.hasTDZ` — one boolean, set once at construction —
  lets a function with no lexical declarations skip it entirely. Then the cost, which is
  the interesting half: `TDZ_UNINITIALIZED` is a `{kind: "tdz-uninitialized"}` object, so
  `RegisterValue` is `TaggedValue | TDZUninitialized` and *every* consumer of a register
  — `getReg`, `UpvalueCell.get`, the GC root walk, the OSR register reader of
  [Ch 37 § reading-registers] — has to be able to see a value that is not a tagged value.
  `> **New idea.**` temporal dead zone; sentinel vs flag.
- [ ] **§ a-class-is-a-desugaring** — Open the second half. Establish that
  `ROP_SET_PROTO`, `ROP_DEFINE_CLASS_MEMBER`, `ROP_DEFINE_ACCESSOR` and
  `ROP_ASSERT_CLASS_CONTRACTS` are the *only* class-specific opcodes, that
  `ROP_DEFINE_CLASS_MEMBER` in the interpreter is one line calling `handleStaProp`
  (index.ts:1470-1473) — the same handler as a plain property store — and that everything
  else about a class is rewriting. `compileClassDeclaration` is 186 lines
  (functions.ts:968-1152), the second-longest method in the bytecode compiler after
  `compileCallExpression`'s 250, and the one that turns a single node into the widest set
  of opcodes. `> **New idea.**` desugaring; prototype as a link, forward-referencing
  [Ch 23 § hidden-classes] for what a prototype *is*.
- [ ] **§ the-constructor-comes-first** — Establish the six-step order and why it cannot
  be permuted. (1) A superclass, if present, gets a **local slot of its own** —
  `addLocal(superClassBinding(node.name))`, pushed onto `func.classBindingSlots`,
  removed from the temp free-list by hand (977-981) so nothing can reuse it, then loaded
  and `Star`ed. This is the binding `compileSuperCall` (1154) and `super.m()`
  (expressions.ts:132) resolve against; [Ch 39 § class-slots] shows the SSA builder
  reading `classBindingSlots` back out. (2) The constructor node is *synthesised* if the
  source has none — `forwardingConstructorOf`, `gatheringForwarderOf`, or
  `emptyConstructorOf` (237-311) — then `injectInstanceFields` prepends field
  initializers, then a dozen `_class*` annotations are hung on the node, then it is
  compiled by `compileFunctionDeclaration` like any other function. The class *is* that
  function. (3) `loadClassValue()` reads it back — from a register if resolvable, from a
  global cell otherwise — into `classReg`, and `LdaProp "prototype"` into `prototypeReg`.
- [ ] **§ set-proto-twice** — Establish the two-link inheritance model (1036-1047).
  `SET_PROTO prototypeReg, superProtoReg` links the instance chain; `SET_PROTO classReg,
  superCtorReg` links the *constructor* chain, which is how static members are inherited.
  Then read the interpreter case (1986-1997) and establish the split it makes:
  `isObject`/`isObject` calls `setPrototype`, `isFunction`/`isFunction` calls
  `setFunctionStaticBase` — one opcode, two unrelated mechanisms, chosen by the tag of
  its operands. Note the silent third arm: if neither pair matches, the instruction does
  nothing at all.
- [ ] **§ methods-accessors-and-static-fields** — Establish the three method shapes
  (1049-1143). Every method compiles like a function expression with a fresh
  `isFunctionBoundary` scope, so a method may capture from the enclosing scope and gets
  `MAKE_CLOSURE` when it does (1100) — the same one-line test as everywhere else. Then
  the split at 1103: `get`/`set` park the function in a temp and emit
  `ROP_DEFINE_ACCESSOR target, name, getterReg, setterReg` with `-1` for the half that is
  absent, so a getter and a setter of the same name are two separate instructions each
  supplying one side; everything else emits `ROP_DEFINE_CLASS_MEMBER target, name, fb`
  with a feedback slot, and `targetReg` is `classReg` for `static` and `prototypeReg`
  otherwise. Then the strangest lowering in the file (1115-1143): a **static field
  initializer becomes a zero-argument `RegisterCompiledFunction`** named
  `Class.field$init`, added to the constant pool, loaded, `Star`ed into a temp, `CALL`ed
  with zero arguments, and its result stored with `DEFINE_CLASS_MEMBER`. Establish why:
  the initializer may reference `this` (the class), may be a private call
  (`tests/e2e/language/classes.test.ts > "runs private constructor calls from static
  field initializers"`), and needs its own scope — and the compiler has exactly one
  mechanism for "an expression with its own scope", which is a function. Close with
  `ROP_ASSERT_CLASS_CONTRACTS` (1145-1148), emitted only when the class declares
  `implements`, checked at 2004-2014 against constants that are `RuntimeInterfaceContract`
  objects — a structural check, which is [Ch 12 § classes-without-nominality] arriving in
  the instruction stream.
- [ ] **§ four-instructions-the-interpreter-can-skip** — Close the chapter by showing the
  compiler's output being read back as a *pattern*. Read `analyzeConstructor`
  (helpers.ts:36-99): it walks the constructor's instructions four at a time looking for
  exactly `LdaThis`, `Star`, one of six loads, `StaNamedProperty`, and requires the run
  to end with `LdaUndefined`, `Return` at `pc + 2 === instrs.length`. Any deviation —
  a computed name, a duplicate field, arithmetic, a call — returns `null` for the whole
  function. Point at `Series` in the worked example: it matches, twice.
  Then the pay-off, `getConstructorStub` (interpreter/index.ts:1280-1340): the recognised
  shape is compiled once into a closure that allocates an object, presizes it against the
  hidden class the fields imply, and stores them by offset — the constructor's bytecode
  never runs. Establish that the result is cached as `compiledFn.simpleConstructorInfo`
  (`undefined` = not asked, `null` = asked and refused) and read by three unrelated
  consumers: the interpreter's construct path (567, 1141), `BaselineRuntime`
  (baseline/runtime.ts:173), and the SSA builder's inliner
  (builder/ir-builder.ts:1885-1887). Invariant → enforcement → test: the invariant is
  that the stub and the bytecode produce the same object; nothing enforces it, and the
  four `analyzeSimpleConstructor` unit tests pin only the recogniser, not the agreement.
- [ ] **§ what-the-example-cannot-reach** — The statement Part III's opener asked this
  chapter to make once. `docs/example/*.tera` contains no class inheritance, no static
  fields, no `interface` implementation, no generator and no `switch`, so
  `ROP_SET_PROTO`, `ROP_ASSERT_CLASS_CONTRACTS` and the static-field-initializer lowering
  are described from source and from `tests/e2e/language/classes.test.ts` rather than
  from a disassembly of the spine. Name the two sections that stand on tests alone and
  move on.

## Honesty items

- > **Broken.** `compileDoWhileStatement`
  (`src/bytecode/register/compiler/statements.ts:642-652`) never calls `_bodyMayCapture`
  and never emits `ROP_CLOSE_UPVALUES`. It also does not capture an `iterationScopeBase`,
  so it has nothing to pass one. Every closure created in a `do:` / `while (…)` body
  therefore shares one `UpvalueCell` per slot with every other iteration: the worked
  example's `while` form answers `0 1 2` and the byte-identical `do` form answers
  `2 2 2`. `while`, `for`, `for-in` and `for-of` are all correct. Cost of fixing: four
  lines, copied verbatim from `compileWhileStatement` (386, 396-399) — read
  `this.func.registerCount` before the body, call `_bodyMayCapture`, emit the instruction
  at `continueTarget`. There is no test covering a closure created in a `do-while` body;
  `tests/bytecode/register/compiler.test.ts > "emits body before condition check"` is the
  only `do-while` test and it asserts on jump structure only.
- > **Unfinished.** `compileForInStatement` (functions.ts:1313-1316) and
  `compileForOfStatement` (1396-1399) close upvalues over **`varSlot` only** — the loop
  variable — where `compileWhileStatement` and `compileForStatement` close everything at
  or above `iterationScopeBase`. A `let`-bound variable declared *inside* a `for-of` body
  and captured by a closure is therefore not closed per iteration. Both also skip the
  instruction entirely when `node.kind === "var"`, which is correct for `var` semantics
  and undetectable from the bytecode afterwards. [unpinned]
- > **Never runs.** `LocalBindingKind` includes `"class"`
  (`src/bytecode/register/ops/bytecode.ts:166`) and `setLocalBindingKind` (554-559) gives
  it the same TDZ registration as `let` and `const`. Both `_declareLocal` signatures
  declare the kind (`functions.ts:645`, `statements.ts:161`) — but no call site anywhere
  in `src/` passes `"class"`. A class binding at function scope is created by
  `addLocal` + `scope.define` directly (functions.ts:977-982), which records the kind
  `"temp"` and never enters `uninitializedLocalSlots`. So a class name has no temporal
  dead zone, and the branch that would give it one is unreachable. Cost of removing:
  three lines. Cost of *using* it: one call site, and a decision about whether
  `superClassBinding` slots should be in the TDZ too.
- > **Unenforced.** `UpvalueDescriptor`
  (`src/bytecode/register/ops/bytecode.ts:182-188`) declares all five of its fields
  optional — `name?`, `index?`, `isLocal?`, `outerType?`, `outerSlot?` — while
  `captureUpvalue` always writes exactly four of them and never `index` or `isLocal`.
  Nothing checks the shape at construction; the interpreter re-validates it at *every*
  `ROP_MAKE_CLOSURE` instead, throwing `VMReferenceError` three different ways
  (index.ts:2123, 2126, 2141) for cases the compiler cannot produce. Two dead fields and
  three run-time checks are the price of a type that permits a state the producer never
  builds. Cost of enforcing: make the four written fields required and delete the two
  others, then the three throws become unreachable and can go too.
- > **Unenforced.** Nothing checks that a slot in `uninitializedLocalSlots` is written
  before it is read on every path — that is exactly what the TDZ sentinel exists to
  discover at run time. The consequence worth naming is downstream: the sentinel is not a
  `TaggedValue`, so any tier that reads registers without going through
  `RegisterFrame.getReg` sees an object of a type it has no case for. `getReg` and
  `UpvalueCell.get` handle it; [Ch 37 § reading-registers] shows the OSR argument reader
  taking registers straight out of the array.
- > **Unfinished.** `Scope.isConst` (helpers.ts:255-270) answers by two routes —
  `resolved.kind === "const"`, then a manual walk of `constSlots` that stops at
  `isFunctionBoundary`. Neither can see a captured binding: **both** `captureUpvalue`
  returns (221 and 231) build `{type: "upvalue", slot}` with no `kind` field at all, even
  though the descriptor pushed one line earlier records `kind` faithfully. So
  `resolved.kind` is `undefined`, `resolved.type !== "local"` short-circuits the walk,
  `isConst` answers `false`, and `compileAssignment`'s
  `Assignment to constant variable '<name>'` throw (expressions.ts:449-451) cannot fire
  for a `const` written from inside a closure. Cost of fixing: add
  `kind: outerResult.kind` to two object literals. Hard to observe from tera source
  today, because no parser path produces a `ConstDeclaration` node — only
  `src/frontend/checker/semantic-lowering.ts:124` does — which is itself worth stating
  once. [unpinned]

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter Series docs/example/stats.tera
node dist/cli.js --print-bytecode --filter '<script>' docs/example/stats.tera
node dist/cli.js --print-bytecode --filter scaler docs/example/stats-closure.tera
npx vitest run --project unit tests/bytecode/register/compiler/helpers.test.ts tests/bytecode/register/interpreter/frame.test.ts tests/runtime/intrinsics/environment.test.ts
npx vitest run --project e2e tests/e2e/language/classes.test.ts
```

The `do-while` half of § close-upvalues is reproduced by the fenced block in
§ Worked example, which writes both files into `$(mktemp -d)` and runs them.

## Tests that pin this

- `tests/bytecode/register/compiler/helpers.test.ts > "resolves locally defined variables"`
- `tests/bytecode/register/compiler/helpers.test.ts > "resolves through parent scope chain"`
- `tests/bytecode/register/compiler/helpers.test.ts > "returns null for undeclared variables"`
  — the resolution that becomes `ROP_STA_GLOBAL`.
- `tests/bytecode/register/compiler/helpers.test.ts > "child shadows parent with same name"`
- `tests/bytecode/register/compiler/helpers.test.ts > "defineVar sets kind to var"`
- `tests/bytecode/register/compiler/helpers.test.ts > "defineConst sets kind to const and marks constSlots"`
- `tests/bytecode/register/compiler/helpers.test.ts > "defineFunction sets kind to function"`
- `tests/bytecode/register/compiler/helpers.test.ts > "returns true for const-declared variables"`
- `tests/bytecode/register/compiler/helpers.test.ts > "returns false for let/var-declared variables"`
- `tests/bytecode/register/compiler/helpers.test.ts > "captures local from outer scope as upvalue when crossing function boundary"`
- `tests/bytecode/register/compiler/helpers.test.ts > "reuses same upvalue slot for repeated captures of same variable"`
- `tests/bytecode/register/compiler/helpers.test.ts > "does NOT capture as upvalue when no function boundary"`
  — the three that pin § resolve-and-the-boundary exactly.
- `tests/bytecode/register/compiler/helpers.test.ts > "detects simple constructor with field assignments from params"`
- `tests/bytecode/register/compiler/helpers.test.ts > "detects constructor with constant field initializer"`
- `tests/bytecode/register/compiler/helpers.test.ts > "returns null for empty constructor"`
- `tests/bytecode/register/compiler/helpers.test.ts > "returns null for constructor with non-simple patterns (e.g. ADD)"`
- `tests/bytecode/register/compiler/helpers.test.ts > "caches result on compiledFn.simpleConstructorInfo"`
- `tests/runtime/intrinsics/environment.test.ts > "reads from frame locals when open"`
- `tests/runtime/intrinsics/environment.test.ts > "writes to frame locals when open"`
- `tests/runtime/intrinsics/environment.test.ts > "close captures current value and detaches from frame"`
- `tests/runtime/intrinsics/environment.test.ts > "set after close writes to closedValue, not frame"`
- `tests/runtime/intrinsics/environment.test.ts > "close is idempotent"`
- `tests/runtime/intrinsics/environment.test.ts > "two cells sharing same frame slot see each other's writes when open"`
- `tests/runtime/intrinsics/environment.test.ts > "closing one cell doesn't affect another on same slot"`
  — the sharing invariant § open-cells-alias-the-frame stands on.
- `tests/runtime/intrinsics/environment.test.ts > "getUpvalue and setUpvalue delegate to cells"`
- `tests/bytecode/register/interpreter/frame.test.ts > "isTDZUninitialized identifies the sentinel"`
- `tests/bytecode/register/interpreter/frame.test.ts > "throwIfTDZ throws for uninitialized, passes through otherwise"`
- `tests/bytecode/register/interpreter/frame.test.ts > "marks uninitializedLocalSlots with TDZ sentinel"`
- `tests/bytecode/register/interpreter/frame.test.ts > "getReg throws on TDZ-uninitialized slot"`
- `tests/bytecode/register/interpreter/frame.test.ts > "getOrCreateUpvalueCell creates cell, getReg/setReg use it"`
- `tests/bytecode/register/interpreter/frame.test.ts > "getOrCreateUpvalueCell returns same cell for same slot"`
- `tests/bytecode/register/interpreter/frame.test.ts > "closeUpvalues captures values and detaches from frame"`
- `tests/bytecode/register/compiler.test.ts > "compiles function declaration without upvalues as LDA_CONST"`
- `tests/bytecode/register/compiler.test.ts > "compiles function declaration with upvalue as MAKE_CLOSURE"`
  — the two halves of § four-lines-of-codegen.
- `tests/bytecode/register/compiler.test.ts > "creates inner function as constant"`
- `tests/bytecode/register/compiler.test.ts > "compiles named function expression"`
  — `selfBindingSlot`.
- `tests/bytecode/register/compiler.test.ts > "binding kind recorded correctly per declaration type"`
- `tests/bytecode/register/compiler.test.ts > "script-scope var uses global cells not locals"`
  — § script-scope-is-different, pinned.
- `tests/bytecode/register/compiler.test.ts > "emits LDA_GLOBAL for unresolved identifier"`
- `tests/bytecode/register/compiler.test.ts > "emits LDA_REG for local variable"`
- `tests/bytecode/register/compiler.test.ts > "throws on assignment to const"`
- `tests/bytecode/register/compiler.test.ts > "creates new scope for block statements"`
- `tests/bytecode/register/compiler.test.ts > "outer variable accessible in inner block"`
- `tests/e2e/language/functions.test.ts > "runs recursion, closures, and arrow functions"`
- `tests/e2e/language/classes.test.ts > "constructs instances without new"`
- `tests/e2e/language/classes.test.ts > "initializes string literal fields in simple constructors"`
- `tests/e2e/language/classes.test.ts > "supports inheritance, super calls, and method override"`
- `tests/e2e/language/classes.test.ts > "inherits static members through the constructor chain"`
  — the second `SET_PROTO`.
- `tests/e2e/language/classes.test.ts > "keeps static members off instances and instance members off the class"`
- `tests/e2e/language/classes.test.ts > "supports static getters and setters on the class"`
  — `DEFINE_ACCESSOR` with one half `-1`.
- `tests/e2e/language/classes.test.ts > "runs private constructor calls from static field initializers"`
  — the static-field-initializer-as-function lowering.
- `tests/e2e/language/classes.test.ts > "allows keyword-named static class members"`
- `tests/e2e/language/classes.test.ts > "keeps instances independent"`
- `tests/e2e/language/classes.test.ts > "enforces implemented interface contracts at runtime without typecheck"`
- `tests/e2e/language/classes.test.ts > "runs classes that declare interface implementations"`
  — `ASSERT_CLASS_CONTRACTS`.
- `tests/e2e/language/classes.test.ts > "guards abstract class construction at runtime without typecheck"`
- `tests/e2e/docs/book-examples.test.ts > "covers every example file, so a new one cannot be added untested"`
  — the test a `stats-closure-loop.tera` variation would have to satisfy.
