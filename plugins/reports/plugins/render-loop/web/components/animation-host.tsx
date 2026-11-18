import type { ComponentPropsWithRef } from "react";
import { ANIMATION_HOST_ATTR } from "../../core";

/** A host's own props: a div's, without anything React could render inside it. */
export type AnimationHostProps = Omit<
  ComponentPropsWithRef<"div">,
  "children" | "dangerouslySetInnerHTML"
>;

/**
 * The element an imperative animation draws into (a rAF loop writing an SVG
 * scene, a scripted figure building its own rows): its descendants' writes are
 * the animation's frames, not a render loop, so the detector does not count
 * them. It takes no children: React renders the empty box, and everything inside
 * it is the animation's — a React-rendered node inside a host would still be
 * watched (a real re-render loop there must fire), so the animation writing into
 * one reads as a loop. The script builds its skeleton itself, from mount on.
 */
export function AnimationHost(props: AnimationHostProps) {
  return <div {...props} {...{ [ANIMATION_HOST_ATTR]: "" }} />;
}
