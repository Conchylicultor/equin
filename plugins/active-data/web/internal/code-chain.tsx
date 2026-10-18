import { InlineCode } from "@plugins/primitives/plugins/markdown/web";
import { copiesAsText } from "@plugins/primitives/plugins/dom/plugins/copy-source-text/web";
import {
  fullMatch,
  useActiveDataCodeCandidates,
  type CodeCandidate,
} from "./use-code-candidates";

/**
 * The arbiter for `display:"code"` contributions: walks the syntactic candidates
 * in registry order, asks each for a claim, and renders the first one that claims
 * — or the plain `<code>` terminal if none does.
 *
 * It is a RECURSIVE COMPONENT rather than a loop so the chain is lazy *by
 * construction*: level i+1's element does not exist until level i has declined, so
 * a candidate's `useClaim` (and the I/O behind it) is never mounted for a token an
 * earlier candidate already owns.
 *
 * It reads the registry itself instead of taking candidates as a prop:
 * `markdown-renderer.tsx` memoizes the whole `<ReactMarkdownLib>` element, so
 * `inlineCode` runs about once per code span and the element it returns lives in a
 * frozen tree — a prop would freeze a boot-time snapshot of the registry into it.
 */
export function ActiveDataCodeChain({ text }: { text: string }) {
  const candidates = useActiveDataCodeCandidates();
  return <CodeChainLevel text={text} candidates={candidates} index={0} />;
}

function CodeChainLevel({
  text,
  candidates,
  index,
}: {
  text: string;
  candidates: readonly CodeCandidate[];
  index: number;
}) {
  let next = index;
  while (next < candidates.length && !fullMatch(candidates[next]!.test, text)) {
    next++;
  }
  // Nobody left who even syntactically matches — the host owns the fallback.
  if (next >= candidates.length) return <InlineCode>{text}</InlineCode>;
  const candidate = candidates[next]!;
  // Keyed on the candidate's id: the level below calls THAT candidate's
  // `useClaim`, so a different candidate at the same chain position must be a
  // different component instance (fresh hook state), never a re-render of the
  // previous one's.
  return (
    <CodeCandidateLevel
      key={candidate.id}
      text={text}
      candidates={candidates}
      candidate={candidate}
      index={next}
    />
  );
}

/**
 * One level of the chain: exactly one candidate, whose `useClaim` is called
 * unconditionally here (the branch that selects the candidate lives one component
 * up, so hook order is fixed per instance).
 */
function CodeCandidateLevel({
  text,
  candidates,
  candidate,
  index,
}: {
  text: string;
  candidates: readonly CodeCandidate[];
  candidate: CodeCandidate;
  index: number;
}) {
  const claim = candidate.resolver.useClaim(text);
  switch (claim.status) {
    case "pending":
      // The terminal, NOT the next level. A level below a still-loading candidate
      // would mount and fire its own I/O for an answer about to be discarded — and
      // then flicker when this one settles.
      return <InlineCode>{text}</InlineCode>;
    case "declined":
      return (
        <CodeChainLevel text={text} candidates={candidates} index={index + 1} />
      );
    case "claimed": {
      // UNSAFE: spliced into a foreign markdown ReactNode tree, so this cannot
      // route through the slot-render middleware chain (the documented
      // active-data exemption). `value` is the very value this candidate's own
      // `useClaim` just produced — see the SOUNDNESS note on `codeTag`.
      const Component = candidate.resolver.component;
      // A code chip is reachable ONLY from inside a backtick-wrapped span (the
      // syntactic gate above it), so the characters this chip replaced were
      // `text` WITH its backticks. Declaring them is what lets the copy carry
      // the markdown back rather than a bare word that no longer renders as a
      // chip when pasted — see `primitives/dom/copy-source-text`.
      return (
        <span className="contents" {...copiesAsText(`\`${text}\``)}>
          <Component content={text} value={claim.value} />
        </span>
      );
    }
  }
}
