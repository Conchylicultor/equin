import { keptText } from "@plugins/primitives/plugins/kept-state/core";
import { useState } from "react";
import type { LaunchOptionValues } from "@plugins/tasks/plugins/launch-options/web";
import { useCaptureUrlDefault } from "../../web/use-capture-url-default";
import { TaskDraftComposer } from "../../web/components/task-draft-composer";

/**
 * The Improve popover's composer, exhibited on its own (the `task-draft/composer` exhibit): the real
 * field, URL toggle, prose actions and launch-option pills, seeded from the
 * same defaults the popover uses. An exhibit, not a working copy — typing and
 * toggling work, submitting does nothing.
 */
export default function ComposerExhibit() {
  const captureUrlDefault = useCaptureUrlDefault();
  const [text, setText] = useState("");
  const [launchOptions, setLaunchOptions] = useState<LaunchOptionValues>({});
  const [includeUrl, setIncludeUrl] = useState(captureUrlDefault);
  return (
    <TaskDraftComposer
      cardId="exhibit"
      keep={keptText(text, setText)}
      launchOptions={launchOptions}
      autoFocus={false}
      disabled={false}
      onLaunchOptionsChange={setLaunchOptions}
      onSubmitChord={() => {}}
      isHead
      includeUrl={includeUrl}
      onToggleUrl={setIncludeUrl}
      relate={null}
    />
  );
}
