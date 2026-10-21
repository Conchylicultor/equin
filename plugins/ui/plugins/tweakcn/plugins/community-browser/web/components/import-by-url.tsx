import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import {
  EndpointError,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { useSetConfig } from "@plugins/config_v2/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { themeSelectionConfig } from "@plugins/ui/plugins/theme-engine/core";
import { useThemeScopeId } from "@plugins/ui/plugins/theme-engine/web";
import { awaitSavedThemesWrite } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/web";
import { importTweakcnTheme } from "@plugins/ui/plugins/tweakcn/core";

/** Extract a bare theme ID from a tweakcn URL or raw ID string. */
function parseThemeId(input: string): string {
  const trimmed = input.trim();
  // Match URLs like https://tweakcn.com/r/themes/<id>.json or .../themes/<id>
  const urlMatch = trimmed.match(
    /tweakcn\.com\/r\/themes\/([^/.]+)(?:\.json)?/,
  );
  if (urlMatch) return urlMatch[1]!;
  // Strip trailing .json if present
  return trimmed.replace(/\.json$/, "");
}

const SECTION_TERMS = ["import by url", "import", "tweakcn", "url"];

/**
 * Declared as the contribution's `useAvailable` rather than a `return null` in
 * the body: the host paints the card before it reaches the body, so a null
 * there would leave an "Import from tweakcn" bar over nothing on every
 * non-matching query.
 */
export function useImportByUrlMatchesSearch({
  search,
}: {
  search: string;
}): boolean {
  const q = search.trim().toLowerCase();
  return q.length === 0 || SECTION_TERMS.some((term) => term.includes(q));
}

/**
 * Import any tweakcn theme by id or URL — including ones the bundled community
 * catalog does not have (brand-new, unlisted, private), pulled live. The
 * imported theme is saved like a catalog pick and selected for the scope the
 * customizer is editing, so it shows at once.
 */
export function ImportByUrlSection() {
  const scopeId = useThemeScopeId();
  const selectTheme = useSetConfig(themeSelectionConfig, { scopeId });
  const [input, setInput] = useState("");

  const importMutation = useEndpointMutation(importTweakcnTheme);

  const handleImport = async () => {
    const themeId = parseThemeId(input);
    if (!themeId) return;
    let write;
    try {
      write = await importMutation.mutateAsync({ body: { themeId } });
    } catch (err) {
      // Shown inline below (and by the global error toast).
      if (err instanceof EndpointError) return;
      throw err;
    }
    // The theme list must have the import before the scope selects it, or the
    // painter would paint a missing theme for a frame.
    await awaitSavedThemesWrite(write.watermark);
    selectTheme("theme", write.theme.id);
    setInput("");
  };

  return (
    <Stack gap="md">
      <Stack direction="row" gap="sm">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleImport();
          }}
          placeholder="Theme ID or tweakcn URL..."
          // A raw <input> must itself be the flex cell, so it takes the class
          // string rather than a <Fill> wrapper.
          className={cn(
            fillClasses("x"),
            "rounded-md border border-border bg-muted/20 px-md py-xs text-body text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none",
          )}
        />
        <Button
          variant="ghost"
          onClick={handleImport}
          loading={importMutation.isPending}
          disabled={!input.trim()}
          className="border border-border"
        >
          Import
        </Button>
      </Stack>

      {importMutation.isError ? (
        <Text as="p" variant="body" tone="destructive">
          {importMutation.error.message}
        </Text>
      ) : (
        <Text as="p" variant="body" tone="muted">
          Paste a tweakcn theme ID or URL to import any theme — including ones
          not in the community catalog.
        </Text>
      )}
    </Stack>
  );
}
