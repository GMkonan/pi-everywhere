# Phase 5 — Capacitor checkpoint

## Current decision

Remain a PWA. Capacitor is compatible with Svelte and can wrap the same static web build later, but native packaging is not current implementation work.

Capacitor would place the Svelte UI in an iOS or Android WebView and provide bridges to native capabilities. It would not automatically solve background WebSocket execution, remote connectivity, authentication, app-store operations, or every mobile keyboard issue.

## Reconsider Capacitor if

- physical-device testing shows unacceptable PWA limitations;
- reliable native notifications or background behavior requires a native bridge;
- biometric or platform credential storage becomes necessary;
- camera, files, sharing, or deep links need deeper native integration;
- app-store distribution becomes a product requirement.

## Evaluation questions

- What exact user problem cannot be solved acceptably by the PWA?
- Can a focused web or service-worker improvement solve it first?
- Which native plugins are needed, and are they maintained?
- What signing, store-review, release, and device-testing work would be added?
- Would the Capacitor application still use Tailscale, or would connectivity architecture change?

## Decision outcome

At this checkpoint, record one of:

1. Continue with the PWA because native packaging has no demonstrated value.
2. Add Capacitor around the Svelte build for specific named capabilities.
3. Consider a truly native client only if a WebView wrapper is insufficient.
