import {
  homeInstruction,
  irConstant,
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_LOAD_GLOBAL,
  IR_STORE_GLOBAL,
} from "../ir/index.js";
import { addPhi } from "../ir/cfg-edit.js";
import { nodeIdStamper } from "../ir/graph-edit.js";
import { GraphEditor } from "../ir/editor.js";
import { eliminateTrivialPhis } from "./dce.js";
import { DominatorTree } from "../analyses/dominance.js";

type Stamp = (node: CFGInstruction) => CFGInstruction;

export function globalNameOf(node: CFGInstruction): string | null {
  if (node.type !== IR_LOAD_GLOBAL && node.type !== IR_STORE_GLOBAL) return null;
  const name = node.props.name;
  return typeof name === "string" ? name : null;
}

function assignedBlocks(
  graph: CFGFunction,
  only: ReadonlySet<string>,
): Map<string, Set<CFGBlock>> {
  const blocks = new Map<string, Set<CFGBlock>>();
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (node.type !== IR_STORE_GLOBAL) continue;
      const name = globalNameOf(node);
      if (name === null || !only.has(name)) continue;
      let owners = blocks.get(name);
      if (owners === undefined) {
        owners = new Set<CFGBlock>();
        blocks.set(name, owners);
      }
      owners.add(block);
    }
  }
  return blocks;
}

class Promotion {
  private readonly editor: GraphEditor;
  private readonly stamp: Stamp;
  private readonly dominance: DominatorTree;
  private readonly phis = new Map<CFGBlock, Map<string, CFGInstruction>>();
  private readonly stacks = new Map<string, CFGInstruction[]>();
  private readonly visited = new Set<CFGBlock>();
  private absent: CFGInstruction | null = null;

  constructor(
    private readonly graph: CFGFunction,
    private readonly definitions: Map<string, Set<CFGBlock>>,
  ) {
    this.editor = new GraphEditor(graph);
    this.stamp = nodeIdStamper(graph);
    this.dominance = new DominatorTree(graph);
    for (const name of definitions.keys()) this.stacks.set(name, []);
  }

  run(): void {
    for (const [name, blocks] of this.definitions) this.placePhis(name, blocks);
    if (this.graph.entry !== null) this.rename(this.graph.entry);
    this.discardUnreached();
    this.graph.rebuildUses();
    eliminateTrivialPhis(this.graph);
    this.graph.rebuildUses();
    this.dropUnusedAbsence();
  }

  private placePhis(name: string, blocks: ReadonlySet<CFGBlock>): void {
    const worklist = [...blocks];
    const placed = new Set<CFGBlock>();
    while (worklist.length > 0) {
      const block = worklist.pop()!;
      for (const join of this.dominance.frontierOf(block)) {
        if (placed.has(join)) continue;
        placed.add(join);
        this.definePhi(join, name);
        if (!blocks.has(join)) worklist.push(join);
      }
    }
  }

  private definePhi(block: CFGBlock, name: string): void {
    const phi = this.stamp(addPhi(block));
    for (let index = 0; index < block.predecessors.length; index += 1) {
      phi.addInput(this.absence());
    }
    let byName = this.phis.get(block);
    if (byName === undefined) {
      byName = new Map<string, CFGInstruction>();
      this.phis.set(block, byName);
    }
    byName.set(name, phi);
  }

  private absence(): CFGInstruction {
    this.absent ??= this.stamp(homeInstruction(irConstant(undefined), this.graph.entry!));
    return this.absent;
  }

  private reaching(name: string): CFGInstruction {
    const stack = this.stacks.get(name)!;
    return stack[stack.length - 1] ?? this.absence();
  }

  private enter(block: CFGBlock): readonly string[] {
    this.visited.add(block);
    const bound: string[] = [];
    for (const [name, phi] of this.phis.get(block) ?? []) {
      this.stacks.get(name)!.push(phi);
      bound.push(name);
    }
    for (const node of [...block.nodes]) {
      const name = globalNameOf(node);
      if (name === null || !this.definitions.has(name)) continue;
      if (node.type === IR_STORE_GLOBAL) {
        this.stacks.get(name)!.push(node.inputs[0]!);
        bound.push(name);
      } else {
        this.editor.replaceAllUses(node, this.reaching(name));
      }
      this.editor.remove(node);
    }
    for (const successor of block.successors) {
      const byName = this.phis.get(successor);
      if (byName === undefined) continue;
      const slot = successor.predecessors.indexOf(block);
      if (slot < 0) continue;
      for (const [name, phi] of byName) this.editor.setInput(phi, slot, this.reaching(name));
    }
    return bound;
  }

  private rename(entry: CFGBlock): void {
    type Frame = { readonly bound: readonly string[]; readonly children: CFGBlock[] };
    const frames: Frame[] = [
      { bound: this.enter(entry), children: [...this.dominance.childrenOf(entry)] },
    ];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const child = frame.children.pop();
      if (child === undefined) {
        for (const name of frame.bound) this.stacks.get(name)!.pop();
        frames.pop();
        continue;
      }
      frames.push({
        bound: this.enter(child),
        children: [...this.dominance.childrenOf(child)],
      });
    }
  }

  private discardUnreached(): void {
    for (const block of this.graph.blocks) {
      if (this.visited.has(block)) continue;
      for (const node of [...block.nodes]) {
        const name = globalNameOf(node);
        if (name === null || !this.definitions.has(name)) continue;
        if (node.type === IR_LOAD_GLOBAL) this.editor.replaceAllUses(node, this.absence());
        this.editor.remove(node);
      }
    }
  }

  private dropUnusedAbsence(): void {
    if (this.absent === null || this.absent.uses.length > 0) return;
    this.editor.remove(this.absent);
    this.graph.rebuildUses();
  }
}

export function promoteAssignedGlobals(
  graph: CFGFunction,
  only: ReadonlySet<string>,
): number {
  const definitions = assignedBlocks(graph, only);
  if (definitions.size === 0) return 0;
  new Promotion(graph, definitions).run();
  return definitions.size;
}
