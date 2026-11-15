import { swipeCompareExhibits } from "./internal/swipe-compare-exhibits";

// Default-export `Exhibit[]` — the shape codegen collects into the exhibit
// catalog's `exhibits.generated.ts`. JSX lives in `internal/swipe-compare-exhibits.tsx`.
export default swipeCompareExhibits;
