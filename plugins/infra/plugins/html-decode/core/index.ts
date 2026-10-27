export type { AttributeSource } from "./internal/decode";
export { decodeHtmlText, readHtmlAttr } from "./internal/decode";
export type {
  HtmlEdit,
  ScanHandlers,
  ScannedElement,
  StartTagEditor,
} from "./internal/scan";
export { replaceElementText, rewriteStartTag, scanHtml } from "./internal/scan";
