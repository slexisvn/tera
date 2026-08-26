import { REMARK_TITLES, type RemarkKind, type StageRemark } from "../types/stage";

const ORDER: readonly RemarkKind[] = ["missed", "applied", "analysis"];

type RemarkListProps = {
  remarks: readonly StageRemark[];
  selectedNode: string | null;
  onSelectNode?: (key: string | null) => void;
  onHoverNode?: (key: string | null) => void;
};

export function RemarkList({
  remarks,
  selectedNode,
  onSelectNode,
  onHoverNode,
}: RemarkListProps) {
  if (remarks.length === 0) {
    return (
      <div className="viewer-note">
        This pass recorded no remarks. Either it has nothing to explain, or nobody has taught it to
        say why yet.
      </div>
    );
  }

  const buckets = ORDER.map(
    (kind) => [kind, remarks.filter((remark) => remark.kind === kind)] as const,
  ).filter(([, bucket]) => bucket.length > 0);

  return (
    <div className="remarks">
      {buckets.map(([kind, bucket]) => (
        <section className={`remark-group remark-${kind}`} key={kind}>
          <h3>
            {REMARK_TITLES[kind]} <span className="remark-count">{bucket.length}</span>
          </h3>
          <ul>
            {bucket.map((remark, at) => (
              <li key={`${remark.node}-${at}`}>
                {remark.node === null ? (
                  <span className="remark-node empty">pass</span>
                ) : (
                  <button
                    type="button"
                    className={`remark-node${remark.node === selectedNode ? " active" : ""}`}
                    title={`Select ${remark.node} in the graph`}
                    onClick={() => onSelectNode?.(remark.node)}
                    onMouseEnter={() => onHoverNode?.(remark.node)}
                    onMouseLeave={() => onHoverNode?.(null)}
                  >
                    {remark.node}
                  </button>
                )}
                <span className="remark-message">{remark.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
