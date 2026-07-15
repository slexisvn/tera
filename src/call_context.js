export function parseCallContext(input) {
  let depth = 0;
  let quote = null;
  let commas = 0;
  let parenPos = -1;

  for (let i = input.length - 1; i >= 0; i--) {
    const ch = input[i];

    if (quote) {
      if (ch === quote && (i === 0 || input[i - 1] !== '\\')) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ')' || ch === ']') {
      depth++;
      continue;
    }

    if (ch === '(' || ch === '[') {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (ch === '(') {
        parenPos = i;
        break;
      }
      continue;
    }

    if (ch === ',' && depth === 0) {
      commas++;
    }
  }

  if (parenPos < 0) return null;

  const before = input.substring(0, parenPos);
  const idMatch = before.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!idMatch) {
    const dotMatch = before.match(/[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!dotMatch) return null;
    return { functionName: dotMatch[1], argIndex: commas };
  }

  return { functionName: idMatch[1], argIndex: commas };
}
