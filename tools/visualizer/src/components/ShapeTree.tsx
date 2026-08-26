import { useMemo } from "react";
import { countShapes, deepestShape, shapeForest, type ShapeNode } from "../services/shape-tree";
import type { ShapeEdge } from "../types/stage";

function Branch({ nodes }: { nodes: readonly ShapeNode[] }) {
  return (
    <ul className="shape-branch">
      {nodes.map((node) => (
        <li key={`${node.id}-${node.property}-${node.kind}`}>
          <span className={`shape-edge ${node.kind ?? "root"}`}>
            {node.property === null ? "empty shape" : `${node.kind === "delete" ? "delete " : "+"}${node.property}`}
          </span>
          <span className="shape-id">HC{node.id}</span>
          {node.properties !== null && (
            <span className="shape-count" title="Properties this shape holds">
              {node.properties} props
            </span>
          )}
          {node.hits > 1 && (
            <span className="shape-hits" title="How many times an object took this exact transition">
              ×{node.hits}
            </span>
          )}
          {node.children.length > 0 && <Branch nodes={node.children} />}
        </li>
      ))}
    </ul>
  );
}

export function ShapeTree({ edges }: { edges: readonly ShapeEdge[] }) {
  const forest = useMemo(() => shapeForest(edges), [edges]);

  if (forest.length === 0) {
    return (
      <p className="console-note">
        No hidden class transition was recorded. Objects only build a shape chain when the program
        creates them and adds properties — a program of plain numbers never touches this machinery.
      </p>
    );
  }

  const total = countShapes(forest);
  const deepest = deepestShape(forest);

  return (
    <div className="shapes">
      <div className="shapes-head">
        <span className="shapes-fact">{total} shapes</span>
        <span className="shapes-fact" title="The longest chain of transitions any object walked">
          deepest chain {deepest}
        </span>
        <span className="shapes-fact" title="Separate chains, each starting from a shape nothing transitions into">
          {forest.length} {forest.length === 1 ? "root" : "roots"}
        </span>
      </div>
      <Branch nodes={forest} />
      <p className="shapes-legend">
        Every object starts at an empty shape and moves one step down this tree for each property it
        gains, in the order the program assigns them. Two objects share a shape — and so can share an
        inline cache — only if they walked the identical path. Building the same object with its
        properties in a different order lands somewhere else in this tree, which is why property
        order is a performance decision.
      </p>
    </div>
  );
}
