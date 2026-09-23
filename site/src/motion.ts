import { useEffect, type CSSProperties } from "react";

export const stagger = (index: number): CSSProperties =>
  ({ "--i": index }) as CSSProperties;

export function useScrollReveal(
  threshold = 0.1,
  rootMargin = "0px 0px -40px 0px",
) {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".reveal");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      els.forEach((el) => el.classList.add("is-visible"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        });
      },
      { threshold, rootMargin },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [threshold, rootMargin]);
}
