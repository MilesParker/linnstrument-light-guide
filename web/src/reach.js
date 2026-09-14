/**
 * What the LinnStrument's sensor can feel at once, and how to fit a chord within it.
 *
 * The surface is a scanned row/column matrix rather than one sensor per pad, so
 * certain combinations of simultaneous touches are indistinguishable from other
 * combinations. The firmware resolves each one by dropping a touch, which to whoever
 * is playing looks like a pad that simply does not sound.
 *
 * Step mode has to know about this. It waits for a chord to be held before moving on,
 * so a chord lit on a shape the sensor cannot read is never completed and the step
 * sits there, which is what a stuck step mode actually is.
 *
 * Two rules, both taken from the firmware (ls_handleTouches.ino):
 *
 *  - No more than three touches in one column. countTouchesInColumn() against
 *    MAX_TOUCHES_IN_COLUMN sends a fourth straight to ignoredCell.
 *  - No four touches on the four corners of a rectangle. Two rows and two columns
 *    with all four intersections pressed read the same as three of them plus
 *    crosstalk, so isPhantomTouchContextual() calls the lightest of the four a
 *    phantom and drops it.
 *
 * Both are limits of the sensing method, not settings, and both are stated in Roger
 * Linn's FAQ:
 * https://www.rogerlinndesign.com/support/support-linnstrument-faqs
 *
 * No DOM or MIDI dependencies, so it can be tested in Node.
 *
 * Coordinates are the app's own pads: x is a 0-based play column, y a row 0-7, the
 * same pairs layout.js produces.
 */

/** ls_handleTouches.ino: a fourth touch in one column is ignored */
export const MAX_TOUCHES_IN_COLUMN = 3

/**
 * How much work the fingering search may do before settling for what it has found.
 * Chords reach a handful of notes and a note a handful of pads, so this is never
 * approached in practice; it is here so a pathological layout cannot hang the poll.
 */
const SEARCH_BUDGET = 20000

/**
 * A set of pads being pressed, kept in the shape the two rules ask about: how many
 * touches each column holds, and which columns are touched on each row.
 */
class Touches {
  constructor() {
    this.pads = []
    this.byColumn = new Map() // x -> count
    this.byRow = new Map()    // y -> Set of x
  }

  has(x, y) {
    return this.byRow.get(y)?.has(x) ?? false
  }

  /**
   * Whether the sensor could read this pad on top of what is already pressed, which
   * is the question both rules answer between them.
   */
  accepts(x, y) {
    if (this.has(x, y)) {
      return false // one touch per pad
    }
    if ((this.byColumn.get(x) ?? 0) >= MAX_TOUCHES_IN_COLUMN) {
      return false // this pad would be the fourth in its column
    }
    // This pad completes a rectangle when some other touched column holds a touch on
    // both this pad's row and the row of another touch in this pad's column
    const columnsOnRow = this.byRow.get(y)
    if (columnsOnRow) {
      for (const [otherY, columns] of this.byRow) {
        if (otherY === y || !columns.has(x)) continue
        for (const otherX of columnsOnRow) {
          if (columns.has(otherX)) {
            return false
          }
        }
      }
    }
    return true
  }

  add(x, y) {
    this.pads.push([x, y])
    this.byColumn.set(x, (this.byColumn.get(x) ?? 0) + 1)
    if (!this.byRow.has(y)) {
      this.byRow.set(y, new Set())
    }
    this.byRow.get(y).add(x)
  }

  remove() {
    const [x, y] = this.pads.pop()
    const count = this.byColumn.get(x) - 1
    if (count) {
      this.byColumn.set(x, count)
    } else {
      this.byColumn.delete(x)
    }
    const columns = this.byRow.get(y)
    columns.delete(x)
    if (!columns.size) {
      this.byRow.delete(y)
    }
  }
}

/** Whether every one of these pads could be held down at once */
export function isReadable(pads) {
  return unreadableReason(pads) === null
}

/**
 * Why these pads cannot all be held at once, as 'pad', 'column' or 'rectangle', or
 * null when they can. Pads are taken in order, so the reason names what the pad that
 * would be dropped runs into.
 */
export function unreadableReason(pads) {
  const touches = new Touches()
  for (const [x, y] of pads) {
    if (touches.has(x, y)) return 'pad'
    if ((touches.byColumn.get(x) ?? 0) >= MAX_TOUCHES_IN_COLUMN) return 'column'
    if (!touches.accepts(x, y)) return 'rectangle'
    touches.add(x, y)
  }
  return null
}

/**
 * Work out where to put the fingers for a chord.
 *
 * A pitch sits on several pads at once, so a chord the sensor cannot read on one set
 * of pads can nearly always be read on another: this is the alternate fingering Roger
 * Linn's FAQ points to. The search takes each note's pads in the order given, so the
 * first pad is the one the guide would light of its own accord and later ones are
 * fallbacks; it only reaches for a fallback when the preferred pad does not fit.
 *
 * Notes already being held cannot move — a finger that is down is down — so they are
 * passed in as `pinned` and the rest are placed around them.
 *
 * Where even that is not enough, the chord is one the instrument genuinely cannot
 * sound in full. Then the largest set of notes that does fit is returned and the rest
 * are named in `dropped`, which is what step mode waits for instead of the whole chord.
 *
 * @param {number[]} notes         the chord, in the order preferences should break ties
 * @param {(note: number) => number[][]} padsFor  a note's pads, most wanted first
 * @param {Map<number, number[]>} [pinned]        notes already held, and the pad holding them
 * @returns {{ pads: Map<number, number[]>, dropped: number[] }}
 */
export function resolveFingering(notes, padsFor, pinned = new Map()) {
  const touches = new Touches()
  const placed = new Map()

  // A held note keeps its pad whatever it costs the rest of the chord. Two fingers
  // cannot already be on pads the sensor could not read, so this always fits.
  for (const note of notes) {
    const pad = pinned.get(note)
    if (pad && touches.accepts(pad[0], pad[1])) {
      touches.add(pad[0], pad[1])
      placed.set(note, pad)
    }
  }

  const free = notes.filter((note) => !placed.has(note) && padsFor(note)?.length)
  const missing = notes.filter((note) => !placed.has(note) && !padsFor(note)?.length)

  let best = null
  let budget = SEARCH_BUDGET

  /**
   * Place the notes from `index` on, keeping the best full or partial fingering seen.
   * Placing a note is tried before leaving it out and its pads in the order given, so
   * the first fingering found at any size is the one closest to what was asked for.
   */
  const place = (index, chosen) => {
    if (budget-- <= 0) return
    if (best && chosen.size + (free.length - index) <= best.size) {
      return // cannot beat what we have, however the rest turns out
    }
    if (index === free.length) {
      if (!best || chosen.size > best.size) {
        best = new Map(chosen)
      }
      return
    }
    const note = free[index]
    for (const [x, y] of padsFor(note)) {
      if (!touches.accepts(x, y)) continue
      touches.add(x, y)
      chosen.set(note, [x, y])
      place(index + 1, chosen)
      chosen.delete(note)
      touches.remove()
      if (best?.size === free.length) return // nothing left to improve on
    }
    place(index + 1, chosen) // this note does not fit around the others
  }

  place(0, new Map())

  for (const [note, pad] of best ?? []) {
    placed.set(note, pad)
  }
  return {
    pads: placed,
    dropped: [...missing, ...free.filter((note) => !placed.has(note))],
  }
}

/**
 * Where to put the hands for one step of a piece.
 *
 * Notes carried over from the step before keep the pad they are already on, since
 * the finger holding one is not going to move off it. A note the step strikes afresh
 * comes up to be played again, so it is free to land wherever the chord needs it,
 * whether or not it was sounding a moment ago.
 *
 * @param {number[]} notes    every note sounding on the step
 * @param {number[]} onsets   the notes of those that are struck on it
 * @param {(note: number) => number[][]} padsFor  a note's pads, most wanted first
 * @param {Map<number, number[]>} [previous]      where the step before put its notes
 * @returns {{ pads: Map<number, number[]>, dropped: number[] }}
 */
export function placeChord(notes, onsets, padsFor, previous = new Map()) {
  const held = new Map()
  for (const note of notes) {
    if (onsets.includes(note)) continue
    const pad = previous.get(note)
    if (pad) {
      held.set(note, pad)
    }
  }
  return resolveFingering(notes, padsFor, held)
}
