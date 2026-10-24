import { createContext, useContext, type ReactNode } from "react";
import type { IconFamilyId } from "../../core";

// The theme scope token (`app:<id>`, `fixed:<id>`, `sub:<id>`) of the nearest
// theme boundary, or undefined outside every boundary — where `:root`'s theme
// applies. React context, so it crosses portals the way the theme does.
const IconScopeContext = createContext<string | undefined>(undefined);

/**
 * Tells the icons below which theme scope they are drawn in. The `<Theme>`
 * boundary renders it with its own scope token, so every themed region gets it
 * for free; nothing else should need to. An undefined `scope` keeps the
 * enclosing one, as the boundary itself does.
 */
export function IconScopeProvider({
  scope,
  children,
}: {
  scope: string | undefined;
  children: ReactNode;
}) {
  const parent = useContext(IconScopeContext);
  return (
    <IconScopeContext.Provider value={scope ?? parent}>
      {children}
    </IconScopeContext.Provider>
  );
}

export function useIconScope(): string | undefined {
  return useContext(IconScopeContext);
}

// The family an inspection surface draws the icons below in, overriding the
// scope's own `iconFamily` (undefined: no override).
const IconFamilyPreviewContext = createContext<IconFamilyId | undefined>(
  undefined,
);

/**
 * Draws the icons below as `family` draws them — the same chain `<Icon>` walks
 * in a scope whose `iconFamily` is `family`, every other axis (shape, fill,
 * stroke) the enclosing scope's. For INSPECTION surfaces that show one name in
 * several families side by side (Debug → Icons); an app picks its family
 * through its theme, never this.
 *
 * A strict family's gap drawn under a preview is NOT reported
 * (`iconFamilyGapReportSink`): an inspection surface shows gaps on purpose, and
 * the report means "an app drew one".
 */
export function IconFamilyPreview({
  family,
  children,
}: {
  family: IconFamilyId;
  children: ReactNode;
}) {
  return (
    <IconFamilyPreviewContext.Provider value={family}>
      {children}
    </IconFamilyPreviewContext.Provider>
  );
}

/** The family an enclosing {@link IconFamilyPreview} forces, if any. */
export function useIconFamilyPreview(): IconFamilyId | undefined {
  return useContext(IconFamilyPreviewContext);
}
