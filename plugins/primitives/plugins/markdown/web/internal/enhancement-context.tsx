import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { Components, Options } from "react-markdown";

/** Remark plugins an enhancer adds to the parse — see {@link MarkdownEnhancement.remarkPlugins}. */
export type RemarkPlugins = NonNullable<Options["remarkPlugins"]>;

export interface MarkdownEnhancement {
  transform?: (children: ReactNode) => ReactNode;
  components?: Partial<Components>;
  inlineCode?: (text: string) => ReactNode | null;
  /**
   * Extra remark plugins, run after the base ones (gfm). For an enhancer that
   * must reshape the markdown AST itself — e.g. pair an inline `<tag>`/`</tag>`
   * into one element a `components` entry renders — which a `transform` over
   * the rendered tree cannot do. Keep the array's identity stable: it is part
   * of the renderer's memo key.
   */
  remarkPlugins?: RemarkPlugins;
}

export interface StackedEnhancement {
  transforms: Array<(children: ReactNode) => ReactNode>;
  components: Partial<Components>;
  inlineCodeHandlers: Array<(text: string) => ReactNode | null>;
  remarkPlugins: RemarkPlugins;
}

const ctx = createContext<StackedEnhancement>({
  transforms: [],
  components: {},
  inlineCodeHandlers: [],
  remarkPlugins: [],
});

export const MarkdownEnhancementContext = ctx;

export function useMarkdownEnhancement(
  addition: MarkdownEnhancement | null,
): StackedEnhancement {
  const parent = useContext(ctx);
  return useMemo(() => {
    if (!addition) return parent;
    return {
      transforms: addition.transform
        ? [...parent.transforms, addition.transform]
        : parent.transforms,
      components: addition.components
        ? { ...parent.components, ...addition.components }
        : parent.components,
      inlineCodeHandlers: addition.inlineCode
        ? [...parent.inlineCodeHandlers, addition.inlineCode]
        : parent.inlineCodeHandlers,
      remarkPlugins: addition.remarkPlugins
        ? [...parent.remarkPlugins, ...addition.remarkPlugins]
        : parent.remarkPlugins,
    };
  }, [parent, addition]);
}

/**
 * The enhancers' transforms as one function, for a custom markdown element
 * that renders words of the markdown as its children (an inline tag the remark
 * pass made): the walkers leave a custom component opaque, so the element runs
 * them on its own children — as the base `p` / `li` / `td` do.
 */
export function useMarkdownTransform(): (children: ReactNode) => ReactNode {
  const { transforms } = useContext(ctx);
  return useCallback(
    (children: ReactNode) => transforms.reduce((acc, fn) => fn(acc), children),
    [transforms],
  );
}
