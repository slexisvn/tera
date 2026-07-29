export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

export function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
