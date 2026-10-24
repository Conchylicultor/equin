// The lister's implementation moved to `shared/list-metas.ts` so
// `./equin prototype list` can read the tree with no backend running (a
// CLI process cannot import this barrel's boot-time machinery). Nothing in it
// was server-specific.
//
// This file stays as the server's spelling of it: `handlers.ts`, `resources.ts`
// and the server barrel — which `thumbnails` reads `listPrototypeMetas` from —
// all keep importing `./list`, so the move costs no call site and the exported
// API is unchanged.
export {
  listPrototypeMetas,
  readPrototypeTitle,
} from "../../shared/list-metas";
