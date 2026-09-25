# Phase 4 — Excellent mobile experience

## Goal

Make controlling a live Pi process from a phone feel intentional rather than like a desktop interface resized for mobile.

## Experience areas

- [ ] Refine safe areas, scrolling, virtual-keyboard behavior, touch targets, and composer ergonomics.
- [ ] Make reconnecting and stale/offline state understandable without losing finalized history.
- [ ] Improve safe Markdown and tool cards, using focused sheets or progressive disclosure where useful.
- [ ] Make queued `followUp` and `steer` behavior visible and controllable.
- [ ] Improve completion and attention notifications with useful deep-link behavior.
- [ ] Add model and thinking-level controls through supported Pi extension APIs.
- [ ] Add image prompts with explicit size, type, and transport limits.
- [ ] Consider active session-tree navigation only after lifecycle behavior is covered by tests.
- [ ] Validate every major interaction on physical iPhone and Android devices through Tailscale Serve.

## Deferred

- Desktop command-center features
- Browser terminal, file editor, or Git workspace management
- Multi-user or public internet hosting
- Starting a second Pi process to represent the same live session

## Completion signal

The common phone workflows—select a live process, understand its state, read activity, send or queue a prompt, abort, and return from a notification—are fast and predictable on both iOS and Android.
