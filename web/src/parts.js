/**
 * Which hand a guide note belongs to.
 *
 * Placing a note by pitch alone gets a melody wrong every time it dips below the
 * accompaniment: the note jumps to the other hand for as long as it stays low. A
 * MIDI file already keeps its parts apart, on tracks or channels, so the part
 * decides the hand and the pitch only decides which pad within it.
 *
 * No DOM or MIDI dependencies, so it can be tested in Node.
 */

/**
 * Group note-ons into parts, described by the pitches each one plays.
 *
 * Tracks are the better grouping where a file has them: a piano file usually writes
 * a hand per track while putting both on the same channel. Channels are the fallback.
 *
 * @param {{track: number|undefined, channel: number, note: number, tick: number|undefined}[]} noteOns
 * @returns {{key: string, parts: {id: number, median: number, low: number, high: number, count: number, from: number, to: number}[]}}
 */
export function collectParts(noteOns) {
  const byTrack = groupNotes(noteOns, (event) => event.track)
  const byChannel = groupNotes(noteOns, (event) => event.channel)

  // One track carrying everything says nothing about the parts; channels may still
  const useTracks = byTrack.size > 1
  const key = useTracks ? 'track' : 'channel'
  const grouped = useTracks ? byTrack : byChannel

  const parts = [...grouped]
    .map(([id, events]) => {
      const pitches = events.map((event) => event.note).sort((a, b) => a - b)
      const ticks = events.map((event) => event.tick ?? 0)
      return {
        id,
        median: pitches[Math.floor(pitches.length / 2)],
        low: pitches[0],
        high: pitches[pitches.length - 1],
        count: pitches.length,
        // When the part is playing, which says which other parts it shares hands with
        from: Math.min(...ticks),
        to: Math.max(...ticks),
      }
    })
    .sort((a, b) => a.median - b.median || a.id - b.id)

  return { key, parts }
}

function groupNotes(noteOns, idOf) {
  const grouped = new Map()
  for (const event of noteOns) {
    const id = idOf(event)
    if (id === undefined || id === null) continue
    if (!grouped.has(id)) {
      grouped.set(id, [])
    }
    grouped.get(id).push(event)
  }
  return grouped
}

/**
 * Give each part a side of the split to be played on.
 *
 * Parts are ranked against each other rather than measured against the halves: the
 * lower ones take the lower side. Asking each part which half it fits would put both
 * hands on one side, since parts in the middle of a wide half all answer the same way.
 *
 * Only parts that sound at the same time are ranked together, so a prelude and fugue
 * in one file do not have the second piece decide where the first piece's hands go.
 *
 * @param {{id: number, median: number, from: number, to: number}[]} parts sorted by median
 * @param {{low: number, high: number}[]} ranges the notes each side plays, in side order
 * @returns {Map<number, number>} part id -> side
 */
export function assignSides(parts, ranges) {
  const sides = new Map()
  if (ranges.filter((range) => Number.isFinite(range.low)).length < 2) {
    return sides // nowhere to separate the parts to
  }

  for (const group of concurrentGroups(parts)) {
    if (group.length < 2) {
      continue // one part playing alone has no other hand to be told apart from
    }
    const [lower, higher] = lowestSideFirst(ranges)
    const half = Math.floor(group.length / 2)

    group.forEach((part, i) => {
      if (i < half) {
        sides.set(part.id, lower)
      } else if (i >= group.length - half) {
        sides.set(part.id, higher)
      } else {
        // An odd part in the middle belongs to neither end: let its pitch place it
        sides.set(part.id, deepestSide(part.median, ranges))
      }
    })
  }
  return sides
}

/**
 * Parts that overlap in time, as groups sorted by median pitch. Parts that never
 * sound together are never in the same hands, so they are ranked apart.
 */
function concurrentGroups(parts) {
  const byStart = [...parts].sort((a, b) => (a.from ?? 0) - (b.from ?? 0))
  const groups = []
  let end = -Infinity

  for (const part of byStart) {
    if (!groups.length || (part.from ?? 0) > end) {
      groups.push([])
      end = -Infinity
    }
    groups[groups.length - 1].push(part)
    end = Math.max(end, part.to ?? Infinity)
  }
  return groups.map((group) => group.sort((a, b) => a.median - b.median || a.id - b.id))
}

/** The sides in pitch order, so the lower part can be given the lower one */
function lowestSideFirst(ranges) {
  const order = ranges.map((range, side) => ({ side, middle: (range.low + range.high) / 2 }))
  order.sort((a, b) => a.middle - b.middle)
  return order.map(({ side }) => side)
}

/** The side this pitch sits furthest inside, as deepestInRange does for a single note */
function deepestSide(pitch, ranges) {
  let best = null
  ranges.forEach((range, side) => {
    const depth = Math.min(pitch - range.low, range.high - pitch)
    if (!best || depth > best.depth) {
      best = { side, depth }
    }
  })
  return best.side
}
