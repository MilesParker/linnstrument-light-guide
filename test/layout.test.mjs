import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutGrid, uniformGrid, gridToDict, gridToCenterDict, splitNoteRanges, PREFER_DEEPEST, isReversedSplit, SPECIAL_FADERS, SPECIAL_SEQUENCER, LEFT, RIGHT } from '../web/src/layout.js'

const split = (o = {}) => ({ special: 0, transposeOctave: 0, transposePitch: 0, transposeLights: 0, ...o })
const base = (o = {}) => ({
  columns: 25, colOffset: 1, splitActive: false, splitPoint: 13, selectedSplit: 0,
  rowOffsetMode: 5, splits: [split(), split()], ...o,
})

test('default layout matches the legacy uniform grid', () => {
  assert.deepEqual(layoutGrid(base()), uniformGrid(25, 30, 5))
  assert.deepEqual(layoutGrid(base({ columns: 16 })), uniformGrid(16, 30, 5))
})

test('octave mode starts at 18, not 30', () => {
  const g = layoutGrid(base({ rowOffsetMode: 12, customRowOffset: 12 }))
  assert.equal(g[0][0], 18)
  assert.equal(g[0][1], 30)
})

test('split: right split octave applies from the split point, columns stay continuous', () => {
  const g = layoutGrid(base({ splitActive: true, splits: [split(), split({ transposeOctave: 12 })] }))
  assert.equal(g[11][0], 41) // col 12, left
  assert.equal(g[12][0], 54) // col 13, right: 30 + 12 + 12
})

test('split: a pitch present in both halves maps to pads on both sides', () => {
  const g = layoutGrid(base({ splitActive: true, splits: [split(), split({ transposeOctave: 12 })] }))
  const coords = gridToDict(g)[54]
  assert.ok(coords.some(([x]) => x < 12), 'left split pad')
  assert.ok(coords.some(([x]) => x >= 12), 'right split pad')
})

test('no-overlap split: right split starts on the same note as the left', () => {
  const g = layoutGrid(base({ rowOffsetMode: 0, splitActive: true }))
  assert.equal(g[0][0], 30)
  assert.equal(g[12][0], 30)
  assert.equal(g[0][1], 30 + 12)  // left width = splitPoint - 1
  assert.equal(g[12][1], 30 + 13) // right width = 26 - splitPoint
})

test('faders split has no pitched pads', () => {
  const g = layoutGrid(base({ splitActive: true, splits: [split(), split({ special: SPECIAL_FADERS })] }))
  assert.ok(g.slice(12).every(col => col.every(n => n === -1)))
  assert.ok(Object.values(gridToDict(g)).flat().every(([x]) => x < 12))
})

test('split off: selected split settings govern the whole surface', () => {
  const g = layoutGrid(base({ selectedSplit: 1, splits: [split(), split({ transposeOctave: 12 })] }))
  assert.equal(g[0][0], 42)
})

test('transpose lights shifts the pitch each pad sends', () => {
  const g = layoutGrid(base({ splits: [split({ transposeLights: 2 }), split()] }))
  assert.equal(g[0][0], 28)
})

test('selected split in sequencer mode takes over the surface', () => {
  const g = layoutGrid(base({ splitActive: true, selectedSplit: 1, splits: [split(), split({ special: SPECIAL_SEQUENCER })] }))
  assert.ok(g.every(col => col.every(n => n === -1)))
})

test('guitar tuning uses per-row notes', () => {
  const tuning = [30, 35, 40, 45, 50, 55, 59, 64]
  const g = layoutGrid(base({ rowOffsetMode: 13, guitarTuning: tuning }))
  assert.deepEqual(g[0], tuning)
})

test('reversed off leaves the layout alone', () => {
  assert.deepEqual(layoutGrid(base({ reversed: false, reversedSplits: 'both' })), layoutGrid(base()))
})

test('reversed both mirrors the columns, like NUMCOLS - col in the firmware', () => {
  const plain = layoutGrid(base())
  const g = layoutGrid(base({ reversed: true, reversedSplits: 'both' }))
  assert.deepEqual(g, [...plain].reverse())
  assert.equal(g[0][0], 54)  // col 1 plays what col 25 plays: 30 + 24
  assert.equal(g[24][0], 30) // col 25 plays what col 1 plays
})

test('reversed both mirrors a 128 as well', () => {
  const g = layoutGrid(base({ columns: 16, reversed: true, reversedSplits: 'both' }))
  assert.deepEqual(g, [...layoutGrid(base({ columns: 16 }))].reverse())
  assert.equal(g[0][0], 45) // 17 - 1 = 16, so 30 + 15
})

test('REVL reverses only the left split, mirrored across the whole surface', () => {
  const plain = layoutGrid(base({ splitActive: true }))
  const g = layoutGrid(base({ splitActive: true, reversed: true, reversedSplits: 'left' }))
  for (let x = 12; x < 25; x++) {
    assert.deepEqual(g[x], plain[x], `right split pad ${x} is untouched`)
  }
  assert.equal(g[11][0], 43) // col 12 -> noteCol 26 - 12 = 14
  assert.equal(g[0][0], 54)  // col 1  -> noteCol 25, so the left split ascends right to left
})

test('REVR reverses only the right split', () => {
  const plain = layoutGrid(base({ splitActive: true }))
  const g = layoutGrid(base({ splitActive: true, reversed: true, reversedSplits: 'right' }))
  for (let x = 0; x < 12; x++) {
    assert.deepEqual(g[x], plain[x], `left split pad ${x} is untouched`)
  }
  assert.equal(g[12][0], 42) // col 13 -> noteCol 26 - 13 = 13, so 30 + 12
  assert.equal(g[24][0], 30) // col 25 -> noteCol 1, so the right split ascends right to left
})

test('isReversedSplit follows the firmware handedness rules', () => {
  const off = base({ reversed: false, reversedSplits: 'both' })
  assert.equal(isReversedSplit(off, LEFT), false)
  assert.equal(isReversedSplit(off, RIGHT), false)

  const both = base({ reversed: true, reversedSplits: 'both' })
  assert.equal(isReversedSplit(both, LEFT), true)
  assert.equal(isReversedSplit(both, RIGHT), true)

  const left = base({ reversed: true, reversedSplits: 'left' })
  assert.equal(isReversedSplit(left, LEFT), true)
  assert.equal(isReversedSplit(left, RIGHT), false)

  const right = base({ reversed: true, reversedSplits: 'right' })
  assert.equal(isReversedSplit(right, LEFT), false)
  assert.equal(isReversedSplit(right, RIGHT), true)

  // defaults to both, so a missing config still reverses when the device says so
  assert.equal(isReversedSplit(base({ reversed: true }), LEFT), true)
})

//////////////////////////////////////////
// ONE PAD PER NOTE                     //
//////////////////////////////////////////

/** Distance in pads from (x, y) to the middle of a 25 x 8 surface */
const fromCenter = ([x, y]) => Math.hypot(x - 12, y - 3.5)

test('one pad per note: a note keeps only its pad nearest the middle', () => {
  const g = layoutGrid(base())
  const note = g[12][3] // a pad in the middle of the surface, so the note has many
  assert.ok(gridToDict(g)[note].length > 1, 'the note is on several pads to begin with')

  const [pad] = gridToCenterDict(g)[note]
  const nearest = Math.min(...gridToDict(g)[note].map(fromCenter))
  assert.equal(fromCenter(pad), nearest)
  assert.equal(gridToCenterDict(g)[note].length, 1)
})

test('one pad per note: every note the grid plays still has a pad', () => {
  const g = layoutGrid(base())
  const all = gridToDict(g)
  const lit = gridToCenterDict(g)
  assert.deepEqual(Object.keys(lit).sort(), Object.keys(all).sort())
  // and each is one of the pads that really sends that note
  for (const [note, [pad]] of Object.entries(lit)) {
    assert.ok(all[note].some(([x, y]) => x === pad[0] && y === pad[1]), `note ${note}`)
  }
})

test('one pad per note: a split keeps a pad on each side', () => {
  const layout = base({ splitActive: true, splits: [split(), split({ transposeOctave: 12 })] })
  const g = layoutGrid(layout)
  const note = 54 // present in both halves, as the split test above shows
  const pads = gridToCenterDict(g, layout)[note]

  assert.equal(pads.length, 2)
  assert.ok(pads.some(([x]) => x < 12), 'left split pad')
  assert.ok(pads.some(([x]) => x >= 12), 'right split pad')

  // each nearest the middle of its own half, not of the whole surface
  for (const [x, y] of pads) {
    const center = x < 12 ? 5.5 : 18 // x 0-11 and x 12-24
    const half = gridToDict(g)[note].filter(([px]) => (px < 12) === (x < 12))
    const nearest = Math.min(...half.map(([px, py]) => Math.hypot(px - center, py - 3.5)))
    assert.equal(Math.hypot(x - center, y - 3.5), nearest)
  }
})

test('one pad per note: an unsplit surface is measured from its own middle', () => {
  const g = uniformGrid(16, 30, 5) // a 128, whose middle is at x 7.5, not x 12
  const note = g[7][3]
  const distance = ([x, y]) => Math.hypot(x - 7.5, y - 3.5)

  const [pad] = gridToCenterDict(g)[note]
  assert.equal(distance(pad), Math.min(...gridToDict(g)[note].map(distance)))
})

test('one pad per note: pads equally far from the middle settle on the leftmost', () => {
  // Row offset 0 puts the same note on all 8 pads of a column, so rows 3 and 4 tie
  const g = uniformGrid(16, 30, 0)
  const pads = gridToCenterDict(g)[30 + 7]
  assert.deepEqual(pads, [[7, 3]])
})

test('one pad per note: a faders split contributes no pads', () => {
  const layout = base({ splitActive: true, splits: [split(), split({ special: SPECIAL_FADERS })] })
  const g = layoutGrid(layout)
  assert.ok(Object.values(gridToCenterDict(g, layout)).flat().every(([x]) => x < 12))
})

//////////////////////////////////////////
// ONE PAD, ONE SIDE                    //
//////////////////////////////////////////

/** Left split as it comes, right split an octave up, so the two ranges overlap */
const octaveSplit = base({ splitActive: true, splits: [split(), split({ transposeOctave: 12 })] })

/** Lowest and highest note the pads of a half play */
const rangeOf = (grid, half) => {
  const notes = grid.slice(...(half === LEFT ? [0, 12] : [12])).flat().filter((n) => n >= 0)
  return [Math.min(...notes), Math.max(...notes)]
}

test('one side: a note on both halves goes to the half it sits further inside', () => {
  const g = layoutGrid(octaveSplit)
  const [leftLow, leftHigh] = rangeOf(g, LEFT)
  const [rightLow, rightHigh] = rangeOf(g, RIGHT)
  const overlap = [Math.max(leftLow, rightLow), Math.min(leftHigh, rightHigh)]
  assert.ok(overlap[0] < overlap[1], 'the halves do overlap')

  const sideOf = (note) => {
    const pads = gridToCenterDict(g, octaveSplit, PREFER_DEEPEST)[note]
    assert.equal(pads.length, 1, `note ${note} lights one pad`)
    return pads[0][0] < 12 ? LEFT : RIGHT
  }
  const depth = (note, [low, high]) => Math.min(note - low, high - note)

  for (let note = overlap[0]; note <= overlap[1]; note++) {
    const left = depth(note, [leftLow, leftHigh])
    const right = depth(note, [rightLow, rightHigh])
    if (left === right) continue // settled by keeping the left split, checked below
    assert.equal(sideOf(note), left > right ? LEFT : RIGHT, `note ${note}`)
  }

  // the rule divides the overlap rather than handing all of it to one hand
  assert.equal(sideOf(overlap[0] + 1), LEFT)
  assert.equal(sideOf(overlap[1] - 1), RIGHT)
})

test('one side: a note only one half plays still lights there', () => {
  const g = layoutGrid(octaveSplit)
  const [, leftHigh] = rangeOf(g, LEFT)
  const [rightLow] = rangeOf(g, RIGHT)
  const lit = gridToCenterDict(g, octaveSplit, PREFER_DEEPEST)

  const belowTheRight = rightLow - 1
  const aboveTheLeft = leftHigh + 1
  assert.ok(lit[belowTheRight].every(([x]) => x < 12), 'left half only')
  assert.ok(lit[aboveTheLeft].every(([x]) => x >= 12), 'right half only')
})

test('one side: equal depth into both halves keeps the left', () => {
  // Both halves play the same notes, so every note is equally far into each
  const g = layoutGrid(base({ splitActive: true }))
  const lit = gridToCenterDict(g, base({ splitActive: true }), PREFER_DEEPEST)
  const note = g[5][3]
  assert.equal(lit[note].length, 1)
  assert.ok(lit[note][0][0] < 12, 'left split pad')
})

test('one side: without a split it is the same as one pad per side', () => {
  const g = layoutGrid(base())
  assert.deepEqual(gridToCenterDict(g, base(), PREFER_DEEPEST), gridToCenterDict(g, base()))
})

//////////////////////////////////////////
// A LAYOUT STRAIGHT FROM THE DEVICE    //
//////////////////////////////////////////

/**
 * What readDeviceLayout() hands back: no `columns`, because how many columns the
 * surface has is the app's own setting, added where the grid is generated. Taking
 * the count from the layout instead of the grid loses the right half entirely, and
 * everything then lights on the left.
 */
const asRead = ({ columns, colOffset, ...layout }) => layout

test('device layout: both halves are found without a column count on the layout', () => {
  const full = base({ columns: 16, splitActive: true, splits: [split(), split({ transposeOctave: 12 })] })
  const grid = layoutGrid(full)
  const layout = asRead(full)
  const note = 67 // playable on both halves

  assert.equal(layout.columns, undefined, 'as the device reports it')
  assert.deepEqual(gridToCenterDict(grid, layout)[note], gridToCenterDict(grid, full)[note])
  assert.equal(gridToCenterDict(grid, layout)[note].length, 2, 'one pad per half')
})

test('device layout: the halves report the notes they play', () => {
  const full = base({ columns: 16, splitActive: true, splits: [split(), split({ transposeOctave: 12 })] })
  const grid = layoutGrid(full)

  assert.deepEqual(splitNoteRanges(grid, asRead(full)), splitNoteRanges(grid, full))
  assert.ok(splitNoteRanges(grid, asRead(full)).every((range) => Number.isFinite(range.low)), 'both halves play notes')
})

test('device layout: a note asked for on the right half lands on the right half', () => {
  const full = base({ columns: 16, splitActive: true, splits: [split(), split({ transposeOctave: 12 })] })
  const grid = layoutGrid(full)
  const note = 67 // G4, playable on both halves

  const [[x]] = gridToCenterDict(grid, asRead(full), RIGHT)[note]
  assert.ok(x >= 8, `expected a right half pad, got column ${x}`)
})
