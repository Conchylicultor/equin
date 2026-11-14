import type { ReactNode, RefObject } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  cn,
  Sheet,
  SheetContent,
  SheetTitle,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * A sub-action's sheet: rises from the bottom edge over a scrim (a tap on it
 * closes the sheet), its top corners rounded, a grabber on top, then the
 * action's own body. ui-kit's `Sheet` at `side="bottom"`, sliding the whole
 * way in rather than its default short fade.
 */
export function BottomSheet({
  title,
  open,
  onClose,
  finalFocus,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  /** Where focus goes when the sheet closes. */
  finalFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        finalFocus={finalFocus}
        className="max-h-[82%] gap-none rounded-t-3xl border-t-0 px-lg pt-sm pb-xl duration-300 ease-[cubic-bezier(.2,.8,.2,1)] data-[side=bottom]:data-ending-style:translate-y-[105%] data-[side=bottom]:data-starting-style:translate-y-[105%] data-ending-style:opacity-100 data-starting-style:opacity-100"
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <Stack gap="lg">
          <Center>
            <div
              aria-hidden
              className={cn(
                rigidClass(),
                "h-[5px] w-[38px] rounded-full bg-border",
              )}
            />
          </Center>
          {children}
        </Stack>
      </SheetContent>
    </Sheet>
  );
}
