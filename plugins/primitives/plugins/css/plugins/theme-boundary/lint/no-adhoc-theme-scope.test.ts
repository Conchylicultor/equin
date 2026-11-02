/**
 * Tests for the `no-adhoc-theme-scope` lint rule.
 *
 * The rule bans hand-assembling a theme boundary — both halves of it. It must
 * fire on:
 *   - a raw `data-theme-scope` attribute on ANY host element (an intrinsic, a
 *     capitalized component, a member-expression tag), literal or computed,
 *   - an import of `PortalThemeScopeProvider`, aliased or not.
 * And never on:
 *   - `<Theme name surface>`, the primitive it redirects to,
 *   - a neighbouring `data-*` attribute, or another portal-forwarded signal,
 *   - `usePortalThemeScope` / `appThemeScope`, which READ the scope rather than
 *     declaring a boundary,
 *   - a `[data-theme-scope=…]` CSS selector or `getAttribute` string, which are
 *     not JSX attributes at all (theme-engine emits the former by the thousand).
 */

import rule from "./no-adhoc-theme-scope";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-theme-scope", rule, {
  valid: [
    // The prescribed shape.
    {
      code: `const el = <Theme name={appThemeScope(id)} surface="canvas">{children}</Theme>;`,
    },
    // Reading the scope is not declaring a boundary.
    {
      code: `
          import { usePortalThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
          const scope = usePortalThemeScope();
        `,
      },
      // Another portal-forwarded signal — the bridge itself is not the theme
      // half, and plugin lineage / pane id ride it legitimately.
      {
        code: `
          import { PortalForwardProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
          const el = <PortalForwardProvider name="data-pane-id" value={id}>{children}</PortalForwardProvider>;
        `,
      },
      // A neighbouring data-* attribute.
      { code: `const el = <div data-pane-id={id} data-testid="x" />;` },
      // The attribute as a CSS SELECTOR / DOM read — theme-engine emits these,
      // and the e2e driver reads them back. Not a JSX attribute.
      {
        code: `
          const css = '[data-theme-scope="app:pages"]{--background:red}';
          const scope = el.getAttribute("data-theme-scope");
        `,
      },
    ],
    invalid: [
      // The bug shape: attribute with no paint and no forward (app-tabs-body).
      {
        code: `const el = <div data-theme-scope={appThemeScope(tab.appId)} className="absolute inset-0">{body}</div>;`,
        errors: [{ messageId: "adhocThemeScope" }],
      },
      // A string literal value is the same declaration.
      {
        code: `const el = <div data-theme-scope="app:pages" />;`,
        errors: [{ messageId: "adhocThemeScope" }],
      },
      // ANY host element — no tag gate. A capitalized layout component is
      // exactly how the sibling rules' deleted tag allowlists failed open.
      {
        code: `const el = <Stack direction="row" data-theme-scope={themeScope} className="bg-sidebar" />;`,
        errors: [{ messageId: "adhocThemeScope" }],
      },
      // …including a member-expression tag.
      {
        code: `const el = <Foo.Bar data-theme-scope={scope} />;`,
        errors: [{ messageId: "adhocThemeScope" }],
      },
      // The other half, hand-rolled.
      {
        code: `
          import { cn, PortalThemeScopeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
          const el = <PortalThemeScopeProvider scope={scope}>{children}</PortalThemeScopeProvider>;
        `,
        errors: [{ messageId: "adhocPortalThemeScope" }],
      },
      // Aliasing the import is the evasion the imported-name check closes.
      {
        code: `import { PortalThemeScopeProvider as Forward } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";`,
        errors: [{ messageId: "adhocPortalThemeScope" }],
      },
      // Both halves in one file — the shape every converted call site had.
      {
        code: `
          import { PortalThemeScopeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
          const el = (
            <PortalThemeScopeProvider scope={scope}>
              <div data-theme-scope={scope} className="bg-background">{children}</div>
            </PortalThemeScopeProvider>
          );
        `,
        errors: [
          { messageId: "adhocPortalThemeScope" },
          { messageId: "adhocThemeScope" },
        ],
      },
    ],
  },
);
