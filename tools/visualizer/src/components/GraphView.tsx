import { useMemo, useState } from "react";
import { useZoomPan } from "../services/use-zoom-pan";
import { diffIR } from "../services/ir-diff";
import { nodeByKey, parseGraphText } from "../services/ir-graph";
import {
  ARROW_KINDS,
  ARROW_LENGTH,
  ARROW_WIDTH,
  arrowMarkerId,
  dataEdgesInto,
  layoutGraph,
  type GraphLayout,
  type PlacedNode,
  type RoutedEdge,
} from "../services/graph-layout";

type GraphViewProps = {
  text: string;
  before: string | null;
  selectedNode: string | null;
  onSelectNode: (key: string | null) => void;
  onHoverNode: (key: string | null) => void;
};

const NODE_TEXT_LIMIT = 40;

const MIN_DETAIL_SCALE = 0.72;

const MAX_COUNTER_SCALE = 2.6;

const MINIMAP_WIDTH = 132;
const MINIMAP_MAX_HEIGHT = 116;

function shorten(text: string): string {
  return text.length > NODE_TEXT_LIMIT ? `${text.slice(0, NODE_TEXT_LIMIT - 1)}…` : text;
}

function EdgePath({ edge }: { edge: RoutedEdge }) {
  return (
    <path className={`graph-edge ${edge.kind}`} markerEnd={`url(#${arrowMarkerId(edge.kind)})`} d={edge.path} />
  );
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
  const layout = useMemo(() => (model === null ? null : layoutGraph(model)), [model]);

  return (
    <GraphCanvas
      model={model}
      layout={layout}
      marks={marks}
      selectedNode={selectedNode}
      onSelectNode={onSelectNode}
      onHoverNode={onHoverNode}
    />
  );
}

type GraphCanvasProps = {
  model: ReturnType<typeof parseGraphText>;
  layout: GraphLayout | null;
  marks: ReadonlyMap<string, string>;
  selectedNode: string | null;
  onSelectNode: (key: string | null) => void;
  onHoverNode: (key: string | null) => void;
};

function GraphCanvas({ model, layout, marks, selectedNode, onSelectNode, onHoverNode }: GraphCanvasProps) {
  const { surface, view, box, panning, wasDragged, zoomBy, fit, reset } = useZoomPan(
    { width: layout?.width ?? 0, height: layout?.height ?? 0 },
    "width",
  );
  const [cursor, setCursor] = useState(0);

  const walk = useMemo(
    () => (layout === null ? [] : layout.blocks.flatMap((placed) => placed.nodes)),
    [layout],
  );

  if (model === null || layout === null) {
    return <div className="viewer-note">This stage is not a printed SSA graph, so there is nothing to draw.</div>;
  }

  const selected = selectedNode === null ? null : nodeByKey(model, selectedNode);
  const feeds = new Set(selected?.inputs ?? []);
  const dataflow = selected === null ? [] : dataEdgesInto(layout, selected);
  const detailed = view.k >= MIN_DETAIL_SCALE;
  const counter = Math.min(1 / view.k, MAX_COUNTER_SCALE);
  const at = walk.length === 0 ? null : (walk[Math.min(cursor, walk.length - 1)] ?? null);

  const move = (delta: number): void => {
    if (walk.length === 0) return;
    setCursor((current) => Math.min(walk.length - 1, Math.max(0, current + delta)));
  };

  const onKeyDown = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") move(1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") move(-1);
    else if (event.key === "Home") setCursor(0);
    else if (event.key === "End") setCursor(walk.length - 1);
    else if (event.key === "Enter" || event.key === " ") {
      if (at !== null) onSelectNode(at.node.key === selectedNode ? null : at.node.key);
    } else if (event.key === "Escape") onSelectNode(null);
    else return;
    event.preventDefault();
  };

  return (
    <div className="graph">
      <div className="graph-controls">
        <button type="button" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out">−</button>
        <span className="graph-scale">{Math.round(view.k * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.3)} aria-label="Zoom in">+</button>
        <button type="button" onClick={fit} title="Scale the graph to the width of this pane">Fit</button>
        <button type="button" onClick={reset} title="Show the graph at full size">1:1</button>
      </div>
      <svg
        ref={surface}
        className={`graph-canvas${panning ? " panning" : ""}`}
        tabIndex={0}
        role="group"
        aria-label={`Control flow graph of ${model.name}. Arrow keys move between values, Enter follows the one you are on.`}
        onKeyDown={onKeyDown}
      >
        <defs>
          {ARROW_KINDS.map((kind) => (
            <marker
              key={kind}
              id={arrowMarkerId(kind)}
              markerUnits="userSpaceOnUse"
              markerWidth={ARROW_LENGTH}
              markerHeight={ARROW_WIDTH}
              refX="0"
              refY={ARROW_WIDTH / 2}
              orient="auto"
            >
              <path
                className={`graph-arrow ${kind}`}
                d={`M 0 0 L ${ARROW_LENGTH} ${ARROW_WIDTH / 2} L 0 ${ARROW_WIDTH} z`}
              />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.edges.map((edge) => (
            <EdgePath key={edge.key} edge={edge} />
          ))}
          {layout.blocks.map((placed) => (
            <g key={placed.block.label}>
              <rect
                className={`graph-block${placed.block.isLoopHeader ? " loop" : ""}`}
                x={placed.x}
                y={placed.y}
                width={placed.width}
                height={placed.height}
                rx={placed.radius}
              />
              {detailed ? (
                <text className="graph-block-label" x={placed.label.x} y={placed.label.y}>
                  {placed.block.label}
                  {placed.block.isLoopHeader ? "  loop header" : ""}
                </text>
              ) : (
                <g transform={`translate(${placed.label.x} ${placed.label.y}) scale(${counter})`}>
                  <text className="graph-block-label" x="0" y="0">
                    {placed.block.label}
                    {placed.block.isLoopHeader ? "  loop" : ""}
                  </text>
                  <text className="graph-node summary" x="0" y="15">
                    {placed.nodes.length === 0
                      ? "(empty)"
                      : `${placed.nodes.length} value${placed.nodes.length === 1 ? "" : "s"}`}
                  </text>
                </g>
              )}
              {detailed ? (
                placed.nodes.map((line) => (
                  <NodeText
                    key={line.node.key}
                    line={line}
                    mark={marks.get(line.node.key) ?? ""}
                    selected={line.node.key === selectedNode}
                    feeds={feeds.has(line.node.key)}
                    cursor={at?.node.key === line.node.key}
                    onHover={onHoverNode}
                    onPick={() => {
                      if (wasDragged()) return;
                      onSelectNode(line.node.key === selectedNode ? null : line.node.key);
                    }}
                  />
                ))
              ) : null}
              {detailed && placed.nodes.length === 0 && (
                <text className="graph-node empty" x={placed.firstLine.x} y={placed.firstLine.y}>
                  (empty)
                </text>
              )}
            </g>
          ))}
          {dataflow.map((edge) => (
            <EdgePath key={edge.key} edge={edge} />
          ))}
        </g>
      </svg>
      <Minimap layout={layout} view={view} box={box} />
      {!detailed && (
        <p className="graph-tip">Zoom past {Math.round(MIN_DETAIL_SCALE * 100)}% to read the values inside each block.</p>
      )}
      {detailed && selectedNode === null && (
        <p className="graph-tip">Hover a value to light up the line it came from; click to pin it and see what feeds it.</p>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {at === null ? "" : at.node.text}
      </p>
    </div>
  );
}

type NodeTextProps = {
  line: PlacedNode;
  mark: string;
  selected: boolean;
  feeds: boolean;
  cursor: boolean;
  onHover: (key: string | null) => void;
  onPick: () => void;
};

function NodeText({ line, mark, selected, feeds, cursor, onHover, onPick }: NodeTextProps) {
  return (
    <text
      className={["graph-node", mark, selected ? "selected" : "", feeds ? "feeds" : "", cursor ? "cursor" : ""]
        .filter(Boolean)
        .join(" ")}
      x={line.text.x}
      y={line.text.y}
      onPointerEnter={() => onHover(line.node.key)}
      onPointerLeave={() => onHover(null)}
      onClick={onPick}
    >
      <title>{line.node.text}</title>
      {shorten(line.node.text)}
    </text>
  );
}

type MinimapProps = {
  layout: GraphLayout;
  view: { x: number; y: number; k: number };
  box: { width: number; height: number };
};

function Minimap({ layout, view, box }: MinimapProps) {
  if (box.width === 0 || layout.width === 0 || layout.height === 0) return null;
  const covered = { width: box.width / view.k, height: box.height / view.k };
  if (covered.width >= layout.width && covered.height >= layout.height) return null;

  const scale = Math.min(MINIMAP_WIDTH / layout.width, MINIMAP_MAX_HEIGHT / layout.height);
  return (
    <svg
      className="graph-minimap"
      aria-hidden="true"
      width={layout.width * scale}
      height={layout.height * scale}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >
      {layout.blocks.map((placed) => (
        <rect
          key={placed.block.label}
          className="minimap-block"
          x={placed.x}
          y={placed.y}
          width={placed.width}
          height={placed.height}
        />
      ))}
      <rect
        className="minimap-view"
        x={-view.x / view.k}
        y={-view.y / view.k}
        width={covered.width}
        height={covered.height}
      />
    </svg>
  );
}
