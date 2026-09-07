# 57. Objects without a runtime type   ⟨ N ⟩

> **Status:** outline

**Thesis.** The dynamic transition tree has no counterpart in a native binary, so shape
becomes a static table computed from checker types — and it must be structural, because
tera assigns object types structurally.

**What arrived.** An `AotLegality` (or an `AotSkippedFunction`) from chapter 56 — and, with
it, a debt. `analyzeAotLegality` assigns a scalar to a field access by reading
`FIELD_SCALAR_PROP`, `ARRAY_ELEMENT_SCALAR_PROP` and `CLASS_ID_PROP` off the node
([Ch 56 § where-a-scalar-comes-from]), props chapter 56 named and did not explain. This
chapter is who stamps them, and what they are stamped from.

**What leaves.** A graph in which every object and array access is a `LoadField` /
`StoreField` at a **constant byte offset**, every member call is either a direct
`CallKnownFunction` or an explicit branch ladder over a `u32` read from offset 0, and a
`ClassTable` that later passes can still mint into through `defineSynthetic`. Chapter 58
uses exactly that door: its closure frames, coroutine frames and promises are new rows in
this same table.

**New ideas.** *Object header*; *field offset*; *alignment and padding*; *tag bits stolen
from an aligned size*; *virtual dispatch and devirtualization*; *structural vs nominal
subtyping*; *class hierarchy analysis (a dispatch cone)*; *branch ladder*; *select /
branchless choice*.

**Length.** 14 pages

## Anchors

- `src/optimizing/metadata/class-table.ts` — 1,034 lines, the object model in one file.
  Layout constants at lines 50-53 (`CLASS_SHAPE_ID_OFFSET = 0`, `CLASS_FLAGS_OFFSET = 4`,
  `CLASS_HEADER_BYTES = 8`, `CLASS_ALIGNMENT_BYTES = 8`); the six stamped prop names at
  55-60 (`CLASS_ID_PROP`, `FIELD_TYPE_PROP`, `FIELD_SCALAR_PROP`, `INSTANCE_SIZE_PROP`,
  `VALUE_CLASS_PROP`, `ARRAY_ELEMENT_SCALAR_PROP`); array offsets at 72-77.
  Types: `ClassShape`, `ClassField`, `ClassMethod`, `ClassStaticField`, `GlobalVariable`,
  `ArrayLayout`, `GeneratorShape`, `ClassTable`.
  Functions: `buildClassTable`, `Table.define` (782-855), `Table.defineSynthetic` (586-594),
  `Table.defineArray` (596-609), `Table.mint` (615-621), `Table.conformingShapes` (888-897),
  `conformsTo` (908-925), `Table.standInsFor` (872-886), `commonShapeOf`,
  `joinedLiteralShape`, `sameFieldLayout`, `referenceFieldOffsets` (1002-1008),
  `constructorFieldDisagreement` (1018-1034), `fieldScalarOf` (474-485),
  `Table.mintStructural` (637-648), `orderedByInheritance` (533-551).
- `src/optimizing/metadata/class-symbols.ts` — 97 lines, the naming scheme.
  `classMemberSymbol` builds `Owner.name`, `Owner.get.name`, `Owner.static.name`;
  `classStaticFieldSymbol`; `globalVariableSymbol` (owner `tera_global`);
  `memberSignature` (75-86), which is where `this` becomes parameter zero
  (`CLASS_RECEIVER_PARAM`).
- `src/optimizing/passes/class-member-lowering.ts` — 1,112 lines, the pass that spends
  the table. `lowerClassMembers` (1102), `lowerElementMembers` (1108),
  `applyFieldAccess` (349), `fieldLoadNode` (333), `applyConstruction` (540-566),
  `shapeIdOfReceiver` (568-578), `dispatchArmsFor` (580-594), `applyDispatchLadder`
  (596-652), `polymorphicShapeOf` (526-528), `memberCallTargets`,
  `keyedMembershipFor` (843-872), `keyedLookupFor` (958-991), `provenPresent` (911-928),
  `armsProving` (902-909), `negatedOperandOf` (885-891), `lookupFieldsOf` (768-773),
  `storesUnusedIteratorHook` (752-766).
- `src/optimizing/passes/array-shapes.ts` — 1,114 lines. `shapeArrayAllocations` (1043),
  `stampElementTypes` (1057), `arrayModelOf` (641), `arrayModelForDeclaredType` (656),
  `arrayElementNamingOf` (699), `mergedArray` (619) with its `merging` re-entrancy set
  (617), `allocate` (805), `pushElement` (968), `loadBuffer` (788), `storeCount`/`loadCount`
  (753/771), `elementAccess` (884), `emptyArray` (943), `ArrayModel`, `KnownElement`.
- `src/optimizing/target/runtime-layout.ts:201-206` — `TERA_CLASS_RECORD =
  declareRecord("tera_classes", [tailReferences, fieldStart, fieldCount, reserved])`, four
  `COUNT_BYTES` fields. Lines 253-258: `TERA_FREE_SHAPE_ID = 0`, `TERA_MARK_FLAG = 1`,
  `TERA_OLD_FLAG = 2`, `TERA_REMEMBERED_FLAG = 4`, `TERA_BLOCK_FLAGS = 7`.
  Line 218: `TERA_CLASS_FIELDS = declareTable("tera_class_fields", COUNT_BYTES)`.
- `src/optimizing/backends/c/emit.ts:1325-1355` — `cClassTable`, the second, independent
  emission of the same data: `typedef struct { uint32_t tail; uint32_t fields; const
  uint32_t *offsets; } tera_class;` plus a `tera_fields_<id>[]` per shape that has
  reference fields. Row 0 is hardcoded `{ 0, 0, 0 }` — the free-block shape id.
- `src/optimizing/types/scalar.ts:56-63` — `SCALAR_WIDTHS`; `scalarAlignment` (107-109),
  which is where `SCALAR_TEXT` (1024 bytes wide) is deliberately aligned to 8, not 1024.
- `src/optimizing/target/legalization.ts` — the pass order this chapter depends on:
  `element-types` (216), `object-literal-shapes` (233), `callee-signatures` (270),
  `array-allocation-shapes` (278), `class-member-lowering` (291), `heap-iteration` (307),
  `element-member-lowering` (313), `array-access-lowering` (356).
- `examples/design-pattern/20_state.tera` — 21 lines; the miscompile that made cones
  structural.
- `src/frontend/checker/type-system.ts` — `objectAssignable`, the checker rule the class
  table had to be made to agree with.

## Worked example

`examples/design-pattern/20_state.tera` — a `Document` whose `state` field is declared
`DraftState` (by the constructor's assignment) and legally holds a `PublishedState`,
because both classes carry `publish(document: Document) -> string`. The program is
twenty-one lines and the interpreter and the binary now agree:

```
$ node dist/cli.js examples/design-pattern/20_state.tera
state: published | already published
$ node dist/cli.js compile examples/design-pattern/20_state.tera -o /tmp/state.exe
tera compile: wrote /tmp/state.exe
$ /tmp/state.exe
state: published | already published
```

Before the fix it compiled just as cleanly and printed the wrong second answer: the call
`this.state.publish(this)` was devirtualized to `DraftState.publish`, because the cone was
built from `parent` links and `PublishedState` is not a subclass of anything.

`docs/example/stats.tera` supplies the layout half. Its `float[]` field, its `Series`
instances and its two array headers are all visible in one place:

```
$ node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
$ sed -n '113,133p' /tmp/stats-c/stats.c
```

which prints the `tera_class` typedef, four `tera_fields_<id>[]` arrays and a nine-row
`tera_classes[]`. `grep 'tera_alloc(' /tmp/stats-c/stats.c` shows the sizes those rows
describe: `24` (an array header), `8`, `40`, `48`, and `1032` (an object owning one inline
text field).

## Outline

- [ ] **§ what-a-transition-tree-cannot-become** — Establish the problem by naming what is
      being removed. Parts IV and V built a `Map`/hidden class per object *at run time*,
      grown by transition on each new property, and every inline cache in the interpreter
      and JIT compares against one. None of that survives: there is no allocator that can
      mint a map, no cache to hold it, no deopt if the guess is wrong.
      **`> **New idea.** Object header**: the fixed bytes every heap object carries before
      its first field, so that code holding only an address can still ask what it is.
      State the replacement in one sentence: **every shape a program will ever have is
      known before the program starts, so the shapes become a constant array and the
      per-object cost is one `u32` index into it.**
      Forward-reference [Ch 61 § marking] — the collector is the other reader of
      that array, and the reason it exists at all.
- [ ] **§ eight-bytes-and-three-spare-bits** — The header, as a fixed-width ASCII table.
      Offsets 0-3 are the shape id (`CLASS_SHAPE_ID_OFFSET`); offsets 4-7
      (`CLASS_FLAGS_OFFSET`) hold **the block's own size**, and its three low bits are the
      collector's flags. Establish why that overlap is sound rather than clever:
      `CLASS_ALIGNMENT_BYTES = 8`, every `size` in the table has been through
      `alignUp(cursor, 8)`, so bits 0-2 of a size are always zero and
      `TERA_BLOCK_FLAGS = TERA_MARK_FLAG | TERA_OLD_FLAG | TERA_REMEMBERED_FLAG = 7`
      fits exactly. **`> **New idea.** Tag bits stolen from an aligned value.**
      Show the two writes that establish it, from the emitted C:

      ```c
      *(uint32_t *)object = (uint32_t)shape_id;
      *(uint32_t *)(object + 4) = (uint32_t)size;
      ```

      — the tail of `tera_alloc` in `/tmp/stats-c/stats.c`

      Then the invariant → enforcement → test chain. **Invariant:** any code that produces
      a block must write both words. **Enforcement:** none — `tera_alloc` does it, and so
      must the x64 inline bump-allocation fast path, separately. See § honesty-items.
      Name `TERA_FREE_SHAPE_ID = 0` and `FREE_BLOCK_BYTES` here: shape 0 is the free block,
      which is why `cClassTable` hardcodes row zero.
- [ ] **§ laying-a-class-out** — `Table.define` (782-855) read as the whole algorithm, in
      order: start `cursor` at the **parent's `size`**, not at `CLASS_HEADER_BYTES`; for
      each declared data member ask `fieldScalarOf` for a scalar; `alignUp(cursor,
      scalarAlignment(scalar))`; record the offset; advance. Round the class size up to 8
      at the end. **`> **New idea.** Alignment and padding** — why a `float` after an `int`
      does not start at offset 12.
      Establish the two consequences that everything later depends on:
      (a) **a subclass's instance is a byte-exact prefix-compatible extension of its
      parent's**, which is why a parent's field offset is valid on a child without a check;
      (b) `orderedByInheritance` (533-551) exists because a parent must be laid out before
      its children, and source order does not guarantee that.
      `[t: tests/optimizing/metadata/class-table.test.ts > "places the first field directly after the object header"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "aligns a float field that follows an int field"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "rounds the instance size up to the object alignment"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "gives an inherited field the exact offset it has in the parent"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "starts a subclass's own fields after the whole parent instance"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "keeps the prefix property across a three-level chain declared out of order"]`
- [ ] **§ a-field-the-table-cannot-lay-out** — `fieldScalarOf` returning `null` does not
      refuse the class; it pushes the member's name onto `shape.unsupported` and carries on
      (812-816). Establish the design choice: a class with one un-layoutable field is still
      usable through its other fields, and the refusal is deferred to whoever actually
      touches it. Then `constructorFieldDisagreement` (1018-1034) as the cross-check that
      catches the opposite error — the constructor assigning a field the declared shape
      never saw — with its message quoted verbatim
      (`class X has fields the compiler cannot agree on: constructor assigns …; declared
      shape has …`). Note `declaredFieldsOf` counts `unsupported` names as declared, which
      is what keeps the two lists comparable.
      `[t: tests/optimizing/metadata/class-table.test.ts > "records a field whose declared type is not an AOT scalar instead of laying it out"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "names a field the constructor assigns but the shape never saw"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "names a field the shape declares that the constructor never assigns"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "counts a field with an unsupported type as declared rather than missing"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "compares only the class's own fields, not inherited ones"]`
- [ ] **§ the-table-in-the-binary** — What actually reaches the file, and the fact that it
      is emitted **twice** from one declaration. `TERA_CLASS_RECORD` (`runtime-layout.ts`
      :201-206) declares four count-sized fields — `tailReferences`, `fieldStart`,
      `fieldCount`, `reserved` — which the machine backends lay out as a flat record indexed
      by `TERA_CLASS_RECORD_SHIFT`, with the offsets themselves in the separate
      `tera_class_fields` table. `cClassTable` emits the same information in C's own idiom:
      a struct holding a *pointer* to a per-shape `tera_fields_<id>[]`. Establish the
      invariant this pair is the clearest example of: **two independent implementations,
      one declaration** — the same rule the part opener states for `tera_context`.
      Then `referenceFieldOffsets` (1002-1008): the row does not describe *fields*, it
      describes **pointers** — `field.scalar === SCALAR_POINTER`, sorted. A `float` field is
      invisible to this table, which is exactly right, because its only consumer is the
      collector.
      `tailReferences` is the escape hatch for a shape whose *size* is not fixed: everything
      past the header is a vector of references. Only `arrayBufferShape` (171-176) sets it,
      and only when the element scalar is `SCALAR_POINTER`.
      Show the two branches of `tera_reference_count` / `tera_reference_at` from the emitted
      C, which is the entire meaning of the flag in six lines.
- [ ] **§ an-array-is-two-objects** — *Why the obvious design fails.* The obvious design is
      one heap object per array, header plus elements inline, sized at allocation. Stage it,
      then break it with `xs.push(v)`: growing means allocating a bigger block, and every
      name already bound to the old block — a local, a field, a callee's parameter — is now
      looking at a stranded copy. With no moving collector ([Ch 61 § nothing-moves]) there
      is no forwarding pointer to save it.
      The fix is one indirection. `defineArray` (596-609) mints **two** shapes:
      `tera_array$<declaredType>`, a fixed 24-byte header `{length: int32 @8, capacity:
      int32 @12, elements: pointer @16}`, and `tera_array_buffer$<scalar>`, a shape with no
      declared fields and `tailReferences` set when the element is a pointer. Growth
      reallocates the buffer and rewrites one field; every alias still reads the header.
      Fixed-width ASCII table for both blocks.
      Establish the naming rule as a **hard invariant**: *an array shape's name must
      determine its element scalar*, because `mint` returns an existing shape by name and
      `arrays.set(shape.name, …)` then overwrites the layout. Naming with `declaredTypeOf`
      dropped nullability, `int` and `int | null` collided, and every `int[]` in the program
      silently became a float64 array. It names with `heldTypeOf` (115-120) now.
      `[t: tests/optimizing/metadata/class-table.test.ts > "keeps the absence an element admits in the name it lays the array out under"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "gives an element that admits an absence a shape apart from the one that does not"]`
      `[t: tests/optimizing/passes/array-shapes.test.ts > "keeps an element that admits an absence apart from the one that does not"]`
      `[t: tests/optimizing/passes/array-shapes.test.ts > "lays a nullable numeric element out as a double, leaving the plain one an int"]`
      `[t: tests/e2e/optimizing/aot/heap-arrays.test.ts > "grows an array past the length it was created with"]`
      `[t: tests/e2e/optimizing/aot/heap-arrays.test.ts > "grows an array reachable through a field without losing the holder"]`
- [ ] **§ naming-what-an-array-holds** — `arrayModelOf` (641) as five sources tried in
      order — a stamped `VALUE_CLASS_PROP` (`shapedArray`), a declared parameter
      (`receivedArray`), a callee's answer (`answeredArray`), a nested element name, and
      `mergedArray` for a phi. Establish why a phi needed its own case and why it needed a
      **re-entrancy set**: a loop-carried array variable is its own input through the back
      edge, so the walk must skip that input as the back edge while still refusing any
      *other* unresolvable arm. Same idiom appears twice in the file (`merging` at 617,
      `naming` at 667), which is itself worth naming as a pattern.
      `[t: tests/optimizing/passes/array-shapes.test.ts > "carries the element through a merge whose arms allocate the same array"]`
      `[t: tests/optimizing/passes/array-shapes.test.ts > "answers nothing for a merge whose arms hold elements that disagree"]`
      `[t: tests/optimizing/passes/array-shapes.test.ts > "answers the seeded arm rather than recursing on a phi that feeds itself"]`
      `[t: tests/optimizing/passes/array-shapes.test.ts > "takes an element an arm only guessed as no evidence at all"]`
- [ ] **§ structural-not-nominal** — *Bugs are told as engineering.* The chapter's centre.
      **Symptom:** `examples/design-pattern/20_state.tera` compiled with no warning and
      printed `state: published | published` instead of `… | already published`.
      **Mechanism:** `Document.state` is assigned `DraftState()` in the constructor, so the
      field's declared type names `DraftState`; the dispatch cone was built by walking
      `parent` links, `PublishedState` has no parent, the cone was `[DraftState]`, and a
      one-target cone devirtualizes to a direct call. **The checker had always disagreed:**
      `objectAssignable` in `frontend/checker/type-system.ts` accepts any object with the
      required surface, so the assignment `document.state = PublishedState()` is legal tera.
      **`> **New idea.** Structural vs nominal subtyping** — and the general rule this
      produced: **a compiler's class hierarchy must be built from the same relation its
      type checker uses, or devirtualization is unsound.**
      **Fix:** `dispatchConeOf` (renamed from `subclassesOf`) returns every *concrete* shape
      that `conformsTo` the required one — same offset **and** same scalar for every
      required field, same arity for every required callable (908-925). **`> **New idea.**
      Class hierarchy analysis.** **Regression test:**
      `[t: tests/optimizing/metadata/class-table.test.ts > "covers an unrelated class that carries the same surface"]`.
      Establish the cost control: cones are computed lazily from a member-name index
      (`byMember`), seeded from the *rarest* required member (888-897), and cached in
      `cones` — not a pairwise scan of all classes. `defineSynthetic` and `mint` clear the
      cache, which is the only reason a later-minted class cannot be missed.
      Close on the free consequence: **field offsets agree by construction inside a cone**
      (that is what `conformsTo` checks), so `applyFieldAccess` may use a fixed offset with
      no receiver check at all.
      `[t: tests/optimizing/metadata/class-table.test.ts > "includes every concrete subclass of an abstract base in its cone"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "leaves the abstract base itself out of its own cone"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "leaves out a class that is missing part of the surface"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "leaves out a class whose member of the same name takes a different arity"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "leaves out a class that puts a shared field in a different slot"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "parts company with the structural dispatch cone"]`
- [ ] **§ interfaces-are-shapes-too** — `interfaceSurfaceOf`
      (`src/frontend/modules/interface.ts`:123-140) turns an `interface` into an
      **abstract** `ClassSurface`: a member whose declared type parses as a function
      signature becomes an abstract `method`, everything else stays a `CLASS_DATA_MEMBER`.
      So an interface is laid out by the same `Table.define` as a class — parent `null`,
      cursor starting at `CLASS_HEADER_BYTES` — and its fields acquire **concrete offsets
      of their own**. Establish the consequence, because it is sharp and it is not
      obvious: `conformsTo` compares offsets, so an implementing class is in the cone only
      if it happens to place the interface's fields at the same bytes. Declaration order
      is layout. See § honesty-items for what that costs today.
      Abstract shapes are indexed separately (`abstractByMember`) and drive `standInsFor`
      (872-886) — the inverse question, "which declared surfaces does this concrete class
      stand in for" — which `commonStandInOf` uses to find a common type for a merge with no
      common ancestor. `narrowestOf` picks the one covering the fewest shapes.
      `[t: tests/optimizing/metadata/class-table.test.ts > "reports every implementation reachable from the receiver type"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "attributes an inherited method to the class that defines it"]`
      `[t: tests/optimizing/metadata/class-table.test.ts > "omits an abstract declaration from the implementations of its own cone"]`
      `[t: tests/e2e/optimizing/aot/interface-dispatch.test.ts > "calls a method on what another interface call answered"]`
      `[t: tests/e2e/optimizing/aot/interface-dispatch.test.ts > "keeps a shared base class as the element type when there is one"]`
- [ ] **§ spending-the-table** — `class-member-lowering` (legalization pass 291) as the
      consumer. Four rewrites, each ending in a constant:
      (a) **construction** — `applyConstruction` (540-566) splits `Foo(x)` into an
      `irNewObject` stamped with `CLASS_ID_PROP`/`INSTANCE_SIZE_PROP`/`VALUE_CLASS_PROP` and
      a direct call to `shape.constructorSymbol` with the allocation prepended as `this`;
      (b) **field access** — `applyFieldAccess` (349) becomes `irLoadField(receiver,
      field.offset)` stamped with `FIELD_TYPE_PROP` and `FIELD_SCALAR_PROP`, the props
      chapter 56 reads;
      (c) **a call with one target** — a direct `CallKnownFunction` on
      `classMemberSymbol`'s name, `Owner.method`;
      (d) **a call with several** — the ladder below.
      Establish the devirtualization shortcut: a receiver the pass can *see being allocated*
      has exactly that class, so `Foo().bar()` never pays for a ladder even when `Foo`'s
      cone is wide.
- [ ] **§ the-dispatch-ladder** — `applyDispatchLadder` (596-652) in full, because it is the
      one place a native tera program branches on a runtime type.
      **`> **New idea.** Virtual dispatch, and a branch ladder as its simplest
      implementation.** `shapeIdOfReceiver` (568-578) loads the `u32` at offset 0; each arm
      compares it against a constant `classId` with `irInt32Compare("==")` and jumps to a
      block holding a direct call; results merge into one phi in the block
      `splitBlockAfter` created. Show the shape of the generated CFG as a Mermaid diagram.
      Establish the two things worth noticing: **the last arm carries no test** (636-638) —
      the cone is exhaustive by construction, so the final `else` is unconditional — and
      there is **no vtable and no indirect call**, which is the property chapter 58 finishes
      collecting.
      Note the cost honestly: the ladder is linear in the cone, with no measurement of when
      that stops being the right shape.
- [ ] **§ a-record-is-a-lookup-table** — The other use of a shape, where the *key* is a
      runtime value. `k in t` becomes an OR-chain of `GenericCompare("==", key, "<field>")`
      folded with `irInt32Or` (`keyedMembershipFor`, 843-872) — **no control flow at all**.
      `t[k]` becomes a chain of `irSelect(key == "<field>", loadField, previous)` over
      **unconditional** field loads, seeded with an absence constant
      (`keyedLookupFor`, 958-991). **`> **New idea.** Select — choosing a value without
      branching** — and why loading every field first is safe here (they all exist) but
      would not be in general.
      Gated by `lookupFieldsOf` (768-773): every field numeric, an int/float mix allowed —
      requiring one shared scalar refused ordinary rate tables where `"usd": 1.0` folds to
      an int. A record with a string field is left alone.
      `[t: tests/optimizing/passes/class-member-lowering.test.ts > "asks the key against every name the record carries"]`
      `[t: tests/optimizing/passes/class-member-lowering.test.ts > "answers true when any one of those matches"]`
      `[t: tests/optimizing/passes/class-member-lowering.test.ts > "reads whichever field the key names"]`
      `[t: tests/optimizing/passes/class-member-lowering.test.ts > "falls back to an absence when the key names none of them"]`
      `[t: tests/optimizing/passes/class-member-lowering.test.ts > "leaves a record holding something that is not a number alone"]`
- [ ] **§ a-dominating-in-removes-an-arm** — The small, sharp piece of reasoning that makes
      the previous section usable. A lookup seeded with `undefined` is nullable, so a
      `-> int` return refuses it ([Ch 56 § when-the-join-conflicts]). `provenPresent`
      (911-928) asks whether the program already proved the key is carried: the pass records
      every membership chain it creates in `GuardSearch.memberships`, `armsProving` (902)
      finds the blocks that branch on it, and the `DominatorTree` decides whether such an arm
      dominates the lookup. When it does, the chain is seeded with the **last field's value**
      instead of the absence constant and one comparison disappears with it.
      **`> **New idea.** Dominance used as a proof carrier** — if the only way to reach here
      was through that test, the test's answer is a fact here.
      Two traps worth stating: the guard's condition may be `Not(orChain)` **or**
      `Int32Compare(==, orChain, 0)` (`negatedOperandOf`, 885-891), and the membership must
      be recorded before the lookup is visited, which block order happens to guarantee.
      `[t: tests/optimizing/passes/class-member-lowering.test.ts > "spends no test on the last field, since one of them must hold"]`
      `[t: tests/optimizing/passes/class-member-lowering.test.ts > "reads the same proof out of a guard written the other way round"]`
      `[t: tests/optimizing/passes/class-member-lowering.test.ts > "keeps the absence when nothing proved the key is carried"]`
      `[t: tests/e2e/optimizing/aot/record-lookup.test.ts > "looks up a record of floats the way the interpreter does"]`
      `[t: tests/e2e/optimizing/aot/record-lookup.test.ts > "refuses an unguarded lookup answered as a whole number"]`
- [ ] **§ minting-into-the-same-table** — `defineSynthetic` (586-594) and `syntheticSurface`
      (`metadata/coroutines.ts`:67-80) as the extension point, and the census of who uses it:
      object literals (`object-literal-shapes.ts`:120 via `literalShapeSurface`), joined
      literals (`joinedLiteralShape`), structural shapes minted on demand from a declared
      object type (`mintStructural`, 637-648), arrays (`defineArray`), closure frames
      (`closure-conversion.ts`:195), coroutine frames, promises and timers
      (`coroutines.ts`:82-107), generator frames (`generators.ts`:26), and the string box
      (`string-boxing.ts`:32). Establish the design claim: **a synthetic class is
      indistinguishable from a user class**, so it gets a layout, an id, a `tera_classes`
      row, reference offsets and therefore precise collection, for free.
      Note `syntheticShape` (123-144) sizes itself from the *maximum* `offset + width` of
      the fields handed to it, because its callers assign their own offsets.
      Hand over to chapter 58, whose entire subject is what gets minted here.

## Honesty items

- `> **Unenforced.**` — the header contract. Every producer of a heap block must write the
  shape id at offset 0 and the block size at offset 4, and the low three bits of that size
  must be zero. `tera_alloc` does it (`src/optimizing/backends/c/emit.ts`), the x64 inline
  bump-allocation fast path does it independently (`src/optimizing/backends/x64/heap.ts`),
  and nothing checks that they agree. Getting it wrong is not a crash but a collector that
  walks garbage. Cost: a size assertion in a debug build, or a single shared emitter for the
  two-word prologue — the second is a real refactor across two backends.
- `> **Unfinished.**` — `TERA_CLASS_RECORD` declares a fourth field, `reserved`, that
  nothing reads or writes (`src/optimizing/target/runtime-layout.ts:205`). It is the slot
  freed when per-block `size` moved into the flags word and `tailReferences` took its place.
  Cost to remove: it is padding to a power-of-two record size, and
  `TERA_CLASS_RECORD_SHIFT = Math.log2(TERA_CLASS_RECORD.bytes)` (line 250) requires that,
  so removing it means giving the shift a different definition.
- `> **Unfinished.**` — an array's buffer never shrinks. `pushElement` /
  `tera_array_reserve` amortised-double and copy, and there is no counterpart for `pop`,
  `shift` or `splice`; those return elements and lower the length, and the capacity stays.
  Named in `src/optimizing/passes/array-shapes.ts` only by absence. Cost: a shrink policy is
  a policy question, not a patch — nothing in the tree measures allocation behaviour.
- `> **Broken.**` — `docs/example/stats-poly.tera` is listed in `docs/example/README.md`
  as this chapter's polymorphism example and does not reach it: `fn report(s)` has no
  declared parameter type, so `requireDeclaredParameters` throws
  `AotUndeclaredParameterError` before the class table is ever consulted. The chapter uses
  `examples/design-pattern/20_state.tera` instead. See [Ch 56 § honesty-items] for the
  full accounting.
- `> **Unenforced.**` — `conformsTo` (`class-table.ts`:908-925) compares callables by
  **arity only**; parameter and return types are not checked. Two classes whose `render()`
  answers a `string` and an `int` are in one cone, and the dispatch ladder will call both
  through one call site's signature. No test covers a cone member whose member types
  disagree. Cost: comparing declared signatures needs a subtyping relation the class table
  does not currently hold, only names.
- `> **Broken.**` — an interface that declares a **data field** silently miscompiles when
  two implementing classes lay that field out at different offsets. `interfaceSurfaceOf`
  keeps the field, `Table.define` gives the interface its own offset for it, and
  `conformsTo` (`class-table.ts`:911-913) drops any class that put another field first —
  so the cone collapses to one member and `applyMemberCall` devirtualizes. Reproduced on
  this tree with `interface Named: label: string; describe() -> string` and two
  implementors, one declaring `label` first and one declaring an `n: int` first
  (no file in `docs/example/` covers this yet — writing one is the fix to the *book*):

  ```
  $ node dist/cli.js /tmp/iface-field.tera
  a b
  $ node dist/cli.js compile /tmp/iface-field.tera -o /tmp/ifacefield.exe && /tmp/ifacefield.exe
  a
  ```

  Reordering the two fields so both classes agree makes the binary print `a b`. This is the
  same shape of failure as § structural-not-nominal, one level down: the cone now matches
  the checker on *surface* but not on *layout*, and the checker does not care about layout.
  Cost to make it a refusal rather than a wrong answer: `conformsTo` would have to report
  *why* it rejected a candidate, and `dispatchConeOf` refuse a cone that a member-name
  index says should be wider than a layout comparison made it — roughly one extra index
  lookup per cone, plus a new refusal sentence. Cost to make it *work*: interface fields
  would need indirection the object model does not have.
  [unpinned] — no test covers an interface with a data field.

## Verify it yourself

```bash
node dist/cli.js examples/design-pattern/20_state.tera
node dist/cli.js compile examples/design-pattern/20_state.tera -o /tmp/state.exe && /tmp/state.exe
node dist/cli.js compile docs/example/stats.tera --emit source --target c -o /tmp/stats-c
sed -n '113,133p' /tmp/stats-c/stats.c
grep -n 'tera_alloc(' /tmp/stats-c/stats.c | head -8
printf 'interface Named:\n  label: string\n  describe() -> string\n\nclass First implements Named:\n  public label: string = "a"\n  public n: int = 1\n  public describe() -> string:\n    return this.label\n\nclass Second implements Named:\n  public n: int = 2\n  public label: string = "b"\n  public describe() -> string:\n    return this.label\n\nfn show(x: Named) -> string:\n  return x.describe()\n\nprint(show(First()), show(Second()))\n' > /tmp/iface-field.tera
node dist/cli.js /tmp/iface-field.tera
node dist/cli.js compile /tmp/iface-field.tera -o /tmp/ifacefield.exe && /tmp/ifacefield.exe
npx vitest run --project unit tests/optimizing/metadata/class-table.test.ts
npx vitest run --project unit tests/optimizing/passes/class-member-lowering.test.ts tests/optimizing/passes/array-shapes.test.ts
```

## Tests that pin this

- `tests/optimizing/metadata/class-table.test.ts` > `"places the first field directly after the object header"`
- `tests/optimizing/metadata/class-table.test.ts` > `"packs an int field at its own width rather than the pointer width"`
- `tests/optimizing/metadata/class-table.test.ts` > `"aligns a float field that follows an int field"`
- `tests/optimizing/metadata/class-table.test.ts` > `"gives a declared string field storage of its own rather than a pointer"`
- `tests/optimizing/metadata/class-table.test.ts` > `"aligns text storage on the pointer width instead of its full size"`
- `tests/optimizing/metadata/class-table.test.ts` > `"rounds the instance size up to the object alignment"`
- `tests/optimizing/metadata/class-table.test.ts` > `"gives an inherited field the exact offset it has in the parent"`
- `tests/optimizing/metadata/class-table.test.ts` > `"starts a subclass's own fields after the whole parent instance"`
- `tests/optimizing/metadata/class-table.test.ts` > `"keeps the prefix property across a three-level chain declared out of order"`
- `tests/optimizing/metadata/class-table.test.ts` > `"records a field whose declared type is not an AOT scalar instead of laying it out"`
- `tests/optimizing/metadata/class-table.test.ts` > `"lays out a field whose type is another class as a pointer"`
- `tests/optimizing/metadata/class-table.test.ts` > `"includes every concrete subclass of an abstract base in its cone"`
- `tests/optimizing/metadata/class-table.test.ts` > `"leaves the abstract base itself out of its own cone"`
- `tests/optimizing/metadata/class-table.test.ts` > `"covers an unrelated class that carries the same surface"`
- `tests/optimizing/metadata/class-table.test.ts` > `"leaves out a class that is missing part of the surface"`
- `tests/optimizing/metadata/class-table.test.ts` > `"leaves out a class whose member of the same name takes a different arity"`
- `tests/optimizing/metadata/class-table.test.ts` > `"leaves out a class that puts a shared field in a different slot"`
- `tests/optimizing/metadata/class-table.test.ts` > `"reports every implementation reachable from the receiver type"`
- `tests/optimizing/metadata/class-table.test.ts` > `"attributes an inherited method to the class that defines it"`
- `tests/optimizing/metadata/class-table.test.ts` > `"omits an abstract declaration from the implementations of its own cone"`
- `tests/optimizing/metadata/class-table.test.ts` > `"separates a class that merely carries the same surface"`
- `tests/optimizing/metadata/class-table.test.ts` > `"parts company with the structural dispatch cone"`
- `tests/optimizing/metadata/class-table.test.ts` > `"accepts a bytecode field list that matches the declared shape"`
- `tests/optimizing/metadata/class-table.test.ts` > `"names a field the constructor assigns but the shape never saw"`
- `tests/optimizing/metadata/class-table.test.ts` > `"names a field the shape declares that the constructor never assigns"`
- `tests/optimizing/metadata/class-table.test.ts` > `"counts a field with an unsupported type as declared rather than missing"`
- `tests/optimizing/metadata/class-table.test.ts` > `"compares only the class's own fields, not inherited ones"`
- `tests/optimizing/metadata/class-table.test.ts` > `"resolves a class name to a pointer rather than a float"`
- `tests/optimizing/metadata/class-table.test.ts` > `"gives a shape minted inside an outer one an id of its own"`
- `tests/optimizing/metadata/class-table.test.ts` > `"answers each nested shape by the id it was minted under"`
- `tests/optimizing/metadata/class-table.test.ts` > `"accepts a literal that lays its fields out like the class it stands in for"`
- `tests/optimizing/metadata/class-table.test.ts` > `"refuses a literal that holds the same field as a different scalar"`
- `tests/optimizing/metadata/class-table.test.ts` > `"stores the widened field as a float64 so either literal reads back"`
- `tests/optimizing/metadata/class-table.test.ts` > `"refuses a named class, which is nominal rather than structural"`
- `tests/optimizing/metadata/class-table.test.ts` > `"keeps the absence an element admits in the name it lays the array out under"`
- `tests/optimizing/metadata/class-table.test.ts` > `"gives an element that admits an absence a shape apart from the one that does not"`
- `tests/optimizing/metadata/class-table.test.ts` > `"finds a member the shape spells as a field"`
- `tests/optimizing/metadata/class-table.test.ts` > `"holds for a shape whose iterator method answers with the shape itself"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"carries an int array's element as a scalar with no element shape"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"gives a nested array an element shape that is itself an array"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"keeps an element that admits an absence apart from the one that does not"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"lays a nullable numeric element out as a double, leaving the plain one an int"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"shapes a numeric literal one of whose elements is absent"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"stores every element as a double, which is what carries the absence"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"leaves a literal of plain ints packed as ints"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"moves both records onto one shape so the array holds a single layout"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"keeps each record's instance size in step with the shape it adopted"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"carries the element through a merge whose arms allocate the same array"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"answers nothing for a merge whose arms hold elements that disagree"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"answers the seeded arm rather than recursing on a phi that feeds itself"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"takes an element an arm only guessed as no evidence at all"`
- `tests/optimizing/passes/array-shapes.test.ts` > `"answers rather than recursing when an array is filled from itself"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"asks the key against every name the record carries"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"answers true when any one of those matches"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"answers the last of those tests, so no membership survives the pass"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"leaves a record holding something that is not a number alone"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"reads whichever field the key names"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"falls back to an absence when the key names none of them"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"answers a spelled-out key the record does not carry with an absence outright"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"spends no test on the last field, since one of them must hold"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"reads the same proof out of a guard written the other way round"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"keeps the absence when nothing proved the key is carried"`
- `tests/optimizing/passes/class-member-lowering.test.ts` > `"drops the store when the receiver steps itself"`
- `tests/e2e/optimizing/aot/interface-dispatch.test.ts` > `"calls a method on what another interface call answered"`
- `tests/e2e/optimizing/aot/interface-dispatch.test.ts` > `"calls its own abstract method from a base class"`
- `tests/e2e/optimizing/aot/interface-dispatch.test.ts` > `"dispatches over an array literal of unrelated implementations"`
- `tests/e2e/optimizing/aot/interface-dispatch.test.ts` > `"keeps a shared base class as the element type when there is one"`
- `tests/e2e/optimizing/aot/heap-arrays.test.ts` > `"passes an array to a function that walks it"`
- `tests/e2e/optimizing/aot/heap-arrays.test.ts` > `"keeps an array in a field across calls"`
- `tests/e2e/optimizing/aot/heap-arrays.test.ts` > `"allocates the array on the heap rather than in the frame"`
- `tests/e2e/optimizing/aot/heap-arrays.test.ts` > `"grows an array past the length it was created with"`
- `tests/e2e/optimizing/aot/heap-arrays.test.ts` > `"grows an array reachable through a field without losing the holder"`
- `tests/e2e/optimizing/aot/heap-arrays.test.ts` > `"dispatches per element over an array it was handed"`
- `tests/e2e/optimizing/aot/record-lookup.test.ts` > `"looks up a record of floats the way the interpreter does"`
- `tests/e2e/optimizing/aot/record-lookup.test.ts` > `"answers a constant key the record does not carry the way the interpreter does"`
- `tests/e2e/optimizing/aot/record-lookup.test.ts` > `"refuses an unguarded lookup answered as a whole number"`
- `tests/e2e/optimizing/aot/record-lookup.test.ts` > `"leaves a record whose fields do not share one scalar alone"`
- `tests/e2e/optimizing/aot/record-lookup.test.ts` > `"looks up with a key an array handed back"`
- The dispatch **ladder shape itself** — **[unpinned]**. No unit test asserts the generated
  CFG of `applyDispatchLadder`; it is covered only end-to-end through
  `tests/e2e/optimizing/aot/interface-dispatch.test.ts`.
