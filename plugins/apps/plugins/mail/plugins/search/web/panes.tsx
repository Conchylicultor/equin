import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { mailApp } from "@plugins/apps/plugins/mail/plugins/shell/core";
import { MailSearchBody } from "./components/mail-search-body";
import {
  MailMessageBody,
  MailMessageTitle,
} from "./components/mail-message-reader";

const mailSearchRoute = defineRoute({
  id: "mail-search",
  segment: "search",
});

/**
 * On-demand mail search surface. `segment: "search"` resolves relative to the
 * Mail app's base path (`/mail/search`); it is opened as the surface root from
 * the sidebar entry (mode `"root"`). Not `appIndex` — the app's index landing
 * pane already owns bare `/mail`.
 */
export const mailSearchPane = Pane.define({
  route: mailSearchRoute,
  app: mailApp,
  width: 480,
  component: MailSearchBody,
  title: "Search",
});

/**
 * The reading pane for a single message. Opened to the right of a search row
 * (`mode: "push"`, `side: "right"`) for the thread's newest matched message:
 * the header is that message's live row in the mirror, the body its
 * `mail.message-body` value (read by `messageId`). Static prefix `m/` before
 * the `:messageId` param satisfies the pane router's "params need a static
 * prefix" rule.
 *
 * `useResolve: false` opts out of route-resolution: the pane reads its message
 * by `messageId` and owns its own loading / not-found / error states in the
 * body.
 */
export const mailMessagePane = Pane.define({
  route: defineRoute({
    id: "mail-message",
    segment: "m/:messageId",
    parent: mailSearchRoute,
  }),
  app: mailApp,
  width: 640,
  useResolve: false,
  component: MailMessageBody,
  // The subject is known only inside the body (the message's live row), so
  // the tab reads "Message" and the header's `component` — mounted under the
  // body — paints the subject.
  title: { useText: "Message", component: MailMessageTitle },
});
