/**
 * Plays a local MIDI file straight into the Light Guide.
 *
 * Uses JZZ.MIDI.SMF, which the page already loads for the recorder, so this
 * needs no virtual MIDI port, no loopback driver and no external player.
 *
 * Real time mode forwards the file as it plays. Step mode lights one chord at a
 * time and waits until that chord has actually been played (see buildSteps).
 */

import { ext, guideNoteOn, guideNoteOff, highlightInstrument, highlightVisualization, recolorGuideNote, refreshPartSides, litPads } from "./main.js"
import { COLOR_OFF } from "./grid.js"
import { collectParts } from "./parts.js"
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

/** Chords to step through, rebuilt for each loaded file */
let steps = []
let stepIndex = 0
let stepStartedAt = 0
let stepTimer = null
/** Bumped on every step change and on stop, so a pending blink cannot outlive its step */
let generation = 0

export function registerPlayerEvents() {
  const fileEl = document.getElementById('midiFile')
  const playEl = document.getElementById('player-play')
  const stopEl = document.getElementById('player-stop')
  const stepEl = document.getElementById('player-step')
  const fileLabelEl = document.getElementById('midiFileLabel')
  const slowerEl = document.getElementById('player-slower')
  const fasterEl = document.getElementById('player-faster')
  const speedEl = document.getElementById('player-speed')

  if (!fileEl || !playEl || !stopEl || !stepEl || !fileLabelEl || !slowerEl || !fasterEl || !speedEl) {
    return
  }

  speedIndex = storedSpeedIndex()

  /** Print the speed and dim whichever key has nowhere left to go */
  const showSpeed = () => {
    speedEl.textContent = `${Math.round(SPEEDS[speedIndex] * 100)}%`
    speedEl.classList.toggle('off-tempo', speedIndex !== FULL_SPEED)
    // Step mode is paced by whoever is playing, so there is no tempo to scale
    slowerEl.disabled = stepEl.checked || speedIndex === 0
    fasterEl.disabled = stepEl.checked || speedIndex === SPEEDS.length - 1
  }

  /** Takes effect on the spot, mid-song included: JZZ rebases its clock on the new speed */
  const setSpeed = (index) => {
    speedIndex = Math.min(SPEEDS.length - 1, Math.max(0, index))
    localStorage.setItem(SPEED_KEY, String(SPEEDS[speedIndex]))
    if (player) {
      player.speed(SPEEDS[speedIndex])
    }
    showSpeed()
  }

  slowerEl.addEventListener('click', () => setSpeed(speedIndex - 1))
  fasterEl.addEventListener('click', () => setSpeed(speedIndex + 1))
  stepEl.addEventListener('change', showSpeed)
  showSpeed()

  /** The label is the only visible part of the file chooser, so it carries the file name */
  const setFileLabel = (name) => {
    fileLabelEl.textContent = name.length > 24 ? `${name.slice(0, 23)}…` : name
  }

  fileEl.addEventListener('change', async (event) => {
    const file = event.target.files[0]
    if (!file) return
    try {
      stopPlayback()
      player = loadPlayer(await file.arrayBuffer())
      playEl.disabled = false
      stopEl.disabled = false
      setFileLabel(file.name)
      const seconds = Math.round(player.durationMS() / 1000)
      log.success(`Loaded MIDI file: ${file.name} (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}, ${steps.length} steps)`)
    } catch (err) {
      player = null
      steps = []
      ext.parts = null
      refreshPartSides()
      playEl.disabled = true
      stopEl.disabled = true
      setFileLabel('Choose File')
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
  log.info(`Step mode: play the lit notes to advance, ${steps.length} steps in total.`)
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

  for (const note of lit) {
    if (!step.notes.includes(note)) {
      lightOff(note) // note ended on this step
    }
  }
  for (const note of step.notes) {
    const color = step.onsets.includes(note) ? pressColor() : holdColor()
    const side = sideOf(step.parts.get(note))
    if (!lit.has(note)) {
      lightOn(note, 1, 100, color, side) // note starts on this step
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

  stepStartedAt = performance.now()
}

//////////////////////////////////////////
// STEP COLORS                          //
//////////////////////////////////////////

// The three colors a pad can carry in step mode. Only the press color is a plain
// setting; the others fall back rather than going dark when switched off, so
// turning one off leaves step mode looking exactly as it did without it.

/** Notes this step strikes, which is what the Light Guide color has always meant */
function pressColor() {
  return ext.config.guideHighlightColor
}

/** Notes struck on an earlier step, to be held rather than played again */
function holdColor() {
  const color = ext.config.stepHoldColor
  return color === COLOR_OFF ? pressColor() : color
}

/** Notes the next step strikes, lit while still dark, as a look ahead */
function previewColor() {
  return ext.config.stepNextColor
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
 * Outline the lit pads by what becomes of them on the next step: held on, or struck
 * again. A pad is a single color on the instrument, so showing this there would cover
 * up whether the note is to be struck or held now, which matters more.
 */
function markFutures(step, next) {
  clearFutureMarks()
  if (!next || !ext.config.stepFutureOutlines) {
    return
  }
  for (const note of step.notes) {
    const side = sideOf(step.parts.get(note))
    if (next.onsets.includes(note)) {
      markCells(note, 'step-restrike', side)
    } else if (next.notes.includes(note)) {
      markCells(note, 'step-sustains', side)
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
  document.querySelectorAll('.step-sustains, .step-restrike').forEach((el) => {
    el.classList.remove('step-sustains', 'step-restrike')
  })
}

/** Move on once every note of the current step is actually held down */
function checkStep() {
  const step = steps[stepIndex]

  for (const note of step.notes) {
    if (isPlayable(note) && !ext.heldNotes.has(note)) return
  }
  // Notes starting on this step need a press of their own rather than a hold left
  // over from the previous step, which is what makes a re-struck note count
  for (const note of step.onsets) {
    if (isPlayable(note) && !pressedOnThisStep(note)) return
  }

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
}

/** Stopping mid-note would otherwise leave pads lit */
function allNotesOff() {
  for (const note of [...activeNotes.keys()]) {
    lightOff(note)
  }
  clearPreview()
  clearFutureMarks()
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
