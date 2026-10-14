import { defineCard } from "../kit/types";
import "./richtext.css";

/**
 * Rich text editor: a page whose text holds blocks other apps added — a live task, a song, a map.
 * States: 0 the finished page (rest) · 1 text only · 2 + the task · 3 + the song. The blocks arrive one by one.
 */
export const richtextCard = defineCard({
  states: 4,
  autoplay: { seq: [1, 2, 3, 0], every: [900, 900, 900, 4200] },
  render: (k) => {
    const notes = [6, 10, 8, 13, 7, 11, 9, 5, 12, 8]
      .map((h) => `<i style="height:${h}px"></i>`)
      .join("");
    return (
      `<span class="k-html k-panel rt">` +
      `<span class="rt-h">Trip to Lisbon</span>` +
      k.bar(94) +
      k.bar(72) +
      `<span class="rt-blk" data-in="0 2 3"><b>Book the hotel</b><span class="rt-st">In progress</span><span class="rt-tag">task</span></span>` +
      k.bar(60) +
      `<span class="rt-blk" data-in="0 3"><span class="rt-play"></span><b>Fado</b><span class="rt-notes">${notes}</span><span class="rt-tag">song</span></span>` +
      `<span class="rt-blk rt-map-row" data-in="0"><span class="rt-map"><span class="rt-pin" style="left:22%;top:12px"></span><span class="rt-pin" style="left:51%;top:5px"></span><span class="rt-pin" style="left:76%;top:15px"></span></span><span class="rt-tag" style="align-self:center">map</span></span>` +
      `</span>`
    );
  },
});
