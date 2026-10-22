import { useMemo } from "react";
import type { CreateOption } from "@plugins/primitives/plugins/data-view/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { Library } from "../slots";

/**
 * Every source's create affordance as a data-view {@link CreateOption}, its
 * `onSelect` bound to this surface's fetcher. Source-agnostic: a source without
 * a `createOption` is skipped, and nothing here names one. Shared by the
 * library's "+" menu and the first-run onboarding cards.
 */
export function useSourceCreators(): CreateOption[] {
  const sources = Library.Source.useContributions();
  const fetchEndpoint = useFetchEndpoint();
  return useMemo(
    () =>
      sources.flatMap((s) => {
        const option = s.createOption;
        if (!option) return [];
        return [
          { ...option, onSelect: () => option.onSelect({ fetchEndpoint }) },
        ];
      }),
    [sources, fetchEndpoint],
  );
}
