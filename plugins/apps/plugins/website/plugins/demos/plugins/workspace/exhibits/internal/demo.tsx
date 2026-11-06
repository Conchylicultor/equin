import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import { workspaceDemo } from "../../core";

/** The demo scenario in a fixed frame — what the website band shows. */
export default function AgentManagerDemoExhibit() {
  return (
    <div className="h-[720px] w-full">
      <DemoScope scenario={workspaceDemo}>
        <AppEmbed app={workspaceDemo.app} route={workspaceDemo.route} />
      </DemoScope>
    </div>
  );
}
