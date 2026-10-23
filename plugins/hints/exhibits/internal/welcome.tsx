import { symbol } from "@plugins/ui/plugins/icons/core";
import { WelcomeCard } from "../../web/components/hint-card";
import { EMPTY_SCENE } from "../../web/components/stage";
import { StageFrame } from "./frame";

const noop = () => {};

/** The tour's welcome card on its full scrim, framed in place of the viewport. */
export default function WelcomeExhibit() {
  return (
    <StageFrame
      scene={{
        ...EMPTY_SCENE,
        spot: { mode: "cover" },
        welcome: (
          <WelcomeCard
            icon={symbol("all-inclusive")}
            title="Welcome to equin"
            body="An app that builds itself. You say what you want; agents build it in the background while you keep working."
            note="A few quick stops · about a minute"
            start={{ label: "Show me around", onClick: noop }}
            skip={{ label: "I'll explore on my own", onClick: noop }}
          />
        ),
      }}
    />
  );
}
