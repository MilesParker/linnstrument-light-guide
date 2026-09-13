import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutGrid, uniformGrid, gridToDict, isReversedSplit, SPECIAL_FADERS, SPECIAL_SEQUENCER, LEFT, RIGHT } from '../web/src/layout.js'

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
