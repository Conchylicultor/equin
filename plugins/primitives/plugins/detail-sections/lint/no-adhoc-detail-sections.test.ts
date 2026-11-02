/**
 * Tests for the `no-adhoc-detail-sections` lint rule. Run with `bun test`.
 *
 * The rule flags a `<X.Section.Render>` whose render-prop returns its own
 * `Surface`/`Card`/`SectionCard` root — the hand-rolled detail-pane host. The
 * `valid` cases below are the real shapes in this repo that must NEVER trip it:
 * the landing-band slots that pass no callback, the hosts that return a bare
 * component or `div`, non-`Section` `.Render` zones, and the multi-hop
 * indirection this rule deliberately lets through.
 */

import rule from "./no-adhoc-detail-sections";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-detail-sections", rule, {
  valid: [
    // `website.section` / `home.section` — self-closing, no render-prop at all.
    { code: `const el = <Website.Section.Render />;` },
    { code: `const el = <Home.Section.Render />;` },
    // `pages.welcome.section` — returns the contributed component bare.
    {
      code: `const el = <PagesWelcome.Section.Render>{(s) => <s.component />}</PagesWelcome.Section.Render>;`,
    },
    // `profiling.section` — Gantt lanes, a plain keyed div.
    {
      code: `const el = <Profiling.Section.Render>{(s) => <div key={s.id}><s.component /></div>}</Profiling.Section.Render>;`,
    },
    // The sanctioned shape: the factory's Host renders the section through a helper.
    {
      code: `const el = <Section.Render>{(item) => <SectionItemHost section={item} entityProps={p} />}</Section.Render>;`,
    },
    // A `.Render` zone that is not `.Section.Render` — the member before
    // `.Render` must literally be `Section`.
    {
      code: `const el = <Toolbar.Start.Render>{(s) => <Card><s.component /></Card>}</Toolbar.Start.Render>;`,
    },
    // Chrome around the LIST rather than per item (review's plugin-changes shape).
    {
      code: `const el = <Card><PluginChanges.Section.Render>{(s) => <s.component />}</PluginChanges.Section.Render></Card>;`,
    },
    // Multi-hop indirection — the documented false negative (Sonata's old host).
    {
      code: `const el = <Sonata.Section.Render>{(s) => <SectionCardHost section={s} />}</Sonata.Section.Render>;`,
    },
    // A wrapper that merely CONTAINS a card resolves to the wrapper, not the card.
    {
      code: `const el = <Foo.Section.Render>{(s) => <div><Card /></div>}</Foo.Section.Render>;`,
    },
  ],
  invalid: [
    // The Workflows host verbatim — the shape this rule exists to catch.
    {
      code: `const el = (
          <WorkflowsDetail.Section.Render>
            {(s) => (
              <Surface key={s.id} level="raised" as="section" className="p-lg">
                <Text as="h2" variant="label">{s.title}</Text>
                <s.component definitionId={definitionId} />
              </Surface>
            )}
          </WorkflowsDetail.Section.Render>
        );`,
        errors: [{ messageId: "adhocDetailSections" }],
      },
      // The deploy host (same copy-pasted shape, different slot).
      {
        code: `const el = <Deploy.Section.Render>{(s) => <Surface level="raised"><s.component serverId={id} /></Surface>}</Deploy.Section.Render>;`,
        errors: [{ messageId: "adhocDetailSections" }],
      },
      // A `Card` root rather than `Surface`.
      {
        code: `const el = <X.Section.Render>{(s) => <Card><s.component /></Card>}</X.Section.Render>;`,
        errors: [{ messageId: "adhocDetailSections" }],
      },
      // Re-wrapping the primitive's own SectionCard by hand.
      {
        code: `const el = <X.Section.Render>{(s) => <SectionCard title={s.label}><s.component /></SectionCard>}</X.Section.Render>;`,
        errors: [{ messageId: "adhocDetailSections" }],
      },
      // A block body with an early return — the return walk still finds the card.
      {
        code: `const el = <X.Section.Render>{(s) => { if (!s) return null; return <Card><s.component /></Card>; }}</X.Section.Render>;`,
        errors: [{ messageId: "adhocDetailSections" }],
      },
      // Ternary — both branches are resolved.
      {
        code: `const el = <X.Section.Render>{(s) => s.hidden ? null : <SectionCard title={s.label} />}</X.Section.Render>;`,
        errors: [{ messageId: "adhocDetailSections" }],
      },
    ],
  },
);
