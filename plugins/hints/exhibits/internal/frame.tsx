import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { HintStage, type StageScene } from "../../web/components/stage";
import { hintsThemeScope } from "../../web/internal/hints-theme";

/**
 * A stage scene framed in place of the viewport, over a stand-in app ground,
 * in the hints' fixed theme — the way the host draws it over every app.
 */
export function StageFrame({
  scene,
  children,
}: {
  scene: StageScene;
  children?: React.ReactNode;
}) {
  return (
    <Theme
      name={hintsThemeScope}
      surface="none"
      className="relative block h-96 bg-background"
    >
      {children}
      <HintStage scene={scene} />
    </Theme>
  );
}
