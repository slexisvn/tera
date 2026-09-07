# 24. Property access, end to end   ⟨I · B · ~~J~~ · ~~N~~⟩

> **Status:** outline

**Thesis.** `obj.name` is not a lookup. It is a fixed sequence — nullish check, accessor
check, exotic hook, visibility check, inline-cache probe, feedback record, prototype walk
— and the order is *semantically significant*: every step before the cache is a step the
cache is not allowed to answer.

**What arrived.** From [Ch 23 § arrays-are-not-objects]: a `JSObject` whose `HiddenClass`
carries an `id`, a `version`, an `isDeprecated` flag, a `protoObject` and a shared
`prototypeValidityCell`; a flat `slots` array addressed by offset, with `overflowProperties`
past ten; `AccessorPair` sharing those slots with data; `lookupPrototypeChain` returning
`{found, value, owner, descriptor, depth}`. And the explicit warning that a `JSArray` is
*not* a `JSObject` and cannot answer `length` this way. From [Ch 21], the ten opcodes
lifted into `handlers.ts` and named but not opened.

**What leaves.** Two things, and chapter 25 takes only the second.
First, for a `JSObject` receiver: a resolved `TaggedValue`, plus a filled `FeedbackSlot`
carrying `(mapId, version, offset, protoDepth)` and a warm `InlineCache` entry under the
site key `funcName#fnId:slot`. That pair is the entire input to [Ch 33] and [Ch 34], and
[Ch 54] is what happens when it lies.
Second, for every receiver that is *not* a `JSObject` — an array, a string, a number, a
function, a promise — a single unresolved call, `memberLookupValue(obj, propName, interp)`,
sitting at the bottom of `handleLdaProp` with nothing behind it. Chapter 25 opens that.

**New ideas.** *Exotic object* — an object with behaviour that is not "look in the slots",
and the ECMAScript term for it, used here because the directory is called `exotic/`.
*Trap* / *proxy* (introduced, not developed — [Ch 26] carries proxies). *Receiver vs.
owner* — the object the access started from versus the object the property was found on,
and why a getter must be called with the first. *Accessor property* as distinct from a
data property. *Access-site enforcement* — a rule the type checker also states, re-checked
at run time because the checker is not the only way in. Not new here: inline caches
([Ch 34]) and feedback lattices ([Ch 33]) are *named* in this chapter and *explained* in
Part V; this chapter's job is to show where in the sequence they are consulted.

**Length.** 12 pages

## Anchors

- `src/bytecode/register/interpreter/handlers.ts` — 709 lines, the chapter's spine.
  The structural `InterpreterLike` type (77-101) — the cost [Ch 21] named;
  `constantPropertyName` (105-110); `PropertyFeedbackSlot` and `recordPropertyFeedback`
  (112-147) — the four-tuple, and its two early returns on `kind === "accessor"`;
  `throwNullishAccess` / `throwIfNullish` / `throwIfNullishKey` (149-175);
  **`handleLdaProp` (177-288)** — read it top to bottom, it *is* the chapter;
  `handleStaProp` (291-373); `handleLdaIndex` (375-…) named here, opened in [Ch 26].
- `src/objects/exotic/proxy-ops.ts` — 765 lines, the generic protocol.
  `runtimeGetProperty` (362-477): symbol keys first, then proxy traps with the
  `targetOwnDataInvariant` check (53-…), then object / array / string / function in that
  order; `ordinaryGetObject` (221-253) — the accessor-aware object path, with
  `taggedReceiver` passed separately from `obj` so a getter is called on the receiver;
  `ordinarySetObject` (255-…); `runtimeSetProperty`, `runtimeHasProperty`,
  `runtimeDeleteProperty`, `runtimeOwnKeys`, `runtimeGetOwnPropertyDescriptor`,
  `runtimeDefineProperty` (478-757); `isJSProxyValue` (144), `getTrap` (207).
- `src/objects/exotic/function-members.ts` — 178 lines. `resolveFunctionSlot` (33-39) —
  the `staticBase` walk that makes static inheritance work; `functionMemberValue`
  (112-138) — own slot, then `call`/`apply`/`bind`, then `name`, then `length`, then the
  lazily-created `prototype`; `makeFunctionMethod` (53-101) — `call`, `apply` and `bind`
  synthesised as fresh native functions on every access; `setFunctionMember` (140-157);
  `defineFunctionAccessor`; `setFunctionStaticBase`.
- `src/runtime/class-access.ts` — 181 lines, no dependencies on the interpreter.
  `assertObjectMemberAccess` (53-62) and `assertFunctionMemberAccess` (64-73) — the two
  the handlers call; `instanceMemberAccess` / `staticMemberAccess` / `findMemberAccess`
  (105-127) — the `staticBase` lineage walk over
  `classInstanceMemberVisibility` / `classStaticMemberVisibility`;
  `memberAccessAllowed` (129-139) and `lineageIncludesBeforeOwner` (154-166) — the
  `protected` rule; `throwAccess` (179-181) — the verbatim message.
- `src/objects/heap/symbol-properties.ts` — 32 lines. `readSymbolProperty`,
  `writeSymbolProperty`, `ownsSymbolProperty`, `removeSymbolProperty`, and the one design
  fact: the map is keyed by `getPayload(taggedSym)` — the `JSSymbol` object — and lives on
  the *instance*, never in the hidden class.
- `src/runtime/member-lookup.ts:150-159` — `memberLookupValue`, the tail call
  `handleLdaProp` ends in. Named here, opened in [Ch 25].
- `src/runtime/value-semantics.ts:41-50` — `getRuntimeProperty`, the *other* front door:
  `memberLookupValue` first, `proxyRuntimeGetProperty` as the fallback. This is what the
  baseline and JIT runtimes call, and the reason the two paths agree.
- `src/feedback/vector/index.ts:202-…` — `FeedbackSlot.recordPropertyAccess(hiddenClassId,
  offset, mapVersion, protoDepth)` and the four parallel arrays `maps` / `mapVersions` /
  `offsets` / `protoDepths`. Cited here, opened in [Ch 33].
- `src/feedback/ic/index.ts` — `InlineCacheManager.getOrCreate(key)`, `ic.lookup(obj,
  name)`, `ic.lookupForWrite(obj, name, value)`, `LoadFieldHandler`,
  `ProtoLoadFieldHandler`, `MissingPropertyHandler`, `MegamorphicCache`. Named here,
  opened in [Ch 34].
- `src/bytecode/register/ops/bytecode.ts:517-525` — `getICKey(funcName, fbSlotIdx)`,
  memoised per function: `"mean#7:1"`. And 620-655, the disassembler that prints *every*
  non-special operand with an `r` prefix, so a feedback-slot index shows up as `r1`.

## Worked example

`docs/example/stats.tera`, line 9: `while i < this.values.length`. One source expression,
two `LdaNamedProperty` instructions, two completely different code paths.

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
```

```
     8  LdaNamedProperty r4 [1] (values) r0
    10  LdaNamedProperty r3 [2] (length) r1
```

— `stats.tera` via `--print-bytecode --filter mean`

Both are the same opcode. The first has a `JSObject` receiver: it runs the whole sequence,
finds `values` at offset 1 of `HC89`, records `(89, version, 1, 0)` into feedback slot 0
and installs an IC handler. The second has an *array* receiver, so it falls past every
object branch in `handleLdaProp` and out of the bottom into `memberLookupValue` — no map,
no offset, no IC entry, and the only thing recorded is `recordArrayLengthAccess(true,
elementsKind)`. Reading the trace, the object hop is a `[IC] Site …(map=HC89, offset=1)`
line and the array hop is not there at all:

```bash
node dist/cli.js --trace docs/example/stats.tera | grep -E '^\[IC\]' | head -8
```

Note also the disassembly's trailing `r0` / `r1` on those two lines: those are **feedback
slot indices, not registers**. The disassembler prefixes every operand it does not
specially format with `r` (`bytecode.ts:649`), and the same wart makes `JumpIfFalse r32 r3`
print a jump *target* as a register. Say it once, then keep using the tool's output
([Conventions § 4](../CONVENTIONS.md)).

## Outline

- [ ] **§ lda-prop — the sequence, in order.** Number the steps as they appear in
      `handleLdaProp` (177-288) and establish that this list *is* the specification:
      (1) read the receiver register and resolve the name from the constant pool;
      (2) `throwIfNullish`; (3) record a primitive receiver tag if the receiver is not an
      object; (4) proxy? — hand the whole thing to `runtimeGetProperty`;
      (5) object? — `assertObjectMemberAccess`; (6) own accessor?; (7) prototype accessor?;
      (8) `size` on a Map/Set; (9) string-wrapper `length` and index;
      (10) `ic.lookup`; (11) `recordPropertyFeedback`; (12) on a miss, `getProperty` then
      `lookupPrototypeChain`; (13) not an object at all — the array-`length` feedback
      record, then `memberLookupValue`. Establish the shape: twelve of the thirteen steps
      exist to decide whether step 10 is even *allowed*.
- [ ] **§ why-the-obvious-design-fails — cache first, correct later.** Stage the design a
      reader will propose: consult the inline cache first, since that is the fast path, and
      fall back only on a miss. Then break it four ways, each with a program: a getter
      would be *read* instead of *called*; a `Proxy` would answer from its target instead
      of its trap; a `private` member would be readable from outside the class; and
      `map.size` — which is not a property at all — would resolve to whatever `size` a user
      once stored. Establish the rule: **a cache may only memoise a decision that has
      already been made**, so everything that can change the decision must run first. That
      is why the fast path in this engine is thirteen steps long, and why [Ch 34]'s
      handlers can be as simple as they are.
- [ ] **§ nullish-first.** `throwIfNullish` and the message factory `throwNullishAccess`,
      which composes `Cannot ${verb} properties of ${typeName} (${gerund} '${propName}')`
      from a boolean. Establish that this is the *only* step that can run before the
      receiver's kind is known, and that the two absence values of [Ch 22] are
      distinguished in the message text (`of null` vs `of undefined`) and merged in the
      predicate (`isNull(obj) || isUndefinedVal(obj)`). Quote the diagnostic verbatim
      ([Conventions § 5](../CONVENTIONS.md)).
- [ ] **§ accessors-before-the-cache.** Own accessor first (`lookupProperty` +
      `kind === "accessor"`), then the prototype chain's. Both call
      `interp.callFunctionValue(pair.get, [], obj)` — with `obj`, the *receiver*, not the
      owner, which is the whole reason `lookupPrototypeChain` returns `owner` and `depth`
      separately. Establish the two consequences a reader must carry forward: an accessor
      whose `AccessorPair` has no `get` answers `mkUndefined()` rather than throwing; and
      because both branches `return` before step 10, **an accessor site is never cached and
      never profiled** — `recordPropertyFeedback` also bails on `kind === "accessor"`
      (128, 138), so the slot stays `uninitialized` for the life of the process. Verify it
      from the trace: a program whose only property read is a getter produces no `[IC]`
      line at all. Honesty item below.
- [ ] **§ exotic-fast-paths.** Three special cases, all keyed on
      `hiddenClass.instanceType`, all before the cache: `size` for `INSTANCE_TYPE_MAP` and
      `INSTANCE_TYPE_SET` (reading `_mapData!.size`, a *host* `Map`'s size, not a
      property); `length` and integer indices for `INSTANCE_TYPE_STRING_WRAPPER`, reading
      `_primitiveValue` through `stringCharAt` — which is [Ch 26]'s negative-index
      convention, arriving early. Establish why these live here rather than in
      [Ch 25]'s table: the receiver *is* a `JSObject`, so the table would never see it.
      Then the asymmetry: `handleLdaProp` imports `INSTANCE_TYPE_NUMBER_WRAPPER` and
      `INSTANCE_TYPE_BOOLEAN_WRAPPER` and uses neither — those two wrappers, built by
      `boxPrimitive` (`interpreter/index.ts:260-279`), get their members from their
      prototypes by the ordinary route.
- [ ] **§ proxies-and-symbol-keys.** `isJSProxyValue(obj)` is checked *fourth*, and hands
      the entire access to `runtimeGetProperty` — the generic protocol, which is a second,
      independent implementation of the same sequence (symbol → proxy → object → array →
      string → function). Establish what the two implementations share (`ordinaryGetObject`
      re-does the accessor and prototype logic) and what only the generic one has: symbol
      keys, the `get`-trap invariant checks against `targetOwnDataInvariant`, and recursion
      through `proxy.target` with `originalReceiver` preserved. Then symbol properties as a
      third storage class, beside slots and overflow: a `Map` keyed by the `JSSymbol`
      payload, held on the instance, **absent from the hidden class** — so a symbol-keyed
      property causes no transition, appears in no `getOwnPropertyNames`, and can never be
      inline-cached. Forward to [Ch 26] for proxies proper.
- [ ] **§ visibility-at-every-site.** `assertObjectMemberAccess` runs on *every* object
      property read and write, before anything is looked up. Walk `findMemberAccess`: it
      climbs the `staticBase` chain of the receiver's constructor looking for the name in
      `classInstanceMemberVisibility`, so a member declared `private` five classes up is
      still found. Then `memberAccessAllowed` — `currentClassOwnerName(interpreter)` asks
      the *interpreter* who is executing, which is how a method of the owning class is
      distinguished from an outside caller with no static information at all. Then
      `lineageIncludesBeforeOwner`, the `protected` rule, which is genuinely subtle and
      deserves the chapter's one three-class diagram. Establish why this is re-checked at
      run time when the checker already rejects it statically: the checker is not the only
      way in — the REPL, `--eval`, a host embedder and a computed key all reach the same
      handler. Show the verbatim refusal, `Cannot access private member 'secret' of 'Box'`.
- [ ] **§ functions-are-not-objects.** A `TaggedValue` with `CODE_FUNCTION` has a
      `RuntimeFunctionPayload`, not a `JSObject`, so none of the above applies:
      `functionMemberValue` runs a different protocol. `resolveFunctionSlot` walks
      `staticBase` checking `accessors` before `properties` at each level — that walk is
      static-member inheritance. Then the synthesised members, in order: `call`, `apply`
      and `bind` built fresh by `makeFunctionMethod` **on every access** (so
      `f.call !== f.call`); `name`; `length` from `functionArity`; and `prototype`, created
      lazily on first read and back-linked with `constructorRef`. Establish the ordering
      rule that falls out — an own property always wins over a synthesised one, which is
      what `tests/e2e/optimizing/member-access.test.ts > "keeps a user-set own property
      winning over a builtin member"` pins — and the `bind` detail worth one sentence: the
      bound function's `construct` ignores its own `this` and calls the target with
      `mkUndefined()`.
- [ ] **§ the-second-hop — `this.values.length`.** The worked example, walked twice through
      the sequence. First hop: `this` is a `Series` instance, so steps 5-12 run, the IC is
      created under key `mean#<id>:0`, the handler is `LoadFieldHandler(HC89, version, 1,
      "values")` and the feedback slot records `(89, version, 1, 0)`. Second hop: the
      receiver is a `JSArray`, so `isObject` is false, *every* object branch is skipped,
      and the one thing that happens before the fall-through is
      `recordArrayLengthAccess(true, getPayload(obj).getElementsKind())` — the elements
      kind from [Ch 23] entering the feedback vector, and the exact fact `stats-deopt.tera`
      later invalidates. Establish the handover sentence: an array's `length` is answered
      by nobody in this chapter.
- [ ] **§ store-is-not-load.** `handleStaProp` (291-373) as a diff against
      `handleLdaProp`, not a re-walk. Same prefix (nullish, proxy, visibility, accessor),
      then three divergences: the `_frozen` / `_sealed` / `_nonExtensible` flags checked
      here and nowhere else ([Ch 23 § integrity-levels] explains why they are flags);
      `ic.lookupForWrite`, whose interesting case is a *transitioning* store — the store
      that adds a property and therefore changes the map; and an `enforceAccess` parameter
      that lets a constructor initialise its own private fields. Then the tail that
      `handleLdaProp` does not have: an array receiver routes `length` to `setLength`,
      integer names to `setIndex` and everything else to `setProperty`; a function receiver
      goes to `setFunctionMember`; a regex receiver accepts exactly `lastIndex`.
- [ ] **§ property-access — what one access leaves behind.** The closing section, and the
      artifact [Ch 25] and Part V receive. Two records per site: the `FeedbackSlot`'s
      parallel arrays `maps` / `mapVersions` / `offsets` / `protoDepths` — the four-tuple —
      and the `InlineCache` entry under `getICKey`'s memoised string. Show both moving on
      `stats-poly.tera`, where a second class with the same members drives one site from
      `monomorphic` to `polymorphic` in a single trace line
      (`[IC] Site #2944030887: monomorphic → polymorphic (map=HC92, offset=1)`), and the
      slot behind it (`[FB] Slot #0: property — monomorphic → polymorphic`). Establish the
      three destinations and stop: [Ch 33] reads the slot, [Ch 34] explains the handler,
      [Ch 49] speculates on the tuple and [Ch 54] undoes it. And restate what is *not*
      resolved: every non-object receiver, which is [Ch 25]'s whole chapter.

## Honesty items

- > **Unfinished.** Accessor properties are outside the feedback and inline-cache system
  entirely. `handleLdaProp:205-227` returns from both accessor branches before
  `ic.lookup`, and `recordPropertyFeedback` (`handlers.ts:128, 138`) returns early on
  `kind === "accessor"` in both of its branches. There is no accessor handler among the
  five kinds in `src/feedback/ic/index.ts`. A program whose only property read is a class
  getter produces no `[IC]` line and no `[FB] property` line, so a getter can never be
  inlined or speculated on by [Ch 49]. Finishing it means an IC handler that caches
  *which getter* rather than which offset, plus a dependency on the accessor's map.
- > **Unenforced.** `handleLdaProp` and `runtimeGetProperty` are two independent
  implementations of the same ordering — nullish, proxy, accessor, exotic, prototype — and
  nothing checks that they stay in step. They already differ: `runtimeGetProperty` handles
  symbol keys and the `obj._index` hook, `handleLdaProp` handles the string-wrapper fast
  path and the feedback records, and only `handleLdaProp` consults the IC. `handleLdaProp`
  delegates to `runtimeGetProperty` for proxies, so a single access can traverse both.
  The only thing that keeps them agreeing is
  `tests/e2e/optimizing/member-access.test.ts`'s cross-tier differential.
- > **Dead.** `handlers.ts:38-39` imports `INSTANCE_TYPE_NUMBER_WRAPPER` and
  `INSTANCE_TYPE_BOOLEAN_WRAPPER`; neither appears anywhere else in the file. Only
  `INSTANCE_TYPE_STRING_WRAPPER` has a fast path (237). The two imports are the residue of
  a symmetry that was never built.
- > **Broken.** `handleDeleteProp` (`handlers.ts:689-709`) discards the boolean
  `runtimeDeleteProperty` returns and unconditionally answers `mkBool(true)`, so
  `delete o.x` reports success even when the property is non-configurable and the delete
  did not happen. It also never checks `_frozen` / `_sealed`, which is the second half of
  [Ch 23 § integrity-levels]'s frozen-object defect. Fixing it is one `return` line; the
  reason to name it here is that this is the access site, and the access site is where the
  book has agreed such rules live.
- > **Unfinished.** `functionMemberValue` builds a *new* `call` / `apply` / `bind` function
  object on every access (`makeFunctionMethod`, 53-101), so `f.bind` allocates a
  `RuntimeFunctionPayload` and a `ValueHeap` slot each time it is read, and
  `f.call === f.call` is false. Memoising the three on the payload beside `properties`
  would cost one lazy field; nothing currently does. `[unpinned]`
- > **Unenforced.** `InterpreterLike` (`handlers.ts:77-101`) is a hand-written structural
  copy of the eleven interpreter members these handlers use. It is not derived from
  `RegisterInterpreter` and there is no `satisfies` linking them, so the two can drift
  until a call fails at run time. [Ch 21] names this as the price paid for lifting the ten
  opcodes out of the switch; this is the chapter that spends it.
- > **Unenforced.** Symbol-keyed properties bypass the hidden class completely
  (`symbol-properties.ts`), so they take part in no transition, no map version, no IC and
  no `getOwnPropertyNames`. Nothing states that invariant anywhere in the source; it is
  visible only by the absence of `symbolProperties` from `HiddenClass`. `[unpinned]`

## Verify it yourself

```bash
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --trace docs/example/stats.tera | grep -E '^\[IC\]' | head -8
node dist/cli.js --trace docs/example/stats-poly.tera | grep -E 'polymorphic' | head -6
printf 'class Cell:\n  public constructor(v: int):\n    this.v = v\n  public get doubled() -> int:\n    return this.v * 2\nc = Cell(21)\nprint(c.doubled)\nprint(c.v)\n' > /tmp/accessor.tera
node dist/cli.js --trace /tmp/accessor.tera | grep -E '^\[IC\]|^\[FB\]'
printf 'class Box:\n  private secret: int = 7\n  public peek() -> int:\n    return this.secret\nb = Box()\nprint(b.peek())\nprint(b.secret)\n' > /tmp/private.tera
node dist/cli.js /tmp/private.tera
npx vitest run --project unit tests/objects/exotic/proxy-ops.test.ts tests/feedback/ic.test.ts
```

The accessor run prints two `[IC]` lines and two `[FB] Slot #0: property` lines — both for
the `this.v` reads *inside* the getter. There is no record for `c.doubled` itself, which is
the honesty item above, reproduced.

## Tests that pin this

- `tests/objects/exotic/proxy-ops.test.ts > "reads named properties from plain object"`,
  `> "returns undefined for missing property"`, `> "reads array index from tagged array"`,
  `> "reads .length from array"`, `> "reads string .length"`,
  `> "reads string character by index"`,
  `> "reads function .prototype (auto-creates if missing)"` — the generic protocol's
  branch order, one test per branch, including the lazy `prototype`.
- `tests/objects/exotic/proxy-ops.test.ts > "isJSProxyValue detects proxy-wrapped objects"`,
  `> "get on proxy without trap falls through to target"`,
  `> "has on proxy without trap falls through to target"`,
  `> "set on proxy without trap falls through to target"`,
  `> "delete on proxy without trap falls through to target"`,
  `> "ownKeys on proxy without trap falls through to target"` — the recursion through
  `proxy.target`.
- `tests/objects/exotic/proxy-ops.test.ts > "sets named property on plain object"`,
  `> "sets array element by index"`, `> "sets array length to truncate"` — the store side.
- `tests/feedback/ic.test.ts > "matches when hcId, version match and not deprecated"`,
  `> "misses on different hcId"`, `> "misses on different version"`,
  `> "misses on deprecated"`, `> "executes by reading property at offset"` — what the
  handler installed at step 10 actually re-checks. [Ch 34] develops these.
- `tests/feedback/ic.test.ts > "matches when receiver and proto pass all checks"`,
  `> "misses a same-map receiver whose prototype differs"`,
  `> "misses when an intermediate prototype link is replaced"`,
  `> "misses when proto validity version changes"`, `> "misses when proto deprecated"` —
  `ProtoLoadFieldHandler`, i.e. a cached `protoDepth > 0` access.
- `tests/feedback/ic.test.ts > "always returns undefined"`,
  `> "misses a same-map receiver carrying a different prototype"`,
  `> "misses when the prototype later gains properties"` — `MissingPropertyHandler`:
  absence is cached too, and is the harder claim.
- `tests/feedback/ic.test.ts > "transitions uninitialized -> monomorphic -> polymorphic on different objects"`,
  `> "hits on monomorphic fast path"`, `> "hits on polymorphic path"`,
  `> "transitions to megamorphic after 8 unique classes"` — the state machine behind the
  `[IC] Site …` trace lines.
- `tests/e2e/optimizing/member-access.test.ts > "reads .length (arity) and .name, including on a returned closure"`,
  `> "invokes a function via .call and .apply"`,
  `> "keeps a user-set own property winning over a builtin member"` — the function-member
  protocol, checked against every tier.
- `tests/e2e/optimizing/member-access.test.ts > "keeps private instance reads guarded after warmup"`
  — visibility survives the tier the access is running in, which is the reason the check
  is at the access site rather than in the checker alone.
- `tests/e2e/optimizing/member-access.test.ts > "reads length, a character, and a method via a computed key"`,
  `> "keeps optional computed access short-circuiting on nullish"`,
  `> "indexes a string with a negative (python-style) index"`,
  `> "resolves computed string keys on a hot (compiled) call"`,
  `> "calls a string method on the string, not on undefined"`,
  `> "short-circuits to null on a nullish receiver"`,
  `> "calls a method on an object receiver"` — the string-wrapper and optional-access
  paths, and the receiver-preservation rule.
- `tests/e2e/language/classes.test.ts > "initializes and guards private instance fields"`,
  `> "guards private methods while allowing owner calls"`,
  `> "allows protected subclass access and rejects external access"`,
  `> "guards private and protected static members"`,
  `> "inherits static members through the constructor chain"`,
  `> "keeps static members off instances and instance members off the class"` —
  `class-access.ts`'s lineage walk, including the `protected` rule.
- No test pins the accessor-sites-are-never-cached behaviour, or the disassembler's `r`
  prefix on feedback-slot operands. `[unpinned]`
