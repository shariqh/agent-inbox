---
name: unslop-code
description: Remove the comments an AI coding agent adds that a maintainer would not write, from the JavaScript and TypeScript files a change touched. Use after writing or editing code in a git repository and before committing it.
---

# unslop-code

Run this once after you have written or edited code in a git repository, before you commit:

    ~/.agent-inbox/bin/unslop-code --apply --report <report file>

Give the command a shell timeout of at least 300 seconds. Run it from inside the repository. Do not check that the file exists first, and add no redirection.

- It looks at the lines your change added in JavaScript and TypeScript files, removes whole-line comments that only restate the code or narrate steps, and changes nothing else. It never rewrites code.
- Exit 0: it ran. Read the report. `suggestions` lists other things it noticed, each with a file, a line and a kind. They are suggestions: look at each line and decide yourself; never apply one without reading the code.
- Any other exit, or no answer within the timeout: carry on without it. Do not retry. Tell the person in one line that unslop-code was not used, with the exit code or "timeout" and the last line it printed.
- Exit 18: the same, and also tell the person to run `meshctl enable --unslop-code --apply` again.
- If `~/.agent-inbox/bin/unslop-code` does not exist, the agent is off: say so in one line and carry on.

Never send it files that hold secrets or customer material; it skips a file in which it sees a key or a token, but do not rely on that.
