export function offsetAt(text, position) {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset + position.character;
}

export function positionAt(text, offset) {
  let line = 0;
  let column = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      column = 0;
    } else {
      column++;
    }
  }
  return { line, character: column };
}

export function wordRangeAt(text, position) {
  const line = text.split('\n')[position.line] ?? '';
  let start = position.character;
  let end = position.character;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1])) start--;
  while (end < line.length && /[A-Za-z0-9_]/.test(line[end])) end++;
  if (start === end) return null;
  return {
    text: line.slice(start, end),
    range: {
      start: { line: position.line, character: start },
      end: { line: position.line, character: end },
    },
  };
}

export function lineAt(text, lineIndex) {
  return text.split('\n')[lineIndex] ?? '';
}
