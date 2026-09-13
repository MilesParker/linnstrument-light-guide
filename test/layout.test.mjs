import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutGrid, uniformGrid, gridToDict, SPECIAL_FADERS, SPECIAL_SEQUENCER } from '../web/src/layout.js'

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
