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

/** An inline host's own props: a span's, without anything React could render inside it. */
export type InlineAnimationHostProps = Omit<
  ComponentPropsWithRef<"span">,
  "children" | "dangerouslySetInnerHTML"
>;

/**
 * {@link AnimationHost} as a span, for where only phrasing content may stand
 * (inside a `<button>`: the foundations page's pieces mount their live
 * drawings into one). The same rule: React renders the empty box, the script
 * builds and animates everything inside it.
 */
export function InlineAnimationHost(props: InlineAnimationHostProps) {
  return <span {...props} {...{ [ANIMATION_HOST_ATTR]: "" }} />;
}

/** A foreign renderer's host props: a div's, children included. */
export type ForeignDomHostProps = ComponentPropsWithRef<"div">;

/**
 * The element a third-party library renders into imperatively while React
 * also renders children of its own inside (a Google map: Google builds and
 * rewrites its tiles, controls and panes on every camera move; our pins and
 * controls are React portals among them). The library's writes are its
 * rendering, not a re-render loop, so the detector skips every node React
 * does not own — the same rule as {@link AnimationHost} — while the React
 * nodes inside stay watched: a component re-rendering in a loop there still
 * files. Unlike an animation host it takes children, since the library's own
 * React bindings (vis.gl's `<Map>`) are rendered inside it.
 */
export function ForeignDomHost(props: ForeignDomHostProps) {
  return <div {...props} {...{ [ANIMATION_HOST_ATTR]: "" }} />;
}
