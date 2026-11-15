---
name: unslop
description: Remove generic AI-writing patterns from prose for people while keeping its meaning, facts, links and terms. Use when drafting or revising a PR description, an issue, release notes, public documentation, a blog post or an email. Public drafts go to the local unslop agent; email, customer text and private material are edited in-session.
---

<!-- Written by agent-inbox meshctl (#513). Do not edit: meshctl rewrites this file. -->

# unslop

The editing rules are in `rules.md`, beside this file. If `rules.md` cannot be read, do NOT
edit in-session: return the text unchanged and say that the rules could not be read.

## Where the text is edited

1. Email, customer text and private material never go to the unslop agent. Edit them
   in-session with `rules.md`. When unsure, edit in-session.
2. For a PR description, an issue, release notes, public documentation or a blog post,
   write the draft to a file and run this command directly, with a shell timeout of at
   least 300 seconds. Do not check for the shim first, and use no shell redirection:

   ~/.agent-inbox/bin/unslop --kind <pr|issue|release-notes|docs|blog> --in <draft file> --report <report file>

   - Exit 0: use stdout as the edited text, and check the report's `warnings`.
   - Any other exit, or none within the timeout: ignore stdout and never retry. Before any
     in-session edit, tell the person in your reply that the unslop agent was not used,
     giving the exit code (or that it timed out) and the last line the shim wrote to stderr.
     Then edit the original in-session with `rules.md`.
   - Exit 18 (the shim is stale): the same, and also tell the person to run
     `meshctl enable --unslop --apply` again.
   - If the shell says the shim file does not exist, the agent is off: still tell the person
     the unslop agent was not used (it is off), then edit in-session with `rules.md`.
3. Anything else: edit in-session with `rules.md`.

## Email

Email is edited in-session only, with `rules.md`, before the draft goes for approval.
Never change an approved revision in place. Before the draft goes for approval, check that:

- every fact and source in the original survived;
- names, recipients, dates, links, commitments and technical terms are unchanged;
- nothing was added that the original did not say.
