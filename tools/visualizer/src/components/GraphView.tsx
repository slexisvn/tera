import { useMemo } from "react";
import { useZoomPan } from "../services/use-zoom-pan";
import { diffIR } from "../services/ir-diff";
import { layerBlocks, nodeByKey, parseGraphText, type IrBlock } from "../services/ir-graph";

type Anchor = { readonly x: number; readonly y: number };

const BLOCK_WIDTH = 260;
const ROW_GAP = 46;
const COLUMN_GAP = 32;
const HEADER_HEIGHT = 26;
const NODE_HEIGHT = 17;
const PADDING = 24;

type Placed = {
  readonly block: IrBlock;
  readonly x: number;
  readonly y: number;
  readonly height: number;
};

type GraphViewProps = {
  text: string;
  before: string | null;
  selectedNode: string | null;
  onSelectNode: (key: string | null) => void;
  onHoverNode: (key: string | null) => void;
};

function heightOf(block: IrBlock): number {
  return HEADER_HEIGHT + Math.max(1, block.nodes.length) * NODE_HEIGHT + 8;
}

const ARROW_GAP = 3;
const SIDE_BULGE = 30;

/** Down the page: leave the bottom edge, arrive at the top edge. */
function forwardEdgePath(from: Placed, to: Placed): string {
  const x1 = from.x + BLOCK_WIDTH / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + BLOCK_WIDTH / 2;
  const y2 = to.y - ARROW_GAP;
  const bend = Math.max(18, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
}

const CORNER = 10;

/** Rounded polyline through the given corners. */
function orthogonal(points: readonly Anchor[]): string {
  const parts = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let at = 1; at < points.length - 1; at++) {
    const previous = points[at - 1]!;
    const corner = points[at]!;
    const next = points[at + 1]!;
    const into = trim(corner, previous);
    const out = trim(corner, next);
    parts.push(`L ${into.x} ${into.y}`, `Q ${corner.x} ${corner.y}, ${out.x} ${out.y}`);
  }
  const last = points[points.length - 1]!;
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}

function trim(corner: Anchor, toward: Anchor): Anchor {
  const dx = toward.x - corner.x;
  const dy = toward.y - corner.y;
  const length = Math.hypot(dx, dy);
  if (length <= CORNER) return toward;
  return { x: corner.x + (dx / length) * CORNER, y: corner.y + (dy / length) * CORNER };
}

function rowBottomOf(block: Placed, all: readonly Placed[]): number {
  let bottom = block.y + block.height;
  for (const other of all) {
    if (other.y === block.y) bottom = Math.max(bottom, other.y + other.height);
  }
  return bottom;
}

/**
 * Back up the page. A single curve cannot do this: the source usually has a
 * neighbour to its right, so the edge has to drop into the corridor below its
 * own row, run right past everything, climb, and come back in under the target.
 */
function backEdgePath(from: Placed, to: Placed, all: readonly Placed[]): string {
  const exitX = from.x + BLOCK_WIDTH / 2;
  const fromCorridor = rowBottomOf(from, all) + ROW_GAP / 2;
  const entryX = to.x + BLOCK_WIDTH / 2;
  const toCorridor = rowBottomOf(to, all) + ROW_GAP / 2;

  const top = Math.min(fromCorridor, toCorridor);
  const bottom = Math.max(fromCorridor, toCorridor);
  let rightmost = Math.max(from.x, to.x) + BLOCK_WIDTH;
  for (const block of all) {
    if (block.y > bottom || block.y + block.height < top) continue;
    rightmost = Math.max(rightmost, block.x + BLOCK_WIDTH);
  }
  const lane = rightmost + SIDE_BULGE;

  return orthogonal([
    { x: exitX, y: from.y + from.height },
    { x: exitX, y: fromCorridor },
    { x: lane, y: fromCorridor },
    { x: lane, y: toCorridor },
    { x: entryX, y: toCorridor },
    { x: entryX, y: to.y + to.height + ARROW_GAP },
  ]);
}

/**
 * Which way an edge actually runs on the canvas. The model's own notion of a
 * back edge follows printed order, but the layout orders blocks by depth, so an
 * edge can run upward on screen while the model calls it forward — drawing that
 * with the forward path is what produced a straight line across the graph.
 */
function runsBackward(from: Placed, to: Placed): boolean {
  return to.y <= from.y;
}

const FLOW_LANE = 18;

/** Producer to consumer, routed down a lane left of both blocks. */
function flowPath(from: Anchor, to: Anchor): string {
  const lane = Math.min(from.x, to.x) - FLOW_LANE;
  return `M ${from.x} ${from.y} C ${lane} ${from.y}, ${lane} ${to.y}, ${to.x - ARROW_GAP} ${to.y}`;
}

export function GraphView({ text, before, selectedNode, onSelectNode, onHoverNode }: GraphViewProps) {
  const model = useMemo(() => parseGraphText(text), [text]);
  const marks = useMemo(() => {
    if (before === null) return new Map<string, string>();
    const kinds = new Map<string, string>();
    for (const row of diffIR(before, text)) {
      if (row.kind !== "same") kinds.set(row.key, row.kind);
    }
    return kinds;
  }, [before, text]);

  const placement = useMemo(() => {
    if (model === null) return null;
    const rows = layerBlocks(model);
    const placed: Placed[] = [];
    let y = PADDING;
    let width = 0;
    for (const row of rows) {
      let x = PADDING;
      let tallest = 0;
      for (const block of row) {
        const height = heightOf(block);
        placed.push({ block, x, y, height });
        x += BLOCK_WIDTH + COLUMN_GAP;
        tallest = Math.max(tallest, height);
      }
      width = Math.max(width, x);
      y += tallest + ROW_GAP;
    }
    return { placed, width: width + PADDING, height: y + PADDING };
  }, [model]);

  return (
    <GraphCanvas
      model={model}
      placement={placement}
      marks={marks}
      selectedNode={selectedNode}
      onSelectNode={onSelectNode}
      onHoverNode={onHoverNode}
    />
  );
}

type Placement = { readonly placed: readonly Placed[]; readonly width: number; readonly height: number };

type GraphCanvasProps = {
  model: ReturnType<typeof parseGraphText>;
  placement: Placement | null;
  marks: ReadonlyMap<string, string>;
  selectedNode: string | null;
  onSelectNode: (key: string | null) => void;
  onHoverNode: (key: string | null) => void;
};

function GraphCanvas({ model, placement, marks, selectedNode, onSelectNode, onHoverNode }: GraphCanvasProps) {
  const { surface, view, panning, wasDragged, zoomBy, fit, reset } = useZoomPan({
    width: placement?.width ?? 0,
    height: placement?.height ?? 0,
  });

  if (model === null || placement === null) {
    return <div className="viewer-note">This stage is not a printed SSA graph, so there is nothing to draw.</div>;
  }

  const byLabel = new Map(placement.placed.map((entry) => [entry.block.label, entry]));

  // Where each value is written. The anchor sits on the block's left border, not
  // on the text, so a connector runs in the gutter instead of across the lines.
  const anchorOf = new Map<string, Anchor>();
  for (const { block, x, y } of placement.placed) {
    block.nodes.forEach((node, at) => {
      anchorOf.set(node.key, { x, y: y + HEADER_HEIGHT + 8 + at * NODE_HEIGHT });
    });
  }
  const selected = selectedNode === null ? null : nodeByKey(model, selectedNode);
  const feeds = new Set(selected?.inputs ?? []);
  const dataflow =
    selected === null
      ? []
      : selected.inputs
          .map((input) => ({ from: anchorOf.get(input), to: anchorOf.get(selected.key), key: input }))
          .filter((edge): edge is { from: Anchor; to: Anchor; key: string } =>
            edge.from !== undefined && edge.to !== undefined,
          );

  return (
    <div className="graph">
      <div className="graph-controls">
        <button type="button" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out">−</button>
        <span className="graph-scale">{Math.round(view.k * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.3)} aria-label="Zoom in">+</button>
        <button type="button" onClick={fit}>Fit</button>
        <button type="button" onClick={reset}>1:1</button>
      </div>
      <svg
        ref={surface}
        className={`graph-canvas${panning ? " panning" : ""}`}
        role="img"
        aria-label={`Control flow graph of ${model.name}`}
      >
        <defs>
          <marker id="graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className="graph-arrow-head" />
          </marker>
          <marker id="graph-back-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className="graph-back-head" />
          </marker>
          <marker id="graph-flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className="graph-flow-head" />
          </marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {placement.placed.map((from) =>
          from.block.successors.map((label) => {
            const to = byLabel.get(label);
            if (to === undefined) return null;
            const back = runsBackward(from, to);
            return (
              <path
                key={`${from.block.label}-${label}`}
                className={`graph-edge${back ? " back" : ""}`}
                markerEnd={back ? "url(#graph-back-arrow)" : "url(#graph-arrow)"}
                d={back ? backEdgePath(from, to, placement.placed) : forwardEdgePath(from, to)}
              />
            );
          }),
        )}
        {dataflow.map((edge) => (
          <path
            key={`flow-${edge.key}`}
            className="graph-flow"
            markerEnd="url(#graph-flow-arrow)"
            d={flowPath(edge.from, edge.to)}
          />
        ))}
        {placement.placed.map(({ block, x, y, height }) => (
          <g key={block.label} transform={`translate(${x} ${y})`}>
            <rect
              className={`graph-block${block.isLoopHeader ? " loop" : ""}`}
              width={BLOCK_WIDTH}
              height={height}
              rx="8"
            />
            <text className="graph-block-label" x="10" y="17">
              {block.label}
              {block.isLoopHeader ? "  loop header" : ""}
            </text>
            {block.nodes.map((node, at) => (
              <text
                key={node.key}
                className={[
                  "graph-node",
                  marks.get(node.key) ?? "",
                  node.key === selectedNode ? "selected" : "",
                  feeds.has(node.key) ? "feeds" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                x="12"
                y={HEADER_HEIGHT + 12 + at * NODE_HEIGHT}
                onPointerEnter={() => onHoverNode(node.key)}
                onPointerLeave={() => onHoverNode(null)}
                onClick={() => {
                  if (wasDragged()) return;
                  onSelectNode(node.key === selectedNode ? null : node.key);
                }}
              >
                <title>{node.text}</title>
                {node.text.length > 40 ? `${node.text.slice(0, 39)}…` : node.text}
              </text>
            ))}
            {block.nodes.length === 0 && (
              <text className="graph-node empty" x="12" y={HEADER_HEIGHT + 12}>
                (empty)
              </text>
            )}
          </g>
        ))}
        </g>
      </svg>
    </div>
  );
}
