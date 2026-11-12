export {
  InAppTabSchema,
  MAX_IN_APP_TABS,
  submitTabMemorySample,
  TAB_MEMORY_FIRST_SAMPLE_MS,
  TAB_MEMORY_SAMPLE_EVERY_MS,
  TabMemorySampleSchema,
  type InAppTab,
  type TabMemorySample,
} from "./internal/sample";
export {
  MAX_PAGE_POINTS,
  MAX_PAGES,
  MAX_RENDERER_POINTS,
  MAX_RENDERERS,
  RENDERER_BUCKET_MS,
  TAB_MEMORY_WINDOW_MS,
  tabMemorySeries,
  TabMemoryDataSchema,
  type PagePoint,
  type PageSeries,
  type RendererSeries,
  type TabMemoryData,
} from "./internal/series";
export { jsHeapGrowthMbPerHour } from "./internal/growth";
