import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { declareRenderMode } from "@plugins/primitives/plugins/dom/plugins/render-mode/core/testing";
import {
  testTransport,
  transportWrapper,
} from "@plugins/primitives/plugins/networking/web/testing";
import { ContactReach } from "../components/contact-reach";

// vitest runs each file in its own module registry, so this declaration — once
// per process, by design — reaches no other suite.
declareRenderMode("static");

describe("the contact form in a static render", () => {
  it("writes the form's state, never the confirmation of a message not sent", () => {
    const Wrapper = transportWrapper(testTransport());
    const html = renderToStaticMarkup(
      <Wrapper>
        <ContactReach />
      </Wrapper>,
    );
    expect(html).toContain("Get in touch");
    expect(html).not.toContain("Message sent");
    expect(html).not.toContain("a copy is on its way");
  });
});
