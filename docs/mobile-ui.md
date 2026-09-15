# Touch and small screens

m8x is a desktop tool that people reach for from a phone. Not to build a
workflow — nobody wires a graph with their thumbs — but to answer the question
that brings them to it: *did the thing run, and why not*. Executions, insights
and the failure detail view are worth using on a phone. The editor mostly needs
to not be broken when somebody opens it there.

That split is the whole policy. This document says what it means concretely,
and what in the current code does not hold to it yet.

## Three tiers, not one

| Surface | On a phone |
| --- | --- |
| Executions, Insights, the failure detail, Datatable rows | First class. These are read on a phone on purpose. |
| Workflow browser, Credentials, Retention | Usable. Browsing, opening, renaming, activating — yes. Reorganising a folder tree — no. |
| The canvas editor | Legible and safe. Pan, zoom, tap a node, read its parameters, press Run. Not a place to author a graph. |

The tier decides how much work a screen deserves. It does not excuse a screen
from the baseline below.

## Baseline

These apply everywhere, including the editor.

**The viewport meta tag.** Without it a mobile browser lays the page out at
980px and scales it down, which makes every rule below meaningless. This is one
export in `app/layout.tsx` and it is currently missing:

```ts
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};
```

`viewportFit: 'cover'` is what lets `env(safe-area-inset-*)` return anything
other than zero, which the editor toolbar and any bottom-anchored bar will want.

**Text inputs at 16px or larger.** iOS Safari zooms the page when you focus an
input whose font is smaller, and it does not zoom back out. Our `Input`,
`Textarea` and `Select` are all `text-sm` (14px). Below `md` they need `text-base`;
above it `text-sm` is fine and looks better.

**Touch targets of 44px.** `Button` is `h-7` (28px) at `size="sm"` and `h-9`
(36px) at `md`. Both are fine with a mouse and neither is fine with a thumb.
Either add a `size="touch"` used below `md`, or give the existing sizes a
responsive height (`h-11 md:h-7`). Icon-only buttons — the drawer close, the
back arrow in the editor, the row menu trigger — need explicit padding, not just
a 16px icon.

**Nothing that only exists on hover.** The workflow browser's row menu is
`opacity-0 group-hover:opacity-100`. On a touch device that element is simply
invisible until it is tapped by accident. Anything hover-revealed must be
permanently visible below `md`.

**`dvh`, never `vh`.** `h-dvh` on the app shell is already right. Keep it that
way — `100vh` on iOS is taller than the visible area and hides whatever sits at
the bottom of the screen behind the browser chrome.

**Every table is a card list below `md`.** `overflow-x-auto` on a six-column
table is a horizontal scroll nested inside a vertical one, which is how you lose
a row while trying to scroll the page. The executions table is the case that
matters: below `md` render each row as a stacked card — workflow name, status
badge, relative time, failure message — and keep the table from `md` up. Datatable
rows are the one honest exception: the data really is a grid, so horizontal
scroll stays, but the container gets `-mx-4 px-4` so the scroll area is the full
screen width rather than a narrow inset.

**One column below `md`.** Any two-pane layout collapses. Any filter bar wraps
(`flex-wrap`) rather than pushing its last control off screen.

## The editor

The editor is where the current layout actually breaks rather than merely
cramps, so it gets specifics.

**The toolbar is seven buttons in a row that cannot wrap.** On a 375px screen
everything from Save rightwards is off screen, including Run. Below `md`: keep
Run, Save and Add node visible, and move Tidy up, Duplicate and Activate into an
overflow menu behind a `⋯` button. The workflow name truncates; the status
badges wrap to a second line.

**The inspector cannot be a 384px sidebar.** `w-96 shrink-0` next to the canvas
leaves nothing of a phone screen for the canvas. Below `md` the inspector is a
bottom sheet: fixed to the bottom, `max-h-[85dvh]`, its own scroll, a backdrop
that dismisses it, and the same component body as the desktop panel. That keeps
one inspector rather than two. A drag handle at the top is nice; a plain close
button is enough.

**Connection handles are 10px.** `!size-2.5` is a quarter of a fingertip. Two
changes, both cheap: raise React Flow's `connectionRadius` (default 20) to
around 40 on coarse pointers, and grow the handle's hit area without growing its
paint — a transparent `::before` at `-inset-2` does it. Detect the pointer with
`@media (pointer: coarse)` rather than by screen width; a touchscreen laptop is
wide and still has fat fingers.

**Do not fight the browser for the gesture.** React Flow's defaults are right on
touch: one finger pans, two pinch-zoom. Leave `panOnDrag` and `zoomOnPinch`
alone. What does need a decision is node dragging — on a phone, a long-press
before a node becomes draggable is worth it, because otherwise every attempt to
pan that starts on a node moves the node instead. That is an unsaved change the
user did not ask for, and `dirty` will nag them about it.

**The node palette opens the keyboard.** `autoFocus` on its search input is
correct on desktop and wrong on a phone, where it covers half the list with a
keyboard before the user has seen what is in it. Autofocus only when
`(pointer: fine)`. The palette itself is `pt-20` with a `max-h-96` body; below
`md` it should be a full-screen sheet.

**`Controls` needs to be out of the thumb's way.** React Flow puts them bottom
left, which is where the inspector sheet will be. Below `md`, hide them —
pinch-zoom covers everything they do except fit-view, and fit-view can live in
the toolbar.

## The workflow browser

Folder reorganisation uses the HTML5 drag-and-drop API (`draggable`,
`onDragStart`, `onDrop`). That API does not fire on touch at all — not
degraded, absent. The tree is therefore read-only on a phone today, silently.

The fix is not a touch drag-and-drop library. It is the entry the row menu
should have anyway: **Move to folder…**, opening a list of folders to pick from.
Cheaper than a gesture, works with a keyboard and a screen reader, and it means
drag-and-drop stays what it is — a desktop accelerator for something that has a
plain path.

## What to reach for

`@media (pointer: coarse)` for anything about fingers; Tailwind breakpoints for
anything about space. They are different questions and conflating them is how a
tablet ends up with desktop hit targets.

Below `md` is the phone. `md` and up is everything else. m8x does not need a
tablet tier — the desktop layout works from 768px, and inventing a third set of
rules for the gap would cost more than it returns.
