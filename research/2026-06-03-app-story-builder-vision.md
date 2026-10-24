# Story Builder — Vision

## The idea

You have a story to tell — a product launch, a conference talk, a tutorial, a travel log, a pitch. Today you open PowerPoint, or Google Slides, or a blog CMS, and you start *formatting* before you've finished *thinking*. The medium dictates the structure before the story does.

Story Builder inverts this. You write the story first — a nested tree of blocks (text, images, sketches, quotes, whatever fits). The tree *is* the story: its hierarchy captures the narrative arc, the nesting captures detail levels, the ordering captures flow. No slides, no headings, no layout — just the story in its natural shape.

Then you pick a renderer. The same story becomes a slide deck, a long-form blog post, a comic strip, a zine, a video storyboard. Each renderer is a plugin that interprets the story tree through its own lens — what a "section" means, how depth maps to emphasis, where to break pages or scenes.

## Why this matters

Most creative tools conflate *content* and *presentation*. Edit the slides, and you've edited the story. Change formats, and you start over. The story has no independent existence.

Here the story is the artifact. Renderers are views. You can iterate on the narrative in one place and see it update across every format simultaneously. You can share the story and let the recipient pick how they want to consume it.

## Core experience

1. **Author** — A block editor (nested, drag-to-reorder, mixed content types). You organize your narrative as a tree. Flat is fine; deep nesting is fine. The editor doesn't prescribe structure.

2. **Render** — Pick a renderer from the installed set. The renderer reads the story tree and produces its output format. The output is live — edit the story, see the render update.

3. **Extend** — Renderers are plugins. Anyone can write one. A `defineRenderer` contribution point lets a plugin declare: "I turn stories into X." The built-in set might start with slides and blog; the community adds the rest.

## What a renderer sees

A renderer receives the story as a tree of blocks. Each block has:
- Content (rich text, image, embed — whatever the block editor supports)
- Children (sub-blocks, arbitrary depth)
- Position in the tree (order among siblings)

That's it. No renderer-specific annotations on the story. The renderer decides how to interpret structure. A slide renderer might treat top-level blocks as slides and children as bullet points. A blog renderer might treat depth as heading levels. A comic renderer might treat each block as a panel.

## What this is not

- Not a slide editor. You don't drag text boxes around.
- Not a CMS. There's no publish pipeline, no themes, no SEO fields.
- Not an AI writing tool (yet). Generation is a future layer — the story is human-authored first.

## Within equin

Story Builder is an equin app (`/story`). The block editor is a reusable primitive (sidequest or plugin) — it's useful beyond this app. The renderer plugin architecture uses equin's existing slot/contribution system. Stories are persisted in the DB as block trees.

The generation layer (AI helps you refine the story, or generates renderer-specific enhancements) is a future iteration. The interaction model — how the AI and the author collaborate on the narrative — is deliberately left open. The story-as-tree structure gives the AI a natural interface: suggest blocks, reorder sections, expand sparse nodes, collapse verbose ones.
