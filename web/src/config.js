export const defaultConfig = {

  //////////////////////////////////////////
  // MIDI Port Names                      //
  //////////////////////////////////////////

  instrumentInputPort: 'LinnStrument MIDI',
  instrumentOutputPort: 'LinnStrument MIDI',
  lightGuideInputPort: 'Loop Back C',
  forwardPort1: 'Loop Forward A',
  forwardPort2: 'Loop Forward B',
  instrumentInputPort2: '',

  //////////////////////////////////////////
  // General Options                      //
  //////////////////////////////////////////

  playedHighlightColor: 12,
  guideHighlightColor: 6,
  /**
   * Step mode only. Each of these says what to do with a lit pad beyond it simply
   * being part of the step, and each falls back to how step mode looked without it
   * when switched off, rather than leaving a pad dark that used to be lit.
   */
  /** Color for a note struck on an earlier step and only held now. Off reuses guideHighlightColor. */
  stepHoldColor: 4,
  /** Color for the notes the next step strikes, lit while still dark. Off shows no look ahead. */
  stepNextColor: 5,
  /** Outline lit pads on the visualization by what becomes of them on the next step */
  stepFutureOutlines: 1,
  showFeedback: 1,
  linnStrumentSize: 128,
  rowOffset: 5,
  colOffset: 1,
  startNoteNumber: 30,
  /**
   * Which splits left handed operation reverses, when the LinnStrument reports it is on.
   * The device does not report this itself: 'both' is REV, 'left' REVL, 'right' REVR.
   */
  reversedSplits: 'both',
  /** If the time offset is lower than this, the note is considered "in-time" (in ms) */
  delayedNoteThreshold: 50,
  /** 
   * If the time offset is higher than this, the note is considered a missed note. (in ms)
   * After this time, the app will stop looking and consider it a missed note. 
   */
  missedNoteThreshold: 200,

  //////////////////////////////////////////
  // Advanced Options (no UI)             //
  //////////////////////////////////////////

  guideNoteStatistics: true,
  /** How long the guide note feedback stays visible (colorized border around the cell) (in ms) */
  guideNoteStaticsFadeOut: 800,
  /** Time after no guide notes until statistics get printed and reset */
  guideNotesPausedThreshold: 3000, // in ms
  playedNotesPausedThreshold: 3200, // in ms
  /** BPM is necessary for MIDI recordings */
  bpm: 120,
  /** Highlight note timings on LinnStrument */ // TODO: This feature is not really reliable and needs own state
  highlightNoteTimingOnInstrument: false,
}

export function initConfig() {
  let config = defaultConfig
  const userConfig = localStorage.getItem("config");
  
  if (userConfig) {
    config = {
      ...config,
      ...JSON.parse(userConfig)
    }
  }

  updateSettingsInUI(config)

  console.debug('Config', config)

  return config
}

/** Fills a MIDI port select, rebuilding the list since this runs on every layout read */
function setPortOptions(id, devices, selected) {
  const el = document.getElementById(id)
  el.innerHTML = '<option value=""></option>'
  devices.forEach((device) => {
    const option = document.createElement("option")
    option.text = device.name
    option.selected = selected === device.name
    el.add(option)
  })
}

/** Writes a config value into its field, unless it is the one being edited */
function setField(id, value) {
  const el = document.getElementById(id)
  if (el !== document.activeElement) {
    el.value = value.toString()
  }
}

export function updateSettingsInUI(config) {

  setField('reversedSplits', config.reversedSplits)
  setField('showFeedback', config.showFeedback)
  setField('guideHighlightColor', config.guideHighlightColor)
  setField('playedHighlightColor', config.playedHighlightColor)
  setField('stepHoldColor', config.stepHoldColor)
  setField('stepNextColor', config.stepNextColor)
  setField('stepFutureOutlines', config.stepFutureOutlines)
  setField('linnStrumentSize', config.linnStrumentSize)
  setField('delayedNoteThreshold', config.delayedNoteThreshold)
  setField('missedNoteThreshold', config.missedNoteThreshold)

  setPortOptions('instrumentInputPort', WebMidi.inputs, config.instrumentInputPort)
  setPortOptions('instrumentOutputPort', WebMidi.outputs, config.instrumentOutputPort)
  setPortOptions('lightGuideInputPort', WebMidi.inputs, config.lightGuideInputPort)
  setPortOptions('forwardPort1', WebMidi.outputs, config.forwardPort1)
  setPortOptions('forwardPort2', WebMidi.outputs, config.forwardPort2)
  setPortOptions('instrumentInputPort2', WebMidi.inputs, config.instrumentInputPort2)

  refreshSaveState(config)
}

/** The config values the form is currently showing */
function configFromUI() {
  return {
    reversedSplits: document.getElementById("reversedSplits").value,
    showFeedback: parseInt(document.getElementById("showFeedback").value),
    guideHighlightColor: parseInt(document.getElementById("guideHighlightColor").value),
    playedHighlightColor: parseInt(document.getElementById("playedHighlightColor").value),
    stepHoldColor: parseInt(document.getElementById("stepHoldColor").value),
    stepNextColor: parseInt(document.getElementById("stepNextColor").value),
    stepFutureOutlines: parseInt(document.getElementById("stepFutureOutlines").value),
    linnStrumentSize: parseInt(document.getElementById("linnStrumentSize").value),
    delayedNoteThreshold: parseInt(document.getElementById("delayedNoteThreshold").value),
    missedNoteThreshold: parseInt(document.getElementById("missedNoteThreshold").value),

    instrumentInputPort: document.getElementById("instrumentInputPort").value,
    instrumentOutputPort: document.getElementById("instrumentOutputPort").value,
    lightGuideInputPort: document.getElementById("lightGuideInputPort").value,
    forwardPort1: document.getElementById("forwardPort1").value,
    forwardPort2: document.getElementById("forwardPort2").value,
    instrumentInputPort2: document.getElementById("instrumentInputPort2").value,
  }
}

/**
 * Lights the Save key while the form differs from what is stored, which also covers
 * settings just read off the LinnStrument but not yet saved.
 */
export function refreshSaveState(config) {
  const stored = { ...config, ...JSON.parse(localStorage.getItem("config") || "{}") }
  const current = configFromUI()
  const unsaved = Object.keys(current).some((key) => String(current[key]) !== String(stored[key]))
  document.getElementById("save").classList.toggle("unsaved", unsaved)
}

export function saveConfig(config, event) {
  if (event) {
    event.preventDefault() 
  }

  Object.assign(config, configFromUI())

  localStorage.setItem("config", JSON.stringify(config));
  location.reload()
}

export function resetConfig(event) {
  if (event) {
    event.preventDefault() 
  }
  localStorage.removeItem("config")
  location.reload()
}
