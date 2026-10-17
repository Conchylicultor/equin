import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import {
  Breadcrumb,
  type BreadcrumbSegment,
} from "@plugins/primitives/plugins/breadcrumb/web";

export interface FilepathBreadcrumbProps {
  path: string;
  onNavigate?: (dirPath: string) => void;
  showCopy?: boolean;
}

export function FilepathBreadcrumb({
  path,
  onNavigate,
  showCopy = true,
}: FilepathBreadcrumbProps) {
  const pathSegments = path.split("/");
  const segments: BreadcrumbSegment[] = pathSegments.map((seg, i) => ({
    key: String(i),
    label: seg,
    activation: onNavigate
      ? () => onNavigate(pathSegments.slice(0, i + 1).join("/"))
      : undefined,
  }));

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
