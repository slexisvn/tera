export const CHART_METHOD_DOCS = new Map([
  ['line', doc(
    'chart.line(data, x?, y?, color?, title?, x_label?, y_label?, hline?, vline?, dash?, animate=false, frame?, key?, easing="cubic", loop=false, speed=1, autoplay=false, zoom=true)',
    'Draw a line chart for ordered values or trends. Use y=[...] for multiple series and color= to group DataFrame rows. Add a dashed reference line with hline=3.5 (horizontal) or vline=100 (vertical) — pass a number or list, and label/color them with hline_label="μ = 3.5", hline_color="#e06c75". Use dash=true to dash every series. Pass animate=true to reveal the line left→right with Play/Pause, a scrubber, loop, and speed controls (honours reduced-motion). Pass frame="step" to morph the curve between keyframes (one per distinct frame value), tweening vertices over time with a frame scrubber. Pace the motion with easing="linear"|"ease"|"ease-in-out"|"cubic", repeat with loop=true, run faster/slower with speed=0.5|1|2|4, and auto-start with autoplay=true (otherwise the chart rests on its final frame as a static poster until you press Play, so exports and screenshots stay complete).'
  )],
  ['bar', doc(
    'chart.bar(data, x?, y?, color?, mode="grouped", title?)',
    'Compare values across categories. Use mode="stacked" to stack multiple series; aggregate DataFrame rows before charting.'
  )],
  ['scatter', doc(
    'chart.scatter(data, x?, y?, size?, color?, title?, animate=false, frame?, key?, duration?, easing="cubic", loop=true, speed=1, autoplay=false, zoom=true)',
    'Plot numeric X/Y observations to inspect relationships, clusters, and outliers. Use color= to split DataFrame groups. Pass animate=true to reveal points left→right with transport controls. Pass frame="year" with key="country" to morph the marks between keyframes (Gapminder-style): each distinct frame value becomes a keyframe, marks matched by key smoothly interpolate their x/y (and size/color), and marks that enter or leave fade in/out. The transport label shows the current frame value and the scrubber seeks by frame; reduced-motion snaps between frames without tweening. Tune the motion with easing="linear"|"ease"|"ease-in-out"|"cubic", loop=true/false, and speed=0.5|1|2|4; until you press Play (or set autoplay=true) the chart holds its last frame as a static poster so exports stay complete.'
  )],
  ['histogram', doc(
    'chart.histogram(data, x?, color?, bins=20, title?, zoom=true)',
    'Show the frequency distribution of numeric values. Bins are computed automatically and can be grouped with color=.'
  )],
  ['area', doc(
    'chart.area(data, x?, y?, color?, mode="overlay", title?, animate=false, easing="cubic", loop=false, speed=1, autoplay=false, zoom=true)',
    'Show trends with the area below each series filled. Use mode="stacked" when aligned series should accumulate. Pass animate=true to reveal the area left→right with transport controls; pace it with easing="linear"|"ease"|"ease-in-out"|"cubic", loop=true, and speed=0.5|1|2|4. The chart rests on its filled final frame until you press Play (or set autoplay=true).'
  )],
  ['box', doc(
    'chart.box(data, x?, color?, whisker=1.5, title?)',
    'Summarize a numeric distribution with Tukey quartiles, median, whiskers, and outliers. Use color= for grouped boxes.'
  )],
  ['violin', doc(
    'chart.violin(data, x?, color?, bandwidth?, whisker=1.5, title?)',
    'Show a mirrored kernel-density distribution together with median and quartile markers. Use color= to compare groups.'
  )],
  ['density', doc(
    'chart.density(data, x?, color?, bandwidth?, title?, zoom=true)',
    'Estimate and draw a smooth numeric probability density using a Gaussian kernel. Bandwidth defaults to Silverman.'
  )],
  ['correlation', doc(
    'chart.correlation(data, columns?, method="pearson", title?)',
    'Draw a correlation matrix for numeric DataFrame columns. Supports method="pearson" and method="spearman".'
  )],
  ['hexbin', doc(
    'chart.hexbin(data, x?, y?, bins=30, title?, zoom=true)',
    'Aggregate dense numeric X/Y observations into hexagonal bins whose intensity represents the number of points.'
  )],
  ['heatmap', doc(
    'chart.heatmap(data, x?, y?, value?, title?)',
    'Draw a numeric matrix heatmap. For DataFrame input, provide x, y, and value columns; 2D arrays are supported directly.'
  )],
  ['regression', doc(
    'chart.regression(data, x?, y?, title?, zoom=true)',
    'Plot numeric X/Y observations with a least-squares linear fit and R² tooltip.'
  )],
  ['ecdf', doc(
    'chart.ecdf(data, x?, color?, title?, zoom=true)',
    'Draw an empirical cumulative distribution function for comparing numeric distributions without binning.'
  )],
  ['bubble', doc(
    'chart.bubble(data, x?, y?, size?, color?, title?, frame?, key?, duration?, easing="cubic", loop=true, speed=1, autoplay=false, zoom=true)',
    'Plot X/Y observations with marker area scaled by a third numeric variable. Useful for spend, revenue, or segment size. Pass frame="year" with key="country" to morph the bubbles between keyframes: marks matched by key interpolate their x/y/size/color over time, entering/leaving marks fade, and the transport scrubber seeks by frame value (reduced-motion snaps without tweening). Pace it with easing="linear"|"ease"|"ease-in-out"|"cubic", loop=true/false, and speed=0.5|1|2|4; the chart holds its last frame as a static poster until you press Play (or set autoplay=true).'
  )],
  ['funnel', doc(
    'chart.funnel(data, step?, value?, title?)',
    'Show a conversion funnel across ordered stages, including overall and step-to-step retention.'
  )],
  ['waterfall', doc(
    'chart.waterfall(data, step?, value?, title?)',
    'Show how positive and negative contributions accumulate from a starting point to a final total.'
  )],
  ['figure', doc(
    'chart.figure(data, title?).encode(x?, color?).bar(y?).line(y?, axis?).facet(col?)',
    'Compose multiple marks on one coordinate system. Chain .line/.bar/.scatter/.point/.area/.histogram/.regression/.bubble; pass axis="right" for a secondary y-axis, or .facet("column") to split into small-multiple panels.'
  )],
]);

export function chartMethodOwner(pre, span) {
  let text = '';
  for (const node of pre.childNodes) {
    if (node === span) break;
    text += node.textContent ?? '';
  }
  const match = text.match(/([A-Za-z_]\w*)\.\s*$/);
  return match?.[1] ?? null;
}

function doc(display, description) {
  return { display, kind: 'method of chart', description };
}
