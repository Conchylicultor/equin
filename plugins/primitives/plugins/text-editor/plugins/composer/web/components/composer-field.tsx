import {
  ControlSizeProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { insetClass } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  TextEditor,
  type TextEditorProps,
} from "@plugins/primitives/plugins/text-editor/web";
import { AttachFilesButton } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";

/**
 * Every `TextEditor` prop except `bottomSlot`: the composer IS the bottom slot,
 * so there is no spelling for a caller to hand in a second one and silently
 * lose the bar.
 */
export interface ComposerFieldProps extends Omit<
  TextEditorProps,
  "bottomSlot"
> {
  /**
   * Leading half of the bar, after the composer's own "+" (attach files): icon
   * actions and attach toggles (`ComposerAttachButton`), a
   * {@link ComposerRule}, then pills.
   */
  barStart?: React.ReactNode;
  /** Trailing half of the bar, pushed flush right. */
  barEnd?: React.ReactNode;
}

/**
 * The prompt field the Improve and Launch popovers are built from: ONE box
 * holding the prose and the bar of controls that configure
 * what submitting it will do.
 *
 * It is a thin wrapper because `TextEditor` already has the seam it needs —
 * `bottomSlot` renders inside `EditorShell`'s border. So the single border, the
 * focus ring, the placeholder, the markdown⇄Lexical sync, ⌘⏎ submit, the
 * imperative `insertRef` insert and the inline chips all keep working exactly as
 * they do in a bare editor; the composer only decides what sits under the prose.
 *
 * Every composer attaches files: the bar always leads with the "+" picker, and
 * the whole box takes a paste or a drop — so no prompt field can be the one that
 * only accepts images.
 *
 * Every other `TextEditor` prop is forwarded untouched.
 */
export function ComposerField({
  barStart,
  barEnd,
  ...editor
}: ComposerFieldProps) {
  return (
    <TextEditor
      {...editor}
      bottomSlot={
        // One density for everything under the prose, declared once here rather
        // than per control, so a button, a chip and a pill on this bar are the
        // same height under any theme.
        <ControlSizeProvider size="sm">
          {/* The bar owns its icons' tone the way it owns their density:
                every glyph on it — a pill's, an icon button's — sits dimmed
                beside the labels, so one control cannot read brighter than
                its neighbours because it happens to be a different widget. */}
            <Line
              className={cn(
                "gap-xs [&_svg]:opacity-70",
                insetClass({ x: "xs", y: "xs" }),
              )}
            >
              <AttachFilesButton
                disabled={editor.disabled}
                onError={editor.onError}
              />
              {barStart}
              {/* The empty flexible cell: everything after it sits flush
                    right, in its own track rather than floating over the
                    leading half. */}
              <Fill />
              {barEnd}
          </Line>
        </ControlSizeProvider>
      }
    />
  );
}

/**
 * The hairline that separates the bar's icon actions from its pills. Rigid, so
 * a crowded bar never crushes it down to nothing.
 */
export function ComposerRule() {
  return <Rigid aria-hidden className="h-4 w-px bg-border" />;
}
