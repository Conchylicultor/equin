/**
 * FxViewSection — the piano roll's visual effects, as its own block of the
 * player's View options panel (a `Sonata.ViewSection` scoped to the roll).
 *
 * Lists every PianoRollFx contribution grouped by tier ("Ambient" first —
 * the always-tasteful defaults — then the opt-in "Fancy" spectacle), each a
 * control-panel row whose switch is wired to the effect's own `{ enabled }`
 * config via useConfig/useSetConfig. Collection-consumer clean: only generic
 * slot fields are read, so every new fx plugin auto-appears here with zero edits.
 *
 * Each row is its own component so the config hooks stay stable per component
 * (the contribution list length never changes a component's hook count).
 */
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { PianoRollFx } from "../slots";
import { Icon } from "@plugins/ui/plugins/icons/web";

type FxItem = ReturnType<typeof PianoRollFx.useContributions>[number];

export function FxViewSection() {
  const effects = PianoRollFx.useContributions();
  if (effects.length === 0) return null;

  const ambient = effects.filter((e) => e.tier === "ambient");
  const fancy = effects.filter((e) => e.tier === "fancy");

  // The panel owns its own inset and the hairline between the two tiers; this
  // file draws neither.
  return (
    <>
      {ambient.length > 0 ? (
        <FxTierSection label="Effects · Ambient" effects={ambient} />
      ) : null}
      {fancy.length > 0 ? (
        <FxTierSection label="Effects · Fancy" effects={fancy} />
      ) : null}
    </>
  );
}

function FxTierSection({
  label,
  effects,
}: {
  label: string;
  effects: FxItem[];
}) {
  return (
    <ControlPanel.Section label={label}>
      {effects.map((e) => (
        <FxToggleRow key={e.id} effect={e} />
      ))}
    </ControlPanel.Section>
  );
}

function FxToggleRow({ effect }: { effect: FxItem }) {
  const { enabled } = useConfig(effect.config);
  const setConfig = useSetConfig(effect.config);
  const icon = effect.icon;
  return (
    // `select="switch"` IS the row's on/off language — the switch owns the
    // trailing cell and the row itself is the control, so the hand-rolled track
    // and knob (two nested spans) are gone. The effect's glyph takes the `icon`
    // slot: a switch row's leading cell is free (its indicator is trailing),
    // which is why the row type lets THAT selection language carry one.
    <ControlPanel.Row
      select="switch"
      checked={enabled}
      icon={icon ? <Icon icon={icon} /> : undefined}
      onSelect={() => setConfig("enabled", !enabled)}
    >
      {effect.label}
    </ControlPanel.Row>
  );
}
