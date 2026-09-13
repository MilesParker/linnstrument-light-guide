/**
 * Plays a local MIDI file straight into the Light Guide.
 *
 * Uses JZZ.MIDI.SMF, which the page already loads for the recorder, so this
 * needs no virtual MIDI port, no loopback driver and no external player.
 *
 * Real time mode forwards the file as it plays. Step mode lights one chord at a
 * time and waits until that chord has actually been played (see buildSteps).
 */

import { ext, guideNoteOn, guideNoteOff } from "./main.js"
import { log } from "./log.js"

const DRUM_CHANNEL = 9 // GM channel 10, zero-based

/** How often step mode looks at what is currently held down (in ms) */
const STEP_POLL_INTERVAL = 25
/** How long a re-struck note goes dark before lighting up again (in ms) */
const RESTRIKE_BLINK = 90

let player = null
/** Notes currently lit by the player, so Stop can clear exactly those */
const activeNotes = new Set()

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

  if (!fileEl || !playEl || !stopEl || !stepEl) {
    return
  }

  fileEl.addEventListener('change', async (event) => {
    const file = event.target.files[0]
    if (!file) return
    try {
      stopPlayback()
      player = loadPlayer(await file.arrayBuffer())
      playEl.disabled = false
      stopEl.disabled = false
      const seconds = Math.round(player.durationMS() / 1000)
      log.success(`Loaded MIDI file: ${file.name} (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}, ${steps.length} steps)`)
    } catch (err) {
      player = null
      steps = []
      playEl.disabled = true
      stopEl.disabled = true
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
      player.play()
    }
  })

  stopEl.addEventListener('click', stopPlayback)
}

function loadPlayer(arrayBuffer) {
  const smf = new JZZ.MIDI.SMF(toBinaryString(arrayBuffer))
  const p = smf.player()

  // Built before anything plays, from the same event list the player runs on
  steps = buildSteps(p._data)

  p.connect((msg) => {
    const status = msg[0] & 0xf0
    const channel = msg[0] & 0x0f

    // GM drums would light pads for every kick and snare
    if (channel === DRUM_CHANNEL) return

    const note = msg[1]
    const velocity = msg[2]

    if (status === 0x90 && velocity > 0) {
      lightOn(note, channel + 1, velocity)
    } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
      lightOff(note, channel + 1, velocity)
    }
  })

  return p
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
 * Group the file's notes into one step per tick that starts a note, which makes
 * the steps fall on the smallest division the file actually uses.
 *
 * A step carries every note sounding at that tick, not just the new ones, so a
 * note held across several steps keeps its light and still has to stay held.
 * `onsets` are the notes that start on the step and so need a press of their own.
 */
function buildSteps(data) {
  const events = []
  for (const msg of data) {
    const status = msg[0] & 0xf0
    if ((msg[0] & 0x0f) === DRUM_CHANNEL) continue
    if (status === 0x90 && msg[2] > 0) {
      events.push({ tick: msg.tt, note: msg[1], on: true })
    } else if (status === 0x80 || (status === 0x90 && msg[2] === 0)) {
      events.push({ tick: msg.tt, note: msg[1], on: false })
    }
  }
  // Note offs before note ons within a tick, so a note struck again reads as a new onset
  events.sort((a, b) => a.tick - b.tick || (a.on ? 1 : 0) - (b.on ? 1 : 0))

  const result = []
  /** note -> number of overlapping note ons, so a doubled note is not dropped early */
  const sounding = new Map()
  let i = 0

  while (i < events.length) {
    const tick = events[i].tick
    const onsets = new Set()

    while (i < events.length && events[i].tick === tick) {
      const event = events[i++]
      if (event.on) {
        sounding.set(event.note, (sounding.get(event.note) ?? 0) + 1)
        onsets.add(event.note)
      } else {
        const remaining = (sounding.get(event.note) ?? 0) - 1
        if (remaining > 0) {
          sounding.set(event.note, remaining)
        } else {
          sounding.delete(event.note)
        }
      }
    }

    // A tick that only ends notes is not a step of its own
    if (onsets.size) {
      result.push({ notes: [...sounding.keys()], onsets: [...onsets] })
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

/** Light the current step, leaving held notes alone and blinking re-struck ones */
function showStep() {
  const step = steps[stepIndex]
  const lit = new Set(activeNotes)
  const current = ++generation

  for (const note of lit) {
    if (!step.notes.includes(note)) {
      lightOff(note) // note ended on this step
    }
  }
  for (const note of step.notes) {
    if (!lit.has(note)) {
      lightOn(note) // note starts on this step
    }
  }
  for (const note of step.onsets) {
    if (!lit.has(note)) continue
    // Lit note struck again: go dark briefly, or it reads as a note to keep holding
    lightOff(note)
    setTimeout(() => {
      if (current === generation) {
        lightOn(note)
      }
    }, RESTRIKE_BLINK)
  }

  stepStartedAt = performance.now()
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

/** A note with no pad in the current layout can never be pressed, so it cannot gate a step */
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

function lightOn(note, channel = 1, velocity = 100) {
  activeNotes.add(note)
  guideNoteOn(note, channel, velocity)
}

function lightOff(note, channel = 1, velocity = 0) {
  activeNotes.delete(note)
  guideNoteOff(note, channel, velocity)
}

/** Stopping mid-note would otherwise leave pads lit */
function allNotesOff() {
  for (const note of [...activeNotes]) {
    lightOff(note)
  }
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
