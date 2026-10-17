import { useState } from "react";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { PaneScroll } from "@plugins/primitives/plugins/pane/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  Steps,
  Step,
  StepLink,
  StepDone,
  StepNote,
  StepCommand,
  StepActions,
  StepAction,
  StepKey,
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
import { LiveMapSetup, type MapIdPreviewResult } from "../slots";

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

  // The pane body's one scroll viewport: the key steps plus the Map ID steps
  // run past a laptop screen.
  return (
    <PaneScroll>
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
                Use the project that already has billing linked — the one
                holding your Places key is fine.
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
                cannot carry a referrer restriction, and this key will be
                visible to anyone who can open your pages.
              </StepNote>
            </Stack>
          </Step>

          <Step title="Set a daily quota" state={stepState}>
            <Stack gap="sm">
              <StepLink
                href={`${CONSOLE}/apis/api/maps-backend.googleapis.com/quotas`}
              />
              <StepNote>
                Optional but recommended. A browser key is public by design, so
                a daily cap on map loads bounds what anyone could spend with it.
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

        {saved ? (
          <MapIdSetupSteps
            mapId={config.mapId}
            browserKey={config.browserKey}
          />
        ) : null}
      </Stack>
    </PaneScroll>
  );
}

/** The preview map's height: tall enough to read a street of shops, short enough to sit in a step. */
const PREVIEW_HEIGHT = "h-72";

/**
 * Optional second part: a Map ID turns every map into Google's vector map,
 * whose zoom glides fractionally like google.com/maps instead of snapping a
 * whole level per wheel burst (research/2026-10-16-map-zoom-smoothness.md).
 * The user makes it in the Console — the app holds no Cloud permission — and
 * only the id is stored.
 *
 * The steps run in the order the Console needs, so nothing goes back: the Map
 * ID first, then the style, which is associated with the Map ID last. A live
 * preview map (drawn by the map renderer, through `LiveMapSetup.MapIdPreview`)
 * checks the Map ID the moment it is valid, with no other map to open.
 */
function MapIdSetupSteps({
  mapId,
  browserKey,
}: {
  mapId: string | null;
  browserKey: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Bumped by "Check again": a new key remounts the preview, a new map.
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    id: string;
    result: MapIdPreviewResult;
  } | null>(null);

  const value = draft ?? mapId ?? "";
  const trimmed = value.trim();
  const valid = MAP_ID_PATTERN.test(trimmed);
  const saved = mapId !== null;
  // What the preview draws: the id being typed once it is a valid one, else
  // the saved one — so a typo never blanks the map.
  const previewMapId = valid ? trimmed : mapId;
  const previewId = previewMapId === null ? null : `${previewMapId}:${attempt}`;
  const outcome =
    previewId !== null && result?.id === previewId ? result.result : null;
  const isSavedPreview = previewMapId === mapId;
  const vector = saved && isSavedPreview && outcome?.kind === "vector";

  const createState: StepState = saved ? "done" : "active";
  const pasteState: StepState = vector ? "done" : "active";
  const styleState: StepState = !saved ? "upcoming" : "active";

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
        <Text as="p">
          Without a Map ID the map zooms by whole steps. With one it is
          Google&apos;s vector map: zoom glides with the wheel and the trackpad,
          as on google.com/maps. Do these three steps in order, in the same
          project as the browser key.
        </Text>
      </Stack>

      <Steps>
        <Step title="Create the Map ID" state={createState}>
          <Stack gap="sm">
            <StepLink href={`${CONSOLE}/google/maps-apis/studio/maps`} />
            <StepActions>
              <StepAction>
                Click <StepKey>Create map ID</StepKey>, and give it any name.
              </StepAction>
              <StepAction>
                Set <StepKey>Map type</StepKey> to <StepKey>JavaScript</StepKey>
                .
              </StepAction>
              <StepAction>
                Choose <StepKey>Vector</StepKey>.
              </StepAction>
              <StepAction>
                Leave <StepKey>Tilt</StepKey> and <StepKey>Rotation</StepKey>{" "}
                <StepKey>unchecked</StepKey> (the pins are drawn flat).
              </StepAction>
              <StepAction>
                Save, then copy the <StepKey>Map ID</StepKey> from its row.
              </StepAction>
            </StepActions>
          </Stack>
        </Step>

        <Step title="Paste the Map ID" state={pasteState}>
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
            {previewMapId === null ? (
              <StepNote>
                Once you paste a Map ID, a map appears here and checks it.
              </StepNote>
            ) : (
              <MapIdPreviewPanel
                key={previewId}
                browserKey={browserKey}
                mapId={previewMapId}
                outcome={outcome}
                onResult={(r) => setResult({ id: previewId!, result: r })}
                onCheckAgain={() => setAttempt((n) => n + 1)}
              />
            )}
          </Stack>
        </Step>

        <Step title="Hide Google's places" state={styleState}>
          <Stack gap="sm">
            <StepLink href={`${CONSOLE}/google/maps-apis/studio/styles`} />
            <StepActions>
              <StepAction>
                Click <StepKey>Create style</StepKey>, open its{" "}
                <StepKey>JSON</StepKey> tab and choose <StepKey>Import</StepKey>
                .
              </StepAction>
              <StepAction
                detail={
                  <StepCommand
                    text={BASEMAP_STYLE_JSON}
                    title="Copy style JSON"
                  />
                }
              >
                Paste this style, then save it with any name:
              </StepAction>
              <StepAction>
                In the style, open <StepKey>Map IDs</StepKey> (or in the Map ID,{" "}
                <StepKey>Map style</StepKey>) and{" "}
                <StepKey>associate the style with the Map ID</StepKey> from step
                1, for light mode.
              </StepAction>
              <StepAction>
                Wait for the map above to drop the shops and museums, then press{" "}
                <StepKey>Check again</StepKey>.
              </StepAction>
            </StepActions>
            <StepNote>
              Nothing here can detect hidden places automatically: look at the
              map above. Google can take a few minutes to serve a changed style.
              If shops still show, turn off Points of interest in the style
              editor.
            </StepNote>
          </Stack>
        </Step>
      </Steps>
    </Stack>
  );
}

/**
 * The preview map and what it found. Keyed by the previewed Map ID and the
 * attempt, so each check is a new map instance (Google fixes a Map ID at map
 * creation).
 */
function MapIdPreviewPanel({
  browserKey,
  mapId,
  outcome,
  onResult,
  onCheckAgain,
}: {
  browserKey: string;
  mapId: string;
  outcome: MapIdPreviewResult | null;
  onResult: (result: MapIdPreviewResult) => void;
  onCheckAgain: () => void;
}) {
  return (
    <Stack gap="sm">
      <Clip className={`${PREVIEW_HEIGHT} w-full rounded-md border`}>
        <LiveMapSetup.MapIdPreview.Dispatch
          browserKey={browserKey}
          mapId={mapId}
          onResult={onResult}
        />
      </Clip>
      <Stack direction="row" align="center" gap="sm">
        <Button variant="outline" onClick={onCheckAgain}>
          Check again
        </Button>
        <PreviewStatus outcome={outcome} />
      </Stack>
      <StepNote>
        Google can take a few minutes to serve a changed Map ID or style: press
        Check again to draw a fresh map.
      </StepNote>
    </Stack>
  );
}

function PreviewStatus({ outcome }: { outcome: MapIdPreviewResult | null }) {
  if (outcome === null) {
    return (
      <Text as="span" variant="caption" tone="muted">
        Checking…
      </Text>
    );
  }
  switch (outcome.kind) {
    case "vector":
      return <StepDone>Vector map ✓</StepDone>;
    case "raster":
      return (
        <Text as="span" variant="caption" className="text-destructive">
          Raster — this Map ID must be JavaScript → Vector.
        </Text>
      );
    case "error":
      return (
        <Text as="span" variant="caption" className="text-destructive">
          The map could not load: {outcome.message}
        </Text>
      );
  }
}
