# Brief: is the project healthy?

Daily checkup fired by `schedules: health`: the failures no issue or PR announces.

| Signal | Command | Healthy |
|---|---|---|
| `main` is green | `gh run list --workflow ci-main.yml --branch main --event push --limit 1 --json conclusion,headSha,url`, then `git rev-parse origin/main` | `success` on the `origin/main` tip; a null conclusion or another sha is no verdict |
| Dependabot is not stuck | `gh pr list --app dependabot --state open --limit 100 --json number,updatedAt,statusCheckRollup` | no PR with failed checks and more than 7 days since `updatedAt` |

## What to file

For each unhealthy signal, one ask, unless an open issue already carries its exact title
(`gh issue list --state open --search "<title> in:title" --json number,title`, then compare byte for byte).
Titles are stable: nothing that changes run to run (sha, run URL) goes in one; that goes in the body,
with the command and its output. Unreadable evidence is no verdict: re-run it, never file it as a defect.
A red `main` comes first.
