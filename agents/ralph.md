# Ralph Agent Instructions

You are an autonomous coding agent working on a software project.

**Driver:** these instructions describe ONE iteration only and assume a fresh agent with no memory of prior iterations. **This project uses a per-story branch + PR + self-review-loop + self-merge workflow.** One iteration = one story: implement it, open a PR, review that PR, fix what the review finds, re-review until a pass comes back clean, merge to `main` — then stop. The next story runs in a **fresh session**, so treat `CLAUDE.md`, `progress.txt` and the PRD notes as the only handoff you get and the only handoff you leave.

## Your Task

1. Read the PRD at `prd.json` (in the same directory as this file)
2. Read the progress log at `progress.txt` (check Codebase Patterns section first)
3. Ensure `main` is up to date (`git checkout main && git pull`), then create a **new branch for this story only**, named `ralph/<story-id>-<short-slug>` (e.g. `ralph/us-001-scaffold`) — branched from the latest `main`, never reusing a prior story's branch and never committing multiple stories to one branch.
4. Pick the user story with `passes: false` that has the **lowest `priority` number** (1 is highest priority and runs first; higher numbers run later)
5. Run `showboat init docs/demos/<story_id>.md "<Story Title>"` to begin the proof-of-work log.
6. Implement that single user story. Document your progress and capture all successful quality checks (test, lint, typecheck) using the appropriate `showboat` commands.
7. Verify & Record:
- If Web: Use rodney to automate browser checks (e.g., rodney open, rodney assert) and wrap them in showboat exec to capture the proof.
- If Mobile: Use native CLI tools (e.g., adb shell, maestro) and wrap them in showboat exec. Use showboat image to capture simulator/emulator screenshots.
- If CLI/Lib: Use standard test runners wrapped in showboat exec.
8. Run quality checks (e.g., typecheck, lint, test - use whatever your project requires).
9. Run showboat verify on the demo file to ensure the whole sequence is reproducible.
10. Reflect: Update "Codebase Patterns" in CLAUDE.md.
11. Run `showboat verify`. It must exit 0. If it fails, fix the code/demo and retry.
12. Update CLAUDE.md files if you discover reusable patterns (see below)
13. If checks pass, commit ALL changes using **Conventional Commits** format: `<type>(<story-id>): <short summary>` — e.g. `feat(US-007): add hero boot-sequence animation`. Pick `<type>` by what the change actually is, not by default to `feat`:
    - `feat` — new user-facing functionality (most section/component stories)
    - `chore` — tooling, config, dependency, scaffolding work (e.g. US-001 scaffold, US-011 image pipeline, US-017 CI setup)
    - `style` — visual/CSS-only changes with no behavior change (e.g. parts of US-002 tokens, US-009 polish)
    - `fix` — bug fixes discovered and corrected mid-story
    - `docs` — documentation-only changes
    If a story mixes concerns, pick the type matching its primary intent; split into multiple commits within the branch if that's cleaner than picking one type.
14. Update the PRD to set `passes: true` for the completed story, and commit that PRD update on the same story branch (`chore(US-XXX): mark story complete` or folded into the main story commit)
15. Append your progress to `progress.txt`, and commit that update on the same story branch
16. Push the branch (`git push -u origin <branch-name>`) and open a PR against `main` via `gh pr create` — title `<type>(<story-id>): <short summary>` matching the primary commit, body summarizing what was implemented and how it was verified.
17. **Review/fix loop.** Run the `/code-review` skill against the PR's diff. Then:
    - If it reports findings: fix every one of them on the story branch (or, for a finding you judge to be a false positive, say so explicitly in your report and why), re-run the quality checks, commit, and push.
    - Re-run `/code-review` on the updated diff.
    - Repeat until a review pass returns **zero findings**. There is no round cap — keep looping. If you find yourself oscillating (the same finding reappearing after a fix, or fixes trading one finding for another across three-plus rounds), stop looping and report the deadlock instead of merging.
18. Once a review pass is clean and `npm run check` + `npm run lint` + `showboat verify` all pass on the final commit, merge the PR to `main` (`gh pr merge --squash --delete-branch`), then `git checkout main && git pull`.
19. **Stop.** One story per session: after the merge, report the merged PR URL and say which story is next, then stop. The next story runs in a **fresh session** — the human clears the context (`/clear`) and re-invokes these instructions, which is why step 1 assumes an agent with no memory of prior iterations. Do not start the next story in this session.

    This is the reason steps 10/12/14/15 are not optional busywork: everything the next story needs — patterns, gotchas, why a structure is the way it is — has to be in `CLAUDE.md`, `progress.txt` or the PRD notes **before** the merge, because the agent that picks up the next story cannot see this conversation.

### Tool Discovery & Usage Rules
You have two primary specialized tools. Treat their `--help` outputs as your definitive skill specifications:

- **Showboat:** Use for documenting and verifying work across all platforms (Web, Mobile, CLI).
  - *Constraint:* Use `showboat --help` to understand how to capture output and verify demos.
- **Rodney:** Use for Web-based automation, verification, and visual proof.
  - *Constraint:* Use `rodney --help` to understand how to drive Chrome, take screenshots, or assert DOM states.
  - *Context:* Use `rodney --local` to ensure browser sessions are scoped to the current project/iteration.

## Progress Report Format

APPEND to progress.txt (never replace, always append):
```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the evaluation panel is in component X")
---
```

The learnings section is critical - it helps future iterations avoid repeating mistakes and understand the codebase better.

## Consolidate Patterns

If you discover a **reusable pattern** that future iterations should know, add it to the `## Codebase Patterns` section at the TOP of progress.txt (create it if it doesn't exist). This section should consolidate the most important learnings:

```
## Codebase Patterns
- Example: Use `sql<number>` template for aggregations
- Example: Always use `IF NOT EXISTS` for migrations
- Example: Export types from actions.ts for UI components
```

Only add patterns that are **general and reusable**, not story-specific details.

## Update CLAUDE.md Files

Before committing, check if any edited files have learnings worth preserving in nearby CLAUDE.md files:

1. **Identify directories with edited files** - Look at which directories you modified
2. **Check for existing CLAUDE.md** - Look for CLAUDE.md in those directories or parent directories
3. **Add valuable learnings** - If you discovered something future developers/agents should know:
   - API patterns or conventions specific to that module
   - Gotchas or non-obvious requirements
   - Dependencies between files
   - Testing approaches for that area
   - Configuration or environment requirements

**Examples of good CLAUDE.md additions:**
- "When modifying X, also update Y to keep them in sync"
- "This module uses pattern Z for all API calls"
- "Tests require the dev server running on PORT 3000"
- "Field names must match the template exactly"

**Do NOT add:**
- Story-specific implementation details
- Temporary debugging notes
- Information already in progress.txt

Only update CLAUDE.md if you have **genuinely reusable knowledge** that would help future work in that directory.

## Quality Requirements

- ALL commits must pass your project's quality checks (typecheck, lint, test)
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns

## Browser Testing (If Available)

For any story that changes UI, verify it works in the browser if you have browser testing tools configured (e.g., via MCP):

1. Navigate to the relevant page
2. Verify the UI changes work as expected
3. Take a screenshot if helpful for the progress log

If no browser tools are available, note in your progress report that manual browser verification is needed.

## Stop Condition

**Always stop after one story**, whether it merged or not. Report the PR URL, what was verified, and which story is next; the human then clears the session and starts the next one. Never begin a second story in the same session, even if time and context remain.

Three ways an iteration ends:

- **Merged** (the normal case). Report the PR URL and the next story's id. If every story in `prd.json` now has `passes: true`, say so explicitly.
- **Review deadlock** (see step 17). Leave the PR open, do not merge, and report exactly what's stuck.
- **Blocked** — a missing credential, ambiguous acceptance criteria, or a decision only the human can make. Report the blocker rather than guessing or marking a story `passes: true` it didn't earn.

## Important

- Work on ONE story per session, on its own branch, ending in exactly one merged PR
- Never merge a PR whose latest review pass still has open findings
- Never start a second story in the same session — the next one gets a fresh context
- Commit frequently within the story's branch
- Keep CI green
- Read the Codebase Patterns section in progress.txt before starting