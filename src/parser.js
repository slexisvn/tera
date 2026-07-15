import { tokenize, LangSyntaxError } from './tokenizer.js';

const PRECEDENCE = {
  'or': 1,
  'and': 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5, '@': 5,
  '**': 6,
};

const COMPOUND_OPS = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '**=': '**', '@=': '@' };

export function parse(source) {
  return new Parser(tokenize(source)).parseProgram();
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  parseProgram(stop = null) {
    const body = [];
    this.skipLines();
    while (!this.at('eof') && !(stop && (this.atValue(stop) || this.at(stop)))) {
      body.push(this.parseStatement());
      this.skipLines();
    }
    return { type: 'Program', body };
  }

  parseStatement() {
    const start = this.current();
    if (this.atIdentifier('model') && this.peek(1).type === 'identifier') return this.parseModel();
    if (this.atIdentifier('forward')) return this.parseForward();
    if (this.atIdentifier('train') && this.peek(1).value !== '=' && !COMPOUND_OPS[this.peek(1).value]) return this.parseTrain();
    if (this.atIdentifier('validate') && this.peek(1).value !== '=' && !COMPOUND_OPS[this.peek(1).value]) return this.parseValidate();
    if (this.atIdentifier('optimizer') && this.peek(1).value === ':') return this.parseOptimizer();
    if (this.atIdentifier('fn')) return this.parseFunctionDeclaration();
    if (this.atIdentifier('if')) return this.parseIf();
    if (this.atIdentifier('for')) return this.parseFor();
    if (this.atIdentifier('while')) return this.parseWhile();
    if (this.atIdentifier('break')) { this.next(); return this.locate({ type: 'Break' }, start); }
    if (this.atIdentifier('continue')) { this.next(); return this.locate({ type: 'Continue' }, start); }
    if (this.atIdentifier('return')) {
      this.next();
      return this.locate({ type: 'Return', value: this.parseExpression() }, start);
    }

    if (this.at('identifier')) {
      const nextVal = this.peek(1).value;
      if (nextVal === ',') {
        const maybeDestructure = this.tryParseDestructureAssign();
        if (maybeDestructure) return maybeDestructure;
      }
      if (nextVal === '=') {
        const name = this.next().value;
        this.expectValue('=');
        return this.locate({ type: 'Assign', name, value: this.parseExpression() }, start);
      }
      if (nextVal === ':') {
        const name = this.next().value;
        this.expectValue(':');
        const annotation = this.parseTypeAnnotation();
        this.expectValue('=');
        return this.locate({ type: 'Assign', name, annotation, value: this.parseExpression() }, start);
      }
      if (COMPOUND_OPS[nextVal] !== undefined) {
        const name = this.next().value;
        const opToken = this.next();
        const op = COMPOUND_OPS[opToken.value];
        return this.locate({ type: 'CompoundAssign', name, op, value: this.parseExpression() }, start);
      }
    }
    const expr = this.parseExpression();
    if (expr.type === 'Index' && this.atValue('=')) {
      this.next();
      return this.locate({ type: 'IndexAssign', object: expr.object, items: expr.items, op: null, value: this.parseExpression() }, start);
    }
    if (expr.type === 'Index' && COMPOUND_OPS[this.current().value] !== undefined) {
      const op = COMPOUND_OPS[this.next().value];
      return this.locate({ type: 'IndexAssign', object: expr.object, items: expr.items, op, value: this.parseExpression() }, start);
    }
    return this.locate({ type: 'ExpressionStatement', expression: expr }, start);
  }

  parseBlock() {
    this.expectValue(':');
    if (!this.at('newline') && !this.at('indent') && !this.at('eof')) {
      return [this.parseStatement()];
    }
    this.skipLines();
    this.expect('indent');
    const body = this.parseProgram('dedent').body;
    this.expect('dedent');
    return body;
  }

  parseIf() {
    const start = this.expectIdentifier('if');
    const condition = this.parseExpression();
    const body = this.parseBlock();
    const elifs = [];
    this.skipLines();
    while (this.atIdentifier('else') && this.peek(1).type === 'identifier' && this.peek(1).value === 'if') {
      this.next();
      this.next();
      const elifCond = this.parseExpression();
      const elifBody = this.parseBlock();
      this.skipLines();
      elifs.push({ condition: elifCond, body: elifBody });
    }
    let elseBody = null;
    if (this.atIdentifier('else')) {
      this.next();
      elseBody = this.parseBlock();
    }
    return this.locate({ type: 'If', condition, body, elifs, elseBody }, start);
  }

  parseFor() {
    const start = this.expectIdentifier('for');
    const variable = this.expect('identifier').value;
    this.expectIdentifier('in');
    const iterable = this.parseExpression();
    const body = this.parseBlock();
    return this.locate({ type: 'For', variable, iterable, body }, start);
  }

  parseWhile() {
    const start = this.expectIdentifier('while');
    const condition = this.parseExpression();
    const body = this.parseBlock();
    return this.locate({ type: 'While', condition, body }, start);
  }

  parseFunctionDeclaration() {
    const start = this.expectIdentifier('fn');
    const name = this.expect('identifier').value;
    const paramTypes = [];
    const params = this.parseNameList(paramTypes);
    const returnType = this.matchValue('->') ? this.parseTypeAnnotation() : null;
    const body = this.parseBlock();
    return this.locate({ type: 'FunctionDeclaration', name, params, paramTypes, returnType, body }, start);
  }

  parseModel() {
    const start = this.expectIdentifier('model');
    const name = this.expect('identifier').value;
    const paramTypes = [];
    const params = this.parseNameList(paramTypes);
    const body = this.parseBlock();
    return this.locate({ type: 'ModelDeclaration', name, params, paramTypes, body }, start);
  }

  parseForward() {
    const start = this.expectIdentifier('forward');
    const paramTypes = [];
    const params = this.parseBlockParams(paramTypes);
    const returnType = this.matchValue('->') ? this.parseTypeAnnotation() : null;
    const body = this.parseBlock();
    return this.locate({ type: 'ForwardDeclaration', params, paramTypes, returnType, body }, start);
  }

  parseTrain() {
    const start = this.expectIdentifier('train');
    const paramTypes = [];
    const params = this.parseBlockParams(paramTypes);
    const body = this.parseBlock();
    return this.locate({ type: 'TrainDeclaration', params, paramTypes, body }, start);
  }

  parseValidate() {
    const start = this.expectIdentifier('validate');
    const paramTypes = [];
    const params = this.parseBlockParams(paramTypes);
    const body = this.parseBlock();
    return this.locate({ type: 'ValidateDeclaration', params, paramTypes, body }, start);
  }

  parseOptimizer() {
    const start = this.expectIdentifier('optimizer');
    const body = this.parseBlock();
    return this.locate({ type: 'OptimizerDeclaration', body }, start);
  }

  tryParseDestructureAssign() {
    const savedPos = this.pos;
    const start = this.current();
    const names = [this.next().value];
    while (this.matchValue(',')) {
      if (!this.at('identifier')) { this.pos = savedPos; return null; }
      names.push(this.next().value);
    }
    if (!this.atValue('=')) { this.pos = savedPos; return null; }
    this.next();
    return this.locate({ type: 'DestructureAssign', names, value: this.parseExpression() }, start);
  }

  parseNameList(annotations = null) {
    if (!this.matchValue('(')) return [];
    const names = [];
    if (!this.atValue(')')) {
      do {
        names.push(this.expect('identifier').value);
        const ann = this.matchValue(':') ? this.parseTypeAnnotation() : null;
        if (annotations) annotations.push(ann);
        if (!this.matchValue(',')) break;
      } while (!this.atValue(')'));
    }
    this.expectValue(')');
    return names;
  }

  parseBlockParams(annotations) {
    if (this.atValue('(')) return this.parseNameList(annotations);
    const names = [];
    while (!this.atValue(':') && !this.atValue('->')) {
      names.push(this.expect('identifier').value);
      annotations.push(null);
      if (!this.matchValue(',')) break;
      if (this.atValue(':') || this.atValue('->')) break;
    }
    return names;
  }

  parseTypeAnnotation() {
    return this.parseUnionType();
  }

  parseUnionType() {
    const start = this.current();
    const first = this.parsePostfixType();
    if (!this.atValue('|')) return first;
    const members = [first];
    while (this.matchValue('|')) members.push(this.parsePostfixType());
    return this.locate({ kind: 'UnionType', members }, start);
  }

  parsePostfixType() {
    let type = this.parsePrimaryType();
    while (this.atValue('[') && this.peek(1).value === ']') {
      const start = this.next();
      this.expectValue(']');
      type = this.locate({ kind: 'ArrayType', element: type }, start);
    }
    return type;
  }

  parsePrimaryType() {
    if (this.atIdentifier('fn')) return this.parseFunctionType();
    const start = this.expect('identifier');
    const name = start.value;
    if (!this.matchValue('<')) return this.locate({ kind: 'NameType', name }, start);
    const args = [this.parseTypeAnnotation()];
    while (this.matchValue(',')) args.push(this.parseTypeAnnotation());
    this.expectGenericClose();
    return this.locate({ kind: 'GenericType', name, args }, start);
  }

  expectGenericClose() {
    if (this.matchValue('>')) return;
    const tok = this.current();
    if (tok.type !== 'string' && tok.value === '>=') {
      tok.value = '=';
      tok.column += 1;
      return;
    }
    throw this.error("Expected '>'");
  }

  parseFunctionType() {
    const start = this.expectIdentifier('fn');
    this.expectValue('(');
    const params = [];
    if (!this.atValue(')')) {
      params.push(this.parseTypeAnnotation());
      while (this.matchValue(',')) params.push(this.parseTypeAnnotation());
    }
    this.expectValue(')');
    this.expectValue('->');
    const ret = this.parseTypeAnnotation();
    return this.locate({ kind: 'FunctionType', params, ret }, start);
  }

  parseExpression(minPrec = 0) {
    let left = this.parsePrefix();
    while (true) {
      if (this.atValue('(')) {
        left = this.parseCall(left);
        continue;
      }
      if (this.atValue('.')) {
        const start = this.next();
        left = this.locate({ type: 'Member', object: left, property: this.expect('identifier').value }, start);
        continue;
      }
      if (this.atValue('[')) {
        left = this.parseIndex(left);
        continue;
      }
      const op = this.current().value;
      const prec = PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) break;
      const start = this.next();
      const right = this.parseExpression(prec + (op === '**' ? 0 : 1));
      left = this.locate({ type: 'Binary', op, left, right }, start);
    }
    return left;
  }

  parsePrefix() {
    const token = this.current();
    if (token.type === 'symbol' && (token.value === '-' || token.value === '+')) {
      this.next();
      return this.locate({ type: 'Unary', op: token.value, value: this.parseExpression(7) }, token);
    }
    if (token.type === 'identifier' && token.value === 'not') {
      this.next();
      return this.locate({ type: 'Unary', op: 'not', value: this.parseExpression(7) }, token);
    }
    if (token.type === 'number' || token.type === 'string') {
      this.next();
      const literal = { type: 'Literal', value: token.value };
      if (token.type === 'number') literal.isFloat = token.float === true;
      return this.locate(literal, token);
    }
    if (token.type === 'identifier') {
      this.next();
      if (token.value === 'true') return this.locate({ type: 'Literal', value: true }, token);
      if (token.value === 'false') return this.locate({ type: 'Literal', value: false }, token);
      if (token.value === 'null') return this.locate({ type: 'Literal', value: null }, token);
      return this.locate({ type: 'Identifier', name: token.value }, token);
    }
    if (this.matchValue('(')) {
      const value = this.parseExpression();
      this.expectValue(')');
      return value;
    }
    if (this.matchValue('[')) {
      this.skipLines();
      if (this.atValue(']')) { this.next(); return this.locate({ type: 'Array', elements: [] }, token); }
      const first = this.parseExpression();
      this.skipLines();
      if (this.atIdentifier('for')) {
        this.next();
        const variable = this.expect('identifier').value;
        this.expectIdentifier('in');
        const iterable = this.parseExpression();
        this.skipLines();
        let condition = null;
        if (this.atIdentifier('if')) { this.next(); condition = this.parseExpression(); this.skipLines(); }
        this.expectValue(']');
        return this.locate({ type: 'ListComprehension', expr: first, variable, iterable, condition }, token);
      }
      const elements = [first];
      this.skipLines();
      while (this.matchValue(',')) {
        this.skipLines();
        if (this.atValue(']')) break;
        elements.push(this.parseExpression());
        this.skipLines();
      }
      this.expectValue(']');
      return this.locate({ type: 'Array', elements }, token);
    }
    if (this.matchValue('{')) {
      const entries = [];
      this.skipLines();
      if (!this.atValue('}')) {
        do {
          this.skipLines();
          if (this.atValue('}')) break;
          const key = this.parseExpression();
          this.expectValue(':');
          const value = this.parseExpression();
          entries.push({ key, value });
          this.skipLines();
        } while (this.matchValue(','));
      }
      this.skipLines();
      this.expectValue('}');
      return this.locate({ type: 'Dict', entries }, token);
    }
    throw this.error(`Expected expression, got '${token.value ?? token.type}'`);
  }

  parseCall(callee) {
    const start = this.expectValue('(');
    const args = [];
    this.skipLines();
    if (!this.atValue(')')) {
      do {
        this.skipLines();
        if (this.atValue(')')) break;
        if (this.at('identifier') && this.peek(1).value === '=') {
          const name = this.next().value;
          this.next();
          args.push({ name, value: this.parseExpression() });
        } else {
          args.push({ name: null, value: this.parseExpression() });
        }
        this.skipLines();
      } while (this.matchValue(','));
    }
    this.skipLines();
    this.expectValue(')');
    return this.locate({ type: 'Call', callee, args }, start);
  }

  parseIndex(object) {
    const start = this.expectValue('[');
    const items = [];
    if (this.atValue(']')) throw this.error('Expected index expression');
    do {
      this.skipLines();
      if (this.atValue(']')) break;
      items.push(this.parseIndexItem());
      this.skipLines();
    } while (this.matchValue(','));
    this.expectValue(']');
    return this.locate({ type: 'Index', object, items }, start);
  }

  parseIndexItem() {
    const start = this.current();
    let first = null;
    if (!this.atValue(':') && !this.atValue(',') && !this.atValue(']')) first = this.parseExpression();
    if (!this.matchValue(':')) {
      if (!first) throw this.error('Expected index expression');
      return first;
    }

    let end = null;
    let step = null;
    if (!this.atValue(':') && !this.atValue(',') && !this.atValue(']')) end = this.parseExpression();
    if (this.matchValue(':') && !this.atValue(',') && !this.atValue(']')) step = this.parseExpression();
    return this.locate({ type: 'Slice', start: first, end, step }, start);
  }

  skipLines() { while (this.at('newline')) this.next(); }
  current() { return this.tokens[this.pos]; }
  peek(n) { return this.tokens[this.pos + n] || this.tokens[this.tokens.length - 1]; }
  next() { return this.tokens[this.pos++]; }
  at(type) { return this.current().type === type; }
  atValue(value) { const tok = this.current(); return tok.type !== 'string' && tok.value === value; }
  atIdentifier(value) { return this.at('identifier') && this.atValue(value); }
  matchValue(value) { if (this.atValue(value)) { this.next(); return true; } return false; }
  expect(type) {
    if (!this.at(type)) throw this.error(`Expected ${type}`);
    return this.next();
  }
  expectValue(value) {
    if (!this.atValue(value)) throw this.error(`Expected '${value}'`);
    return this.next();
  }
  expectIdentifier(value) {
    if (!this.atIdentifier(value)) throw this.error(`Expected '${value}'`);
    return this.next();
  }
  error(message) {
    const t = this.current();
    return new LangSyntaxError(message, t.line, t.column);
  }
  locate(node, token) {
    node.line = token.line;
    node.column = token.column;
    return node;
  }
}
