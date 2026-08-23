export function uleb128(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    const digit = rest & 0x7f;
    rest >>>= 7;
    bytes.push(rest === 0 ? digit : digit | 0x80);
  } while (rest !== 0);
  return bytes;
}

export function sleb128(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  for (;;) {
    const digit = rest & 0x7f;
    rest >>= 7;
    const signed = (digit & 0x40) !== 0;
    if ((rest === 0 && !signed) || (rest === -1 && signed)) {
      bytes.push(digit);
      return bytes;
    }
    bytes.push(digit | 0x80);
  }
}
