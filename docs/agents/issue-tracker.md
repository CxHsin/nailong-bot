# Issue tracker: GitHub

GitHub Issues are the source of truth for `grillme` conclusions, `to-spec` specs, and implementation tasks. Use the repository configured as `origin` and the `gh` CLI. Include `--repo <owner>/<repo>` when the current directory cannot resolve the repository.

## Publish and link

1. After the `grillme` decisions are confirmed, create one Issue containing the conclusion: the problem, settled decisions, remaining constraints, and relevant discussion context. Return its URL.
2. When `to-spec` turns that discussion into a spec, create a separate Issue using the skill's spec template. Link the conclusion Issue in the spec body as `Based on #<number>`. Apply the `ready-for-agent` label. Return its URL.
3. Create one Issue per implementation task. Link each task to the spec as `Part of #<number>` and apply the appropriate triage label. Add task links to the spec Issue's body or a comment so the work can be found from the spec.
4. If a step begins from an existing GitHub Issue, read its body, labels, and comments before continuing. Use Issue numbers and URLs for handoffs. Add later decisions as comments or update the relevant Issue body.

Use a temporary UTF-8 body file with `gh issue create --body-file <path>` or `gh issue edit --body-file <path>` for multiline Markdown. Run `gh issue view <number> --comments` to read an Issue; use `gh issue list --state open` to discover work. Use `gh issue comment`, `gh issue edit`, and `gh issue close` for updates. Resolve the repository from `git remote -v` before writing.

The five triage labels are defined in `triage-labels.md`. Apply them as GitHub labels, not as a `Status:` line in an Issue body.

## When a skill says "publish to the issue tracker"

Create a GitHub Issue in this repository and return its URL. Follow the linking and label rules above for the type of result being published.

## When a skill says "fetch the relevant ticket"

Read the referenced Issue's body, labels, and comments with `gh issue view <number> --comments` before acting on it.

## Targeted retrieval

For a status check, request only the state:

```powershell
gh issue view <number> --json state --jq '.state'
```

For comment navigation, retrieve an index before selecting the relevant discussion:

```powershell
gh issue view <number> --json comments --jq '.comments[] | {url, createdAt}'
```

Before acting on an Issue, complete the body, labels, and comments read required above. For a large Issue, save the full JSON in a temporary file outside the repository and read it in bounded sections. Use comment URLs to track which decisions were read; an index alone does not satisfy the requirement. On later checks, retrieve the changed sections needed for the current question. Follow [context-handoff.md](context-handoff.md) when output is truncated or work is handed off.

## Wayfinding operations

Used by `/wayfinder`. The map is one Issue, with child Issues for tickets.

- **Map**: an Issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- **Child ticket**: a GitHub sub-issue of the map, labelled `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). If sub-issues are unavailable, add a task list of child links to the map and put `Part of #<map>` in each child's body.
- **Blocking**: use GitHub issue dependencies when available. Otherwise put `Blocked by: #<number>` in the child body. A child is unblocked when every blocker is closed.
- **Frontier**: inspect open children in map order; the first unblocked and unassigned child is next.
- **Claim**: assign the child to the working developer before starting work.
- **Resolve**: comment with the answer, close the child, and add a short conclusion with its Issue link to the map's Decisions-so-far.
