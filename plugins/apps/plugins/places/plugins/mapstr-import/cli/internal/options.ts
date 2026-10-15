/** `import-mapstr`'s flags, as commander hands them over. */
export interface ImportMapstrOptions {
  out?: string;
  refresh?: boolean;
  rescore?: boolean;
  apply?: boolean;
  overrides?: string;
}

/** `search-place`'s flags, as commander hands them over. */
export interface SearchPlaceOptions {
  near?: string;
  lang?: string;
  radius?: string;
}
