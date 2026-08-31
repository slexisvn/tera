import { describe, expect } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { peAgrees } from "../../../helpers/aot-agreement.js";
import { itRunsPe } from "../../../helpers/pe-runner.js";

const src = (...lines: string[]) => lines.join("\n");

function compiled(source: string) {
  return nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
}

describe("AOT strings built across branches", () => {
  itRunsPe("appends a different piece per branch inside a loop", () => {
    peAgrees(
      src(
        "fn mask(n: int) -> string:",
        '  out = ""',
        "  for i of range(0, n):",
        "    if i % 2 == 0:",
        '      out = out + "#"',
        "    else:",
        '      out = out + "."',
        "  return out",
        "print(mask(7))",
      ),
    );
  });

  itRunsPe("builds an inner string per row and joins the rows", () => {
    peAgrees(
      src(
        "fn render(n: int) -> string:",
        '  out = ""',
        "  for i of range(0, n):",
        '    line = ""',
        "    for j of range(0, n):",
        "      if (i + j) % 2 == 0:",
        '        line = line + "#"',
        "      else:",
        '        line = line + "."',
        '    out = out + line + "\\n"',
        "  return out",
        "print(render(3))",
      ),
    );
  });

  itRunsPe("keeps two strings built in different branches apart", () => {
    peAgrees(
      src(
        "fn label(c: int) -> string:",
        '  a = "x" + c.to_string()',
        "  if c > 0:",
        "    s = a",
        "  else:",
        '    s = "y" + c.to_string()',
        "  print(a)",
        "  return s",
        "print(label(1))",
        "print(label(-1))",
      ),
    );
  });

  itRunsPe("declines to keep a string a later pass of the same loop overwrites", () => {
    expect(() =>
      compiled(
        src(
          "fn first(n: int) -> string:",
          '  held = ""',
          '  out = ""',
          "  for i of range(0, n):",
          "    if i == 0:",
          '      out = "row " + i.to_string()',
          "    else:",
          '      out = "row " + i.to_string() + "!"',
          "    if i == 0:",
          "      held = out",
          "  print(held)",
          "  return out",
          "print(first(3))",
        ),
      ),
    ).toThrow(/two strings into the same storage/);
  });
});
