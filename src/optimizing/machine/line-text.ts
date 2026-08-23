import type { MachineInstruction } from "./ir.js";

const FIRST_FILE = 1;

export class SourceFiles {
  private readonly indexes = new Map<string, number>();

  indexOf(file: string): number {
    const known = this.indexes.get(file);
    if (known !== undefined) return known;
    const index = this.indexes.size + FIRST_FILE;
    this.indexes.set(file, index);
    return index;
  }

  get names(): readonly string[] {
    return [...this.indexes.keys()];
  }

  get directives(): string[] {
    return [...this.indexes].map(([name, index]) => `\t.file ${index} "${name}"`);
  }
}

export function annotateLines(
  files: SourceFiles,
): (node: MachineInstruction) => string[] {
  let last = "";
  return (node) => {
    const source = node.source;
    if (source === null || source.file.length === 0) return [];
    const directive = `\t.loc ${files.indexOf(source.file)} ${source.line} ${source.column}`;
    if (directive === last) return [];
    last = directive;
    return [directive];
  };
}
