import { DemoScope } from "@plugins/framework/plugins/browser-server/plugins/demo/plugins/scope/web";
import { AppEmbed } from "@plugins/apps-core/plugins/app-embed/web";
import { agentManagerDemo } from "../../core";

/** The demo scenario in a fixed frame — what the website band shows. */
export default function AgentManagerDemoExhibit() {
  return (
    <div className="h-[720px] w-full">
      <DemoScope scenario={agentManagerDemo}>
        <AppEmbed app={agentManagerDemo.app} route={agentManagerDemo.route} />
      </DemoScope>
    </div>
  );
}
