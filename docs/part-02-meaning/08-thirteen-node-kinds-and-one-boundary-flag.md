# 8. Thirteen node kinds and one boundary flag   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Before checking anything the engine collapses the whole `NodeType` table into
thirteen semantic kinds and decides where every name lives; getting the second wrong made
the checker and the runtime disagree about a variable, and still does for one shape of
program.

**What arrived.** From ch 7: an `ASTNode` tree rooted at `NodeType.Program`, sixty-one
distinct `NodeType` names, positions on `__line`/`__column`/`__nameLine`/`__nameColumn`,
and annotation *source text* parked on `_paramInfo`, `_returnType`, `_typeParams`.

**What leaves.** A `SemanticProgram` (thirteen `SemanticNode` kinds, expression subtrees
still raw `ASTNode`) and a `BoundProgram` — `env`, `root` scope, a `WeakMap` from semantic
node to `Scope`, the `reserved` name set, and the `provenTakes` set that ch 13 explains.

**New ideas.** Lowering (one shape standing for many); a scope chain; a binding vs. a
name; why a checker wants a different tree than a code generator.

**Length.** 12 pages

## Anchors

- `src/frontend/checker/semantic-ast.ts` — the thirteen kinds: `TypeAliasNode`,
  `InterfaceNode`, `FunctionNode`, `ModelNode`, `ClassNode`, `BlockNode`, `JumpNode`,
  `ForNode`, `VarNode`, `DestructureNode`, `ReturnNode`, `ExprNode`, `ImportNode`, united
  as `SemanticNode`. Also `BlockTestRole = "guard" | "loop" | "subject" | "label"`,
  `branchChain`, `alwaysExits`, and the `gather`/`ownExpressions`/`nestedExpressions`
  trio whose `within` flag is what keeps expression subtrees raw.
- `src/frontend/checker/semantic-lowering.ts` — `astToSemanticProgram`,
  `lowerToSemanticProgram`, `toSemanticNodes` (27 statement cases, `default: return []`),
  `ifNodes` (builds the `otherwise` refutation list), `switchNodes` (one `subject` block
  wrapping one `label` block per case), `forStatementNodes`, `tryNodes`, `blockNode`,
  `expressionStatementNode` (a bare `x = e` becomes a `VarNode`, not an `ExprNode`).
- `src/frontend/checker/binder.ts` — `Scope` (`parent`, `locals`, `signatures`,
  `signature`, `classOwner`, `boundary`), `BoundProgram`, `bindProgram`, `bindNode`,
  `createScope`, `signatureFromParams`, `lookup`, `lookupWithinBoundary`,
  `lookupSignature`, `modelForwardSignature`.
- `src/bytecode/register/compiler/scope.ts` — the runtime half of the same rule:
  `scopeMethods._declareImplicitLocals`, `scanImplicitBindings` (with `NESTED_SCOPE_TYPES`
  cutting the walk at a nested function), `_declareLocal`, `_prescanStatement`,
  `_hoistVarsFromNode`, `_prepareFunctionBody`.

## Worked example

`docs/example/stats.tera` for the lowering (`while` → a `Block` with `testRole: "loop"`;
`class Series` → one `ClassNode` with two `ClassMemberNode`s), and a two-line pair for the
boundary:

```
x = 1          →  fn f(): x = 2   compiles to  Star r0   (a local)
x: int = 1     →  fn g(): x = 2   compiles to  StaUpvalue r0 (the outer binding)
```

Produced with `node dist/cli.js --print-bytecode --filter f <file>`.

## Outline

- [ ] **Why a code generator's tree is the wrong tree for a checker.** Establish that
      `if`/`while`/`do-while`/`for`/`switch`/`try` differ in *how control reaches a body*
      and not in *what a body means to a type*, so a checker that switches on all six
      repeats itself six times.
- [ ] **The collapse.** Establish the exact mapping in `toSemanticNodes`: 27 statement
      cases in, thirteen kinds out; `if` → `Block{test, testRole:"guard", otherwise}`,
      `while`/`do-while` → `Block{test, testRole:"loop"}`, `for(;;)` → three siblings
      (init, loop block, update), `switch` → `Block{testRole:"subject"}` over
      `Block{testRole:"label", subject}` children, `try` → up to three plain `Block`s.
- [ ] **What the collapse deliberately does not touch.** Establish the half-lowered
      design: statements are rewritten, expression subtrees stay raw `ASTNode`, and
      `gather`'s `within` parameter is the switch — `ownExpressions` stops at the first
      semantic node, `nestedExpressions` walks through them. Name the payoff: one
      `inferExpression` for both trees, and positions that still point at real source.
- [ ] **`testRole` is the only thing four constructs disagree about.** Establish that
      `"guard"` alone earns narrowing, `"loop"` never does (a `break` can leave the test
      true), `"label"` is compared against `subject`, `"subject"` just carries it.
- [ ] **Rebuilding an else-if chain from a flat list.** Establish `branchChain`: `ifNodes`
      emits siblings, each carrying the tests that failed before it in `otherwise`;
      `branchChain(body, at)` walks forward while a node has a non-empty `otherwise`, and
      stops at the first node with no `test` (the final `else`). Both the checker and the
      length-bounds pass call it, which is why they agree about arms.
- [ ] **The root scope is seeded from the language spec.** Establish `bindProgram`:
      `BUILTIN_SIGNATURES` and `GLOBAL_NAMESPACE_BINDINGS` into `root`, every name also
      into `reserved`; then external `builtins`, then `imports`. `reserved` is what
      `reportBuiltinRedeclaration` later reads.
- [ ] **One scope per declaration, and who owns `this`.** Establish `bindNode`'s per-kind
      scopes: a `Function` gets a boundary scope holding its parameters; a `Class` gets a
      class scope plus one boundary scope per member, each with `this` bound to the class
      name (or `typeof C` when static) and `classOwner` set; a `Block` and a `For` get
      ordinary non-boundary children.
- [ ] **A class with no constructor inherits its parent's signature.** Establish
      `binder.ts:222-241`: when `constructor === undefined && node.parent !== undefined`,
      the parent's `Signature` is copied and only `name`, `returns`, `owner`,
      `visibility`, `abstract` are replaced — so `class Cel extends Temp` is callable with
      `Temp`'s arguments without repeating them.
- [ ] **Three lines that decide what a bare `x =` means.** Establish `Scope.boundary`,
      `createScope(..., boundary = true)` on function and member scopes, and
      `lookupWithinBoundary` stopping at the first boundary. Then the mirror in the
      bytecode compiler: `_declareImplicitLocals` declares every plainly-assigned name a
      local unless `this.scope.resolve(name)` already finds it, and
      `scanImplicitBindings` refuses to descend into `NESTED_SCOPE_TYPES`.
- [ ] **Why the obvious design fails.** Stage the pre-gate checker: `lookup`, which walks
      past the boundary, so `fn f(): x = 2` was checked against the module-level `x` while
      the bytecode wrote a local. Show that the AOT strict gate (ch 16) is what made this
      visible, because a warning nobody read became a refusal.
- [ ] **And it is still wrong one way.** Establish the surviving asymmetry: a *bare*
      module-level `x = 1` becomes a hoisted script var that a function scope's `resolve`
      does not find, so the inner write is a local and checker and runtime agree; a
      *declared* `x: int = 1` is a real lexical binding, `resolve` finds it, the inner
      write compiles to `StaUpvalue`, and the checker — stopped by the boundary — says
      nothing. Give the mechanism, the two bytecode listings, and the general rule: a
      mirrored rule needs a shared implementation or a test that runs both halves.
- [ ] **The statement forms that vanish.** Establish that `toSemanticNodes` has no
      `LabeledStatement` case, so `default: return []` erases a labeled statement *and its
      whole body* from the semantic program. Nothing in the checker, the length-bounds
      pass, or the AOT gate can see inside one.
- [ ] **What leaves.** Restate the two artifacts and hand `provenTakes` forward to ch 13
      and the `Scope`/`Signature` pair to ch 9 and ch 11.

## Honesty items

> **Broken.** `astToSemanticProgram` in `src/frontend/checker/semantic-lowering.ts` has no
> `NodeType.LabeledStatement` case; `toSemanticNodes` falls to `default: return []` and
> the labeled statement's entire body disappears from the `SemanticProgram`. `outer: for
> r of [1, 2]: n: int = "text"` draws no diagnostic, and because the ahead-of-time gate is
> just "is the diagnostics array empty" (ch 16), `tera compile` writes a binary for it.
> Cost of finishing: one case forwarding to `toSemanticNodes(node.body)`, plus deciding
> what a `Jump` with a label means to `alwaysExits` — labeled `break`/`continue` are
> already flattened to unlabeled `JumpNode`s, which ch 19 shows is also how the backpatch
> bug got in.

> **Broken.** `lookupWithinBoundary` (`src/frontend/checker/binder.ts:341`) stops at the
> first `boundary` scope, but `scopeMethods._declareImplicitLocals`
> (`src/bytecode/register/compiler/scope.ts:380`) skips any name `this.scope.resolve(name)`
> already finds. For a *declared* module-level binding the two disagree: the runtime
> writes the outer binding (`StaUpvalue`), the checker checks nothing.
> `x: int = 1` / `fn g(): x = "text"` runs, prints `text` twice, and passes
> `--typecheck strict`. Cost of finishing: one rule, one owner — either the checker learns
> the compiler's `resolve` rule or the compiler learns the boundary rule.

> **Unenforced.** `Scope.boundary` and `lookupWithinBoundary` have no test naming them —
> `grep -rn "boundary" tests/` returns only bytecode-upvalue and numeric-range tests. The
> rule that keeps the checker and the runtime agreeing about a bare assignment is pinned
> only indirectly, by tests that are really about built-in redeclaration.

> **Unfinished.** `ModelNode` and `registerModelShape` exist for `model` declarations
> (`bindNode`'s `Model` branch sets `nominalFamilies[name] = "Module"` and
> `modelForwards`), a surface `docs/example/*.tera` never reaches. State the limit; the ML
> path is a sibling repo boundary (ch 28).

## Verify it yourself

```bash
node dist/cli.js --print-ast docs/example/queue.tera | head -20
node dist/cli.js -e 'x = 1
fn f():
  x = 2
  print(x)
f()
print(x)'
node dist/cli.js -e 'x: int = 1
fn g():
  x = 2
  print(x)
g()
print(x)'
node dist/cli.js check -e 'outer: for r of [1, 2]:
  n: int = "text"
  print(n)'
node dist/cli.js check -e 'for r of [1, 2]:
  n: int = "text"
  print(n)'
npx vitest run --project unit tests/frontend/checker/semantic-lowering.test.ts
```

The first two `-e` runs print `2` then `1`, and `2` then `2`: the same inner statement,
two different bindings. The two `check` runs differ only in the label, and only the
unlabeled one reports `Type 'string' is not assignable to 'int'`.

## Tests that pin this

- `tests/frontend/checker/semantic-lowering.test.ts` > "lowers a switch to a single block"
- `tests/frontend/checker/semantic-lowering.test.ts` > "marks the discriminant as a match subject rather than a condition"
- `tests/frontend/checker/semantic-lowering.test.ts` > "gives one nested block per case, default included"
- `tests/frontend/checker/semantic-lowering.test.ts` > "marks every case test as a label"
- `tests/frontend/checker/semantic-lowering.test.ts` > "hands every case the subject it is matched against"
- `tests/frontend/checker/semantic-lowering.test.ts` > "marks an if condition as a guard rather than a match label"
- `tests/frontend/checker/semantic-lowering.test.ts` > "marks a while condition as a loop, which no guard narrowing follows"
- `tests/frontend/checker/semantic-lowering.test.ts` > "hands an else branch the test it is the negation of"
- `tests/frontend/checker/semantic-lowering.test.ts` > "hands each arm of an elif chain every test that failed before it"
- `tests/frontend/checker/semantic-lowering.test.ts` > "lowers throw, break and continue to jumps a guard can exit through"
- `tests/frontend/checker/semantic-lowering.test.ts` > "keeps a nested switch inside its enclosing case"
- `tests/frontend/checker/type-checker.test.ts` > "lets a function keep a local of the same name"
- `tests/frontend/checker/type-checker.test.ts` > "lets a method keep a local of the same name"
- `tests/frontend/checker/type-checker.test.ts` > "refuses a top-level name the program still calls as a built-in"
- `tests/e2e/frontend/checker.test.ts` > "inherits members from a parent class via extends"
- `tests/bytecode/register/compiler/helpers.test.ts` > "captures local from outer scope as upvalue when crossing function boundary"
- `tests/bytecode/register/compiler/helpers.test.ts` > "does NOT capture as upvalue when no function boundary"
- The boundary rule itself: **[unpinned]**
- The `LabeledStatement` gap: **[unpinned]**
