# UI Mastery — Making agents produce professional UI

## Problem

LLM agents produce functional but generic UI. They default to component library defaults, grayscale palettes, uniform spacing, and zero craft. The result is "developer template" quality — works fine, looks forgettable.

Deeper problem: LLMs are primarily trained on text. It's unclear whether they have genuine visual taste, can detect ugly UI, or can reliably judge quality differences between two designs. This sidequest treats that as an open research question, not an assumption.

## Goal

Build a knowledge base and methodology that agents can use to produce professional-grade UI. This includes:

1. **Research** — What makes UI look professional? What do the best apps do?
2. **LLM visual capability** — Can agents actually judge UI quality? How do we test this?
3. **Principles** — Distilled, actionable rules optimized for agent consumption
4. **Architecture** — Code structure and stack choices that *enforce* consistency rather than relying on agent discipline
5. **Patterns** — Concrete primitives and components in the chosen stack
6. **Auditing methodology** — How to systematically evaluate and improve existing UI

## Separation of concerns

This sidequest produces **knowledge and tooling**. It does NOT directly modify equin's UI. The workflow:

- **UI Mastery agents** — Research, audit, produce recommendations and patterns
- **Feature agents** — Build functional features (don't worry about polish)
- **Polish agents** — Apply UI Mastery knowledge to make features look professional

This separation is critical. Feature agents should not be distracted by aesthetics. Polish agents should not be restructuring functionality.

## Folder structure

```
sidequests/ui-mastery/
├── CLAUDE.md                    # This file
├── screenshots/                 # UI screenshots for reference/comparison
├── research/                    # Research docs, plans, audits (dated: YYYY-MM-DD-topic.md)
└── (future: patterns/, tools/)  # Code artifacts when we get there
```

Research docs live in `research/`; screenshots live at the top level. This sidequest does not use the top-level `artifacts/` folder.

## Current status

Phase 0: Scoping — defining what to research and in what order.
