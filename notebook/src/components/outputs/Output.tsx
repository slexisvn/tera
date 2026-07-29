import type { MutableRefObject } from "react";
import { KernelClient } from "../../services/kernel-client";
import type { CellOutput } from "../../types/notebook";
import { ChartOutput } from "./ChartOutput";
import { DataFrameOutput } from "./DataFrameOutput";
import { TensorOutput } from "./TensorOutput";

type OutputProps = {
  output?: CellOutput;
  kernel: MutableRefObject<KernelClient | null>;
};

export function Output({ output, kernel }: OutputProps) {
  if (!output) return <div className="output" />;
  return (
    <div className="output">
      {output.prints.map((line, index) => <div className="print" key={index}>{line}</div>)}
      {!output.ok && <div className="error">{output.error}</div>}
      {output.ok && output.value?.kind === "text" && output.value.text && <div className="result">{output.value.text}</div>}
      {output.ok && output.value?.kind === "tensor" && <TensorOutput tensor={output.value} />}
      {output.ok && output.value?.kind === "chart" && <ChartOutput spec={output.value.spec} />}
      {output.ok && output.value?.kind === "dataframe" && <DataFrameOutput dataframe={output.value} kernel={kernel} />}
    </div>
  );
}
