import { ArrowUpRight } from "lucide-react";
import type { ComponentProps } from "react";

type LinkProps = ComponentProps<"a"> & { arrow?: boolean };

export function Link({ href, children, arrow = false, ...props }: LinkProps) {
  const external = href?.startsWith("https://");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      {...props}
    >
      {children}
      {arrow && <ArrowUpRight size={16} aria-hidden="true" />}
    </a>
  );
}
