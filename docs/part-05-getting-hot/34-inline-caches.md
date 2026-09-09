# 34. Inline caches   ⟨I · B⟩

There is no global cache invalidation in this engine. Nothing tells a cached property handler
that the object model has moved under it — no write barrier from a map to its dependents, no
list of caches to sweep when a class changes, no version epoch anyone bumps. Instead every
cached handler re-checks, on every single hit, the facts it was built on: map id, map version,
and that the map has not been deprecated. Three integer comparisons before the answer, forever.

That sounds like the design you would arrive at by not having got round to the clever one. It
is not. Cache invalidation is a bookkeeping problem, and bookkeeping is only correct if
everyone who could invalidate a fact remembers to say so; the failure mode is a cache that
keeps answering after the fact stopped being true, which is a wrong answer with no symptom.
Re-checking is the opposite trade: it pays a fixed price on every hit and cannot be got wrong
by someone adding a new way to mutate an object next year. This chapter argues that trade, and
then shows the one case where re-checking is genuinely hard — a property found on a *prototype*,
where the value lives on an object the receiver does not own and three separate things can
change beneath it — and the one case that is harder still, where the cached fact is that the
property is **absent**.

Absence is the thesis in miniature. To cache "`x` is at offset 3" you must be right about one
object. To cache "`x` is not here" you must be right about every object on the receiver's
prototype chain, *and* about where that chain ends, because a chain that grew a link may have
grown an `x`. The engine writes that difference down in one boolean parameter, `requireEnd`,
and the whole of the negative-caching story is the two call sites that pass it differently.

**What arrived.** From [Ch 33 § slots-are-operands], a feedback slot index on every property,
index and call instruction, and the `feedbackVector` those slots fill — which the optimizer
reads and this chapter's machinery does not. From [Ch 23 § what-leaves], a `JSObject` whose
`HiddenClass` carries an `id`, a `version`, an `isDeprecated` flag, a `migrationTarget`, a
`protoObject`, and a `prototypeValidityCell` shared with its add-transition children; a flat
`slots` array addressed by integer offset; and `lookupPrototypeChain` returning
`{found, value, owner, descriptor, depth}` with `owner` and `depth` reported separately. And
from [Ch 24 § lda-prop-the-sequence-in-order], the position of the thing this chapter opens: the inline-cache probe
is step 10 of a thirteen-step sequence, and the nine steps before it exist to establish that
step 10 is allowed to run at all.

## What a cache here is

> **New idea. Inline cache.** A program point that reads `obj.name` will, in almost every real
> program, see the same *kind* of object every time it runs. An **inline cache** exploits that:
> the first execution does the full lookup and then writes down what it found — "the receiver's
> shape was map 89, and the answer was at offset 1" — keyed by the program point. The second
> execution compares the receiver's map to the one written down, and on a match reads offset 1
> directly. The technique is called *inline* because in its original form the recorded facts
> were patched into the machine code at the call site, literally inline in the instruction
> stream. Almost no modern implementation does that any more, and tera does not: its caches are
> entries in a hash map keyed by a string. The name is kept because it is what everyone calls
> the technique.

`docs/CONVENTIONS.md` rule 4 says the code's names win, and the code says `InlineCache`. What
matters is what identifies a site. The key is built once per function and memoised:

```ts
  getICKey(funcName: string | null | undefined, fbSlotIdx: number): string {
    if (!this._icKeys) {
      this._icKeys = new Array(this.feedbackSlotCount);
      for (let i = 0; i < this.feedbackSlotCount; i++) {
        this._icKeys[i] = (funcName || "<anonymous>") + "#" + this.id + ":" + i;
      }
    }
    return this._icKeys[fbSlotIdx]!;
  }
```
— `src/bytecode/register/ops/bytecode.ts:517-525`

`funcName#fnId:slot`. So a site's identity is the pair *(compiled function object, feedback
slot)* — exactly the pairing [Ch 33 § slots-are-operands] allocated, reused here for a
completely separate data structure. `this.id` is the function's own id, not its name, so two
closures over the same source text are two different sites; and because the keys are built for
all `feedbackSlotCount` slots on the first call and cached in `_icKeys`, the key string for a
given site is a constant for the life of the process.

`--trace-ic` shows the key hashed to a number, because the tracer's parameter is typed
`number`:

```ts
function siteTraceId(siteId: SiteId): number {
  if (typeof siteId === "number") return siteId;
  let hash = 0;
  for (let i = 0; i < siteId.length; i++) {
    hash = (hash * 31 + siteId.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
```
— `src/feedback/ic/index.ts:93-100`

Which is why the trace reads `Site #2944030887` rather than naming the site. The hash is a
plain multiply-by-31 over the key string, so the mapping is recoverable by hand if you know the
candidate keys: `2944030887` is `report#2:0:load`, the `s.label` load in `report`. Every site
number quoted in this chapter was resolved that way.

## The five caches behind one site

One site key does not name one cache. It names a bundle of five, plus a shared fallback:

```ts
  constructor(siteId: SiteId, megamorphicCache = new MegamorphicCache()) {
    this.siteId = siteId;
    this.megamorphicCache = megamorphicCache;
    this.loadIC = new PropertyLoadIC(siteId + ":load", megamorphicCache);
    this.storeIC = new PropertyStoreIC(siteId + ":store", megamorphicCache);
    this.elementLoadIC = new ElementLoadIC(siteId + ":element-load", megamorphicCache);
    this.elementStoreIC = new ElementStoreIC(siteId + ":element-store", megamorphicCache);
    this.callIC = new CallIC(siteId + ":call");
  }
```
— `src/feedback/ic/index.ts:1352-1360`

Five sub-caches, each with its own state machine and its own site key formed by suffixing the
bundle's. `InlineCache.lookup`, `lookupForWrite`, `lookupElement`, `lookupElementForWrite` and
`lookupCall` (`:1382-1400`) are one-line delegations, and `invalidate` (`:1402-1408`) resets all
five. Four of the five share one `MegamorphicCache` — a per-bundle map from
`(map id, property name)` to a handler, used once a sub-cache has given up on keeping its own
entry list (`:316-371`). `callIC` is constructed without it, because a call site's fallback is
simply to miss.

The bundle also exposes a `state`, and it is worth naming as a reporting convenience rather
than a fact: `InlineCache.state` (`:1362-1370`) returns the first sub-cache whose state is not
`uninitialized`, scanning `loadIC`, `elementLoadIC`, `elementStoreIC`, `callIC` and falling
through to `storeIC`. A site that loads a property monomorphically and calls a method
megamorphically reports "monomorphic". Nothing in `src/` reads it.

`InlineCacheManager.getOrCreate` (`:1437-1442`) is the door: a `Map` from site key to bundle,
create-if-absent, with one shared `MegamorphicCache` handed to every bundle it makes. The
interpreter reaches it four times — in `handleLdaProp`, `handleStaProp`, `handleLdaIndex` and
`handleStaIndex` — and `BaselineRuntime` reaches it with the same keys.

## Lookup line by line

`PropertyLoadIC.lookup` (`src/feedback/ic/index.ts:584-686`) is a hundred lines with the whole
state machine written out in line — three arms and a shared miss path, no per-state helper —
and it is worth walking whole because the state machine is the chapter.

**The top is not a lookup at all.** Before anything else:

```ts
    if (obj.hiddenClass.isDeprecated && obj.migrateInstance) {
      obj.migrateInstance();
      this.invalidate();
    }
```
— `src/feedback/ic/index.ts:585-588`

A deprecated map means the object's shape has been superseded and it carries a
`migrationTarget` ([Ch 23 § deprecation-and-migration]). The receiver is migrated in place, and
the *site* throws its own entries away —
`invalidate()` sets state back to `uninitialized`, empties `entries`, and bumps
`transitionCount` (`:392-396`). This is the only invalidation that happens during ordinary
execution anywhere in the file, and it is a site invalidating itself on the strength of what it
is holding right now
`[t: tests/feedback/ic.test.ts > "handles deprecated map by invalidating"]`.

**Monomorphic.** One entry. Compare `entry.hiddenClassId` to the receiver's id, then ask the
handler `matches(obj)`. Two separate questions: the entry's key is the map id alone, and the
handler's `matches` is the full re-check. On success the site increments `hitCount`,
`entry.hitCount`, and `monomorphicSinceCount` — and at 100 consecutive monomorphic hits sets
`jitCandidate` (`:604-609`)
`[t: tests/feedback/ic.test.ts > "becomes JIT candidate after 100 monomorphic hits"]`. On a
`matches` failure the site takes the miss path and then *overrides* its result:

```ts
        if (!entry.handler.matches(obj)) {
          const result = this._miss(obj, propertyName, hcId);
          result.hit = false;
          return result;
        }
```
— `src/feedback/ic/index.ts:596-600`

The miss installs a fresh handler and computes the value; the caller is told `hit: false`
anyway, so it recomputes. Correctness by redundancy.

**Polymorphic.** A linear scan over up to eight entries, comparing map id first and `matches`
second, with a `continue` when the id matches and the handler does not — so a stale entry for a
map the receiver *does* have is skipped rather than repaired, and the scan falls out of the
bottom into `_miss`.

**Megamorphic.** The entry list is gone (`entries = null`) and the shared `MegamorphicCache`
answers instead, keyed by `(map id, property name)`. Its one structural difference from the
other two paths is what happens when the cached handler no longer matches:

```ts
      const handler = this.megamorphicCache.getLoad(hcId, propertyName);
      if (handler) {
        if (!handler.matches(obj)) {
          this.megamorphicCache.deleteLoad(hcId, propertyName);
        } else {
```
— `src/feedback/ic/index.ts:636-640`

It **deletes** rather than replacing. The map is shared by every site in the program, so a
handler that has gone stale for this receiver is removed for everyone, and whichever site meets
that `(map, name)` pair next pays the reconstruction.

**The miss.** `_miss` (`:688-762`) does the real lookup in three tiers — own property, then
prototype chain, then absence — building one of three handler classes, and then advances the
state machine: `uninitialized` to monomorphic, monomorphic to polymorphic (a *second* map
always transitions, even before the entry list is full), polymorphic while under
`MAX_POLY_ENTRIES`, else megamorphic with `entries = null`
`[t: tests/feedback/ic.test.ts > "transitions uninitialized -> monomorphic -> polymorphic on different objects"]`,
`[t: tests/feedback/ic.test.ts > "transitions to megamorphic after 8 unique classes"]`.

And one asymmetry that runs through every path. When the handler is a `MissingPropertyHandler`,
the return is:

```ts
        if (entry.handler.type === "MissingProperty")
          return { hit: false, value: undefined };
```
— `src/feedback/ic/index.ts:611-612`

`hit: false` on a cache **hit**. The cache found its entry, the entry matched, and the answer is
"there is nothing here" — which the result type has no way to say, because `hit` means *the
lookup produced a value*, not *the cache answered*
`[t: tests/feedback/ic.test.ts > "returns missing property as hit:false, value:undefined"]`.
§ absence-is-a-stronger-claim is where that costs something.

## What each handler verifies

A handler is a small object with a `matches(obj)` and an `execute(obj)`. `matches` is the whole
of the correctness argument; `execute` is one line. The row for each class:

| handler | what `matches()` checks | lines |
| --- | --- | --- |
| `LoadFieldHandler`, `StoreFieldHandler` (both via `FieldHandler.matches`) | map id, map version, `!isDeprecated`. Three checks, no prototype involvement. | `:156-162` |
| `TransitionStoreHandler` | `oldHiddenClassId`, `oldMapVersion`, `!isDeprecated`. Three checks; `execute` calls `obj.setProperty`, letting the map transition happen again rather than recording the target offset. | `:268-274` |
| `ProtoLoadFieldHandler` | eight `if`s: receiver map id, receiver map version, `protoObject` still present, the whole receiver chain down to `depth`, proto map id, proto map version, prototype validity version, proto `!isDeprecated`. | `:210-222` |
| `MissingPropertyHandler` | four: map id, map version, `!isDeprecated`, and the whole chain **to its end**. | `:302-309` |
| `LoadElementHandler`, `StoreElementHandler` | nothing. Neither class has a `matches` method; the *entry* compares `elementsKind` and the handler is never asked. | `:555-581` |
| `CallHandler` | target id, target version, argument count, and — for a method call only — receiver map id and version. | `:535-551` |

The base case is three lines:

```ts
  matches(obj: ICObject): boolean {
    return (
      obj.hiddenClass.id === this.hiddenClassId &&
      obj.hiddenClass.version === this.mapVersion &&
      !obj.hiddenClass.isDeprecated
    );
  }
```
— `src/feedback/ic/index.ts:156-162`

Three comparisons, on every hit, for the life of the process
`[t: tests/feedback/ic.test.ts > "matches when hcId, version match and not deprecated"]`,
`[t: tests/feedback/ic.test.ts > "misses on different version"]`,
`[t: tests/feedback/ic.test.ts > "misses on deprecated"]`. Version and deprecation are separate
because they mean different things: a version bump says *this map changed*, a deprecation flag
says *this map has been replaced and instances must migrate*. A handler must reject both, and
neither implies the other.

The reason three comparisons suffice for an own property is [Ch 23]'s: a `HiddenClass`'s
identity *includes* its prototype, so two objects with the same map id necessarily have the same
`protoObject`. That is what makes the two prototype handlers the hard case rather than every
handler.

## The two prototype handlers

A prototype hit is the case where the value is not on the receiver. `s.label` in `report` is
exactly this: `label` is a method, it lives on `Series`'s prototype object, and the receiver
`s` only knows how to reach it. Three things can change underneath such a cache, and they are
independent:

1. the receiver's own map, which is the ordinary case;
2. the *prototype object's* map — someone added a property to `Series.prototype`, so the offset
   the handler recorded may now hold something else;
3. the receiver's *path* to that prototype — someone re-pointed a link in the middle of the
   chain at a different object, so the handler is still describing a prototype the receiver no
   longer reaches.

`ProtoLoadFieldHandler`'s constructor snapshots enough to test all three:

```ts
    this.receiverMapId = receiver.hiddenClass.id;
    this.receiverMapVersion = receiver.hiddenClass.version;
    this.protoMapId = protoObject.hiddenClass.id;
    this.protoMapVersion = protoObject.hiddenClass.version;
    this.validityVersion = protoObject.getPrototypeValidityVersion();
    this.offset = offset;
    this.protoObject = protoObject;
    this.propertyName = propertyName;
    this.depth = depth;
    this.receiverProtoChain = captureProtoChain(receiver, depth);
```
— `src/feedback/ic/index.ts:198-207`

and `matches` re-checks every one of them (`:210-222`). The interesting piece is the chain.
`captureProtoChain(obj, maxLinks)` (`:112-124`) walks up from `obj.prototype` recording, per
link, the object reference *and* its map id and version; `protoChainMatches` (`:126-141`)
replays that walk against a fresh receiver:

```ts
  let current: ICObject | null = obj.prototype;
  for (let i = 0; i < links.length; i++) {
    if (current === null) return false;
    const link = links[i];
    if (current !== link.object) return false;
    if (current.hiddenClass.id !== link.mapId) return false;
    if (current.hiddenClass.version !== link.mapVersion) return false;
    current = current.prototype;
  }
  return requireEnd ? current === null : true;
```
— `src/feedback/ic/index.ts:131-141`

`current !== link.object` is an **identity** comparison, and it comes first. Two structurally
identical prototypes with the same map id are not interchangeable here, and that is deliberate:
the handler holds a direct reference to `protoObject` and will read the value out of *that*
object, so "some object with the same shape" is not good enough
`[t: tests/feedback/ic.test.ts > "misses a same-map receiver whose prototype differs"]`. The
intermediate-link case is pinned separately, with a two-deep chain where only the middle object
is swapped for a structural twin
`[t: tests/feedback/ic.test.ts > "misses when an intermediate prototype link is replaced"]`.

The fourth snapshot, `validityVersion`, is a single-integer signal that catches mutation
*through* a prototype without any of the above changing.
`HiddenClass.prototypeValidityCell` is one counter object, and an add-transition child
**shares its parent's cell**
(`src/objects/maps/hidden-class.ts:316`) while a prototype transition gets a fresh one (`:516`).
So one counter speaks for a whole family of maps. `JSObject.invalidatePrototypeDependents`
bumps it, and in the same breath tells the JIT:

```ts
  invalidatePrototypeDependents(reason: string): string {
    const oldProtoVersion = this.hiddenClass.prototypeValidityCell.version;
    this.hiddenClass.prototypeValidityCell.version++;
    dependencyRegistry.invalidate(
      DEP_PROTO_VALIDITY,
      this.hiddenClass.id,
      oldProtoVersion,
      reason,
    );
    return reason;
  }
```
— `src/objects/heap/js-object.ts:216-226`

Two consumers, two mechanisms, one event: the interpreter's caches find out by *asking* on their
next hit `[t: tests/feedback/ic.test.ts > "misses when proto validity version changes"]`, and
compiled code finds out because the dependency registry marks it for deoptimization
([Ch 54 § deopt-triggers]). The pull and the push exist side by side, and only the compiled tier
needs the push — because compiled code has no place to put a check it did not emit.

## Absence is a stronger claim

`MissingPropertyHandler` caches the fact that a property is not there. Its constructor is four
assignments and one walk:

```ts
  constructor(receiver: ICObject, propertyName: PropertyKey) {
    this.type = "MissingProperty";
    this.hiddenClassId = receiver.hiddenClass.id;
    this.mapVersion = receiver.hiddenClass.version;
    this.propertyName = propertyName;
    this.offset = -1;
    this.protoChain = captureProtoChain(receiver, Infinity);
  }
```
— `src/feedback/ic/index.ts:293-300`

`Infinity`, not `depth`. And in `matches`, `protoChainMatches(obj, this.protoChain, true)` — the
`requireEnd` flag, whose entire job is the last line of `protoChainMatches`:
`return requireEnd ? current === null : true;`.

That one boolean is the asymmetry. `ProtoLoadFieldHandler` passes `false`, because it has
*found* the owner: it walked `depth` links, the value is there, and whatever lies beyond the
owner cannot change the answer — a property further up the chain is shadowed by the one it
found. `MissingPropertyHandler` passes `true`, because it found nothing, and "nothing, all the
way up" is only true if the chain still ends where it ended. A receiver whose chain grew a link
may have grown the property
`[t: tests/feedback/ic.test.ts > "misses when the prototype later gains properties"]`, and one
with an identical-looking but different prototype object is rejected outright
`[t: tests/feedback/ic.test.ts > "misses a same-map receiver carrying a different prototype"]` —
the case where two receivers have the *same map id* and different prototypes, which a map-only
cache would answer wrongly and this handler answers correctly.

So the harder claim costs an unbounded walk on construction and a full-chain walk on every hit,
where the positive claim costs three integer comparisons. And what it buys, at the caller, is
nothing:

> **Dead.** `MissingPropertyHandler.execute` (`src/feedback/ic/index.ts:311-313`) returns
> `undefined` and has no caller in `src/`. All three of `PropertyLoadIC.lookup`'s paths test
> `handler.type === "MissingProperty"` and return `{ hit: false, value: undefined }` *instead of*
> calling it (`:611-612`, `:628-629`, `:643-644`), and `_miss` sets `value = undefined` directly
> (`:721-724`). Its only exercise is `tests/feedback/ic.test.ts > "always returns undefined"`.
> More consequentially, `hit: false` means every caller redoes the work: `handleLdaProp` takes
> its `else` branch and runs `getProperty` and, if that misses, `lookupPrototypeChain`
> (`src/bytecode/register/interpreter/handlers.ts:267-277`), which is the same lookup the
> handler exists to avoid. The negative cache is correct, keeps the site out of megamorphic, and
> shortens nothing. Cost to fix: a third result state — `{ cached: true, present: false }` — and
> a matching branch in the four call sites that consume a `LoadLookupResult`.

## Calls and the dependency bridge

`CallIC` is the only class in the file that reaches outside it, and it does so on exactly one
path: a monomorphic call whose handler no longer matches.

```ts
      dependencyRegistry.invalidate(
        DEP_CALL_TARGET,
        entry.targetId,
        entry.targetVersion,
        "call-target-miss",
      );
      if (entry.receiverMapId !== null) {
        dependencyRegistry.invalidate(
          DEP_MAP,
          entry.receiverMapId,
          entry.receiverMapVersion,
          "method-receiver-miss",
        );
      }
```
— `src/feedback/ic/index.ts:1232-1245`

A site that has been calling one function and now sees another has just learned something the
JIT needs: any compiled code that inlined that callee, or that guarded on that receiver map, was
built on an assumption that has stopped holding. `dependencyRegistry.invalidate`
(`src/deopt/dependencies.ts:140-187`) looks the key up, marks every optimized function that
registered it, and either hands it to a lazy marker or stamps `pendingDependencyDeopt` on it.

So **a cache miss in the interpreter can throw away compiled code in the JIT**, and it is the
only route from this file into that one. It fires only from the monomorphic arm — the polymorphic
scan falls through to `_miss` in silence, because a site that is already polymorphic never
promised the JIT a single target in the first place. [Ch 54 § deopt-triggers] picks it up.

`CallHandler.matches` (`:535-552`) is what decides. It recomputes the callee's target id and
version the same way `lookup` did, compares both, compares `argCount`, and then — only if
`receiverMapId` is non-null, i.e. this was recorded as a method call — compares the receiver's
map id and version
`[t: tests/feedback/ic.test.ts > "matches same compiled target with same argCount"]`,
`[t: tests/feedback/ic.test.ts > "misses on different target version"]`. Argument count is part
of the identity because the handler is a promise about a *call shape*, not about a function.

## Two limits

*(Why the obvious design fails.)*

The obvious design is one polymorphic ceiling. A site that has seen too many shapes is a site
worth giving up on, and both the thing that records shapes and the thing that caches them should
agree about where "too many" is. tera has three numbers in two files and no shared symbol:

```ts
const MAX_POLY_ENTRIES = 8;
const MAX_ELEMENT_POLY_ENTRIES = 4;
```
— `src/feedback/ic/index.ts:21-22`

against `MAX_POLYMORPHIC_ENTRIES = 4` in `src/feedback/vector/index.ts:23`
([Ch 33 § four-is-the-limit]). Both are module-private `const`s; neither file imports the
other's; nothing in the tree relates them.

The consequence is a live window. A property site that has seen five, six, seven or eight maps is
still being served by the inline cache — `PropertyLoadIC` keeps a real entry for each and the
polymorphic scan finds them
`[t: tests/feedback/ic.test.ts > "transitions to megamorphic after 8 unique classes"]` — while the
*feedback vector* for the same site went megamorphic at the fifth
`[t: tests/feedback/vector.test.ts > "transitions to megamorphic after >4 unique classes"]`, and
`FeedbackNexus.property` therefore hands the optimizer a `MEGAMORPHIC` hint with no maps in it at
all. The compiler refuses to speculate on a site the interpreter is handling by name.

That split is defensible, and the defence is that the two structures answer different questions.
The IC's cost of one more entry is one more iteration of a linear scan over a small array, paid
only by the sites that are actually polymorphic. The JIT's cost of one more speculated map is a
guard on a path that may be entered from anywhere, plus — if the guard fails — a deoptimization
that abandons the whole compiled function and re-enters the interpreter
([Ch 54 § deoptimizing-out-of-wasm]). Serving a fifth shape adds one iteration to a scan;
guessing a fifth shape puts a whole compiled function at risk. A single shared constant would
have to be wrong for one of the two.

**Nothing in the tree says any of that.** The two constants are private to their files, share no
name, have no comment, and no test asserts a relationship between them. This paragraph is the
argument, not a citation of one, and if someone changes `MAX_POLY_ENTRIES` to 4 tomorrow nothing
will notice. The third constant, `MAX_ELEMENT_POLY_ENTRIES = 4`, matches the vector's number by
coincidence of value rather than by construction
`[t: tests/feedback/ic.test.ts > "transitions to megamorphic after >4 kinds"]`.

## No global invalidation

Collect what has been established. `FieldHandler.matches` re-checks map id, version and
deprecation on every hit. `ProtoLoadFieldHandler.matches` re-checks eight things including a
chain walk. `MissingPropertyHandler.matches` walks the chain to its end. `CallHandler.matches`
recomputes the target id from the callee it was handed. The megamorphic path re-checks and
deletes on failure. And `PropertyLoadIC.lookup` / `PropertyStoreIC.store` invalidate their own
site when they meet a receiver whose map has been deprecated.

Every one of those is a **pull**. Nothing is pushed. There is no edge from a `HiddenClass` to the
caches that depend on it, no callback when a property is added, no epoch counter that
invalidates everything, and no list to walk when a prototype is mutated. The one push that exists
— `dependencyRegistry.invalidate` — goes to *compiled* code, not to caches, and it exists because
compiled code cannot re-check a fact it did not emit a check for.

The price is fixed and it is paid by the hits, not the misses: three comparisons on every cached
own-property load, more on a prototype load. The benefit is that there is no bookkeeping to get
wrong. A new way to mutate an object — a new transition kind, a new host builtin that reshapes a
receiver, a new migration path — cannot make a stale handler answer, because no handler trusts
anything it is not looking at. Correctness does not depend on anyone remembering to register a
dependency, which is exactly the failure mode [Ch 1 § why-the-obvious-design-fails] named in a
different subsystem: *a refinement about mutable state must name what falsifies it*. The IC's
answer is to name nothing and re-derive everything.

The next two sections are what that decision bought: the parts of the file built for a
push-based design, which are still there, and still do nothing.

## The index nobody fills

`InlineCacheManager` carries a reverse index from map id to the set of sites that used it:

```ts
  registerHiddenClassUsage(hiddenClassId: MapId, siteId: SiteId): void {
    let siteIds = this.hiddenClassToICs.get(hiddenClassId);
    if (!siteIds) {
      siteIds = new Set();
      this.hiddenClassToICs.set(hiddenClassId, siteIds);
    }
    siteIds.add(siteId);
  }
```
— `src/feedback/ic/index.ts:1448-1455`

`invalidateForHiddenClass` (`:1457-1471`) reads it, invalidates each named site, and returns a
count. `invalidateDeprecatedMaps` (`:1473-1494`) iterates it, tests `isMapDeprecated(hcId)`, and
invalidates and logs. Both are complete, correct, push-based invalidation. Both operate on an
empty map.

> **Never runs.** `InlineCacheManager.registerHiddenClassUsage`
> (`src/feedback/ic/index.ts:1448-1455`) is the only writer of `hiddenClassToICs`, and it has no
> caller in `src/` or `tools/` — only `tests/feedback/ic.test.ts:557-564`. Consequently
> `invalidateForHiddenClass` always returns 0 and `invalidateDeprecatedMaps` always iterates
> nothing. Cost to finish: a call from every `getOrCreate` hit site — the four interpreter
> handlers and `BaselineRuntime`'s five — plus a policy for removing entries when a site is
> invalidated, or the index grows for the life of the process.
>
> `[t: tests/feedback/ic.test.ts > "registerHiddenClassUsage and invalidateForHiddenClass"]` is
> the only exercise the path gets anywhere, and it is why this can be stated as fact rather than
> as suspicion: the mechanism works, and nothing uses it.

> **Never runs.** `Engine.runAgingCycle` (`src/api/engine.ts:1948-1957`), the only caller of
> `icManager.invalidateDeprecatedMaps` in the tree, has no caller in `src/`, `tests/` or
> `tools/`. It collects the program's functions, ages their optimized code, and then sweeps the
> IC manager. Code aging is present and unscheduled. Cost to finish: a trigger — a timer, an
> allocation threshold, or a tiering-policy hook — and a decision about what "idle" means in a
> process that may run for eight milliseconds.

> **Never runs.** `InlineCacheManager.collectStats` (`:1502-1539`), `reportPolymorphism`
> (`:1541-1562`) and `getJitCandidates` (`:1564-1576`), and `PropertyLoadIC.getSortedHandlers`
> (`:764-767`), `getDominantHandler` (`:769-782`) and `getPolymorphicProfile` (`:784-796`), have
> no caller in `src/`. `--stats` reports the *tracer's* counters — `ic_transitions` and
> `ic_hits`, incremented inside `tracer.icEvent` and `tracer.icHit` — and not one of these.
> `DOMINANT_HANDLER_RATIO = 0.8` (`:24`) exists solely for `getDominantHandler`, whose consumer
> was never written. Cost to finish: a `--stats` section that calls `collectStats`, which is
> perhaps twenty lines and a decision about what a reader would do with the numbers.

> **Never runs.** `PropertySiteInlineCache.isSettled` (`:442-447`) and
> `SETTLED_CALL_THRESHOLD = 100` (`:25`) have no reader anywhere.
> `MONOMORPHIC_JIT_THRESHOLD = 100` (`:23`) sets `jitCandidate`, which is read only by
> `getStats`, which is read only by `collectStats`, which nothing calls — so the flag the
> hundred-hit counter exists to raise is observable only from a test. Cost to finish: a
> consumer for both — a tiering-policy hook that treats a settled call site or a
> hundred-hit monomorphic load site as evidence — which is a decision about policy
> ([Ch 35 § the-two-policies]) rather than about this file. Cost to remove: four lines and
> two constants.

The design still works. § no-global-invalidation never needed any of it.

## Elements do not specialize

The second honest coda is smaller and more surprising. `ElementLoadIC` and `ElementStoreIC` key
their entries by `elementsKind` — `PACKED_SMI`, `PACKED_DOUBLE`, `HOLEY_TAGGED` and the rest of
the six-point lattice from [Ch 23 § elements-kinds-six-points-and-a-one-way-join] — and transition through the same four states
on distinct kinds
`[t: tests/feedback/ic.test.ts > "transitions through states on different element kinds"]`. The
handlers those entries hold are these, in full:

```ts
  execute(arrayObj: ICArray, index: number): ICValue {
    return arrayObj.getIndex(index);
  }
```
— `src/feedback/ic/index.ts:564-566`

```ts
  execute(arrayObj: ICArray, index: number, value: TaggedValue): void {
    arrayObj.setIndex(index, value);
  }
```
— `src/feedback/ic/index.ts:578-580`

Whatever kind the handler carries, it calls the generic accessor. Neither class has a `matches`
method; the kind is used to *key* the entry and to drive the lattice, and it selects no code at
all. A `PACKED_DOUBLE` load and a `HOLEY_TAGGED` load run the same line.

> **Unfinished.** `LoadElementHandler` and `StoreElementHandler`
> (`src/feedback/ic/index.ts:555-581`) carry an `elementsKind` that neither `execute` reads.
> Specializing them means either one handler class per kind or a kind-indexed dispatch, plus a
> measurement to justify it — and there is no benchmark harness in this tree
> (`docs/CONVENTIONS.md` rule 9), so the honest statement is that the specialization is absent
> and its value is unknown, not that it would be faster.

The elements-kind speculation that matters is not here. It happens in the JIT, from the feedback
vector's `elementsKindCounts`, and it is `docs/example/stats-deopt.tera`'s subject: a site that
records `PACKED_DOUBLE`, gets compiled against that assumption, and then meets an array that has
widened. [Ch 54] runs it.

Two smaller things in the same file are worth writing down, because both make the trace lie.

> **Broken.** The `--trace-ic` line for an element access reports a map that is not a map.
> `ElementSiteInlineCache._addEntry` (`src/feedback/ic/index.ts:402-423`) and
> `ElementLoadIC.lookup` (`:1048-1087`) pass `kindTraceId(elementsKind)` — a hash of the *kind
> name* — into `tracer.icEvent`/`tracer.icHit`'s `mapId` parameter, which formats it as
> `map=HC${mapId}`. So `stats.tera` prints
> `[IC] Site #7653696: HIT monomorphic-element-load (map=HC2930259320)`, and `2930259320` is
> `kindTraceId("PACKED_DOUBLE")`, not a hidden class. This is the same defect as
> [Ch 33]'s `Slot #0`, in the same tracer, from the other direction: a parameter typed `number`
> that two different kinds of identifier are squeezed into. Cost to fix: a separate tracer method
> for element events, or a label parameter.

> **Broken.** `ElementLoadIC._miss` (`src/feedback/ic/index.ts:1090-1096`) increments
> `missCount` and returns `{ hit: true, value }`; the megamorphic arm of `lookup` increments
> `missCount` and then calls `tracer.icHit` (`:1076-1079`). So the element caches' own
> `hitCount`/`missCount` and the `ic_hits` counter that `--stats` prints disagree about the same
> event, in opposite directions. Nothing reads `hitCount` except `getStats`, which nothing calls
> (above), so the damage is confined to the trace. Cost to fix: one line each, once someone
> decides whether a miss that still answers correctly is a hit.

## What leaves

An `InlineCacheManager` holding one `InlineCache` per site key `funcName#fnId:slot`, each a
five-way bundle — load, store, element-load, element-store, call — over a shared
`MegamorphicCache`, whose entries are handlers that answer `matches(obj)` and `execute(obj)` and
that re-verify everything they assumed on every hit. Nine sites for `stats.tera`, all
monomorphic; fourteen for `stats-poly.tera`, one of which goes polymorphic.

The optimizer does not read any of it. It reads the vector [Ch 33 § the-nexus]. What leaves for
the *program* is that the second and later executions of a property site take the cached value
instead of `getProperty` and `lookupPrototypeChain` — though the site still pays a
`hiddenClass.lookupProperty` on every one of them, because the feedback recorder beside it is
unconditional ([Ch 33 § the-property-exception]); what leaves for the *book* is one edge into
the compiled world —
`dependencyRegistry.invalidate(DEP_CALL_TARGET, …)` on a monomorphic call miss, and
`DEP_PROTO_VALIDITY` from `invalidatePrototypeDependents` — which is how a cache miss in the
interpreter becomes a deoptimization in the JIT. [Ch 54 § deopt-triggers] takes both.

And one rule that outlives the file. **A cached fact must carry its own falsification.** Not a
registry of who to tell, not an epoch anyone must remember to bump — the fact itself, re-derived
and re-checked on every use. The prototype handlers are what that costs when the fact is
not local: eight checks and a chain walk, because three things can change and none of them will
call you. [Ch 35 § one-hook-two-jobs] is the next chapter, and it is about the other thing
the interpreter does on every back edge for someone else's benefit: deciding whether this
function is hot enough to leave.

## Verify it yourself

```bash
# Nine transitions, thirty hits, all monomorphic. The site numbers are hashed keys.
node dist/cli.js --trace-ic docs/example/stats.tera

# The transitions alone: nine uninitialized -> monomorphic and nothing else.
node dist/cli.js --trace-ic docs/example/stats.tera 2>&1 | grep -v HIT

# A second class with the same member names. Fifteen transitions, one of them
# monomorphic -> polymorphic on site #2944030887 = report#2:0:load, the s.label load.
node dist/cli.js --trace-ic docs/example/stats-poly.tera 2>&1 | grep -v HIT

# The same two numbers from the other instrument: ic_transitions 9 / 15, ic_hits 30 / 30.
node dist/cli.js --stats docs/example/stats.tera
node dist/cli.js --stats docs/example/stats-poly.tera

# Resolve a site number back to its key. The hash is multiply-by-31 over funcName#fnId:slot.
node -e 'const h=s=>{let x=0;for(let i=0;i<s.length;i++)x=(x*31+s.charCodeAt(i))|0;return x>>>0};
console.log(h("report#2:0:load"), h("mean#4:0:load"), h("PACKED_DOUBLE"))'

# The handlers, the chain walk and the state machines: 60 tests.
npx vitest run --project unit tests/feedback/ic.test.ts

# The maps those handlers are checking: 41 tests.
npx vitest run --project unit tests/objects/maps/hidden-class.test.ts
```

`--trace-ic docs/example/stats.tera` prints 39 `[IC]` lines: nine transitions and thirty hits.
`stats-poly.tera` prints 45: fifteen transitions and thirty hits. The `node -e` line prints
`2944030887 2846148340 2930259320` — the first two are the site keys quoted throughout this
chapter, and the third is the number the element-load trace prints as `map=HC2930259320`. The two
test files report `Tests 60 passed (60)` and `Tests 41 passed (41)`.

The centrepiece cannot be reproduced from the command line, and this chapter will not pretend
otherwise: `stats-poly.tera` has no shared prototype that changes underneath a receiver, so
nothing in the example set drives `ProtoLoadFieldHandler` or `MissingPropertyHandler` to a miss.
Both are demonstrated from `tests/feedback/ic.test.ts` instead, which constructs receivers with
the same map id and different prototype objects directly — the case the identity comparison in
`protoChainMatches` exists for.

> **Unenforced.** Nothing checks that a site key is used with only one kind of access.
> `getICKey` is a string concatenation, and `handleLdaIndex` deliberately substitutes slot `0`
> when a `ROP_LDA_INDEX` was emitted without a feedback slot
> ([Ch 33 § the-slot-that-was-never-allocated]), so a `for ... in` element load and an unrelated
> property load can land on the same `InlineCache` bundle. They use different sub-caches inside
> it, so it is currently harmless; nothing makes it stay harmless, and nothing would report it if
> it stopped being. Cost to enforce: give the bundle the kind it was created for and assert on
> mismatch, which needs the per-opcode operand table [Ch 33] also asked for. [unpinned]

## Tests that pin this

- `tests/feedback/ic.test.ts` > `"misses a same-map receiver carrying a different prototype"`
  — the centrepiece: two receivers with the same map id and different prototype objects, which a
  map-only cache answers wrongly.
- `tests/feedback/ic.test.ts` > `"misses when the prototype later gains properties"`
  — the `requireEnd` case for absence: the chain changed under a cached "not here".
- `tests/feedback/ic.test.ts` > `"misses a same-map receiver whose prototype differs"`
  — the same identity comparison, through `ProtoLoadFieldHandler`.
- `tests/feedback/ic.test.ts` > `"misses when an intermediate prototype link is replaced"`
  — why `protoChainMatches` walks every link rather than checking the owner.
- `tests/feedback/ic.test.ts` > `"misses when proto validity version changes"`
  — the shared `prototypeValidityCell` doing its job.
- `tests/feedback/ic.test.ts` > `"misses when proto deprecated"`
  — the eighth check in `ProtoLoadFieldHandler.matches`.
- `tests/feedback/ic.test.ts` > `"matches when hcId, version match and not deprecated"`,
  > `"misses on different version"`, > `"misses on deprecated"`
  — the three-comparison base case, one test per comparison.
- `tests/feedback/ic.test.ts` > `"always returns undefined"`
  — `MissingPropertyHandler.execute`, and its only exercise anywhere.
- `tests/feedback/ic.test.ts` > `"transitions uninitialized -> monomorphic -> polymorphic on different objects"`
  — that a *second* map transitions immediately, before the entry list is full.
- `tests/feedback/ic.test.ts` > `"transitions to megamorphic after 8 unique classes"`
  — `MAX_POLY_ENTRIES = 8`, the number the feedback vector disagrees with.
- `tests/feedback/ic.test.ts` > `"returns missing property as hit:false, value:undefined"`
  — the cache hit that reports a lookup failure.
- `tests/feedback/ic.test.ts` > `"becomes JIT candidate after 100 monomorphic hits"`
  — `MONOMORPHIC_JIT_THRESHOLD`, whose flag nothing in `src/` reads.
- `tests/feedback/ic.test.ts` > `"handles deprecated map by invalidating"`
  — the only invalidation that runs during ordinary execution.
- `tests/feedback/ic.test.ts` > `"transitions through states on different element kinds"` and
  > `"transitions to megamorphic after >4 kinds"`
  — `MAX_ELEMENT_POLY_ENTRIES = 4`, and that the kind drives the lattice.
- `tests/feedback/ic.test.ts` > `"matches same compiled target with same argCount"` and
  > `"misses on different target version"`
  — `CallHandler`'s identity: target, version and call shape.
- `tests/feedback/ic.test.ts` > `"transitions to polymorphic on different callee"`
  — the state change that stops the dependency bridge firing again.
- `tests/feedback/ic.test.ts` > `"registerHiddenClassUsage and invalidateForHiddenClass"`
  — the only exercise the manager-level invalidation path gets, and the reason
  § the-index-nobody-fills is fact rather than suspicion.
- `tests/feedback/ic.test.ts` > `"delegates to sub-ICs"` and > `"invalidate resets all sub-ICs"`
  — the five-way bundle, and that resetting one site resets all five.
- `tests/objects/maps/hidden-class.test.ts` — 41 tests over the ids, versions, deprecation flags
  and prototype transitions every `matches()` in this chapter compares against.
- That `MAX_POLY_ENTRIES = 8` and `MAX_POLYMORPHIC_ENTRIES = 4` are *deliberately* different is
  `[unpinned]`. Both values are pinned individually; no test, constraint or comment relates them.
- That a cache miss in the interpreter deoptimizes compiled code is pinned in [Ch 54], not here:
  no test in `tests/feedback/` observes `dependencyRegistry` at all. `[unpinned]` for this
  chapter.
