import { describe, it, expect } from "vitest";
import { Lexer, TokenType } from "../../src/frontend/lexer/index.js";

function tokenize(src) {
  return new Lexer(src).tokenize();
}

function tokenValues(src) {
  return tokenize(src)
    .filter((t) => t.type !== TokenType.EOF)
    .map((t) => t.value);
}

function tokenTypes(src) {
  return tokenize(src)
    .filter((t) => t.type !== TokenType.EOF)
    .map((t) => t.type);
}

describe("Lexer", () => {
  describe("comments", () => {
    it("skips block comments without confusing them for regex", () => {
      expect(tokenValues("/* hi */ x")).toEqual(["x"]);
      expect(tokenValues("1 /* mid */ + 2")).toEqual(["1", "+", "2"]);
      expect(tokenValues("/*\n multi\n line\n*/ y")).toEqual(["y"]);
      expect(tokenValues("/*---\ndescription\n---*/ z")).toEqual(["z"]);
    });
    it("still distinguishes division and regex after comments", () => {
      expect(tokenValues("// c\n10 / 2")).toEqual(["10", "/", "2"]);
      expect(tokenTypes("/* c */ /re/g")).toEqual([TokenType.RegExp]);
    });
    it("skips hash line comments, whole-line and trailing", () => {
      expect(tokenValues("# comment\nx")).toEqual(["x"]);
      expect(tokenValues("x = 1  # trailing")).toEqual(["x", "=", "1"]);
      expect(tokenValues("a\n# between\nb")).toEqual(["a", "b"]);
    });
  });

  describe("numbers", () => {
    it("all numeric formats tokenize correctly", () => {
      const cases = [
        ["42", "42"], ["3.14", "3.14"], ["0", "0"],
        ["0xFF", "0xFF"], ["0XAB", "0XAB"],
        ["0b1010", "0b1010"], ["0B11", "0B11"],
        ["0o77", "0o77"], ["0O10", "0O10"],
        ["1e5", "1e5"], ["1.5e-3", "1.5e-3"], ["2E+10", "2E+10"],
      ];
      for (const [input, expected] of cases) {
        const tok = tokenize(input)[0];
        expect(tok.type).toBe(TokenType.Number);
        expect(tok.value).toBe(expected);
      }
    });

    it("leading-dot, trailing-dot and numeric separators", () => {
      const cases = [
        [".5", ".5"],
        ["5.", "5."],
        ["1_000_000", "1000000"],
        ["1_000.5", "1000.5"],
        ["0xFF_FF", "0xFFFF"],
        ["0b1010_1010", "0b10101010"],
      ];
      for (const [input, expected] of cases) {
        const tok = tokenize(input)[0];
        expect(tok.type).toBe(TokenType.Number);
        expect(tok.value).toBe(expected);
      }
    });
  });

  describe("strings", () => {
    it("escape sequences across quote styles", () => {
      const cases = [
        ['"a\\nb"', "a\nb"], ['"a\\tb"', "a\tb"], ['"a\\rb"', "a\rb"],
        ['"a\\\\b"', "a\\b"], ['"a\\"b"', 'a"b'],
        ["'a\\nb'", "a\nb"], ["'a\\'b'", "a'b"],
        ['""', ""], ["''", ""],
      ];
      for (const [input, expected] of cases) {
        const tok = tokenize(input)[0];
        expect(tok.type).toBe(TokenType.String);
        expect(tok.value).toBe(expected);
      }
    });

    it("unterminated strings throw", () => {
      expect(() => tokenize('"hello')).toThrow(/Unterminated string/);
      expect(() => tokenize("'hello")).toThrow(/Unterminated string/);
    });
  });

  describe("template literals", () => {
    it("simple template", () => {
      const tok = tokenize("`hello`")[0];
      expect(tok.type).toBe(TokenType.TemplateLiteral);
      expect(tok.value.parts).toEqual(["hello"]);
      expect(tok.value.expressions).toEqual([]);
    });

    it("template with expression", () => {
      const tok = tokenize("`a${x}b`")[0];
      expect(tok.value.parts).toEqual(["a", "b"]);
      expect(tok.value.expressions).toEqual(["x"]);
    });

    it("template with multiple expressions", () => {
      const tok = tokenize("`${a}+${b}`")[0];
      expect(tok.value.parts).toEqual(["", "+", ""]);
      expect(tok.value.expressions).toEqual(["a", "b"]);
    });

    it("template escape sequences", () => {
      const tok = tokenize("`a\\nb`")[0];
      expect(tok.value.parts).toEqual(["a\nb"]);
    });

    it("template with nested braces", () => {
      const tok = tokenize("`${a + {x: 1}}`")[0];
      expect(tok.value.expressions).toEqual(["a + {x: 1}"]);
    });

    it("unterminated template throws", () => {
      expect(() => tokenize("`hello")).toThrow(/Unterminated template/);
    });
  });

  describe("identifiers and keywords", () => {
    it("identifiers with special start chars", () => {
      for (const id of ["_foo", "$bar", "_$baz123"]) {
        const tok = tokenize(id)[0];
        expect(tok.type).toBe(TokenType.Identifier);
        expect(tok.value).toBe(id);
      }
    });

    it("keywords", () => {
      const keywords = [
        "let",
        "const",
        "var",
        "function",
        "if",
        "else",
        "while",
        "for",
        "return",
        "true",
        "false",
        "null",
        "undefined",
        "new",
        "this",
        "class",
        "extends",
        "super",
        "async",
        "await",
        "yield",
      ];
      for (const kw of keywords) {
        const tok = tokenize(kw)[0];
        expect(tok.type).toBe(TokenType.Keyword);
        expect(tok.value).toBe(kw);
      }
    });
  });

  describe("punctuators", () => {
    it("single char", () => {
      const singles = [
        "+",
        "-",
        "*",
        "%",
        "(",
        ")",
        "{",
        "}",
        "[",
        "]",
        ";",
        ",",
        ".",
        ":",
        "?",
        "!",
        "=",
        "<",
        ">",
        "&",
        "|",
        "^",
        "~",
      ];
      for (const p of singles) {
        const tok = tokenize(p)[0];
        expect(tok.type).toBe(TokenType.Punctuator);
        expect(tok.value).toBe(p);
      }
    });

    it("multi char", () => {
      const multis = [
        "===",
        "!==",
        "==",
        "!=",
        "<=",
        ">=",
        "&&",
        "||",
        "??",
        "?.",
        "++",
        "--",
        "**",
        "=>",
        "+=",
        "-=",
        "*=",
        "%=",
        "...",
        "<<",
        ">>",
        ">>>",
        "<<=",
        ">>=",
        ">>>=",
        "**=",
        "&=",
        "|=",
        "^=",
      ];
      for (const p of multis) {
        const toks = tokenize(p);
        expect(toks[0].type).toBe(TokenType.Punctuator);
        expect(toks[0].value).toBe(p);
      }
    });

    it("slash as division after context", () => {
      const toks = tokenize("1 / 2");
      expect(toks[1].type).toBe(TokenType.Punctuator);
      expect(toks[1].value).toBe("/");
    });

    it("/= after context", () => {
      const toks = tokenize("x /= 2");
      expect(toks[1].type).toBe(TokenType.Punctuator);
      expect(toks[1].value).toBe("/=");
    });

    it("prefers longer punctuator", () => {
      const toks = tokenize("===");
      expect(toks[0].value).toBe("===");
    });
  });

  describe("regex", () => {
    it("simple regex", () => {
      const toks = tokenize("let x = /abc/g");
      const regex = toks.find((t) => t.type === TokenType.RegExp);
      expect(regex.value.pattern).toBe("abc");
      expect(regex.value.flags).toBe("g");
    });

    it("regex with char class", () => {
      const toks = tokenize("let x = /[a-z]/i");
      const regex = toks.find((t) => t.type === TokenType.RegExp);
      expect(regex.value.pattern).toBe("[a-z]");
      expect(regex.value.flags).toBe("i");
    });

    it("regex with escape", () => {
      const toks = tokenize("let x = /a\\.b/");
      const regex = toks.find((t) => t.type === TokenType.RegExp);
      expect(regex.value.pattern).toBe("a\\.b");
    });

    it("division not regex after number", () => {
      const toks = tokenize("2 / 3");
      expect(toks[1].type).toBe(TokenType.Punctuator);
      expect(toks[1].value).toBe("/");
    });

    it("division not regex after identifier", () => {
      const toks = tokenize("x / y");
      expect(toks[1].type).toBe(TokenType.Punctuator);
      expect(toks[1].value).toBe("/");
    });

    it("regex after operator", () => {
      const toks = tokenize("x = /test/g");
      const regex = toks.find((t) => t.type === TokenType.RegExp);
      expect(regex).toBeDefined();
      expect(regex.value.pattern).toBe("test");
    });
  });

  describe("comments", () => {
    it("single line comment", () => {
      const toks = tokenize("a // comment\nb");
      const vals = toks
        .filter((t) => t.type !== TokenType.EOF)
        .map((t) => t.value);
      expect(vals).toEqual(["a", "b"]);
    });

    it("comment at end of input", () => {
      const toks = tokenize("x // end");
      expect(
        toks.filter((t) => t.type !== TokenType.EOF).map((t) => t.value),
      ).toEqual(["x"]);
    });
  });

  describe("whitespace", () => {
    it("skips spaces tabs newlines", () => {
      const vals = tokenValues("  a \t b \n c \r\n d  ");
      expect(vals).toEqual(["a", "b", "c", "d"]);
    });
  });

  describe("line and column tracking", () => {
    it("tracks line numbers", () => {
      const toks = tokenize("a\nb\nc");
      expect(toks[0].line).toBe(1);
      expect(toks[1].line).toBe(2);
      expect(toks[2].line).toBe(3);
    });

    it("tracks column numbers", () => {
      const toks = tokenize("ab cd");
      expect(toks[0].column).toBe(1);
      expect(toks[1].column).toBe(4);
    });

    it("resets column after newline", () => {
      const toks = tokenize("a\n  b");
      expect(toks[1].column).toBe(3);
    });
  });

  describe("EOF", () => {
    it("EOF is sole token for empty input and last token otherwise", () => {
      const empty = tokenize("");
      expect(empty).toHaveLength(1);
      expect(empty[0].type).toBe(TokenType.EOF);
      const nonEmpty = tokenize("x + y");
      expect(nonEmpty[nonEmpty.length - 1].type).toBe(TokenType.EOF);
      expect(nonEmpty.filter((t) => t.type === TokenType.EOF)).toHaveLength(1);
    });
  });

  describe("complex expressions", () => {
    it("function call", () => {
      const vals = tokenValues("foo(1, 2)");
      expect(vals).toEqual(["foo", "(", "1", ",", "2", ")"]);
    });

    it("arrow function", () => {
      const vals = tokenValues("(x) => x + 1");
      expect(vals).toEqual(["(", "x", ")", "=>", "x", "+", "1"]);
    });

    it("object literal", () => {
      const vals = tokenValues("{ a: 1 }");
      expect(vals).toEqual(["{", "a", ":", "1", "}"]);
    });

    it("member access and computed", () => {
      const vals = tokenValues("a.b[0]");
      expect(vals).toEqual(["a", ".", "b", "[", "0", "]"]);
    });

    it("ternary", () => {
      const vals = tokenValues("a ? b : c");
      expect(vals).toEqual(["a", "?", "b", ":", "c"]);
    });

    it("optional chaining", () => {
      const vals = tokenValues("a?.b");
      expect(vals).toEqual(["a", "?.", "b"]);
    });

    it("spread", () => {
      const vals = tokenValues("...args");
      expect(vals).toEqual(["...", "args"]);
    });

    it("nullish coalescing", () => {
      const vals = tokenValues("a ?? b");
      expect(vals).toEqual(["a", "??", "b"]);
    });
  });

  describe("Tera operators", () => {
    it("tokenizes tensor matmul", () => {
      expect(tokenValues("a @ b")).toEqual(["a", "@", "b"]);
    });
  });
});
