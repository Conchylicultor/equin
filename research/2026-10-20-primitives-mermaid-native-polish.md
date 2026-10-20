# Native Mermaid diagrams: match the mockup (proto-1792499588-rr4kzl)

## Context

The native sequence/flowchart renderers (`code-preview/plugins/mermaid/web/internal/{sequence,flowchart}`)
were built from proto-1792499588-rr4kzl but draw noticeably worse: patchy pills on the grey fence frame,
muddy hues, letter badges and text-only nodes, edges kinked through dagre's label nodes, sparse styling,
and no exhibit to compare against. The prototype already is the target design, so no new mockup — the
work is to close the gap and prove it with `compare-diff`.

## Design

1. **One surface, owned by the diagram.** `MermaidPreview` wraps native diagrams in a *stage*
   (`.mmd-stage`): a rounded, bordered panel inset in the fence frame, painted `--mmd-surface`
   (= `--background`). Every pill, note, block fill and label reads `--mmd-surface` — never
   `--background` directly — so a pill cannot differ from what it sits on. Cards (`--card`) sit on the
   stage with the prototype's per-scheme shadow (`--mmd-shadow`), giving the depth back.
2. **Per-scheme hues.** `participantHue(i)` returns `oklch(var(--mmd-l) var(--mmd-c) <hue>)`; the stage
   sets `--mmd-l/--mmd-c` to the prototype's light values (0.58 / 0.16) and `.dark` overrides them
   (0.74 / 0.13). No mixing toward foreground. Hue table = the prototype's (250, 295, 165, 70, 15, …).
3. **Iconic nodes.** `web/internal/icons.ts`: `iconFor(label, fallback)` — a keyword table (cli/terminal,
   sdk/agent/process, server/backend, queue/inbox/relay, web/browser/ui, db/database/store, file/folder,
   markdown/doc, chat/conversation, user/person, api, auth/key, mail, cloud, page/block, plugin/registry…)
   to Material Symbols literals; fallback per role (participant box, actor person, flowchart shape).
   Participant badge = icon. Flowchart card nodes (rect/round/stadium/subroutine) become the mockup's
   card: icon badge + title (first label line) + mono subtitle (remaining lines), `min-width: 200px`.
   Other shapes keep their outline with the same title/sub text.
4. **Emphasis is authored.** The parser keeps a node's Mermaid classes (`:::cls`, `class A,B cls`) as
   `FlowNode.classes`; a node with any class is drawn as the key node (accent border, tinted bg, accent
   badge). No hub heuristic.
5. **Clean edges.** Labels no longer go to dagre (no label dummy, no kink). Rank gap grows to fit the
   tallest (TB/BT) or widest (LR/RL) label. Paths: endpoints snap to the facing port (bottom-centre →
   top-centre along the rank axis), interior dagre points are simplified away unless dropping them makes
   the chord cross another node, and each remaining hop is a cubic with rank-axis tangents (the
   prototype's curve). Labels sit on the path at 50 % of its length (straight) or 70 % (forking), computed
   by sampling the beziers in `layout.ts` (tested).
6. **Spacing / shadow** from the prototype: actor padding 8/12/8/8, 30px badge, node padding 12/16/12/12,
   34px badge, nodesep 28, rank gap ≥ 76 when labelled.
7. **Exhibit + compare.** `exhibits/index.ts` → `appExhibit("mermaid/native-diagrams")` rendering the
   prototype's two diagrams as mermaid fences through the real `<Markdown>`. Add
   `<meta name="mocks" content="exhibit:mermaid/native-diagrams">` to the prototype and run
   `compare-diff` light + dark.

## Files

- `mermaid/core/internal/{model,parse-flowchart}.ts` (+ `parse.test.ts`): `classes`.
- `mermaid/web/internal/{hues,icons}.ts`, `mermaid-preview-impl.tsx`, `stage.css`.
- `mermaid/web/internal/sequence/*`, `flowchart/*` (layout.ts + `layout.test.ts`).
- `mermaid/exhibits/` ; prototype meta.

## Verification

`./singularity test` on the plugin; `./singularity build`; exhibit-shot + compare-diff vs the prototype
in both schemes; spot-check a conversation fence via `browser_*`.
