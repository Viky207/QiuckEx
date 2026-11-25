# Accessibility Testing Guide for Web Contributors

This guide describes how to test the web frontend (`app/frontend`) for accessibility. It covers manual checks that require a human and how to run the existing automated checks.

> **Automated checks are necessary but not sufficient.** Passing ESLint, Playwright, and Vitest does not mean a component is accessible. Automated tools catch only a subset of issues (missing labels, some contrast problems, some ARIA misuse). Keyboard, focus, zoom, and screen-reader behavior must be verified manually.

---

## 1. Before you start

- Run the app locally (see `app/frontend/CONTRIBUTING.md` for setup).
- Have at least one screen reader available:
  - **macOS:** VoiceOver (built in, `Cmd+F5`).
  - **Windows:** NVDA (free) or Narrator (built in).
  - **Linux:** Orca.
- Test in at least one browser with a keyboard (no mouse/trackpad).
- Keep the browser zoom controls handy (`Cmd/Ctrl` + `+`/`-`).

---

## 2. Manual checks

Run these for every component you add or change, and for any page whose layout or interaction you touch.

### 2.1 Keyboard navigation

- Reach every interactive element using only `Tab` / `Shift+Tab`.
- Activate controls with `Enter` and `Space` where expected.
- Use arrow keys where a widget expects them (menus, tabs, radio groups, listboxes).
- Confirm there are no **keyboard traps** (you can always tab out of a component).
- Confirm the tab order matches the visual reading order.
- Confirm nothing is reachable that shouldn't be (e.g. hidden content, disabled controls that should be skipped).

### 2.2 Focus management and visible focus

- Every focusable element shows a **clearly visible focus indicator** (not just a subtle color change). Check against both light and dark backgrounds if supported.
- When a modal/dialog opens, focus moves **into** the dialog (usually the first focusable element or the dialog container).
- When a modal/dialog closes, focus returns to the element that opened it.
- When content is removed or a route changes, focus is placed somewhere sensible (e.g. page heading or main region), not lost to `<body>`.
- Dynamic content that appears (toasts, inline errors) is announced or focusable as appropriate.
- Do **not** remove focus outlines without providing an equivalent visible indicator.

### 2.3 Zoom and reflow

- At **200% zoom**, all content remains usable: no content is clipped, no horizontal scrolling for normal reading content, controls remain operable.
- At **400% zoom** (or a 320 CSS px wide viewport), content reflows into a single column without loss of information or functionality (WCAG 1.4.10 Reflow).
- Text remains readable and does not overlap other content when text size is increased.
- Test with browser zoom and, where relevant, OS-level text scaling.

### 2.4 Color contrast

- Body text meets **4.5:1** contrast against its background.
- Large text (≥ 24px, or ≥ 18.66px bold) meets **3:1**.
- UI component boundaries and graphical objects needed to understand content meet **3:1**.
- Focus indicators meet **3:1** against adjacent colors.
- Do not rely on color alone to convey meaning (e.g. error state must also have text/icon).
- Use a contrast checker (browser devtools accessibility pane, or a dedicated contrast tool) on the actual rendered colors, including hover/focus/disabled states.

### 2.5 Screen-reader testing

- With the screen reader on, navigate the component and confirm:
  - Every control has an accessible **name** (label, `aria-label`, or `aria-labelledby`).
  - The **role** and **state** are announced correctly (e.g. "button, pressed", "checkbox, checked", "dialog").
  - Dynamic changes (errors, loading, toasts) are announced via appropriate live regions.
  - Images have meaningful `alt` text, or empty `alt=""` when decorative.
  - Headings form a logical outline (no skipped levels for structure).
- Test at least the primary flow of the component with one screen reader and one browser.

---

## 3. Automated checks

These are the existing scripts. Run them locally before opening a PR; CI runs them too.

### 3.1 ESLint (jsx-a11y)

The accessibility lint rules live in `app/frontend/eslint.a11y.config.mjs`. Run the a11y lint config from `app/frontend`:

```bash
cd app/frontend
npx eslint --config eslint.a11y.config.mjs .
```

This catches static issues such as missing `alt`, invalid ARIA attributes, and non-interactive elements with click handlers. Fix all reported errors; treat warnings as items to review.

### 3.2 Playwright

End-to-end tests and their config live in `app/frontend/playwright.config.ts`. Run from `app/frontend`:

```bash
cd app/frontend
npx playwright test
```

Playwright tests can assert keyboard flows, focus location, and accessible names/roles. When you change interactive behavior, add or update a Playwright test that exercises the keyboard path (e.g. tab to a control, activate it, assert focus moved as expected).

### 3.3 Vitest

Unit/component tests and their config live in `app/frontend/vitest.config.ts`. Run from `app/frontend`:

```bash
cd app/frontend
npx vitest run
```

Use Vitest to assert rendered roles, accessible names, and state (e.g. `getByRole`, `aria-*` attributes) for components you change.

> Reminder: green automated checks are a floor, not a ceiling. Complete the manual checks in section 2 for the components you touch.

---

## 4. Per-component checklists

Use the relevant checklist in addition to the general manual checks above.

### Buttons

- Rendered as a real `<button>` (or has correct `role` and keyboard handling if not).
- Has an accessible name (visible text, or `aria-label` for icon-only buttons).
- `Enter` and `Space` both activate it.
- Disabled state is conveyed (`disabled` attribute) and skipped in tab order as expected.
- Toggle buttons expose `aria-pressed`; the state is announced.
- Visible focus indicator present; contrast meets 3:1.
- Icon-only buttons have a label; decorative icons are `aria-hidden`.

### Links

- Rendered as `<a href>`; navigates with `Enter`.
- Link text is meaningful out of context (avoid "click here"); icon-only links have an accessible name.
- External/opens-in-new-tab behavior is conveyed in text or `aria-label`.
- Distinguishable from surrounding text by more than color alone (e.g. underline).
- Focus indicator visible; contrast meets requirements.

### Forms

- Every input has a programmatically associated `<label>` (or `aria-label`/`aria-labelledby`).
- Required fields are marked and conveyed (`required` / `aria-required`), not by color/asterisk alone.
- Help text and errors are associated via `aria-describedby`.
- Errors are announced (live region or focus moved to the error summary) and identify the field.
- Grouped controls (radios, checkboxes) use `<fieldset>`/`<legend>` or an equivalent accessible group name.
- Placeholder text is not the only label.
- Submit works via keyboard; validation messages are reachable and readable by screen readers.

### Modals / dialogs

- Uses a dialog pattern with `role="dialog"` (or native `<dialog>`) and an accessible name (`aria-labelledby`).
- Focus moves into the dialog on open and is trapped within it while open.
- `Esc` closes the dialog (unless it's a blocking confirmation, in which case document the behavior).
- Focus returns to the triggering element on close.
- Background content is inert / not focusable while open (`aria-hidden` or `inert` on the rest of the page).
- Title and content are announced by the screen reader on open.

### Badges

- If a badge conveys status, the status is available to assistive tech (text, or `aria-label` on the badge).
- Color is not the only indicator of meaning; include text or an icon with an accessible name.
- Decorative badges are hidden from assistive tech (`aria-hidden="true"`).
- Badge text meets contrast requirements against its background.
- If a badge is interactive (e.g. a removable chip), it is a real button with an accessible name and keyboard support.

---

## 5. Reporting issues

When you find an accessibility problem, note:

- The component and page/route.
- The check that failed (keyboard, focus, zoom, contrast, screen reader).
- Browser, OS, and assistive technology used.
- Steps to reproduce.

File it as a bug so it can be tracked and fixed, and reference this guide in the report.