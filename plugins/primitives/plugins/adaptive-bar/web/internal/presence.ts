/**
 * Does this box draw nothing at all?
 *
 * **The one statement of "absent"** for an occupant's container and for the
 * yielding cell. Absent means no text and no element that makes a box: every
 * element inside is `display: contents`.
 *
 * Not `childElementCount === 0`, which is what this replaced. A widget rendered
 * straight into the bar has no wrapper, so the two agree — but a contribution
 * rendered through a slot arrives inside reorder's list span, `slot-render`'s
 * box and reorder's two item wrappers, all `display: contents` outside edit
 * mode, and they are there whether or not the contribution inside them returned
 * `null`. Counting children saw those four and called every slot occupant
 * present, so an authored `⋯` bucket whose members all declined a row still
 * painted its trigger, and one with a single applicable member could not tell.
 * A `contents` box is exactly a box that draws nothing, so the wrappers need no
 * naming here: any future wrapper of that kind is transparent to this for free.
 */
export function rendersNothing(el: Element): boolean {
  if ((el.textContent ?? "").trim() !== "") return false;
  for (const child of el.querySelectorAll("*")) {
    if (getComputedStyle(child).display !== "contents") return false;
  }
  return true;
}
