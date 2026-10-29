// @vitest-environment jsdom
// #304 review: a lane is keyed by `data-lane`, so a selection in one lane is
// found again by that identity when lanes are re-created around it, never by
// position (which would land on another lane's text and drop the highlight).
import { describe, expect, it } from 'vitest'
import { captureSelection, restoreSelection } from '../../public/selection.js'

const lanes = (...entries: Array<[string, string]>) =>
  `<div id="lanes">${entries.map(([id, text]) => `<article data-lane="${id}"><strong>${text}</strong></article>`).join('')}</div>`

describe('selections in live lanes', () => {
  it('follows the lane by its data-lane identity when a lane is drawn above it', () => {
    document.body.innerHTML = lanes(['b', 'Painting lanes'])
    const text = document.querySelector('[data-lane="b"] strong')!.firstChild!
    document.getSelection()!.setBaseAndExtent(text, 0, text, 8)
    const bookmark = captureSelection()

    document.body.innerHTML = lanes(['a', 'Swapping GPUs'], ['b', 'Painting lanes'])
    restoreSelection(bookmark)

    expect(document.getSelection()!.toString()).toBe('Painting')
    expect(document.getSelection()!.anchorNode?.parentElement?.closest('[data-lane]')?.getAttribute('data-lane')).toBe('b')
  })
})
