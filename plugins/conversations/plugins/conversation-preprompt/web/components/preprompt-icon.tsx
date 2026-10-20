import {
  PrepromptGlyph,
  usePreprompt,
} from "@plugins/conversations/plugins/preprompts/web";
import type { ConversationPreprompt } from "../../core";

// Renders a preprompt's icon for a conversation. The icon is resolved *live*
// from the preprompt library by id — so an icon added or edited after launch
// shows immediately — and falls back to the launch-time snapshot when the
// library item was deleted (or edited to drop its icon). The actual glyph
// rendering (and the default-glyph fallback) is owned by the preprompts plugin
// via PrepromptGlyph, so the marker reads identically here and in the picker.
export function PrepromptIcon({
  record,
  className,
}: {
  record: ConversationPreprompt;
  className?: string;
}) {
  const live = usePreprompt(record.prepromptId);
  return <PrepromptGlyph icon={live?.icon ?? record.icon} className={className} />;
}
