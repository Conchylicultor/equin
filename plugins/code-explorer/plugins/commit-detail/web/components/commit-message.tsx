import {
  commitCoAuthors,
  commitTrailer,
  parseConventionalSubject,
} from "@plugins/primitives/plugins/commit-list/core";
import type { CommitDetail } from "@plugins/code-explorer/plugins/code-api/core";
import { CONVERSATION_TRAILER_KEY } from "@plugins/tasks/plugins/tasks-core/core";
import { useIdPresenters, type IdPresenter } from "@plugins/ids/web";
import { usePaneToggle } from "@plugins/primitives/plugins/pane/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  ControlSizeProvider,
  WithTooltip,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Avatar } from "@plugins/primitives/plugins/avatar/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Expandable } from "@plugins/primitives/plugins/expandable/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

/** The body's clamp: about five lines of prose before "Full message". */
const BODY_COLLAPSED_PX = 100;

/**
 * The provenance trailers the header shows as chips, in order: only the
 * conversation that wrote the commit (the attempt and push are reached from
 * it). The keys are the trailer grammar's own (`tasks-core`'s reader half); a
 * value an id-kind presenter recognises renders as that kind's chip, opening
 * its pane; any other as a plain chip.
 */
const PROVENANCE: readonly { key: string; label: string; icon: IconRef }[] = [
  {
    key: CONVERSATION_TRAILER_KEY,
    label: "Conversation",
    icon: symbol("chat"),
  },
];

/**
 * The colour a Conventional Commit type wears; an unlisted type is muted.
 * Closed and local: it says how this header draws a type, not what one means.
 */
const TYPE_VARIANT: Record<string, BadgeVariant> = {
  feat: "success",
  fix: "warning",
  perf: "info",
  revert: "destructive",
};

const absoluteDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * One commit's message as the head of its pane: the Conventional Commit type
 * and scopes as chips, the subject (wrapping, never truncated), a meta row
 * (author and co-authors, relative date with the absolute one on hover), the
 * body as prose clamped behind "Full message", and the provenance trailers as
 * chips. The sha is the pane title's (with its copy button), not repeated here.
 */
export function CommitMessage({ commit }: { commit: CommitDetail }) {
  const subject = parseConventionalSubject(commit.subject);
  const provenance = PROVENANCE.flatMap((p) => {
    const value = commitTrailer(commit, p.key);
    return value === null ? [] : [{ ...p, value }];
  });

  return (
    <Inset pad="lg">
      <Stack direction="col" gap="md">
        <Stack direction="col" gap="sm">
          {subject.type !== null && (
            <Cluster gap="xs">
              <Badge variant={TYPE_VARIANT[subject.type] ?? "muted"}>
                {/* The prototype's all-caps type label, cased in the content. */}
                {subject.type.toUpperCase()}
                {subject.breaking ? "!" : ""}
              </Badge>
              {subject.scopes.map((scope) => (
                <Badge
                  key={scope}
                  mono
                  colorClass="text-subtle-foreground ring-1 ring-border ring-inset"
                >
                  {scope}
                </Badge>
              ))}
            </Cluster>
          )}
          <Text as="h1" variant="heading" className="text-pretty">
            {subject.description}
          </Text>
        </Stack>
        <CommitMeta commit={commit} />
        {commit.body !== "" && (
          <Expandable
            collapsedHeight={BODY_COLLAPSED_PX}
            labels={{ more: "Full message", less: "Show less" }}
          >
            <Text as="div" variant="label" tone="subtle">
              <Markdown>{commit.body}</Markdown>
            </Text>
          </Expandable>
        )}
        {provenance.length > 0 && (
          <Cluster gap="xs">
            {provenance.map((p) => (
              <ProvenanceChip
                key={p.key}
                label={p.label}
                icon={p.icon}
                value={p.value}
              />
            ))}
          </Cluster>
        )}
      </Stack>
    </Inset>
  );
}

function CommitMeta({ commit }: { commit: CommitDetail }) {
  const coAuthors = commitCoAuthors(commit);
  const authored = new Date(commit.authoredAt);
  const dated = !Number.isNaN(authored.getTime());
  return (
    <ControlSizeProvider size="xs">
      <Text as="div" variant="caption" tone="muted">
        <Cluster gap="md">
          <Inline gap="xsm">
            <Inline gap="2xs">
              <Avatar
                fallbackGlyph={commit.authorName}
                fallbackKey={commit.authorEmail || commit.authorName}
                title={`${commit.authorName} <${commit.authorEmail}>`}
              />
              {coAuthors.map((c) => (
                <Avatar
                  key={`${c.name}<${c.email}>`}
                  fallbackGlyph={c.name}
                  fallbackKey={c.email || c.name}
                  title={c.email ? `${c.name} <${c.email}>` : c.name}
                />
              ))}
            </Inline>
            <Text tone="subtle">{commit.authorName}</Text>
            {coAuthors.length > 0 && (
              <>
                with
                <Text tone="subtle">
                  {coAuthors.map((c) => c.name).join(", ")}
                </Text>
              </>
            )}
          </Inline>
          {dated && (
            <WithTooltip content={absoluteDate.format(authored)}>
              <span>
                <RelativeTime date={authored} />
              </span>
            </WithTooltip>
          )}
        </Cluster>
      </Text>
    </ControlSizeProvider>
  );
}

/**
 * One provenance trailer: the kind's chip when an id-kind presenter claims
 * the value, else a plain chip naming it.
 */
function ProvenanceChip({
  label,
  icon,
  value,
}: {
  label: string;
  icon: IconRef;
  value: string;
}) {
  const presenter = useIdPresenters().find((p) => p.kind.is(value));
  if (presenter === undefined) {
    return (
      <Badge
        shape="pill"
        icon={<Icon icon={icon} />}
        colorClass="text-subtle-foreground ring-1 ring-border ring-inset"
        tooltip={`${label} ${value}`}
      >
        <Inline gap="xs">
          <Text tone="muted">{label}</Text>
          <Text variant="code">{value.slice(0, 8)}</Text>
        </Inline>
      </Badge>
    );
  }
  return (
    <PresentedProvenanceChip
      // Keyed by kind: a different presenter is a different set of hooks.
      key={presenter.kind.prefix}
      presenter={presenter}
      label={label}
      icon={icon}
      value={value}
    />
  );
}

function PresentedProvenanceChip({
  presenter,
  label,
  icon,
  value,
}: {
  presenter: IdPresenter;
  label: string;
  icon: IconRef;
  value: string;
}) {
  const { useReferent, usePane } = presenter;
  const referent = useReferent(value);
  const target = usePaneToggle()(usePane(value));
  const title = referent.status === "found" ? referent.title : null;
  return (
    <LinkChip
      shape="pill"
      activation={target}
      tooltip={title === null ? value : `${title} · ${value}`}
      leading={<Icon icon={icon} />}
    >
      <Inline gap="xs">
        <Text tone="muted">{label}</Text>
        {title ?? <Text variant="code">{value}</Text>}
      </Inline>
    </LinkChip>
  );
}
