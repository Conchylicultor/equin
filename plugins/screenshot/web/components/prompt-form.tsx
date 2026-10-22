import { useState } from "react";
import { LaunchControl, type LaunchRequest } from "@plugins/primitives/plugins/launch/web";
import { TextEditor } from "@plugins/primitives/plugins/text-editor/web";
import {
  useFetchEndpoint,
  EndpointError,
} from "@plugins/infra/plugins/endpoints/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useLatestRef } from "@plugins/primitives/plugins/latest-ref/web";
import { saveScreenshotFile } from "../../shared/endpoints";

export function PromptForm({ id, getBlob }: { id: string; getBlob: () => Blob | null | Promise<Blob | null> }) {
  const fetchEndpoint = useFetchEndpoint();
  const [text, setText] = useState("");
  const textRef = useLatestRef(text);

  // The screenshot blob is uploaded via the existing `/api/screenshots/:id/file`
  // path (returns a server-side disk path) and appended to the prompt as
  // `@<path>`. Pasted images live inside the markdown as
  // `![](/api/attachments/<id>)` refs — the conversations server resolves
  // those into `@<path>` before handing the prompt to the agent.
  const getRequest = async (): Promise<LaunchRequest> => {
    const body = textRef.current.trim();
    const blob = await getBlob();
    if (!blob) return { prompt: body || undefined };
    let path: string;
    try {
      const answer = await fetchEndpoint(
        saveScreenshotFile,
        { id },
        { body: blob },
      );
      // No computer to hold the file: launch without the @path suffix.
      if (answer.kind === "unavailable") return { prompt: body || undefined };
      ({ path } = answer.value);
    } catch (err) {
      // A server non-2xx (the old `!res.ok` path) degrades gracefully by
      // launching without the @path suffix; anything unexpected propagates.
      if (!(err instanceof EndpointError)) throw err;
      return { prompt: body || undefined };
    }
    const prompt = body ? `${body}\n\n@${path}` : `@${path}`;
    return { prompt };
  };

  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- rigid footer leaf of the screenshot view's flex column
    <Stack gap="sm" className="bg-background shrink-0 border-t p-md">
      <TextEditor
        value={text}
        onChange={setText}
        placeholder="Describe what to do with this screenshot…"
        minRows={3}
        maxHeight="12rem"
        namespace="screenshot-prompt"
      />
      <LaunchControl getRequest={getRequest} />
    </Stack>
  );
}
