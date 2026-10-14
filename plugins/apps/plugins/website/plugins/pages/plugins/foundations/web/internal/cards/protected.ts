import { defineCard } from "../kit/types";
import "./protected.css";

const line = (t: string) => `<span class="pt-l">${t}</span>`;
const card = (cls: string, name: string, body: string) =>
  `<span class="pt-card ${cls}"><span class="pt-name">${name}</span>${body}</span>`;
const page = (title: string, body: string, who: string, cls = "") =>
  `<span class="pt-col"><span class="k-panel pt-pg ${cls}"><span class="pt-ttl">${title}</span>${body}</span><span class="pt-who">${who}</span></span>`;

/**
 * Protected blocks: two pages drawn the way the Pages app draws them. On your
 * page, the agent writes only inside its blue "Agent note" card. On a page
 * agents research for you, your grey "User note" card (a preference) is the one
 * part they cannot change.
 * Static: the tints are the whole picture.
 */
export const protectedCard = defineCard({
  render: () =>
    `<span class="k-html pt">` +
    page(
      "Trip to Lisbon",
      line("Fly out on May 3.") +
        line("4 nights in Alfama.") +
        card(
          "pt-agent",
          "Agent note",
          line("Ideas: Graça viewpoint, LX Factory."),
        ),
      "<b>Your page.</b> The agent can only add its notes.",
    ) +
    page(
      "Where to eat",
      line("Time Out Market") +
        line("Tasca do Chico, for fado") +
        card("pt-human", "User note", line("No seafood for me.")),
      "<b>A page agents research.</b> Your note stays yours.",
      "pt-agentpage",
    ) +
    `</span>`,
});
