import { describe, expect, test } from "bun:test";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { browserApp } from "@plugins/apps/plugins/browser/plugins/shell/core";
import { chordApp } from "@plugins/apps/plugins/chord/plugins/shell/core";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { desktopApp } from "@plugins/apps/plugins/desktop/plugins/shell/core";
import { eventsApp } from "@plugins/apps/plugins/events/plugins/shell/core";
import { fileExplorerApp } from "@plugins/apps/plugins/file-explorer/plugins/shell/core";
import { isleApp } from "@plugins/apps/plugins/isle/plugins/shell/core";
import { keyboardPartyApp } from "@plugins/apps/plugins/keyboard-party/plugins/shell/core";
import { mailApp } from "@plugins/apps/plugins/mail/plugins/shell/core";
import { pagesApp } from "@plugins/apps/plugins/pages/plugins/shell/core";
import { placesApp } from "@plugins/apps/plugins/places/plugins/shell/core";
import { prototypesApp } from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { sonataApp } from "@plugins/apps/plugins/sonata/plugins/shell/core";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import { APPS } from "./catalog";

// The catalog copies each app's glyph as text (importing an app's shell would
// pull it into the website's composition — a test may). The site draws an
// app's icon the way the app draws it only while the copies agree.
const DEFINITIONS: readonly AppRef[] = [
  agentManagerApp,
  browserApp,
  chordApp,
  deployApp,
  desktopApp,
  eventsApp,
  fileExplorerApp,
  isleApp,
  keyboardPartyApp,
  mailApp,
  pagesApp,
  placesApp,
  prototypesApp,
  sonataApp,
  studioApp,
];

describe("the apps catalog", () => {
  test("each app's glyph is its definition's", () => {
    const byId = new Map(DEFINITIONS.map((app) => [app.id, app]));
    for (const app of APPS) {
      if (app.appId === null) continue;
      const def = byId.get(app.appId);
      expect(def, `no definition imported for "${app.appId}"`).toBeDefined();
      expect([app.appId, app.icon.name]).toEqual([app.appId, def!.icon.name]);
    }
  });

  test("no two apps share a colour", () => {
    const colors = APPS.map((app) => app.color);
    expect(colors.filter((c, i) => colors.indexOf(c) !== i)).toEqual([]);
  });
});
