/**
 * What to call a conversation where it is named once and kept — a
 * notification's subject, sent as a snapshot: its own title, else its task's
 * (a conversation takes its task's title at creation, so an untitled one is
 * rare), else "Untitled". The same words the conversation list's
 * `conversation` title mode shows, minus its "Starting…", which is a claim
 * about the status at render time, not a name to store.
 */
export function conversationName(conv: {
  title: string | null;
  taskTitle: string;
}): string {
  return conv.title?.trim() || conv.taskTitle.trim() || "Untitled";
}
