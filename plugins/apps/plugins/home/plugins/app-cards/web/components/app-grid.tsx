import { useMemo } from "react";
import { Apps, useCurrentAppId } from "@plugins/apps-core/web";
import { useActivateApp } from "@plugins/apps-core/plugins/tabs/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  type CreateOption,
} from "@plugins/primitives/plugins/data-view/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { capsuleToolbar } from "@plugins/primitives/plugins/data-view/plugins/capsule-toolbar/web";
import {
  appRow,
  appRowOverrides,
  type AppRow,
} from "@plugins/apps-core/plugins/app-launcher/web";
import type { IconsViewOptions } from "@plugins/primitives/plugins/data-view/plugins/icons/core";
import { useHintAnchor } from "@plugins/hints/web";
import { appTileAnchor, homeGalleryAnchor } from "../../core";
import { installedApp } from "@plugins/apps-core/plugins/app-launcher/core";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { LaunchAgentForm } from "@plugins/primitives/plugins/launch/web";
import { APPS_CATEGORY_ID } from "@plugins/apps/plugins/home/core";
import {
  mintPrototypeFolder,
  newPrototypePrompt,
} from "@plugins/apps/plugins/prototypes/plugins/gallery/web";
import {
  useFetchEndpoint,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { useToast, type Toast } from "@plugins/shell/plugins/notifications/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");

const HOME_APPS_VIEW = defineDataView("home.apps");

/** Registers each app's whole tile (square and name) as its hint anchor. */
function useAppTileRef(row: AppRow) {
  return useHintAnchor(appTileAnchor.at(row.id));
}

/** The icons view's options: every tile is an anchor the onboarding tour can point at. */
const homeAppViewOptions: { icons: IconsViewOptions<AppRow> } = {
  icons: { useTileRef: useAppTileRef },
};

const PROTOTYPE_FIRST = "prototype-first";

// The prompt every "New app" agent starts from. It points at the create-app
// skill (where an app lives and how its shell is shaped) and asks for a plan
// first, since an app is a feature, not a one-line change. The user's own words
// follow as the description of what to build.
//
// With "Prototype first", the agent designs a throwaway mock before any plugin
// code — the same instructions a "New prototype" agent gets, in a folder minted
// here — and waits for the user's review of it in Prototypes.
function newAppPrompt(userText: string, prototypeId: string | null): string {
  const app = [
    "Read the `create-app` skill before writing anything, and follow it.",
    "Start with the `plan` skill: an app is a feature, so design it (what it",
    "shows, its data, which existing plugins it composes) and check the design",
    "with me before implementing.",
    "",
    "Then implement it, run `./singularity build`, and give me the app's URL so I",
    "can try it in your worktree. Do not push.",
  ];
  const parts = ["Build a new top-level Singularity app."];
  if (prototypeId) {
    parts.push(
      [
        "Work in two steps.",
        "",
        "## Step 1 — prototype",
        "",
        "Before any plugin code, design the app as a throwaway prototype. The",
        "rules below hold until I approve the prototype:",
        "",
        newPrototypePrompt(prototypeId),
        "",
        "When it is ready, stop and ask me to review it in the Prototypes app.",
        "Iterate on it with me until I approve it.",
        "",
        "## Step 2 — the app",
        "",
        "Build the app from the approved prototype.",
        ...app,
        "Once the app is built, add",
        '`<meta name="mocks" content="app:/<the app\'s path>">` to the prototype so',
        "the prototype canvas can put the mock beside the real app (+ Real app).",
      ].join("\n"),
    );
  } else {
    parts.push(app.join("\n"));
  }
  parts.push(
    userText.trim()
      ? `The app I want:\n${userText.trim()}`
      : "I have not described the app yet — ask me what it should do.",
  );
  return parts.join("\n\n");
}

/** Opens the launch-agent form for a new app. A dialog rather than a popover,
 *  because the create affordance renders in several shapes (the capsule's round
 *  `+`, the no-match empty state's "Build one?") and a dialog serves them all
 *  from one callback. Launching files a task under the Apps category and starts
 *  it in the background; the bell announces the conversation, like "New
 *  prototype". */
function newApp(fetchEndpoint: FetchEndpoint, toast: Toast): void {
  void openDialog(
    (close) => (
      <LaunchAgentForm
        draftKey="new-app"
        title="New app"
        description="Describe the app you want. An agent plans it with you, builds it in its own worktree, and hands you a link to try it before anything ships."
        placeholder="What should the app do? e.g. a reading list that saves links and tracks what I've finished…"
        toggles={[
          {
            id: PROTOTYPE_FIRST,
            label: "Prototype first",
            description:
              "Design a throwaway mockup you review in Prototypes before any app code.",
          },
        ]}
        getRequest={async (userText, toggles) => {
          // Minted before launch, so the agent is handed a folder that exists;
          // a failed mint rejects and the launch never happens.
          const prototypeId = toggles[PROTOTYPE_FIRST]
            ? await mintPrototypeFolder(fetchEndpoint, toast)
            : null;
          return {
            prompt: newAppPrompt(userText, prototypeId),
            categoryId: APPS_CATEGORY_ID,
          };
        }}
        // Close on either outcome: the task is filed whether or not the
        // agent started.
        onSubmitted={() => close()}
      />
    ),
    { size: "lg" },
  );
}

export function AppGrid() {
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  const apps = Apps.App.useContributions();
  const currentId = useCurrentAppId();
  // Lands in the grid's OWN surface tab — in desktop mode multiple Home
  // windows can be open, so the global focused tab is the wrong target.
  const activate = useActivateApp();
  const galleryRef = useHintAnchor(homeGalleryAnchor);
  const rows = useMemo(
    () => apps.filter((a) => a.id !== currentId).map(appRow),
    [apps, currentId],
  );

  const creators: CreateOption[] = [
    {
      id: "new-app",
      label: "New app",
      icon: <Icon icon={addIcon} className="size-4" />,
      onSelect: () => newApp(fetchEndpoint, toast),
    },
  ];

  return (
    // The gallery's hint anchor: the grid with its toolbar, one box.
    <Stack gap="none" ref={galleryRef}>
      <DataView<AppRow>
        rows={rows}
        rowKey={(a) => a.id}
        // The same tile and name the app launcher draws; the client fields of
        // the kind (usage stats, …) join them.
        collection={installedApp}
        overrides={appRowOverrides}
        // Icons is the launcher (tile + name only); the table shows every field,
        // contributed ones included.
        views={["icons", "table"]}
        viewOptions={homeAppViewOptions}
        defaultView="icons"
        toolbar={capsuleToolbar}
        searchPlaceholder="Search apps"
        storageKey={HOME_APPS_VIEW}
        // The grid only renders inside the visible (focused) Home tab, so the
        // launcher navigates that tab into the picked app in place.
        rowActivation={(row) => activate(row.entry)}
        creators={creators}
        // Every install has apps, so an empty grid is a search that matched
        // nothing — which is when building the missing app is the useful offer.
        emptyState={
          <>
            No app matches.{" "}
            <Button
              variant="link"
              aspect="inline"
              onClick={() => newApp(fetchEndpoint, toast)}
            >
              Build one?
            </Button>
          </>
        }
      />
    </Stack>
  );
}
