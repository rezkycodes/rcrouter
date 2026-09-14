# Issue tracker: GitHub

Issues and specs for RcRouter live in GitHub Issues at `rezkycodes/rcrouter`.
Use `gh` with `--repo rezkycodes/rcrouter` until the local `origin` remote is
changed to RcRouter.

## Conventions

- Create: `gh issue create --repo rezkycodes/rcrouter --title "..." --body "..."`.
- Read: `gh issue view <number> --repo rezkycodes/rcrouter --comments`.
- List: `gh issue list --repo rezkycodes/rcrouter --state open`.
- Comment, label, or close: use the corresponding `gh issue` command with
  `--repo rezkycodes/rcrouter`.
- Blocking edges use native GitHub issue dependencies where available;
  otherwise each issue body declares `Blocked by: #<number>`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When a skill says "publish to the issue tracker", create a GitHub issue in
`rezkycodes/rcrouter`.
