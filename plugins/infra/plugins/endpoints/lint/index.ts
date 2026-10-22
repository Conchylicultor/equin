import fetchEndpointBindingName from "./fetch-endpoint-binding-name";
import noRawEndpointCall from "./no-raw-endpoint-call";
import noRawWebFetch from "./no-raw-web-fetch";
import noVoidFetchEndpoint from "./no-void-fetch-endpoint";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "endpoints",
  rules: {
    "fetch-endpoint-binding-name": fetchEndpointBindingName,
    "no-raw-endpoint-call": noRawEndpointCall,
    "no-raw-web-fetch": noRawWebFetch,
    "no-void-fetch-endpoint": noVoidFetchEndpoint,
  },
} satisfies LintContribution;
