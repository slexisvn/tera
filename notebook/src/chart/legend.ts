type LegendItem = {
  name: string;
  color?: string;
  dash?: boolean;
};

export function renderLegend(host: HTMLElement, series: LegendItem[], hidden: Set<number>, onChange: () => void, extras: LegendItem[] = []): void {
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  series.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = hidden.has(index) ? 'chart-legend-item hidden' : 'chart-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'chart-legend-swatch';
    swatch.style.background = item.color ?? '';
    const label = document.createElement('span');
    label.textContent = item.name;
    button.append(swatch, label);
    button.addEventListener('click', () => {
      if (hidden.has(index)) hidden.delete(index);
      else hidden.add(index);
      onChange();
    });
    legend.append(button);
  });
  for (const extra of extras) {
    const chip = document.createElement('span');
    chip.className = 'chart-legend-item chart-legend-static';
    const swatch = document.createElement('span');
    swatch.className = extra.dash ? 'chart-legend-swatch chart-legend-swatch-dash' : 'chart-legend-swatch';
    if (extra.dash) swatch.style.borderTopColor = extra.color ?? '';
    else swatch.style.background = extra.color ?? '';
    const label = document.createElement('span');
    label.textContent = extra.name;
    chip.append(swatch, label);
    legend.append(chip);
  }
  host.append(legend);
}
