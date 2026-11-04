import { defineFacet } from "@plugins/plugin-meta/plugins/facets/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

export interface TableDef {
  name: string;
  varName: string;
}

export interface EntityExtension {
  parentPlugin: PluginId;
  extName: string;
  tableName: string;
}

export interface EntityExtensionRef {
  childPlugin: PluginId;
  extName: string;
  tableName: string;
}

export interface DbSchemaFacetData {
  /** Repo-relative paths of the plugin's schema files. */
  dbFiles: string[];
  tables: TableDef[];
  entityExtensions: EntityExtension[];
  extendedBy: EntityExtensionRef[];
  /**
   * What `relate` resolves across plugins, read in `extract` from this plugin's
   * own files: its entity refs, its schema files' table declarations and its
   * `defineExtension` calls. Cleared by `relate`.
   */
  raw?: {
    refNames: [string, string][];
    decls: {
      tables: [string, string][];
      entities: [string, string][];
      aliases: [string, string][];
    }[];
    extensions: {
      parentVarName: string;
      parentModule: string;
      extName: string;
    }[];
  };
}

/** Identifying shape of one row in the db-schema Contributions table, shared
 *  between the meta table projection and the app-side table-detail drill-down. */
export interface DbSchemaTableRow {
  pluginId: string;
  name: string;
  varName: string;
}

export const dbSchemaFacetDef = defineFacet<DbSchemaFacetData>("db-schema");
