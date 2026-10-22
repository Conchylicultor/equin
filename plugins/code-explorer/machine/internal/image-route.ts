import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { handleImageContent } from "../../server/internal/image-handler";

/**
 * `GET /api/code/:worktree/image` (`getImageContent`, needsMachine): a
 * checkout file's raw bytes — a raw handler (its own status and headers), so
 * branded here rather than implemented.
 */
export const handleImage = machineHandler(handleImageContent);
