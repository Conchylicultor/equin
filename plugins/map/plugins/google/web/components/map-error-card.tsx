import { useBrowserValue } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

const readOrigin = (): string => window.location.origin;

export type MapErrorReason =
  { kind: "refused" } | { kind: "load"; detail: string };

/**
 * What the map shows instead of Google's silent grey tiles. A refused key and a
 * script that did not load are different fixes, so they say different things.
 */
export function MapErrorCard({ reason }: { reason: MapErrorReason }) {
  const origin = useBrowserValue({ name: "location.origin", read: readOrigin });
  return (
    <Center className="size-full">
      <Stack gap="xs" className="max-w-md px-md" role="alert">
        {reason.kind === "refused" ? (
          <>
            <Text variant="label" tone="destructive">
              Google Maps refused this browser key
            </Text>
            <Text variant="caption" tone="muted">
              Usually one of these, in the Google Cloud console:
            </Text>
            <Text variant="caption" tone="muted">
              • the key's HTTP referrers do not include this page ({origin}) —
              add <code>http://*.localhost:9000/*</code>;
            </Text>
            <Text variant="caption" tone="muted">
              • the Maps JavaScript API is not enabled for the key's project, or
              the key is restricted to other APIs;
            </Text>
            <Text variant="caption" tone="muted">
              • the key was deleted, or billing is off for the project.
            </Text>
            <Text variant="caption" tone="muted">
              Reload the page after fixing it: Google checks a key once per
              page.
            </Text>
          </>
        ) : (
          <>
            <Text variant="label" tone="destructive">
              The Google Maps script did not load
            </Text>
            <Text variant="caption" tone="muted">
              {reason.detail}
            </Text>
          </>
        )}
      </Stack>
    </Center>
  );
}
