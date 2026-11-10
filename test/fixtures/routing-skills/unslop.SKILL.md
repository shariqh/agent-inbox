---
name: unslop
description: Remove generic AI-writing patterns from prose for people while keeping its meaning, facts, links and terms. Use when drafting or revising a PR description, an issue, release notes, public documentation, a blog post or an email. Public drafts go to the local unslop agent; email, customer text and private material are edited in-session.
---

<!-- Written by agent-inbox meshctl (#513). Do not edit: meshctl rewrites this file. -->

# unslop

The editing rules are in `rules.md`, in the folder that `skill` names in
`/Users/someone/.agent-inbox/mesh/wrappers/unslop.json` (the unslop profile, which the agent reads too).

## Where the text is edited

1. Email, customer text and private material never go to the unslop agent. Edit them
   in-session with `rules.md`. When unsure, edit in-session.
2. For a PR description, an issue, release notes, public documentation or a blog post,
   write the draft to a file and run, with a shell timeout of at least 300 seconds:

   /Users/someone/.agent-inbox/bin/unslop --kind <pr|issue|release-notes|docs|blog> --report <report file> < <draft file>

   - Exit 0: use stdout as the edited text, and check the report's `warnings`.
   - Any other exit, or none within the timeout: ignore stdout and edit the original
     in-session with `rules.md`. Do not retry.
3. Anything else: edit in-session with `rules.md`.

## Email

Email is edited in-session only, with `rules.md`, before the draft goes for approval.
Never change an approved revision in place.
