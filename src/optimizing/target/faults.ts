export const TERA_EXIT_HEAP_EXHAUSTED = 70;
export const TERA_EXIT_UNCAUGHT_THROW = 1;
export const TERA_UNCAUGHT_PREFIX = "Uncaught ";
export const TERA_REJECTED_PREFIX = "(in promise) ";
export const TERA_REJECTED_SEPARATOR = `\n${TERA_UNCAUGHT_PREFIX}${TERA_REJECTED_PREFIX}`;
export const TERA_NEVER_SETTLED = "awaited a promise that never settled";
export const TERA_TEXT_OVERFLOW =
  "a string outgrew the space reserved for it: a string a function builds grows with " +
  "--text-size, while a string kept in a field is bounded by that field";
