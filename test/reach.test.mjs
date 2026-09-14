import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isReadable, unreadableReason, resolveFingering, placeChord, MAX_TOUCHES_IN_COLUMN } from '../web/src/reach.js'
import { layoutGrid, gridToDict, gridToCenterDict, LEFT, RIGHT } from '../web/src/layout.js'

const split = (o = {}) => ({ special: 0, transposeOctave: 0, transposePitch: 0, transposeLights: 0, ...o })
const base = (o = {}) => ({
  columns: 16, colOffset: 1, splitActive: false, splitPoint: 9, selectedSplit: 0,
  rowOffsetMode: 5, splits: [split(), split()], ...o,
})

//////////////////////////////////////////
// THE TWO SENSOR RULES                 //
//////////////////////////////////////////

test('a spread out chord is readable', () => {
  assert.ok(isReadable([[0, 0], [2, 1], [5, 3], [9, 6]]))
})

test('three touches in one column are fine, a fourth is not', () => {
  assert.equal(MAX_TOUCHES_IN_COLUMN, 3)
  assert.ok(isReadable([[4, 0], [4, 1], [4, 2]]))
  assert.equal(unreadableReason([[4, 0], [4, 1], [4, 2], [4, 5]]), 'column')
})

test('a column is counted on its own, not across the surface', () => {
  assert.ok(isReadable([[4, 0], [4, 1], [4, 2], [7, 3], [7, 4], [7, 5]]))
})

test('three corners of a rectangle are fine, the fourth is not', () => {
  assert.ok(isReadable([[2, 1], [6, 1], [2, 4]]))
  assert.equal(unreadableReason([[2, 1], [6, 1], [2, 4], [6, 4]]), 'rectangle')
})

test('the rectangle rule needs two shared columns, not one', () => {
  assert.ok(isReadable([[2, 1], [6, 1], [2, 4], [7, 4]]))
})

test('the same pad cannot be pressed twice', () => {
  assert.equal(unreadableReason([[3, 2], [3, 2]]), 'pad')
})

test('the rules apply wherever the pads are, including across a split', () => {
  assert.equal(unreadableReason([[1, 2], [12, 2], [1, 5], [12, 5]]), 'rectangle')
})

//////////////////////////////////////////
// FINDING A FINGERING                  //
//////////////////////////////////////////

/** A note that sits on exactly the pads given, in that order */
const padsOf = (table) => (note) => table[note] ?? []

test('every note keeps its preferred pad when that shape is readable', () => {
  const table = { 60: [[0, 0], [5, 1]], 64: [[4, 0], [9, 1]], 67: [[7, 0]] }
  const { pads, dropped } = resolveFingering([60, 64, 67], padsOf(table))
  assert.deepEqual(dropped, [])
  assert.deepEqual(pads.get(60), [0, 0])
  assert.deepEqual(pads.get(64), [4, 0])
  assert.deepEqual(pads.get(67), [7, 0])
})

test('a note moves to its next pad rather than completing a rectangle', () => {
  // The preferred pads are the four corners of a rectangle on rows 0 and 3
  const table = {
    60: [[2, 0]],
    62: [[6, 0]],
    64: [[2, 3]],
    65: [[6, 3], [1, 4]],
  }
  const { pads, dropped } = resolveFingering([60, 62, 64, 65], padsOf(table))
  assert.deepEqual(dropped, [])
  assert.deepEqual(pads.get(65), [1, 4], 'took the fallback pad')
  assert.ok(isReadable([...pads.values()]))
})

test('a fourth note in a column moves out of it', () => {
  const table = {
    60: [[3, 0]], 62: [[3, 1]], 64: [[3, 2]],
    65: [[3, 3], [8, 6]],
  }
  const { pads, dropped } = resolveFingering([60, 62, 64, 65], padsOf(table))
  assert.deepEqual(dropped, [])
  assert.deepEqual(pads.get(65), [8, 6])
})

test('a held note keeps its pad and the rest are placed around it', () => {
  const table = {
    60: [[2, 0], [7, 1]],
    62: [[6, 0]],
    64: [[2, 3]],
    65: [[6, 3]],
  }
  // 60 is already down on [2, 0], so it is 65 that has to give way — and it cannot
  const pinned = new Map([[60, [2, 0]]])
  const { pads, dropped } = resolveFingering([60, 62, 64, 65], padsOf(table), pinned)
  assert.deepEqual(pads.get(60), [2, 0], 'the held finger did not move')
  assert.deepEqual(dropped, [65])
})

test('with no pinning the same chord is played by moving the free note', () => {
  const table = {
    60: [[2, 0], [7, 1]],
    62: [[6, 0]],
    64: [[2, 3]],
    65: [[6, 3]],
  }
  const { pads, dropped } = resolveFingering([60, 62, 64, 65], padsOf(table))
  assert.deepEqual(dropped, [])
  assert.deepEqual(pads.get(60), [7, 1])
})

test('a note with nowhere to go is dropped, and the others still play', () => {
  const table = { 60: [[0, 0]], 62: [], 64: [[4, 2]] }
  const { pads, dropped } = resolveFingering([60, 62, 64], padsOf(table))
  assert.deepEqual(dropped, [62])
  assert.equal(pads.size, 2)
})

test('when a chord cannot fit, the most notes that can are kept', () => {
  // Five notes that only exist in one column: three of them can sound
  const table = { 60: [[1, 0]], 62: [[1, 1]], 64: [[1, 2]], 65: [[1, 3]], 67: [[1, 4]] }
  const { pads, dropped } = resolveFingering([60, 62, 64, 65, 67], padsOf(table))
  assert.equal(pads.size, MAX_TOUCHES_IN_COLUMN)
  assert.equal(dropped.length, 2)
  assert.ok(isReadable([...pads.values()]))
})

test('a chord that already fits keeps every note', () => {
  const table = { 60: [[1, 0]], 62: [[1, 1]], 64: [[1, 2]], 65: [[1, 3]] }
  assert.deepEqual(resolveFingering([60, 62, 64], padsOf(table)).dropped, [])
  assert.deepEqual(resolveFingering([60, 62, 64, 65], padsOf(table)).dropped, [65])
})

//////////////////////////////////////////
// AGAINST A REAL LAYOUT                //
//////////////////////////////////////////

/** G major 7 voiced D-F#-G-B, whose pads fall on the corners of a rectangle */
const GMAJ7 = [50, 54, 55, 59]
/** C-F-A#-D#, a stack of fourths, which lands four notes in one column */
const QUARTAL = [48, 53, 58, 63]

/** Each note's own pad first, then the rest of its pads: how player.js asks */
function padsForOf(layout) {
  const grid = layoutGrid(layout)
  const all = gridToDict(grid)
  const lit = gridToCenterDict(grid, layout)
  return (note) => [
    ...lit[note],
    ...all[note].filter(([x, y]) => !lit[note].some(([lx, ly]) => lx === x && ly === y)),
  ]
}

test('the pads the guide would light on its own are unreadable', () => {
  const lit = gridToCenterDict(layoutGrid(base()), base())
  assert.equal(unreadableReason(GMAJ7.flatMap((note) => lit[note])), 'rectangle')
  assert.equal(unreadableReason(QUARTAL.flatMap((note) => lit[note])), 'column')
})

test('both chords have a fingering the sensor can read, and it is found', () => {
  for (const chord of [GMAJ7, QUARTAL]) {
    const padsFor = padsForOf(base())
    const { pads, dropped } = resolveFingering(chord, padsFor)
    assert.deepEqual(dropped, [], `${chord}: no note had to be given up`)
    assert.ok(isReadable([...pads.values()]), `${chord}: readable`)
    assert.equal(pads.size, 4)
  }
})

test('only the note that has to move does', () => {
  const layout = base()
  const lit = gridToCenterDict(layoutGrid(layout), layout)
  const { pads } = resolveFingering(GMAJ7, padsForOf(layout))
  const moved = GMAJ7.filter((note) => String(pads.get(note)) !== String(lit[note][0]))
  assert.deepEqual(moved, [59])
})

test('every note keeps a pad that really sends it', () => {
  const layout = base()
  const grid = layoutGrid(layout)
  const { pads } = resolveFingering(GMAJ7, padsForOf(layout))
  for (const [note, [x, y]] of pads) {
    assert.equal(grid[x][y], note)
  }
})

test('no ordinary chord on the default layout has to give up a note', () => {
  const layout = base()
  const grid = layoutGrid(layout)
  const all = gridToDict(grid)
  let checked = 0
  for (let root = 48; root <= 72; root++) {
    for (let a = 1; a <= 12; a++) {
      for (let b = a + 1; b <= 12; b++) {
        for (let c = b + 1; c <= 12; c++) {
          const notes = [root, root + a, root + b, root + c]
          if (notes.some((note) => !all[note])) continue
          checked++
          assert.deepEqual(resolveFingering(notes, (note) => all[note]).dropped, [], `${notes}`)
        }
      }
    }
  }
  assert.ok(checked > 4000, `only checked ${checked} chords`)
})

//////////////////////////////////////////
// ONE STEP AFTER ANOTHER               //
//////////////////////////////////////////

test('a note held over from the step before keeps its pad', () => {
  const table = { 60: [[2, 0], [7, 1]], 62: [[6, 0]], 64: [[2, 3]], 65: [[6, 3]] }
  const previous = new Map([[60, [2, 0]]])
  // 60 sounds on through the step rather than being struck again, so it cannot move
  const { pads, dropped } = placeChord([60, 62, 64, 65], [62, 64, 65], padsOf(table), previous)
  assert.deepEqual(pads.get(60), [2, 0])
  assert.deepEqual(dropped, [65])
})

test('a note struck again is free to move, even where it was already sounding', () => {
  const table = { 60: [[2, 0], [7, 1]], 62: [[6, 0]], 64: [[2, 3]], 65: [[6, 3]] }
  const previous = new Map([[60, [2, 0]]])
  const { pads, dropped } = placeChord([60, 62, 64, 65], [60, 62, 64, 65], padsOf(table), previous)
  assert.deepEqual(pads.get(60), [7, 1])
  assert.deepEqual(dropped, [])
})

test('a progression of the chords that break plays through, one note moving each time', () => {
  const layout = base()
  const lit = gridToCenterDict(layoutGrid(layout), layout)
  const padsFor = padsForOf(layout)
  const progression = [
    { notes: [50, 54, 55, 59], onsets: [50, 54, 55, 59] }, // G major 7 as D F# G B
    { notes: [50, 53, 55, 58], onsets: [53, 58] },         // G minor 7 over a held D and G
    { notes: [48, 53, 58, 63], onsets: [48, 53, 58, 63] }, // a stack of fourths
    { notes: [50, 52, 55, 57], onsets: [50, 52, 55, 57] }, // D E G A
  ]

  let previous = new Map()
  for (const step of progression) {
    const { pads, dropped } = placeChord(step.notes, step.onsets, padsFor, previous)

    assert.deepEqual(dropped, [], `${step.notes}: every note is playable`)
    assert.ok(isReadable([...pads.values()]), `${step.notes}: the sensor can read the chord`)
    // Held fingers stay where they are
    for (const note of step.notes) {
      if (!step.onsets.includes(note) && previous.has(note)) {
        assert.deepEqual(pads.get(note), previous.get(note), `${note} was held, so it did not move`)
      }
    }
    // And no more of the chord is disturbed than the sensor forces
    const moved = step.notes.filter((note) => String(pads.get(note)) !== String(lit[note][0]))
    assert.ok(moved.length <= 1, `${step.notes}: moved ${moved}`)
    previous = pads
  }
})

test('the same step placed twice from the same hold lands in the same place', () => {
  // What the look ahead relies on: it shows where the next step will want a note
  const padsFor = padsForOf(base())
  const previous = new Map([[50, [5, 3]]])
  const first = placeChord(GMAJ7, [54, 55, 59], padsFor, previous).pads
  const again = placeChord(GMAJ7, [54, 55, 59], padsFor, previous).pads
  assert.deepEqual([...first], [...again])
})

//////////////////////////////////////////
// KEEPING NOTES UNDER THEIR OWN HAND    //
//////////////////////////////////////////

// player.js routes each part to a hand and then places the chord twice: once with
// only that hand's pads, and only if that cannot be read, once with the whole
// surface. These cover the decision that is made between the two.

const SPLIT = base({ splitActive: true, splitPoint: 9 })

/** The pads one hand can offer for a note, nearest its own first */
function handPadsOf(layout) {
  const grid = layoutGrid(layout)
  const all = gridToDict(grid)
  const sides = { [LEFT]: gridToCenterDict(grid, layout, LEFT), [RIGHT]: gridToCenterDict(grid, layout, RIGHT) }
  const halfOf = (x) => x + 1 < layout.splitPoint ? LEFT : RIGHT

  return (note, side, ownHandOnly) => {
    const own = sides[side][note] ?? []
    const [ox, oy] = own[0] ?? []
    const hand = ox === undefined ? null : halfOf(ox)
    const cost = ([x, y]) => (x - ox) ** 2 + 4 * (y - oy) ** 2
    const rest = (all[note] ?? [])
      .filter(([x, y]) => !own.some(([px, py]) => px === x && py === y))
      .sort((a, b) => cost(a) - cost(b))
    const here = rest.filter(([x]) => halfOf(x) === hand)
    return ownHandOnly ? [...own, ...here] : [...own, ...here, ...rest.filter(([x]) => halfOf(x) !== hand)]
  }
}

/** Which half each placed pad landed on */
const halves = (pads, splitPoint) => [...pads.values()].map(([x]) => x + 1 < splitPoint ? LEFT : RIGHT)

test('a left hand chord that breaks is re-fingered without leaving the left hand', () => {
  const padsOf = handPadsOf(SPLIT)
  // D F# G B under the left hand, the voicing whose own pads form a rectangle
  const chord = [50, 54, 55, 59]
  const { pads, dropped } = placeChord(chord, chord, (note) => padsOf(note, LEFT, true))

  assert.deepEqual(dropped, [])
  assert.ok(isReadable([...pads.values()]))
  assert.deepEqual(halves(pads, SPLIT.splitPoint), [LEFT, LEFT, LEFT, LEFT])
})

test('a hand with no pads left gives a note up rather than quietly taking the other one', () => {
  const padsOf = handPadsOf(SPLIT)
  // C F A# D# stacks four notes in one column, and the left half holds no other D#
  const chord = [48, 53, 58, 63]

  const ownHand = placeChord(chord, chord, (note) => padsOf(note, LEFT, true))
  assert.deepEqual(ownHand.dropped, [63], 'the left hand cannot read all four')
  assert.deepEqual(halves(ownHand.pads, SPLIT.splitPoint), [LEFT, LEFT, LEFT])

  // Only once that is established does the other hand come into it, and then the
  // whole chord sounds — which is what player.js falls back to, with a warning
  const crossing = placeChord(chord, chord, (note) => padsOf(note, LEFT, false))
  assert.deepEqual(crossing.dropped, [])
  assert.deepEqual(halves(crossing.pads, SPLIT.splitPoint), [LEFT, LEFT, LEFT, RIGHT])
})

test('each hand is placed against its own pads, so the two do not collide', () => {
  const padsOf = handPadsOf(SPLIT)
  const left = placeChord([50, 54, 55], [50, 54, 55], (note) => padsOf(note, LEFT, true))
  const right = placeChord([74, 78, 79], [74, 78, 79], (note) => padsOf(note, RIGHT, true))

  assert.deepEqual(halves(left.pads, SPLIT.splitPoint), [LEFT, LEFT, LEFT])
  assert.deepEqual(halves(right.pads, SPLIT.splitPoint), [RIGHT, RIGHT, RIGHT])
  assert.ok(isReadable([...left.pads.values(), ...right.pads.values()]), 'both hands at once')
})
