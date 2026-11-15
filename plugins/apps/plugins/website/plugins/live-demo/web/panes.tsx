import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { websiteApp } from "@plugins/apps/plugins/website/plugins/shell/core";
import { demoPage } from "../core";
import { DemoPage } from "./components/demo-page";

/** `/about/demo[/at/<place>]` — see {@link DemoPage}. */
export const demoPane = Pane.define({
  route: defineRoute({ id: "website-demo", segment: "demo" }),
  app: websiteApp,
  title: demoPage.title,
  component: DemoPage,
});
