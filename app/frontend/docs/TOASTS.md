# Toast Queue

This document defines the queued, dismissible toast behavior used for copy
feedback and non-critical system notices, plus the persistent history kept for
important events.

## Goals

- Rapid events must not overlap or replace each other before a user can read
  them.
- Toasts must never steal focus.
- Screen reader announcements must be polite and must not be duplicated.
- Every notice must be dismissible from the keyboard.
- Important events must remain available after the transient toast is gone.

## Queue behavior

- Toasts are enqueued in arrival order and shown one at a time (or in a small
  bounded batch) rather than all at once.
- A toast stays visible for a minimum readable duration before the next queued
  toast is shown. New events append to the queue; they never replace a toast
  that is currently visible.
- The queue has a bounded capacity. When the capacity is exceeded, the oldest
  pending (not yet shown) toast is dropped first; the currently visible toast is
  never dropped.
- Copy feedback toasts are coalesced: repeated copies within a short window
  update the existing notice instead of enqueuing a new one.

## Accessibility

- The toast region is a non-modal live region with `aria-live="polite"` and
  `aria-atomic="false"`. It is not focusable and never receives focus when a
  toast appears.
- Each toast is announced once. Re-rendering or re-queueing a toast must not
  re-trigger an announcement; only newly enqueued content is announced.
- Each toast exposes a dismiss control that is reachable by keyboard (Tab) and
  activated with Enter or Space. Dismissing a toast removes it from the queue and
  from the visible region.
- Dismissing a toast does not move focus. If focus was on the dismiss control,
  focus returns to the element that was focused before the toast appeared.
- Toasts do not trap focus and do not block interaction with the page.

## Persistent history

- Important events (for example, failures of non-critical background actions)
  are recorded in a persistent history in addition to the transient toast.
- History entries survive dismissal of the transient toast and page reloads
  where storage is available.
- History is bounded and ordered newest-first; older entries are evicted when
  the bound is reached.
- History entries are not announced automatically. Users open the history to
  review them, so announcements stay polite and non-duplicated.

## Non-goals

- Critical, blocking errors are not delivered as toasts; they use the existing
  inline error surfaces.
- Toasts are not used for anything that requires an immediate decision.

## Testing

Focused automated coverage should assert:

- Queued toasts are shown in order and a visible toast is not replaced by a new
  event.
- The live region is polite and a toast does not receive focus on appearance.
- Each toast can be dismissed with the keyboard, and focus is preserved.
- A toast is announced once and is not re-announced on re-render.
- Important events remain in the persistent history after the toast is
  dismissed, including the boundary case where the history bound is reached.
