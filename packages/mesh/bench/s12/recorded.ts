// Bench S12's recorded run: the local model's answers from the owner's test of the
// design (the remove question and the keep question, asked separately), as raw text.
// Line numbers refer to the given texts in functions/; chat-rows' are three more than
// the model answered, since its given text here keeps the three-line comment above
// the function that the model's copy lacked.
import type { Answer } from './fixtures.js'

export const RECORDED: Record<string, Answer> = {
  'find-age': { remove: '{"remove":[3,5,8,13]}\n', keep: '{"keep":[1]}\n' },
  'keep-in-place': { remove: '{"remove":[30]}\n', keep: '{"keep":[1,2,3,4]}\n' },
  'chat-rows': { remove: '{"remove":[5,9]}\n', keep: '{"keep":[]}\n' },
  'plan-segments': { remove: '{"remove":[5,11,17]}\n', keep: '{"keep":[1,2,3]}\n' },
  'plan-bar-label': { remove: '{"remove":[7]}\n', keep: '{"keep":[1,2]}\n' },
  'plan-sections': { remove: '{"remove":[4,6,9]}\n', keep: '{"keep":[]}\n' },
  'filter-chats': { remove: '{\n  "remove": [3, 6, 8]\n}\n', keep: '{"keep": [1]}\n' },
  'clean-title': { remove: '{"remove":[8,12]}\n', keep: '{"keep":[1,5]}\n' },
  'is-public-address': { remove: '{\n"remove": [3]\n}\n', keep: '{"keep":[1]}\n' },
  claim: { remove: '{"remove":[8,10,12]}\n', keep: '{\n  "keep": [2, 3, 4]\n}\n' },
  'find-row': { remove: '{"remove":[]}\n', keep: '{\n  "keep": [1, 20]\n}\n' },
  'plan-step-states': { remove: '{"remove":[]}\n', keep: '{\n  "keep": [1, 2, 3, 4, 5]\n}\n' },
  'read-chat': { remove: '{"remove":[]}\n', keep: '{"keep":[17]}\n' },
  'clean-copilot-name': { remove: '{"remove":[]}\n', keep: '{\n  "keep": [2,3,4,5,8,10]\n}\n' },
  stalled: { remove: '{"remove":[]}\n', keep: '{"keep": [5, 7]}\n' },
}

// HAND-WRITTEN, not a model's: what a correct model would answer for the change
// fixtures (remove: the planted slop; keep: the comments the change added that
// were already in the file). They prove the plumbing of the task and the bench,
// not a model; the live bench (run.ts) gives a model's numbers.
export const CHANGE_ANSWERS: Record<string, Answer> = {
  'viewer-network': { remove: '{"remove":[47,63,69,91]}', keep: '{"keep":[41,42,59,60,93]}' },
  reuse: { remove: '{"remove":[65,70,75,78,85]}', keep: '{"keep":[44,45,46,47,48,49,50,51,52,53,54,55,56,57]}' },
  star: { remove: '{"remove":[22,25,30,46]}', keep: '{"keep":[15,16,17]}' },
  files: { remove: '{"remove":[41,43,47,58]}', keep: '{"keep":[55]}' },
  place: { remove: '{"remove":[41,43,53]}', keep: '{"keep":[39,47,48,49,50]}' },
  rules: { remove: '{"remove":[61,64,69,71]}', keep: '{"keep":[]}' },
}
