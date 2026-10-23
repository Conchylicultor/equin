import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { HintCard } from "../../web/components/hint-card";
import { WelcomePanel } from "../../web/components/centered-card";

const noop = () => {};

/** The tour's welcome card on its full scrim, framed in place of the viewport. */
export default function WelcomeExhibit() {
  return (
    <Center className="h-96 bg-black/45">
      <WelcomePanel>
        <HintCard
          title="Welcome to equin"
          body="An app that improves itself. Ask for a change anywhere, and an agent builds it while you keep working."
          onClose={noop}
          alt={{ label: "I'll explore on my own", onClick: noop }}
          primary={{ label: "Show me around", onClick: noop }}
        />
      </WelcomePanel>
    </Center>
  );
}
