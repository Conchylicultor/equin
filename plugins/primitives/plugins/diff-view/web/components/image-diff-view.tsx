import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  MissingImage,
  useImageLoad,
  useImageProbe,
  type ImageLoad,
  type ImageProbeState,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { codeImageUrl } from "@plugins/code-explorer/plugins/code-api/core";
import { useAssetSrc } from "@plugins/infra/plugins/endpoints/web";

/** Still finding out: not loaded yet, or failed and asking the server why. */
function isSettling(load: ImageLoad): boolean {
  return (
    load.kind === "pending" ||
    (load.kind === "failed" && load.reason === "probing")
  );
}

function isGone(load: ImageLoad): boolean {
  return load.kind === "failed" && load.reason === "gone";
}

/**
 * One side's image, already probed. A side that did not load shows the
 * missing-image box (with Retry while it is only unreadable); one that loaded
 * still owns its `<img>`'s failure, should the file go between probe and paint.
 */
function SideImage({
  src,
  name,
  probe,
  className,
}: {
  src: string;
  name: string;
  probe: ImageProbeState;
  className?: string;
}) {
  const { load, imgKey, imgProps, retry } = useImageLoad(src);
  const failure =
    probe.load.kind === "failed"
      ? { reason: probe.load.reason, retry: probe.retry }
      : load.kind === "failed"
        ? { reason: load.reason, retry }
        : null;
  return (
    <Center axis="both" className={cn("h-full p-lg", className)}>
      {failure ? (
        <MissingImage
          name={name}
          reason={failure.reason}
          onRetry={failure.retry}
        />
      ) : (
        <img
          key={imgKey}
          src={src}
          alt={name}
          {...imgProps}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </Center>
  );
}

function Panel({
  label,
  src,
  name,
  probe,
  side,
}: {
  label: string;
  src: string;
  name: string;
  probe: ImageProbeState;
  side: "old" | "new";
}) {
  const border =
    side === "old"
      ? "border-destructive/40 bg-destructive/5"
      : "border-success/40 bg-success/5";
  return (
    <Clip fill className={`rounded-md border ${border}`}>
      <Column
        className="h-full"
        header={
          <Text
            as="div"
            variant="caption"
            className="border-b px-md py-xs font-medium text-muted-foreground"
          >
            {label}
          </Text>
        }
        body={<SideImage src={src} name={name} probe={probe} />}
        scrollBody={false}
      />
    </Clip>
  );
}

export function ImageDiffView({
  worktree,
  path,
  base,
}: {
  worktree: string;
  path: string;
  base?: string;
}) {
  const ref = base ?? "HEAD";
  // Both sides' bytes over the subtree's transport (`useAssetSrc`).
  const oldAsset = useAssetSrc(codeImageUrl(worktree, path, { ref }));
  const newAsset = useAssetSrc(codeImageUrl(worktree, path));
  if (oldAsset.kind === "ready" && newAsset.kind === "ready") {
    return (
      <ImageDiffSides
        refLabel={ref}
        oldSrc={oldAsset.src}
        newSrc={newAsset.src}
        name={path.slice(path.lastIndexOf("/") + 1)}
      />
    );
  }
  const notReady = oldAsset.kind !== "ready" ? oldAsset : newAsset;
  if (notReady.kind === "loading") {
    return <Loading className="px-md py-sm" />;
  }
  return (
    <Text as="div" variant="body" className="px-md py-sm text-muted-foreground">
      {notReady.kind === "ready" ? null : notReady.message}
    </Text>
  );
}

function ImageDiffSides({
  refLabel: ref,
  oldSrc,
  newSrc,
  name,
}: {
  refLabel: string;
  oldSrc: string;
  newSrc: string;
  name: string;
}) {
  const oldProbe = useImageProbe(oldSrc);
  const newProbe = useImageProbe(newSrc);

  if (isSettling(oldProbe.load) || isSettling(newProbe.load)) {
    return <Loading className="px-md py-sm" />;
  }

  // Only a 404 / 410 says a side has no version; any other failure is a side
  // that exists but could not be read, shown as such in its panel below.
  const oldGone = isGone(oldProbe.load);
  const newGone = isGone(newProbe.load);

  if (oldGone && newGone) {
    return (
      <Text as="div" variant="body" className="px-md py-sm text-destructive">
        Image not found.
      </Text>
    );
  }

  // Added (no old version)
  if (oldGone && newProbe.load.kind === "loaded") {
    return <SideImage src={newSrc} name={name} probe={newProbe} />;
  }

  // Deleted (no new version)
  if (newGone && oldProbe.load.kind === "loaded") {
    return (
      <SideImage
        src={oldSrc}
        name={name}
        probe={oldProbe}
        className="opacity-50"
      />
    );
  }

  // Modified, or a side that could not be read: side-by-side
  return (
    <Stack direction="row" gap="sm" className="h-full p-lg">
      <Panel label={ref} src={oldSrc} name={name} probe={oldProbe} side="old" />
      <Panel
        label="Working tree"
        src={newSrc}
        name={name}
        probe={newProbe}
        side="new"
      />
    </Stack>
  );
}
