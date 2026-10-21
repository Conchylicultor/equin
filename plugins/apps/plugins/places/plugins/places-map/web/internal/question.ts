/** Words that make a query a question for Sonnet rather than a name to look up. */
const QUESTION_WORDS =
  /\b(open|near|with|for|cheap|cheaper|best|good|tonight|today|tomorrow|late|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|kids?)\b/i;

/**
 * Whether a query reads like a question ("chinese restaurant open tuesday")
 * rather than a place's name ("Chez Li") — then Ask Sonnet leads the panel
 * and Enter asks. Three words or more, or a word only a question has.
 */
export function looksLikeQuestion(query: string): boolean {
  const q = query.trim();
  if (q === "") return false;
  return q.split(/\s+/).length >= 3 || QUESTION_WORDS.test(q);
}
