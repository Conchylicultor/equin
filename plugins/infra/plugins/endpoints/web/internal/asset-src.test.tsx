import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TransportProvider } from "@plugins/primitives/plugins/networking/web";
import { testTransport } from "@plugins/primitives/plugins/networking/web/testing";
import { assetPath, blob, defineEndpoint } from "../../core";
import { useAssetSrc } from "./asset-src";

const getFile = defineEndpoint({
  route: "GET /api/asset-src-test/:id",
  response: blob(),
});

function Probe() {
  const src = useAssetSrc(assetPath(getFile, { id: "a" }));
  return <i>{src.kind === "ready" ? src.src : src.kind}</i>;
}

// A static render to HTML (react-dom/server, no DOM) reads the blob store's
// snapshot as it stands: it must not throw.
describe("useAssetSrc under a server render", () => {
  it("answers the path itself on a transport that serves URLs", () => {
    const html = renderToStaticMarkup(
      <TransportProvider transport={testTransport()}>
        <Probe />
      </TransportProvider>,
    );
    expect(html).toBe("<i>/api/asset-src-test/a</i>");
  });

  it("answers loading from the blob store on one that does not", () => {
    const html = renderToStaticMarkup(
      <TransportProvider transport={testTransport({ servesUrls: false })}>
        <Probe />
      </TransportProvider>,
    );
    expect(html).toBe("<i>loading</i>");
  });
});
