export function takeNamed(args) {
  const last = args[args.length - 1];
  return last && last.__named ? args.pop() : {};
}
