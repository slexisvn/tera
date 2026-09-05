export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

export function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

const CAMEL_MEMBER = /^[a-z][A-Za-z0-9]*$/;
const CAMEL_BOUNDARY = /[a-z0-9][A-Z]/;

export function spellings(name: string): readonly string[] {
  const camel = CAMEL_MEMBER.test(name) && CAMEL_BOUNDARY.test(name);
  return camel ? [name, camelToSnake(name)] : [name];
}
