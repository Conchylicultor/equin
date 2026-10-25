import { useContext, useMemo, type ReactNode } from "react";
import { InlineTextWalkerSlot } from "./slot";
import { InlineTextWalkerContext } from "./walker-context";

// Reads the stacked walker transforms and reduces them over the raw-string
// seed. Because the seed is a string (never a custom-component root), every
// registered walker sees raw text and composes safely in registry order — the
// wrong-order silent no-op that hand-composition allowed is unrepresentable.
function InlineTextSeed({ text }: { text: string }) {
  const { transforms } = useContext(InlineTextWalkerContext);
  return <>{transforms.reduce<ReactNode>((acc, fn) => fn(acc), text)}</>;
}

// Renders a raw string with every registered inline-text walker (active-data
// chips, file-links) applied by `stage`. This is the ONLY sanctioned way to
// compose the inline walkers on a non-markdown surface: consumers never name or
// order a walker, and adding a new inline widget type flows here automatically.
// Mirrors the <Markdown> enhancer pipeline, seeded with the string itself.
export function InlineText({
  text,
  className,
}: {
  text: string;
  className?: string;
}): ReactNode {
  const walkers = InlineTextWalkerSlot.useContributions();
  const sorted = useMemo(
    () => [...walkers].sort((a, b) => a.stage - b.stage),
    [walkers],
  );

  // Nest the walker Components outermost-first (lowest stage = outermost), so
  // each contribution's hooks run once at a stable position (rules-of-hooks
  // safe) and its transform stacks before inner ones, exactly like <Markdown>.
  let content: ReactNode = <InlineTextSeed text={text} />;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const { Component } = sorted[i]!;
    content = <Component>{content}</Component>;
  }

  return className ? <span className={className}>{content}</span> : <>{content}</>;
}
