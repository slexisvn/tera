# Part IV — The bytecode runs   ⟨I · B · J · N⟩

> **Status:** outline

**What arrived.** A `RegisterCompiledFunction` per function — instructions, constants,
`registerCount`, `paramCount`, `localNames`, `uninitializedLocalSlots`, an unallocated
`feedbackVector` — produced by Part III and disassembled by `node dist/cli.js
--print-bytecode`.

**What leaves.** Three artifacts, and every later part depends on all three:

1. **An answer.** `latency mean=15.70 / throughput mean=898.19`, produced with no
   compilation at all. This is the oracle the other three tiers are checked against —
   `tests/e2e/helpers/tiers.ts`'s `differential(...)` compares tier results to it, and
   [Ch 78 § differential] turns that into the book's correctness argument.
2. **Feedback.** Filled `FeedbackSlot`s and warm `InlineCacheManager` entries carrying
   `(mapId, version, offset, protoDepth)`. Part V ([Ch 33], [Ch 34]) reads them; the
   optimizer in Part VII speculates on them; [Ch 54] deoptimizes when they lie.
3. **A tier verdict.** `requiresInterpreterOnly(compiledFn)` — one `Set` membership test
   over the instruction stream — decides, for the life of the process, whether a function
   may ever reach baseline or the JIT at all.

## What this stage owes everything downstream

- **The value representation.** Every tier that runs *inside this process* — interpreter,
  baseline, JIT — passes the same `TaggedValue`: a JavaScript number with a four-bit type
  code in its low nibble. The native compiler does not; that divergence is where Part IX's
  refusals come from, and it starts here.
- **The object model.** A `HiddenClass` transition tree with the prototype baked into map
  identity, a flat `slots` array, and a six-point elements-kind lattice. An IC's whole
  claim is "this map, this offset"; if maps were not shared, no IC would ever hit.
- **One answer per value kind.** `MEMBER_LOOKUPS` in `src/runtime/member-lookup.ts` is a
  dense jump table indexed by tag code. Three tiers call it. Without it, `x.length` would
  have three implementations and would eventually give three answers.
- **The root set.** `visitFrameRoots` is the *definition* of what survives a collection.
  Every generated-code tier that invents a place to keep a value — a baseline JavaScript
  local, a wasm linear-memory offset — has to export it, or the value is swept and the
  program prints a wrong number instead of crashing.
- **The extension surface.** `EngineOptions`, `TeraExtension`, `TeraCompilerExtension`.
  A plug-in that adds a function is easy; one that teaches the optimizer the function is
  pure — so eight calls become fewer than eight — is the real test, and it is met here.

## Which tiers each chapter constrains

| Ch | Title | Tiers |
| --- | --- | --- |
| 21 | The dispatch loop | ⟨I⟩ |
| 22 | Values: four bits inside a double | ⟨I · B · J⟩ |
| 23 | Objects: hidden classes and elements kinds | ⟨I · B · J⟩ |
| 24 | Property access, end to end | ⟨I · B⟩ |
| 25 | One Answer Per Value Kind | ⟨I · B · J⟩ (N mirrors the names only) |
| 26 | Indexing, classes, and the objects that are not objects | ⟨I · B · J · N⟩ |
| 27 | Exceptions, iteration, and the opcodes that pin a function to tier zero | ⟨I · B · J⟩ |
| 28 | What the program calls | ⟨I · B · J · N⟩ |
| 29 | The Engine and its extension points | ⟨I · B · J · N⟩ |
| 30 | Async at run time | ⟨I⟩ |
| 31 | Two heaps, two collectors | ⟨I · B · J⟩ |
| 32 | What is a root | ⟨I · B · J⟩ |

Chapters 21, 24 and 30 constrain the interpreter alone because their machinery is
literally unavailable elsewhere: `ROP_AWAIT`, `ROP_TRY_START`, `ROP_TRY_END`, `ROP_THROW`
and the iterator opcodes are all in `INTERPRETER_ONLY_OPS`
(`src/bytecode/register/interpreter/helpers.ts:67-80`), so a function containing one never
leaves tier zero. Chapter 27 explains why that set is not the disaster it looks like.

## What the running example cannot reach here

`docs/example/stats.tera` allocates two `Series` instances, two `float[]` arrays and a
handful of strings. It therefore never touches:

- the generational scavenger (`--stats` reports `"minorGCCount": 0` for it),
- the store barrier or the remembered set,
- proxies, `WeakMap`, `Map`, `Set`, symbols, or getters and setters,
- deoptimization (that needs `stats-deopt.tera`),
- promises and the microtask queue (that needs `stats-async.tera`).

Chapters 26, 30, 31 and 32 say so in their openers and reach for a variation or for a
purpose-built probe rather than contriving a ninth spine file.

## The chapters

- [21. The dispatch loop](21-the-dispatch-loop.md)
- [22. Values: four bits inside a double](22-values-four-bits-inside-a-double.md)
- [23. Objects: hidden classes and elements kinds](23-objects-hidden-classes-and-elements-kinds.md)
- [24. Property access, end to end](24-property-access-end-to-end.md)
- [25. One Answer Per Value Kind](25-one-answer-per-value-kind.md)
- [26. Indexing, classes, and the objects that are not objects](26-indexing-classes-and-the-objects-that-are.md)
- [27. Exceptions, iteration, and the eleven opcodes that pin a function to tier zero](27-exceptions-iteration-and-the-eleven-opcodes-that.md)
- [28. What the program calls: builtins, the host bridge, and four other compilers](28-what-the-program-calls-builtins-the-host.md)
- [29. The Engine and its extension points](29-the-engine-and-its-extension-points.md)
- [30. Async at run time: promises, microtasks, and a suspended frame](30-async-at-run-time-promises-microtasks-and.md)
- [31. Two heaps, two collectors](31-two-heaps-two-collectors.md)
- [32. What is a root](32-what-is-a-root.md)

## Verify it yourself

```bash
node dist/cli.js docs/example/stats.tera
node dist/cli.js --print-bytecode --filter mean docs/example/stats.tera
node dist/cli.js --trace docs/example/stats.tera | grep '^\[INTERP\] mean' | head -32
node dist/cli.js --stats docs/example/stats.tera | tail -16
```
