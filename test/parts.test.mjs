import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectParts, assignSides } from '../web/src/parts.js'

/** n note-ons of a part, around a pitch, spread evenly over a stretch of ticks */
const notes = (part, around, n = 20, from = 0, to = 1000) =>
  Array.from({ length: n }, (_, i) => ({
    ...part,
    note: around + (i % 5) - 2,
    tick: Math.round(from + ((to - from) * i) / (n - 1)),
  }))

// Two hands on one channel and a track each, as a piano file usually writes them
const twoTracks = [
  ...notes({ track: 1, channel: 0 }, 72), // right hand
  ...notes({ track: 2, channel: 0 }, 45), // left hand
]

const LEFT = 0
const RIGHT = 1

test('parts: tracks group the parts when the file has more than one', () => {
  const { key, parts } = collectParts(twoTracks)
  assert.equal(key, 'track')
  assert.deepEqual(parts.map((p) => p.id), [2, 1]) // sorted low to high
  assert.equal(parts[0].median, 45)
  assert.equal(parts[1].median, 72)
})

test('parts: channels group them when everything is on one track', () => {
  const oneTrack = [
    ...notes({ track: 1, channel: 0 }, 72),
    ...notes({ track: 1, channel: 1 }, 45),
  ]
  const { key, parts } = collectParts(oneTrack)
  assert.equal(key, 'channel')
  assert.deepEqual(parts.map((p) => p.id), [1, 0])
})

test('parts: a file with nothing to separate gives a single part', () => {
  const { parts } = collectParts(notes({ track: 1, channel: 0 }, 60))
  assert.equal(parts.length, 1)
})

//////////////////////////////////////////
// SIDES                                //
//////////////////////////////////////////

// A split whose halves overlap: left plays 30-72, right 50-92
const ranges = [{ low: 30, high: 72 }, { low: 50, high: 92 }]

test('sides: two parts are ranked, lower part to the lower side', () => {
  const { parts } = collectParts(twoTracks)
  const sides = assignSides(parts, ranges)
  assert.equal(sides.get(2), LEFT)  // the lower part
  assert.equal(sides.get(1), RIGHT) // the higher part
})

test('sides: two parts stay apart even when both sit in the overlap', () => {
  const { parts } = collectParts([
    ...notes({ track: 1, channel: 0 }, 62),
    ...notes({ track: 2, channel: 0 }, 58),
  ])
  const sides = assignSides(parts, ranges)
  assert.equal(sides.get(2), LEFT)
  assert.equal(sides.get(1), RIGHT)
  // which is the point: by pitch alone both parts would land on the same side
})

test('sides: four voices are ranked two to a hand', () => {
  const { parts } = collectParts([
    ...notes({ track: 1, channel: 0 }, 76), // soprano
    ...notes({ track: 2, channel: 0 }, 67), // alto
    ...notes({ track: 3, channel: 0 }, 55), // tenor
    ...notes({ track: 4, channel: 0 }, 43), // bass
  ])
  const sides = assignSides(parts, ranges)
  assert.equal(sides.get(4), LEFT)
  assert.equal(sides.get(3), LEFT)
  assert.equal(sides.get(2), RIGHT)
  assert.equal(sides.get(1), RIGHT)
})

test('sides: a single part is not routed anywhere', () => {
  const { parts } = collectParts(notes({ track: 1, channel: 0 }, 60))
  assert.equal(assignSides(parts, ranges).size, 0)
})

test('sides: nothing is routed without two sides to route between', () => {
  const { parts } = collectParts(twoTracks)
  assert.equal(assignSides(parts, [{ low: 30, high: 92 }]).size, 0)
  // an unpitched half (faders, strum, sequencer) has no range and cannot take a part
  assert.equal(assignSides(parts, [{ low: 30, high: 72 }, { low: Infinity, high: -Infinity }]).size, 0)
})

test('sides: the lower side is found by range, not by being first', () => {
  const { parts } = collectParts(twoTracks)
  // right half transposed below the left, as a left handed player might set it up
  const flipped = [{ low: 60, high: 100 }, { low: 30, high: 70 }]
  const sides = assignSides(parts, flipped)
  assert.equal(sides.get(2), RIGHT) // the lower part goes to the lower ranged half
  assert.equal(sides.get(1), LEFT)
})

//////////////////////////////////////////
// PARTS THAT NEVER PLAY TOGETHER       //
//////////////////////////////////////////

// A prelude and fugue in one file, as bach_846.mid holds them: two hands up to
// tick 65281, then four voices from tick 67440 on
const preludeAndFugue = [
  ...notes({ track: 1, channel: 0 }, 64, 20, 241, 65281),    // prelude right hand
  ...notes({ track: 2, channel: 0 }, 53, 20, 1, 65281),      // prelude left hand
  ...notes({ track: 3, channel: 2 }, 74, 20, 70320, 118080), // fugue soprano
  ...notes({ track: 4, channel: 3 }, 67, 20, 67440, 118080), // fugue alto
  ...notes({ track: 5, channel: 4 }, 59, 20, 73200, 117120), // fugue tenor
  ...notes({ track: 6, channel: 5 }, 52, 20, 76080, 111360), // fugue bass
]

test('sides: a piece is ranked against the parts it plays with, not the whole file', () => {
  const { parts } = collectParts(preludeAndFugue)
  const sides = assignSides(parts, ranges)

  // The prelude is a pair of hands in its own right, whatever the fugue does later
  assert.equal(sides.get(1), RIGHT, 'prelude right hand')
  assert.equal(sides.get(2), LEFT, 'prelude left hand')
  // and the fugue's voices are ranked among themselves
  assert.equal(sides.get(3), RIGHT)
  assert.equal(sides.get(4), RIGHT)
  assert.equal(sides.get(5), LEFT)
  assert.equal(sides.get(6), LEFT)
})

test('sides: both hands are always used, whatever the halves happen to span', () => {
  const { parts } = collectParts(preludeAndFugue)
  // Halves that fit the parts badly: a wide low half a part can sit deep inside,
  // and a high half transposed well above the music. Ranking has to hold anyway.
  for (const pair of [
    [{ low: 30, high: 76 }, { low: 54, high: 101 }],
    [{ low: 30, high: 72 }, { low: 62, high: 104 }],
    [{ low: 30, high: 92 }, { low: 88, high: 127 }],
  ]) {
    const sides = assignSides(parts, pair)
    assert.equal(sides.get(1), RIGHT, `prelude right hand, halves ${JSON.stringify(pair)}`)
    assert.equal(sides.get(2), LEFT, `prelude left hand, halves ${JSON.stringify(pair)}`)
    for (const group of [[1, 2], [3, 4, 5, 6]]) {
      const used = new Set(group.map((id) => sides.get(id)))
      assert.equal(used.size, 2, `both hands used by ${group}`)
    }
  }
})

test('sides: three parts put the outer two apart and place the middle by pitch', () => {
  const { parts } = collectParts([
    ...notes({ track: 1, channel: 0 }, 76),
    ...notes({ track: 2, channel: 0 }, 62),
    ...notes({ track: 3, channel: 0 }, 43),
  ])
  const sides = assignSides(parts, ranges)
  assert.equal(sides.get(3), LEFT)
  assert.equal(sides.get(1), RIGHT)
  // 62 sits 10 semitones inside the left half (30-72) and 12 inside the right
  // half (50-92), so the right hand takes it
  assert.equal(sides.get(2), RIGHT)
})

test('sides: a part playing alone in its own stretch is left unrouted', () => {
  const { parts } = collectParts([
    ...notes({ track: 1, channel: 0 }, 72, 20, 0, 1000),
    ...notes({ track: 2, channel: 0 }, 48, 20, 0, 1000),
    ...notes({ track: 3, channel: 0 }, 60, 20, 9000, 10000), // a solo coda, nothing beside it
  ])
  const sides = assignSides(parts, ranges)
  assert.equal(sides.get(1), RIGHT)
  assert.equal(sides.get(2), LEFT)
  assert.equal(sides.has(3), false)
})
