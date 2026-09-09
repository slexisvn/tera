# 8. Thirteen node kinds and one boundary flag   ⟨I · B · J · N⟩

The parser's tree has sixty-one node types. The checker walks a different tree with
thirteen. That is not a simplification for the reader's benefit — it is a real second data
structure, built by a real second pass, and the reason it exists is that a checker asks
questions a code generator never asks. A code generator needs to know how control reaches a
body, because it has to emit the jumps. A checker needs to know what a body *means to a
type*, and by that measure `while`, `do-while`, `for(;;)`, `for-of` and `switch` are almost
the same construct: a region that may run more than once, so nothing you learned inside it
survives. Collapse them, and every analysis in the front end stops repeating itself six
times.

The collapse is one file, `src/frontend/checker/semantic-lowering.ts`. What comes out is a
`SemanticProgram`. It is then handed to `bindProgram`, which does the other half of this
chapter's work: it decides, for every name in the program, which scope that name lives in.
Getting the first half wrong loses a construct. Getting the second half wrong makes the
checker and the runtime disagree about a variable — which is exactly what happened here,
and, for one shape of program, still does.

This chapter is where the book's third artifact appears. The lexer produced tokens, the
parser produced a tree, and this stage produces the thing every later question is asked
against: a `BoundProgram`, whose `scopes` map answers "where does this name live" and whose
`env` answers "what does this type name mean". Nothing downstream re-derives either.

**What arrived.** From `[Ch 7 § what-leaves]`: the `ASTNode` tree exactly as `parseProgram`
built it, sixty-one `NodeType` names, plus two things nothing in Part I understands. The
first is annotation *source text* — the strings on `declaredType`, `_paramInfo` and
`_returnType`, never parsed, only sliced out of the token stream. The second is the spans,
`__line` / `__column` / `__nameLine` / `__nameColumn`, deliberately non-enumerable so that
two nodes with the same shape compare equal. Part II receives that object and nothing else.

## Why a code generator's tree is the wrong tree for a checker

Consider what the bytecode compiler must know about `while i < this.values.length:` in
`docs/example/stats.tera:9`. It must know that the test is evaluated before the body, that
a false test jumps past the body, that the end of the body jumps back to the test, and that
a `break` inside targets the instruction after the loop. Every one of those facts is about
*control*, and none of them is shared with `if`.

Now consider what the checker must know about the same line. It must know that the body may
run zero times, so a variable first assigned inside it is not guaranteed to exist
afterwards. It must know that the body may run many times, so a fact proven by the test —
`[Ch 1 § what-a-guard-proves]`'s count of how many elements an array is known to hold — has
to be re-established on each entry rather than carried forward. And it must know which
expressions belong to the construct itself (the test) versus to its body. That is the
complete list, and every item on it is equally true of `do-while`, of `for(;;)`, of `for x
of xs`, and of a `switch` case.

A checker written directly against the parser's tree has to say all of that six times, once
per `NodeType`. Worse, it has to say it six times in *each* analysis: once in the type
checker, once in the length-bounds pass, once in whatever comes next. The six copies drift.

> **New idea. Lowering.** *Lowering* is translating a program into a smaller language: fewer
> constructs, each doing more work. It is the compiler writer's main tool against
> combinatorial explosion, and it appears at every level of this engine — the parser lowers
> `a += b` into an assignment of a binary expression, the bytecode compiler lowers a `for`
> loop into a jump and a back edge, and the middle end lowers a `%` into a multiply and a
> subtract. The trade is always the same: you give up some information about how the source
> was written, and in exchange every consumer downstream has fewer cases to handle. The art
> is choosing *what* to give up. Lower too little and you have not helped; lower too much
> and you throw away the fact your analysis needed. This chapter is a case study in both
> halves of that.

## The collapse

`toSemanticNodes` (`src/frontend/checker/semantic-lowering.ts:92-147`) is a single switch
with twenty-seven `case` labels and one `default`. It answers with an array of
`SemanticNode`, and there are exactly thirteen of those:

```ts
export type SemanticNode =
  | TypeAliasNode
  | InterfaceNode
  | FunctionNode
  | ModelNode
  | ClassNode
  | BlockNode
  | JumpNode
  | ForNode
  | VarNode
  | DestructureNode
  | ReturnNode
  | ExprNode
  | ImportNode;
```
— `src/frontend/checker/semantic-ast.ts:185-198`

Five of the thirteen are declarations that survive more or less intact — `TypeAlias`,
`Interface`, `Function`, `Model`, `Class`. The interesting eight are what twenty-two
statement forms become.

`Block` absorbs the most. A bare block is a `Block`. A `while` or a `do-while` becomes a
`Block` carrying the test, tagged `testRole: "loop"`. An `if` becomes one or more `Block`s
tagged `"guard"`. A `try` becomes up to three plain `Block`s — the body, the handler
(carrying `catchVariable`), and the finalizer — with no marker saying which was which,
because to a type nothing distinguishes them. A `switch` becomes one `Block` tagged
`"subject"` whose children are one `Block` per case, each tagged `"label"` and each carrying
the discriminant in its `subject` field.

The middle of the switch shows the shape:

```ts
    case NodeType.BlockStatement:
      return [blockNode(node)];
    case NodeType.IfStatement:
      return ifNodes(node);
    case NodeType.WhileStatement:
    case NodeType.DoWhileStatement:
      return [blockNode(node.body as ASTNode, { test: node.test as ASTNode | undefined, testRole: "loop" }, spanOf(node))];
    case NodeType.ForInStatement:
      return forNode(node, "in");
    case NodeType.ForOfStatement:
      return forNode(node, "of");
    case NodeType.ForStatement:
      return forStatementNodes(node);
    case NodeType.TryStatement:
      return tryNodes(node);
```
— `src/frontend/checker/semantic-lowering.ts:106-120`

Note that the return type is an *array*. Three cases use that. `ifNodes` (`:337-348`) emits
one node per arm of an else-if chain, flat, as siblings. `tryNodes` (`:378-392`) emits one
per clause. And `forStatementNodes` (`:367-376`) takes a C-style `for (init; test; update)`
apart into three siblings: whatever the init lowers to, then a `Block` with `testRole:
"loop"` holding the body and the test, then an `Expr` for the update. There is no `for(;;)`
node kind at all. A three-part `for` simply *is* an initializer, a loop and an update, and
saying so is the whole lowering.

`For` — the one loop kind that survives as itself — exists only for `for x in` and `for x
of`, and only because those two bind a name the checker has to give a type to. Even then
`forNode` (`:350-365`) falls back to a `Block` with `testRole: "loop"` if the binding is not
a plain identifier or the iterable is missing.

Two more collapses are worth naming because they surprise people. `Let`, `Const` and `Var`
declarations all become the same `VarNode`; the semantic tree has no notion of mutability,
because assignability does not depend on it. And `expressionStatementNode` (`:471-491`)
looks at an expression statement whose expression is an assignment to a plain identifier and
emits a `Var` rather than an `Expr` — so `total = 0` on `stats.tera:7` and `total: float =
0.0` produce the same node kind, differing only in whether `declaredType` is set. That is
how tera can have no `let` keyword and still have one code path that decides what a name
means.

Run the whole of `stats.tera` through it and the twenty-four lines come out as nineteen:

```
Class  name="Series"
  Function  name="constructor"
    Expr
    Expr
  Function  name="mean"
    Var  name="total"
    Var  name="i"
    Block  testRole="loop"
      Expr
      Expr
    Return
  Function  name="label"
    Return
Function  name="report"
  Return
Var  name="latency"
Var  name="throughput"
Expr
Expr
```

There is no CLI flag that prints this. `lowerToSemanticProgram` is exported from `src/` but
is not in the package's public exports, and is imported only by the checker, the binder and
two tests; the dump above was produced by importing the module directly with `tsx`.
`[Ch 3 § forms-4-and-5-the-second-tree]` shows the same output as one of the running example's fourteen
representations.

## What the collapse deliberately does not touch

The lowering stops at statements. Every expression in the program is still a raw `ASTNode`,
hanging off a semantic node's `test`, `value`, `iterable`, `subject` or `otherwise` field.
`total += this.values[i]` is one `Expr` whose `value` is the parser's `AssignmentExpression`,
unchanged, spans intact.

This is not laziness; it is the design's whole economy. There is exactly one
`inferExpression`, and it walks the parser's tree. If expressions had been lowered too,
there would be two expression languages to infer over, or one lowering that also had to
carry the source positions forward — and positions that survive a rewrite are how you get
diagnostics pointing at column 18 of line 6 instead of at a synthesized node.

The cost is that a walker crossing between the two trees needs to know where the boundary
is. One function does it for both:

```ts
function gather(held: unknown, found: ASTNode[], within: boolean): void {
  if (held === null || typeof held !== "object") return;
  if (Array.isArray(held)) {
    for (const item of held) gather(item, found, within);
    return;
  }
  if (SEMANTIC_KIND in held) {
    if (within) for (const value of Object.values(held)) gather(value, found, within);
    return;
  }
  if (AST_KIND in held) {
    found.push(held as ASTNode);
    return;
  }
  for (const value of Object.values(held)) gather(value, found, within);
}
```
— `src/frontend/checker/semantic-ast.ts:232-247`

`SEMANTIC_KIND` is the string `"kind"` and `AST_KIND` is `"type"`. Which tree an object
belongs to is decided by which discriminant property it has, and the `within` flag decides
what happens when the walk reaches a semantic node: stop, or descend.

The two exports differ only in that flag. `ownExpressions(node)` passes `false`, so it
returns the expressions this node *owns* and stops at the first nested semantic node —
a loop's test, but not the expressions in its body. `nestedExpressions(body)` passes `true`
and walks the entire subtree.

Each has exactly one kind of consumer, and the split is the point. `ownExpressions` is used
only by `src/frontend/checker/length-bounds.ts` (at `:56`, `:150` and `:191`) — the analysis
that must *not* look inside a nested function, because a function body may run later or
never. `nestedExpressions` is used once, by `calledNames`
(`src/frontend/checker/type-checker.ts:1392-1396`), which collects every identifier the
program calls anywhere, at any depth, because "is this built-in name still being called?" is
a question about the whole program. One walker, one flag, two analyses that would otherwise
each need their own traversal.

## `testRole` is the only thing four constructs disagree about

`BlockNode` carries an optional `test` and an optional tag:

```ts
export type BlockTestRole = "guard" | "loop" | "subject" | "label";
```
— `src/frontend/checker/semantic-ast.ts:108`

Four values, and each one is a different answer to "what may I conclude from this test?"

`"guard"` is the only one that earns narrowing. An `if` test is known true on entry to the
body and there is no way back to the top, so a fact the test establishes holds for the whole
body
`[t: tests/frontend/checker/semantic-lowering.test.ts > "marks an if condition as a guard rather than a match label"]`.

`"loop"` never narrows, and the reason is worth being precise about, because it is not
obvious. The test *is* true when the body begins — that much is the same as a guard. What
differs is that the body can run again, and a `break` can leave with the test still true,
and, most importantly, the body can change the thing the test measured. `queue.tera`'s
`while q.length > 0` is exactly this: the guard proves one element, and then the body spends
it. Treating a loop test as a guard would license the second `shift()`
`[t: tests/frontend/checker/semantic-lowering.test.ts > "marks a while condition as a loop, which no guard narrowing follows"]`.
What the length-bounds pass does instead — re-read the test from *inside* an isolated
region, then discard everything the region touched — is `[Ch 13 § three-ways-to-lose-a-count]`.

`"subject"` carries the discriminant and concludes nothing; it exists so the case blocks
have somewhere to hang. `"label"` is the case test, and it is the only role compared against
a second expression: each case block also stores the discriminant in `subject`, so the
checker can ask whether this label is a possible value of that subject without walking back
up the tree
`[t: tests/frontend/checker/semantic-lowering.test.ts > "hands every case the subject it is matched against"]`.
A nested switch stays nested inside its enclosing case rather than being flattened
`[t: tests/frontend/checker/semantic-lowering.test.ts > "keeps a nested switch inside its enclosing case"]`.

The invariant is that every construct which can narrow is tagged `"guard"` and no other
construct is. Enforcement is structural: `"guard"` is written in exactly one place,
`ifNodes` (`semantic-lowering.ts:340`), and every consumer that narrows checks for it — the
type checker at `:128`, `branchChain` at `semantic-ast.ts:211` and `:216`. The tests above
pin each role.

## Rebuilding an else-if chain from a flat list

`ifNodes` flattens an else-if chain into siblings, which is convenient for a walker and
destructive for anything that needs to know the arms belong together. So the chain is
reconstructed on demand, from information each arm carries.

Every arm stores, in `otherwise`, the tests that failed before it. The first arm gets an
empty list; the second gets one test; a final bare `else` gets all of them and no `test` of
its own
`[t: tests/frontend/checker/semantic-lowering.test.ts > "hands each arm of an elif chain every test that failed before it"]`.
`ifNodes` builds that list by appending as it recurses (`:344-346`), and the same mechanism
gives an `else` branch the test it is the negation of
`[t: tests/frontend/checker/semantic-lowering.test.ts > "hands an else branch the test it is the negation of"]`.

Reading it back is `branchChain`:

```ts
export function branchChain(body: readonly SemanticNode[], at: number): BlockNode[] {
  const first = body[at];
  if (first?.kind !== "Block" || first.test === undefined) return [];
  if (first.testRole !== "guard" || (first.otherwise ?? []).length > NO_ALTERNATIVE) return [];
  const chain: BlockNode[] = [first];
  for (let next = at + 1; next < body.length; next++) {
    const node = body[next];
    if (node?.kind !== "Block" || (node.otherwise ?? []).length === NO_ALTERNATIVE) break;
    if (node.test !== undefined && node.testRole !== "guard") break;
    chain.push(node);
    if (node.test === undefined) break;
  }
  return chain;
}
```
— `src/frontend/checker/semantic-ast.ts:208-221`

It starts only at a chain *head* — a guard with an empty `otherwise` — and walks forward
while each successor has a non-empty one, stopping after the first node with no `test`,
which is the final `else`. A `Block` that is not part of any chain (a bare block, a loop, a
switch) fails one of the two guards and ends the walk.

The payoff is that two independent passes agree about arms without coordinating. The type
checker calls it at `type-checker.ts:65` to decide which narrowed scopes to merge; the
length-bounds pass calls it at `length-bounds.ts:128` to decide which branches' counts to
combine with `leastRemaining`. Neither re-derives the chain, so neither can disagree about
where it ends.

## The root scope is seeded from the language spec

`bindProgram` is where the second half of the chapter starts. Before it looks at a single
line of the user's program it fills a root scope from tables:

```ts
export function bindProgram(program: SemanticProgram, options: BindOptions = {}): BoundProgram {
  validateBindOptions(options);
  const root = createScope(null);
  const reserved = new Set<string>();
  for (const [name, sig] of BUILTIN_SIGNATURES) {
    root.signatures.set(name, sig);
    reserved.add(name);
  }
  for (const spec of options.builtins ?? []) {
    root.signatures.set(spec.name, signatureFromExternal(spec));
    reserved.add(spec.name);
  }
  for (const [name, type] of GLOBAL_NAMESPACE_BINDINGS) {
    root.locals.set(name, { type, optional: false, declared: true });
    reserved.add(name);
  }
```
— `src/frontend/checker/binder.ts:301-316`

`BUILTIN_SIGNATURES` is built at module load from `data/tera-language-spec.ts`, the 8,251-line
single source of truth that `[Ch 9 § consumer-four-the-symbol-table]` and `[Ch 74 § one-spec-four-surfaces]`
follow further. Measured on this tree it holds 284 entries. `GLOBAL_NAMESPACE_BINDINGS`
holds five — `Math`, `JSON`, `Object`, `Promise`, `chart` — and those go into `locals`
rather than `signatures`, because you can pass `Math` around as a value. The union is 287
names in `reserved`.

> **New idea. A binding, a name, and a scope chain.** A *name* is text in the source. A
> *binding* is the record a name resolves to — here a `{ type, optional, declared }` object.
> The two are not the same thing: the same name can be many bindings (one per scope), and
> one binding can be reached by many names (through an alias or an import). A *scope* is a
> map from names to bindings, plus a pointer to a parent scope; the chain of parents is the
> *scope chain*, and resolving a name means walking up it until a map has the name. Every
> question about "which `x` is this?" is a question about where the walk stops.

`reserved` is not the scope chain — it is a flat set of names, kept separately because the
question it answers is not "what does this name mean here" but "is the program still calling
the built-in this name would shadow". `reportBuiltinRedeclaration`
(`type-checker.ts:1274-1280`) requires all three of: the name is reserved, the declaration is
at module level, and the name appears in `calledNames`. So:

```
$ node dist/cli.js check -e 'print = 1
print(2)'
[eval]:1:1: error: Cannot redeclare built-in 'print'
```

but a local of the same name inside a function is fine, because the second condition fails
`[t: tests/frontend/checker/type-checker.test.ts > "lets a function keep a local of the same name"]`
`[t: tests/frontend/checker/type-checker.test.ts > "lets a method keep a local of the same name"]`,
and a module-level `print = 1` in a program that never calls `print` is also fine, because
the third does
`[t: tests/frontend/checker/type-checker.test.ts > "refuses a top-level name the program still calls as a built-in"]`.

## One scope per declaration, and who owns `this`

`bindNode` (`binder.ts:167-286`) walks the semantic program and creates scopes. Which
declarations get one, and what goes in it, is the whole of the rule.

A `Function` gets a scope holding its parameters, created with `createScope(scope, sig,
true)` — the third argument is the boundary flag the next section is about. A `Block` and a
`For` get ordinary child scopes, created with `createScope(scope, scope.signature)` and no
boundary; a `For` also puts its loop variable in as `any`, and a `Block` with a
`catchVariable` puts the caught name in as `any`. A `Var` gets nothing at all — `bindNode`'s
`Var` branch is an empty return (`:283-285`), because what a bare assignment declares is
decided later, by the type checker, once it knows the value's type.

A `Class` gets two levels. The class scope holds the class name bound to `` `typeof ${name}` ``
and carries `classOwner`. Each member then gets its own boundary scope under it:

```ts
    for (const member of node.members) {
      const memberSig = signatureFromParams(member.fn.name, member.fn.typeParams, member.fn.params, member.fn.returns, {
        visibility: member.visibility,
        owner: node.name,
        abstract: member.abstract,
      });
      if (member.static && member.memberKind !== "constructor") {
        scope.signatures.set(`${node.name}.${member.fn.name}`, memberSig);
      }
      const child = createScope(classScope, memberSig, true);
      child.classOwner = node.name;
      bound.scopes.set(member.fn, child);
      child.locals.set("this", { type: member.static ? staticType : node.name, optional: false, declared: true });
      for (const [name, binding] of memberSig.params) child.locals.set(name, { ...binding, declared: true });
      for (const stmt of member.fn.body) bindNode(stmt, bound, child);
    }
```
— `src/frontend/checker/binder.ts:251-266`

`this` is an ordinary local. There is no special form for it anywhere in the checker: inside
`Series.mean` it is a binding whose type is the string `"Series"`, and inside a static method
it is a binding whose type is the string `"typeof Series"`. That is the whole of the
receiver model at this stage. A static member is *also* registered on the enclosing scope
under its dotted name, so `Series.of(...)` resolves as a signature lookup rather than a
member access.

The scopes are not stored on the nodes. They go into `bound.scopes`, a
`WeakMap<SemanticNode, Scope>` (`binder.ts:32`), which keeps the semantic tree a plain data
structure and lets the whole map be collected when the program is.

## A class with no constructor inherits its parent's signature

One branch of the `Class` case is worth its own section because it is a design decision that
is easy to miss and impossible to reverse-engineer from behaviour:

```ts
    const inherited =
      constructor === undefined && node.parent !== undefined
        ? lookupSignature(scope, node.parent) ?? null
        : null;
    const sig: Signature =
      inherited === null
        ? signatureFromParams(node.name, [], constructor?.fn.params ?? [], node.name, {
            visibility: constructor?.visibility ?? DEFAULT_CLASS_VISIBILITY,
            owner: node.name,
            abstract: node.abstract,
          })
        : {
            ...inherited,
            name: node.name,
            returns: node.name,
            owner: node.name,
            visibility: DEFAULT_CLASS_VISIBILITY,
            abstract: node.abstract,
          };
```
— `src/frontend/checker/binder.ts:223-241`

When a class declares no constructor and does have a parent, the parent's `Signature` is
copied wholesale and exactly five fields are replaced: `name`, `returns`, `owner`,
`visibility`, `abstract`. Everything that describes the *arguments* — `params`, `required`,
`positional`, `typeParams`, `rest` — is inherited untouched.

So a subclass is callable with its parent's arguments without repeating them, and the
inherited arity and types are really checked:

```
$ node dist/cli.js check -e 'class Temp:
  public constructor(deg: float):
    this.deg = deg

class Cel extends Temp:
  public unit() -> string:
    return "C"

c = Cel("hot")
print(c.unit())'
[eval]:9:9: error: Type 'string' is not assignable to parameter 'deg: float'
```

`Cel` never wrote a constructor; the diagnostic still names `Temp`'s parameter by its own
name and type. The behaviour is pinned by
`[t: tests/e2e/frontend/checker.test.ts > "inherits members from a parent class via extends"]`.

Note the ordering dependency this creates: `lookupSignature(scope, node.parent)` is a
lookup, at bind time, of a name that must already be in a scope. Classes are bound in source
order (`bindProgram`'s final loop, `:327`), so a subclass declared before its parent finds
nothing and falls into the `inherited === null` arm with no parameters at all. Nothing in the
tree checks for that.

## Three lines that decide what a bare `x =` means

Here is the whole of the boundary mechanism. `Scope` has an optional flag:

```ts
export type Scope = {
  parent: Scope | null;
  locals: Map<string, Binding>;
  signatures: Map<string, Signature>;
  signature?: Signature;
  classOwner?: string | null;
  boundary?: boolean;
};
```
— `src/frontend/checker/binder.ts:19-26`

`createScope` sets it only when told to (`boundary = false` by default, `:297`), and it is
told to in exactly two places: the `Function` case (`:198`) and the class-member case
(`:260`). Model sections get one too (`:215`). Blocks, `for` bodies and class scopes do not.

Then there are two lookups, differing by three lines:

```ts
export function lookupWithinBoundary(scope: Scope, name: string): Binding | undefined {
  let current: Scope | null = scope;
  while (current) {
    const binding = current.locals.get(name);
    if (binding) return binding;
    if (current.boundary) return undefined;
    current = current.parent;
  }
  return undefined;
}
```
— `src/frontend/checker/binder.ts:341-350`

`lookup` (`:331-339`) is the same loop without the `if (current.boundary)` line. It walks all
the way to the root.

The point of the boundary version is `checkVar`. When the checker meets a `Var` with no
declared type — a bare `x = 2` — it asks `lookupWithinBoundary(scope, node.name)`
(`type-checker.ts:521`). If that answers a binding, this statement is an *assignment* to an
existing name and the value must be compatible with it. If it answers nothing, this
statement *declares* a new name, and the binding is written into `functionScope(scope)`
(`:545`), which walks up to the first boundary:

```ts
function functionScope(scope: Scope): Scope {
  let current = scope;
  while (!current.boundary && current.parent) current = current.parent;
  return current;
}
```
— `src/frontend/checker/type-checker.ts:1460-1464`

The bytecode compiler has to make the same decision, on the raw AST, with no scopes and no
semantic tree. It does it with a different mechanism that is supposed to reach the same
answer:

```ts
  _declareImplicitLocals(this: ScopeCompiler, statements: ASTNode[]) {
    if (this.scope.isScript) return;
    const scan: ImplicitScan = { assigned: new Set(), escaped: new Set() };
    scanImplicitBindings(statements, scan);
    for (const name of scan.assigned) {
      if (this.scope.locals.has(name)) continue;
      if (this.scope.resolve(name)) continue;
      this._declareLocal(name, "var");
    }
  },
```
— `src/bytecode/register/compiler/scope.ts:380-389`

`scanImplicitBindings` (`:75-114`) walks the function's statements collecting names that are
plainly assigned, and refuses to descend into `NESTED_SCOPE_TYPES` (`:64-71`) — function
declarations, function and arrow expressions, class and model declarations — which is the
compiler's version of a boundary, applied to the walk instead of to the lookup. It also
tracks an `escaped` set: a name that is *read* before it is assigned is not treated as an
implicit local, so `x = x + 1` inside a function writes the outer `x` while `x = 1` declares
a new one.

Then the decisive line: `if (this.scope.resolve(name)) continue`. If the compiler's own
scope chain already finds the name, the assignment writes that binding instead of declaring
a local — and `resolve` does not stop at a boundary. The upvalue machinery is pinned by
`[t: tests/bytecode/register/compiler/helpers.test.ts > "captures local from outer scope as upvalue when crossing function boundary"]`
and
`[t: tests/bytecode/register/compiler/helpers.test.ts > "does NOT capture as upvalue when no function boundary"]`.

So there are two rules for one question, in two files, with no shared code. The next two
sections are what that costs.

## Why the obvious design fails

*(Why the obvious design fails.)*

The obvious design is the one function. A checker needs to resolve names; resolving a name
means walking the scope chain to the root; write `lookup`, use it everywhere. That is what
this checker did, and `lookup` is still there and still used for every other purpose.

Under that design, `fn f(): x = 2` inside a program with a module-level `x` resolved to the
module-level `x`. The checker therefore type-checked the inner statement as an assignment:
whatever `x` was declared to hold, `2` had to be compatible with it. Meanwhile the bytecode
compiler's `_declareImplicitLocals` saw a plainly-assigned name, asked `this.scope.resolve`,
found nothing — because a *bare* module-level `x = 1` compiles to a global (`StaGlobal`)
rather than being entered in the compiler's lexical scope chain — and declared a fresh local.

Two machines, one statement, two different variables. The checker was validating a write to
the outer binding; the runtime was performing a write to an inner one. Nothing detected it,
because the checker's opinion had no consequence: in the default `warn` mode a diagnostic is
stored on `Engine.diagnostics` and never read (`[Ch 1 § the-gate]`).

What made it visible was the ahead-of-time gate. `[Ch 16 § one-field-one-word]` forces
strict mode for every `tera compile`, and strict mode turns a stored diagnostic into a
refusal. A disagreement nobody read became a program that would not build. The fix was
`lookupWithinBoundary` and the `boundary` flag: stop the walk where the runtime's walk
effectively stops, so a bare assignment inside a function declares a function-local name in
the checker exactly as it does in the compiler.

The general rule is convention 7's, applied to a rule rather than an invariant: **a rule
implemented twice needs either a shared implementation or a test that runs both halves
against the same program.** Neither exists here, which is the subject of the next section
and of this chapter's `> **Unenforced.**` callout.

> **Unenforced.** `Scope.boundary` (`src/frontend/checker/binder.ts:25`) and
> `lookupWithinBoundary` (`:341-350`) have no test that names them. `grep -rn "boundary"
> tests/` returns sixteen hits and not one is about this rule — two are the bytecode upvalue
> tests above, and the rest are unrelated ("call boundary", "byte boundary", "growth
> boundary", a dataflow `boundary` callback). The rule that keeps the checker and the
> runtime agreeing about a bare assignment is pinned only indirectly, by tests that are
> really about built-in redeclaration. Cost of fixing: one test file that, for each of a
> handful of shapes, compiles the program *and* checks it and asserts the two agree about
> which binding a bare `x =` wrote.

## And it is still wrong one way

The boundary flag fixed the direction that was breaking builds. It did not make the two
rules the same rule, and there is a shape of program where they still disagree — in the
opposite direction, which is why nobody noticed.

The difference is whether the module-level binding is *bare* or *declared*.

```
$ node dist/cli.js -e 'x = 1
fn f():
  x = 2
  print(x)
f()
print(x)'
2
1
```

```
$ node dist/cli.js -e 'x: int = 1
fn g():
  x = 2
  print(x)
g()
print(x)'
2
2
```

The same inner statement, `x = 2`, writes two different variables. The bytecode says so
directly:

```
=== f (params=0, locals=1, registers=3, constants=2) ===
Locals: r0=x
Instructions:
     0  LdaConst [0] (2)
     1  Star r0
```

```
=== g (params=0, locals=0, registers=2, constants=2) ===
Instructions:
     0  LdaConst [0] (2)
     1  StaUpvalue r0
```

`Star r0` stores to a local slot; `StaUpvalue r0` stores through a captured reference to the
outer binding. Both were produced with
`node dist/cli.js --print-bytecode --filter f` and `--filter g`.

The mechanism is what the *outer* binding compiled to, and the module-level bytecode says
that just as plainly:

```
$ node dist/cli.js --print-bytecode -e 'x = 1
print(x)'
=== <script> (params=0, locals=0, registers=2, constants=3) ===
Instructions:
     0  LdaConst [0] (1)
     1  StaGlobal [1] (x)
```

```
$ node dist/cli.js --print-bytecode -e 'x: int = 1
print(x)'
=== <script> (params=0, locals=1, registers=3, constants=2) ===
Locals: r0=x
Instructions:
     0  LdaConst [0] (1)
     1  Star r0
```

(Both listings continue with the `print` call; only the first two instructions differ, and
the `Constants:` blocks are elided.)

A bare module-level `x = 1` compiles to `StaGlobal`, because `_declareImplicitLocals` returns
immediately at script scope (`if (this.scope.isScript) return`, `scope.ts:381`) and nothing
else declares it — the statement is an `ExpressionStatement`, so `_prescanStatement` never
sees it either. A global is not in the compiler's lexical scope chain, so
`this.scope.resolve("x")` inside `f` finds nothing and the inner `x = 2` is declared a local.
A declared `x: int = 1` is a `LetDeclaration`, `_prescanStatement` declares it lexically
(`:220-227`), `resolve` finds it from inside `g`, and the inner write becomes an upvalue
store.

The checker does not distinguish the two cases at all, because
`lookupWithinBoundary` stops at `g`'s boundary either way and reports no previous binding.
So it treats `x = 2` as a fresh function-local declaration of type `int` and says nothing.

> **Broken.** `lookupWithinBoundary` (`src/frontend/checker/binder.ts:341-350`) stops at the
> first `boundary` scope, but `scopeMethods._declareImplicitLocals`
> (`src/bytecode/register/compiler/scope.ts:380-389`) skips any name `this.scope.resolve(name)`
> already finds, and `resolve` has no boundary. For a *declared* module-level binding the two
> disagree: the runtime writes the outer binding, the checker checks nothing.
> `x: int = 1` followed by `fn g(): x = "text"` runs, prints `text` twice, and passes
> `node dist/cli.js --typecheck strict` with exit 0 — a `string` written through a binding
> declared `int`, with no diagnostic at any of the three doors. Cost of finishing: one rule
> with one owner. Either the checker learns the compiler's `resolve` rule (which means
> modelling script-var hoisting in the binder), or the compiler learns the boundary rule
> (which means a declared module-level binding stops being capturable, and is a language
> change, not a bug fix).

## The statement forms that vanish   ⟨— · — · — · N⟩

`toSemanticNodes`'s switch has twenty-seven cases and this default:

```ts
    default:
      return [];
```
— `src/frontend/checker/semantic-lowering.ts:144-145`

An unhandled statement does not become an unknown node, or an `Expr`, or an empty `Block`.
It returns *nothing* — and because the recursion goes through the same function, its entire
body returns nothing with it.

There is no `NodeType.LabeledStatement` case. The book's own example set has a labeled
statement in it, `docs/example/labeled.tera`, and lowering that file produces this:

```
Var  name="rows"
```

One node. The program is seven lines with two nested loops, an `if`, a `continue outer` and
a `print`; the semantic program is the array literal on line 1 and nothing else. The AST is
intact — `node dist/cli.js --print-ast docs/example/labeled.tera` shows
`LabeledStatement  label="outer"` with the whole tree hanging off it — so the interpreter,
the baseline compiler and both compiling tiers run the program correctly, and it prints
`1`, `2`, `3`, `5`, `6`, `7` on six lines
`[t: tests/e2e/docs/book-examples.test.ts > "labeled.tera resumes the outer loop instead of restarting the program"]`.
It is only the checker that cannot see it, along with the length-bounds pass and the
`calledNames` scan, all three of which walk the semantic program.

The consequence lands on the native road, because the checker's diagnostics array is the
only thing standing between a program and a binary:

> **Broken.** `astToSemanticProgram` (`src/frontend/checker/semantic-lowering.ts:87-90`) has
> no `NodeType.LabeledStatement` case; `toSemanticNodes` falls to `default: return []` and
> the labeled statement's entire body disappears from the `SemanticProgram`. Measured on
> this tree, 2026-09-07: the three-line program `outer: for r of [1, 2]:` / `n: int = "text"`
> / `print(n)` draws no diagnostic from `node dist/cli.js check` and exits 0, while the same
> program without the label reports `[eval]:2:12: error: Type 'string' is not assignable to
> 'int'` and exits 1. Because the ahead-of-time gate is "is the diagnostics array empty"
> (`[Ch 16 § one-field-one-word]`), `node dist/cli.js compile` writes a 9,770-byte PE
> executable for the labeled version, and running it prints `text` twice. Cost of finishing:
> one case forwarding to `toSemanticNodes(node.body)`, plus a decision about what a labeled
> jump means to `alwaysExits` — `break` and `continue` are already flattened to unlabeled
> `JumpNode`s (`semantic-lowering.ts:136-139`) with their `label` field dropped, which is the
> same information loss that `[Ch 19 § the-bug]` shows on the bytecode side.

`src/frontend/ast/index.ts` declares twenty-seven node types that can appear in statement
position. Twenty-five of them have a case. The two that do not are `EmptyStatement`, which
carries nothing and loses nothing, and `LabeledStatement`, which carries an entire program.

> **Unfinished.** `ModelNode` (`src/frontend/checker/semantic-ast.ts:67-74`) and the `Model`
> branch of `bindNode` (`binder.ts:204-220`) exist for `model` declarations: the branch
> registers `nominalFamilies[name] = "Module"`, builds a forward signature from a member
> named `forward` (`modelForwardSignature`, `:292-295`), and gives each model *section* its
> own boundary scope. No file in `docs/example/` declares a `model`, so the running example
> never reaches any of it, and this book states the limit rather than contriving a ninth
> variation (convention 2). The surface exists because the ML path is a sibling repository —
> `mlfw` — and models are how a tera program hands work across that boundary; the interface
> is described in `[Ch 28 § four-other-compilers-described-only-by-interface]` and its internals are out of scope
> (convention 19).

## What leaves

Two artifacts, and everything in Part II is asked against them.

**A `SemanticProgram`** — a `{ body: SemanticNode[] }` of thirteen kinds, in which control
constructs have become `Block`s tagged by `testRole`, an else-if chain is a flat list each of
whose arms carries the tests that failed before it, and every expression subtree is still the
parser's own `ASTNode` with its spans intact. Two walkers, `ownExpressions` and
`nestedExpressions`, cross between the trees, differing only in whether they stop at a
semantic node.

**A `BoundProgram`** (`binder.ts:28-35`) — the `env` holding type aliases, interfaces,
nominal families and abstract classes; the `root` scope seeded with 284 builtin signatures
and five global namespaces; a `WeakMap` from semantic node to `Scope`, with `boundary` set on
function scopes, class-member scopes and model sections and nowhere else; the `reserved` set
of 287 names; and `provenTakes`, the set of call-site AST nodes a length guard licensed,
computed at `:323` and explained in `[Ch 13 § handing-the-answer-to-the-checker]`.

One detail of the `BoundProgram` is the whole subject of the next chapter. Every type in it
is already a *string*, and already normalized: `signatureFromParams` runs `cleanType` over
every parameter type and the return type (`binder.ts:93` and `:103`), `bindNode` runs it over
alias bodies, interface fields, interface parents and indexer key and value types, and
`semantic-lowering.ts` ran it again on the way in, at `typeAliasNode`, `interfaceNode`,
`functionNode` and `paramsFromInfo`. Nothing in this engine ever builds a type *object*.
`[Ch 9 § the-one-line-decision]` takes that apart — what the decision buys, the one character
of lookbehind the whole format rests on, and the four consumers downstream that re-parse the
text rather than being handed a structure.

## Verify it yourself

```bash
# the parser's tree: sixty-one node types, spans, raw annotation text
node dist/cli.js --print-ast docs/example/queue.tera | head -20

# a bare module-level binding: the inner write is a local. prints 2 then 1
node dist/cli.js -e 'x = 1
fn f():
  x = 2
  print(x)
f()
print(x)'

# a declared module-level binding: the inner write is an upvalue. prints 2 then 2
node dist/cli.js -e 'x: int = 1
fn g():
  x = 2
  print(x)
g()
print(x)'

# the same two programs in bytecode: Star r0 versus StaUpvalue r0
node dist/cli.js --print-bytecode --filter f -e 'x = 1
fn f():
  x = 2
  print(x)
f()'
node dist/cli.js --print-bytecode --filter g -e 'x: int = 1
fn g():
  x = 2
  print(x)
g()'

# the Broken boundary item: a string written through an int binding, strict mode, exit 0
node dist/cli.js --typecheck strict -e 'x: int = 1
fn g():
  x = "text"
  print(x)
g()
print(x)'; echo "exit=$?"

# the Broken LabeledStatement item: same program, label or no label
node dist/cli.js check -e 'outer: for r of [1, 2]:
  n: int = "text"
  print(n)'; echo "exit=$?"
node dist/cli.js check -e 'for r of [1, 2]:
  n: int = "text"
  print(n)'; echo "exit=$?"

# the lowering, and the roles four constructs disagree about (14 tests)
npx vitest run --project unit tests/frontend/checker/semantic-lowering.test.ts
```

The two `-e` runs print `2` then `1`, and `2` then `2`: the same inner statement, two
different bindings. The strict run prints `text` twice and exits 0. The two `check` runs
differ only in the label, and only the unlabeled one reports
`[eval]:2:12: error: Type 'string' is not assignable to 'int'`.

The semantic-program dumps in this chapter have no CLI flag behind them.
`lowerToSemanticProgram` is not in the package's public exports; reproducing them means
importing `src/frontend/checker/semantic-lowering.ts` directly, for example with `npx tsx`,
and printing `kind`, `name` and `testRole` for each node. The `labeled.tera` result — one
`Var` node for a seven-line program — is the shortest way to see the gap.

## Tests that pin this

- `tests/frontend/checker/semantic-lowering.test.ts` > `"lowers a switch to a single block"`
  — twenty-seven statement cases, thirteen kinds: a whole `switch` is one `Block`.
- `tests/frontend/checker/semantic-lowering.test.ts` > `"marks the discriminant as a match subject rather than a condition"`
  — the `"subject"` role exists so the discriminant is not mistaken for a guard.
- `tests/frontend/checker/semantic-lowering.test.ts` > `"gives one nested block per case, default included"`
  — three cases in, three child blocks out.
- `tests/frontend/checker/semantic-lowering.test.ts` > `"marks every case test as a label"`
  — and `"hands every case the subject it is matched against"`, which is why a case block
  can be checked without walking back up the tree.
- `tests/frontend/checker/semantic-lowering.test.ts` > `"marks an if condition as a guard rather than a match label"`
  — the only role that earns narrowing.
- `tests/frontend/checker/semantic-lowering.test.ts` > `"marks a while condition as a loop, which no guard narrowing follows"`
  — the role that does not, and the reason `queue.tera` refuses its second `shift()`.
- `tests/frontend/checker/semantic-lowering.test.ts` > `"hands an else branch the test it is the negation of"`
  and > `"hands each arm of an elif chain every test that failed before it"`
  — the `otherwise` lists `branchChain` walks back into a chain.
- `tests/frontend/checker/semantic-lowering.test.ts` > `"lowers throw, break and continue to jumps a guard can exit through"`
  — three statement forms into one `JumpNode`, distinguished only by `via`.
- `tests/frontend/checker/semantic-lowering.test.ts` > `"keeps a nested switch inside its enclosing case"`
  — the flattening is per-construct, not global.
- `tests/frontend/checker/type-checker.test.ts` > `"lets a function keep a local of the same name"`
  and > `"lets a method keep a local of the same name"`
  — `reportBuiltinRedeclaration` fires only at module level.
- `tests/frontend/checker/type-checker.test.ts` > `"refuses a top-level name the program still calls as a built-in"`
  — and only when `calledNames` still contains the name.
- `tests/e2e/frontend/checker.test.ts` > `"inherits members from a parent class via extends"`
  — the constructor-signature copy at `binder.ts:223-241`.
- `tests/bytecode/register/compiler/helpers.test.ts` > `"captures local from outer scope as upvalue when crossing function boundary"`
  and > `"does NOT capture as upvalue when no function boundary"`
  — the runtime half of the boundary rule, pinned on its own terms.
- `tests/e2e/docs/book-examples.test.ts` > `"labeled.tera resumes the outer loop instead of restarting the program"`
  — the program the semantic lowering erases still runs correctly at every tier.
- The boundary rule itself — that the checker and the bytecode compiler agree about which
  binding a bare `x =` writes — is **[unpinned]**. No test in `tests/` names `Scope.boundary`
  or `lookupWithinBoundary`, and none runs both halves against one program.
- The `LabeledStatement` gap is **[unpinned]**. No test asserts that a labeled statement's
  body reaches the semantic program, and none asserts a diagnostic inside one.
