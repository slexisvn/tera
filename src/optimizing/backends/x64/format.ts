export type ObjectFormatName = "elf" | "coff" | "macho";

export interface ObjectFormat {
  readonly name: ObjectFormatName;
  readonly symbolPrefix: string;
  readonly textDirective: string;
  readonly rodataDirective: string;
  functionAttributes(symbol: string): readonly string[];
}

const FORMATS: Record<ObjectFormatName, ObjectFormat> = {
  elf: {
    name: "elf",
    symbolPrefix: "",
    textDirective: "\t.text",
    rodataDirective: "\t.section .rodata",
    functionAttributes: (symbol) => [`\t.type ${symbol}, @function`],
  },
  coff: {
    name: "coff",
    symbolPrefix: "",
    textDirective: "\t.text",
    rodataDirective: '\t.section .rdata,"dr"',
    functionAttributes: (symbol) => [
      `\t.def ${symbol}; .scl 2; .type 32; .endef`,
    ],
  },
  macho: {
    name: "macho",
    symbolPrefix: "_",
    textDirective: "\t.section __TEXT,__text,regular,pure_instructions",
    rodataDirective: "\t.section __TEXT,__const",
    functionAttributes: () => [],
  },
};

export function objectFormat(name: ObjectFormatName): ObjectFormat {
  return FORMATS[name];
}

export function hostObjectFormat(platform: string): ObjectFormatName {
  if (platform === "win32") return "coff";
  if (platform === "darwin") return "macho";
  return "elf";
}
