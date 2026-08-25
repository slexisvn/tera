export type LabFixture = {
  readonly id: string;
  readonly label: string;
  readonly pass: string;
  readonly expect: string;
  readonly text: string;
};

export const LAB_FIXTURES: readonly LabFixture[] = [
  {
    id: "foldable",
    label: "Constant sum",
    pass: "sccp",
    expect: "the add collapses into Constant [value=42]",
    text: `fn folds params=0 {
  B0 succs= preds=:
    v0 = Constant [value=20]
    v1 = Constant [value=22]
    v2 = Int32Add v0, v1
    v3 = Return v2
}
`,
  },
  {
    id: "dead-value",
    label: "Value nobody reads",
    pass: "dead-code-elimination",
    expect: "v3 disappears, everything the return needs stays",
    text: `fn dead params=1 {
  v0 = Parameter [index=0]
  B0 succs= preds=:
    v1 = Constant [value=7]
    v2 = Int32Add v0, v1
    v3 = Int32Mul v0, v0
    v4 = Return v2
}
`,
  },
  {
    id: "dominated-check",
    label: "Check a dominator already made",
    pass: "redundant-checks",
    expect: "v3 goes away and the return reads v1 instead",
    text: `fn checks params=1 {
  v0 = Parameter [index=0]
  B0 succs=B1 preds=:
    v1 = CheckSmi v0 !fs
    v2 = Jump [targetBlock=1]
  B1 succs= preds=B0:
    v3 = CheckSmi v0 !fs
    v4 = Return v3
}
`,
  },
  {
    id: "common-subexpression",
    label: "Two identical adds",
    pass: "gvn",
    expect: "the second add is replaced by the first",
    text: `fn twice params=2 {
  v0 = Parameter [index=0]
  v1 = Parameter [index=1]
  B0 succs= preds=:
    v2 = Int32Add v0, v1
    v3 = Int32Add v0, v1
    v4 = Int32Mul v2, v3
    v5 = Return v4
}
`,
  },
];
