import type { z } from "zod";
import type { CatalogThemeSchema } from "./resources";

export type CatalogTheme = z.infer<typeof CatalogThemeSchema>;
