import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  upsertNote as upsertNoteEndpoint,
  deleteNote as deleteNoteEndpoint,
} from "../../shared/endpoints";

export async function upsertNote(
  fetchEndpoint: FetchEndpoint,
  conversationId: string,
  notes: string,
): Promise<void> {
  await fetchEndpoint(upsertNoteEndpoint, { conversationId }, { body: { notes } });
}

export async function deleteNote(
  fetchEndpoint: FetchEndpoint,
  conversationId: string,
): Promise<void> {
  await fetchEndpoint(deleteNoteEndpoint, { conversationId });
}
