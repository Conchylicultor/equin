import type { z, ZodObject } from "zod";
import {
  defineContainerBlock,
  type ContainerBlockOptions,
  type RejectTextBearing,
} from "@plugins/page/plugins/container/core";
import type {
  BlockAudience,
  BlockAuthor,
  BlockHandle,
} from "@plugins/page/plugins/editor/core";

/**
 * The declaration surface of an annotation: a void container's, plus the two
 * things an annotation has that an ordinary container does not.
 *
 * Everything else is FORWARDED, never restated — `ContainerBlockOptions` is
 * intersected rather than copied, so a new container option (or a removed one)
 * reaches annotations with no edit here, and the two surfaces cannot drift into
 * disagreeing about what a container may declare.
 */
export type AnnotationBlockOptions<S extends ZodObject> =
  ContainerBlockOptions<S> & {
    /**
     * Who may RECEIVE this card's content — `"agent"` for the three cards
     * addressed TO or written BY an agent (`/human`, `/todo`, `/agent`), `"human"`
     * for the one withheld from them (`/private`).
     *
     * REQUIRED. See `defineAnnotationBlock` below.
     */
    audience: BlockAudience;
    /**
     * Whose words this card holds, and therefore who may WRITE it — `"agent"` for
     * the one card an agent authors (`/agent`), `"human"` for everything the page's
     * author types (`/human`, `/todo`, `/private`).
     *
     * REQUIRED, and it is a genuinely separate question from `audience`, not a
     * restatement of it: `/human` and `/todo` are addressed to an agent and are
     * still not an agent's to rewrite. That single row — `/agent` being the only
     * `author: "agent"` card in the system — is what the whole agent-write rule
     * reduces to.
     */
    author: BlockAuthor;
  };

/**
 * A `BlockHandle` that PROVES both parties were declared: both fields are
 * required here, where `BlockHandle`'s are optional (an ordinary paragraph
 * declares neither). `& { text?: undefined }` is `defineContainerBlock`'s own
 * voidness proof, carried through — see its return-type note for why weakening
 * it breaks every container's `Editor.Block` registration.
 */
export type AnnotationBlockHandle<T> = BlockHandle<T> & {
  text?: undefined;
  audience: BlockAudience;
  author: BlockAuthor;
};

/**
 * Define an ANNOTATION block type: a void container that carries part of the
 * page's human↔agent side-channel, and therefore declares both of the page's
 * parties — who its content is for, and whose words it holds.
 *
 * It is `defineContainerBlock` plus exactly two REQUIRED fields, and the
 * requirement is the whole mechanism:
 *
 * > **An annotation cannot be unmarked, on either axis.** There is no default to
 * > leak through, and none to be silently frozen by.
 *
 * The fail-safe direction the family doc demands ("the failure mode of a future
 * annotation is *the agent didn't see it*, never *the private card leaked*") is
 * therefore reached by making the unmarked state UNREPRESENTABLE rather than by
 * defaulting it. A default would be a value some consumer eventually has to
 * interpret; a required field is a compile error at the one site that knows the
 * answer.
 *
 * The two absent-value defaults it makes unreachable point in OPPOSITE
 * directions — absent `audience` is visible to everyone, absent `author` is the
 * human's — which is precisely why neither can be derived from the other and why
 * both have to be asked (see `BlockHandle.author` for the table). What they have
 * in common is only that both are right for ORDINARY PROSE and wrong for an
 * annotation: a card that fell through them would be a paragraph, and this
 * family exists because the page has things in it that are not paragraphs.
 *
 * Enforcement has two halves, neither sufficient alone:
 *
 * - this signature, which a new annotation written through this factory cannot
 *   satisfy without answering both questions;
 * - the `annotations:parties-declared` check, which is what stops a new
 *   annotation from reaching for `defineContainerBlock` directly and quietly
 *   being an ordinary container — the case the signature cannot see.
 *
 * Neither field is threaded through `ContainerBlockOptions`, deliberately, and
 * for the same reason. A callout or a quote has no audience and no author — they
 * are ordinary prose — so widening the container surface would both invite a
 * meaningless declaration and destroy the check's discriminator: presence of
 * either field on a handle is exactly the proof that it came through here,
 * because nothing else can set them.
 */
export function defineAnnotationBlock<S extends ZodObject>(
  opts: AnnotationBlockOptions<S> & RejectTextBearing<S>,
): AnnotationBlockHandle<z.infer<S>> {
  // `opts` is passed WHOLE rather than destructured: `RejectTextBearing<S>` is an
  // unresolved conditional while `S` is generic, and a rest element over it is not
  // an object type TypeScript can spread. `defineBlock` builds the handle from a
  // fixed field list, so the extra `audience` / `author` keys riding along are
  // inert there — this function is the one place either is installed, which is
  // what keeps "only the annotation factory declares a party" true.
  return {
    ...defineContainerBlock(opts),
    audience: opts.audience,
    author: opts.author,
  };
}
