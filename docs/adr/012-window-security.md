# 12. Window security: token, cookie, Host and Origin

Date: 2026-11-04 · Status: accepted

## Context

A server on 127.0.0.1 is reachable from every site open in the learner's browser. DNS rebinding can even make it look same-origin. The window must never let a web page tick boxes, press buttons, or read the learner's plan.

## Decision

- The server binds to 127.0.0.1 on a random port.
- Every request needs a random token. The link from the session carries it once. The first load swaps it for an HttpOnly, SameSite=Strict cookie and redirects, so the token leaves the address bar.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. That blocks DNS rebinding.
- POSTs must be JSON, and a non-matching `Origin` is refused.
- A strict Content Security Policy, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
- Buttons send one of three fixed events. No endpoint accepts free text (W-7).

## Consequences

- A link only works on the learner's own machine and only for the current server. A restarted server needs a fresh link from `/menitor:go`.
- Phone access over the local network (v1.1) needs a pairing step, not just a wider bind address.
