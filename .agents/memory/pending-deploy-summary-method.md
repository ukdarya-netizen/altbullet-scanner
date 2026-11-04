---
name: Pending-deploy summary method
description: How to accurately list what's undeployed instead of reconstructing it from conversation memory.
---

## Method
1. `git --no-optional-locks log --pretty=format:"%h %ad %s" --date=format:"%Y-%m-%d %H:%M"` and find the most recent commit titled "Published your App" — confirm it's a real deploy (not just a checkpoint) by checking it has a `Replit-Commit-Deployment-Build-Id` trailer via `git show <hash>`.
2. `git diff --stat <last-deploy-hash> HEAD -- <source dirs>` to get the real file-level footprint since that deploy.
3. Read the full `git diff <last-deploy-hash> HEAD -- <files>` for the changed files to describe the actual pending changes in plain terms.

**Why:** A day's conversation can *feel* like it accumulated a huge stack of undeployed work, but several rounds of "Published your App" may have already shipped most of it. Reconstructing "what's pending" from chat history/summaries risks wildly overstating the diff and causing unnecessary anxiety before a deploy decision. The git log is ground truth; the conversation is not.

**How to apply:** Whenever a user asks for a consolidated list of undeployed changes (especially before a production deploy affecting live users), run this method fresh rather than summarizing from memory of what was discussed.
