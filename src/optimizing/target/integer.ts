export const INT32_BITS = 32;
export const INT32_MAX = 2 ** (INT32_BITS - 1) - 1;
export const INT32_MIN = -(2 ** (INT32_BITS - 1));
export const UINT32_RANGE = 2 ** INT32_BITS;
export const INT32_SHIFT_MASK = INT32_BITS - 1;

export const INT64_BITS = 64;
export const INT64_TRUNC_LIMIT = 2 ** (INT64_BITS - 1);

export const INT32_DECIMAL_TEXT_BYTES = String(INT32_MIN).length + 1;

export function isInt32(value: number): boolean {
  return (
    Number.isInteger(value) &&
    !Object.is(value, -0) &&
    value >= INT32_MIN &&
    value <= INT32_MAX
  );
}

export function withinInt32(min: number, max: number): boolean {
  return min > INT32_MIN && max < INT32_MAX;
}
