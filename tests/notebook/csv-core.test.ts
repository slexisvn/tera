import { describe, expect, it } from "vitest";
import { CsvStreamParser } from "../../src/csv-core.js";

describe("CsvStreamParser", () => {
  it("parses chunked CSV with quoted separators and CRLF rows", () => {
    const parser = new CsvStreamParser(",");
    parser.feed("name,score,note\r\n");
    parser.feed("\"Ada, Lovelace\",42,\"hello ");
    parser.feed("\"\"tera\"\"\"\r\nGrace,7,plain");
    const result = parser.finish();

    expect(result.headers).toEqual(["name", "score", "note"]);
    expect(result.rowCount).toBe(2);
    expect(parser.drain()).toEqual([
      ["name", "score", "note"],
      ["Ada, Lovelace", 42, 'hello "tera"'],
      ["Grace", 7, "plain"],
    ]);
  });

  it("drains pending rows without losing future rows", () => {
    const parser = new CsvStreamParser(",");
    parser.feed("a,b\n1,2\n");
    expect(parser.drain()).toEqual([
      ["a", "b"],
      [1, 2],
    ]);
    parser.feed("3,4\n");
    expect(parser.finish()).toEqual({ rowCount: 2, headers: ["a", "b"] });
    expect(parser.drain()).toEqual([[3, 4]]);
  });
});
