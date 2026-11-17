import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import {
  Breadcrumb,
  type BreadcrumbSegment,
} from "@plugins/primitives/plugins/breadcrumb/web";
import type {
  PathPlaces,
  PathPlacesAt,
} from "@plugins/primitives/plugins/path-bar/web";

export interface FilepathBreadcrumbProps {
  path: string;
  onNavigate?: (dirPath: string) => void;
  /**
   * The places beside each crumb, listed while the pointer rests on it (a
   * click still navigates): `folderPlaces(fs)` for a path on a file system
   * (`primitives/path-bar/folder-places`). Required, so a trail without them
   * says why: `null` only where the path's folders cannot be listed (a file
   * with no browsable place).
   */
  places: PathPlaces | null;
  showCopy?: boolean;
}

/**
 * A crumb's path: its segments joined; the empty prefix of an absolute path
 * is the root, `/`.
 */
function prefixPath(parts: readonly string[], end: number): string {
  return parts.slice(0, end).join("/") || "/";
}

export function FilepathBreadcrumb({
  path,
  onNavigate,
  places,
  showCopy = true,
}: FilepathBreadcrumbProps) {
  const pathSegments = path.split("/");
  const dirs = pathSegments.map((_, i) => prefixPath(pathSegments, i + 1));
  const at: PathPlacesAt = {
    trail: new Set(dirs),
    activationFor: (dir) => (onNavigate ? () => onNavigate(dir) : undefined),
  };
  const segments: BreadcrumbSegment[] = pathSegments.map((seg, i) => {
    const parent = i > 0 ? dirs[i - 1] : undefined;
    return {
      key: String(i),
      // An absolute path's first segment is the root, which has no name.
      label: seg === "" && i === 0 ? "/" : seg,
      activation: onNavigate ? () => onNavigate(dirs[i]!) : undefined,
      // Resting on a crumb lists its parent's places; the root has none.
      siblings:
        places !== null && parent !== undefined
          ? places(parent, at)
          : undefined,
    };
  });

  const copyAction = showCopy ? (
    <CopyButton
      text={path}
      aspect="inline"
      className="text-muted-foreground hover:text-foreground"
      tooltip="Copy path"
    />
  ) : undefined;

  return <Breadcrumb segments={segments} actions={copyAction} />;
}
