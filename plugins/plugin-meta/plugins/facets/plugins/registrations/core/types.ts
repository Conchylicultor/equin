import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";
import type { DocMeta } from "@plugins/framework/plugins/web-sdk/core";

export interface DocMetaRegistration {
  kind: string;
  factory?: string;
  runtime: "server" | "machine" | "central";
  doc: DocMeta;
}

export const registrationsFacetDef = defineFacet<DocMetaRegistration[]>("registrations");
