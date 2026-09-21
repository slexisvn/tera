import { Braces, Table2, Box, Network, ChartNoAxesColumn, Check } from 'lucide-react';
import { language } from '../content/site';
import { SectionHeading } from '../components/SectionHeading';
import { Code } from '../components/Code';
import { DataTable } from '../components/DataTable';

export function Language() {
  const maxRevenue = Math.max(...language.chart.values.map(item => item.value));
  return <section className="section" id="language">
    <SectionHeading {...language} />
    <div className="feature-grid reveal">
      <article className="feature feature-core"><div className="feature-icon"><Braces size={21} /></div><h3>{language.core.title}</h3><p>{language.core.description}</p><Code value={language.core.code} /><ul className="language-features">{language.core.features.map(feature => <li key={feature}><Check size={13} />{feature}</li>)}</ul></article>
      <article className="feature feature-data"><div className="feature-label"><Table2 size={18} />{language.dataframe.label}</div><h3>{language.dataframe.title}</h3><p>{language.dataframe.description}</p><DataTable {...language.dataframe} /></article>
      <article className="feature feature-tensor"><div className="feature-label"><Box size={18} />{language.tensor.label}</div><div className="tensor-visual" aria-label={language.tensor.caption}><div className="matrix">{language.tensor.matrix.flat().map((value, index) => <span key={index}>{value.toFixed(1)}</span>)}</div><div className="tensor-notation"><code>{language.tensor.operation}</code><span>{language.tensor.caption}</span></div></div><h3>{language.tensor.title}</h3><p>{language.tensor.description}</p></article>
      <article className="feature feature-model"><div className="feature-label"><Network size={18} />{language.model.label}</div><div className="model-visual">{language.model.layers.map(layer => <div className="model-layer" key={layer.name}><span>{layer.name}</span><div className="layer-nodes" aria-hidden="true">{Array.from({ length: Math.min(Number(layer.size), 5) }, (_, index) => <i key={index} />)}</div><code>{layer.size}</code></div>)}</div><h3>{language.model.title}</h3><p>{language.model.description}</p></article>
      <article className="feature feature-chart"><div className="feature-label"><ChartNoAxesColumn size={18} />{language.chart.label}</div><div className="chart-visual" role="img" aria-label={`${language.chart.caption}: ${language.chart.values.map(item => `${item.label} ${item.value}`).join(', ')}`}>
        {language.chart.values.map(item => <div className="chart-column" key={item.label}><span className="chart-bar" style={{ height: `${item.value / maxRevenue * 100}%` }}><span>{item.value.toLocaleString('en-US')}</span></span><span className="chart-axis">{item.label}</span></div>)}
      </div><h3>{language.chart.title}</h3><p>{language.chart.description}</p></article>
    </div>
  </section>;
}
