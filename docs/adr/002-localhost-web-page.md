# 2. A localhost web page, not Electron

Date: 2026-11-04 · Status: accepted

## Context

The learner needs one task card in view while they code, beside or over their editor. It must work on macOS, Linux and Windows without a heavy install.

## Options

- **An Electron or Tauri app.** A native window, but a large download per platform, and signing and updating to manage.
- **A page served from 127.0.0.1.** Any browser, any OS, no install. Document Picture-in-Picture gives an always-on-top mini window where browsers support it.
- **Terminal only.** No extra pieces, but the card scrolls away as the session goes on.

## Decision

Serve the task window as a page on 127.0.0.1 from a small Node server, with Document Picture-in-Picture for the pop-out.

## Consequences

- Nothing to install beyond Node, which the CLI already needs.
- Safari and mobile get a normal window instead of picture-in-picture.
- A local server must defend itself against other sites in the same browser. See [ADR 12](012-window-security.md).
