import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SingleLineProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Favicon } from "@plugins/apps/plugins/browser/plugins/shell/web";

/** Parse a URL's hostname; falls back to the raw string for unparseable input. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (err) {
    if (err instanceof TypeError) return url; // invalid URL — expected
    throw err;
  }
}

interface LinkTileProps {
  url: string;
  /** Display label; defaults to the URL's hostname. */
  label?: string;
  onClick: () => void;
}

/**
 * A pin of the start page: the site's favicon on a rounded tile, its name under
 * it — the whole cell is the button, lit on hover.
 */
export function LinkTile({ url, label, onClick }: LinkTileProps) {
  const text = label ?? hostOf(url);
  return (
    <Stack
      as="button"
      gap="xs"
      align="center"
      onClick={onClick}
      title={text}
      className="browser-pin w-full"
    >
      <Center className="browser-pin-tile">
        <Favicon url={url} size={22} />
      </Center>
      <SingleLineProvider value={true}>
        <Text variant="caption" className="w-full text-center">
          {text}
        </Text>
      </SingleLineProvider>
    </Stack>
  );
}
