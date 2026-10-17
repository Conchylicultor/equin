import { useCallback, useMemo, useState } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { isNodeData, useReorderedEntries } from "@plugins/reorder/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import type { ArtifactItem } from "@plugins/conversations/plugins/conversation-view/plugins/artifacts/core";
import { ConversationArtifacts, type ArtifactKind } from "../slots";
import { useConversationArtifacts } from "../use-conversation-artifacts";
import { ArtifactsCloseContext } from "../internal/close-context";
import { ArtifactsPanel } from "./artifacts-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const categoryIcon = symbol("category");

const LABEL = "Artifacts";

/**
 * Toolbar button listing everything this conversation made, changed or looked
 * at — prototypes, pages, research docs, screenshots, skills.
 *
 * Three states, and the first one matters: while the transcript is still
 * arriving the button is a plain disabled glyph with **no count**, because "0"
 * would be a claim about the user's work that reverses itself a moment later.
 * Once settled it opens whenever anything was found, and the closed button
 * says WHAT the conversation made: one glyph per kind it created or edited
 * something of, then ONE number for all of them — so "prototypes and pages,
 * three things" reads at a glance, without opening anything. Only `"produced"` kinds show there,
 * and only what was created or edited: the pictures it looked at, the skills
 * it loaded and the docs it merely read are listed in the panel but never on
 * the button (`ArtifactKind.origin`). A conversation that made nothing shows
 * the generic glyph alone, rather than a "0" the rows underneath contradict.
 */
export function ArtifactsButton() {
  const { convId } = conversationPane.useParams();
  const artifacts = useConversationArtifacts(convId);
  const [open, setOpen] = useState(false);

  if (artifacts.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={categoryIcon}
        subject="the artifacts"
        error={artifacts.error}
        refetch={artifacts.refetch}
      />
    );
  }
  if (artifacts.status === "loading") {
    return (
      // eslint-disable-next-line icon-button/prefer-icon-button -- placeholder for the icon+count button below; a square IconButton would resize the toolbar when the count settles
      <Button
        variant="ghost"
        tooltip={LABEL}
        aria-label={LABEL}
        disabled
        className="gap-xs"
      >
        <Icon icon={categoryIcon} />
      </Button>
    );
  }

  return (
    <ArtifactsReady
      byKind={artifacts.data.byKind}
      total={artifacts.data.total}
      made={artifacts.data.made}
      count={artifacts.data.count}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

/**
 * The kinds the conversation made something of, in the order the panel lists
 * them — the slot's reorder config, read through the same tree the panel's
 * `Render` applies, so the button and the sections below it cannot disagree.
 * A kind the user hid from the panel is hidden here too.
 */
function useMadeKinds(
  made: ReadonlyMap<string, number>,
): { kind: ArtifactKind & { id: string }; n: number }[] {
  const contributions = ConversationArtifacts.Kind.useContributions();
  // The clean contributions carry `_pluginId` + `id`, which is all the reorder
  // entry key needs; they lack `_slot`, so widen through `unknown`.
  const { entries } = useReorderedEntries(
    ConversationArtifacts.Kind.id,
    contributions as unknown as Contribution[],
  );
  return useMemo(() => {
    const out: { kind: ArtifactKind & { id: string }; n: number }[] = [];
    for (const entry of entries) {
      if (isNodeData(entry)) continue;
      const kind = entry as unknown as ArtifactKind & { id: string };
      const n = made.get(kind.id);
      if (n !== undefined) out.push({ kind, n });
    }
    return out;
  }, [entries, made]);
}

function ArtifactsReady({
  byKind,
  total,
  made,
  count,
  open,
  onOpenChange,
}: {
  byKind: ReadonlyMap<string, ArtifactItem[]>;
  total: number;
  made: ReadonlyMap<string, number>;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const madeKinds = useMadeKinds(made);

  if (total === 0) {
    return (
      // eslint-disable-next-line icon-button/prefer-icon-button -- same control as the enabled form below, which carries a count beside its glyph
      <Button
        variant="ghost"
        tooltip={`${LABEL} — nothing yet`}
        aria-label={LABEL}
        disabled
        className="gap-xs"
      >
        <Icon icon={categoryIcon} />
      </Button>
    );
  }

  return (
    <InlinePopover
      align="end"
      width="picker"
      padding="none"
      maxHeight="xl"
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <Button
          variant={open ? "secondary" : "ghost"}
          // The number is what the conversation MADE, so the tooltip says so
          // and splits it by kind — the panel underneath lists more than that,
          // and a reader comparing the two deserves the words.
          tooltip={
            madeKinds.length > 0
              ? `${LABEL} — made or changed: ${madeKinds
                  .map(({ kind, n }) => `${kind.label} ${n}`)
                  .join(", ")}`
              : LABEL
          }
          aria-label={LABEL}
          aria-pressed={open}
          className="gap-xs"
        >
          {madeKinds.length === 0 ? (
            <Icon icon={categoryIcon} />
          ) : (
            <>
              {madeKinds.map(({ kind }) => (
                <Icon icon={kind.icon} key={kind.id} />
              ))}
              <Text variant="count">{count}</Text>
            </>
          )}
        </Button>
      }
    >
      <ArtifactsCloseContext value={close}>
        <ArtifactsPanel byKind={byKind} />
      </ArtifactsCloseContext>
    </InlinePopover>
  );
}
