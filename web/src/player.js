/**
 * Plays a local MIDI file straight into the Light Guide.
 *
 * Uses JZZ.MIDI.SMF, which the page already loads for the recorder, so this
 * needs no virtual MIDI port, no loopback driver and no external player.
 *
 * Real time mode forwards the file as it plays. Step mode lights one chord at a
 * time and waits until that chord has actually been played (see buildSteps).
 */

import { ext, guideNoteOn, guideNoteOff, highlightInstrument, highlightInstrumentXY, highlightVisualization, highlightVisualizationXY, recolorGuideNote, refreshPartSides, litPads, layoutPads, setPadOverrides } from "./main.js"
import { COLOR_OFF } from "./grid.js"
import { LEFT, RIGHT } from "./layout.js"
import { collectParts } from "./parts.js"
import { placeChord } from "./reach.js"
import { log } from "./log.js"

const DRUM_CHANNEL = 9 // GM channel 10, zero-based

/** How often step mode looks at what is currently held down (in ms) */
const STEP_POLL_INTERVAL = 25
/** How long a re-struck note goes dark before lighting up again (in ms) */
const RESTRIKE_BLINK = 90
/**
 * Notes starting within this fraction of a beat belong to the same step. 1/16th of a
 * beat is a 64th note, below any division worth stepping to, so this only merges
 * notes meant to sound together.
 */
const CHORD_FRACTION = 16

/**
 * Playback speeds, as a fraction of the file's own tempo. Coarse further down, where
 * a passage is taken right back to learn it, finer around full speed where it is
 * worked back up.
 */
const SPEEDS = [0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 2]
const FULL_SPEED = SPEEDS.indexOf(1)
/** Kept out of the config: it belongs to the song being learned, not the setup */
const SPEED_KEY = 'playerSpeed'

let player = null
let speedIndex = FULL_SPEED
/** Notes currently lit as guide notes, note -> { color, side } of the pad lit for it */
const activeNotes = new Map()
/** Notes lit only as a look ahead to the next step, note -> { color, side } */
const previewNotes = new Map()
/**
 * Notes held when the step does not want them, note -> { pads, ringed }: the pads
 * lit for the note, and whether those are known to be under the finger
 */
const strayNotes = new Map()
/** Notes held that the step does not want, note -> when that started, for errorDelay */
const straySince = new Map()
/** Pads lit around the stray notes, "x,y" -> [x, y], so there is something to see */
const strayRing = new Map()
/** Where the current step lit each of its notes, note -> pads */
let litThisStep = new Map()
/** Where the step before lit each of its notes, which is where a finger left behind is */
let litLastStep = new Map()

/** Chords to step through, rebuilt for each loaded file */
let steps = []
let stepIndex = 0
let stepStartedAt = 0
let stepTimer = null
/** Where the current step puts each of its notes, note -> [x, y] (see reach.js) */
let fingering = new Map()
/** How many of the current step's notes the sensor can read at once */
let stepReach = 0
/** Bumped on every step change and on stop, so a pending blink cannot outlive its step */
let generation = 0
/**
 * Repaints the Player group for the mode it is in: which pair of keys the last two
 * slots carry, and what the readout over them says. Set once the panel is registered.
 */
let showTransport = () => {}

export function registerPlayerEvents() {
  const fileEl = document.getElementById('midiFile')
  const playEl = document.getElementById('player-play')
  const stopEl = document.getElementById('player-stop')
  const stepEl = document.getElementById('player-step')
  const fileNameEl = document.getElementById('midi-file-name')
  const slowerEl = document.getElementById('player-slower')
  const fasterEl = document.getElementById('player-faster')
  const speedEl = document.getElementById('player-speed')
  const backEl = document.getElementById('player-back')
  const nextEl = document.getElementById('player-next')

  if (!fileEl || !playEl || !stopEl || !stepEl || !fileNameEl || !slowerEl || !fasterEl || !speedEl ||
    !backEl || !nextEl) {
    return
  }

  backEl.addEventListener('click', () => moveStep(-1))
  nextEl.addEventListener('click', () => moveStep(1))

  speedIndex = storedSpeedIndex()

  /**
   * The panel has no room for both pairs, and neither pair means anything in the
   * other's mode: a tempo cannot be scaled when the playing sets the pace, and there
   * is no step to move while the file runs in time. So the last two slots carry
   * whichever pair the mode calls for, and the readout over them follows suit —
   * the speed there, or how far through the steps this is.
   */
  showTransport = () => {
    const stepping = stepEl.checked
    slowerEl.hidden = stepping
    fasterEl.hidden = stepping
    backEl.hidden = !stepping
    nextEl.hidden = !stepping

    // Each key is dimmed where it has nowhere left to go
    slowerEl.disabled = speedIndex === 0
    fasterEl.disabled = speedIndex === SPEEDS.length - 1
    backEl.disabled = !stepTimer || stepIndex === 0
    nextEl.disabled = !stepTimer || stepIndex >= steps.length - 1

    speedEl.textContent = stepping ? stepCount() : `${Math.round(SPEEDS[speedIndex] * 100)}%`
    speedEl.classList.toggle('off-tempo', !stepping && speedIndex !== FULL_SPEED)
  }

  /** Takes effect on the spot, mid-song included: JZZ rebases its clock on the new speed */
  const setSpeed = (index) => {
    speedIndex = Math.min(SPEEDS.length - 1, Math.max(0, index))
    localStorage.setItem(SPEED_KEY, String(SPEEDS[speedIndex]))
    if (player) {
      player.speed(SPEEDS[speedIndex])
    }
    showTransport()
  }

  slowerEl.addEventListener('click', () => setSpeed(speedIndex - 1))
  fasterEl.addEventListener('click', () => setSpeed(speedIndex + 1))
  stepEl.addEventListener('change', showTransport)
  showTransport()

  /** Printed across the group's rule, so the key it was loaded with keeps its own label */
  const setFileName = (name) => {
    fileNameEl.textContent = name.length > 24 ? `${name.slice(0, 23)}…` : name
  }

  fileEl.addEventListener('change', async (event) => {
    const file = event.target.files[0]
    if (!file) return
    try {
      stopPlayback()
      player = loadPlayer(await file.arrayBuffer())
      playEl.disabled = false
      stopEl.disabled = false
      setFileName(file.name)
      showTransport()
      const seconds = Math.round(player.durationMS() / 1000)
      log.success(`Loaded MIDI file: ${file.name} (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}, ${steps.length} steps)`)
    } catch (err) {
      player = null
      steps = []
      ext.parts = null
      refreshPartSides()
      playEl.disabled = true
      stopEl.disabled = true
      setFileName('')
      showTransport()
      log.error(`Could not read MIDI file: ${file.name}`)
      console.error(err)
    }
  })

  playEl.addEventListener('click', () => {
    if (!player) return
    stopPlayback()
    if (stepEl.checked) {
      startStepMode()
    } else {
      // Each loaded file gets a fresh player, which starts back at full speed
      player.speed(SPEEDS[speedIndex])
      player.play()
    }
  })

  stopEl.addEventListener('click', stopPlayback)
}

/** Where the stepping is up to, or what there is of it before it has begun */
function stepCount() {
  if (stepTimer) {
    return `${stepIndex + 1} / ${steps.length}`
  }
  return steps.length ? `${steps.length} steps` : ''
}

/** The speed left over from the last session, as long as it is still one of ours */
function storedSpeedIndex() {
  const index = SPEEDS.indexOf(parseFloat(localStorage.getItem(SPEED_KEY)))
  return index === -1 ? FULL_SPEED : index
}

function loadPlayer(arrayBuffer) {
  const smf = new JZZ.MIDI.SMF(toBinaryString(arrayBuffer))
  const p = smf.player()

  // Which hand plays what, before anything is built from the events or played
  ext.parts = collectParts(noteOnsOf(p._data))
  refreshPartSides()

  // Built before anything plays, from the same event list the player runs on
  steps = buildSteps(p._data, p.ppqn)

  p.connect((msg) => {
    const status = msg[0] & 0xf0
    const channel = msg[0] & 0x0f

    // GM drums would light pads for every kick and snare
    if (channel === DRUM_CHANNEL) return

    const note = msg[1]
    const velocity = msg[2]

    if (status === 0x90 && velocity > 0) {
      lightOn(note, channel + 1, velocity, ext.config.guideHighlightColor, sideOf(partOf(msg)))
    } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
      lightOff(note, channel + 1, velocity)
    }
  })

  return p
}

/** Every note the file starts, with what it takes to tell its parts apart */
function noteOnsOf(data) {
  const noteOns = []
  for (const msg of data) {
    if ((msg[0] & 0xf0) !== 0x90 || msg[2] === 0) continue
    if ((msg[0] & 0x0f) === DRUM_CHANNEL) continue
    noteOns.push({ track: msg.track, channel: msg[0] & 0x0f, note: msg[1], tick: msg.tt })
  }
  return noteOns
}

/** The part a file event belongs to, under whichever grouping this file supports */
function partOf(msg) {
  return ext.parts?.key === 'track' ? msg.track : msg[0] & 0x0f
}

/** The side that part is played on, or null when the parts are not routed */
function sideOf(part) {
  return ext.partSides?.get(part) ?? null
}

/** Stop whichever mode is running and clear whatever it left lit */
function stopPlayback() {
  generation++
  if (stepTimer) {
    clearInterval(stepTimer)
    stepTimer = null
  }
  if (player) {
    player.stop()
  }
  allNotesOff()
  showTransport()
}

//////////////////////////////////////////
// STEP MODE                            //
//////////////////////////////////////////

/**
 * Group the file's notes into one step per set of notes that start together.
 *
 * A step carries every note sounding once it has begun, not just the new ones, so a
 * note held across several steps keeps its light. `onsets` are the notes that start
 * on the step and so need a press of their own.
 *
 * Notes are rarely written exactly on the tick, so anything within a 64th note of
 * the step joins it. Splitting a chord that way would deadlock it: its later notes
 * are already held by the time their step comes up, so could never be pressed afresh.
 */
function buildSteps(data, ppqn) {
  const events = []
  for (const msg of data) {
    const status = msg[0] & 0xf0
    if ((msg[0] & 0x0f) === DRUM_CHANNEL) continue
    if (status === 0x90 && msg[2] > 0) {
      events.push({ tick: msg.tt, note: msg[1], on: true, part: partOf(msg) })
    } else if (status === 0x80 || (status === 0x90 && msg[2] === 0)) {
      events.push({ tick: msg.tt, note: msg[1], on: false })
    }
  }
  // Note offs before note ons within a tick, so a note struck again reads as a new onset
  events.sort((a, b) => a.tick - b.tick || (a.on ? 1 : 0) - (b.on ? 1 : 0))

  const result = []
  /** note -> { count, part }: overlapping note ons, so a doubled note is not dropped early */
  const sounding = new Map()
  let i = 0

  // SMPTE timed files carry no ppqn, so fall back to the JZZ default
  const chordTicks = Math.max(1, Math.round((ppqn || 96) / CHORD_FRACTION))

  while (i < events.length) {
    const stepTick = events[i].tick
    const onsets = new Set()

    while (i < events.length && events[i].tick - stepTick <= chordTicks) {
      const event = events[i++]
      if (event.on) {
        // The part of the note starting now, which is the hand it is to be played with
        sounding.set(event.note, { count: (sounding.get(event.note)?.count ?? 0) + 1, part: event.part })
        onsets.add(event.note)
      } else {
        const held = sounding.get(event.note)
        if (held && held.count > 1) {
          sounding.set(event.note, { ...held, count: held.count - 1 })
        } else {
          sounding.delete(event.note)
        }
      }
    }

    // A tick that only ends notes is not a step of its own. A note that starts and
    // ends again inside one step is dropped too: nothing lights up for it, so
    // waiting for it to be pressed would stall.
    if (onsets.size) {
      result.push({
        notes: [...sounding.keys()],
        onsets: [...onsets].filter((note) => sounding.has(note)),
        parts: new Map([...sounding].map(([note, { part }]) => [note, part])),
      })
    }
  }

  return result
}

function startStepMode() {
  if (!steps.length) {
    log.warn(`No notes to step through in this MIDI file.`)
    return
  }
  stepIndex = 0
  showStep()
  stepTimer = setInterval(checkStep, STEP_POLL_INTERVAL)
  showTransport()
  log.info(`Step mode: play the lit notes to advance, ${steps.length} steps in total.`)
}

/**
 * Move the step on or back by hand, rather than by playing it.
 *
 * Step mode is otherwise paced entirely by whoever is playing, which leaves nothing
 * for a passage being worked on: a step is played wrong and there is no way back to
 * it, or a step is to be looked at rather than played. The step lands exactly as the
 * playing would have left it, so the one it moves to still waits to be played.
 *
 * @returns {boolean} whether there was a step to move to
 */
function moveStep(delta) {
  if (!stepTimer) {
    return false // not in step mode, so there is no step to move
  }
  const index = stepIndex + delta
  if (index < 0 || index >= steps.length) {
    return false // already at one end of the file
  }
  stepIndex = index
  showStep()
  return true
}

/**
 * Light the current step, leaving held notes alone and blinking re-struck ones.
 * Strikes, holds and the next step's notes get their own colors, so a lit pad says
 * what to do with it rather than only that it is part of the step.
 */
function showStep() {
  const step = steps[stepIndex]
  const next = steps[stepIndex + 1]
  const lit = new Set(activeNotes.keys())
  const current = ++generation

  clearPreview()
  clearStrayNotes()

  // Worked out before anything moves, while the pads the notes are lit on are still
  // the ones the fingers are actually resting on
  const overrides = placeStep(step, next)

  for (const note of lit) {
    // The note ended on this step, or it has been moved to another pad and has to be
    // put out where it is before it can be lit afresh. Where it is now is what the
    // hand it was lit under says, not the hand this step would light it under.
    const where = litPads(note, activeNotes.get(note).side)
    if (!step.notes.includes(note) || !samePad(fingering.get(note), where?.[0])) {
      lightOff(note)
    }
  }

  setPadOverrides(overrides)
  litLastStep = litThisStep
  litThisStep = new Map()

  for (const note of step.notes) {
    // A note the sensor has no room for is left dark rather than lit on a pad that
    // would be ignored. The step does not wait for it either, so it is not a note to
    // go looking for; the log says which notes these were.
    if (isPlayable(note) && !fingering.has(note)) continue

    const color = stepColor(note, step, next)
    const side = sideOf(step.parts.get(note))
    litThisStep.set(note, litPads(note, side) ?? [])
    if (!activeNotes.has(note)) {
      lightOn(note, 1, 100, color, side) // note starts on this step, or has moved pad
    } else if (step.onsets.includes(note)) {
      // Lit note struck again: go dark briefly, or it reads as a note to keep holding
      lightOff(note)
      setTimeout(() => {
        if (current === generation) {
          lightOn(note, 1, 100, color, side)
        }
      }, RESTRIKE_BLINK)
    } else {
      recolor(note, color) // struck on an earlier step, only held from here on
    }
  }

  showPreview(step, next)
  markFutures(step, next)
  updateStrayNotes()
  showTransport()

  stepStartedAt = performance.now()
}

//////////////////////////////////////////
// FINGERING                            //
//////////////////////////////////////////

// Where to put the hands for a step. The sensor cannot read every shape (see
// reach.js), and the pad nearest the middle of the split — which is what the guide
// lights left to itself — walks into that surprisingly often: a four note chord
// lands on the corners of a rectangle, or stacked fourths land in one column, and
// the step waits for a note the instrument was never going to send.

/**
 * Place the current step's notes on pads the sensor can read together, and record in
 * `stepReach` how many of them it can read at all, which is what the step waits for.
 *
 * The next step's notes are placed at the same time, so the look ahead points at the
 * pad the note will really be wanted on. That placement is worked out again once the
 * step comes round, from the same notes held in the same places, so it lands where
 * the look ahead said it would.
 *
 * @returns {Map<number, number[][]>} the notes that had to move, and where to
 */
function placeStep(step, next) {
  const wanted = step.notes.filter(isPlayable)
  const here = placeUnderHands(step, fingering)

  fingering = here.pads
  stepReach = wanted.length - here.dropped.filter(isPlayable).length

  // Only the step being played is reported on. The one after it is placed here too,
  // but it gets its say when it comes round and is placed again.
  const at = `Step ${stepIndex + 1} of ${steps.length}`
  if (stepReach < wanted.length) {
    log.warn(`${at}: the sensor cannot read all of ${wanted.length} notes here at once, so ${stepReach} of them ` +
      `moves it on. Not lit: ${here.dropped.filter(isPlayable).map(noteName).join(', ')}.`)
  }
  if (here.crossed.length) {
    log.warn(`${at}: ${here.crossed.map(noteName).join(', ')} lights under the other hand, as its own has no pad ` +
      `left that the sensor can read alongside the rest of the chord.`)
  }

  const ahead = next ? placeUnderHands(next, here.pads).pads : new Map()

  const overrides = new Map()
  const place = (note, pad, parts) => {
    // Only a note that had to move is overridden, so every other pad lights exactly
    // where the Duplicate Note Pads setting puts it
    const side = sideOf(parts.get(note))
    if (!samePad(pad, layoutPads(note, side)?.[0])) {
      overrides.set(note, { pads: [pad], side })
    }
  }
  for (const [note, pad] of here.pads) {
    place(note, pad, step.parts)
  }
  for (const [note, pad] of ahead) {
    // The step being played owns any note both of them hold: a note struck again next
    // step is free to land elsewhere then, but it is lit where it is played now
    if (!here.pads.has(note)) {
      place(note, pad, next.parts)
    }
  }
  return overrides
}

/**
 * Place a step's notes, keeping each one under the hand its part was routed to.
 *
 * A note only crosses to the other half where the chord cannot be read at all with
 * both hands keeping their own parts, which is the same thing that already happens to
 * a part reaching past the half it was given. Trying the hands' own pads as a whole
 * first matters: taken note by note, one note crossing early would hide a fingering
 * the hand had all along.
 *
 * @returns {{ pads: Map<number, number[]>, dropped: number[], crossed: number[] }}
 */
function placeUnderHands(step, previous) {
  const ownHands = placeChord(step.notes, step.onsets, (note) => padsFor(note, step, true), previous)
  if (!ownHands.dropped.some(isPlayable)) {
    return { ...ownHands, crossed: [] }
  }

  const crossing = placeChord(step.notes, step.onsets, (note) => padsFor(note, step, false), previous)
  if (crossing.pads.size <= ownHands.pads.size) {
    return { ...ownHands, crossed: [] } // crossing bought nothing, so leave the hands alone
  }

  const crossed = [...crossing.pads]
    .filter(([note, [x]]) => {
      const home = layoutPads(note, sideOf(step.parts.get(note)))?.[0]
      return home && halfOf(x) !== halfOf(home[0])
    })
    .map(([note]) => note)
  return { ...crossing, crossed }
}

/**
 * Every pad that sends a note, the one the guide would light of its own accord first
 * and the rest ordered by how far the hand has to reach for them. Rows count for
 * more than columns: the fingers already span several columns, but a row is a
 * different string to the hand.
 *
 * `ownHandOnly` drops the pads under the other hand, which is how a note is kept with
 * the part it belongs to.
 */
function padsFor(note, step, ownHandOnly) {
  const own = layoutPads(note, sideOf(step.parts.get(note))) ?? []
  const [ox, oy] = own[0] ?? []
  const hand = ox === undefined ? null : halfOf(ox)
  const cost = ([x, y]) => ox === undefined ? 0 : (x - ox) ** 2 + 4 * (y - oy) ** 2
  const rest = (ext.gridDict?.[note] ?? [])
    .filter(([x, y]) => !own.some(([px, py]) => px === x && py === y))
    .sort((a, b) => cost(a) - cost(b))
  return ownHandOnly
    ? [...own, ...rest.filter(([x]) => halfOf(x) === hand)]
    : [...own, ...rest.filter(([x]) => halfOf(x) === hand), ...rest.filter(([x]) => halfOf(x) !== hand)]
}

/**
 * Which half of the surface a pad is on, or null while it is not split and there is
 * only the one. splitPoint is the firmware column the right half starts at, and x
 * is that column less the control column.
 */
function halfOf(x) {
  const layout = ext.deviceLayout
  return layout?.splitActive ? (x + 1 < layout.splitPoint ? LEFT : RIGHT) : null
}

function samePad(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1]
}

/** Note numbers mean little to whoever is playing, so the log names the note */
function noteName(note) {
  return new Note(note).identifier
}

//////////////////////////////////////////
// STEP COLORS                          //
//////////////////////////////////////////

// The colors a pad can carry in step mode. Only the press color is a plain
// setting; the others fall back rather than going dark when switched off, so
// turning one off leaves step mode looking exactly as it did without it.

/** Notes this step strikes and lets go of again, which is what the Light Guide color has always meant */
function pressColor() {
  return ext.config.guideHighlightColor
}

/** Notes that are not to be lifted, whether struck now or on an earlier step */
function holdColor() {
  const color = ext.config.stepHoldColor
  return color === COLOR_OFF ? pressColor() : color
}

/** Notes the next step strikes, lit while still dark, as a look ahead */
function previewColor() {
  return ext.config.stepNextColor
}

/** Notes the next step strikes again, which have to come up before it does */
function repeatColor() {
  return ext.config.stepRepeatColor
}

/** Notes being held that this step does not want, so the pad to lift is visible */
function errorColor() {
  return ext.config.stepErrorColor
}

/**
 * How long a note has to be held after the step stops wanting it before it shows as
 * wrongly held. A step turns the moment its last note goes down, with every finger of
 * the chord still on its pad, so without this each step would open with the chord
 * just played lit as a mistake while it is being lifted.
 */
function errorDelay() {
  const delay = ext.config.stepErrorDelay
  return Number.isFinite(delay) && delay >= 0 ? delay : 400
}

/**
 * The color a note of the current step is lit with: what to do with the pad now,
 * together with what becomes of it when the step turns. A pad needs both at once,
 * and it carries them from the moment it lights rather than changing under the
 * finger a step later, by which time the cue has come too late to act on.
 *
 *                   ends this step   held on into next   struck again next
 *   struck now      press            hold                repeat
 *   already down    hold             hold                repeat
 *
 * A note the next step strikes again reads the same whichever row it is in, because
 * the instruction is the same: this pad has to come up before the step turns. What
 * to do with it until then is answered by whether a finger is already on it.
 *
 * The one pairing left standing is a note already down that ends with this step,
 * which shares the hold color with one that carries on. Held a step too long it
 * becomes a note the next step has no use for, which the error color catches, and
 * the sustain outline separates the two on the visualization.
 */
function stepColor(note, step, next) {
  const heldOn = !step.onsets.includes(note)          // already down when the step began
  const again = !!next && next.onsets.includes(note)  // the next step strikes it afresh
  const kept = !!next && next.notes.includes(note)    // still sounding on the next step

  if (again && repeatColor() !== COLOR_OFF) {
    return repeatColor()
  }
  // Switched off, a repeated note falls back to what its pad said before this color
  // existed: already down stays a held note, struck now stays a note to strike.
  if (heldOn || (kept && !again)) {
    return holdColor()
  }
  return pressColor()
}

/**
 * Light the notes the next step strikes, so the hands can be on their way.
 *
 * These are not notes to play yet, so they bypass guideNoteOn: counted as guide notes
 * they would be measured in the timing statistics and recorded a step too early.
 * Only notes that are dark right now; markFutures covers the rest.
 */
function showPreview(step, next) {
  const color = previewColor()
  if (!next || color === COLOR_OFF) {
    return
  }
  for (const note of next.onsets) {
    if (step.notes.includes(note)) continue
    const side = sideOf(next.parts.get(note))
    previewNotes.set(note, { color, side })
    highlightInstrument(note, color, side)
    highlightVisualization(note, color, 'preview', false, side)
  }
}

function clearPreview() {
  for (const [note, { side }] of [...previewNotes]) {
    previewNotes.delete(note)
    highlightInstrument(note, 0, side)
    highlightVisualization(note, 0, 'preview', false, side)
  }
}

/**
 * Outline the lit pads held on into the next step, which is the one thing the colors
 * leave paired: a note already down that ends with this step carries the same hold
 * color as one that carries on past it. A pad is a single color on the instrument,
 * so this cannot be a color there without covering up what to do with the pad now.
 */
function markFutures(step, next) {
  clearFutureMarks()
  if (!next || !ext.config.stepFutureOutlines) {
    return
  }
  for (const note of step.notes) {
    if (isPlayable(note) && !fingering.has(note)) continue // not lit, so nothing to outline
    // A note struck again on the next step is not held on: the repeat color has it
    if (next.notes.includes(note) && !next.onsets.includes(note)) {
      markCells(note, 'step-sustains', sideOf(step.parts.get(note)))
    }
  }
}

function markCells(note, className, side = null) {
  for (const [x, y] of litPads(note, side) ?? []) {
    const cell = document.getElementById(`cell-${x}-${y}`)
    if (cell) {
      cell.classList.add(className)
    }
  }
}

function clearFutureMarks() {
  document.querySelectorAll('.step-sustains').forEach((el) => {
    el.classList.remove('step-sustains')
  })
}

/**
 * Light the pads being held that the step has no note for, so a finger left behind
 * shows up as the thing to lift. A step never waits on these, but they still matter:
 * where the next step strikes that note again, the held finger blocks the press that
 * would advance, which just looks like a step that will not move on.
 *
 * The pad under the finger cannot show it on the instrument, though: the firmware
 * paints a touched pad in its played color over anything sent to it. So the pads
 * around it are lit as well, leaving the held pad as the dark one in a ring of the
 * error color. The instrument reports the note and not the pad, so this is only done
 * for a note the step before lit, which is where the finger holding it went.
 *
 * Nothing shows until the note has been held for errorDelay, so lifting the chord
 * just played is not taken for a mistake. Run on every poll, since what is held
 * changes while a step is being worked out, and so the delay runs out on its own.
 */
function updateStrayNotes() {
  const color = errorColor()
  const step = steps[stepIndex]
  const stray = new Set()
  const now = performance.now()

  const unwanted = new Set()
  if (step && color !== COLOR_OFF) {
    for (const note of ext.heldNotes) {
      if (!step.notes.includes(note)) {
        unwanted.add(note)
      }
    }
  }
  for (const note of [...straySince.keys()]) {
    if (!unwanted.has(note)) straySince.delete(note)
  }
  for (const note of unwanted) {
    if (!straySince.has(note)) straySince.set(note, now)
    if (now - straySince.get(note) >= errorDelay()) stray.add(note)
  }

  for (const note of stray) {
    if (strayNotes.has(note)) continue
    // A note the last step lit is under the finger it was lit for. Anything else
    // could be on any of its pads, so it gets no ring: the one the layout lights
    // stands in for it on the visualization, as the played note does.
    const left = litLastStep.get(note)
    const pads = left ?? litPads(note, previewNotes.get(note)?.side ?? null) ?? []
    strayNotes.set(note, { pads, ringed: !!left })
    for (const [x, y] of pads) {
      highlightInstrumentXY(x, y, color)
      highlightVisualizationXY(x, y, color, 'error', true)
    }
  }
  for (const [note, { pads }] of [...strayNotes]) {
    if (stray.has(note)) continue
    strayNotes.delete(note)
    for (const [x, y] of pads) {
      restorePad(x, y)
    }
  }

  updateStrayRing(step, color)
}

/**
 * Light the pads around each stray note, leaving out any pad this step or the look
 * ahead lights, since those are telling the hand where to go, and the stray pads
 * themselves.
 */
function updateStrayRing(step, color) {
  const want = new Map()

  if ([...strayNotes.values()].some(({ ringed }) => ringed)) {
    const skip = new Set()
    for (const { pads } of strayNotes.values()) {
      for (const pad of pads) skip.add(padKey(pad))
    }
    for (const note of step.notes) {
      for (const pad of litPads(note, sideOf(step.parts.get(note))) ?? []) skip.add(padKey(pad))
    }
    for (const [x, y] of appLitPads()) skip.add(padKey([x, y]))

    const columns = ext.config.linnStrumentSize / 8
    for (const { pads, ringed } of strayNotes.values()) {
      if (!ringed) continue
      for (const [cx, cy] of pads) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const x = cx + dx
            const y = cy + dy
            if (x < 0 || x >= columns || y < 0 || y > 7) continue
            const key = padKey([x, y])
            if (!skip.has(key)) want.set(key, [x, y])
          }
        }
      }
    }
  }

  for (const [key, [x, y]] of want) {
    if (strayRing.has(key)) continue
    strayRing.set(key, [x, y])
    highlightInstrumentXY(x, y, color) // the visualization can show the held pad itself
  }
  for (const [key, [x, y]] of [...strayRing]) {
    if (want.has(key)) continue
    strayRing.delete(key)
    restorePad(x, y)
  }
}

/** Every pad the guide or the look ahead has lit, with the color it is lit in */
function* appLitPads() {
  for (const [note, { color, side }] of [...activeNotes, ...previewNotes]) {
    for (const [x, y] of litPads(note, side) ?? []) yield [x, y, color]
  }
}

/** Put a pad back to whatever the guide or the look ahead has on it, or dark */
function restorePad(x, y) {
  let color = 0
  for (const [px, py, lit] of appLitPads()) {
    if (px === x && py === y) color = lit
  }
  highlightInstrumentXY(x, y, color)
  highlightVisualizationXY(x, y, 0, 'error')
}

function padKey([x, y]) {
  return `${x},${y}`
}

/**
 * Put out the stray lights without restoring anything under them, for a step
 * change, which repaints every pad it wants from scratch straight afterwards.
 */
function clearStrayNotes() {
  const pads = [...[...strayNotes.values()].flatMap(({ pads }) => pads), ...strayRing.values()]
  strayNotes.clear()
  strayRing.clear()
  straySince.clear() // the time starts again from the step that no longer wants the note
  for (const [x, y] of pads) {
    highlightInstrumentXY(x, y, 0)
    highlightVisualizationXY(x, y, 0, 'error')
  }
}

/**
 * Move on once as much of the current step is held down as the instrument can sound.
 *
 * That is normally the whole chord, and then this waits for every note of it. Where
 * the sensor cannot read them all at once (see reach.js) it is however many of them
 * it can: which ones is left to whoever is playing, since the notes that fit depend
 * on where the fingers landed first, and counting them asks nothing about that.
 */
function checkStep() {
  const step = steps[stepIndex]

  updateStrayNotes()

  let sounding = 0
  for (const note of step.notes) {
    if (!isPlayable(note) || !ext.heldNotes.has(note)) continue
    // Notes starting on this step need a press of their own rather than a hold left
    // over from the previous step, which is what makes a re-struck note count
    if (step.onsets.includes(note) && !pressedOnThisStep(note)) continue
    sounding++
  }
  if (sounding < stepReach) return

  if (stepIndex + 1 >= steps.length) {
    stopPlayback()
    log.success(`Reached the end of the MIDI file.`)
    return
  }

  stepIndex++
  showStep()
}

/**
 * A note with no pad in the current layout can never be pressed, so it cannot gate a
 * step. Any pad sending the note counts: the instrument reports the note, not the pad.
 */
function isPlayable(note) {
  const coords = ext.gridDict?.[note]
  return !!coords && coords.length > 0
}

function pressedOnThisStep(note) {
  const played = ext.history.playedNotes
  for (let i = played.length - 1; i >= 0; i--) {
    if (played[i].time < stepStartedAt) return false
    if (played[i].noteNumber === note) return true
  }
  return false
}

//////////////////////////////////////////
// HELPER FUNCTIONS                     //
//////////////////////////////////////////

function lightOn(note, channel = 1, velocity = 100, color = ext.config.guideHighlightColor, side = null) {
  releaseOtherSide(note, side)
  activeNotes.set(note, { color, side })
  guideNoteOn(note, channel, velocity, color, side)
}

function lightOff(note, channel = 1, velocity = 0) {
  const lit = activeNotes.get(note)
  activeNotes.delete(note)
  guideNoteOff(note, channel, velocity, lit?.side ?? null)
}

/**
 * Both hands can be on the same note at once, lighting different pads for it. Only
 * one fits in activeNotes, so the other's pad is released here rather than left lit
 * with nothing to turn it off. A light, not a note: neither measured nor recorded.
 */
function releaseOtherSide(note, side) {
  const lit = activeNotes.get(note)
  if (lit && lit.side !== side) {
    highlightInstrument(note, 0, lit.side)
    highlightVisualization(note, 0, 'guide', false, lit.side)
  }
}

/** Repaint a note that is already lit, which is not a note of its own */
function recolor(note, color) {
  const lit = activeNotes.get(note)
  if (lit?.color === color) {
    return
  }
  activeNotes.set(note, { color, side: lit?.side ?? null })
  recolorGuideNote(note, color, lit?.side ?? null)
}

/**
 * Light the pads that should be lit again.
 *
 * The LinnStrument repaints its LEDs whenever it answers an NRPN, and drops cell
 * updates that arrive mid-paint. Real time playback never notices, since it relights
 * every few hundred ms; step mode lights a note once and leaves it, so it has to put
 * its own lights back. Re-sending a color a pad already has is a no-op.
 */
export function refreshInstrumentLights() {
  for (const [note, { color, side }] of [...activeNotes, ...previewNotes]) {
    highlightInstrument(note, color, side)
  }
  for (const [x, y] of [...[...strayNotes.values()].flatMap(({ pads }) => pads), ...strayRing.values()]) {
    highlightInstrumentXY(x, y, errorColor())
  }
}

/** Stopping mid-note would otherwise leave pads lit */
function allNotesOff() {
  for (const note of [...activeNotes.keys()]) {
    lightOff(note)
  }
  clearPreview()
  clearStrayNotes()
  litThisStep = new Map()
  litLastStep = new Map()
  clearFutureMarks()
  // Last, so everything above puts out the pad it was actually lit on
  setPadOverrides(null)
  fingering = new Map()
  stepReach = 0
}

/** JZZ.MIDI.SMF expects a binary string; chunked to avoid blowing the stack */
function toBinaryString(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
  }
  return out
}
