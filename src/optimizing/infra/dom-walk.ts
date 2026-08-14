export interface ScopedVisitor<B, S> {
  fork(state: S): S;
  visitBlock(block: B, state: S): void;
}

export function walkDominatorTree<B, S>(
  root: B,
  childrenOf: (block: B) => readonly B[],
  initial: S,
  visitor: ScopedVisitor<B, S>,
): void {
  const stack: Array<{ block: B; state: S }> = [{ block: root, state: initial }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    visitor.visitBlock(frame.block, frame.state);
    const children = childrenOf(frame.block);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ block: children[i]!, state: visitor.fork(frame.state) });
    }
  }
}
