export const RISCV_IMMEDIATE_BITS = 12;

const LIMIT = 2 ** (RISCV_IMMEDIATE_BITS - 1);

export function fitsImmediate(value: number): boolean {
  return value >= -LIMIT && value < LIMIT;
}
