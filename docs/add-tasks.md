# Add tasks: /menitor:add

A command that allows users to add tasks, either right after the current one or at the optimal position amongst the other tasks. Menitor decides the placement from the priority and context of the task.

## Problem

Users might want to add a feature, change the UI/UX or add a todo as they work on the project. Today there is no flow that tracks ideas like these as they come up. The plan is locked once approved, and `/menitor:pivot` (v1.1) is for changing course, not for adding to it.

## Users

- **The learner** runs `/menitor:add <short description>`.
- **The agent** may spot something worth adding, such as a follow-up from a review. It proposes it the same way, and adds nothing until the learner says yes in the session.

## Must-haves

### Propose before adding

`/menitor:add speed up the list page` proposes a task with a goal, a spot and a reason. It adds nothing until I say yes.

### Grill the idea first

Before proposing, Menitor asks one to three short questions about the idea: what "done" looks like, and why now. Then it proposes the task, its spot and a one-line reason.

### Place it safely

- A follow-up to the active task goes right after it.
- Anything else goes at the end of the milestone it belongs to.
- The learner sees the proposed spot with a one-line reason and can move it.
- Nothing lands before a done task or the active task.

### Size decides the shape

- **Step:** a one-action idea joins a related task that hasn't started, up to its six-item limit. If the related task is the active one, it becomes a small follow-up task right after it instead. The active card never changes under you.
- **Task:** a few steps become a task in a related milestone.
- **Milestone:** a big idea becomes its own milestone of several tasks.

### Change a locked plan safely

New tasks get new IDs. Old tasks are never renumbered, and done and active tasks never change. Every addition writes a line to the log.

### Show what was added

Added tasks carry an "Added" tag on the card, and a dot on their cell in the plan list. `plan show` and the terminal card mark them too.

## Design

### Data

- A task gets an optional `added` field: the time it was added.
- A new task's ID is the next free number (`t9` after `t8`), and a milestone's the next free `m` number. Checklist IDs follow (`t9.c1`).
- Done tasks, the active task and existing IDs are never touched, so hints, steps, solutions and the log stay valid.

### Command

`menitor plan add -` reads one addition as JSON on stdin and refuses a spot before the active task:

- `{"task": {...}, "after": "t3"}` adds a task. `after` may be a milestone ID to append to it.
- `{"step": "text", "to": "t5"}` adds a checklist item to a task not started yet. It goes before the task's commit step, so the commit stays last.
- `{"milestone": {...}, "after": "m2"}` adds a milestone.
- `--dry-run` prints where it would land without saving.
- It prints only the warnings the addition brings, and refusals say where it may go instead.

When every task is done, an added task becomes the current task.

### Flow

1. The learner types `/menitor:add <idea>`, or the agent spots an idea.
2. The agent grills the idea, then drafts the addition and runs `plan add --dry-run`.
3. The agent shows the goal, the spot and the reason, and asks yes, move it, or no.
4. On yes, it runs `plan add` and shows the updated plan. Type-along steps and hints are written for a new learner task.

### Testing

- Unit tests for placement: after the active task, at the end of a milestone, a refused spot, ID allocation, the six-item limit.
- CLI tests for `plan add` and `--dry-run`, and that the log gets one line.
- A window test that an added task shows its tag.
