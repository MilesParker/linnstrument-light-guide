/**
 * Pad-to-pitch mapping, ported from the LinnStrument firmware
 * (ls_handleTouches.ino: getNoteNumber, determineRowOffsetNote,
 * getSplitBoundaries, getSplitOf).
 *
 * No DOM or MIDI dependencies, so it can be tested in Node.
 *
 * Coordinates: x is 0-based play column (firmware col = x + 1), y is row 0-7.
 * An invalid pad (no pitch, or out of MIDI range) is -1.
 */

export const LEFT = 0
export const RIGHT = 1

// Global Row Offset (NRPN 227) raw values
export const ROWOFFSET_NOOVERLAP = 0
export const ROWOFFSET_OCTAVECUSTOM = 12
export const ROWOFFSET_GUITAR = 13
export const ROWOFFSET_ZERO = 127

// Split Special (NRPN 35 / 135)
export const SPECIAL_OFF = 0
export const SPECIAL_ARP = 1
export const SPECIAL_FADERS = 2
export const SPECIAL_STRUM = 3
export const SPECIAL_SEQUENCER = 4

/** Specials where the split's pads don't play their own pitch */
const UNPITCHED_SPECIALS = [SPECIAL_FADERS, SPECIAL_STRUM, SPECIAL_SEQUENCER]

// Which splits left handed operation reverses (Device.splitHandedness: REV / REVL / REVR)
export const REVERSED_BOTH = 'both'
export const REVERSED_LEFT = 'left'
export const REVERSED_RIGHT = 'right'

/**
 * Device layout as read from the LinnStrument, in firmware units.
 *
 * @typedef {Object} SplitState
 * @property {number} transposeOctave  semitones, (NRPN 36 - 5) * 12
 * @property {number} transposePitch   semitones, NRPN 37 - 7
 * @property {number} transposeLights  semitones, NRPN 38 - 7
 * @property {number} special          NRPN 35 raw value
 *
 * @typedef {Object} DeviceLayout
 * @property {number} columns          play columns: 16 (128) or 25 (200)
 * @property {number} colOffset        app-level column step, 1 on a stock LinnStrument
 * @property {boolean} splitActive
 * @property {number} splitPoint       firmware column where the right split starts (2-25)
 * @property {number} selectedSplit    0 left, 1 right; governs the whole surface when split is off
 * @property {number} rowOffsetMode    NRPN 227 raw value
 * @property {boolean} reversed        left handed operation, NRPN 246
 * @property {string} [reversedSplits] which splits it applies to, from config (see isReversedSplit)
 * @property {number} [customRowOffset] semitones, -17 = inverted guitar (NRPN 253)
 * @property {number[]} [guitarTuning] 8 note numbers (NRPN 263-270)
 * @property {SplitState[]} splits     [left, right]
 */

function numCols(layout) {
  return layout.columns + 1 // firmware NUMCOLS includes the control column
}

export function splitBoundaries(layout, split) {
  if (layout.splitActive) {
    return split === LEFT ? [1, layout.splitPoint] : [layout.splitPoint, numCols(layout)]
  }
  return [1, numCols(layout)]
}

export function splitOf(layout, col) {
  const selectedIsSequencer = layout.splits[layout.selectedSplit].special === SPECIAL_SEQUENCER
  if (layout.splitActive && !selectedIsSequencer) {
    return col < layout.splitPoint ? LEFT : RIGHT
  }
  return layout.selectedSplit
}

/**
 * Whether a split plays right to left, mirroring isLeftHandedSplit() in the firmware.
 * The LinnStrument reports that left handed operation is on, but not which splits it
 * reverses (Device.splitHandedness has no NRPN), so that comes from config.
 */
export function isReversedSplit(layout, split) {
  if (!layout.reversed) {
    return false
  }
  const reversedSplits = layout.reversedSplits ?? REVERSED_BOTH
  return reversedSplits === REVERSED_BOTH
    || (split === LEFT && reversedSplits === REVERSED_LEFT)
    || (split === RIGHT && reversedSplits === REVERSED_RIGHT)
}

export function rowBaseNote(layout, split, row) {
  let lowest = 30
  const mode = layout.rowOffsetMode

  if (mode <= 12) {
    let offset = mode
    if (mode === ROWOFFSET_OCTAVECUSTOM) {
      offset = layout.customRowOffset ?? 12
    }
    if (offset < 0) {
      lowest = 65
    }

    if (mode === ROWOFFSET_NOOVERLAP) {
      const [lowCol, highCol] = splitBoundaries(layout, split)
      offset = highCol - lowCol
      if (layout.splitActive && split === RIGHT) {
        // right split starts where the left one does, like two instruments side by side
        const [leftLow, leftHigh] = splitBoundaries(layout, LEFT)
        lowest -= leftHigh - leftLow
      }
    } else if (offset === -17) { // inverted guitar
      offset = -5
      if (row <= 1) {
        lowest -= 1
      }
    } else if (offset >= 12) {
      lowest = 18
    } else if (offset <= -12) {
      lowest = 18 - 7 * offset
    }

    return lowest + row * offset
  }

  if (mode === ROWOFFSET_GUITAR) {
    return layout.guitarTuning[row]
  }

  return lowest // ROWOFFSET_ZERO
}

/** MIDI note sent by the pad at (x, y), or -1 */
export function padNote(layout, x, y) {
  const col = x + 1
  const split = splitOf(layout, col)
  const s = layout.splits[split]

  if (UNPITCHED_SPECIALS.includes(s.special)) {
    return -1
  }

  // A reversed split ascends right to left, so the pitch comes from the mirrored column
  const noteCol = isReversedSplit(layout, split) ? numCols(layout) - col : col

  const note = rowBaseNote(layout, split, y)
    + (noteCol - 1) * (layout.colOffset ?? 1)
    - s.transposeLights
    + s.transposePitch
    + s.transposeOctave

  return note >= 0 && note <= 127 ? note : -1
}

/** grid[x][y] = MIDI note or -1 */
export function layoutGrid(layout) {
  const grid = []
  for (let x = 0; x < layout.columns; x++) {
    grid[x] = []
    for (let y = 0; y < 8; y++) {
      grid[x][y] = padNote(layout, x, y)
    }
  }
  return grid
}

/** Legacy uniform grid, used when the layout can't be read from the device */
export function uniformGrid(columns, startNoteNumber, rowOffset, colOffset = 1) {
  const grid = []
  for (let x = 0; x < columns; x++) {
    grid[x] = []
    for (let y = 0; y < 8; y++) {
      const note = startNoteNumber + x * colOffset + y * rowOffset
      grid[x][y] = note >= 0 && note <= 127 ? note : -1
    }
  }
  return grid
}

/** note -> [[x, y], ...], every pad on either split that sends that note */
export function gridToDict(grid) {
  const dict = {}
  grid.forEach((column, x) => {
    column.forEach((note, y) => {
      if (note < 0) return
      ;(dict[note] ??= []).push([x, y])
    })
  })
  return dict
}

/** `prefer` value asking for a single pad without naming a side */
export const PREFER_DEEPEST = 'deepest'

/**
 * note -> [[x, y], ...], the pad to light for that note, one per split.
 *
 * A pitch sits on several pads at once, so a chord can light pads spread right
 * across the surface. Keeping only the pad nearest the middle of each split
 * leaves one place to put the finger, near where the hands already are.
 *
 * `prefer` cuts that back to a single pad: PREFER_DEEPEST picks the side the note
 * sits further inside, and LEFT or RIGHT ask for that side, which is how a note is
 * put under the hand its part belongs to. A note the wanted side cannot play falls
 * back to the side that can.
 */
export function gridToCenterDict(grid, layout = null, prefer = null) {
  const regions = padRegions(grid, layout)
  /** note -> region -> the nearest pad found for it so far */
  const nearest = {}

  grid.forEach((column, x) => {
    const region = regions.find((r) => x >= r.from && x <= r.to) ?? regions[0]
    column.forEach((note, y) => {
      if (note < 0) return
      const distance = (x - region.cx) ** 2 + (y - region.cy) ** 2
      const perRegion = (nearest[note] ??= new Map())
      const chosen = perRegion.get(region)
      if (!chosen || distance < chosen.distance) {
        perRegion.set(region, { distance, pad: [x, y] })
      }
    })
  })

  const dict = {}
  for (const note of Object.keys(nearest)) {
    dict[note] = preferredPads(Number(note), [...nearest[note]], prefer)
  }
  return dict
}

/** The pads of `chosen` that `prefer` asks for, as [[x, y], ...] */
function preferredPads(note, chosen, prefer) {
  if (prefer === null || chosen.length === 1) {
    return chosen.map(([, candidate]) => candidate.pad)
  }
  if (prefer !== PREFER_DEEPEST) {
    const wanted = chosen.find(([region]) => region.side === prefer)
    if (wanted) {
      return [wanted[1].pad]
    }
  }
  return [deepestInRange(note, chosen)]
}

/** The lowest and highest note each side of the surface plays, in side order */
export function splitNoteRanges(grid, layout = null) {
  return padRegions(grid, layout).map(({ lowNote, highNote }) => ({ low: lowNote, high: highNote }))
}

/**
 * Of the pads a note has on either side of a split, the one whose side the note
 * sits furthest inside, in semitones from the ends of that side's range. Where the
 * sides overlap this splits it down the middle, so each hand keeps the notes that
 * fall comfortably within its own range. Ties keep the left split.
 */
function deepestInRange(note, chosen) {
  let best = null
  for (const [region, candidate] of chosen) {
    const depth = Math.min(note - region.lowNote, region.highNote - note)
    if (!best || depth > best.depth) {
      best = { depth, pad: candidate.pad }
    }
  }
  return best.pad
}

/**
 * The areas a pad can be nearest the middle of: one per split while the surface is
 * split, otherwise the surface itself. Column ranges are converted from firmware
 * columns to x. Each area carries the pitches it plays, which is what deepestInRange
 * measures against.
 */
function padRegions(grid, layout) {
  const rows = grid[0]?.length ?? 8
  // A layout read from the LinnStrument carries no `columns`; that is the app's
  // own setting, so the count comes from the grid.
  const surface = layout && { ...layout, columns: grid.length }
  const ranges = surface && surface.splitActive
    ? [splitBoundaries(surface, LEFT), splitBoundaries(surface, RIGHT)]
    : [[1, grid.length + 1]]

  return ranges.map(([lowCol, highCol], side) => {
    const from = lowCol - 1
    const to = highCol - 2
    // An unpitched split (faders, strum, the sequencer) has no notes and no range
    const notes = grid.slice(from, to + 1).flat().filter((note) => note >= 0)
    return {
      side, // LEFT or RIGHT, or LEFT alone when the surface is not split
      from,
      to,
      cx: (from + to) / 2,
      cy: (rows - 1) / 2,
      lowNote: Math.min(...notes),
      highNote: Math.max(...notes),
    }
  })
}
