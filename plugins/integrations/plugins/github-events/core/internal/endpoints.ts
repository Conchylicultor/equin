import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Where the `gh webhook forward` forwarders post GitHub's deliveries. A
 * delivery comes in through the gateway carrying `x-forwarded-*` headers, so
 * the gateway stamps it a visitor, never the owner: the route is public, and
 * its authentication is the delivery's `X-Hub-Signature-256` — an HMAC of the
 * raw body with the secret of the forwarder's current start, verified before
 * anything of the body is read.
 */
export const githubDeliveryEndpoint = defineEndpoint({
  route: "POST /api/github-events/deliveries",
  access: {
    public:
      "GitHub webhook deliveries, authenticated by their HMAC signature (X-Hub-Signature-256 over the raw body, keyed by the forwarder's per-start secret)",
  },
  internal: {
    why: "the gh webhook forwarder posts GitHub's deliveries; no browser sends one",
  },
  needsMachine: { feature: "GitHub events" },
});
