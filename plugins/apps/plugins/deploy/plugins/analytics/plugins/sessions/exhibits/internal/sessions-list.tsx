import { useState, type ReactNode } from "react";
import { SessionsList } from "../../web/components/sessions-section";
import { sessionRowOf } from "../../core";
import { fixtureSessions } from "./fixture";

/** The Sessions list on made-up visits: its views and filters run in memory over them. */
export default function SessionsListExhibit(): ReactNode {
  // Made up once, relative to the moment the exhibit opens.
  const [rows] = useState(() =>
    fixtureSessions(Date.now()).map((s) => sessionRowOf("exhibit", s)),
  );
  return <SessionsList host={{ kind: "fixture", rows }} />;
}
