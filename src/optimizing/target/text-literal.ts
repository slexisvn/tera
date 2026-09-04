const PRINTABLE_LIMIT = 0x7e;
const FIRST_PRINTABLE = 0x20;
const OCTAL_DIGITS = 3;

const encoder = new TextEncoder();

export function byteEscapedLiteral(value: string): string {
  let out = '"';
  for (const byte of encoder.encode(value)) {
    const character = String.fromCharCode(byte);
    if (character === '"' || character === "\\") out += `\\${character}`;
    else if (character === "\n") out += "\\n";
    else if (character === "\t") out += "\\t";
    else if (byte < FIRST_PRINTABLE || byte > PRINTABLE_LIMIT) {
      out += `\\${byte.toString(8).padStart(OCTAL_DIGITS, "0")}`;
    } else out += character;
  }
  return `${out}"`;
}
