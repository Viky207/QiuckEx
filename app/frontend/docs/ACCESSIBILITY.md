# Accessibility

This document describes the accessibility behavior of the frontend, focusing on
interactive controls and the feedback they provide to assistive technology (AT).

## Copy controls

Copy-to-clipboard controls (for example, copying a link or identifier) must be
usable by keyboard and screen-reader users. The reusable copy control provides:

- **Keyboard operability.** The control is a native `<button>`, so it is reachable
  via `Tab` and activated with `Enter` or `Space` without custom key handling.
- **Visible confirmation.** On success the control shows a visible confirmation
  state (for example, a "Copied" label) that reverts after a short delay. On
  failure it shows a visible error state.
- **Non-visual announcement.** Both success and failure are announced through a
  polite live region (`role="status"` / `aria-live="polite"`). The live region
  text is updated only when a copy attempt produces a new result, so unrelated
  rerenders do not repeat the announcement.

### Announcement deduplication

The live region message is derived from the copy result (success or failure) and
is only written when that result changes. Re-rendering the surrounding view for
unrelated reasons does not re-trigger the announcement, avoiding noisy or
repeated AT output.

### Failure and boundary cases

- If the clipboard API is unavailable or the write is rejected, the control
  announces a failure message and shows the visible error state.
- Rapid repeated activations update the announcement only when the result
  changes, so a repeated success does not spam the live region.

## Testing

Focused automated coverage asserts that:

- a successful copy announces the success message,
- a failed copy announces the failure message, and
- unrelated rerenders do not repeat the announcement.
