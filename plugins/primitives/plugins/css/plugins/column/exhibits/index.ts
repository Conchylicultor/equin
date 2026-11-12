import { columnExhibits } from "./internal/column-exhibits";

// Default-export `Exhibit[]` — the shape codegen collects into the exhibit
// catalog's `exhibits.generated.ts`. JSX lives in `internal/column-exhibits.tsx`.
export default columnExhibits;
