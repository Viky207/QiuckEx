# Handsoff

Handsoff is a production GitHub issue runner that proposes surgical, scope-faithful changes to satisfy assigned issues.

## Localization-safe layouts

Translated labels can be significantly longer than their English source strings. To keep critical actions visible and usable across supported viewport sizes, layouts follow these rules:

- **No fixed-width English copy.** Buttons, cards, and status badges size to their content (or use flexible `min-width`/`max-width` with wrapping) rather than hard-coded pixel widths tuned to English text.
- **Critical actions stay visible.** Primary actions (e.g. confirm, recover, submit) must remain reachable at supported viewport sizes even when labels expand. Prefer wrapping or truncation with an accessible full label over clipping.
- **Expanded text.** Allow labels to wrap (`overflow-wrap`, `text-overflow`) and avoid `white-space: nowrap` on user-facing action labels unless truncation is intentional and the full text is exposed to assistive tech.
- **Plural forms.** Do not concatenate counts into fixed strings; use the i18n plural API so locales with multiple plural categories render correctly.
- **Locale-specific amount/date widths.** Format amounts and dates with the active locale (`Intl.NumberFormat` / `Intl.DateTimeFormat`) and let containers flex, since localized output widths vary by locale.

### Test coverage

Focused automated tests cover the boundary cases above: expanded translated labels, plural forms, and locale-specific amount/date widths, asserting that critical actions remain visible and layouts do not depend on fixed-width English copy.
