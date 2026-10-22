import type { ComponentType, ReactNode } from "react";
import type { Components } from "react-markdown";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
import { langFromClassName, nodeToText } from "./helpers";
import { InlineCode } from "./inline-code";
import { FencedCode } from "./fenced-code";

// react-markdown hands every component override a fresh `node` (the hast AST
// node) on every render. Any override that spreads its props onto an intrinsic
// element therefore leaks it as an invalid `node="[object Object]"` DOM
// attribute, and — because the object identity changes each render — React
// rewrites that attribute on every markdown element on every render (~300
// writes/s in a re-rendering transcript). Strip it once, centrally, over the
// merged component map so no override (base or enhancer-contributed, present or
// future) can ever leak it. None of our overrides read `node`.
export function stripNodeProp(components: Components): Components {
  const src = components as Record<
    string,
    ComponentType<Record<string, unknown>>
  >;
  const out: Record<string, ComponentType<Record<string, unknown>>> = {};
  for (const tag of Object.keys(src)) {
    const Original = src[tag]!;
    out[tag] = ({ node: _node, ...rest }: Record<string, unknown>) => (
      <Original {...rest} />
    );
  }
  return out as Components;
}

/**
 * Whether `url` addresses the page's own server's `/api` — a relative
 * `/api/…` path, or an absolute URL on this page's origin. Persisted markdown
 * holds such addresses (an attachment's `![](/api/attachments/<id>)`).
 */
function isPageApiUrl(url: string): boolean {
  if (url.startsWith("/api/")) return true;
  if (!/^https?:\/\//.test(url) || typeof window === "undefined") return false;
  const parsed = new URL(url);
  return (
    parsed.origin === window.location.origin &&
    parsed.pathname.startsWith("/api/")
  );
}

/**
 * The base image: an element loads its `src` by URL, which only the page's own
 * server answers (`servesUrls`). Under any other transport (an in-browser
 * server — the demo) an `/api` address would load from the page's REAL
 * server, so it renders as its alt text instead; an enhancer that can resolve
 * the address over the transport (the conversation markdown's
 * `img-enhancer`, turning an attachment into an `AssetPath`) overrides this.
 */
function BaseImg({
  src,
  alt,
  ...p
}: {
  src?: string | Blob;
  alt?: string;
} & Record<string, unknown>) {
  const { servesUrls } = useTransport();
  if (typeof src === "string" && !servesUrls && isPageApiUrl(src)) {
    return (
      <Text as="span" variant="caption" tone="muted">
        {alt || "Image"}
      </Text>
    );
  }
  return (
    <img src={typeof src === "string" ? src : undefined} alt={alt} {...p} />
  );
}

/** The base link: as {@link BaseImg}, an `/api` address only the page serves by URL. */
function BaseLink({ href, ...p }: { href?: string } & Record<string, unknown>) {
  const { servesUrls } = useTransport();
  const pageApi = href !== undefined && !servesUrls && isPageApiUrl(href);
  return (
    <a
      className="text-primary-text underline"
      href={pageApi ? undefined : href}
      target={href?.startsWith("http") && !pageApi ? "_blank" : undefined}
      rel={
        href?.startsWith("http") && !pageApi ? "noopener noreferrer" : undefined
      }
      {...p}
    />
  );
}

// `transform` and `getInlineCodeHandlers` are stable accessors that read the
// latest context value at call time. The base map is built ONCE (permanent tag
// identities) so react-markdown never remounts a base tag — live data flows
// through these accessors without changing any component identity.
export function buildBaseComponents(
  transform: (children: ReactNode) => ReactNode,
  getInlineCodeHandlers: () => Array<(text: string) => ReactNode | null>,
): Components {
  return {
    h1: ({ children, ...p }) => (
      // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm; siblings rendered independently by react-markdown
      <Text as="h1" variant="title" className="mt-4 mb-2" {...p}>
        {transform(children)}
      </Text>
    ),
    h2: ({ children, ...p }) => (
      // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm; siblings rendered independently by react-markdown
      <Text as="h2" variant="title" className="mt-4 mb-2" {...p}>
        {transform(children)}
      </Text>
    ),
    h3: ({ children, ...p }) => (
      // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm; siblings rendered independently by react-markdown
      <Text as="h3" variant="heading" className="mt-3 mb-1.5" {...p}>
        {transform(children)}
      </Text>
    ),
    h4: ({ children, ...p }) => (
      // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm; siblings rendered independently by react-markdown
      <Text as="h4" variant="subheading" className="mt-3 mb-1" {...p}>
        {transform(children)}
      </Text>
    ),
    p: ({ children, ...p }) => (
      // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm; siblings rendered independently by react-markdown
      <p className="my-2" {...p}>
        {transform(children)}
      </p>
    ),
    a: (p) => <BaseLink {...p} />,
    img: (p) => <BaseImg {...p} />,
    // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm (my-2); list indent kept as pl-xl
    ul: (p) => <ul className="my-2 list-disc pl-xl" {...p} />,
    // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm (my-2); list indent kept as pl-xl
    ol: (p) => <ol className="my-2 list-decimal pl-xl" {...p} />,
    li: ({ children, ...p }) => (
      // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown list-item rhythm; siblings rendered independently by react-markdown
      <li className="my-0.5" {...p}>
        {transform(children)}
      </li>
    ),
    blockquote: ({ children, ...p }) => (
      <blockquote
        // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm (my-2); blockquote indent kept as pl-md
        className="my-2 border-l-2 border-muted-foreground/30 pl-md text-muted-foreground"
        {...p}
      >
        {transform(children)}
      </blockquote>
    ),
    // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm; siblings rendered independently by react-markdown
    hr: (p) => <hr className="my-4 border-border" {...p} />,
    code: ({ className, children, ...rest }) => {
      const lang = langFromClassName(className);
      const text = nodeToText(children).replace(/\n$/, "");
      const isBlock = lang !== null || text.includes("\n");
      if (isBlock) {
        return <FencedCode code={text} lang={lang} />;
      }
      for (const handler of getInlineCodeHandlers()) {
        const result = handler(text);
        if (result !== null) return <>{result}</>;
      }
      return <InlineCode {...rest}>{children}</InlineCode>;
    },
    pre: ({ children }) => <>{children}</>,
    // eslint-disable-next-line spacing/no-adhoc-spacing -- markdown block rhythm; siblings rendered independently by react-markdown
    table: (p) => <table className="my-2 w-full border-collapse" {...p} />,
    th: ({ children, ...p }) => (
      <th
        className="border border-border bg-muted px-sm py-xs text-left"
        {...p}
      >
        {transform(children)}
      </th>
    ),
    td: ({ children, ...p }) => (
      <td className="border border-border px-sm py-xs" {...p}>
        {transform(children)}
      </td>
    ),
  };
}
