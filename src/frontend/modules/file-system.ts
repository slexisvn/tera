export type ModuleFileSystem = {
  readonly separator: string;
  readFile(target: string): string;
  isFile(target: string): boolean;
  isDirectory(target: string): boolean;
  canonical(target: string): string;
  resolve(target: string): string;
  join(...segments: string[]): string;
  dirname(target: string): string;
  relative(from: string, to: string): string;
  isAbsolute(target: string): boolean;
};
