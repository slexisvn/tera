import {
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_PARAMETER,
  IR_PHI,
  IR_CONSTANT,
  IR_RETURN,
  IR_JUMP,
  IR_BRANCH,
  IR_NEG,
  IR_SELECT,
  IR_NOT,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_MUL,
  IR_FLOAT64_DIV,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_INT32_AND,
  IR_INT32_OR,
  IR_INT32_XOR,
  IR_INT32_NOT,
  IR_INT32_SHL,
  IR_INT32_SHR,
  IR_INT32_USHR,
  IR_INT32_COMPARE,
  IR_FLOAT64_COMPARE,
  IR_CALL_KNOWN_FUNCTION,
  IR_LOAD_FIELD,
  IR_LOAD_TEXT,
  IR_NEW_OBJECT,
  IR_RUNTIME_BASE,
  IR_STORE_FIELD,
  IR_STORE_TEXT,
  allocationShapeOf,
  fieldOffsetOf,
  fieldScalarOf,
  heapElementScalarOf,
  textCapacityOf,
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_GENERIC_ADD,
  IR_GENERIC_CALL,
  IR_GENERIC_COMPARE,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_ARRAY_RESERVE,
  IR_CALL_BUILTIN,
  IR_LOAD_GLOBAL,
  arrayReserveOf,
} from "../../ir/index.js";
import { buildDispatch } from "../../infra/dispatch.js";
import {
  PROT_NONE,
  PROT_READ_WRITE,
  WINDOWS_MEM_COMMIT,
  WINDOWS_MEM_RESERVE,
  WINDOWS_PAGE_READWRITE,
} from "../../target/syscalls.js";
import {
  TERA_ALLOC_SYMBOL,
  TERA_CLASS_RECORD,
  TERA_COLLECT_SYMBOL,
  TERA_CONTEXT,
  TERA_FREE_SHAPE_ID,
  TERA_LINK_BYTES,
  TERA_GROW_SYMBOL,
  TERA_RESERVE_SYMBOL,
  TERA_HEAP_COMMIT_BYTES,
  TERA_HEAP_RESERVE_BYTES,
  TERA_MARK_FLAG,
  TERA_MARKS,
  TERA_BLOCK_FLAGS,
  TERA_MINOR_SYMBOL,
  TERA_OLD_FLAG,
  TERA_REMEMBERED,
  TERA_REMEMBERED_CAPACITY,
  TERA_BARRIER_SYMBOL,
  TERA_REMEMBERED_FLAG,
  TERA_YOUNG,
  TERA_YOUNG_CAPACITY,
  TERA_ROOT_CAPACITY,
  TERA_ROOTS,
  TERA_STATIC_ROOT_COUNT,
  TERA_STATIC_ROOTS,
  TERA_STATICS,
  TERA_POINTER_BYTES,
  requireContextStorage,
  type TeraContextField,
} from "../../target/runtime-layout.js";
import {
  ARRAY_CAPACITY_OFFSET,
  ARRAY_ELEMENTS_OFFSET,
  ARRAY_GROWTH_FACTOR,
  ARRAY_INITIAL_CAPACITY,
  ARRAY_LENGTH_OFFSET,
  BUFFER_ELEMENTS_OFFSET,
  CLASS_ALIGNMENT_BYTES,
  CLASS_FLAGS_OFFSET,
  CLASS_HEADER_BYTES,
  referenceFieldOffsets,
  type ClassTable,
} from "../../metadata/class-table.js";
import {
  TERA_EXIT_HEAP_EXHAUSTED,
  TERA_EXIT_UNCAUGHT_THROW,
  TERA_UNCAUGHT_PREFIX,
} from "../../target/faults.js";
import { AnalysisManager } from "../../infra/analysis-manager.js";
import { createAnalysisRegistry } from "../../analyses/index.js";
import {
  typeInferenceAnalysisId,
  type TypeInference,
} from "../../analyses/type-inference.js";
import {
  analyzeAotLegality,
  builtinOperandScalar,
  callThroughArguments,
  codeSymbolOf,
  AOT_CHAR_AT,
  AOT_FLOAT_TO_STRING,
  AOT_INT_TO_STRING,
  type AotLegality,
  type AotStringBuffer,
} from "../../analyses/aot-legality.js";
import { calleeSymbolName } from "../../metadata/call-signatures.js";
import { isPendingThrowReturn } from "../../builder/throw-recovery.js";
import {
  AGGREGATE_CLOSE_TEXT,
  builtinIntrinsicByName,
  NO_TERMINATOR,
  OBJECT_CLOSE_TEXT,
  OBJECT_OPEN_TEXT,
  PARSE_FLOAT_BUILTIN,
  PARSE_INT_BUILTIN,
  builtinParameterAt,
  INPUT_BUILTIN,
  PRINT_BUILTIN,
  printTerminatorOf,
  qualifiedMethodName,
  THROW_BUILTIN,
  CLOCK_BUILTIN,
  WAIT_BUILTIN,
} from "../../metadata/builtin-methods.js";
import {
  isStorableScalar,
  SCALAR_FLOAT64,
  SCALAR_POINTER,
  SCALAR_INT32,
  SCALAR_STRING,
  SCALAR_TEXT,
  scalarWidth,
  SCALAR_CODE,
  SCALAR_VOID,
  type AotScalar,
} from "../../types/scalar.js";
import { INT32_DECIMAL_BYTES } from "../../machine/data.js";
import { declaredAotScalar } from "../../metadata/class-table.js";
import type { DeclaredSignature } from "../../types/signature.js";
import { isAbsenceConstant, isRootedPointer } from "../../analyses/aot-legality.js";
import { NULL_TEXT } from "../../metadata/printed-values.js";
import {
  FLOAT64_DECIMAL_BYTES,
  FLOAT64_NULL_BITS,
  FLOAT64_EXPONENT_BIAS,
  FLOAT64_EXPONENT_DIGITS,
  FLOAT64_EXPONENT_MASK,
  FLOAT64_FIXED_EXPONENT_LIMIT,
  FLOAT64_FRACTION_EXPONENT_LIMIT,
  FLOAT64_LIMB_BITS,
  FLOAT64_LIMBS,
  FLOAT64_MANTISSA_BITS,
  FLOAT64_MANTISSA_MASK,
  FLOAT64_MIN_EXPONENT,
  FLOAT64_SIGN_SHIFT,
  FLOAT64_SIGNIFICANT_DIGITS,
} from "../../target/float64.js";
import { INT32_MAX, INT32_MIN, UINT32_RANGE } from "../../target/integer.js";
import {
  cTypeOf,
  declarationOf,
  immutableDeclarationOf,
  prototypeOf,
  C_CODE,
  C_CODE_TYPEDEF,
  C_STRING,
  type CScalarType,
} from "../../target/c-types.js";
import {
  sanitizeSymbol,
  C_KEYWORDS,
  C_LIBRARY_NAMES,
} from "../../target/symbols.js";

export const C_HEADER_PREAMBLE = [
  "#include <stdint.h>",
  "#include <stdio.h>",
  "#include <stdlib.h>",
  "#include <string.h>",
  "#include <math.h>",
  "",
  C_CODE_TYPEDEF,
].join(String.fromCharCode(10));
const C_MAP = "tera_map";
const C_COMMIT = "tera_commit";
export const C_RESERVE_MACRO = "TERA_HEAP_RESERVE";
const C_CLOCK = "tera_clock";
const C_WAIT = "tera_pause";
const MILLIS_PER_SECOND = 1000;
const NANOS_PER_MILLI = 1000000;

const C_STRING_SET = "tera_str_set";
const C_STRING_APPEND = "tera_str_append";
const C_STRING_BUFFER_PREFIX = "sb";
const C_ROOT_BASE = "roots";

const C_PRINT_HELPERS = new Map<AotScalar, CBuiltinMethod>([
  [
    SCALAR_STRING,
    {
      helper: "tera_print_str",
      definition: `static inline void tera_print_str(const char *value, int32_t terminator) {
  printf("%s", value == 0 ? "${NULL_TEXT}" : value);
  if (terminator) printf("%c", terminator);
}`,
    },
  ],
  [
    SCALAR_INT32,
    {
      helper: "tera_print_i32",
      definition: `static inline void tera_print_i32(int32_t value, int32_t terminator) {
  printf("%d", value);
  if (terminator) printf("%c", terminator);
}`,
    },
  ],
  [
    SCALAR_FLOAT64,
    {
      helper: "tera_print_f64",
      definition: `static inline void tera_print_f64(double value, int32_t terminator) {
  char text[${FLOAT64_DECIMAL_BYTES}];
  printf("%s", tera_f64_to_str(text, ${FLOAT64_DECIMAL_BYTES}, value));
  if (terminator) printf("%c", terminator);
}`,
    },
  ],
]);

export const C_RUNTIME_SUPPORT = `#if defined(_WIN32)
void Sleep(unsigned long);
unsigned long long GetTickCount64(void);
void *VirtualAlloc(void *, size_t, unsigned long, unsigned long);
#else
#include <time.h>
#include <sys/mman.h>
#endif

#ifndef ${C_RESERVE_MACRO}
#define ${C_RESERVE_MACRO} ${TERA_HEAP_RESERVE_BYTES}
#endif

static unsigned char *${C_MAP}(size_t bytes) {
#if defined(_WIN32)
  return (unsigned char *)VirtualAlloc(
    0, bytes, ${WINDOWS_MEM_RESERVE}u, ${WINDOWS_PAGE_READWRITE}u);
#else
  void *base = mmap(0, bytes, ${PROT_NONE}, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  return base == MAP_FAILED ? 0 : (unsigned char *)base;
#endif
}

static int32_t ${C_COMMIT}(unsigned char *base, size_t bytes) {
#if defined(_WIN32)
  return VirtualAlloc(base, bytes, ${WINDOWS_MEM_COMMIT}u, ${WINDOWS_PAGE_READWRITE}u) != 0;
#else
  return mprotect(base, bytes, ${PROT_READ_WRITE}) == 0;
#endif
}

static inline int32_t tera_i32_add(int32_t a, int32_t b) {
  return (int32_t)((uint32_t)a + (uint32_t)b);
}

static inline int32_t tera_i32_sub(int32_t a, int32_t b) {
  return (int32_t)((uint32_t)a - (uint32_t)b);
}

static inline int32_t tera_i32_mul(int32_t a, int32_t b) {
  return (int32_t)((uint32_t)a * (uint32_t)b);
}

static inline int32_t tera_i32_div(int32_t a, int32_t b) {
  return b == 0 || (a == INT32_MIN && b == -1) ? 0 : a / b;
}

static inline int32_t tera_i32_mod(int32_t a, int32_t b) {
  return b == 0 || (a == INT32_MIN && b == -1) ? 0 : a % b;
}

static inline int32_t tera_i32_neg(int32_t a) {
  return (int32_t)(0u - (uint32_t)a);
}

static inline int32_t tera_i32_shl(int32_t a, int32_t b) {
  return (int32_t)((uint32_t)a << ((uint32_t)b & 31u));
}

static inline int32_t tera_i32_shr(int32_t a, int32_t b) {
  return a >> ((uint32_t)b & 31u);
}

static inline double tera_u32_shr(int32_t a, int32_t b) {
  return (double)((uint32_t)a >> ((uint32_t)b & 31u));
}

static inline int32_t tera_to_i32(double value) {
  if (!isfinite(value)) return 0;
  double truncated = trunc(value);
  if (truncated >= ${INT32_MIN}.0 && truncated <= ${INT32_MAX}.0) return (int32_t)truncated;
  double wrapped = fmod(truncated, ${UINT32_RANGE}.0);
  if (wrapped < 0.0) wrapped += ${UINT32_RANGE}.0;
  if (wrapped >= ${UINT32_RANGE / 2}.0) wrapped -= ${UINT32_RANGE}.0;
  return (int32_t)wrapped;
}

static inline char *tera_str_copy(char *dst, int32_t cap, const char *src, size_t at) {
  if (cap <= 0) return dst;
  size_t limit = (size_t)cap - 1u;
  while (at < limit && *src != '\\0') dst[at++] = *src++;
  dst[at] = '\\0';
  return dst;
}

static inline char *${C_STRING_SET}(char *dst, int32_t cap, const char *src) {
  return tera_str_copy(dst, cap, src, 0);
}

static inline char *${C_STRING_APPEND}(char *dst, int32_t cap, const char *src) {
  if (cap <= 0) return dst;
  size_t at = 0;
  size_t limit = (size_t)cap - 1u;
  while (at < limit && dst[at] != '\\0') at++;
  return tera_str_copy(dst, cap, src, at);
}`;

export const C_FLOAT_SUPPORT = `typedef struct {
  int32_t len;
  uint32_t limb[${FLOAT64_LIMBS}];
} tera_bn;

static void tera_bn_set(tera_bn *a, uint64_t value) {
  a->len = 0;
  while (value != 0) {
    a->limb[a->len++] = (uint32_t)value;
    value >>= ${FLOAT64_LIMB_BITS};
  }
}

static void tera_bn_copy(tera_bn *dst, const tera_bn *src) {
  dst->len = src->len;
  for (int32_t at = 0; at < src->len; at++) dst->limb[at] = src->limb[at];
}

static void tera_bn_mul(tera_bn *a, uint32_t factor) {
  uint64_t carry = 0;
  for (int32_t at = 0; at < a->len; at++) {
    uint64_t product = (uint64_t)a->limb[at] * factor + carry;
    a->limb[at] = (uint32_t)product;
    carry = product >> ${FLOAT64_LIMB_BITS};
  }
  while (carry != 0) {
    a->limb[a->len++] = (uint32_t)carry;
    carry >>= ${FLOAT64_LIMB_BITS};
  }
}

static void tera_bn_shl(tera_bn *a, int32_t bits) {
  if (a->len == 0) return;
  int32_t rest = bits % ${FLOAT64_LIMB_BITS};
  int32_t words = bits / ${FLOAT64_LIMB_BITS};
  if (rest != 0) {
    uint32_t carry = 0;
    for (int32_t at = 0; at < a->len; at++) {
      uint32_t moved = a->limb[at] >> (${FLOAT64_LIMB_BITS} - rest);
      a->limb[at] = (a->limb[at] << rest) | carry;
      carry = moved;
    }
    if (carry != 0) a->limb[a->len++] = carry;
  }
  if (words == 0) return;
  for (int32_t at = a->len - 1; at >= 0; at--) a->limb[at + words] = a->limb[at];
  for (int32_t at = 0; at < words; at++) a->limb[at] = 0;
  a->len += words;
}

static int32_t tera_bn_cmp(const tera_bn *a, const tera_bn *b) {
  if (a->len != b->len) return a->len < b->len ? -1 : 1;
  for (int32_t at = a->len - 1; at >= 0; at--) {
    if (a->limb[at] != b->limb[at]) return a->limb[at] < b->limb[at] ? -1 : 1;
  }
  return 0;
}

static int32_t tera_bn_above(const tera_bn *a, const tera_bn *b, int32_t inclusive) {
  int32_t sign = tera_bn_cmp(a, b);
  return sign > 0 || (inclusive && sign == 0);
}

static void tera_bn_sub(tera_bn *a, const tera_bn *b) {
  uint32_t borrow = 0;
  for (int32_t at = 0; at < a->len; at++) {
    uint64_t taken = (uint64_t)(at < b->len ? b->limb[at] : 0u) + borrow;
    uint64_t left = (uint64_t)a->limb[at];
    borrow = left < taken;
    a->limb[at] = (uint32_t)(left - taken);
  }
  while (a->len > 0 && a->limb[a->len - 1] == 0) a->len--;
}

static void tera_bn_add(tera_bn *dst, const tera_bn *a, const tera_bn *b) {
  int32_t len = a->len > b->len ? a->len : b->len;
  uint64_t carry = 0;
  for (int32_t at = 0; at < len; at++) {
    uint64_t sum = (uint64_t)(at < a->len ? a->limb[at] : 0u)
      + (uint64_t)(at < b->len ? b->limb[at] : 0u) + carry;
    dst->limb[at] = (uint32_t)sum;
    carry = sum >> ${FLOAT64_LIMB_BITS};
  }
  dst->len = len;
  if (carry != 0) dst->limb[dst->len++] = (uint32_t)carry;
}

static size_t tera_str_put(char *dst, size_t at, const char *text) {
  while (*text != '\\0') dst[at++] = *text++;
  return at;
}

static size_t tera_exponent_put(char *dst, size_t at, int32_t exponent) {
  char reversed[${FLOAT64_EXPONENT_DIGITS}];
  int32_t count = 0;
  uint32_t magnitude = exponent < 0 ? 0u - (uint32_t)exponent : (uint32_t)exponent;
  dst[at++] = exponent < 0 ? '-' : '+';
  do {
    reversed[count++] = (char)('0' + (magnitude % 10u));
    magnitude /= 10u;
  } while (magnitude != 0u);
  while (count > 0) dst[at++] = reversed[--count];
  return at;
}

static char *tera_f64_to_str(char *dst, int32_t cap, double value) {
  if (cap < ${FLOAT64_DECIMAL_BYTES}) {
    if (cap > 0) dst[0] = '\\0';
    return dst;
  }
  uint64_t bits;
  memcpy(&bits, &value, sizeof bits);
  if (bits == ${FLOAT64_NULL_BITS}ull) {
    dst[tera_str_put(dst, 0, "${NULL_TEXT}")] = '\\0';
    return dst;
  }
  int32_t negative = (int32_t)(bits >> ${FLOAT64_SIGN_SHIFT});
  int32_t biased = (int32_t)((bits >> ${FLOAT64_MANTISSA_BITS}) & 0x${FLOAT64_EXPONENT_MASK.toString(16)}u);
  uint64_t mantissa = bits & 0x${FLOAT64_MANTISSA_MASK.toString(16)}ull;
  size_t at = 0;
  if (biased == 0x${FLOAT64_EXPONENT_MASK.toString(16)}) {
    at = tera_str_put(dst, at, mantissa != 0 ? "NaN" : (negative ? "-Infinity" : "Infinity"));
    dst[at] = '\\0';
    return dst;
  }
  if (biased == 0 && mantissa == 0) {
    dst[0] = '0';
    dst[1] = '\\0';
    return dst;
  }

  uint64_t significand = biased == 0 ? mantissa : mantissa | (1ull << ${FLOAT64_MANTISSA_BITS});
  int32_t exponent = biased == 0 ? ${FLOAT64_MIN_EXPONENT} : biased - ${FLOAT64_EXPONENT_BIAS};
  int32_t inclusive = (significand & 1ull) == 0;
  int32_t atBoundary = significand == (1ull << ${FLOAT64_MANTISSA_BITS}) && biased > 1;
  tera_bn r, s, plus, minus, scratch;

  tera_bn_set(&r, significand);
  tera_bn_set(&minus, 1);
  tera_bn_set(&plus, atBoundary ? 2 : 1);
  if (exponent >= 0) {
    tera_bn_shl(&r, exponent + (atBoundary ? 2 : 1));
    tera_bn_set(&s, atBoundary ? 4 : 2);
    tera_bn_shl(&minus, exponent);
    tera_bn_shl(&plus, exponent);
  } else {
    tera_bn_shl(&r, atBoundary ? 2 : 1);
    tera_bn_set(&s, 1);
    tera_bn_shl(&s, (atBoundary ? 2 : 1) - exponent);
  }

  int32_t decimal = 0;
  tera_bn_add(&scratch, &r, &plus);
  while (tera_bn_above(&scratch, &s, inclusive)) {
    tera_bn_mul(&s, 10);
    decimal++;
  }
  for (;;) {
    tera_bn_mul(&scratch, 10);
    if (tera_bn_above(&scratch, &s, inclusive)) break;
    tera_bn_mul(&r, 10);
    tera_bn_mul(&plus, 10);
    tera_bn_mul(&minus, 10);
    decimal--;
  }

  char digits[${FLOAT64_SIGNIFICANT_DIGITS}];
  int32_t count = 0;
  while (count < ${FLOAT64_SIGNIFICANT_DIGITS}) {
    tera_bn_mul(&r, 10);
    tera_bn_mul(&plus, 10);
    tera_bn_mul(&minus, 10);
    int32_t digit = 0;
    while (tera_bn_cmp(&r, &s) >= 0) {
      tera_bn_sub(&r, &s);
      digit++;
    }
    int32_t below = tera_bn_cmp(&r, &minus);
    int32_t low = below < 0 || (inclusive && below == 0);
    tera_bn_add(&scratch, &r, &plus);
    int32_t high = tera_bn_above(&scratch, &s, inclusive);
    if (!low && !high) {
      digits[count++] = (char)('0' + digit);
      continue;
    }
    if (low && high) {
      tera_bn_copy(&scratch, &r);
      tera_bn_mul(&scratch, 2);
      int32_t tie = tera_bn_cmp(&scratch, &s);
      high = tie > 0 || (tie == 0 && (digit & 1) != 0);
    }
    digits[count++] = (char)('0' + digit + (high ? 1 : 0));
    break;
  }

  if (negative) dst[at++] = '-';
  if (decimal > ${FLOAT64_FIXED_EXPONENT_LIMIT} || decimal <= ${FLOAT64_FRACTION_EXPONENT_LIMIT}) {
    dst[at++] = digits[0];
    if (count > 1) {
      dst[at++] = '.';
      for (int32_t index = 1; index < count; index++) dst[at++] = digits[index];
    }
    dst[at++] = 'e';
    at = tera_exponent_put(dst, at, decimal - 1);
  } else if (decimal <= 0) {
    dst[at++] = '0';
    dst[at++] = '.';
    for (int32_t index = decimal; index < 0; index++) dst[at++] = '0';
    for (int32_t index = 0; index < count; index++) dst[at++] = digits[index];
  } else if (decimal >= count) {
    for (int32_t index = 0; index < count; index++) dst[at++] = digits[index];
    for (int32_t index = count; index < decimal; index++) dst[at++] = '0';
  } else {
    for (int32_t index = 0; index < decimal; index++) dst[at++] = digits[index];
    dst[at++] = '.';
    for (int32_t index = decimal; index < count; index++) dst[at++] = digits[index];
  }
  dst[at] = '\\0';
  return dst;
}`;

const C_STRING_SUPPORT = `static inline int32_t tera_text_size(const char *value) {
  return (int32_t)strlen(value);
}

static inline char *tera_text_copy(char *dst, int32_t cap, const char *src, int32_t from, int32_t count) {
  int32_t at = 0;
  if (cap <= 0) return dst;
  while (at < count && at + 1 < cap) {
    dst[at] = src[from + at];
    at++;
  }
  dst[at] = '\\0';
  return dst;
}

static inline int32_t tera_text_match(const char *value, int32_t at, const char *needle) {
  int32_t index = 0;
  while (needle[index] != '\\0') {
    if (value[at + index] != needle[index]) return 0;
    index++;
  }
  return 1;
}

static inline int32_t tera_text_find(const char *value, const char *needle, int32_t from) {
  int32_t size = tera_text_size(value);
  int32_t width = tera_text_size(needle);
  for (int32_t start = from; start + width <= size; start++) {
    if (tera_text_match(value, start, needle)) return start;
  }
  return -1;
}

static inline int32_t tera_text_blank(char value) {
  return value == ' ' || value == '\\t' || value == '\\n' || value == '\\r' || value == '\\v' || value == '\\f';
}

static inline int32_t tera_text_bound(int32_t index, int32_t size) {
  if (index < 0) {
    index += size;
    return index < 0 ? 0 : index;
  }
  return index > size ? size : index;
}

static inline char *tera_string_case(char *dst, int32_t cap, const char *src, int32_t upper) {
  int32_t at = 0;
  if (cap <= 0) return dst;
  while (src[at] != '\\0' && at + 1 < cap) {
    char value = src[at];
    if (upper) dst[at] = (value >= 'a' && value <= 'z') ? (char)(value - 32) : value;
    else dst[at] = (value >= 'A' && value <= 'Z') ? (char)(value + 32) : value;
    at++;
  }
  dst[at] = '\\0';
  return dst;
}

static inline char *tera_string_trim_range(char *dst, int32_t cap, const char *src, int32_t lead, int32_t trail) {
  int32_t start = 0;
  int32_t end = tera_text_size(src);
  if (lead) while (start < end && tera_text_blank(src[start])) start++;
  if (trail) while (end > start && tera_text_blank(src[end - 1])) end--;
  return tera_text_copy(dst, cap, src, start, end - start);
}

static inline double tera_text_number(const char *text, int32_t integral) {
  const char *at = text;
  char *stop = 0;
  double value;
  while (tera_text_blank(*at)) at++;
  if (!integral) {
    value = strtod(at, &stop);
    return stop == at ? (0.0 / 0.0) : value;
  }
  value = (double)strtol(at, &stop, 10);
  return stop == at ? (0.0 / 0.0) : value;
}

static inline int32_t tera_text_put(char *dst, int32_t cap, int32_t at, const char *text) {
  for (int32_t k = 0; text[k] != '\\0' && at + 1 < cap; k++) dst[at++] = text[k];
  return at;
}

static inline char *tera_string_replace_gaps(char *dst, int32_t cap, const char *src, const char *fresh, int32_t all) {
  int32_t size = tera_text_size(src);
  int32_t at = all ? 0 : tera_text_put(dst, cap, 0, fresh);
  for (int32_t index = 0; index < size; index++) {
    if (all && index > 0) at = tera_text_put(dst, cap, at, fresh);
    if (at + 1 < cap) dst[at++] = src[index];
  }
  dst[at] = '\\0';
  return dst;
}

static inline char *tera_string_replace_range(char *dst, int32_t cap, const char *src, const char *old, const char *fresh, int32_t all) {
  int32_t at = 0;
  int32_t index = 0;
  int32_t size = tera_text_size(src);
  int32_t width = tera_text_size(old);
  int32_t done = 0;
  if (cap <= 0) return dst;
  if (width == 0) return tera_string_replace_gaps(dst, cap, src, fresh, all);
  while (index < size) {
    if (!done && index + width <= size && tera_text_match(src, index, old)) {
      at = tera_text_put(dst, cap, at, fresh);
      index += width;
      if (!all) done = 1;
      continue;
    }
    if (at + 1 < cap) dst[at++] = src[index];
    index++;
  }
  dst[at] = '\\0';
  return dst;
}`;

const C_BUILTIN_METHODS = new Map<string, CBuiltinMethod>([
  [
    qualifiedMethodName("Math", "abs"),
    {
      helper: "tera_math_abs",
      definition: `static inline double tera_math_abs(double v) {
  return v < 0.0 ? -v : v;
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "floor"),
    {
      helper: "tera_math_floor",
      definition: `static inline double tera_math_floor(double v) {
  return floor(v);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "ceil"),
    {
      helper: "tera_math_ceil",
      definition: `static inline double tera_math_ceil(double v) {
  return ceil(v);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "sqrt"),
    {
      helper: "tera_math_sqrt",
      definition: `static inline double tera_math_sqrt(double v) {
  return sqrt(v);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "trunc"),
    {
      helper: "tera_math_trunc",
      definition: `static inline double tera_math_trunc(double v) {
  return trunc(v);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "round"),
    {
      helper: "tera_math_round",
      definition: `static inline double tera_math_round(double v) {
  return floor(v + 0.5);
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "min"),
    {
      helper: "tera_math_min",
      definition: `static inline double tera_math_min(double a, double b) {
  if (a != a || b != b) return a - a + (b - b);
  return a < b ? a : b;
}`,
    },
  ],
  [
    qualifiedMethodName("Math", "max"),
    {
      helper: "tera_math_max",
      definition: `static inline double tera_math_max(double a, double b) {
  if (a != a || b != b) return a - a + (b - b);
  return a > b ? a : b;
}`,
    },
  ],
  [
    PARSE_INT_BUILTIN,
    {
      helper: "tera_parse_int",
      definition: `static inline double tera_parse_int(const char *text) {
  return tera_text_number(text, 1);
}`,
    },
  ],
  [
    PARSE_FLOAT_BUILTIN,
    {
      helper: "tera_parse_float",
      definition: `static inline double tera_parse_float(const char *text) {
  return tera_text_number(text, 0);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "to_upper_case"),
    {
      helper: "tera_string_upper",
      definition: `static inline char *tera_string_upper(char *dst, int32_t cap, const char *src) {
  return tera_string_case(dst, cap, src, 1);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "to_lower_case"),
    {
      helper: "tera_string_lower",
      definition: `static inline char *tera_string_lower(char *dst, int32_t cap, const char *src) {
  return tera_string_case(dst, cap, src, 0);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "trim"),
    {
      helper: "tera_string_trim",
      definition: `static inline char *tera_string_trim(char *dst, int32_t cap, const char *src) {
  return tera_string_trim_range(dst, cap, src, 1, 1);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "trim_start"),
    {
      helper: "tera_string_trim_start",
      definition: `static inline char *tera_string_trim_start(char *dst, int32_t cap, const char *src) {
  return tera_string_trim_range(dst, cap, src, 1, 0);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "trim_end"),
    {
      helper: "tera_string_trim_end",
      definition: `static inline char *tera_string_trim_end(char *dst, int32_t cap, const char *src) {
  return tera_string_trim_range(dst, cap, src, 0, 1);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "slice"),
    {
      helper: "tera_string_slice",
      definition: `static inline char *tera_string_slice(char *dst, int32_t cap, const char *src, int32_t start, int32_t end) {
  int32_t size = tera_text_size(src);
  int32_t from = tera_text_bound(start, size);
  int32_t to = tera_text_bound(end, size);
  return tera_text_copy(dst, cap, src, from, to > from ? to - from : 0);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "repeat"),
    {
      helper: "tera_string_repeat",
      definition: `static inline char *tera_string_repeat(char *dst, int32_t cap, const char *src, int32_t times) {
  int32_t at = 0;
  int32_t size = tera_text_size(src);
  if (cap <= 0) return dst;
  for (int32_t round = 0; round < times; round++) {
    for (int32_t index = 0; index < size && at + 1 < cap; index++) dst[at++] = src[index];
  }
  dst[at] = '\\0';
  return dst;
}`,
    },
  ],
  [
    qualifiedMethodName("string", "replace"),
    {
      helper: "tera_string_replace",
      definition: `static inline char *tera_string_replace(char *dst, int32_t cap, const char *src, const char *old, const char *fresh) {
  return tera_string_replace_range(dst, cap, src, old, fresh, 0);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "replace_all"),
    {
      helper: "tera_string_replace_all",
      definition: `static inline char *tera_string_replace_all(char *dst, int32_t cap, const char *src, const char *old, const char *fresh) {
  return tera_string_replace_range(dst, cap, src, old, fresh, 1);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "index_of"),
    {
      helper: "tera_string_index_of",
      definition: `static inline int32_t tera_string_index_of(const char *value, const char *needle) {
  return tera_text_find(value, needle, 0);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "includes"),
    {
      helper: "tera_string_includes",
      definition: `static inline int32_t tera_string_includes(const char *value, const char *needle) {
  return tera_text_find(value, needle, 0) >= 0;
}`,
    },
  ],
  [
    qualifiedMethodName("string", "starts_with"),
    {
      helper: "tera_string_starts_with",
      definition: `static inline int32_t tera_string_starts_with(const char *value, const char *prefix) {
  return tera_text_size(prefix) <= tera_text_size(value) && tera_text_match(value, 0, prefix);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "ends_with"),
    {
      helper: "tera_string_ends_with",
      definition: `static inline int32_t tera_string_ends_with(const char *value, const char *suffix) {
  int32_t size = tera_text_size(value);
  int32_t width = tera_text_size(suffix);
  return width <= size && tera_text_match(value, size - width, suffix);
}`,
    },
  ],
  [
    qualifiedMethodName("string", "char_code_at"),
    {
      helper: "tera_string_char_code_at",
      definition: `static inline int32_t tera_string_char_code_at(const char *value, int32_t index) {
  return index < 0 ? 0 : (int32_t)(unsigned char)value[index];
}`,
    },
  ],
  [
    qualifiedMethodName("string", "length"),
    {
      helper: "tera_string_length",
      definition: `static inline int32_t tera_string_length(const char *value) {
  return (int32_t)strlen(value);
}`,
    },
  ],
  [
    AOT_CHAR_AT,
    {
      helper: "tera_string_char_at",
      definition: `static inline char *tera_string_char_at(char *dst, int32_t cap, const char *src, int32_t index) {
  if (cap <= 0) return dst;
  if (cap < 2 || index < 0) {
    dst[0] = '\\0';
    return dst;
  }
  for (int32_t seen = 0; seen < index; seen++) {
    if (src[seen] == '\\0') {
      dst[0] = '\\0';
      return dst;
    }
  }
  dst[0] = src[index];
  dst[dst[0] == '\\0' ? 0 : 1] = '\\0';
  return dst;
}`,
    },
  ],
  [
    AOT_FLOAT_TO_STRING,
    { helper: "tera_f64_to_str", definition: "" },
  ],
  [
    AOT_INT_TO_STRING,
    {
      helper: "tera_i32_to_str",
      definition: `static inline char *tera_i32_to_str(char *dst, int32_t cap, int32_t value) {
  if (cap <= 0) return dst;
  if (cap < ${INT32_DECIMAL_BYTES}) {
    dst[0] = '\\0';
    return dst;
  }
  uint32_t magnitude = value < 0 ? 0u - (uint32_t)value : (uint32_t)value;
  size_t at = 0;
  if (value < 0) dst[at++] = '-';
  size_t start = at;
  do {
    dst[at++] = (char)('0' + (magnitude % 10u));
    magnitude /= 10u;
  } while (magnitude != 0u);
  dst[at] = '\\0';
  for (size_t last = at - 1; start < last; start++, last--) {
    char swap = dst[start];
    dst[start] = dst[last];
    dst[last] = swap;
  }
  return dst;
}`,
    },
  ],
  [
    THROW_BUILTIN,
    {
      helper: "tera_throw",
      definition: `static inline void tera_throw(const char *message) {
  fprintf(stderr, "%s%s\\n", ${cStringLiteral(TERA_UNCAUGHT_PREFIX)}, message);
  exit(${TERA_EXIT_UNCAUGHT_THROW});
}`,
    },
  ],
  [
    CLOCK_BUILTIN,
    {
      helper: C_CLOCK,
      definition: `static double ${C_CLOCK}(void) {
#if defined(_WIN32)
  return (double)GetTickCount64();
#else
  struct timespec moment;
  clock_gettime(CLOCK_MONOTONIC, &moment);
  return (double)moment.tv_sec * ${MILLIS_PER_SECOND}.0 +
    (double)moment.tv_nsec / ${NANOS_PER_MILLI}.0;
#endif
}`,
    },
  ],
  [
    WAIT_BUILTIN,
    {
      helper: C_WAIT,
      definition: `static void ${C_WAIT}(double millis) {
  if (!(millis > 0.0)) return;
#if defined(_WIN32)
  Sleep((unsigned long)millis);
#else
  struct timespec span;
  span.tv_sec = (long)(millis / ${MILLIS_PER_SECOND}.0);
  span.tv_nsec = (long)((millis - (double)span.tv_sec * ${MILLIS_PER_SECOND}.0) * ${NANOS_PER_MILLI}.0);
  nanosleep(&span, 0);
#endif
}`,
    },
  ],
  [
    INPUT_BUILTIN,
    {
      helper: "tera_input",
      definition: `static inline char *tera_input(char *dst, int32_t cap, const char *prompt) {
  if (cap <= 0) return dst;
  fputs(prompt, stdout);
  fflush(stdout);
  if (fgets(dst, cap, stdin) == NULL) {
    dst[0] = '\\0';
    return dst;
  }
  size_t used = strlen(dst);
  while (used > 0 && (dst[used - 1] == '\\n' || dst[used - 1] == '\\r')) dst[--used] = '\\0';
  return dst;
}`,
    },
  ],
]);

const C_CLASS_TYPE = "tera_class";
const C_CONTEXT_TYPE = "tera_context_t";
const C_BLOCK_SIZE = "tera_block_size";
const C_REFERENCE_COUNT = "tera_reference_count";
const C_REFERENCE_AT = "tera_reference_at";
const C_ARRAY_RESERVE = "tera_array_reserve";
const C_MARK = "tera_mark";
const C_MARK_YOUNG = "tera_mark_young";
const C_SWEEP = "tera_sweep";
const C_SWEEP_YOUNG = "tera_sweep_young";
const C_NOTE_YOUNG = "tera_note_young";
const C_RELEASE = "tera_release";
const C_NURSERY_RESET = "tera_nursery_reset";
const C_BARRIER = TERA_BARRIER_SYMBOL;
const C_REMEMBER = "tera_remember";
const C_IS_YOUNG = "tera_is_young";
const C_TAKE = "tera_take";
const C_BUMP = "tera_bump";
const C_CLASS_FIELDS_PREFIX = "tera_fields_";

const C_CONTEXT_TYPES: ReadonlyMap<TeraContextField, string> = new Map([
  ["arenaBase", "unsigned char *"],
  ["arenaCursor", "size_t"],
  ["arenaCommitted", "size_t"],
  ["arenaReserved", "size_t"],
  ["freeHead", "unsigned char *"],
  ["rootsBase", "unsigned char **"],
  ["rootCount", "size_t"],
  ["marksBase", "unsigned char **"],
  ["nurseryLimit", "size_t"],
  ["youngBase", "unsigned char **"],
  ["youngCount", "size_t"],
  ["rememberedBase", "unsigned char **"],
  ["rememberedCount", "size_t"],
  ["waitHead", "unsigned char *"],
  ["waitTail", "unsigned char *"],
  ["waitCount", "size_t"],
  ["waitDue", "double"],
  ["sweepHead", "unsigned char *"],
  ["sweepCount", "size_t"],
  ["queueHead", "unsigned char *"],
  ["queueTail", "unsigned char *"],
  ["queueCount", "size_t"],
  ["rejectedHead", "unsigned char *"],
  ["rejectedCount", "size_t"],
  ["rejectedText", "unsigned char *"],
  ["reportedCount", "size_t"],
  ["pendingThrowFlag", "uint32_t"],
  ["pendingThrowValue", "unsigned char *"],
]);

function cFieldName(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function cContextField(name: TeraContextField): string {
  return `${TERA_CONTEXT.symbol}.${cFieldName(name)}`;
}

function cContextType(): string {
  requireContextStorage();
  return [
    "typedef struct {",
    ...TERA_CONTEXT.fields.map((field) => {
      const declared = C_CONTEXT_TYPES.get(field.name);
      if (declared === undefined) {
        throw new Error(`the C backend has no type for ${TERA_CONTEXT.symbol}.${field.name}`);
      }
      const spacer = declared.endsWith("*") ? "" : " ";
      return `  ${declared}${spacer}${cFieldName(field.name)};`;
    }),
    `} ${C_CONTEXT_TYPE};`,
  ].join("\n");
}

export function cClassTable(classes: ClassTable | null): string {
  const shapes = classes === null ? [] : classes.shapes();
  const rows = [`  { 0, 0, 0 },`];
  const tables: string[] = [];
  const statics: number[] = [];
  for (const shape of shapes) {
    const offsets = referenceFieldOffsets(shape);
    const name = `${C_CLASS_FIELDS_PREFIX}${shape.id}`;
    if (offsets.length > 0) {
      tables.push(`static const uint32_t ${name}[] = { ${offsets.join(", ")} };`);
    }
    rows.push(
      `  { ${shape.tailReferences ? 1 : 0}, ${offsets.length}, ${offsets.length > 0 ? name : "0"} },`,
    );
    for (const field of shape.staticFields.values()) {
      if (field.scalar === SCALAR_POINTER) statics.push(field.offset);
    }
  }
  return [
    `typedef struct {`,
    `  uint32_t tail;`,
    `  uint32_t fields;`,
    `  const uint32_t *offsets;`,
    `} ${C_CLASS_TYPE};`,
    ...tables,
    `static const ${C_CLASS_TYPE} ${TERA_CLASS_RECORD.symbol}[] = {`,
    ...rows,
    `};`,
    `static const uint32_t ${TERA_STATIC_ROOTS.symbol}[] = { ${[...statics, 0].join(", ")} };`,
    `static const uint32_t ${TERA_STATIC_ROOT_COUNT.symbol} = ${statics.length};`,
  ].join("\n");
}

export const C_HEAP_SUPPORT = `${cContextType()}
static unsigned char ${TERA_STATICS.symbol}[${TERA_STATICS.size}];
static unsigned char *${TERA_ROOTS.symbol}[${TERA_ROOTS.capacity}];
static unsigned char *${TERA_MARKS.symbol}[${TERA_MARKS.capacity}];
static unsigned char *${TERA_YOUNG.symbol}[${TERA_YOUNG.capacity}];
static unsigned char *${TERA_REMEMBERED.symbol}[${TERA_REMEMBERED.capacity}];
static ${C_CONTEXT_TYPE} ${TERA_CONTEXT.symbol} = {
  .${cFieldName("arenaReserved")} = ${C_RESERVE_MACRO},
  .${cFieldName("rootsBase")} = ${TERA_ROOTS.symbol},
  .${cFieldName("marksBase")} = ${TERA_MARKS.symbol},
  .${cFieldName("youngBase")} = ${TERA_YOUNG.symbol},
  .${cFieldName("rememberedBase")} = ${TERA_REMEMBERED.symbol},
};

static uint32_t ${C_BLOCK_SIZE}(const unsigned char *block) {
  return *(const uint32_t *)(block + ${CLASS_FLAGS_OFFSET}) & ~(uint32_t)${TERA_BLOCK_FLAGS}u;
}

static void ${C_NURSERY_RESET}(void) {
  size_t room = (${TERA_YOUNG.capacity}u - ${cContextField("youngCount")}) * ${CLASS_HEADER_BYTES}u;
  size_t reach = ${cContextField("arenaCursor")} + room;
  ${cContextField("nurseryLimit")} =
    reach < ${cContextField("arenaCommitted")} ? reach : ${cContextField("arenaCommitted")};
}

static inline int32_t ${C_IS_YOUNG}(const unsigned char *block) {
  return (*(const uint32_t *)(block + ${CLASS_FLAGS_OFFSET}) & ${TERA_OLD_FLAG}u) == 0u;
}

static void ${C_NOTE_YOUNG}(unsigned char *block) {
  ${cContextField("youngBase")}[${cContextField("youngCount")}++] = block;
}

static void ${C_REMEMBER}(unsigned char *target) {
  if (${cContextField("rememberedCount")} == ${TERA_REMEMBERED_CAPACITY}u) return;
  *(uint32_t *)(target + ${CLASS_FLAGS_OFFSET}) |= ${TERA_REMEMBERED_FLAG}u;
  ${cContextField("rememberedBase")}[${cContextField("rememberedCount")}++] = target;
}

static inline void ${C_BARRIER}(unsigned char *target, const unsigned char *value) {
  if (value == 0 || !${C_IS_YOUNG}(value) || ${C_IS_YOUNG}(target)) return;
  if ((*(const uint32_t *)(target + ${CLASS_FLAGS_OFFSET}) & ${TERA_REMEMBERED_FLAG}u) != 0u) return;
  ${C_REMEMBER}(target);
}

static uint32_t ${C_REFERENCE_COUNT}(const unsigned char *block) {
  const ${C_CLASS_TYPE} *shape = &${TERA_CLASS_RECORD.symbol}[*(const uint32_t *)block];
  if (shape->tail == 0u) return shape->fields;
  return (${C_BLOCK_SIZE}(block) - ${BUFFER_ELEMENTS_OFFSET}u) / ${TERA_POINTER_BYTES}u;
}

static unsigned char *${C_REFERENCE_AT}(const unsigned char *block, uint32_t at) {
  const ${C_CLASS_TYPE} *shape = &${TERA_CLASS_RECORD.symbol}[*(const uint32_t *)block];
  uint32_t offset = shape->tail == 0u
    ? shape->offsets[at]
    : ${BUFFER_ELEMENTS_OFFSET}u + at * ${TERA_POINTER_BYTES}u;
  return *(unsigned char **)(block + offset);
}

static int32_t ${C_MARK}(unsigned char *object) {
  size_t top = 0;
  int32_t overflowed = 0;
  if (object != 0) ${cContextField("marksBase")}[top++] = object;
  while (top > 0) {
    unsigned char *block = ${cContextField("marksBase")}[--top];
    uint32_t *flags = (uint32_t *)(block + ${CLASS_FLAGS_OFFSET});
    if ((*flags & ${TERA_MARK_FLAG}u) != 0u) continue;
    *flags |= ${TERA_MARK_FLAG}u;
    uint32_t references = ${C_REFERENCE_COUNT}(block);
    for (uint32_t at = 0; at < references; at++) {
      unsigned char *field = ${C_REFERENCE_AT}(block, at);
      if (field == 0) continue;
      if (top == ${TERA_MARKS.capacity}) overflowed = 1;
      else ${cContextField("marksBase")}[top++] = field;
    }
  }
  return overflowed;
}

static int32_t tera_mark_pending(void) {
  int32_t overflowed = 0;
  size_t at = 0;
  while (at < ${cContextField("arenaCursor")}) {
    unsigned char *block = ${cContextField("arenaBase")} + at;
    uint32_t size = ${C_BLOCK_SIZE}(block);
    if (*(const uint32_t *)block != ${TERA_FREE_SHAPE_ID}u &&
        (*(uint32_t *)(block + ${CLASS_FLAGS_OFFSET}) & ${TERA_MARK_FLAG}u) != 0u) {
      uint32_t references = ${C_REFERENCE_COUNT}(block);
      for (uint32_t index = 0; index < references; index++) {
        unsigned char *field = ${C_REFERENCE_AT}(block, index);
        if (field == 0) continue;
        if ((*(uint32_t *)(field + ${CLASS_FLAGS_OFFSET}) & ${TERA_MARK_FLAG}u) != 0u) continue;
        overflowed |= ${C_MARK}(field);
      }
    }
    at += size;
  }
  return overflowed;
}

static int32_t ${C_MARK_YOUNG}(unsigned char *object) {
  size_t top = 0;
  int32_t overflowed = 0;
  if (object != 0 && ${C_IS_YOUNG}(object)) ${cContextField("marksBase")}[top++] = object;
  while (top > 0) {
    unsigned char *block = ${cContextField("marksBase")}[--top];
    uint32_t *flags = (uint32_t *)(block + ${CLASS_FLAGS_OFFSET});
    if ((*flags & ${TERA_MARK_FLAG}u) != 0u) continue;
    *flags |= ${TERA_MARK_FLAG}u;
    uint32_t references = ${C_REFERENCE_COUNT}(block);
    for (uint32_t at = 0; at < references; at++) {
      unsigned char *field = ${C_REFERENCE_AT}(block, at);
      if (field == 0 || !${C_IS_YOUNG}(field)) continue;
      if (top == ${TERA_MARKS.capacity}) overflowed = 1;
      else ${cContextField("marksBase")}[top++] = field;
    }
  }
  return overflowed;
}

static int32_t tera_mark_young_pending(void) {
  int32_t overflowed = 0;
  for (size_t at = 0; at < ${cContextField("youngCount")}; at++) {
    unsigned char *block = ${cContextField("youngBase")}[at];
    if ((*(const uint32_t *)(block + ${CLASS_FLAGS_OFFSET}) & ${TERA_MARK_FLAG}u) == 0u) continue;
    uint32_t references = ${C_REFERENCE_COUNT}(block);
    for (uint32_t index = 0; index < references; index++) {
      unsigned char *field = ${C_REFERENCE_AT}(block, index);
      if (field == 0 || !${C_IS_YOUNG}(field)) continue;
      if ((*(uint32_t *)(field + ${CLASS_FLAGS_OFFSET}) & ${TERA_MARK_FLAG}u) != 0u) continue;
      overflowed |= ${C_MARK_YOUNG}(field);
    }
  }
  return overflowed;
}

static void ${C_RELEASE}(unsigned char *block, size_t bytes) {
  if (block + bytes == ${cContextField("arenaBase")} + ${cContextField("arenaCursor")}) {
    ${cContextField("arenaCursor")} -= bytes;
    return;
  }
  *(uint32_t *)block = ${TERA_FREE_SHAPE_ID}u;
  *(uint32_t *)(block + ${CLASS_FLAGS_OFFSET}) = (uint32_t)bytes;
  if (bytes >= ${CLASS_HEADER_BYTES} + ${TERA_LINK_BYTES}) {
    *(unsigned char **)(block + ${CLASS_HEADER_BYTES}) = ${cContextField("freeHead")};
    ${cContextField("freeHead")} = block;
  }
}

static void ${C_SWEEP_YOUNG}(void) {
  size_t at = 0;
  while (at < ${cContextField("youngCount")}) {
    unsigned char *block = ${cContextField("youngBase")}[at];
    uint32_t *flags = (uint32_t *)(block + ${CLASS_FLAGS_OFFSET});
    if ((*flags & ${TERA_MARK_FLAG}u) != 0u) {
      *flags = (*flags & ~(uint32_t)${TERA_BLOCK_FLAGS}u) | ${TERA_OLD_FLAG}u;
      at++;
      continue;
    }
    size_t bytes = ${C_BLOCK_SIZE}(block);
    size_t run = at + 1;
    while (run < ${cContextField("youngCount")}) {
      unsigned char *next = ${cContextField("youngBase")}[run];
      if (block + bytes != next) break;
      if ((*(uint32_t *)(next + ${CLASS_FLAGS_OFFSET}) & ${TERA_MARK_FLAG}u) != 0u) break;
      bytes += ${C_BLOCK_SIZE}(next);
      run++;
    }
    ${C_RELEASE}(block, bytes);
    at = run;
  }
  ${cContextField("youngCount")} = 0;
}

static void ${C_SWEEP}(void) {
  ${cContextField("freeHead")} = 0;
  size_t at = 0;
  while (at < ${cContextField("arenaCursor")}) {
    unsigned char *block = ${cContextField("arenaBase")} + at;
    uint32_t *flags = (uint32_t *)(block + ${CLASS_FLAGS_OFFSET});
    if (*(const uint32_t *)block != ${TERA_FREE_SHAPE_ID}u && (*flags & ${TERA_MARK_FLAG}u) != 0u) {
      *flags = (*flags & ~(uint32_t)${TERA_BLOCK_FLAGS}u) | ${TERA_OLD_FLAG}u;
      at += ${C_BLOCK_SIZE}(block);
      continue;
    }
    size_t run = at;
    size_t bytes = 0;
    while (run < ${cContextField("arenaCursor")}) {
      unsigned char *next = ${cContextField("arenaBase")} + run;
      uint32_t live = *(const uint32_t *)next != ${TERA_FREE_SHAPE_ID}u &&
        (*(uint32_t *)(next + ${CLASS_FLAGS_OFFSET}) & ${TERA_MARK_FLAG}u) != 0u;
      if (live) break;
      bytes += ${C_BLOCK_SIZE}(next);
      run += ${C_BLOCK_SIZE}(next);
    }
    ${C_RELEASE}(block, bytes);
    at = run;
  }
}

static void ${TERA_COLLECT_SYMBOL}(void) {
  int32_t overflowed = 0;
  for (size_t at = 0; at < ${cContextField("rootCount")}; at++) {
    overflowed |= ${C_MARK}(${cContextField("rootsBase")}[at]);
  }
  for (uint32_t at = 0; at < ${TERA_STATIC_ROOT_COUNT.symbol}; at++) {
    overflowed |= ${C_MARK}(*(unsigned char **)(${TERA_STATICS.symbol} + ${TERA_STATIC_ROOTS.symbol}[at]));
  }
  overflowed |= ${C_MARK}(${cContextField("waitHead")});
  overflowed |= ${C_MARK}(${cContextField("sweepHead")});
  overflowed |= ${C_MARK}(${cContextField("queueHead")});
  overflowed |= ${C_MARK}(${cContextField("rejectedHead")});
  overflowed |= ${C_MARK}(${cContextField("rejectedText")});
  while (overflowed != 0) overflowed = tera_mark_pending();
  ${C_SWEEP}();
  ${cContextField("youngCount")} = 0;
  ${cContextField("rememberedCount")} = 0;
  ${C_NURSERY_RESET}();
}

static void ${TERA_MINOR_SYMBOL}(void) {
  if (${cContextField("rememberedCount")} == ${TERA_REMEMBERED_CAPACITY}u) {
    ${TERA_COLLECT_SYMBOL}();
    return;
  }
  int32_t overflowed = 0;
  for (size_t at = 0; at < ${cContextField("rootCount")}; at++) {
    overflowed |= ${C_MARK_YOUNG}(${cContextField("rootsBase")}[at]);
  }
  for (uint32_t at = 0; at < ${TERA_STATIC_ROOT_COUNT.symbol}; at++) {
    overflowed |= ${C_MARK_YOUNG}(*(unsigned char **)(${TERA_STATICS.symbol} + ${TERA_STATIC_ROOTS.symbol}[at]));
  }
  overflowed |= ${C_MARK_YOUNG}(${cContextField("waitHead")});
  overflowed |= ${C_MARK_YOUNG}(${cContextField("sweepHead")});
  overflowed |= ${C_MARK_YOUNG}(${cContextField("queueHead")});
  overflowed |= ${C_MARK_YOUNG}(${cContextField("rejectedHead")});
  overflowed |= ${C_MARK_YOUNG}(${cContextField("rejectedText")});
  for (size_t at = 0; at < ${cContextField("rememberedCount")}; at++) {
    unsigned char *block = ${cContextField("rememberedBase")}[at];
    uint32_t references = ${C_REFERENCE_COUNT}(block);
    for (uint32_t index = 0; index < references; index++) {
      overflowed |= ${C_MARK_YOUNG}(${C_REFERENCE_AT}(block, index));
    }
    *(uint32_t *)(block + ${CLASS_FLAGS_OFFSET}) &= ~(uint32_t)${TERA_REMEMBERED_FLAG}u;
  }
  ${cContextField("rememberedCount")} = 0;
  while (overflowed != 0) overflowed = tera_mark_young_pending();
  ${C_SWEEP_YOUNG}();
  ${C_NURSERY_RESET}();
}

static void ${TERA_RESERVE_SYMBOL}(void) {
  unsigned char *base = ${C_MAP}(${cContextField("arenaReserved")});
  if (base == 0) exit(${TERA_EXIT_HEAP_EXHAUSTED});
  size_t first = ${TERA_HEAP_COMMIT_BYTES} < ${cContextField("arenaReserved")}
    ? ${TERA_HEAP_COMMIT_BYTES}
    : ${cContextField("arenaReserved")};
  if (${C_COMMIT}(base, first) == 0) exit(${TERA_EXIT_HEAP_EXHAUSTED});
  ${cContextField("arenaBase")} = base;
  ${cContextField("arenaCommitted")} = first;
  ${C_NURSERY_RESET}();
}

static int32_t ${TERA_GROW_SYMBOL}(size_t size) {
  size_t wanted = ${cContextField("arenaCommitted")} * 2;
  size_t needed = ${cContextField("arenaCursor")} + size;
  if (wanted < needed) wanted = needed;
  if (wanted > ${cContextField("arenaReserved")}) wanted = ${cContextField("arenaReserved")};
  if (wanted <= ${cContextField("arenaCommitted")}) return 0;
  if (${C_COMMIT}(${cContextField("arenaBase")}, wanted) == 0) return 0;
  ${cContextField("arenaCommitted")} = wanted;
  ${C_NURSERY_RESET}();
  return 1;
}

static unsigned char *${C_BUMP}(size_t size) {
  if (${cContextField("arenaCursor")} + size > ${cContextField("arenaCommitted")}) return 0;
  unsigned char *object = ${cContextField("arenaBase")} + ${cContextField("arenaCursor")};
  ${cContextField("arenaCursor")} += size;
  return object;
}

static unsigned char *${C_TAKE}(size_t size) {
  unsigned char *previous = 0;
  unsigned char *at = ${cContextField("freeHead")};
  while (at != 0) {
    size_t bytes = ${C_BLOCK_SIZE}(at);
    unsigned char *next = *(unsigned char **)(at + ${CLASS_HEADER_BYTES});
    size_t rest = bytes - size;
    if (bytes == size || (bytes > size && rest >= ${CLASS_HEADER_BYTES} + ${TERA_LINK_BYTES})) {
      if (previous == 0) ${cContextField("freeHead")} = next;
      else *(unsigned char **)(previous + ${CLASS_HEADER_BYTES}) = next;
      if (bytes != size) {
        unsigned char *tail = at + size;
        *(uint32_t *)tail = ${TERA_FREE_SHAPE_ID}u;
        *(uint32_t *)(tail + ${CLASS_FLAGS_OFFSET}) = (uint32_t)rest;
        *(unsigned char **)(tail + ${CLASS_HEADER_BYTES}) = ${cContextField("freeHead")};
        ${cContextField("freeHead")} = tail;
      }
      return at;
    }
    previous = at;
    at = next;
  }
  return 0;
}

static unsigned char *${TERA_ALLOC_SYMBOL}(size_t size, int32_t shape_id) {
  if (${cContextField("arenaBase")} == 0) ${TERA_RESERVE_SYMBOL}();
  if (${cContextField("youngCount")} == ${TERA_YOUNG_CAPACITY}u) ${TERA_MINOR_SYMBOL}();
  unsigned char *object = ${C_BUMP}(size);
  if (object == 0) object = ${C_TAKE}(size);
  if (object == 0 && ${cContextField("youngCount")} > 0) {
    ${TERA_MINOR_SYMBOL}();
    object = ${C_BUMP}(size);
    if (object == 0) object = ${C_TAKE}(size);
  }
  if (object == 0) {
    ${TERA_COLLECT_SYMBOL}();
    object = ${C_BUMP}(size);
    if (object == 0) object = ${C_TAKE}(size);
  }
  if (object == 0 && ${TERA_GROW_SYMBOL}(size) != 0) object = ${C_BUMP}(size);
  if (object == 0) exit(${TERA_EXIT_HEAP_EXHAUSTED});
  for (size_t at = 0; at < size; at++) object[at] = 0;
  *(uint32_t *)object = (uint32_t)shape_id;
  *(uint32_t *)(object + ${CLASS_FLAGS_OFFSET}) = (uint32_t)size;
  ${C_NOTE_YOUNG}(object);
  ${C_NURSERY_RESET}();
  return object;
}

static inline unsigned char *${C_ARRAY_RESERVE}(unsigned char *array, int32_t shape_id, int32_t stride) {
  int32_t length = *(const int32_t *)(array + ${ARRAY_LENGTH_OFFSET});
  int32_t capacity = *(const int32_t *)(array + ${ARRAY_CAPACITY_OFFSET});
  unsigned char *elements = *(unsigned char **)(array + ${ARRAY_ELEMENTS_OFFSET});
  if (length < capacity) return elements;
  int32_t grown = capacity == 0 ? ${ARRAY_INITIAL_CAPACITY} : capacity * ${ARRAY_GROWTH_FACTOR};
  size_t bytes = ${BUFFER_ELEMENTS_OFFSET} + (size_t)grown * (size_t)stride;
  bytes = (bytes + ${CLASS_ALIGNMENT_BYTES} - 1u) / ${CLASS_ALIGNMENT_BYTES} * ${CLASS_ALIGNMENT_BYTES};
  unsigned char *fresh = ${TERA_ALLOC_SYMBOL}(bytes, shape_id);
  memcpy(
    fresh + ${BUFFER_ELEMENTS_OFFSET},
    elements + ${BUFFER_ELEMENTS_OFFSET},
    (size_t)length * (size_t)stride);
  *(int32_t *)(array + ${ARRAY_CAPACITY_OFFSET}) = grown;
  ${C_BARRIER}(array, fresh);
  *(unsigned char **)(array + ${ARRAY_ELEMENTS_OFFSET}) = fresh;
  if (length > 0 && ${TERA_CLASS_RECORD.symbol}[shape_id].tail != 0u && !${C_IS_YOUNG}(fresh)) {
    ${C_REMEMBER}(fresh);
  }
  return fresh;
}`;

const C_ABSENT_NUMBER = `tera_f64_of_bits(${FLOAT64_NULL_BITS}ull)`;
const EMPTY_TERMINATOR = NO_TERMINATOR;

const C_ABSENCE_SUPPORT = `static inline double tera_f64_of_bits(uint64_t bits) {
  double value;
  memcpy(&value, &bits, sizeof(value));
  return value;
}

static inline uint64_t tera_f64_bits(double value) {
  uint64_t bits;
  memcpy(&bits, &value, sizeof(bits));
  return bits;
}`;

const C_BUILTIN_SUPPORT = [
  C_FLOAT_SUPPORT,
  C_STRING_SUPPORT,
  C_ABSENCE_SUPPORT,
  ...[...C_BUILTIN_METHODS.values(), ...C_PRINT_HELPERS.values()]
    .map((method) => method.definition)
    .filter((definition) => definition.length > 0),
].join("\n\n");

export const C_SOURCE_PREAMBLE = `${C_HEADER_PREAMBLE}\n\n${C_RUNTIME_SUPPORT}\n\n${C_HEAP_SUPPORT}\n\n${C_BUILTIN_SUPPORT}`;

export type CEmitResult =
  | {
      readonly ok: true;
      readonly symbol: string;
      readonly parameterCount: number;
      readonly parameterScalars: readonly AotScalar[];
      readonly returnScalar: AotScalar;
      readonly prototype: string;
      readonly source: string;
      readonly headerPreamble: string;
      readonly sourcePreamble: string;
      readonly translationUnitPreamble: string;
      readonly references: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const INT32_HELPERS = new Map<string, string>([
  [IR_INT32_ADD, "tera_i32_add"],
  [IR_INT32_SUB, "tera_i32_sub"],
  [IR_INT32_MUL, "tera_i32_mul"],
  [IR_INT32_DIV, "tera_i32_div"],
  [IR_INT32_MOD, "tera_i32_mod"],
  [IR_INT32_SHL, "tera_i32_shl"],
  [IR_INT32_SHR, "tera_i32_shr"],
  [IR_INT32_USHR, "tera_u32_shr"],
]);

const INT32_OPERATORS = new Map<string, string>([
  [IR_INT32_AND, "&"],
  [IR_INT32_OR, "|"],
  [IR_INT32_XOR, "^"],
]);

const FLOAT_OPERATORS = new Map<string, string>([
  [IR_FLOAT64_ADD, "+"],
  [IR_FLOAT64_SUB, "-"],
  [IR_FLOAT64_MUL, "*"],
  [IR_FLOAT64_DIV, "/"],
]);

const COMPARE_OPERATORS = new Map<string, string>([
  ["==", "=="],
  ["loose==", "=="],
  ["!=", "!="],
  ["loose!=", "!="],
  ["<", "<"],
  [">", ">"],
  ["<=", "<="],
  [">=", ">="],
]);

const SKIPPED_IN_BLOCK = new Set<string>([IR_PARAMETER, IR_PHI, IR_CONSTANT]);

const C_HEAP_IDENTIFIERS: readonly string[] = [
  TERA_ALLOC_SYMBOL,
  TERA_COLLECT_SYMBOL,
  TERA_CONTEXT.symbol,
  TERA_ROOTS.symbol,
  TERA_MARKS.symbol,
  TERA_STATICS.symbol,
  TERA_CLASS_RECORD.symbol,
  TERA_STATIC_ROOTS.symbol,
  TERA_STATIC_ROOT_COUNT.symbol,
  C_BLOCK_SIZE,
  C_BUMP,
  C_CLASS_FIELDS_PREFIX,
  C_CLASS_TYPE,
  C_CONTEXT_TYPE,
  C_MARK,
  C_ROOT_BASE,
  C_SWEEP,
  C_TAKE,
];

const RESERVED_C_IDENTIFIERS = new Set<string>([
  ...C_KEYWORDS,
  ...C_LIBRARY_NAMES,
  ...INT32_HELPERS.values(),
  ...[...C_BUILTIN_METHODS.values()].map((method) => method.helper),
  ...[...C_PRINT_HELPERS.values()].map((method) => method.helper),
  ...C_HEAP_IDENTIFIERS,
  "tera_i32_neg",
  "tera_to_i32",
]);

function formatDouble(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

export function cIdentifier(name: string): string {
  return sanitizeSymbol(name, RESERVED_C_IDENTIFIERS);
}

function cStringLiteral(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"' || character === "\\") out += `\\${character}`;
    else if (character === "\n") out += "\\n";
    else if (character === "\t") out += "\\t";
    else if (code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += character;
  }
  return `${out}"`;
}

interface CBuiltinMethod {
  readonly helper: string;
  readonly definition: string;
}

interface EmitContext {
  readonly node: CFGInstruction;
  nameOf(value: CFGInstruction): string;
  emit(line: string): void;
  copyEdge(from: CFGBlock, to: CFGBlock): void;
  labelOf(block: CFGBlock): string;
}

function reversePostOrder(graph: CFGFunction): CFGBlock[] {
  const order: CFGBlock[] = [];
  const entered = new Set<CFGBlock>();
  const pending: Array<{ readonly block: CFGBlock; at: number }> = [];
  const open = (block: CFGBlock): void => {
    if (entered.has(block)) return;
    entered.add(block);
    pending.push({ block, at: 0 });
  };
  for (const start of graph.entry === null ? graph.blocks : [graph.entry, ...graph.blocks]) {
    open(start);
    while (pending.length > 0) {
      const frame = pending[pending.length - 1]!;
      const successor = frame.block.successors[frame.at++];
      if (successor === undefined) {
        order.push(frame.block);
        pending.pop();
        continue;
      }
      open(successor);
    }
  }
  return order.reverse();
}

class CFunctionEmitter {
  private readonly order: CFGBlock[];
  private readonly names = new Map<CFGInstruction, string>();
  private readonly bufferNames = new Map<AotStringBuffer, string>();
  private readonly blockPhis: CFGInstruction[] = [];
  private readonly constantDeclarations: string[] = [];
  private readonly references = new Set<string>();
  private readonly rootSlots = new Map<CFGInstruction, number>();
  private readonly body: string[] = [];
  private readonly dispatch = buildDispatch<string, EmitContext>(this.handlers());

  private tempSeq = 0;

  constructor(
    private readonly graph: CFGFunction,
    private readonly legality: AotLegality,
  ) {
    this.order = reversePostOrder(graph);
  }

  emit(): CEmitResult {
    this.assignNames();
    this.declareStringBuffers();
    this.declareConstants();
    for (const block of this.order) this.emitBlock(block);

    const symbol = cIdentifier(this.graph.name);
    const signature = this.signature(symbol);
    return {
      ok: true,
      symbol,
      parameterCount: this.graph.parameters.length,
      parameterScalars: this.legality.parameterScalars,
      returnScalar: this.legality.returnScalar,
      prototype: `${signature};`,
      source: this.render(signature),
      headerPreamble: C_HEADER_PREAMBLE,
      sourcePreamble: this.preamble(),
      translationUnitPreamble: this.translationUnit(),
      references: [...this.references],
    };
  }

  private typeNameOf(value: CFGInstruction): CScalarType {
    return cTypeOf(this.legality.scalarOf(value));
  }

  private isInt32(value: CFGInstruction): boolean {
    return this.legality.scalarOf(value) === SCALAR_INT32;
  }

  private reserveRoot(value: CFGInstruction): void {
    if (!isRootedPointer(this.legality, value)) return;
    this.rootSlots.set(value, this.rootSlots.size);
  }

  private rootStore(value: CFGInstruction): string | null {
    const slot = this.rootSlots.get(value);
    if (slot === undefined) return null;
    return `${cContextField("rootsBase")}[${C_ROOT_BASE} + ${slot}] = (unsigned char *)${this.nameOf(value)};`;
  }

  private assignNames(): void {
    const taken = this.calledSymbols();
    const fresh = (prefix: string, sequence: number): [string, number] => {
      let name = `${prefix}${sequence}`;
      while (taken.has(name)) name = `${prefix}${++sequence}`;
      return [name, sequence + 1];
    };
    for (const param of this.graph.parameters) {
      this.names.set(param, fresh("p", Number(param.props.index))[0]);
    }
    let phiSeq = 0;
    let valueSeq = 0;
    for (const constant of this.legality.constants) {
      const [name, next] = fresh("v", valueSeq);
      this.names.set(constant, name);
      valueSeq = next;
    }
    for (const block of this.order) {
      for (const phi of block.phis) {
        const [name, next] = fresh("b", phiSeq);
        this.names.set(phi, name);
        phiSeq = next;
        this.blockPhis.push(phi);
      }
      for (const node of block.nodes) {
        if (this.names.has(node)) continue;
        const [name, next] = fresh("v", valueSeq);
        this.names.set(node, name);
        valueSeq = next;
      }
    }
    for (const param of this.graph.parameters) this.reserveRoot(param);
    for (const phi of this.blockPhis) this.reserveRoot(phi);
    for (const block of this.order) {
      for (const node of block.nodes) this.reserveRoot(node);
    }
  }

  private calledSymbols(): ReadonlySet<string> {
    const reserved = new Set<string>([cIdentifier(this.graph.name)]);
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        const callee = calleeSymbolName(node);
        if (callee !== null) reserved.add(cIdentifier(callee));
      }
    }
    return reserved;
  }

  private declareStringBuffers(): void {
    let sequence = 0;
    for (const buffer of this.legality.stringBuffers) {
      const name = `${C_STRING_BUFFER_PREFIX}${sequence++}`;
      this.bufferNames.set(buffer, name);
      this.constantDeclarations.push(`static char ${name}[${buffer.capacity}];`);
    }
  }

  private bufferNameOf(node: CFGInstruction): string {
    const buffer = this.legality.stringBufferOf(node);
    const name = buffer === null ? undefined : this.bufferNames.get(buffer);
    if (name === undefined) throw new Error(`no string buffer for v${node.id}`);
    return name;
  }

  private bufferCapacityOf(node: CFGInstruction): number {
    return this.legality.stringBufferOf(node)!.capacity;
  }

  private emitStringConcat(ctx: EmitContext): void {
    const name = this.bufferNameOf(ctx.node);
    const capacity = this.bufferCapacityOf(ctx.node);
    const left = this.nameOf(ctx.node.inputs[0]!);
    const right = this.nameOf(ctx.node.inputs[1]!);
    this.define(
      ctx,
      `${C_STRING_APPEND}(${C_STRING_SET}(${name}, ${capacity}, ${left}), ${capacity}, ${right})`,
    );
  }

  private declareConstants(): void {
    for (const constant of this.legality.constants) {
      const value = constant.props.value;
      const name = this.nameOf(constant);
      if (typeof value === "string") {
        this.constantDeclarations.push(
          `${declarationOf(C_STRING, name)} = ${cStringLiteral(value)};`,
        );
        continue;
      }
      const compiled = codeSymbolOf(constant);
      if (compiled !== null) {
        this.references.add(cIdentifier(compiled));
        this.constantDeclarations.push(
          `${declarationOf(C_CODE, name)} = (${C_CODE})${cIdentifier(compiled)};`,
        );
        continue;
      }
      if (value === null) {
        const absent =
          this.legality.scalarOf(constant) === SCALAR_FLOAT64 ? C_ABSENT_NUMBER : "0";
        this.constantDeclarations.push(
          `${declarationOf(this.typeNameOf(constant), name)} = ${absent};`,
        );
        continue;
      }
      const expression =
        typeof value === "boolean"
          ? value
            ? "1"
            : "0"
          : this.isInt32(constant)
            ? String(Number(value) | 0)
            : formatDouble(Number(value));
      this.constantDeclarations.push(
        `const ${declarationOf(this.typeNameOf(constant), name)} = ${expression};`,
      );
    }
  }

  private emitBlock(block: CFGBlock): void {
    if (block.predecessors.length > 0) this.body.push(`${this.labelOf(block)}:;`);
    for (const node of block.nodes) {
      if (SKIPPED_IN_BLOCK.has(node.type)) continue;
      if (!this.dispatch(node.type, this.contextFor(node))) {
        throw new Error(`C backend has no lowering for admitted opcode ${node.type}`);
      }
    }
  }

  private define(ctx: EmitContext, expression: string): void {
    ctx.emit(
      `${immutableDeclarationOf(this.typeNameOf(ctx.node), ctx.nameOf(ctx.node))} = ${expression};`,
    );
    const rooted = this.rootStore(ctx.node);
    if (rooted !== null) ctx.emit(rooted);
  }

  private asDouble(value: CFGInstruction): string {
    return `(double)${this.nameOf(value)}`;
  }

  private asInt32(value: CFGInstruction): string {
    return this.isInt32(value) ? this.nameOf(value) : `tera_to_i32(${this.nameOf(value)})`;
  }

  handlers(): Array<readonly [string, (ctx: EmitContext) => void]> {
    const entries: Array<readonly [string, (ctx: EmitContext) => void]> = [];

    entries.push([IR_CALL_BUILTIN, (ctx) => this.emitBuiltinCall(ctx)]);
    entries.push([IR_GENERIC_ADD, (ctx) => this.emitStringConcat(ctx)]);
    entries.push([IR_CALL_KNOWN_FUNCTION, (ctx) => this.emitKnownCall(ctx)]);
    entries.push([IR_GENERIC_CALL, (ctx) => this.emitCallThrough(ctx)]);
    entries.push([IR_NEW_OBJECT, (ctx) => this.emitNewObject(ctx)]);
    entries.push([IR_ARRAY_RESERVE, (ctx) => this.emitArrayReserve(ctx)]);
    entries.push([
      IR_RUNTIME_BASE,
      (ctx) => this.define(ctx, `(unsigned char *)&${String(ctx.node.props.symbol)}`),
    ]);
    entries.push([IR_LOAD_FIELD, (ctx) => this.emitLoadField(ctx)]);
    entries.push([IR_STORE_FIELD, (ctx) => this.emitStoreField(ctx)]);
    entries.push([IR_LOAD_TEXT, (ctx) => this.emitLoadText(ctx)]);
    entries.push([IR_STORE_TEXT, (ctx) => this.emitStoreText(ctx)]);
    entries.push([IR_LOAD_ELEMENT, (ctx) => this.emitLoadElement(ctx)]);
    entries.push([IR_GENERIC_GET_INDEX, (ctx) => this.emitLoadElement(ctx)]);
    entries.push([IR_STORE_ELEMENT, (ctx) => this.emitStoreElement(ctx)]);
    entries.push([IR_GENERIC_SET_INDEX, (ctx) => this.emitStoreElement(ctx)]);
    entries.push([IR_NEG, (ctx) => this.emitNegate(ctx)]);
    entries.push([IR_SELECT, (ctx) => this.emitSelect(ctx)]);
    entries.push([IR_NOT, (ctx) => this.emitLogicalNot(ctx)]);
    entries.push([IR_INT32_NOT, (ctx) => this.define(ctx, `~${this.asInt32(ctx.node.inputs[0]!)}`)]);
    entries.push([IR_INT32_COMPARE, (ctx) => this.emitCompare(ctx, false)]);
    entries.push([IR_FLOAT64_COMPARE, (ctx) => this.emitCompare(ctx, true)]);
    entries.push([IR_GENERIC_COMPARE, (ctx) => this.emitStringCompare(ctx)]);
    entries.push([IR_LOAD_GLOBAL, (ctx) => this.emitCodeAddress(ctx)]);
    entries.push([IR_RETURN, (ctx) => this.emitReturn(ctx)]);
    entries.push([IR_JUMP, (ctx) => this.emitJump(ctx)]);
    entries.push([IR_BRANCH, (ctx) => this.emitBranch(ctx)]);

    for (const [opcode, helper] of INT32_HELPERS) {
      entries.push([
        opcode,
        (ctx) =>
          this.define(
            ctx,
            `${helper}(${this.asInt32(ctx.node.inputs[0]!)}, ${this.asInt32(ctx.node.inputs[1]!)})`,
          ),
      ]);
    }
    for (const [opcode, operator] of INT32_OPERATORS) {
      entries.push([
        opcode,
        (ctx) =>
          this.define(
            ctx,
            `${this.asInt32(ctx.node.inputs[0]!)} ${operator} ${this.asInt32(ctx.node.inputs[1]!)}`,
          ),
      ]);
    }
    for (const [opcode, operator] of FLOAT_OPERATORS) {
      entries.push([
        opcode,
        (ctx) =>
          this.define(
            ctx,
            `${this.asDouble(ctx.node.inputs[0]!)} ${operator} ${this.asDouble(ctx.node.inputs[1]!)}`,
          ),
      ]);
    }

    return entries;
  }

  private emitSelect(ctx: EmitContext): void {
    const [condition, whenTrue, whenFalse] = ctx.node.inputs as [
      CFGInstruction,
      CFGInstruction,
      CFGInstruction,
    ];
    const chosen = this.isInt32(ctx.node)
      ? [this.asInt32(whenTrue), this.asInt32(whenFalse)]
      : [this.asDouble(whenTrue), this.asDouble(whenFalse)];
    this.define(ctx, `${this.nameOf(condition)} ? ${chosen[0]} : ${chosen[1]}`);
  }

  private printerFor(scalar: AotScalar): string {
    const method = C_PRINT_HELPERS.get(scalar);
    if (method === undefined) {
      throw new Error(`C backend cannot print an admitted ${scalar} value`);
    }
    return method.helper;
  }

  private emitPrint(ctx: EmitContext): void {
    const arity = ctx.node.inputs.length;
    ctx.node.inputs.forEach((value, index) => {
      const terminator = printTerminatorOf(ctx.node, index, arity);
      ctx.emit(`${this.printerFor(this.legality.scalarOf(value))}(${this.nameOf(value)}, ${terminator});`);
    });
  }

  private emitBuiltinCall(ctx: EmitContext): void {
    const name = String(ctx.node.props.name);
    if (name === PRINT_BUILTIN) {
      this.emitPrint(ctx);
      return;
    }
    const method = C_BUILTIN_METHODS.get(name);
    const intrinsic = builtinIntrinsicByName(name);
    if (method === undefined || intrinsic === null) {
      throw new Error(`C backend has no helper for admitted builtin ${name}`);
    }
    const operands = ctx.node.inputs.map((input, index) => {
      const expected = builtinOperandScalar(builtinParameterAt(intrinsic, index));
      if (expected === SCALAR_INT32) return this.asInt32(input);
      if (expected === SCALAR_STRING) return this.nameOf(input);
      return this.asDouble(input);
    });
    if (this.legality.stringBufferOf(ctx.node)?.producer === ctx.node) {
      operands.unshift(this.bufferNameOf(ctx.node), String(this.bufferCapacityOf(ctx.node)));
    }
    const call = `${method.helper}(${operands.join(", ")})`;
    const produced = isStorableScalar(builtinOperandScalar(intrinsic.signature.returns));
    if (produced === null) ctx.emit(`${call};`);
    else this.define(ctx, call);
  }

  private codeCastOf(signature: DeclaredSignature): string {
    const params = signature.params.map((param) =>
      cTypeOf(declaredAotScalar(param, this.graph.classes) ?? SCALAR_FLOAT64),
    );
    const returns = cTypeOf(declaredAotScalar(signature.returns, this.graph.classes) ?? SCALAR_VOID);
    return `${returns} (*)(${params.length > 0 ? params.join(", ") : "void"})`;
  }

  private emitCodeAddress(ctx: EmitContext): void {
    const named = codeSymbolOf(ctx.node);
    if (named === null) return;
    const symbol = cIdentifier(named);
    this.references.add(symbol);
    ctx.emit(
      `${declarationOf(C_CODE, ctx.nameOf(ctx.node))} = (${C_CODE})${symbol};`,
    );
  }

  private emitCallThrough(ctx: EmitContext): void {
    const callee = ctx.node.inputs[0]!;
    const signature = this.legality.codeSignatureOf(callee)!;
    const args = callThroughArguments(ctx.node).map((input) => this.nameOf(input)).join(", ");
    const call = `((${this.codeCastOf(signature)})${this.nameOf(callee)})(${args})`;
    if (ctx.node.uses.length === 0) ctx.emit(`${call};`);
    else this.define(ctx, call);
  }

  private emitKnownCall(ctx: EmitContext): void {
    const callee = cIdentifier(calleeSymbolName(ctx.node)!);
    this.references.add(callee);
    const args = ctx.node.inputs.map((input) => this.nameOf(input)).join(", ");
    if (ctx.node.uses.length === 0) ctx.emit(`${callee}(${args});`);
    else this.define(ctx, `${callee}(${args})`);
  }

  private fieldAccess(node: CFGInstruction, scalar: AotScalar): string {
    const receiver = this.nameOf(node.inputs[0]!);
    return `(*(${cTypeOf(scalar)} *)(${receiver} + ${fieldOffsetOf(node)}))`;
  }

  private emitNewObject(ctx: EmitContext): void {
    const shape = allocationShapeOf(ctx.node);
    this.define(ctx, `${TERA_ALLOC_SYMBOL}(${shape.size}, ${shape.id})`);
  }

  private emitArrayReserve(ctx: EmitContext): void {
    const growth = arrayReserveOf(ctx.node);
    const array = this.nameOf(ctx.node.inputs[0]!);
    this.define(
      ctx,
      `${C_ARRAY_RESERVE}(${array}, ${growth.buffer}, ${growth.elementBytes})`,
    );
  }

  private emitLoadField(ctx: EmitContext): void {
    this.define(ctx, this.fieldAccess(ctx.node, fieldScalarOf(ctx.node)));
  }

  private emitStoreField(ctx: EmitContext): void {
    const value = ctx.node.inputs[1]!;
    const scalar = fieldScalarOf(ctx.node);
    const access = this.fieldAccess(ctx.node, scalar);
    this.emitBarrier(ctx, scalar, ctx.node.inputs[0]!, value);
    const store = `${access} = ${this.asScalar(value, scalar)}`;
    if (ctx.node.uses.length === 0) ctx.emit(`${store};`);
    else this.define(ctx, `(${store})`);
  }

  private emitBarrier(
    ctx: EmitContext,
    scalar: AotScalar | null,
    target: CFGInstruction,
    value: CFGInstruction,
  ): void {
    if (scalar !== SCALAR_POINTER) return;
    if (target.type === IR_RUNTIME_BASE) return;
    ctx.emit(`${C_BARRIER}(${this.nameOf(target)}, ${this.nameOf(value)});`);
  }

  private textAddress(node: CFGInstruction): string {
    return `(char *)(${this.nameOf(node.inputs[0]!)} + ${fieldOffsetOf(node)})`;
  }

  private emitLoadText(ctx: EmitContext): void {
    this.define(ctx, this.textAddress(ctx.node));
  }

  private emitStoreText(ctx: EmitContext): void {
    const value = this.nameOf(ctx.node.inputs[1]!);
    ctx.emit(
      `${C_STRING_SET}(${this.textAddress(ctx.node)}, ${textCapacityOf(ctx.node)}, ${value});`,
    );
  }

  private asScalar(value: CFGInstruction, scalar: AotScalar): string {
    if (scalar === SCALAR_INT32) return this.asInt32(value);
    if (scalar === SCALAR_FLOAT64) return this.asDouble(value);
    return this.nameOf(value);
  }

  private elementAccess(node: CFGInstruction, scalar: AotScalar | null): string {
    const array = this.nameOf(node.inputs[0]!);
    const index = this.asInt32(node.inputs[1]!);
    if (scalar === null) return `${array}[${index}]`;
    return `((${cTypeOf(scalar)} *)(${array} + ${fieldOffsetOf(node)}))[${index}]`;
  }

  private elementTextAddress(node: CFGInstruction): string {
    const array = this.nameOf(node.inputs[0]!);
    const index = this.asInt32(node.inputs[1]!);
    const stride = scalarWidth(SCALAR_TEXT);
    return `(char *)(${array} + ${fieldOffsetOf(node)} + (size_t)(${index}) * ${stride})`;
  }

  private emitLoadElement(ctx: EmitContext): void {
    const scalar = heapElementScalarOf(ctx.node);
    if (scalar === SCALAR_TEXT) {
      this.define(ctx, this.elementTextAddress(ctx.node));
      return;
    }
    this.define(ctx, this.elementAccess(ctx.node, scalar));
  }

  private emitStoreElement(ctx: EmitContext): void {
    const scalar = heapElementScalarOf(ctx.node);
    const value = ctx.node.inputs[2]!;
    if (scalar === SCALAR_TEXT) {
      const address = this.elementTextAddress(ctx.node);
      ctx.emit(
        `${C_STRING_SET}(${address}, ${scalarWidth(SCALAR_TEXT)}, ${this.nameOf(value)});`,
      );
      return;
    }
    const stored = scalar === null ? this.nameOf(value) : this.asScalar(value, scalar);
    this.emitBarrier(ctx, scalar, ctx.node.inputs[0]!, value);
    const store = `${this.elementAccess(ctx.node, scalar)} = ${stored}`;
    if (ctx.node.uses.length === 0) ctx.emit(`${store};`);
    else this.define(ctx, `(${store})`);
  }

  private emitNegate(ctx: EmitContext): void {
    const operand = ctx.node.inputs[0]!;
    this.define(
      ctx,
      this.isInt32(ctx.node)
        ? `tera_i32_neg(${this.asInt32(operand)})`
        : `-${this.asDouble(operand)}`,
    );
  }

  private emitLogicalNot(ctx: EmitContext): void {
    this.define(ctx, `${this.nameOf(ctx.node.inputs[0]!)} == 0`);
  }

  private emitCompare(ctx: EmitContext, asDouble: boolean): void {
    if (asDouble && this.comparesReferences(ctx.node)) {
      this.emitStringCompare(ctx);
      return;
    }
    const operator = COMPARE_OPERATORS.get(String(ctx.node.props.op));
    if (operator === undefined) {
      throw new Error(`C backend has no lowering for comparison ${String(ctx.node.props.op)}`);
    }
    const left = ctx.node.inputs[0]!;
    const right = ctx.node.inputs[1]!;
    const lhs = asDouble ? this.asDouble(left) : this.nameOf(left);
    const rhs = asDouble ? this.asDouble(right) : this.nameOf(right);
    this.define(ctx, `${lhs} ${operator} ${rhs}`);
  }

  private comparesReferences(node: CFGInstruction): boolean {
    return node.inputs.every((input) => this.legality.scalarOf(input) === SCALAR_POINTER);
  }

  private emitStringCompare(ctx: EmitContext): void {
    const operator = COMPARE_OPERATORS.get(String(ctx.node.props.op));
    if (operator === undefined) {
      throw new Error(`C backend has no lowering for comparison ${String(ctx.node.props.op)}`);
    }
    const left = this.nameOf(ctx.node.inputs[0]!);
    const right = this.nameOf(ctx.node.inputs[1]!);
    if (this.comparesReferences(ctx.node)) {
      this.define(ctx, `${left} ${operator} ${right}`);
      return;
    }
    if (ctx.node.inputs.some(isAbsenceConstant)) {
      this.define(
        ctx,
        this.legality.absenceComparesAsNumber(ctx.node)
          ? `tera_f64_bits(${left}) ${operator} tera_f64_bits(${right})`
          : `(const void *)${left} ${operator} (const void *)${right}`,
      );
      return;
    }
    this.define(ctx, `strcmp(${left}, ${right}) ${operator} 0`);
  }

  private emitReturn(ctx: EmitContext): void {
    if (this.rootSlots.size > 0) ctx.emit(`${cContextField("rootCount")} = ${C_ROOT_BASE};`);
    if (this.legality.returnScalar === SCALAR_VOID) {
      ctx.emit("return;");
      return;
    }
    if (isPendingThrowReturn(ctx.node)) {
      ctx.emit(`return (${cTypeOf(this.legality.returnScalar)})0;`);
      return;
    }
    ctx.emit(`return ${this.nameOf(ctx.node.inputs[0]!)};`);
  }

  private emitJump(ctx: EmitContext): void {
    const target = this.successorByProp(ctx.node.block!, "targetBlock");
    ctx.copyEdge(ctx.node.block!, target);
    ctx.emit(`goto ${ctx.labelOf(target)};`);
  }

  private emitBranch(ctx: EmitContext): void {
    const source = ctx.node.block!;
    const trueBlock = this.successorByProp(source, "trueBlock");
    const falseBlock = this.successorByProp(source, "falseBlock");
    ctx.emit(`if (${this.nameOf(ctx.node.inputs[0]!)} != 0) {`);
    ctx.copyEdge(source, trueBlock);
    ctx.emit(`goto ${ctx.labelOf(trueBlock)};`);
    ctx.emit(`} else {`);
    ctx.copyEdge(source, falseBlock);
    ctx.emit(`goto ${ctx.labelOf(falseBlock)};`);
    ctx.emit(`}`);
  }

  private successorByProp(block: CFGBlock, prop: string): CFGBlock {
    const terminator = block.getTerminator()!;
    const targetId = terminator.props[prop];
    for (const successor of block.successors) {
      if (successor.id === targetId) return successor;
    }
    throw new Error(`block ${block.id} has no successor for ${prop}`);
  }

  private copyEdge(from: CFGBlock, to: CFGBlock): void {
    const phis = to.phis;
    if (phis.length === 0) return;
    const predIndex = to.predecessors.indexOf(from);
    if (predIndex < 0) {
      throw new Error(`edge B${from.id}->B${to.id} is not a predecessor edge`);
    }
    const temps: string[] = [];
    for (const phi of phis) {
      const temp = `t${this.tempSeq++}`;
      temps.push(temp);
      this.body.push(
        `${immutableDeclarationOf(this.typeNameOf(phi), temp)} = ${this.nameOf(phi.inputs[predIndex]!)};`,
      );
    }
    for (let i = 0; i < phis.length; i++) {
      this.body.push(`${this.nameOf(phis[i]!)} = ${temps[i]!};`);
      const rooted = this.rootStore(phis[i]!);
      if (rooted !== null) this.body.push(rooted);
    }
  }

  private contextFor(node: CFGInstruction): EmitContext {
    return {
      node,
      nameOf: (value) => this.nameOf(value),
      emit: (line) => this.body.push(line),
      copyEdge: (from, to) => this.copyEdge(from, to),
      labelOf: (block) => this.labelOf(block),
    };
  }

  private nameOf(value: CFGInstruction): string {
    return this.names.get(value) ?? `v${value.id}`;
  }

  private labelOf(block: CFGBlock): string {
    return `L${block.id}`;
  }

  private signature(symbol: string): string {
    return prototypeOf(symbol, this.legality.returnScalar, this.legality.parameterScalars);
  }

  private rootFrame(): string[] {
    if (this.rootSlots.size === 0) return [];
    const count = this.rootSlots.size;
    return [
      `  const size_t ${C_ROOT_BASE} = ${cContextField("rootCount")};`,
      `  if (${C_ROOT_BASE} + ${count} > ${TERA_ROOT_CAPACITY}) exit(${TERA_EXIT_HEAP_EXHAUSTED});`,
      `  ${cContextField("rootCount")} = ${C_ROOT_BASE} + ${count};`,
      `  for (size_t at = ${C_ROOT_BASE}; at < ${cContextField("rootCount")}; at++) ${cContextField("rootsBase")}[at] = 0;`,
      ...this.graph.parameters
        .map((param) => this.rootStore(param))
        .filter((store): store is string => store !== null)
        .map((store) => `  ${store}`),
    ];
  }

  private preamble(): string {
    return `${C_HEADER_PREAMBLE}\n\n${this.translationUnit()}`;
  }

  private translationUnit(): string {
    return [
      C_CODE_TYPEDEF,
      C_RUNTIME_SUPPORT,
      cClassTable(this.graph.classes),
      C_HEAP_SUPPORT,
      C_BUILTIN_SUPPORT,
    ].join("\n\n");
  }

  private render(signature: string): string {
    const declarations: string[] = [];
    for (const phi of this.blockPhis) {
      declarations.push(`  ${declarationOf(this.typeNameOf(phi), this.nameOf(phi))};`);
    }
    for (const declaration of this.constantDeclarations) {
      declarations.push(`  ${declaration}`);
    }
    const unusedParams = this.graph.parameters
      .filter((param) => param.uses.length === 0)
      .map((param) => `  (void)p${Number(param.props.index)};`);
    const statements = this.body.map((line) =>
      line.endsWith(":;") ? line : `  ${line}`,
    );
    const lines = [...declarations, ...this.rootFrame(), ...unusedParams, ...statements];
    const bodyText = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    return `${this.preamble()}\n\n${signature} {\n${bodyText}}\n`;
  }
}

function inferTypes(graph: CFGFunction): TypeInference {
  return new AnalysisManager(graph, createAnalysisRegistry()).get(typeInferenceAnalysisId);
}

export function emitNumericFunction(
  graph: CFGFunction,
  types: TypeInference = inferTypes(graph),
): CEmitResult {
  const legality = analyzeAotLegality(graph, types);
  if (!legality.ok) return { ok: false, reason: legality.reason };
  return new CFunctionEmitter(graph, legality.legality).emit();
}

export function cEmittedOpcodes(): ReadonlySet<string> {
  const probe = Object.create(CFunctionEmitter.prototype) as CFunctionEmitter;
  return new Set(probe.handlers().map(([opcode]) => opcode));
}
