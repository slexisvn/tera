export const COMPOUND_ASSIGN_OPERATORS = [
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
  "**=",
] as const;

export const BINARY_OPERATORS = [
  "==",
  "!=",
  "===",
  "!==",
  "<",
  ">",
  "<=",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "@",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "**",
  "instanceof",
  "in",
] as const;

const LOGICAL_OPERATORS = ["&&", "||", "??"] as const;
const UPDATE_OPERATORS = ["++", "--"] as const;
const STRUCTURAL_PUNCTUATORS = ["...", "?.", "=>", "->"] as const;

export const SINGLE_CHAR_PUNCTUATORS: ReadonlySet<string> = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "=",
  ".",
  ",",
  ";",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ":",
  "?",
  "@",
  "&",
  "|",
  "^",
  "~",
]);

const PUNCTUATOR_SPELLINGS: readonly string[] = [
  ...COMPOUND_ASSIGN_OPERATORS,
  ...BINARY_OPERATORS,
  ...LOGICAL_OPERATORS,
  ...UPDATE_OPERATORS,
  ...STRUCTURAL_PUNCTUATORS,
];

export const MULTI_CHAR_PUNCTUATORS: readonly string[] = [
  ...new Set(PUNCTUATOR_SPELLINGS.filter((spelling) => spelling.length > 1)),
]
  .filter((spelling) => /^[^\w\s]+$/.test(spelling))
  .sort((left, right) => right.length - left.length);
