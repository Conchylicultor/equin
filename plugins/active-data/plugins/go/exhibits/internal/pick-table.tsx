import { GoBlock } from "../../web/components/go-block";

const CONTENT = `| Item | Problem | Proposed |
|---|---|---|
| [x] **Themes** | "wear" and "including apps added later" | Each app can have its own theme, from a community gallery or your own. |
| [x] **Live data** | Long | Every screen shows a change as soon as it is written, by you, an agent or a script. |
| [ ] *Plugin-system layer tagline* | "An abstraction above the code" is vague | The app is built from about a thousand small, self-contained pieces. |`;

/** A copy-audit review as a pick table: two rows pre-picked, one declined. */
export default function PickTableExhibit() {
  return <GoBlock content={CONTENT} attrs={{}} />;
}
