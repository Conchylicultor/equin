import { useState } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  Steps,
  Step,
  StepLink,
  StepDone,
  StepNote,
  StepCommand,
  type StepState,
} from "@plugins/primitives/plugins/setup-steps/web";
import {
  fetchEndpoint,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import {
  BASEMAP_STYLE_JSON,
  BROWSER_KEY_PATTERN,
  MAP_ID_PATTERN,
  clearMapsBrowserConfig,
  clearMapsMapId,
  setMapsBrowserConfig,
  setMapsMapId,
} from "../../core";
import {
  useMapsBrowserConfig,
  type MapsBrowserConfigState,
} from "../internal/use-maps-browser-config";
import {
  useMapIdCheck,
  type MapIdCheck,
} from "../internal/map-rendering-report";

const CONSOLE = "https://console.cloud.google.com";
/** The referrer every local checkout is served from, via the gateway. */
const LOCAL_REFERRER = "http://*.localhost:9000/*";

/**
 * Guided setup for the live map's public browser key (Maps JavaScript API),
 * then the optional vector map's Map ID.
 * Separate from the Places key wizard on purpose: that key is
 * server-only and must never be restricted to referrers, this one must be.
 */
export function LiveMapSetupPane() {
  const config = useMapsBrowserConfig();
  if (config.kind === "loading") {
    return <Loading variant="rows" count={4} className="p-lg max-w-lg" />;
  }
  if (config.kind === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the live map setup state"
        error={config.error}
        refetch={config.refetch}
      />
    );
  }
  return <LiveMapSetupSteps config={config} />;
}

function LiveMapSetupSteps({
  config,
}: {
  config: Exclude<MapsBrowserConfigState, { kind: "loading" | "error" }>;
}) {
  const saved = config.kind === "set";
  // A draft only exists once the user types; until then the inputs show what is
  // stored (the key is public config, so showing it back is fine).
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const keyValue = keyDraft ?? (saved ? config.browserKey : "");
  const trimmedKey = keyValue.trim();
  const keyValid = BROWSER_KEY_PATTERN.test(trimmedKey);
  const dirty = keyDraft !== null;

  const stepState: StepState = saved ? "done" : "active";

  async function handleSave() {
    setSaveError(null);
    try {
      await fetchEndpoint(
        setMapsBrowserConfig,
        {},
        { body: { browserKey: trimmedKey } },
      );
      setKeyDraft(null);
    } catch (err) {
      setSaveError(getEndpointErrorMessage(err));
    }
  }

  async function handleClear() {
    setSaveError(null);
    try {
      await fetchEndpoint(clearMapsBrowserConfig, {});
      setKeyDraft(null);
    } catch (err) {
      setSaveError(getEndpointErrorMessage(err));
    }
  }

  return (
    <Stack gap="xl" className="p-lg max-w-lg">
      <Stack gap="xs">
        {saved ? (
          <StepDone>Browser key saved</StepDone>
        ) : (
          <Text as="p" variant="caption" className="text-muted-foreground">
            No browser key on this machine yet. The live map is drawn in your
            browser by the Maps JavaScript API, which needs its own key — the
            Places key stays on the server and is never sent to a browser.
          </Text>
        )}
      </Stack>

      <Steps>
        <Step title="Enable the Maps JavaScript API" state={stepState}>
          <Stack gap="sm">
            <StepLink
              href={`${CONSOLE}/apis/library/maps-backend.googleapis.com`}
            />
            <StepNote>
              Use the project that already has billing linked — the one holding
              your Places key is fine.
            </StepNote>
          </Stack>
        </Step>

        <Step title="Create a browser key" state={stepState}>
          <Stack gap="sm">
            <StepLink href={`${CONSOLE}/apis/credentials`} />
            <StepNote>
              Create credentials → API key, then edit it. Under Application
              restrictions choose Websites and add this referrer:
            </StepNote>
            <StepCommand text={LOCAL_REFERRER} title="Copy referrer" />
            <StepNote>
              Also add every domain you publish pages on (for example
              https://your-domain/*). Under API restrictions, restrict the key
              to the Maps JavaScript API only. Do not reuse the Places key: it
              cannot carry a referrer restriction, and this key will be visible
              to anyone who can open your pages.
            </StepNote>
          </Stack>
        </Step>

        <Step title="Set a daily quota" state={stepState}>
          <Stack gap="sm">
            <StepLink
              href={`${CONSOLE}/apis/api/maps-backend.googleapis.com/quotas`}
            />
            <StepNote>
              Optional but recommended. A browser key is public by design, so a
              daily cap on map loads bounds what anyone could spend with it.
            </StepNote>
          </Stack>
        </Step>

        <Step title="Paste the key" state={stepState}>
          <Stack gap="sm">
            <Input
              placeholder="AIza…"
              value={keyValue}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            {trimmedKey && !keyValid ? (
              <Text as="p" variant="caption" className="text-destructive">
                Not a Google API key — it should start with AIza and be 39
                characters long.
              </Text>
            ) : null}
            <StepNote>
              Nothing is checked here: a referrer-restricted key can only be
              verified by a real page, so a wrong key shows up as an error on
              the map itself.
            </StepNote>
          </Stack>
        </Step>
      </Steps>

      <Stack gap="sm">
        <Stack direction="row" gap="sm">
          <Button
            variant="default"
            disabled={!keyValid || (saved && !dirty)}
            onClick={handleSave}
          >
            {saved ? "Save changes" : "Save"}
          </Button>
          {saved ? (
            <Button variant="outline" onClick={handleClear}>
              Remove browser key
            </Button>
          ) : null}
        </Stack>
        {saveError ? (
          <Text as="p" variant="caption" className="text-destructive">
            {saveError}
          </Text>
        ) : null}
      </Stack>

      {saved ? <MapIdSetupSteps mapId={config.mapId} /> : null}
    </Stack>
  );
}

/**
 * Optional second part: a Map ID turns every map into Google's vector map,
 * whose zoom glides fractionally like google.com/maps instead of snapping a
 * whole level per wheel burst (research/2026-10-16-map-zoom-smoothness.md).
 * The user makes it in the Console — the app holds no Cloud permission — and
 * only the id is stored.
 */
function MapIdSetupSteps({ mapId }: { mapId: string | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const value = draft ?? mapId ?? "";
  const trimmed = value.trim();
  const valid = MAP_ID_PATTERN.test(trimmed);
  const saved = mapId !== null;
  const stepState: StepState = saved ? "done" : "active";
  // No stored id has no report; "" never gets one.
  const check = useMapIdCheck(mapId ?? "");
  const checkState: StepState = !saved
    ? "upcoming"
    : check.kind === "checked" && check.rendering === "vector"
      ? "done"
      : "active";

  async function handleSave() {
    setSaveError(null);
    try {
      await fetchEndpoint(setMapsMapId, {}, { body: { mapId: trimmed } });
      setDraft(null);
    } catch (err) {
      setSaveError(getEndpointErrorMessage(err));
    }
  }

  async function handleClear() {
    setSaveError(null);
    try {
      await fetchEndpoint(clearMapsMapId, {});
      setDraft(null);
    } catch (err) {
      setSaveError(getEndpointErrorMessage(err));
    }
  }

  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Text as="h3" variant="label">
          Smooth zoom (vector map) — optional
        </Text>
        <Text as="p" variant="caption" className="text-muted-foreground">
          Without a Map ID the map zooms by whole steps. With one it is
          Google&apos;s vector map: zoom glides with the wheel and the trackpad,
          as on google.com/maps. Create both in the same project as the browser
          key.
        </Text>
      </Stack>

      <Steps>
        <Step title="Create the map style" state={stepState}>
          <Stack gap="sm">
            <StepLink href={`${CONSOLE}/google/maps-apis/studio/styles`} />
            <StepNote>
              Create style → JSON → Import, and paste this style (it hides
              Google&apos;s own shops, museums and restaurants, so your places
              are the only pins). Google converts it on import; save it as, for
              example, &ldquo;Singularity basemap&rdquo;. If shops still show,
              turn off Points of interest in the style editor.
            </StepNote>
            <StepCommand text={BASEMAP_STYLE_JSON} title="Copy style JSON" />
          </Stack>
        </Step>

        <Step title="Create the Map ID" state={stepState}>
          <Stack gap="sm">
            <StepLink href={`${CONSOLE}/google/maps-apis/studio/maps`} />
            <StepNote>
              Create map ID → Map type JavaScript → Vector, and leave Tilt and
              Rotation unchecked (pins are drawn flat). Then open the style from
              the previous step and associate it with this Map ID (light mode).
            </StepNote>
          </Stack>
        </Step>

        <Step title="Paste the Map ID" state={stepState}>
          <Stack gap="sm">
            <Input
              placeholder="e.g. 8e0a97af9386fef"
              value={value}
              onChange={(e) => setDraft(e.target.value)}
            />
            {trimmed && !valid ? (
              <Text as="p" variant="caption" className="text-destructive">
                Not a Map ID — copy it from the Map ID&apos;s row in Map
                Management.
              </Text>
            ) : null}
          </Stack>
        </Step>

        <Step title="Check it" state={checkState}>
          {saved ? <MapIdCheckLine check={check} /> : null}
        </Step>
      </Steps>

      <Stack gap="sm">
        <Stack direction="row" gap="sm">
          <Button
            variant="default"
            disabled={!valid || (saved && draft === null)}
            onClick={handleSave}
          >
            {saved ? "Save Map ID" : "Save"}
          </Button>
          {saved ? (
            <Button variant="outline" onClick={handleClear}>
              Remove Map ID
            </Button>
          ) : null}
        </Stack>
        {saveError ? (
          <Text as="p" variant="caption" className="text-destructive">
            {saveError}
          </Text>
        ) : null}
      </Stack>
    </Stack>
  );
}

/** How Google drew the last map opened with this Map ID on this page. */
function MapIdCheckLine({ check }: { check: MapIdCheck }) {
  if (check.kind === "unchecked") {
    return (
      <StepNote>
        Open a map (Places, or a page with a map): this step turns green once
        Google draws it as a vector map.
      </StepNote>
    );
  }
  if (check.rendering === "vector") {
    return <StepDone>Vector map confirmed</StepDone>;
  }
  return (
    <Text as="p" variant="caption" className="text-destructive">
      Google drew this Map ID as a raster map: it must be a JavaScript Map ID of
      type Vector, in the same project as the browser key.
    </Text>
  );
}
