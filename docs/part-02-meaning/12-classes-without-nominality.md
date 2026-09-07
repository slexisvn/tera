# 12. Classes without nominality   ⟨— · — · J · N⟩

> **Status:** outline

**Thesis.** A user class is an anonymous shape, so assignability is structural, and the
nominal lineage exists only for the two things that need it — protected access and least
upper bound.

**What arrived.** From ch 11: a type for every expression, including the right-hand side
of `this.x = ...`. From ch 8: one boundary `Scope` per member with `this` already bound
and `classOwner` set.

**What leaves.** An `ObjectShape` in `env.interfaces` under the class's own name (and a
second one under `typeof C` for statics), and — when `aot` is on — a `ClassSurface[]`
that ch 57 turns into an eight-byte header and a field offset per member.

**New ideas.** Structural vs. nominal typing; a shape; why a compiler that assigns types
structurally cannot build a dispatch cone from names.

**Length.** 12 pages

## Anchors

- `src/frontend/checker/type-checker.ts` — `registerClassShape` (parent fields copied,
  declared fields, then constructor-first member walk, then `fillOpenElements`, then
  methods and getters), `collectThisFields`, `recordThisAssignment`, `widenedField`,
  `refineOpenElements`, `pushedElementsOf`, `collectThisPushes`, `recordThisPush`,
  `fillOpenElements`, `fillOpenField`, `memberReturnType`, `classMethodType`,
  `checkAbstractMembers`, `checkImplements`, `requireMemberVisibility`,
  `checkClassField`, `checkClassMemberVisibility`, `classAccessAllowed`,
  `classConstructorAccessAllowed`, `classLineage`, `ownerFromType`, `currentClassOwner`,
  `isClassConstructorSignature`, `emitMembers`, and the constants `PUSH_MEMBER`,
  `NULL_TYPE`.
- `src/frontend/checker/type-system.ts` — `Binding` (`open`, `widens`, `visibility`,
  `owner`, `abstract`, `member`), `OPEN_FIELD_TYPE`, `assignableType`, `ObjectShape`,
  `instantiateShapeForType`, `shapeType`, `objectAssignable`, `nominalFamily`,
  `nominalLineage`, `commonNominalAncestor`, `abstractClasses`.
- `src/core/class-visibility.ts` — 24 lines: `CLASS_VISIBILITIES`, `ClassVisibility`,
  `DEFAULT_CLASS_VISIBILITY`, `CLASS_MEMBER_MODIFIERS`, `isClassVisibility`,
  `classVisibilityOrDefault`.
- `src/core/class-member.ts` — 45 lines: `CLASS_MEMBER_KINDS`,
  `CLASS_SHAPE_MEMBER_KINDS`, `ClassShapeMemberKind`, `CLASS_DATA_MEMBER`,
  `CLASS_CALLABLE_KINDS`, `CLASS_PROTOTYPE_PROPERTY`, `superClassBinding`,
  `superClassBindingOwner`, `classMemberKindOfAccessor`.
- `src/frontend/modules/interface.ts` — `ClassMemberSurface`, `ClassSurface`,
  `shapeMembers`, `setterMembers`, `classSurfaceOf`, `interfaceSurfaceOf`,
  `classSurfacesOf`.

## Worked example

`docs/example/stats.tera:1-4`. `class Series` declares no fields at all; its whole shape
comes from two constructor assignments:

```
this.name = name      →  name:   string
this.values = values  →  values: float[]
```

Nothing in the source says `values: float[]` as a field. Ask the checker and it answers
in that spelling:

```bash
node dist/cli.js check -e '<stats.tera> + n: int = latency.values'
```
→ `Type 'float[]' is not assignable to 'int'`

`docs/example/stats-poly.tera` adds `class Constant` with the same two methods and
`fn report(s) -> string` with an *undeclared* parameter — call sites go polymorphic, and
`s.label()` resolves on both without either class naming an interface.

## Outline

- [ ] **New idea: a shape.** Primer — a nominal type is a name you must claim; a
      structural type is a set of members you happen to have. Establish which one tera
      chose and where you can see it: `registerClassShape` writes into
      `bound.env.interfaces`, the *same* map that user `interface` declarations and
      built-in interfaces write into. A class and an interface are the same kind of thing
      here.
- [ ] **Building a class out of nothing.** Establish `registerClassShape` in order:
      parent's fields copied first (and the parent's `typeof` shape into the static
      shape), then explicitly declared fields, then `this.x = ...` harvesting, then
      `fillOpenElements`, then methods and getters as `(a: T) -> R` strings via
      `classMethodType`. Name why the order is this and not another.
- [ ] **Constructor first, on purpose.** Establish the sort in `registerClassShape`:
      `constructorFirst` puts the constructor at index 0 so the first type a field gets is
      the one the constructor assigned, and every later method assignment can only widen
      it. Then `recordThisAssignment`'s two guards — a field already in the shape from a
      *declaration* is never overwritten (`existing !== undefined && !inferred.has(field)`),
      and an `isUnknownish` assignment never disturbs a field that already has a type.
- [ ] **Disagreement widens by LUB.** Establish `widenedField`:
      `leastUpperBound([carried, assigned], env) ?? unionType([carried, assigned])` — the
      join from ch 10, with the bare-union fallback that lives at the call site.
- [ ] **`this.xs.push(v)` is how an empty array gets an element type.** Establish
      `recordThisPush` (receiver must be `this.<field>`, member must be `push`, first
      argument's inferred type recorded), `pushedElementsOf` collecting across every
      non-static member, and `fillOpenElements` filling only where the field is *inferred*
      and its element type is still unknownish. Establish `refineOpenElements` as the
      second pass, run after all members are checked, so a push in a method body still
      counts.
- [ ] **Statics are a parallel shape.** Establish `typeof C` as a second `ObjectShape`
      registered alongside `C`, `binder.ts` binding the class name locally as
      `typeof C`, and `scope.signatures.set(\`${node.name}.${member.fn.name}\`, …)` for
      static members. The consequence: a static member is not on an instance and an
      instance member is not on the class object, without either being a special case.
- [ ] **The open field.** Establish `this.next = null` producing
      `{ type: "null", open: true }`, and `assignableType(binding)` answering
      `OPEN_FIELD_TYPE` — the literal string `"any"` — whenever `open` is set. Establish
      `fillOpenField`: the first non-null store rewrites the type to `T | null` while
      *keeping* `open: true`.
- [ ] **What the open field deliberately does not do.** Establish honestly that `open`
      is never cleared, and that `memberType` (`infer.ts:637`) reads through
      `assignableType`, so *reads* answer `any` too. `head.next.value` is legal not
      because the checker proved `next` non-null but because it declines to have an
      opinion. Contrast with `keeps a declared nullable field as declared`, where an
      explicit `int | null` is enforced in both directions.
- [ ] **Visibility is required, not defaulted.** Establish `requireMemberVisibility` and
      `checkClassField`'s `explicitVisibility` check: every method, constructor, getter,
      setter and declared field must spell `public`/`private`/`protected`, which is why
      every class in `docs/example/` reads `public constructor(...)`. Establish the one
      exemption: a field introduced only by constructor assignment needs none, because
      there is nothing to annotate.
- [ ] **The two things lineage is for.** Establish `env.nominalFamilies` as the only
      nominal structure, written by `bindNode`'s `extends` handling, and its two readers:
      `classAccessAllowed` (protected access walks `classLineage` and compares indices, so
      a subclass may reach a parent's protected member and not the reverse) and
      `commonNominalAncestor` inside `leastUpperBound` (so an array of `Cel` and `Fah`
      answers `Temp` rather than a union). Everything else about a class is structural.
- [ ] **Abstract and implements.** Establish `checkAbstractMembers` (private abstract
      refused, abstract constructors refused, static abstract refused; a concrete class
      carrying an abstract binding is refused, with two different messages for "declares"
      versus "inherits") and `checkImplements` (each named interface's required fields
      must exist, be public, and be assignable). Note that `implements` is a *check*, not
      a subtyping declaration — assignability was already structural without it.
- [ ] **What leaves, and where it lands.** Establish `classSurfacesOf`: `shapeMembers`
      flattens the instance shape and the `typeof` shape into `ClassMemberSurface`s
      carrying `declaredType` as text, `setterMembers` adds setters (which are not in the
      shape), and `constructorParams` are inherited whole from the parent when the class
      declares no constructor of its own. Hand it to ch 57.
- [ ] **Why this matters four hundred pages later.** Establish the forward reference: the
      AOT backend builds *structural* dispatch cones because tera assigns types
      structurally, and a nominal cone silently miscompiled `examples/design-pattern/20_state.tera`.
      Two classes with the same members are one cone here, and that is a consequence of
      this chapter's decision, not of the backend's.

## Honesty items

> **Unfinished.** `Binding.open` is set in `recordThisAssignment` and never cleared —
> `fillOpenField` refines the type to `T | null` but spreads `...binding`, keeping
> `open: true`. `assignableType` therefore keeps answering `OPEN_FIELD_TYPE` (`"any"`) for
> both reads and writes for the life of the program: after `a.next = Item()`, both
> `a.next = 5` and `n: int = a.next` pass. Cost of finishing: deciding when a field stops
> being open — which needs a definite-assignment analysis the single-pass checker does not
> have (ch 16).

> **Unfinished.** `recordThisAssignment` and `collectThisPushes` walk only `Expr`, `Block`
> and `For` statements. A `this.x = ...` inside a nested function, a lambda, or a labeled
> statement (ch 8) never reaches the shape.

> **Unfinished.** `recordThisPush` matches the member name `push` literally
> (`PUSH_MEMBER`), so `unshift`, `concat` and an indexed store never contribute an element
> type to an inferred array field — even though `ADDS_ONE_ELEMENT` in
> `src/core/indexing.ts` already names both `push` and `unshift` for ch 13's purposes.

> **Unenforced.** `classSurfaceOf` reads `bound.root.signatures.get(node.name)` for the
> constructor signature — the *root* scope, not the enclosing one. A class declared inside
> a function has no root signature and its `constructorParams` come back empty; nothing
> reports it.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats-poly.tera
node dist/cli.js check -e 'class Box:
  public constructor(v: float[]):
    this.items = v
b = Box([1.0])
n: int = b.items
print(n)'
node dist/cli.js check -e 'class A:
  public constructor():
    this.n = 1
class B:
  public constructor():
    this.n = 2
a: A = B()
print(a)'
node dist/cli.js check -e 'class Item:
  public constructor():
    this.next = null
a = Item()
a.next = Item()
a.next = 5
print(a.next)'
npx vitest run --project unit tests/frontend/checker/type-checker.test.ts -t "a field that starts out null"
npx vitest run --project e2e tests/e2e/frontend/checker.test.ts -t "user-defined classes"
```

The second reports `Type 'float[]' is not assignable to 'int'` for a field nobody
declared. The third is silent: `A` and `B` share no name and no parent, and that is
enough. The fourth is silent too — the open field's honest limit.

## Tests that pin this

- `tests/e2e/frontend/checker.test.ts` > "models a constructor call and instance fields"
- `tests/e2e/frontend/checker.test.ts` > "types this, methods returning this, and getters"
- `tests/e2e/frontend/checker.test.ts` > "checks a field member accessed through this against a return type"
- `tests/e2e/frontend/checker.test.ts` > "inherits members from a parent class via extends"
- `tests/e2e/frontend/checker.test.ts` > "uses nominal least-upper-bound for arrays of subclass instances"
- `tests/e2e/frontend/checker.test.ts` > "enforces private and protected instance visibility"
- `tests/e2e/frontend/checker.test.ts` > "requires a visibility modifier on class field declarations"
- `tests/e2e/frontend/checker.test.ts` > "does not require visibility for fields introduced only by constructor assignment"
- `tests/e2e/frontend/checker.test.ts` > "requires a visibility modifier on class methods, constructors, and accessors"
- `tests/e2e/frontend/checker.test.ts` > "enforces private constructors while allowing static factories"
- `tests/e2e/frontend/checker.test.ts` > "enforces static member visibility"
- `tests/e2e/frontend/checker.test.ts` > "exposes static members on the class type and keeps them off instances"
- `tests/e2e/frontend/checker.test.ts` > "inherits static members from a superclass"
- `tests/e2e/frontend/checker.test.ts` > "accepts a class that satisfies the interface"
- `tests/e2e/frontend/checker.test.ts` > "reports a missing interface member"
- `tests/e2e/frontend/checker.test.ts` > "requires implemented members to be public"
- `tests/e2e/frontend/checker.test.ts` > "treats an implemented class as assignable to the interface"
- `tests/e2e/frontend/checker.test.ts` > "rejects instantiating an abstract class"
- `tests/e2e/frontend/checker.test.ts` > "requires concrete subclasses to implement inherited abstract members"
- `tests/e2e/frontend/checker.test.ts` > "rejects private abstract members"
- `tests/frontend/checker/type-checker.test.ts` > "takes what a later assignment gives it"
- `tests/frontend/checker/type-checker.test.ts` > "reads through a field another object assigns"
- `tests/frontend/checker/type-checker.test.ts` > "keeps a declared field type as declared"
- `tests/frontend/checker/type-checker.test.ts` > "stays open for what the rest of the program puts in it"
- `tests/frontend/checker/type-checker.test.ts` > "keeps a declared nullable field as declared"
- `tests/frontend/checker/type-checker.test.ts` > "takes its element type from what the class pushes"
- `tests/frontend/checker/type-checker.test.ts` > "joins what several pushes give it"
- `tests/frontend/checker/type-checker.test.ts` > "leaves a declared element type alone"
- `tests/frontend/checker/type-checker.test.ts` > "takes the class a method pushes into the field"
- `tests/frontend/checker/type-checker.test.ts` > "fills a null field in from what the program stores there"
- `tests/frontend/checker/type-checker.test.ts` > "carries a field the constructor wrote as a subscript"
- Two structurally identical classes being mutually assignable: **[unpinned]**
