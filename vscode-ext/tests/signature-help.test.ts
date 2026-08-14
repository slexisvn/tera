import { afterEach, describe, expect, it } from "vitest";
import { computeSignatureHelp } from "../src/server/providers/signature-help.ts";
import { GEOMETRY, cleanupProjects, contextFor, projectFor, type ModuleProject } from "./provider-harness.ts";

afterEach(cleanupProjects);

function helpAt(project: ModuleProject, relative: string, buffer: string, line: number, character: number) {
  const uri = project.open(relative, buffer);
  return computeSignatureHelp(project.context, { textDocument: { uri }, position: { line, character } });
}

describe("signature help", () => {
  it("still resolves builtin signatures", () => {
    const help = computeSignatureHelp(contextFor("x = tensor("), {
      textDocument: { uri: "file:///test.tera" },
      position: { line: 0, character: "x = tensor(".length },
    });

    expect(help?.signatures[0]?.label).toContain("tensor");
  });

  it("resolves an imported function's signature from its module", () => {
    const project = projectFor(GEOMETRY);
    const buffer = "from mathx import abs_int\nprint(abs_int(";
    const help = helpAt(project, "main.tera", buffer, 1, buffer.length - "from mathx import abs_int\n".length);

    expect(help?.signatures[0]?.label).toBe("abs_int(n: int) -> int");
    expect(help?.signatures[0]?.parameters).toEqual([{ label: "n" }]);
    expect(help?.activeParameter).toBe(0);
  });

  it("keeps the alias in the label when the import is renamed", () => {
    const project = projectFor(GEOMETRY);
    const buffer = "from mathx import max_int as best\nprint(best(1, ";
    const help = helpAt(project, "main.tera", buffer, 1, "print(best(1, ".length);

    expect(help?.signatures[0]?.label).toBe("best(a: int, b: int) -> int");
    expect(help?.activeParameter).toBe(1);
  });

  it("resolves a namespace member's signature", () => {
    const project = projectFor(GEOMETRY);
    const buffer = "import shapes\nprint(shapes.rect_area(3, ";
    const help = helpAt(project, "main.tera", buffer, 1, "print(shapes.rect_area(3, ".length);

    expect(help?.signatures[0]?.label).toBe("shapes.rect_area(width: int, height: int) -> int");
    expect(help?.activeParameter).toBe(1);
  });
});
