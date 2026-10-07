# Phase 4 — Excellent mobile experience

## Goal

Make controlling a live Pi process from a phone feel intentional rather than like a desktop interface resized for mobile.

## Experience areas

- [ ] Refine safe areas, scrolling, virtual-keyboard behavior, touch targets, and composer ergonomics. The Svelte composer and paged-history viewport preservation are implemented; physical iPhone/Android validation remains.
- [ ] Make reconnecting and stale/offline state understandable without losing finalized history.
- [ ] Improve safe Markdown and tool cards, using focused sheets or progressive disclosure where useful.
- [ ] Make queued `followUp` and `steer` behavior visible and controllable.
- [ ] Improve completion and attention notifications with useful deep-link behavior.
- [ ] Add model and thinking-level controls through supported Pi extension APIs.
- [x] Add image prompts with explicit size, type, and transport limits.
- [ ] Consider active session-tree navigation only after lifecycle behavior is covered by tests.
- [ ] Validate every major interaction on physical iPhone and Android devices through Tailscale Serve.

## Implementation notes

- Selected histories open with the newest 16 snapshot entries; older pages are loaded explicitly and prepended without jumping the viewport. A slow initial request retries once with an eight-entry page.
- The composer accepts text-only, image-only, or mixed prompts on image-capable models. It normalizes up to three files to metadata-free JPEGs at 1600 px maximum, 300 KiB each, and 900 KiB combined.
- The daemon and extension revalidate image payloads before Pi receives flat `ImageContent` blocks. Attachments stay in memory and are cleared after sending or changing sessions.

## Deferred

- Desktop command-center features
- Browser terminal, file editor, or Git workspace management
- Multi-user or public internet hosting
- Starting a second Pi process to represent the same live session

## Completion signal

The common phone workflows—select a live process, understand its state, read activity, send or queue a prompt, abort, and return from a notification—are fast and predictable on both iOS and Android.
