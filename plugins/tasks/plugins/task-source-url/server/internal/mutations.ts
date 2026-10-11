import { tasksSourceUrl } from "./tables";

export async function setTaskSourceUrl(
  taskId: string,
  url: string,
): Promise<void> {
  await tasksSourceUrl.upsert(taskId, { url });
}
