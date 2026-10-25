import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Overlay } from "@plugins/primitives/plugins/css/plugins/overlay/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  Browser,
  useBrowserNav,
} from "@plugins/apps/plugins/browser/plugins/shell/web";
import { useSurfaceShortcuts } from "@plugins/primitives/plugins/shortcuts/web";
import { normalizeInput } from "../normalize";
import { FOCUS_ADDRESS_KEYS } from "../focus-keys";
import { SiteInfoButton } from "./site-info";
import "./omnibox.css";

const searchIcon = symbol("search");

/**
 * The address bar: Chrome's pill. A leading site-info button (the start page
 * shows a search glyph instead), the address, and the contributed in-field
 * actions (`Browser.OmniboxAction`, e.g. the bookmark star). Enter normalizes
 * the input and navigates (or goes home on empty).
 *
 * The input's draft state is owned by a self-keyed inner component
 * ({@link OmniboxInput}) keyed on `current`: whenever the active URL changes
 * (back/forward/home/link nav), the inner component remounts and re-seeds its
 * `useState` from the new URL — replacing the old "mirror prop into state via
 * effect" pattern. The remount discards any in-progress typed text, which is
 * the intended behavior (the address bar should reflect the live URL).
 */
export function Omnibox() {
  const { current, navigate, goHome } = useBrowserNav();
  return (
    <OmniboxInput
      key={current}
      current={current}
      navigate={navigate}
      goHome={goHome}
    />
  );
}

/** Split a URL into what the pill shows strong (the host, sans `www.`) and faint (the rest). */
function displayParts(url: string): { host: string; rest: string } | null {
  try {
    const u = new URL(url);
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
    return { host: u.host.replace(/^www\./, ""), rest };
  } catch (err) {
    if (err instanceof TypeError) return null; // not a URL — show it raw
    throw err;
  }
}

function OmniboxInput({
  current,
  navigate,
  goHome,
}: {
  current: string;
  navigate: (url: string) => void;
  goHome: () => void;
}) {
  const [value, setValue] = useState(current);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shortcuts = useMemo(
    () => [
      {
        id: "browser.focus-address",
        keys: FOCUS_ADDRESS_KEYS,
        label: "Focus the address bar",
        handler: () => inputRef.current?.focus(),
      },
    ],
    [],
  );
  useSurfaceShortcuts(shortcuts);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    inputRef.current?.blur();
    const result = normalizeInput(value);
    if (result.kind === "home") {
      goHome();
    } else {
      navigate(result.url);
    }
  };

  // While unfocused and untouched, the pill shows the address formatted (host
  // strong, path faint) over the input, whose own text is masked; focusing
  // hands the plain, fully-selected text back for editing.
  const parts =
    !focused && value === current && current ? displayParts(current) : null;

  return (
    <ControlSizeProvider size="xs">
      <Line
        as="form"
        onSubmit={submit}
        className={cn("browser-omnibox w-full", focused && "is-focused")}
      >
        <span className={rigidClass()}>
          {current ? (
            <SiteInfoButton url={current} />
          ) : (
            <Center className="browser-omnibox-glyph">
              <Icon icon={searchIcon} className="size-[15px]" aria-hidden />
            </Center>
          )}
        </span>
        <Fill>
          <Overlay
            above={
              parts ? (
                <Center axis="vertical" className="h-full">
                  <Text variant="body" className="browser-omnibox-address">
                    <span className="text-foreground">{parts.host}</span>
                    <span className="text-faint-foreground">{parts.rest}</span>
                  </Text>
                </Center>
              ) : undefined
            }
          >
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={(e) => {
                setFocused(true);
                e.currentTarget.select();
              }}
              onBlur={() => {
                setFocused(false);
                setValue(current);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
              }}
              placeholder="Search or enter address"
              aria-label="Address bar"
              autoComplete="off"
              spellCheck={false}
              className={cn(
                "browser-omnibox-input browser-omnibox-address text-body w-full",
                parts && "is-masked",
              )}
            />
          </Overlay>
        </Fill>
        {current && (
          <span className={rigidClass()}>
            <Browser.OmniboxAction.Render />
          </span>
        )}
      </Line>
    </ControlSizeProvider>
  );
}
