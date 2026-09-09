# 12. Classes without nominality   ⟨— · — · J · N⟩

`class Series` declares no fields. Read the first four lines of `docs/example/stats.tera`
and there is a name, a constructor, and two parameters — nothing that says a `Series` has a
`values` field, and certainly nothing that says the field holds `float[]`. Yet the checker
knows both, and will tell you so if you ask it. That knowledge has to be manufactured, and
the way it is manufactured decides something much larger than where the checker looks up a
field: it decides that in tera a class is a **shape**, not a **name**.

The consequence runs the length of the book. Two classes with the same members are the same
type here, whether or not either of them has heard of the other. There is no `implements`
you must write to make an argument fit; `implements` exists, but it is a check, not a
subtyping declaration. Nominal lineage — the parent chain written with `extends` — survives
in exactly two places, and both are places where structure genuinely cannot answer the
question. Everything else about a class is derived from what it happens to have.

This chapter builds a class shape out of nothing, in the order the code builds it, and then
follows the shape out of the front end. When the ahead-of-time compiler decides which
implementations a `s.label()` call could reach, it compares field offsets and method
arities, not class names, and it does that because of the decision made here. A dispatch
cone built from names would be a different language.

One limit up front, in the spirit of `docs/CONVENTIONS.md` rule 2. The variation this
chapter leans on, `docs/example/stats-poly.tera`, deliberately writes `fn report(s) -> string`
with an undeclared parameter, so that the call sites go polymorphic. That is exactly the
shape the ahead-of-time compiler will not take:

```
$ node dist/cli.js compile docs/example/stats-poly.tera -o stats-poly.exe
tera compile: compiling ahead of time needs every parameter to have a declared type
  report: parameter 's' has no declared type; declare it (for example 's: int'), or keep this part interpreted
```

So `stats-poly.tera` demonstrates structural typing in the checker and polymorphism in the
interpreter and JIT, and it demonstrates the native compiler's refusal — but it does not
reach the native class table. The structural dispatch cone at the end of this chapter is
shown from the source of the pass that builds it, and it is `[Ch 57 § laying-a-class-out]`'s
subject to walk in full.

**What arrived.** From [Ch 11 § the-write-back]: a type for every expression, produced by
`inferExpression`, including the right-hand side of every `this.x = ...` — which is the
only thing that will make `values` a `float[]`. From [Ch 8 § one-scope-per-declaration-and-who-owns-this]: one
boundary `Scope` per class member, created by `bindNode`'s `Class` case, with `this`
already bound to the class name (or to `typeof C` for a static member) and `classOwner` set
to the class it belongs to. From [Ch 10 § the-join-and-the-two-fallbacks]: `compatible` and
`leastUpperBound`, both of which this chapter calls without re-deriving.

## New idea: a shape

> **New idea. Nominal and structural typing.** A **nominal** type system decides "does this
> value fit here?" by comparing *names*. A `Circle` is a `Shape` because someone wrote
> `class Circle extends Shape` or `implements Shape`; two classes with identical members but
> no declared relationship are unrelated types, and that is the point — the name is a claim
> you make on purpose. A **structural** type system decides the same question by comparing
> *members*: a value fits where a `Shape` was expected if it carries everything a `Shape`
> carries, whether or not anyone declared a relationship. Java and C# are nominal; TypeScript
> and Go's interfaces are structural. The difference is not a matter of taste — it changes
> what a compiler can conclude from a name alone, and therefore what it can compile a call
> into.

tera is structural, and you can see it in one map. Everything the checker knows about the
members of a type lives in `env.interfaces`, a `Map<string, ObjectShape>`. Four different
declarations write into it, and it does not record which was which:

- the language's built-in interfaces, loaded by `createTypeEnv` from
  `data/tera-language-spec.ts` (`src/frontend/checker/type-system.ts:320-330`);
- a user `interface` declaration;
- a `model` declaration, via `registerModelShape` (`type-checker.ts:206-220`);
- a `class` declaration, via `registerClassShape` (`type-checker.ts:222-271`).

An `ObjectShape` is three fields, and only one of them is usually present:

```ts
export type ObjectShape = {
  typeParams?: string[];
  fields: Map<string, Binding>;
  indexers?: IndexSignature[];
};
```
— `src/frontend/checker/type-system.ts:45-49`

There is no `name` on it, no parent pointer, no marker saying "this came from a class".
`objectAssignable` (`type-system.ts:1015-1040`), the last resort of the assignability
walk from [Ch 10 § and-then-structure-decides], takes two of these and compares fields.
It never asks where either shape came from.

That is a design position, and the shortest way to see it is to write two classes that
share nothing but their members:

```
$ node dist/cli.js check -e 'class A:
  public constructor():
    this.n = 1
class B:
  public constructor():
    this.n = 2
a: A = B()
print(a)'
$ echo $?
0
```

`A` and `B` share no name, no parent, and no interface. A `B` is an `A` because it has an
`n: int`, and that is the whole reason. This is `[unpinned]` — no test in the tree asserts
that two structurally identical user classes are mutually assignable, which is a gap worth
knowing about, because it is the load-bearing property of the entire chapter.

Assignability is one-directional where the members differ. Add a field to `B` and the
`B`-into-`A` direction still holds, because a `B` has everything an `A` needs; the
`A`-into-`B` direction does not:

```
$ node dist/cli.js check -e 'class A:
  public constructor():
    this.n = 1
class B:
  public constructor():
    this.n = 2
    this.extra = "x"
a: A = B()
b: B = A()
print(a)'
[eval]:9:8: error: Type 'A' is not assignable to 'B'
```

Nine lines in, and only the second assignment is refused. Width subtyping, with nobody
having declared anything.

## Building a class out of nothing

`registerClassShape` is called from `checkNode`'s `Class` case (`type-checker.ts:157`),
before any member body is checked. It builds two shapes — the instance shape under the
class's own name, and a static shape under `typeof C` — in a fixed order, and the order is
the design.

```ts
  registerClassShape(node: Extract<SemanticNode, { kind: "Class" }>, classScope: Scope): void {
    if (node.abstract) this.bound.env.abstractClasses.add(node.name);
    const shape: ObjectShape = { fields: new Map() };
    const staticShape: ObjectShape = { fields: new Map() };
    const staticType = `typeof ${node.name}`;
    if (node.parent) {
      const parentShape = instantiateShapeForType(node.parent, this.bound.env);
      if (parentShape) for (const [name, binding] of parentShape.fields) shape.fields.set(name, binding);
      const parentStatic = this.bound.env.interfaces.get(`typeof ${node.parent}`);
      if (parentStatic) for (const [name, binding] of parentStatic.fields) staticShape.fields.set(name, binding);
    }
    this.bound.env.interfaces.set(node.name, shape);
    this.bound.env.interfaces.set(staticType, staticShape);
    for (const field of node.fields) {
      const fieldScope = this.bound.scopes.get(node) ?? classScope;
      const type = field.declaredType ? cleanType(field.declaredType) : field.value ? inferExpression(field.value, this.bound, fieldScope) : "undefined";
      const binding = { type, optional: false, visibility: field.visibility, owner: node.name, abstract: false, member: CLASS_DATA_MEMBER };
```
— `src/frontend/checker/type-checker.ts:222-238`

Five stages follow one another, each depending on the last:

1. **The parent's members are copied, by value, into both shapes.** Not linked — copied.
   `shape.fields.set(name, binding)` puts the parent's `Binding` object into the child's
   map, `owner` and all. After this line there is no runtime relationship between the two
   shapes; a later edit to the parent's shape does not reach the child. Inheritance in the
   checker is a snapshot taken at declaration time, which is why declaration order matters
   and why a class must be declared after the class it extends.
   `[t: tests/e2e/frontend/checker.test.ts > "inherits members from a parent class via extends"]`
   pins the instance side and
   `[t: tests/e2e/frontend/checker.test.ts > "inherits static members from a superclass"]`
   the static side.

2. **Both shapes are registered before anything else happens** (`:233-234`). This is what
   lets a class refer to itself: `public static make() -> Reg: return Reg()` needs `Reg` to
   resolve while `Reg`'s own members are still being built. An empty shape under the right
   name is enough.

3. **Explicitly declared fields are written** (`:235-240`), taking their type from
   `declaredType` if there is one, otherwise from the initializer, otherwise `"undefined"`.
   A declared field carries `visibility`, `owner`, `abstract` and
   `member: CLASS_DATA_MEMBER`. Statics go into `staticShape`, instances into `shape`, and
   that one ternary is the entire separation.

4. **`this.x = ...` assignments are harvested** from the member bodies, in a member order
   the next section is about.

5. **Methods and getters are typed last** (`:252-266`), because a method's inferred return
   type may depend on a field the harvest just discovered. `Series.mean()` returns `float`
   because `this.values` is `float[]` because the constructor assigned it — a chain that
   only resolves in this order.

The order is not arbitrary and it is not reversible. Declared fields must precede harvested
ones because `recordThisAssignment` refuses to overwrite a declared field. Harvesting must
precede method typing because `memberReturnType` (`:368-376`) infers an undeclared return
by walking the body, which reads fields. And the parent copy must precede everything,
because a subclass's constructor assigning `this.name` must widen the parent's `name`
rather than shadow it.

The last four lines of the function are the outputs: `emitMembers` twice, feeding the
symbol table the editor and REPL read ([Ch 74 § one-spec-four-surfaces]), then
`checkAbstractMembers` and `checkImplements`, the two checks that need the finished shape.

## Constructor first, on purpose

Members are not walked in source order. They are sorted:

```ts
    const constructorFirst = (member: ClassMemberNode): number => (member.memberKind === "constructor" ? 0 : 1);
    const ordered = [...node.members].sort((left, right) => constructorFirst(left) - constructorFirst(right));
    for (const member of ordered) {
      if (member.static) continue;
      if (member.abstract) continue;
      const memberScope = this.bound.scopes.get(member.fn) ?? classScope;
      this.collectThisFields(member.fn.body, memberScope, shape, node.name, inferredFields);
    }
```
— `src/frontend/checker/type-checker.ts:243-250`

`Array.prototype.sort` is stable in every engine this runs on, so the effect is precisely
"move the constructor to index 0, leave everything else alone". The reason is that the
first type a field receives becomes its baseline, and every later assignment can only
*widen* it. Whichever member is walked first decides what a field starts as. Choosing the
constructor makes that choice predictable: a field gets the type the constructor gave it,
and a method that assigns something else broadens the answer rather than replacing it.

For `Series`, the walk of the constructor body is the whole story. Two statements, two
fields:

```
this.name = name      →  name:   string
this.values = values  →  values: float[]
```

Nothing in `docs/example/stats.tera` writes `values: float[]`. Append one line to the file
and the checker answers in that exact spelling:

```
$ cp docs/example/stats.tera probe.tera
$ echo 'n: int = latency.values' >> probe.tera
$ node dist/cli.js check probe.tera
...\probe.tera:25:10: error: Type 'float[]' is not assignable to 'int'
```

Line 25 is the line that was appended to the twenty-four
`[t: tests/e2e/docs/book-examples.test.ts > "stats.tera is the twenty-four lines the book claims"]`.
The type came from a constructor parameter's declared type, through an assignment, into a
field nobody declared.

The harvest itself is `collectThisFields` and `recordThisAssignment`. The second is where
the two guards live:

```ts
    if (expr.type !== NodeType.AssignmentExpression) return;
    const target = expr.target as ASTNode | undefined;
    if (!target || target.type !== NodeType.MemberExpression) return;
    if ((target.object as ASTNode)?.type !== NodeType.ThisExpression) return;
    const field = memberName(target);
    if (!field) return;
    const existing = shape.fields.get(field);
    if (existing !== undefined && !inferred.has(field)) return;
    const assigned = inferExpression(expr.value as ASTNode, this.bound, scope);
    if (existing !== undefined && this.isUnknownish(assigned)) return;
    const type = existing === undefined ? assigned : this.widenedField(existing.type, assigned);
    inferred.add(field);
    const open = type === NULL_TYPE ? { open: true } : {};
    shape.fields.set(field, { type, ...open, optional: false, member: CLASS_DATA_MEMBER, owner });
```
— `src/frontend/checker/type-checker.ts:400-413`

`inferred` is a per-class set of the field names this harvest created. The guard at line
407 reads: *if the field is already in the shape and this harvest did not put it there,
leave it alone.* A field that came from a `declared` line, or from the parent, is never
overwritten by a constructor assignment
`[t: tests/frontend/checker/type-checker.test.ts > "keeps a declared field type as declared"]`.
The guard at line 409 reads: *an unknownish assignment never disturbs a field that already
has a type* — so a method that stores an untypeable expression into a field cannot erase
what the constructor established. Both guards are one-way: they protect what is already
known, and they let the first writer win.

## Disagreement widens by LUB

When two assignments to the same field disagree, the field takes their join:

```ts
  widenedField(carried: TypeName, assigned: TypeName): TypeName {
    if (carried === assigned) return carried;
    return leastUpperBound([carried, assigned], this.bound.env) ?? unionType([carried, assigned]);
  }
```
— `src/frontend/checker/type-checker.ts:477-480`

`leastUpperBound` is [Ch 10 § the-join-and-the-two-fallbacks]'s function: fold left, keep
whichever side the other is assignable to, and fall back to `commonNominalAncestor` when
neither is. It returns `null` when there is no join at all — two unrelated shapes — and
that `?? unionType(...)` is the fallback that lives here rather than inside the join. A
field written as an `int` in the constructor and a `string` in a method becomes
`int | string`, which is honest and usually useless, and that is the point: the checker
records the disagreement rather than picking a winner
`[t: tests/frontend/checker/type-checker.test.ts > "takes what a later assignment gives it"]`.

Two of these fold together into one rule that reads well in the class the harvest is for.
A subclass constructor assigning `this.name = "circle"` to a field the parent typed
`string` gets `string` back, because `string` and `string` are equal at line 478. A
subclass assigning a `Circle` to a field the parent typed `Shape` gets `Shape`, because
`Circle` is assignable to `Shape`. Only a genuine conflict produces a union.

## `this.xs.push(v)` is how an empty array gets an element type

`this.items = []` gives a field the type of an empty array literal, which carries no
element type. Nothing in the constructor can supply one. So there is a second harvest,
looking for exactly one shape: a `push` whose receiver is a field of `this`.

`recordThisPush` (`type-checker.ts:444-458`) demands, in order, a `CallExpression`, a
non-computed member callee whose property is literally `push`, a receiver that is itself a
non-computed member expression, a receiver object that is `this`, and a first argument
whose inferred type is not unknownish. Everything that survives is appended to a
`Map<string, TypeName[]>` keyed by field name. `pushedElementsOf` (`:423-433`) runs that
collector over every non-static, non-abstract member.

Filling is separate, and conservative:

```ts
  fillOpenElements(
    shape: ObjectShape,
    inferred: ReadonlySet<string>,
    pushed: ReadonlyMap<string, TypeName[]>,
  ): void {
    for (const [field, types] of pushed) {
      if (!inferred.has(field)) continue;
      const binding = shape.fields.get(field);
      if (binding === undefined) continue;
      const element = arrayElementType(binding.type);
      if (element === null || !this.isUnknownish(element)) continue;
      const carried = leastUpperBound(types, this.bound.env) ?? unionType(types);
      if (this.isUnknownish(carried)) continue;
      shape.fields.set(field, { ...binding, type: `${carried}[]` });
    }
  }
```
— `src/frontend/checker/type-checker.ts:460-475`

Four refusals in eleven lines. The field must have been created by the harvest
(`inferred.has(field)`) — a *declared* `int[]` is never rewritten from a push
`[t: tests/frontend/checker/type-checker.test.ts > "leaves a declared element type alone"]`.
The field must currently be an array type. Its element type must still be unknownish — a
field that already knows what it holds is left alone. And the join of the pushed types must
itself be known. Only then does the field become `${carried}[]`
`[t: tests/frontend/checker/type-checker.test.ts > "takes its element type from what the class pushes"]`,
with several pushes joined by the same `leastUpperBound`
`[t: tests/frontend/checker/type-checker.test.ts > "joins what several pushes give it"]`.

`fillOpenElements` is called twice. Once inside `registerClassShape` (`:251`), over the
constructor-first ordering, and once again from `refineOpenElements` (`:416-421`), which
`checkNode` runs *after* every member body has been checked (`:163`). The second pass
exists because a method body's types are not settled until the method has been checked; a
push inside a method whose argument type depends on something the check established only
becomes usable then
`[t: tests/frontend/checker/type-checker.test.ts > "takes the class a method pushes into the field"]`.

> **Unfinished.** `recordThisPush` (`src/frontend/checker/type-checker.ts:448`) compares the
> member name against the constant `PUSH_MEMBER` (`:1398`), which is the string `"push"`.
> `unshift`, `concat`, a subscript store and every collection method in
> [Ch 60 § prelude-one-collections] also put an element into an array field, and none of
> them contributes an element type. This is odd next to `src/core/indexing.ts:62`, where
> `ADDS_ONE_ELEMENT` already names `push` *and* `unshift` for [Ch 13 § spending-and-refunding]'s
> purposes — the tree has the wider set, and this harvest does not use it. Finishing it
> costs replacing one string comparison with a set membership test for `unshift`, and a
> decision about what element type an indexed store or a `concat` contributes.

> **Unfinished.** `collectThisFields` (`:378-391`) and `collectThisPushes` (`:435-442`)
> recurse into `Block` and `For` statements and nothing else. A `this.x = ...` inside a
> nested function, inside a lambda, or inside a labeled statement ([Ch 8 § one-scope-per-declaration-and-who-owns-this])
> never reaches the shape, because the walk does not descend into a node that carries its own
> scope. Finishing it costs deciding whether an assignment inside a closure that may run
> later, never, or many times should be treated as establishing a field type at all — the
> same question [Ch 13 § three-ways-to-lose-a-count] answers *no* to for array lengths.

## Statics are a parallel shape

There is no static member table. There is a second `ObjectShape`, registered under the
literal type name `typeof C`, and the binder makes the class name itself resolve to that
type:

```ts
    if (node.abstract) bound.env.abstractClasses.add(node.name);
    if (node.parent) bound.env.nominalFamilies.set(node.name, node.parent);
    const staticType = `typeof ${node.name}`;
    scope.locals.set(node.name, { type: staticType, optional: false, declared: true });
    const classScope = createScope(scope, sig);
    classScope.classOwner = node.name;
    bound.scopes.set(node, classScope);
```
— `src/frontend/checker/binder.ts:243-249`

So the identifier `Series` has type `typeof Series`, and `Series()` is a call resolved
through the constructor `Signature` registered one line earlier at `:242`. A static method
gets a second registration, `scope.signatures.set(\`${node.name}.${member.fn.name}\`, memberSig)`
(`binder.ts:258`), which is what makes `Vec.create(1, 2)` a resolvable call with real
argument checking
`[t: tests/e2e/frontend/checker.test.ts > "argument-checks static method calls"]`.

Inside a member, `this` is bound to the class name for an instance member and to
`typeof C` for a static one (`binder.ts:263`), which is why a static method reading
`this.somethingInstanceOnly` finds nothing. Nothing here is a special case: `typeof C` is
an ordinary type with an ordinary shape, and the whole static/instance distinction is which
of two maps a member was written into.

The separation is visible in the symbol table rather than in a diagnostic.
`[t: tests/e2e/frontend/checker.test.ts > "exposes static members on the class type and keeps them off instances"]`
asserts that the emitted symbols contain `typeof Reg.make` and `Reg.v` and `Reg.read`, and
do *not* contain `Reg.make`. It asserts nothing about what happens if you read `make`
through an instance, because nothing happens:

> **Unenforced.** A static member is absent from the instance shape, and the checker does
> not report reading one through an instance. `memberType`
> (`src/frontend/checker/infer.ts:633-643`) answers `null` for a member the shape does not
> carry, `declaredMemberType` turns that into `"unknown"`, and an `unknown` is only reported
> where something demands a type. Measured on this tree, 2026-09-07: a program declaring
> `public static make() -> int` and then calling `c.make()` on an instance passes
> `tera check` with exit 0, and fails at run time with `undefined is not a function`,
> exit 1. Enforcing it costs a diagnostic on a member access that resolves to nothing on a
> class-derived shape, plus a decision about what to do for the many builtin shapes where
> an absent member is currently tolerated on purpose.

## The open field

`this.next = null` is the one assignment whose type is useless. `null` is a real type, and
a field typed `null` accepts nothing else — which would make the ordinary linked-list
constructor uninhabitable. `recordThisAssignment` recognises the case and flags it:

```ts
    const open = type === NULL_TYPE ? { open: true } : {};
```
— `src/frontend/checker/type-checker.ts:412`

`open` is a `Binding` field, and it short-circuits the accessor every read and every write
goes through:

```ts
export type Binding = {
  type: TypeName;
  optional: boolean;
  declared?: boolean;
  widens?: TypeName;
  open?: boolean;
  visibility?: ClassVisibility;
  owner?: string;
  abstract?: boolean;
  member?: ClassShapeMemberKind;
};

export const OPEN_FIELD_TYPE: TypeName = "any";

export function assignableType(binding: Binding): TypeName {
  if (binding.open === true) return OPEN_FIELD_TYPE;
  return binding.widens ?? binding.type;
}
```
— `src/frontend/checker/type-system.ts:26-43`

`assignableType` is the whole of it: an open field answers the literal string `"any"`, and
`"any"` is compatible with everything in both directions. The second line — `widens ?? type`
— belongs to a different mechanism, the narrowing undo button that
[Ch 13 § the-widens-field] is about; the two share this function and
otherwise have nothing to do with each other.

The first non-null store then refines the recorded type without clearing the flag:

```ts
  fillOpenField(target: ASTNode, actual: TypeName, scope: Scope): void {
    if (target.type !== NodeType.MemberExpression || target.computed) return;
    if (this.isUnknownish(actual) || actual === NULL_TYPE) return;
    const owner = inferExpression(target.object as ASTNode, this.bound, scope);
    const shape = this.bound.env.interfaces.get(owner);
    const field = propertyNameOf(target);
    const binding = shape?.fields.get(field);
    if (binding?.open !== true || binding.type !== NULL_TYPE) return;
    shape!.fields.set(field, { ...binding, type: unionType([actual, NULL_TYPE]) });
  }
```
— `src/frontend/checker/type-checker.ts:1004-1013`

Called from `checkAssignmentExpression` (`:996`) on every assignment in the program, not
only inside the class. So `head.next = Node(2)` written at the top level of the program is
what gives `Node.next` the type `Node | null`
`[t: tests/frontend/checker/type-checker.test.ts > "fills a null field in from what the program stores there"]`.
The guard `binding.type !== NULL_TYPE` makes it a one-shot: once the field has been
refined, a later store of a different type does not refine it again.

## What the open field deliberately does not do

Nothing clears `open`. Look at the final line of `fillOpenField`: it spreads `...binding`,
so `open: true` survives the refinement it just performed. `assignableType` therefore keeps
answering `"any"` for the life of the program, and the refined `Node | null` it wrote is
carried but never consulted through that path.

The consequence is that `head.next.value` is legal not because the checker proved `next`
is non-null, but because it declined to have an opinion:

```
$ node dist/cli.js check -e 'class Item:
  public constructor():
    this.next = null
fn f(a: Item) -> int:
  a.next = 5
  n: int = a.next
  return n
print(f(Item()))'
$ echo $?
0
```

Both directions pass. `a.next = 5` stores an `int` into a field the program has been
treating as an `Item | null`, and `n: int = a.next` reads an `int` out of it. Neither is
reported. This is the honest version of the test whose title is the design statement:
`[t: tests/frontend/checker/type-checker.test.ts > "stays open for what the rest of the program puts in it"]`.

Two details keep this from being worse than it is. The first is that an *explicitly
declared* nullable field is not open, and is enforced in both directions:
`public slot: int | null = null` refuses a `string` store with
`Type 'string' is not assignable to 'int | null'`
`[t: tests/frontend/checker/type-checker.test.ts > "keeps a declared nullable field as declared"]`.
The `open` flag is set only by the harvest, only for a field whose inferred type came out
`null`, and writing the type down is the way to opt out of it.

The second is that an assignment in the same scope narrows the *name*, not the field. The
last three lines of `checkAssignmentExpression` (`type-checker.ts:997-1001`) store the
assigned type under the dotted name in the local scope, so reading `a.next` immediately
after `a.next = Item()` answers `Item` and not `any`. That is a flow fact, not a field
type; step into another function and the field's `"any"` is all there is.

> **Unfinished.** `Binding.open` (`src/frontend/checker/type-system.ts:31`) is set in
> `recordThisAssignment` (`type-checker.ts:412`) and cleared nowhere in `src/`.
> `fillOpenField` (`:1012`) refines the type to `T | null` while spreading the binding, so
> the flag survives, and `assignableType` (`type-system.ts:40-43`) keeps answering
> `OPEN_FIELD_TYPE` for reads and writes alike. Finishing it means deciding *when* a field
> stops being open, which is a definite-assignment question — has every path to this read
> stored something? — and the checker is a single pass over a statement list with no
> control-flow graph ([Ch 16 § single-pass-and-why-source-order-is-semantics]). The cheaper half-fix is to clear `open` in
> `fillOpenField` and accept `T | null`, which would make `head.next.value` require a null
> guard and would change the diagnostics of any program in `examples/` that builds a linked
> structure.

## Visibility is required, not defaulted

Every method, constructor, getter, setter and declared field must spell its visibility.
There is no implicit `public`:

```ts
  requireMemberVisibility(member: ClassMemberNode): void {
    if (member.explicitVisibility) return;
    const label = member.memberKind === "constructor" ? "Constructor"
      : member.memberKind === "getter" ? "Getter"
      : member.memberKind === "setter" ? "Setter"
      : "Method";
    const subject = member.memberKind === "constructor" ? label : `${label} '${member.fn.name}'`;
    this.add(member.fn.nameSpan.line, member.fn.nameSpan.column, `${subject} must declare a visibility modifier ('public', 'private', or 'protected')`);
  }
```
— `src/frontend/checker/type-checker.ts:320-328`

`checkClassField` (`:330-337`) does the same for declared fields with a differently worded
sentence. Both read `explicitVisibility`, a parser flag, rather than the resolved
`visibility` — which is why `DEFAULT_CLASS_VISIBILITY` can be `"public"`
(`src/core/class-visibility.ts:5`) without weakening the requirement. The default is what a
member *means*; the flag is whether the programmer said so. That is why every class in
`docs/example/` reads `public constructor(...)` and `public mean() -> float`.

The one exemption is the field nobody declared. A field that exists only because the
constructor assigned to it has no declaration site, so there is nothing to annotate and
nothing is demanded
`[t: tests/e2e/frontend/checker.test.ts > "does not require visibility for fields introduced only by constructor assignment"]`.
`recordThisAssignment` writes such a binding with no `visibility` key at all
(`type-checker.ts:413`), and every reader supplies `DEFAULT_CLASS_VISIBILITY` when the key
is missing. So `Series.name` and `Series.values` are public, silently, and correctly.

`src/core/class-visibility.ts` is twenty-four lines and is the entire vocabulary: three
visibilities, a default, and three member modifiers —
`CLASS_MEMBER_MODIFIERS = [static, abstract, async]` at `:9-13`. Notably `public`,
`private` and `protected` are *not* keywords in the lexer's table, which is why
`public = 9` at the top level of a program is a parse error while `static = 9` runs and
prints `9` ([Ch 4 § forty-seven-words]).

## The two things lineage is for

`extends` writes exactly one thing that structure does not already provide:

```ts
    if (node.parent) bound.env.nominalFamilies.set(node.name, node.parent);
```
— `src/frontend/checker/binder.ts:244`

`env.nominalFamilies` is a `Map<string, string>` from a class name to its parent's name.
It is the only nominal structure in the checker, and it has exactly two readers.

**Protected access.** A `private` member is reachable only from its owner, which is a name
comparison and needs no lineage. `protected` needs to know whether the caller is at or
below the owner in the chain:

```ts
function classAccessAllowed(
  visibility: ClassVisibility,
  owner: string,
  caller: string | null,
  targetType: TypeName,
  env: TypeEnv,
): boolean {
  if (visibility === "public") return true;
  if (!caller) return false;
  if (visibility === "private") return caller === owner;
  const lineage = classLineage(ownerFromType(targetType), env);
  const ownerIndex = lineage.indexOf(owner);
  const callerIndex = lineage.indexOf(caller);
  return caller === owner || (ownerIndex >= 0 && callerIndex >= 0 && callerIndex <= ownerIndex);
}
```
— `src/frontend/checker/type-checker.ts:1491-1505`

`classLineage` (`:1523-1533`) walks `nominalFamilies` from the accessed type upward,
collecting names, with a `seen` set so a cycle terminates. The comparison is
`callerIndex <= ownerIndex`: the caller must be at least as *derived* as the owner. A
subclass reaching a parent's protected member passes; a parent reaching a subclass's does
not. A structural rule could not express this, because both classes have the member —
the question is who is allowed to say so
`[t: tests/e2e/frontend/checker.test.ts > "enforces private and protected instance visibility"]`.
`classConstructorAccessAllowed` (`:1511-1521`) is the same idea for a private constructor
with a public static factory
`[t: tests/e2e/frontend/checker.test.ts > "enforces private constructors while allowing static factories"]`.

**Least upper bound.** `commonNominalAncestor` (`type-system.ts:870-874`) is the last thing
`leastUpperBound` tries before giving up. Without it, `[Circle(2.0), Rectangle(3.0, 4.0)]`
would have to be `Circle | Rectangle`, because neither is assignable to the other. With it
the array is `Shape[]` and the loop variable is `Shape`, so `s.describe()` resolves
`[t: tests/e2e/frontend/checker.test.ts > "uses nominal least-upper-bound for arrays of subclass instances"]`.
Structure cannot answer this either. There is a structural common supertype of `Circle` and
`Rectangle` — the shape carrying `name`, `area` and `describe` — but nothing gives it a
name, and every type in this checker is a name ([Ch 9 § the-one-line-decision]).

That is the whole of it. Two readers, one map. Everything else about a class — what it is
assignable to, what members it carries, whether a call resolves, what a field's type is —
never consults the parent chain.

## Abstract and implements

`checkAbstractMembers` (`type-checker.ts:273-297`) does four things, and the wording of
each diagnostic is the specification. Three are refusals of an ill-formed declaration: an
abstract member may not be `private` (`Abstract member 'x' cannot be private`), a
constructor may not be abstract (`Constructors cannot be abstract`), and a static member
may not be abstract (`Static member 'x' cannot be abstract`)
`[t: tests/e2e/frontend/checker.test.ts > "rejects private abstract members"]`.

The fourth walks the finished shape looking for any binding still marked `abstract`, and
picks between two sentences depending on where it came from:

- `Class 'C' must be abstract because it declares abstract member 'm'` — the class declared
  it itself;
- `Class 'C' must implement abstract member 'm' inherited from 'P'` — it arrived in the
  parent copy.

The distinction is possible only because the parent's `Binding` was copied with its `owner`
intact. `[t: tests/e2e/frontend/checker.test.ts > "requires concrete subclasses to implement inherited abstract members"]`
pins the second, and `abstractClasses` — written in both `bindNode` (`binder.ts:243`) and
`registerClassShape` (`:223`) — is what makes `Shape()` itself a refusal
`[t: tests/e2e/frontend/checker.test.ts > "rejects instantiating an abstract class"]`.

`checkImplements` (`:299-318`) is the chapter's thesis in negative form. For each named
interface it fetches the contract shape, then for each non-optional field checks three
things: the class has a member of that name, that member is `public`, and its type is
`compatible` with the required one. Three sentences, one per failure.

What it does *not* do is record anything. There is no "implements" edge written into
`nominalFamilies`, no marker on the shape, nothing that a later assignability question
could consult. A class that implements an interface was already assignable to it, because
it has the members; a class that does not is still assignable if it happens to have them
anyway. `implements` buys you the diagnostic at the declaration site instead of at the use
site, and nothing else
`[t: tests/e2e/frontend/checker.test.ts > "treats an implemented class as assignable to the interface"]`.
The `public` requirement is the one thing it adds that structure would not have caught,
because `objectAssignable` compares types and never looks at `visibility`
`[t: tests/e2e/frontend/checker.test.ts > "requires implemented members to be public"]`.

## Why this matters four hundred pages later   ⟨N⟩

When the native compiler lowers `s.label()`, it has to answer a question the checker never
asks: *which function bodies could this call reach?* The set of candidate implementations
is called a **dispatch cone**, and building it is the difference between a direct call, a
small switch, and a refusal.

> **New idea. A dispatch cone.** A virtual call in a language with subtyping does not name
> the code it runs. A compiler that wants to turn it into something a machine can execute
> has to compute the set of bodies it could reach — the *cone* — from static information. A
> one-element cone becomes a direct call. A small cone becomes a test-and-branch over the
> receiver's class id. A cone the compiler cannot bound becomes an indirect call through a
> table, or, where there is no table to build, a refusal.

The obvious way to build a cone is from names: start at the declared type, walk down the
`extends` graph, collect every subclass. That is what a nominal language does, and it is
what the AOT backend cannot do here, because in this checker the declared type does not
determine the set of values that can arrive. `A` accepted a `B` in this chapter's second
listing, and `B` is not below `A` in any graph. A cone built from names would omit `B`'s
`label`, compile the site as a direct call to `A`'s, and be wrong.

So the cone is structural, and the comparison is `conformsTo`:

```ts
function conformsTo(candidate: ClassShape, required: ClassShape): boolean {
  for (const field of required.fields.values()) {
    const carried = candidate.fields.get(field.name);
    if (carried === undefined) return false;
    if (carried.offset !== field.offset || carried.scalar !== field.scalar) return false;
  }
  for (const kind of CLASS_CALLABLE_KINDS) {
    const members = required.callables.get(kind);
    if (members === undefined) continue;
    const carried = candidate.callables.get(kind);
    for (const [name, method] of members) {
      const found = carried?.get(name);
      if (found === undefined) return false;
      if (found.signature.params.length !== method.signature.params.length) return false;
    }
  }
  return true;
}
```
— `src/optimizing/metadata/class-table.ts:908-925`

No name comparison, no parent walk. A candidate conforms if it carries every required field
at the *same offset* with the *same scalar*, and every required callable under the same name
with the same arity. `dispatchConeOf` (`:669-677`) filters the class table with it, and
`implementationsOf` (`:679-694`) turns the cone into the list of bodies
`class-member-lowering.ts:439` will emit a dispatch over.

The offset and scalar equality is stricter than the checker's structural rule and it has to
be: two classes with the same member names but different layouts are the same type to the
checker and are not interchangeable to a machine that reads a field by adding a constant to
a pointer. [Ch 57 § laying-a-class-out] is where that layout is assigned, and where the
consequence — that the class table must be built so that conforming classes *get* matching
offsets — becomes the constraint it is.

The general rule, and the reason this section is not a forward reference but the chapter's
conclusion: **a backend's dispatch strategy is determined by the front end's notion of type
identity, not by the backend's cleverness.** The moment a language says "any value with
these members fits here", building a cone from a declaration graph is unsound, and no
amount of care in the lowering pass recovers it.

## What leaves, and where it lands

Two artifacts leave this chapter.

**An `ObjectShape` in `env.interfaces` under the class's own name, and a second one under
`typeof C`.** Its `fields` map carries, for each member, a `Binding` with the member's type
as canonical text, its `visibility`, the `owner` it was declared on, whether it is
`abstract`, its `member` kind (`field`, `method`, `getter`, `setter`), and — for a field
that started as `null` — the `open` flag that makes it answer `"any"` forever. Method types
are strings built by `classMethodType` (`type-checker.ts:1414`) in the form
`(a: T, b: U) -> R`, so a method is a field whose type happens to parse as a function.
Every downstream question about a class is answered from this map. [Ch 13] needs it
immediately: `this.items` has the type `string[]` because this chapter put it there, and
without that `arrayMethodSignature` cannot answer for `.shift()` at all.

**A `ClassSurface[]`, but only on the ahead-of-time road.** `classSurfacesOf`
(`src/frontend/modules/interface.ts:142-156`) flattens the two shapes into
`ClassMemberSurface` records — `name`, `declaredType` as text, `member` kind, `owner`,
`abstract`, `visibility`, `static` — via `shapeMembers` (`:57-78`), called once for the
instance shape and once for `typeof C`. `setterMembers` (`:80-95`) then appends the setters,
which are not in the shape at all, taking their type from the setter's first parameter.
`constructorParams` come from `bound.root.signatures.get(node.name)`, except where a class
declares no constructor of its own and has a parent, in which case the parent's are
inherited whole (`:103-104`). The single caller is one line:

```ts
      if (aot) this.aotClasses = buildClassTable(classSurfacesOf(checked.bound), checked.bound.env);
```
— `src/api/engine.ts:1201`

Four lines above the strict-mode throw that [Ch 16 § one-field-one-word] is about, and gated on the
same `aot` flag. On the interpreter, baseline and JIT roads this line does not run and no
surface is ever built. [Ch 57 § laying-a-class-out] takes the array and turns each surface
into an eight-byte header and a field offset per member.

> **Unfinished.** `classSurfacesOf` iterates `bound.program.body` — the top-level statement
> list — so a class declared inside a function never becomes a surface, and
> `classSurfaceOf` compounds it by reading the constructor signature from
> `bound.root.signatures` rather than the enclosing scope. Nothing reports the omission
> directly. Measured on this tree, 2026-09-07: a seven-line program declaring `class Inner`
> inside `fn make()` runs in the interpreter and prints `1`, passes `tera check` with exit 0,
> and fails to compile with a message naming a downstream symptom rather than the cause —
> `tera compile: warning: skipped 'Inner' (x64-windows backend cannot emit: unsupported
> opcode GenericSetProp)` alongside `call to Inner passes 0 of 1 arguments`. The identical
> class moved to the top level compiles, links and runs. Finishing it costs a recursive walk
> in `classSurfacesOf` and a decision about what a nested class's identity is when the
> enclosing function is compiled more than once.

[Ch 13] picks the shapes up and asks a question this chapter cannot answer:
not *what type does this field have*, but *how many elements are in it right now*.

## Verify it yourself

```bash
# structural dispatch in the interpreter: one report(), two classes, no interface
node dist/cli.js docs/example/stats-poly.tera

# the same file is refused ahead of time, for the undeclared parameter
node dist/cli.js compile docs/example/stats-poly.tera -o stats-poly.exe; echo "exit=$?"

# a field type nobody declared, in the checker's own spelling
cp docs/example/stats.tera probe.tera
echo 'n: int = latency.values' >> probe.tera
node dist/cli.js check probe.tera; echo "exit=$?"

# two classes sharing no name and no parent are mutually assignable
node dist/cli.js check -e 'class A:
  public constructor():
    this.n = 1
class B:
  public constructor():
    this.n = 2
a: A = B()
print(a)'; echo "exit=$?"

# the open field: both directions pass, forever
node dist/cli.js check -e 'class Item:
  public constructor():
    this.next = null
fn f(a: Item) -> int:
  a.next = 5
  n: int = a.next
  return n
print(f(Item()))'; echo "exit=$?"

# a static read through an instance: silent, then fatal
node dist/cli.js check -e 'class C:
  public static make() -> int:
    return 1
  public constructor():
    this.v = 1
c = C()
print(c.make())'; echo "exit=$?"
node dist/cli.js -e 'class C:
  public static make() -> int:
    return 1
  public constructor():
    this.v = 1
c = C()
print(c.make())'; echo "exit=$?"

# the field-shape unit tests
npx vitest run --project unit tests/frontend/checker/type-checker.test.ts -t "a field that starts out null"

# the class half of the checker end to end (15 tests)
npx vitest run --project e2e tests/e2e/frontend/checker.test.ts -t "user-defined classes"
```

The third reports `Type 'float[]' is not assignable to 'int'` at `25:10`, for a field nobody
declared, on the line appended past the file's twenty-four. The fourth is silent: `A` and
`B` share no name and no parent, and that is enough. The fifth is silent too — the open
field's honest limit. The sixth pair is the `> **Unenforced.**` item above: `tera check`
exits 0 and the interpreter then prints `undefined is not a function` and exits 1.

## Tests that pin this

- `tests/e2e/frontend/checker.test.ts` > `"models a constructor call and instance fields"`
  — the harvest itself: fields that exist only because the constructor assigned them.
- `tests/e2e/frontend/checker.test.ts` > `"types this, methods returning this, and getters"`
  — `this` bound to the class name, and getters typed by their return rather than as a
  function.
- `tests/e2e/frontend/checker.test.ts` > `"checks a field member accessed through this against a return type"`
  — a harvested field type is enforced, not merely recorded.
- `tests/e2e/frontend/checker.test.ts` > `"inherits members from a parent class via extends"`
  — the parent copy at `registerClassShape:227-232`.
- `tests/e2e/frontend/checker.test.ts` > `"uses nominal least-upper-bound for arrays of subclass instances"`
  — `commonNominalAncestor`, the second of lineage's two readers: `shapes` is `Shape[]`.
- `tests/e2e/frontend/checker.test.ts` > `"enforces private and protected instance visibility"`
  — `classAccessAllowed`, the first reader, with both diagnostics asserted verbatim.
- `tests/e2e/frontend/checker.test.ts` > `"requires a visibility modifier on class field declarations"`
  and > `"requires a visibility modifier on class methods, constructors, and accessors"`
  — `explicitVisibility` is checked, not the resolved `visibility`.
- `tests/e2e/frontend/checker.test.ts` > `"does not require visibility for fields introduced only by constructor assignment"`
  — the one exemption, and why `Series.name` needs no modifier.
- `tests/e2e/frontend/checker.test.ts` > `"enforces private constructors while allowing static factories"`
  — `classConstructorAccessAllowed`.
- `tests/e2e/frontend/checker.test.ts` > `"enforces static member visibility"`
  — visibility applies to the `typeof C` shape too.
- `tests/e2e/frontend/checker.test.ts` > `"exposes static members on the class type and keeps them off instances"`
  — the parallel-shape split, asserted through the emitted symbol table.
- `tests/e2e/frontend/checker.test.ts` > `"inherits static members from a superclass"`
  — the `typeof Parent` copy.
- `tests/e2e/frontend/checker.test.ts` > `"accepts a class that satisfies the interface"`,
  > `"reports a missing interface member"`, > `"requires implemented members to be public"`
  and > `"treats an implemented class as assignable to the interface"`
  — `checkImplements` as a check rather than a declaration.
- `tests/e2e/frontend/checker.test.ts` > `"rejects instantiating an abstract class"`,
  > `"requires concrete subclasses to implement inherited abstract members"` and
  > `"rejects private abstract members"`
  — `checkAbstractMembers`' four rules.
- `tests/frontend/checker/type-checker.test.ts` > `"takes what a later assignment gives it"`
  and > `"reads through a field another object assigns"`
  — `widenedField`, and the fact that the harvest sees assignments from outside the class.
- `tests/frontend/checker/type-checker.test.ts` > `"keeps a declared field type as declared"`
  — the first guard in `recordThisAssignment`.
- `tests/frontend/checker/type-checker.test.ts` > `"stays open for what the rest of the program puts in it"`
  and > `"keeps a declared nullable field as declared"`
  — the open field, and the declared type that opts out of it.
- `tests/frontend/checker/type-checker.test.ts` > `"takes its element type from what the class pushes"`,
  > `"joins what several pushes give it"`, > `"leaves a declared element type alone"` and
  > `"takes the class a method pushes into the field"`
  — `recordThisPush` / `fillOpenElements`, including the second pass.
- `tests/frontend/checker/type-checker.test.ts` > `"fills a null field in from what the program stores there"`
  — `fillOpenField` firing from an assignment outside the class body.
- `tests/frontend/checker/type-checker.test.ts` > `"carries a field the constructor wrote as a subscript"`
  — a field established through an indexed store rather than a dotted one.
- Two structurally identical classes being mutually assignable: **[unpinned]**. Nothing in
  `tests/` asserts it, although it is the property every other claim in this chapter rests
  on.
