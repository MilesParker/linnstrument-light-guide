import { log } from "./log.js";
import { defaultConfig, initConfig, resetConfig, saveConfig, updateSettingsInUI, refreshSaveState } from "./config.js";
import { resetGrid, getGridDict, getLitDict, getSideDicts, generateGrid, drawGrid, ledClass, devicePlayedColor, COLOR_FROM_DEVICE } from "./grid.js";
import { ROWOFFSET_OCTAVECUSTOM, ROWOFFSET_GUITAR, splitNoteRanges, LEFT, RIGHT } from "./layout.js";
import { assignSides } from "./parts.js";
import { registerPlayerEvents, refreshInstrumentLights } from "./player.js";
import { measureNoteTiming, calculateStatistics, logGuideNoteTiming } from "./statistics.js";
import { createMidiInputRecording, exportMidiInputRecording } from "./recorder.js";

/**
 * Global namespace, aliased to `window.ext`
 */
export const ext = {
  config: {},
  history: {
    /** Only played note-on messages */
    playedNotes: [],
  },
  recording: {
    tick: 0,
    tickTimer: null,
    /** instrument incoming MIDI input message */
    midiInput: {
      file: null,
      track: null,
    },
    /** guide notes incoming MIDI input message */
    guideInput: {
      file: null,
      track: null,
    },
  },
  stats: {
    guideNoteTimings: [],
  },
  /** Layout read from the LinnStrument (see layout.js), null until detected */
  deviceLayout: null,
  /** Notes currently held down on the instrument, which is what step mode waits for */
  heldNotes: new Set(),
  fn: {
    resetGrid,
    resetConfig,
    init,
    resetLinnStrumentState: resetState,
    clearLog,
    clearHistory,
  }
}
window.ext = ext

//////////////////////////////////////////
// INIT                                 //
//////////////////////////////////////////

// Whether the browser has Web MIDI of its own is settled in index.html, before the libraries
// load and before this module is even fetched. Enabling through JZZ's shim instead would come
// up with no ports and no way to reach the instrument, so it is not worth starting.
if (window.hasNativeWebMidi) {
  // Only enable() failing is MIDI being unavailable; a fault inside init() is not that
  WebMidi.enable().then(init, reportMidiRefused).catch(console.error);
} else {
  drawUnlitSurface()
}

/**
 * Raise the same warning as index.html does, with the reason swapped in: the API is
 * there but would not start, e.g. the page is not on HTTPS or the permission was denied.
 */
function reportMidiRefused(error) {
  console.error(error)
  drawUnlitSurface()
  document.getElementById("offline-browser-reason").textContent =
    `This browser refused Web MIDI: ${error?.message ?? error}`
  document.getElementById("offline-connect").hidden = true
  document.getElementById("offline-browser").hidden = false
}

/**
 * With no MIDI to start the app on, still draw the pads, unlit, so the warning over
 * them sits on the instrument rather than on an empty strip. Nothing else runs.
 */
function drawUnlitSurface() {
  ext.config = { ...defaultConfig }
  ext.grid = generateGrid(ext.config)
  drawGrid(ext.grid)
  window.addEventListener("resize", debounce(() => drawGrid(ext.grid), 200))
}

// Function triggered when WEBMIDI.js is ready
async function init() {

  // Load Config
  ext.config = initConfig()

  // Setup MIDI callbacks / event listeners
  registerPlayerEvents()
  await registerUiEvents()
  await registerMidiEvents()

  // Setup Grid
  await setupGrid()

  log.info(`Successfully initialized.`)

  // Infer current layout / transposition from LinnStrument directly.
  // After this it is only read again when the Read button is pressed.
  await readConfigFromLinnStrument()
  
  // This runs every 100ms, but the real intervals are checked by the functions
  // and is different for each functionality
  setInterval(() => {
    checkForStatisticsDump()
    checkForMidiDump()
  }, 100);

  createMidiInputRecording()
}

async function setupGrid() {
  resetGrid()
  // Pads step mode had moved notes onto belong to the grid being replaced
  setPadOverrides(null)
  ext.grid = generateGrid(ext.config, ext.deviceLayout)
  // Every pad that sends a note, which is what a note can be played on
  ext.gridDict = getGridDict(ext.grid)
  // The pads to light for it, which is a subset when one pad per note is set
  ext.litDict = getLitDict(ext.grid, ext.config, ext.deviceLayout)
  ext.sideDicts = getSideDicts(ext.grid, ext.deviceLayout)
  refreshPartSides()
  drawGrid(ext.grid)
}

/**
 * Work out which side of the split each part of the loaded file belongs to, so a note
 * lights under the hand that plays it rather than where its pitch falls. Runs again
 * whenever the layout or the file changes, since both decide the answer.
 */
export function refreshPartSides() {
  ext.partSides = null

  if (!ext.config.partRouting || !ext.parts) {
    return // switched off, or no file to read parts from
  }
  const { key, parts } = ext.parts

  if (!ext.deviceLayout?.splitActive) {
    log.warn(`Parts are not routed to hands: the LinnStrument is not split, so there is only one place to light a note.`)
    return
  }

  const ranges = splitNoteRanges(ext.grid, ext.deviceLayout)
  const sides = assignSides(parts, ranges)
  if (!sides.size) {
    log.warn(`Parts are not routed to hands: this file has nothing to tell them apart by, only one ${key}.`)
    return
  }
  ext.partSides = sides

  // Named with their ranges, which is what the hands were decided from
  const named = (side) => parts
    .filter((part) => sides.get(part.id) === side)
    .map((part) => `${key} ${part.id} plays ${part.low}-${part.high}`)
    .join(', ')
  const half = (side) => `${side === LEFT ? 'left' : 'right'} hand (pads reach ${ranges[side].low}-${ranges[side].high})`
  log.info(`Parts routed by ${key} — ${half(LEFT)}: ${named(LEFT)}; ${half(RIGHT)}: ${named(RIGHT)}.`)

  // A part can reach past the half it was given, and those notes have nowhere to go
  // but the other hand. Worth warning about: it looks exactly like a misrouted note.
  for (const part of parts) {
    const side = sides.get(part.id)
    const range = ranges[side]
    const outside = []
    if (part.low < range.low) outside.push(`below ${range.low}`)
    if (part.high > range.high) outside.push(`above ${range.high}`)
    if (outside.length) {
      log.warn(`${key} ${part.id} plays ${part.low}-${part.high}, which reaches ${outside.join(' and ')}, ` +
        `past what the ${side === LEFT ? 'left' : 'right'} half can play. Those notes light on the other hand instead.`)
    }
  }
}

/** The pads the layout puts a note on, under a given side's hand where one is known */
export function layoutPads(noteNumber, side = null) {
  if (side != null && ext.sideDicts) {
    const pads = ext.sideDicts[side][noteNumber]
    if (pads) {
      return pads
    }
  }
  return ext.litDict[noteNumber]
}

/**
 * The pads to light for a note. Normally the layout's own, but step mode moves a
 * note the sensor could not otherwise read onto a pad it can (see reach.js).
 *
 * An override belongs to the hand it was worked out for. Asked about the other hand
 * — which is how a note lit on both at once is put out again — the layout answers,
 * since that is where the other hand's pad still is.
 */
export function litPads(noteNumber, side = null) {
  const moved = ext.padOverrides?.get(noteNumber)
  if (moved && (side === null || side === moved.side)) {
    return moved.pads
  }
  return layoutPads(noteNumber, side)
}

/**
 * Put some notes on pads of step mode's choosing until told otherwise. Keyed by
 * note, which is all the rest of the lighting path knows about, so this reaches the
 * instrument, the visualization and the outlines alike.
 *
 * @param {Map<number, { pads: number[][], side: number|null }> | null} overrides
 */
export function setPadOverrides(overrides) {
  ext.padOverrides = overrides
}

/**
 * Register UI Events and Listeners
 */
async function registerUiEvents() {
  // UI Buttons Listeners
  document.getElementById("save").addEventListener("click", (event) => {
    saveConfig(ext.config, event)
  });
  document.getElementById("read-config").addEventListener("click", readConfigFromLinnStrument);

  // Light the Save key as soon as the form no longer matches what is stored
  document.querySelectorAll('.card-body form').forEach((form) => {
    form.addEventListener("input", () => refreshSaveState(ext.config));
    form.addEventListener("change", () => refreshSaveState(ext.config));
  });
  document.getElementById("reset-config").addEventListener("click", resetConfig);
  document.getElementById("reset-state").addEventListener("click", resetState);
  document.getElementById("clear-log").addEventListener("click", clearLog);
  document.getElementById("clear-history").addEventListener("click", clearHistory);
  document.getElementById("calculate-statistics").addEventListener("click", calculateStatistics);

  // UI Resize trigger, with debounce
  window.addEventListener("resize", debounce(() => {
    drawGrid(ext.grid)
  }, 200));

  // Enable tooltips
  const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'))
  tooltipTriggerList.map(function (tooltipTriggerEl) {
    return new bootstrap.Tooltip(tooltipTriggerEl, { delay: { show: 1500, hide: 100 } })
  })
}

/**
 * Register listeners and callbacks to MIDI events / messages
 */
async function registerMidiEvents() {

  //////////////////////////////////////////
  // INSTRUMENT INPUT                     //
  //////////////////////////////////////////

  if (ext.config.instrumentInputPort) {
    try {
      ext.input = WebMidi.getInputByName(ext.config.instrumentInputPort)
      if (!ext.input) {
        throw new Error('Could not connect to Instrument MIDI Input')
      }
      ext.input.addListener("noteon", (msg) => {
        const noteNumber = msg.dataBytes[0]
        ext.history.playedNotes.push({
          time: performance.now(),
          noteNumber: msg.note.number,
        })
        ext.heldNotes.add(msg.note.number)
        highlightVisualization(noteNumber, ext.config.playedHighlightColor)

        // Add it to MIDI input recording
        const jzzMsg = JZZ.MIDI.noteOn(msg.message.channel, msg.note.number, msg.rawVelocity)
        ext.recording.midiInput.track.add(ext.recording.tick, jzzMsg);
      });
      ext.input.addListener("noteoff", (msg) => {
        highlightVisualization(msg.dataBytes[0], 0)
        ext.heldNotes.delete(msg.note.number)

        // Add it to MIDI input recording
        const jzzMsg = JZZ.MIDI.noteOff(msg.message.channel, msg.note.number, msg.rawVelocity)
        ext.recording.midiInput.track.add(ext.recording.tick, jzzMsg);
      });
      ext.input.addListener("controlchange", (msg) => {
        // Filter out the LinnStrument control (NRPN / RPN) messages
        const ignoredSubTypes = [
          "dataentrycoarse", "dataentryfine", 
          "registeredparametercoarse", "registeredparameterfine",
          "nonregisteredparametercoarse", "nonregisteredparameterfine",
        ]
        // Add it to MIDI input recording
        if (!ignoredSubTypes.includes(msg.subtype)) {
          const jzzMsg = JZZ.MIDI.control(msg.message.channel, msg.controller.number, msg.rawValue)
          ext.recording.midiInput.track.add(ext.recording.tick, jzzMsg);
        }
      })

      log.success(`Connected to Instrument MIDI Input: ${ext.config.instrumentInputPort}`)

    } catch (err) {
      log.error(`Could not connect to Instrument MIDI Input: ${ext.config.instrumentInputPort}`)
      console.error(err)
    }
  } else {
    log.error(`No Instrument MIDI Input given.`)
  }

  //////////////////////////////////////////
  // INSTRUMENT 2 INPUT                     //
  //////////////////////////////////////////

  // TODO: This is mostly copy'n'pasted from above. Could be refactored to be nicer.
  if (ext.config.instrumentInputPort2) {
    try {
      ext.input2 = WebMidi.getInputByName(ext.config.instrumentInputPort2)
      if (!ext.input2) {
        throw new Error('Could not connect to Instrument 2 MIDI Input')
      }
      ext.input2.addListener("noteon", (msg) => {
        const noteNumber = msg.dataBytes[0]
        ext.history.playedNotes.push({
          time: performance.now(),
          noteNumber: msg.note.number,
        })
        ext.heldNotes.add(msg.note.number)
        highlightVisualization(noteNumber, ext.config.playedHighlightColor)

        // Add it to MIDI input recording
        const jzzMsg = JZZ.MIDI.noteOn(msg.message.channel, msg.note.number, msg.rawVelocity)
        ext.recording.midiInput.track.add(ext.recording.tick, jzzMsg);
      });
      ext.input2.addListener("noteoff", (msg) => {
        highlightVisualization(msg.dataBytes[0], 0)
        ext.heldNotes.delete(msg.note.number)

        // Add it to MIDI input recording
        const jzzMsg = JZZ.MIDI.noteOff(msg.message.channel, msg.note.number, msg.rawVelocity)
        ext.recording.midiInput.track.add(ext.recording.tick, jzzMsg);
      });
      ext.input2.addListener("controlchange", (msg) => {
        // Filter out NRPN / RPN messages
        const ignoredSubTypes = [
          "dataentrycoarse", "dataentryfine", 
          "registeredparametercoarse", "registeredparameterfine",
          "nonregisteredparametercoarse", "nonregisteredparameterfine",
        ]
        // Add it to MIDI input recording
        if (!ignoredSubTypes.includes(msg.subtype)) {
          const jzzMsg = JZZ.MIDI.control(msg.message.channel, msg.controller.number, msg.rawValue)
          ext.recording.midiInput.track.add(ext.recording.tick, jzzMsg);
        }
      })

      log.success(`Connected to Instrument 2 MIDI Input: ${ext.config.instrumentInputPort2}`)

    } catch (err) {
      log.error(`Could not connect to Instrument 2 MIDI Input: ${ext.config.instrumentInputPort2}`)
      console.error(err)
    }
  } else {
    log.error(`No Instrument 2 MIDI Input given.`)
  }


  //////////////////////////////////////////
  // INSTRUMENT OUTPUT                    //
  //////////////////////////////////////////

  if (ext.config.instrumentOutputPort) {
    try {
      ext.output = WebMidi.getOutputByName(ext.config.instrumentOutputPort)
      if (!ext.output) {
        throw new Error('Could not connect to instrument MIDI Output')
      }
      log.success(`Connected to LinnStrument MIDI Output: ${ext.config.instrumentOutputPort}`)
    } catch (err) {
      log.warn(`Could not connect to Instrument MIDI Output: ${ext.config.instrumentInputPort}`)
      console.warn(err)
    }
  } else {
    log.warn(`No Instrument MIDI Output given. Without this, Light Guide highlighting and layout detection will not work.`)
  }

  //////////////////////////////////////////
  // LIGHT GUIDE INPUT                    //
  //////////////////////////////////////////

  if (ext.config.lightGuideInputPort) {
    try {
      ext.lightGuideInput = WebMidi.getInputByName(ext.config.lightGuideInputPort)

      if (!ext.lightGuideInput) {
        throw new Error('Could not connect to Light Guide MIDI Input')
      }

      // Support "typical" Light Guide where noteon / noteoff MIDI events are used
      ext.lightGuideInput.addListener("noteon", async (msg) => {
        await guideNoteOn(msg.dataBytes[0], msg.message.channel, msg.rawVelocity)
      });
      ext.lightGuideInput.addListener("noteoff", (msg) => {
        guideNoteOff(msg.dataBytes[0], msg.message.channel, msg.rawVelocity)
      });

      // Support Synthesia Proprietary 1 (ONE Smart Piano) Light Guide input
      ext.lightGuideInput.addListener("keyaftertouch", async (msg) => {
        // Add note number offset for ONE Smart Piano 
        const noteNumber = msg.dataBytes[0] + 21

        if (msg.value > 0) {
          highlightInstrument(noteNumber, ext.config.guideHighlightColor)
          highlightVisualization(noteNumber, ext.config.guideHighlightColor, 'guide', true)
          if (ext.config.guideNoteStatistics) {
            const timing = await measureNoteTiming(noteNumber)
            logGuideNoteTiming(timing)
          }
        } else {
          highlightInstrument(noteNumber, 0)
          highlightVisualization(noteNumber, 0, 'guide')
        }
      });

      log.success(`Connected to Light Guide MIDI Input: ${ext.config.lightGuideInputPort}`)

    } catch (err) {
      log.error(`Could not connect to Light Guide MIDI Input: ${ext.config.lightGuideInputPort}`)
      console.error(err)
    }
  } else {
    log.warn(`No Light Guide MIDI input. The Light Guide Feature will not work.`)
  }

  //////////////////////////////////////////
  // MIDI THRU FORWARDS                   //
  //////////////////////////////////////////

  if (ext.input) {
    if (ext.config.forwardPort1) {
      try {
        ext.forwardPort1 = WebMidi.getOutputByName(ext.config.forwardPort1)
        if (!ext.forwardPort1) {
          throw new Error('Could not connect to Forward MIDI Port 1')
        }
        ext.input.addForwarder(ext.forwardPort1)
        if (ext.input2) {
          ext.input2.addForwarder(ext.forwardPort1)
        }
        log.success(`Connected MIDI Forward Port 1: ${ext.config.forwardPort1}`)
      } catch (err) {
        log.warn(`Could not connect to optional Forward Port 1: ${ext.config.forwardPort1}`)
      }
    }
    if (ext.config.forwardPort2) {
      try {
        ext.forwardPort2 = WebMidi.getOutputByName(ext.config.forwardPort2)
        if (!ext.forwardPort2) {
          throw new Error('Could not connect to Forward MIDI Port 1')
        }
        ext.input.addForwarder(ext.forwardPort2)
        if (ext.input2) {
          ext.input2.addForwarder(ext.forwardPort2)
        }
        log.success(`Connected MIDI Forward Port 2: ${ext.config.forwardPort2}`)
      } catch (err) {
        log.warn(`Could not connect to optional Forward Port 2: ${ext.config.forwardPort2}`)
      }
    }
  } else {
    log.warn(`No Instrument input found, cannot forward MIDI from it.`)
  }

  return
}

//////////////////////////////////////////
// HELPER FUNCTIONS                     //
//////////////////////////////////////////

/**
 * Highlight pads on instrument by note number and color
 */
/**
 * Handle an incoming Light Guide note-on, from a MIDI port or the file player.
 */
export async function guideNoteOn(noteNumber, channel = 1, velocity = 100, color = ext.config.guideHighlightColor, side = null) {
  highlightInstrument(noteNumber, color, side)
  highlightVisualization(noteNumber, color, 'guide', true, side)

  if (ext.config.guideNoteStatistics) {
    const timing = await measureNoteTiming(noteNumber)
    logGuideNoteTiming(timing)
  }

  const jzzMsg = JZZ.MIDI.noteOn(channel, noteNumber, velocity)
  ext.recording.guideInput.track.add(ext.recording.tick, jzzMsg);
}

/** Handle an incoming Light Guide note-off. */
export function guideNoteOff(noteNumber, channel = 1, velocity = 0, side = null) {
  highlightInstrument(noteNumber, 0, side)
  highlightVisualization(noteNumber, 0, 'guide', false, side)

  const jzzMsg = JZZ.MIDI.noteOff(channel, noteNumber, velocity)
  ext.recording.guideInput.track.add(ext.recording.tick, jzzMsg);
}

/**
 * Change the color of a guide note that is already lit. Deliberately not a note off /
 * note on pair: the note has not changed, so it must not be measured or recorded again.
 */
export function recolorGuideNote(noteNumber, color, side = null) {
  highlightInstrument(noteNumber, color, side)
  highlightVisualization(noteNumber, color, 'guide', true, side)
}

export function highlightInstrument(noteNumber, color, side = null) {
  const noteCoords = litPads(noteNumber, side)
  if (noteCoords) {
    for (const noteCoord of noteCoords) {
      highlightInstrumentXY(noteCoord[0], noteCoord[1], color)
    }
  }
}

/**
 * Highlight pads on instrument by x / y coordinates and color
 * 
 * Will only work if we have Instrument MIDI Output
 */
export function highlightInstrumentXY(x, y, color) {
  if (ext.output) {
    const channel = ext.output.channels[1]
    channel.sendControlChange(20, x + 1); // Add one because 0 is settings
    channel.sendControlChange(21, y);
    channel.sendControlChange(22, color);
  }
}

/**
 * Highlight pads on web visualization by note number and color
 */
export function highlightVisualization(noteNumber, color, type = "played", big = false, side = null) {

  // The visualization stands in for the instrument, so it lights the same pads. A
  // played note has no side: the instrument reports the note, not the pad it came from.
  const noteCoords = litPads(noteNumber, side)
  if (noteCoords) {
    for (const noteCoord of noteCoords) {
      highlightVisualizationXY(noteCoord[0], noteCoord[1], color, type, big)
    }
  }
}

/**
 * Highlight one pad on web visualization by x / y coordinates and color
 */
export function highlightVisualizationXY(x, y, color, type = "played", big = false) {
  const padColor = color === COLOR_FROM_DEVICE ? devicePlayedColor(x) : color

  // Clear first either way, so recoloring a lit pad replaces its LED
  // rather than leaving a second one stacked underneath
  const lit = document.getElementById(`highlight-${type}-${x}-${y}`)
  if (lit) {
    lit.parentNode.removeChild(lit);
  }

  if (padColor !== 0) {
    const cell = document.getElementById(`cell-${x}-${y}`)
    if (!cell) {
      return
    }
    const size = cell.offsetWidth

    const highlightEl = document.createElement('span')
    highlightEl.id = `highlight-${type}-${x}-${y}`
    highlightEl.className = `highlight highlight-${type} ${ledClass(padColor)}`
    if (big) {
      highlightEl.style = `height: ${size - 6}px; width: ${size - 6}px; margin-left: ${3}px;`
    } else {
      highlightEl.style = `height: ${size / 2}px; width: ${size / 2}px; margin-left: ${size / 4}px;`
    }

    cell.prepend(highlightEl)
  }
}

/** Only one read may be in flight at a time, so two presses cannot interleave */
let readingState = false

/**
 * Read layout, transposition and note light settings from the LinnStrument and apply
 * them. A read is a sequence of NRPN round trips with no way to tell which answer
 * belongs to which request, so it only runs when asked: at startup, and on Read.
 */
export async function readConfigFromLinnStrument() {
  if (readingState) {
    return
  }
  if (!ext.output || !ext.input) {
    log.warn(`Cannot read from LinnStrument without both an instrument input and output port.`)
    return
  }

  readingState = true
  try {
    const layout = await readDeviceLayout()
    ext.config.bpm = await getLinnStrumentParamValue(238)
    ext.deviceLayout = layout

    try {
      ext.noteLights = await readNoteLights()
    } catch (err) {
      ext.noteLights = null
      log.warn(`Could not read note light settings, using note name colors instead: ${err}`)
    }

    setupGrid()

    // Reflect the detected bottom-left note and row interval in the config
    const [bottom, second] = [ext.grid[0][0], ext.grid[0][1]]
    if (bottom >= 0) ext.config.startNoteNumber = bottom
    if (bottom >= 0 && second >= 0) ext.config.rowOffset = second - bottom
    updateSettingsInUI(ext.config)

    const splitInfo = layout.splitActive
      ? `split at column ${layout.splitPoint}, left ${describeSplit(layout.splits[0])}, right ${describeSplit(layout.splits[1])}`
      : `no split, ${describeSplit(layout.splits[layout.selectedSplit])}`
    const reversedInfo = layout.reversed ? `, reversed ${ext.config.reversedSplits}` : ''
    const lights = ext.noteLights
    const lightsInfo = lights
      ? `, noteLights=${lights.main.filter(Boolean).length} main / ${lights.accent.filter(Boolean).length} accent, colors ${JSON.stringify(lights.splitColors)}`
      : ', noteLights=unavailable'
    log.success(`Read from LinnStrument: rowOffsetMode=${layout.rowOffsetMode}, ${splitInfo}${reversedInfo}, bpm=${ext.config.bpm}${lightsInfo}`)

    // Reading repaints the LinnStrument's LEDs, dropping pad colors that arrived
    // mid-paint. Put them back.
    refreshInstrumentLights()
  } catch (err) {
    log.warn(`Could not read from LinnStrument, please adjust config manually. (${err})`)
  } finally {
    readingState = false
  }
}

/**
 * Read everything that determines which pitch each pad plays.
 * NRPN numbers per midi.md in the LinnStrument firmware repo;
 * right-split parameters are the left ones + 100.
 */
async function readDeviceLayout() {
  const get = getLinnStrumentParamValue

  const layout = {
    splitActive: (await get(200)) === 1,
    selectedSplit: await get(201),
    splitPoint: await get(202),
    rowOffsetMode: await get(227),
    reversed: (await get(246)) === 1,
    splits: [],
  }

  for (const base of [0, 100]) {
    const special = await get(base + 35)
    const octave = await get(base + 36)
    const pitch = await get(base + 37)
    const lights = await get(base + 38)
    layout.splits.push({
      special,
      transposeOctave: (octave - 5) * 12,
      transposePitch: pitch - 7,
      transposeLights: lights - 7,
    })
  }

  if (layout.rowOffsetMode === ROWOFFSET_OCTAVECUSTOM) {
    const custom = await get(253)
    layout.customRowOffset = custom === 33 ? -17 : custom - 16
  }

  if (layout.rowOffsetMode === ROWOFFSET_GUITAR) {
    layout.guitarTuning = []
    for (let row = 0; row < 8; row++) {
      layout.guitarTuning.push(await get(263 + row))
    }
  }

  return layout
}

/**
 * Which pitch classes the LinnStrument lights by itself, and in what color. Note
 * lights (NRPN 203-214 main, 215-226 accent) are global; the main, accent and played
 * colors (NRPN 30/31/32, +100 for the right split) are per split.
 */
async function readNoteLights() {
  const get = getLinnStrumentParamValue

  const main = []
  const accent = []
  for (let i = 0; i < 12; i++) {
    main.push(await get(203 + i))
    accent.push(await get(215 + i))
  }

  const splitColors = []
  for (const base of [0, 100]) {
    splitColors.push({
      main: await get(base + 30),
      accent: await get(base + 31),
      played: await get(base + 32),
    })
  }

  return main.includes(undefined) ? null : { main, accent, splitColors }
}

function describeSplit(split) {
  const specials = ['normal', 'arp', 'faders', 'strum', 'sequencer']
  return `(${specials[split.special] ?? split.special}, octave ${split.transposeOctave / 12}, pitch ${split.transposePitch}, lights ${split.transposeLights})`
}

async function getLinnStrumentParamValue(paramNumber) {
  const timeout = 300
  if (!ext.input) {
    log.warn('Cannot getLinnStrumentParamValue, because no input device')
    return
  }
  return promiseTimeout(timeout, new Promise((resolve) => {
    ext.output.sendNrpnValue(nrpn(299), nrpn(paramNumber), { channels: 1 });
    ext.input.channels[1].addListener("nrpn", (msg) => {
      if (msg.message.dataBytes[0] === 38) {
        return resolve(msg.message.dataBytes[1])
      }
    }, { duration: timeout })
  }))
}

async function resetState() {
  // Put LinnStrument out of User Firmware Mode (if it still is)
  if (ext.output) {
    ext.output.sendNrpnValue(nrpn(245), nrpn(1), { channels: 1 });
    sleep(100)
    ext.output.sendNrpnValue(nrpn(245), nrpn(0), { channels: 1 });
    sleep(100)
    resetGrid()
    log.success(`Successfully reset LinnStrument and app state.`)
  }
}

function clearLog() {
  document.getElementById("log").innerHTML = ''
}

function clearHistory() {
  ext.history.playedNotes = []
  ext.stats.guideNoteTimings = []
  createMidiInputRecording()
}

function checkForStatisticsDump() {
  if (ext.stats.guideNoteTimings.length > 0) {
    const lastItem = ext.stats.guideNoteTimings.slice(-1)[0] 
    if (lastItem && lastItem.time < performance.now() - ext.config.guideNotesPausedThreshold) {
      console.debug('Guide Note Timings', ext.stats.guideNoteTimings)
      calculateStatistics()
      ext.stats.guideNoteTimings = []
    }
  }
}

function checkForMidiDump() {
  if (ext.recording.midiInput.track.length > 3) {
    const lastItem = ext.history.playedNotes.slice(-1)[0]
    if (lastItem.time < performance.now() - ext.config.playedNotesPausedThreshold) {
      exportMidiInputRecording()
      createMidiInputRecording()
    }
  }
}

/**
 * Converts NRPN number to array of [MSB, LSB]
 */
function nrpn(nrpnValue) {
  const msb = nrpnValue >> 7;
  const lsb = nrpnValue & 0x7F;
  return [msb, lsb];
}

function debounce(func, time) {
  var time = time || 100; // 100 by default if no param
  var timer;
  return function (event) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(func, time, event);
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * https://italonascimento.github.io/applying-a-timeout-to-your-promises/
 */
function promiseTimeout(ms, promise) {

  // Create a promise that rejects in <ms> milliseconds
  let timeout = new Promise((resolve, reject) => {
    let id = setTimeout(() => {
      clearTimeout(id);
      reject('Timed out in '+ ms + 'ms.')
    }, ms)
  })

  // Returns a race between our timeout and the passed in promise
  return Promise.race([
    promise,
    timeout
  ])
}
