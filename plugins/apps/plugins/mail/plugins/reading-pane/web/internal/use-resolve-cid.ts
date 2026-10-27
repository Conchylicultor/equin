import { useCallback } from "react";
import type { MailAttachment } from "@plugins/apps/plugins/mail/plugins/mail-core/core";
import { mailAttachmentUrl } from "@plugins/apps/plugins/mail/plugins/attachments/core";
import { useMailAttachment } from "@plugins/apps/plugins/mail/plugins/attachments/web";

/** Strip the surrounding angle brackets Gmail wraps a Content-ID in. */
function bareCid(cid: string): string {
  return cid.replace(/^<|>$/g, "").trim();
}

function findByCid(
  attachments: readonly MailAttachment[],
  cid: string,
): MailAttachment | undefined {
  const target = bareCid(cid);
  return attachments.find(
    (a) => a.contentId != null && bareCid(a.contentId) === target,
  );
}

export interface CidImages {
  /**
   * `<MailHtml resolveCid>`: a pure read of the live mail row — the stored
   * attachment's same-origin URL, or `undefined` while its bytes are not
   * stored (or no attachment carries the cid, and `<MailHtml>` drops the image).
   */
  resolveCid: (cid: string) => string | undefined;
  /**
   * `<MailHtml onUnresolvedCids>`: for every cid image still waiting on an
   * attachment the mailbox has, fire the materialise write. The write stamps
   * the row's `storedAttachmentId`; the `mail.message-body` value carries the
   * stamped row back, `resolveCid` changes, and the image fills in.
   */
  onUnresolvedCids: (cids: readonly string[]) => void;
}

/**
 * Inline `cid:` images for `<MailHtml>`, read from the message's live
 * attachment rows. The URL is never held here: it is derived from the row's
 * `storedAttachmentId`, so the only thing this hook does on its own is ask the
 * server to store bytes it does not have yet (a write whose answer is unused).
 */
export function useResolveCid(attachments: MailAttachment[]): CidImages {
  const { materialise } = useMailAttachment();

  const resolveCid = useCallback(
    (cid: string): string | undefined => {
      const stored = findByCid(attachments, cid)?.storedAttachmentId;
      return stored ? mailAttachmentUrl(stored) : undefined;
    },
    [attachments],
  );

  const onUnresolvedCids = useCallback(
    (cids: readonly string[]): void => {
      for (const cid of cids) {
        const att = findByCid(attachments, cid);
        if (att && !att.storedAttachmentId) materialise(att.id);
      }
    },
    [attachments, materialise],
  );

  return { resolveCid, onUnresolvedCids };
}
