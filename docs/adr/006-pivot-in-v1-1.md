# 6. /menitor:pivot moves to v1.1

Date: 2026-11-04 · Status: accepted

## Context

Learners change their minds mid-project. Changing a plan that is underway touches tasks already done, start commits, ticks and owners.

## Decision

v1 has no pivot. Once the learner approves the plan, it's locked, and `menitor plan import` refuses to replace it. Pivot arrives in v1.1, with ADRs and an impact estimate.

## Consequences

- The v1 state model stays simple: task IDs, checklist IDs and owners never change after approval, except for fixes appended by checks and owners changed by learner-granted skips.
- A first demo project rarely needs a pivot. The design will be better after watching real pivots.
