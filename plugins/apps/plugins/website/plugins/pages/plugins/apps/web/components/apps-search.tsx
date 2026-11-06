import { useCallback, useMemo, useRef } from "react";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import "./apps-gallery.css";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/**
 * The gallery's search: one field under the heading, focused by `/`. It filters
 * by an app's name and what it does.
 */
export function AppsSearch({
  query,
  onQueryChange,
}: {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(
    () => focusElement(inputRef.current, { reveal: true }),
    [],
  );
  // Surface-scoped, and a plain key, so it yields to any focused text field
  // (the `/` is typed there).
  const shortcuts = useMemo(
    () => [
      {
        id: "website.apps.focus-search",
        keys: "/",
        label: "Search apps",
        handler: focusSearch,
      },
    ],
    [focusSearch],
  );
  useSurfaceShortcuts(shortcuts);

  return (
    // Its frame — size, corner, hairline, translucent fill, shadow and the
    // focus glow — is the gallery's paint, in `apps-gallery.css`.
    <Surface level="raised" className="website-apps-search text-left">
      <SearchInput
        ref={inputRef}
        appearance="bare"
        wrapperClassName={cn("website-apps-search-line")}
        placeholder="Search apps"
        aria-label="Search apps"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
    </Surface>
  );
}
