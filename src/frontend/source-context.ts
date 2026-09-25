export function maskNonCodeSource(source: string): string {
  const out = source.split("");
  let cursor = 0;
  const mask = (index: number): void => {
    if (source[index] !== "\n" && source[index] !== "\r") out[index] = " ";
  };
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "#" || (char === "/" && source[cursor + 1] === "/")) {
      while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") mask(cursor++);
      continue;
    }
    if (char === "/" && source[cursor + 1] === "*") {
      mask(cursor++);
      mask(cursor++);
      while (cursor < source.length) {
        const closes = source[cursor] === "*" && source[cursor + 1] === "/";
        mask(cursor++);
        if (closes) {
          mask(cursor++);
          break;
        }
      }
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      mask(cursor++);
      while (cursor < source.length) {
        const current = source[cursor];
        mask(cursor++);
        if (current === "\\" && cursor < source.length) {
          mask(cursor++);
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    cursor++;
  }
  return out.join("");
}
