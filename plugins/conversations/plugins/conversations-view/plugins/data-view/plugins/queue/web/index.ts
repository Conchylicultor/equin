import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SidebarSources } from "@plugins/conversations/plugins/conversations-view/plugins/data-view/web";
import { QueueSource } from "./components/sidebar-queue";
import {
  QueueItemActions,
  PinAction,
  MoveToAction,
  PromoteAction,
  StepDownAction,
  DemoteAction,
  AddToQueueAction,
  CloseAction,
} from "./components/queue-item-actions";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Contributes the priority Queue (Pinned, user-made and status group-by sections — drag a row across them or onto New section, rename / reorder / delete sections from their headers, Move to on each row — task-group aggregation, supervised tasks nested beneath their supervisor's row (attach, per-view Sub-items), and neighbor-based manual-order drag over the queue's live data/mutation layer) as the Queue source of the merged conversation-sidebar DataView.",
  contributions: [
    SidebarSources({
      id: "queue",
      title: "Queue",
      icon: symbol("low-priority"),
      views: ["list"],
      // Supervised tasks attach beneath their supervisor's row.
      subItems: "attach",
      component: QueueSource,
    }),
    QueueItemActions({ id: "pin", component: PinAction }),
    QueueItemActions({ id: "move-to", component: MoveToAction }),
    QueueItemActions({ id: "promote", component: PromoteAction }),
    QueueItemActions({ id: "step-down", component: StepDownAction }),
    QueueItemActions({ id: "demote", component: DemoteAction }),
    QueueItemActions({ id: "add-to-queue", component: AddToQueueAction }),
    QueueItemActions({ id: "close", component: CloseAction }),
  ],
  slots: { queueActions: QueueItemActions },
} satisfies PluginDefinition;
