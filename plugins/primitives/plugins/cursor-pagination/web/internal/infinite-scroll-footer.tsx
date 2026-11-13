import type { ReactElement } from "react";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ScrollSentinel } from "./scroll-sentinel";
import type { InfiniteScrollHandle } from "./use-infinite-scroll";

export interface InfiniteScrollFooterProps {
  handle: InfiniteScrollHandle;
  loadingLabel?: string;
  errorLabel?: string;
  /**
   * The list stops here and cannot page further (a bounded scroll at its
   * cap): `shown` rows, and what the user can do about it (`hint`, a
   * user-facing clause — "narrow the filter to see the rest"). Said at the end
   * of the rows, so a list that stopped is never read as a list that ended.
   */
  truncated?: false | { shown: number; hint: string };
}

/**
 * The single reusable infinite-scroll footer: a "loading more" spinner while a
 * page is fetching, a "couldn't load more" placeholder + Retry when the last
 * next-page fetch errored, and the observer sentinel (hidden while errored, so
 * it never re-arms behind the Retry button), and — for a list that cannot page
 * past its end — the line saying so. Pair with `useInfiniteScroll`.
 */
export function InfiniteScrollFooter({
  handle,
  loadingLabel = "Loading…",
  errorLabel = "Couldn't load more.",
  truncated = false,
}: InfiniteScrollFooterProps): ReactElement {
  const {
    isFetchingNextPage,
    isFetchNextPageError,
    hasNextPage,
    sentinelRef,
    retry,
  } = handle;
  return (
    <>
      {isFetchingNextPage && (
        <Center axis="horizontal">
          <Loading variant="spinner" label={loadingLabel} />
        </Center>
      )}
      {isFetchNextPageError && (
        <Center axis="horizontal">
          <Inset pad="sm">
            <Stack gap="xs" align="center">
              <Placeholder tone="error">{errorLabel}</Placeholder>
              <ControlSizeProvider size="sm">
                <Button variant="ghost" onClick={() => retry()}>
                  Retry
                </Button>
              </ControlSizeProvider>
            </Stack>
          </Inset>
        </Center>
      )}
      {truncated !== false && (
        <Center axis="horizontal">
          <Inset pad="sm">
            <Placeholder>
              {`Showing the first ${truncated.shown} — ${truncated.hint}.`}
            </Placeholder>
          </Inset>
        </Center>
      )}
      <ScrollSentinel
        sentinelRef={sentinelRef}
        show={hasNextPage && !isFetchNextPageError}
      />
    </>
  );
}
