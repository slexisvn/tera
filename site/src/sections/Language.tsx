import {
  Braces,
  Table2,
  Box,
  Network,
  ChartNoAxesColumn,
  Check,
  ArrowRight,
} from "lucide-react";
import { language } from "../content/site";
import { SectionHeading } from "../components/SectionHeading";
import { Code } from "../components/Code";
import { DataTable } from "../components/DataTable";

function ModelDiagram() {
  const layers = language.model.layers.map((layer, index) => {
    const count = Math.min(Number(layer.size), index === 1 ? 5 : 4);
    const gap = count > 1 ? 80 / (count - 1) : 0;

    return {
      ...layer,
      x: 32 + index * 128,
      nodes: Array.from(
        { length: count },
        (_, node) => 55 + (node - (count - 1) / 2) * gap,
      ),
    };
  });

  const connections = layers.slice(0, -1).flatMap((layer, layerIndex) => {
    const next = layers[layerIndex + 1];

    return layer.nodes.flatMap((y, nodeIndex) => {
      const nearest = Math.round(
        ((nodeIndex + 0.5) * next.nodes.length) / layer.nodes.length - 0.5,
      );
      const adjacent =
        nearest === next.nodes.length - 1 ? nearest - 1 : nearest + 1;

      return [nearest, adjacent].map((targetIndex) => ({
        x1: layer.x,
        y1: y,
        x2: next.x,
        y2: next.nodes[targetIndex],
      }));
    });
  });

  return (
    <div
      className="model-visual"
      role="img"
      aria-label="Model architecture: 4 input nodes connect to a 32-unit Linear and ReLU layer, then to 3 output nodes."
    >
      <svg viewBox="0 0 320 146" aria-hidden="true" focusable="false">
        <g className="model-connections">
          {connections.map((connection, index) => (
            <line key={index} {...connection} />
          ))}
        </g>
        {layers.map((layer, layerIndex) => (
          <g className="model-stage" key={layer.name}>
            {layer.nodes.map((y, nodeIndex) => (
              <circle
                className={
                  layerIndex === 1
                    ? "model-node model-node-hidden"
                    : "model-node"
                }
                key={nodeIndex}
                cx={layer.x}
                cy={y}
                r="4.25"
              />
            ))}
            <text
              className="model-stage-name"
              x={layer.x}
              y="123"
              textAnchor="middle"
            >
              {layer.name}
            </text>
            <text
              className="model-stage-size"
              x={layer.x}
              y="140"
              textAnchor="middle"
            >
              {layer.size}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function Language() {
  const maxRevenue = Math.max(
    ...language.chart.values.map((item) => item.value),
  );
  return (
    <section className="section" id="language">
      <SectionHeading {...language} />
      <div className="feature-grid reveal">
        <article className="feature feature-core">
          <div className="feature-icon">
            <Braces size={21} />
          </div>
          <h3>{language.core.title}</h3>
          <p>{language.core.description}</p>
          <Code value={language.core.code} />
          <ul className="language-features">
            {language.core.features.map((feature) => (
              <li key={feature}>
                <Check size={13} />
                {feature}
              </li>
            ))}
          </ul>
        </article>
        <article className="feature feature-data">
          <div className="feature-label">
            <Table2 size={18} />
            {language.dataframe.label}
          </div>
          <h3>{language.dataframe.title}</h3>
          <p>{language.dataframe.description}</p>
          <DataTable {...language.dataframe} />
        </article>
        <article className="feature feature-tensor">
          <div className="feature-label">
            <Box size={18} />
            {language.tensor.label}
          </div>
          <div
            className="tensor-visual"
            role="img"
            aria-label={`Matrix a with ${language.tensor.caption}, values ${language.tensor.matrix.flat().map((value) => value.toFixed(1)).join(", ")}; operation ${language.tensor.operation}.`}
          >
            <div className="tensor-matrix-card" aria-hidden="true">
              <div className="tensor-matrix-header">
                <span>a</span>
                <span>2D TENSOR</span>
              </div>
              <div className="tensor-matrix-grid">
                {language.tensor.matrix.flat().map((value, index) => (
                  <span
                    className={
                      index === 4 ? "tensor-cell tensor-cell-focus" : "tensor-cell"
                    }
                    key={index}
                  >
                    {value.toFixed(1)}
                  </span>
                ))}
              </div>
            </div>
            <ArrowRight className="tensor-flow-arrow" size={14} aria-hidden="true" />
            <div className="tensor-notation" aria-hidden="true">
              <span className="tensor-notation-label">MATMUL</span>
              <code>{language.tensor.operation}</code>
              <span className="tensor-output-label">OUTPUT</span>
              <span className="tensor-shape">{language.tensor.caption}</span>
            </div>
          </div>
          <h3>{language.tensor.title}</h3>
          <p>{language.tensor.description}</p>
        </article>
        <article className="feature feature-model">
          <div className="feature-label">
            <Network size={18} />
            {language.model.label}
          </div>
          <ModelDiagram />
          <h3>{language.model.title}</h3>
          <p>{language.model.description}</p>
        </article>
        <article className="feature feature-chart">
          <div className="feature-label">
            <ChartNoAxesColumn size={18} />
            {language.chart.label}
          </div>
          <div
            className="chart-visual"
            role="img"
            aria-label={`${language.chart.caption}: ${language.chart.values.map((item) => `${item.label} ${item.value}`).join(", ")}`}
          >
            <svg viewBox="0 0 320 146" aria-hidden="true" focusable="false">
              <g className="chart-grid">
                <line x1="25" y1="33" x2="295" y2="33" />
                <line x1="25" y1="72" x2="295" y2="72" />
                <line x1="25" y1="111" x2="295" y2="111" />
              </g>
              {language.chart.values.map((item, index) => {
                const x = 70 + index * 90;
                const height = Math.max(4, (item.value / maxRevenue) * 78);

                return (
                  <g
                    className={
                      item.value === maxRevenue
                        ? "chart-series chart-series-lead"
                        : "chart-series"
                    }
                    key={item.label}
                  >
                    <rect
                      x={x - 22}
                      y={111 - height}
                      width="44"
                      height={height}
                      rx="2"
                    />
                    <text
                      className="chart-value"
                      x={x}
                      y={Math.max(21, 104 - height)}
                      textAnchor="middle"
                    >
                      {item.value.toLocaleString("en-US")}
                    </text>
                    <text className="chart-axis" x={x} y="135" textAnchor="middle">
                      {item.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          <h3>{language.chart.title}</h3>
          <p>{language.chart.description}</p>
        </article>
      </div>
    </section>
  );
}
