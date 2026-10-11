import { useMemo, type ReactNode } from "react";
import {
  InlineTextWalkerContext,
  useInlineTextWalker,
  type InlineTextWalker,
} from "@plugins/primitives/plugins/inline-text/web";
import { maskCode } from "@plugins/active-data/web";
import { GoEcho } from "../components/go-echo";

const GO_REGION_RE = /<go>([\s\S]*?)<\/go>/g;

function splitGoRegions(children: ReactNode): ReactNode {
  // Registered before every other walker, so it is handed the raw string seed;
  // anything else is already another walker's output and is left alone.
  if (typeof children !== "string" || !children.includes("<go>"))
    return children;
  const out: ReactNode[] = [];
  let last = 0;
  // Paired on the text with its code blanked out, so a `<go>` written as
  // code is not a tag; the body is read back from the real text.
  for (const m of maskCode(children).matchAll(GO_REGION_RE)) {
    if (m.index > last) out.push(children.slice(last, m.index));
    const bodyStart = m.index + "<go>".length;
    out.push(
      <GoEcho
        key={m.index}
        body={children.slice(bodyStart, bodyStart + m[1]!.length)}
      />,
    );
    last = m.index + m[0].length;
  }
  if (last === 0) return children;
  if (last < children.length) out.push(children.slice(last));
  return out;
}

/**
 * Renders `<go>…</go>` regions on the plain-text surfaces — the user's sent
 * messages above all, where a region is a suggestion they accepted with Go.
 */
export function GoInlineTextWalker({ children }: { children: ReactNode }) {
  const walker = useMemo<InlineTextWalker>(
    () => ({ transform: splitGoRegions }),
    [],
  );
  const value = useInlineTextWalker(walker);
  return (
    <InlineTextWalkerContext.Provider value={value}>
      {children}
    </InlineTextWalkerContext.Provider>
  );
}
