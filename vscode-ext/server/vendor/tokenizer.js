export class LangSyntaxError extends Error {
  constructor(message, line, column) {
    super(`${message} at ${line}:${column}`);
    this.name = 'LangSyntaxError';
    this.line = line;
    this.column = column;
  }
}

export function tokenize(source) {
  return addIndentation(tokenizeRaw(source));
}

function tokenizeRaw(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const push = (type, value, startLine = line, startColumn = column) => {
    tokens.push({ type, value, line: startLine, column: startColumn, endLine: line, endColumn: column });
  };

  const advance = () => {
    const ch = source[i++];
    if (ch === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
    return ch;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }
    if (ch === '\n' || ch === ';') {
      const l = line, c = column;
      advance();
      push('newline', '\n', l, c);
      continue;
    }
    if (ch === '#' || (ch === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const l = line, c = column;
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) value += advance();
      push('identifier', value, l, c);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1]))) {
      const l = line, c = column;
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i])) value += advance();
      let isFloat = value.includes('.');
      if (/[eE]/.test(source[i] || '')) {
        isFloat = true;
        value += advance();
        if (/[+-]/.test(source[i] || '')) value += advance();
        while (/[0-9]/.test(source[i] || '')) value += advance();
      }
      push('number', Number(value), l, c);
      tokens[tokens.length - 1].float = isFloat;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const l = line, c = column;
      const quote = advance();
      let value = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          advance();
          const escaped = advance();
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
        } else {
          value += advance();
        }
      }
      if (source[i] !== quote) throw new LangSyntaxError('Unterminated string', l, c);
      advance();
      push('string', value, l, c);
      continue;
    }

    const l = line, c = column;
    const three = source.slice(i, i + 3);
    if (three === '**=') {
      advance(); advance(); advance();
      push('symbol', '**=', l, c);
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['**', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '@=', '->'].includes(two)) {
      advance(); advance();
      push('symbol', two, l, c);
      continue;
    }
    if ('()[],.=:+-*/%@<>{}|'.includes(ch)) {
      advance();
      push('symbol', ch, l, c);
      continue;
    }
    throw new LangSyntaxError(`Unexpected character '${ch}'`, line, column);
  }

  push('eof', null);
  return tokens;
}

function addIndentation(tokens) {
  const result = [];
  const indentStack = [0];
  let bracketDepth = 0;
  let afterColon = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type === 'eof') {
      while (indentStack.length > 1) {
        indentStack.pop();
        result.push({ type: 'dedent', value: null, line: tok.line, column: tok.column });
      }
      result.push(tok);
      break;
    }

    if (tok.type !== 'string') {
      if (tok.value === '(' || tok.value === '[' || tok.value === '{') bracketDepth++;
      if (tok.value === ')' || tok.value === ']' || tok.value === '}') bracketDepth--;
    }

    if (tok.type === 'newline') {
      if (bracketDepth > 0) continue;

      let j = i + 1;
      while (j < tokens.length && tokens[j].type === 'newline') j++;
      if (j >= tokens.length || tokens[j].type === 'eof') {
        result.push(tok);
        while (indentStack.length > 1) {
          indentStack.pop();
          result.push({ type: 'dedent', value: null, line: tok.line, column: tok.column });
        }
        i = j - 1;
        afterColon = false;
        continue;
      }

      if (tokens[j].type === 'symbol' && tokens[j].value === '.') {
        i = j - 1;
        continue;
      }

      const nextCol = tokens[j].column;
      const currentIndent = indentStack[indentStack.length - 1];

      result.push(tok);

      if (afterColon && nextCol > currentIndent) {
        indentStack.push(nextCol);
        result.push({ type: 'indent', value: null, line: tokens[j].line, column: tokens[j].column });
      } else if (nextCol < currentIndent) {
        while (indentStack.length > 1 && indentStack[indentStack.length - 1] > nextCol) {
          indentStack.pop();
          result.push({ type: 'dedent', value: null, line: tokens[j].line, column: tokens[j].column });
        }
      }

      i = j - 1;
      afterColon = false;
      continue;
    }

    afterColon = (tok.value === ':');
    result.push(tok);
  }

  return result;
}
