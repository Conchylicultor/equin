import { defineCard } from "../kit/types";

/** A plugin: one card holding its client code and its server code, each a card of its own. Static. */
export const pluginCard = defineCard({
  render: (k) => {
    const part = (
      x: number,
      title: string,
      sub: string,
      lines: readonly (readonly [number, number])[],
    ) =>
      k.box(x, 42, 116, 86, { title, sub, align: "start" }) +
      k.codeLines(x + 12, 84, lines, 7.5);
    return k.svg(
      148,
      k.plugin(16, 8, 270, 132) +
        part(30, "Client", "runs in your browser", [
          [0, 52],
          [7, 72],
          [7, 45],
          [14, 34],
          [0, 24],
          [0, 59],
        ]) +
        part(156, "Server", "runs on the server", [
          [0, 62],
          [7, 42],
          [14, 59],
          [7, 37],
          [0, 25],
          [0, 49],
        ]),
    );
  },
});
