import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";

export type CodeHandler = {
  block?: (text: string, lang: string | null) => ReactNode | null;
  inline?: (text: string) => ReactNode | null;
};

export type MarkdownExtension = {
  id: string;
  useComponents?: Hook<() => Partial<Components>>;
  useTransform?: Hook<() => ((children: ReactNode) => ReactNode) | null>;
  useCodeHandler?: Hook<() => CodeHandler | null>;
};
