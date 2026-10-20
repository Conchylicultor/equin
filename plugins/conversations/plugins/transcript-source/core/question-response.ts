import type { QuestionAnswer } from "./protocol";

// The CLI turns an AskUserQuestion answer into the model's tool result, and a
// `response` REPLACES the answers there: the model reads only `The user
// responded: <response>`, never what was picked. So an answer carrying both
// spells its picks into the response itself, ahead of the reply, and the
// answered view strips them back off to show the reply alone. One pair, so
// the two sides cannot drift.

const PREAMBLE = "My answers: ";

function picksLine({ answers, annotations }: QuestionAnswer): string | null {
  const parts = Object.entries(answers).map(([question, value]) => {
    const notes = annotations?.[question]?.notes;
    return `"${question}"="${value}"${notes ? ` notes: ${notes}` : ""}`;
  });
  return parts.length > 0 ? `${PREAMBLE}${parts.join(", ")}` : null;
}

/**
 * The answer as it must reach the CLI: with a reply AND picks, the reply is
 * prefixed with the picks so the model sees both. Otherwise unchanged.
 */
export function withPicksInResponse<A extends QuestionAnswer>(answer: A): A {
  if (answer.response === undefined) return answer;
  const picks = picksLine(answer);
  if (picks === null) return answer;
  return { ...answer, response: `${picks}\n\n${answer.response}` };
}

/**
 * The user's own reply in a recorded answer — `response` minus the picks
 * `withPicksInResponse` spelled into it (an older record has none).
 */
export function replyOf(answer: QuestionAnswer): string | undefined {
  const { response } = answer;
  if (response === undefined) return undefined;
  const picks = picksLine(answer);
  const prefix = picks === null ? null : `${picks}\n\n`;
  return prefix !== null && response.startsWith(prefix)
    ? response.slice(prefix.length)
    : response;
}
