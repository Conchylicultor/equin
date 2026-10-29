import { useLiveMutation } from "@plugins/network/plugins/live/web";
import { postBrowserHistory } from "../../shared/endpoints";

/** Records a browser visit. Predicted: `browserRecents` shows it at once. */
export function useRecordVisit(): (url: string) => void {
  const { mutate } = useLiveMutation(postBrowserHistory);
  return (url: string) => mutate({ body: { url } });
}
