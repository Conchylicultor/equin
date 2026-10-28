import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import { lumenDemo } from "../../core";

/** The demo scenario in a fixed frame — what the website band shows. */
export default function AgentManagerDemoExhibit() {
  return (
    <div className="h-[720px] w-full">
      <DemoScope scenario={lumenDemo}>
        <AppEmbed app={lumenDemo.app} route={lumenDemo.route} />
      </DemoScope>
    </div>
  );
}
