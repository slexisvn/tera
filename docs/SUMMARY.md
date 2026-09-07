# Summary

[The tera engine](README.md)
[Conventions](CONVENTIONS.md)
[Glossary](GLOSSARY.md)
[The running example](example/README.md)

---

# Part 0 — The Program

- [About this part](part-00-the-program/_part.md)
- [1. Two Answers, One Program](part-00-the-program/01-two-answers-one-program.md)
- [2. What tera looks like](part-00-the-program/02-what-tera-looks-like.md)
- [3. One program, fourteen forms](part-00-the-program/03-one-program-fourteen-forms.md)

---

# Part I — Text becomes a tree

- [About this part](part-01-text-to-tree/_part.md)
- [4. Characters to tokens](part-01-text-to-tree/04-characters-to-tokens.md)
- [5. The Program That Indents But Does Not Nest](part-01-text-to-tree/05-the-program-that-indents-but-does-not.md)
- [6. `if (x) (y)(z)` Parses Wrong, and a Bigger Parser Will Not Save You](part-01-text-to-tree/06-if-x-y-z-parses-wrong-and.md)
- [7. The shape of the tree](part-01-text-to-tree/07-the-shape-of-the-tree.md)

---

# Part II — The tree acquires meaning

- [About this part](part-02-meaning/_part.md)
- [8. Thirteen node kinds and one boundary flag](part-02-meaning/08-thirteen-node-kinds-and-one-boundary-flag.md)
- [9. Types are text](part-02-meaning/09-types-are-text.md)
- [10. The lattice](part-02-meaning/10-the-lattice.md)
- [11. Inference without Hindley-Milner](part-02-meaning/11-inference-without-hindley-milner.md)
- [12. Classes without nominality](part-02-meaning/12-classes-without-nominality.md)
- [13. `q.shift()` Under a Guard: Proving a Partial Operation Total](part-02-meaning/13-q-shift-under-a-guard-proving-a.md)
- [14. Async, and the await you never wrote](part-02-meaning/14-async-and-the-await-you-never-wrote.md)
- [15. Modules: two graphs, not one](part-02-meaning/15-modules-two-graphs-not-one.md)
- [16. Warnings as Errors: The Day the AOT Gate Flipped](part-02-meaning/16-warnings-as-errors-the-day-the-aot.md)

---

# Part III — The tree becomes bytecode

- [About this part](part-03-bytecode/_part.md)
- [17. Why a register machine, and which one](part-03-bytecode/17-why-a-register-machine-and-which-one.md)
- [18. Compiling expressions: the accumulator protocol](part-03-bytecode/18-compiling-expressions-the-accumulator-protocol.md)
- [19. The Jump Nobody Patched](part-03-bytecode/19-the-jump-nobody-patched.md)
- [20. Scopes, closures, and classes in bytecode](part-03-bytecode/20-scopes-closures-and-classes-in-bytecode.md)

---

# Part IV — The bytecode runs

- [About this part](part-04-execution/_part.md)
- [21. The dispatch loop](part-04-execution/21-the-dispatch-loop.md)
- [22. Values: four bits inside a double](part-04-execution/22-values-four-bits-inside-a-double.md)
- [23. Objects: hidden classes and elements kinds](part-04-execution/23-objects-hidden-classes-and-elements-kinds.md)
- [24. Property access, end to end](part-04-execution/24-property-access-end-to-end.md)
- [25. One Answer Per Value Kind](part-04-execution/25-one-answer-per-value-kind.md)
- [26. Indexing, classes, and the objects that are not objects](part-04-execution/26-indexing-classes-and-the-objects-that-are.md)
- [27. Exceptions, iteration, and the eleven opcodes that pin a function to tier zero](part-04-execution/27-exceptions-iteration-and-the-eleven-opcodes-that.md)
- [28. What the program calls: builtins, the host bridge, and four other compilers](part-04-execution/28-what-the-program-calls-builtins-the-host.md)
- [29. The Engine and its extension points](part-04-execution/29-the-engine-and-its-extension-points.md)
- [30. Async at run time: promises, microtasks, and a suspended frame](part-04-execution/30-async-at-run-time-promises-microtasks-and.md)
- [31. Two heaps, two collectors](part-04-execution/31-two-heaps-two-collectors.md)
- [32. What is a root](part-04-execution/32-what-is-a-root.md)

---

# Part V — The program gets hot

- [About this part](part-05-getting-hot/_part.md)
- [33. Feedback: what the interpreter learns](part-05-getting-hot/33-feedback-what-the-interpreter-learns.md)
- [34. Inline caches](part-05-getting-hot/34-inline-caches.md)
- [35. Back edges: safepoints, budgets, and the tiering policy](part-05-getting-hot/35-back-edges-safepoints-budgets-and-the-tiering.md)
- [36. The baseline compiler](part-05-getting-hot/36-the-baseline-compiler.md)
- [37. On-stack replacement](part-05-getting-hot/37-on-stack-replacement.md)

---

# Part VI — Bytecode becomes SSA

- [About this part](part-06-ssa/_part.md)
- [38. A control-flow graph, not a sea of nodes](part-06-ssa/38-a-control-flow-graph-not-a-sea.md)
- [39. Building SSA from bytecode](part-06-ssa/39-building-ssa-from-bytecode.md)
- [40. Frame states: describing a frame you no longer have](part-06-ssa/40-frame-states-describing-a-frame-you-no.md)

---

# Part VII — The graph is optimized

- [About this part](part-07-optimization/_part.md)
- [41. The pass manager](part-07-optimization/41-the-pass-manager.md)
- [42. The analyses everything stands on](part-07-optimization/42-the-analyses-everything-stands-on.md)
- [43. SCCP](part-07-optimization/43-sccp.md)
- [44. GVN-PRE](part-07-optimization/44-gvn-pre.md)
- [45. Memory: what a load can be told, and an object that stops existing](part-07-optimization/45-memory-what-a-load-can-be-told.md)
- [46. Loops, and the Optimization That Cannot Fire](part-07-optimization/46-loops-and-the-optimization-that-cannot-fire.md)
- [47. Simplification, dead code, and the identities that are wrong](part-07-optimization/47-simplification-dead-code-and-the-identities-that.md)
- [48. Types and representations in the middle end](part-07-optimization/48-types-and-representations-in-the-middle-end.md)
- [49. Speculative Types Are Not Facts](part-07-optimization/49-speculative-types-are-not-facts.md)
- [50. Inlining and tail calls](part-07-optimization/50-inlining-and-tail-calls.md)

---

# Part VIII — The graph becomes WebAssembly

- [About this part](part-08-wasm/_part.md)
- [51. Legalizing for a target](part-08-wasm/51-legalizing-for-a-target.md)
- [52. Emitting WebAssembly by hand](part-08-wasm/52-emitting-webassembly-by-hand.md)
- [53. The boundary is the wall](part-08-wasm/53-the-boundary-is-the-wall.md)
- [54. Deoptimizing out of wasm, and when the JIT says no](part-08-wasm/54-deoptimizing-out-of-wasm-and-when-the.md)

---

# Part IX — The other road: ahead of time

- [About this part](part-09-ahead-of-time/_part.md)
- [55. The same graph, with no way out](part-09-ahead-of-time/55-the-same-graph-with-no-way-out.md)
- [56. Legality, and the art of refusing well](part-09-ahead-of-time/56-legality-and-the-art-of-refusing-well.md)
- [57. Objects without a runtime type](part-09-ahead-of-time/57-objects-without-a-runtime-type.md)
- [58. Making the program static](part-09-ahead-of-time/58-making-the-program-static.md)
- [59. Strings without a runtime tag](part-09-ahead-of-time/59-strings-without-a-runtime-tag.md)
- [60. A runtime written in its own language](part-09-ahead-of-time/60-a-runtime-written-in-its-own-language.md)
- [61. The arena, the shadow stack, and why nothing moves](part-09-ahead-of-time/61-the-arena-the-shadow-stack-and-why.md)
- [62. Generations Without Moving](part-09-ahead-of-time/62-generations-without-moving.md)
- [63. The event loop, and a rejection nobody awaited](part-09-ahead-of-time/63-the-event-loop-and-a-rejection-nobody.md)

---

# Part X — The graph becomes bytes

- [About this part](part-10-bytes/_part.md)
- [64. MachineIR and instruction selection](part-10-bytes/64-machineir-and-instruction-selection.md)
- [65. The Branch in the Middle of a Block](part-10-bytes/65-the-branch-in-the-middle-of-a.md)
- [66. Linear scan register allocation](part-10-bytes/66-linear-scan-register-allocation.md)
- [67. Splitting: A Feature That Was Measured and Left Off](part-10-bytes/67-splitting-a-feature-that-was-measured-and.md)
- [68. Frames, prologues, and two ABIs](part-10-bytes/68-frames-prologues-and-two-abis.md)
- [69. The assembler](part-10-bytes/69-the-assembler.md)
- [70. Object files and self-linked executables](part-10-bytes/70-object-files-and-self-linked-executables.md)
- [71. Telling the debugger and the unwinder](part-10-bytes/71-telling-the-debugger-and-the-unwinder.md)

---

# Part XI — Two controls

- [About this part](part-11-two-controls/_part.md)
- [72. Two Controls: riscv64 and C](part-11-two-controls/72-two-controls-riscv64-and-c.md)

---

# Part XII — Watching the program

- [About this part](part-12-watching/_part.md)
- [73. The shell: a CLI as instrument](part-12-watching/73-the-shell-a-cli-as-instrument.md)
- [74. The REPL](part-12-watching/74-the-repl.md)
- [75. The debugger](part-12-watching/75-the-debugger.md)
- [76. The visualizer: replaying every pass](part-12-watching/76-the-visualizer-replaying-every-pass.md)
- [77. Bisecting Your Own Compiler](part-12-watching/77-bisecting-your-own-compiler.md)
- [78. Verifiers Everywhere](part-12-watching/78-verifiers-everywhere.md)
- [79. How we know any of this is true](part-12-watching/79-how-we-know-any-of-this-is.md)

---

# Part XIII — Agreement, refusal, and honest state

- [About this part](part-13-agreement/_part.md)
- [80. The Agreement Contract](part-13-agreement/80-the-agreement-contract.md)
- [81. Refusal as a First-Class Answer](part-13-agreement/81-refusal-as-a-first-class-answer.md)
- [82. The inventory: dead, broken, unfinished, measured worse, never runs](part-13-agreement/82-the-inventory-dead-broken-unfinished-measured-worse.md)
- [83. Epilogue: the same program, four ways](part-13-agreement/83-epilogue-the-same-program-four-ways.md)

---

# Appendices

- [A. Opcode table](appendix/a-opcode-table.md)
- [B. IR operations](appendix/b-ir-operations.md)
- [C. Refusals](appendix/c-refusals.md)
- [D. Inventory: dead, broken, unfinished](appendix/d-inventory.md)
- [E. File map](appendix/e-file-map.md)
- [F. Reading this repo](appendix/f-reading-this-repo.md)
