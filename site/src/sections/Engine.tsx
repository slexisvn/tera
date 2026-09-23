import {
  ArrowRight,
  ArrowUpRight,
  Braces,
  Cpu,
  Network,
  Table2,
  Workflow,
} from "lucide-react";
import { engine, links } from "../content/site";
import { SectionHeading } from "../components/SectionHeading";
import { Link } from "../components/Link";

function LanguageDiagram() {
  return (
    <div
      className="compiler-map"
      role="img"
      aria-label="Tera source has two execution paths: tiered JIT, starting in the interpreter then JavaScript and WebAssembly; and native AOT, producing a native executable."
    >
      <div className="compiler-source">
        <Braces size={26} />
        <span>hello.tera</span>
        <code>
          <i>fn</i> square(x: int):
          <br />
          &nbsp; <i>return</i> x * x
        </code>
      </div>
      <div className="compiler-fork" aria-hidden="true">
        <span />
        <span />
      </div>
      <div className="compiler-paths">
        <div className="compiler-path">
          <div className="compiler-path-label">
            <b>JIT</b>
            <span>OPTIMIZE AS YOU RUN</span>
          </div>
          <div className="compiler-tiers">
            <span>Interpreter</span>
            <ArrowRight size={14} />
            <span className="compiler-tier">
              JS<small>baseline</small>
            </span>
            <ArrowRight size={14} />
            <span className="compiler-hot">
              <span className="compiler-tier">
                Wasm<small>optimizing</small>
              </span>
              <span className="heat-bars">
                <i />
                <i />
                <i />
                <i />
              </span>
            </span>
          </div>
        </div>
        <div className="compiler-path">
          <div className="compiler-path-label">
            <b>AOT</b>
            <span>COMPILE AHEAD</span>
          </div>
          <div className="compiler-tiers">
            <span>Optimize</span>
            <ArrowRight size={14} />
            <span className="compiler-native">
              <Cpu size={17} />
              Native binary
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function QueryDiagram() {
  return (
    <div
      className="query-compare"
      role="img"
      aria-label="Illustrative predicate pushdown: a filter on table A moves before an inner join, reducing rows entering the join."
    >
      <div className="query-plan">
        <p>Before · logical plan</p>
        <svg viewBox="0 0 200 210" aria-hidden="true">
          <g className="plan-wires">
            <path d="M48 42V68H100V94 M152 42V68H100 M100 134V162" />
          </g>
          <g className="plan-node">
            <rect x="15" y="10" width="66" height="32" rx="4" />
            <rect x="119" y="10" width="66" height="32" rx="4" />
            <rect x="48" y="94" width="104" height="40" rx="4" />
            <rect x="48" y="162" width="104" height="40" rx="4" />
          </g>
          <g className="art-label">
            <text x="48" y="32">
              A
            </text>
            <text x="152" y="32">
              B
            </text>
            <text x="100" y="120">
              join
            </text>
            <text x="100" y="188">
              filter A
            </text>
          </g>
          <g className="plan-row-marks">
            {[0, 1, 2, 3, 4].map((i) => (
              <path key={i} d={`M${84 + i * 8} 76v10`} />
            ))}
          </g>
        </svg>
      </div>
      <ArrowRight
        className="query-rewrite-arrow"
        size={22}
        aria-hidden="true"
      />
      <div className="query-plan query-plan-optimized">
        <p>After · filter pushdown</p>
        <svg viewBox="0 0 200 210" aria-hidden="true">
          <g className="plan-wires">
            <path d="M48 42V67 M152 42V121H100 M48 103V121H100V147 M100 187V200" />
          </g>
          <g className="plan-node">
            <rect x="15" y="10" width="66" height="32" rx="4" />
            <rect x="119" y="10" width="66" height="32" rx="4" />
            <rect
              className="plan-optimized"
              x="1"
              y="67"
              width="94"
              height="36"
              rx="4"
            />
            <rect
              className="plan-optimized"
              x="48"
              y="147"
              width="104"
              height="40"
              rx="4"
            />
          </g>
          <g className="art-label">
            <text x="48" y="32">
              A
            </text>
            <text x="152" y="32">
              B
            </text>
            <text className="art-accent" x="48" y="91">
              filter A
            </text>
            <text className="art-accent" x="100" y="173">
              join
            </text>
          </g>
          <g className="plan-row-marks optimized">
            <path d="M96 128v10M104 128v10" />
          </g>
          <g className="result-cells">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <rect
                key={i}
                x={65 + i * 13}
                y="200"
                width="9"
                height="9"
                rx="1"
              />
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

function MLDiagram() {
  return (
    <div
      className="ml-lowering"
      role="img"
      aria-label="Example compilation: Graph IR represents MatMul, Add bias, and ReLU. Tensor IR lowers these operations to scheduled loops. Low-level IR uses flat buffer addresses before backend kernel generation."
    >
      <div className="ml-stage">
        <p className="ml-stage-label">
          <span>01</span> Graph IR
        </p>
        <div className="ml-operations">
          <span>
            MatMul<small>x · weights</small>
          </span>
          <ArrowRight size={14} />
          <span>
            Add<small>bias</small>
          </span>
          <ArrowRight size={14} />
          <span>
            ReLU<small>max(0, x)</small>
          </span>
        </div>
      </div>
      <div className="ml-stage">
        <p className="ml-stage-label">
          <span>02</span> Tensor IR
        </p>
        <div className="ml-loop">
          <div className="ml-tiles" aria-hidden="true">
            {Array.from({ length: 16 }, (_, i) => (
              <i className={i % 4 < 2 && i < 8 ? "active" : ""} key={i} />
            ))}
          </div>
          <div>
            <code>for tile(i, j)</code>
            <span>Lower & schedule loops</span>
          </div>
        </div>
      </div>
      <div className="ml-stage">
        <p className="ml-stage-label">
          <span>03</span> Low-level IR
        </p>
        <div className="ml-kernel">
          <code>buffer[i * width + j]</code>
          <span>
            <Cpu size={16} />
            Backend kernels
          </span>
        </div>
      </div>
    </div>
  );
}

const visuals = [LanguageDiagram, QueryDiagram, MLDiagram];
const icons = [Braces, Table2, Network];
const labels = ["LANGUAGE COMPILER", "QUERY OPTIMIZER", "ML COMPILER"];
const captions = [
  "One source. Two execution paths.",
  "Filter earlier. Send fewer rows into the join.",
  "Tensor math, lowered into executable kernels.",
];

export function Engine() {
  return (
    <section className="section engine-section" id="engine">
      <SectionHeading {...engine} />
      <div className="engine-cards">
        {engine.systems.map((system, index) => {
          const Visual = visuals[index];
          const Icon = icons[index];
          return (
            <article
              className="engine-card reveal"
              data-engine={system.id}
              key={system.id}
              aria-labelledby={`engine-${system.id}-title`}
            >
              <div className="engine-card-copy">
                <div className="engine-card-label">
                  <Icon size={18} aria-hidden="true" />
                  <span>{labels[index]}</span>
                  <span className="engine-card-index">0{index + 1}</span>
                </div>
                <h3 id={`engine-${system.id}-title`}>{system.title}</h3>
                <p>{system.description}</p>
              </div>
              <figure className="engine-figure">
                <Visual />
                <figcaption>{captions[index]}</figcaption>
              </figure>
              <div className="engine-card-footer">
                <span>
                  {index === 0
                    ? "EXECUTION"
                    : index === 1
                      ? "ENGINE"
                      : "TARGETS"}
                </span>
                <div>
                  {system.targets.map((target) => (
                    <span key={target}>{target}</span>
                  ))}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <Link href={links.visualizer} className="engine-visualizer">
        <Workflow size={19} aria-hidden="true" />
        <span>
          {engine.visualizer}
          <small>Explore the language pipeline, pass by pass.</small>
        </span>
        <ArrowUpRight size={19} aria-hidden="true" />
      </Link>
    </section>
  );
}
