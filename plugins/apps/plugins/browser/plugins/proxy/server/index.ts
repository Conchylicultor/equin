import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { handleProxy } from "./internal/handle-proxy";
import {
  browserProxyEndpoint,
  browserProxyPostEndpoint,
} from "../shared/endpoints";

export default {
  description:
    "Framing-stripping browser proxy: fetches the target server-side (SSRF-guarded, anonymous), strips X-Frame-Options/CSP and credential headers, and rewrites HTML to inject a <base> + nav-interception script so framing-blocked sites render in the in-app browser.",
  httpRoutes: {
    [browserProxyEndpoint.route]: handleProxy,
    [browserProxyPostEndpoint.route]: rawEndpointHandler(
      browserProxyPostEndpoint,
      handleProxy,
    ),
  },
} satisfies ServerPluginDefinition;
