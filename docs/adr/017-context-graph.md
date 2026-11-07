# 17. A file-level context graph, built in core with no dependencies

Date: 2026-11-07 · Status: accepted.

## Context

Milestone 8 cut what Menitor's own text costs ([context-cost.md](../context-cost.md)). What remains is what the agent reads to do the work: the doc section in a brief, the files it opens to review a change, and the files it searches to write hints or do a delegated task. Today that reading is undirected. The agent knows a task's doc section and its diff, but not which other files the task leans on, so it opens whole files and searches the tree.

The learner asked for "optimized ways to read files and collect context, maybe a traversable graph", to spend as few tokens as possible. A graph is a large choice. It touches the state files, the CLI and every skill that reads code, so it gets a decision first.

The choice has to fit the earlier decisions:

- No runtime dependencies, in plain JavaScript (ADR 8), and no install step (ADR 4).
- An agent-neutral core (ADR 5): the graph and its queries belong to the CLI, not to one agent.
- One writer per state file (ADR 9).
- Beginners are the primary users (ADR 7): nothing they must install or configure.

## Options

1. **A graph of docs sections, tasks and files, with file-level links.** Menitor already knows most of the edges. Markdown headings give the sections, each task links one section, and git gives the files each task changed. Paths named in a section, and import lines in the code, add the rest. All of it can be read with Node and git.
2. **A code symbol index.** Functions, classes and their call sites, parsed per language. It answers finer questions, such as "who calls this". But a real parser means tree-sitter or a compiler per language: native modules or large packages, against ADRs 4 and 8. A parser written in-house would be costly and wrong in the cases that matter.
3. **An existing tool.** Several tools build a code graph or map and serve it to agents. Examples are knowledge-graph MCP servers such as GitNexus or Serena, Aider's repo map, and Universal Ctags. They are strong at symbol-level questions. But each needs its own install, with a native binary, Python or a database, and each knows nothing of Menitor's docs, tasks or plan.
4. **Embeddings and search.** A vector index finds "related" text. It needs a model, either a download or a remote API, against the local-only rule. Its answers are fuzzy, so they are hard to check.

## Decision

Build option 1 in core: a file-level graph of docs sections, tasks and files, with zero dependencies.

- **Nodes.** A doc section (file, heading, anchor, line range and size), a task (ID, linked section, branch, start commit) and a project file (path, size, git blob hash).
- **Edges.**
  - A task links the section its card names.
  - A task touched the files changed between its start commit and its pass.
  - A section names the files and sections it mentions: code-formatted paths and Markdown links.
  - A file imports the files its import lines name. These are read with small per-language patterns for JavaScript, TypeScript and Python, and are absent for other languages.
- **Storage.** `.menitor/graph.json`, written only by the CLI and kept out of git. It can always be rebuilt from the docs, the plan and git, so a lost or stale file costs time, never correctness.
- **Freshness.** No watcher. On each query, the CLI compares git's blob hashes (`git ls-files -s`) and the docs' sizes and times with what it indexed, and re-reads only what changed.
- **Queries.** The CLI answers "what does this task touch?" with sections, files and line ranges, each with its size. It also answers "which tasks and sections name this file?". Briefs and the check review read through these answers in t33, so the agent opens the parts that matter instead of whole files.
- **Existing tools stay optional.** When a learner already has a code-graph tool, a skill may use it for symbol-level questions. Menitor never needs one.

## Expected savings

Milestone 9 measures these with `npm run context-cost`, extended in t33 to count what the review and the brief read. The targets are estimates to be checked, not results:

- **The check review** reads the diff and the touched sections and line ranges, instead of whole changed files and the files around them. The target is a third to a half less on a typical task.
- **Hints and delegated work** start from the files the graph names, instead of a search of the tree. The target is a few hundred tokens less per milestone start.
- **The brief** stays about the same. It already loads only one section; the graph adds the files that section names, as a list of paths and sizes.

## Consequences

- No new dependency and no install step. The graph is plain JSON that the CLI writes and reads.
- File-level links are coarse: the graph says which files and sections to read, not which function calls which. That suits Menitor's tasks, which are a few files each, and the reviews, which start from a diff.
- Import edges exist only for JavaScript, TypeScript and Python. Other stacks still get the task, section and path edges, which come from the docs and git.
- A wrong edge would only make the agent read one file too many or too few. The diff stays the source of truth for a review, so a missed file can't hide a change.
- A future symbol index can be added beside the graph, as an optional tool, without changing this decision.
