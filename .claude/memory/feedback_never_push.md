---
name: Never push on own initiative
description: Never push on own initiative (only on explicit "push"/"publish"/"ship"); never propose push as a testing or verification step either
type: feedback
originSessionId: 01afc406-19bf-41ed-9504-50efa28e7638
---
Never commit or push code on your own initiative. Only run `./equin push` when the user explicitly says "push", "publish", or "ship". "Save in git" or "commit" means commit only — do NOT interpret it as permission to push to main.

**Never treat `./equin push` as a testing or verification step.** Design docs, plans, and verification checklists must not propose running push to exercise push-related flows. `push` promotes the branch to main — it is irreversible shared-state mutation, not a test fixture. Simulate the push path instead: insert `pushes` rows directly (SQL or test helper), or rely on dedicated integration tests in the push-watcher plugin.

**Why:** The guardrail is against *unsolicited* pushes, not against obeying a direct instruction. No extra confirmation needed when the user already asked. Testing push by actually pushing defeats the point of the guardrail — once it's in a verification plan, it will eventually get executed unreviewed.

**How to apply:** After making code changes, stop and let the user review. Do not commit or push unless the user asks. "push"/"publish"/"ship" all mean `./equin push` — never raw git commands. When writing verification sections of design docs, for any push-related scenario, describe how to simulate the push (DB insert / test helper) and explicitly warn against invoking `./equin push` for testing.
