import { Component, type ReactNode } from "react";
import { findScrollParent } from "./internal/find-scroll-parent";

export interface KeepAnchorAcrossProps {
  /**
   * Changes exactly when a commit may resize content ABOVE what the reader is
   * looking at (rows above the viewport swapped for a placeholder, a
   * placeholder's rows landing). Only a change of this key anchors — every
   * other update costs nothing.
   */
  changeKey: unknown;
  /**
   * The attribute marking an anchor candidate, whose VALUE names it across
   * the commit (content identity — the element itself may be re-created).
   */
  anchorAttr: string;
  /**
   * Candidates carrying this attribute — on themselves or an ancestor inside
   * the region — are a last resort: the anchor is the first visible candidate
   * without it, and one with it only when no other is on screen (a stand-in
   * that is about to be replaced makes a poor anchor, and so does content
   * pinned with `position: sticky`, which does not move when content is
   * inserted above it).
   */
  weakAttr?: string;
  /**
   * Receives the region's box (the anchor candidates are looked up inside
   * it) — for a caller that also measures what the region holds.
   */
  hostRef?: (el: HTMLDivElement | null) => void;
  /**
   * `true`: the region's box takes its parent's full height, so content sized
   * to fill (`h-full` — a full-bleed map) has a definite height to resolve
   * against. Default: the box is as tall as its content.
   */
  fill?: boolean;
  children: ReactNode;
}

interface Anchor {
  scroller: HTMLElement;
  name: string;
  top: number;
}

/**
 * Keeps what the reader is looking at where it is on screen across a commit
 * that resizes content above it — the element the view is anchored by is the
 * first marked one visible in the scroller, and after the commit the scroller
 * is scrolled by however far that element moved. Applied only when
 * `changeKey` says the content may have moved.
 *
 * It is the ONLY anchoring inside its region: the region's box opts out of
 * browser scroll anchoring (`overflow-anchor: none`). Two anchorings acting on
 * one commit pick their anchors independently, and the browser's picks
 * whatever box is on screen — inside a windowed list that is a spacer or a row
 * the window is about to recycle, so it scrolls by how far THAT moved (the
 * height of a page swapped above the reader, measured: a jump of thousands of
 * px) on top of the correction made here.
 *
 * A class for the reason {@link KeepScrollAcross} is one: no hook runs before
 * React's mutations. `getSnapshotBeforeUpdate` finds the anchor and its
 * offset while the old content is still in place; `componentDidUpdate`
 * re-measures it (one forced layout) and scrolls before paint. An anchor gone
 * after the commit (it was replaced) leaves the scroller alone.
 */
export class KeepAnchorAcross extends Component<
  KeepAnchorAcrossProps,
  object,
  Anchor | null
> {
  private host: HTMLDivElement | null = null;

  private readonly setHost = (el: HTMLDivElement | null): void => {
    this.host = el;
    this.props.hostRef?.(el);
  };

  override getSnapshotBeforeUpdate(
    prev: Readonly<KeepAnchorAcrossProps>,
  ): Anchor | null {
    if (Object.is(prev.changeKey, this.props.changeKey)) return null;
    const { anchorAttr, weakAttr } = this.props;
    const container = this.host;
    if (container === null || !container.isConnected) return null;
    const scroller = findScrollParent(container);
    const viewTop =
      scroller === document.scrollingElement
        ? 0
        : scroller.getBoundingClientRect().top;
    let weak: Anchor | null = null;
    for (const el of container.querySelectorAll(`[${anchorAttr}]`)) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= viewTop) continue;
      const anchor = {
        scroller,
        name: el.getAttribute(anchorAttr)!,
        top: rect.top,
      };
      if (weakAttr === undefined || el.closest(`[${weakAttr}]`) === null) {
        return anchor;
      }
      weak ??= anchor;
    }
    return weak;
  }

  override componentDidUpdate(
    _prev: Readonly<KeepAnchorAcrossProps>,
    _state: Readonly<object>,
    snapshot: Anchor | null,
  ): void {
    if (snapshot === null) return;
    const container = this.host;
    if (container === null) return;
    const { anchorAttr } = this.props;
    let el: Element | null = null;
    for (const candidate of container.querySelectorAll(`[${anchorAttr}]`)) {
      if (candidate.getAttribute(anchorAttr) === snapshot.name) {
        el = candidate;
        break;
      }
    }
    if (el === null) return;
    const moved = el.getBoundingClientRect().top - snapshot.top;
    if (moved !== 0) snapshot.scroller.scrollTop += moved;
  }

  override render(): ReactNode {
    return (
      // A plain block box: the region's opt-out of browser scroll anchoring
      // (a `display: contents` box draws nothing for the property to apply to).
      <div
        ref={this.setHost}
        className={this.props.fill ? "h-full" : undefined}
        style={{ overflowAnchor: "none" }}
      >
        {this.props.children}
      </div>
    );
  }
}
