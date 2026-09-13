import { highlightInstrumentXY } from "./main.js"
import { layoutGrid, uniformGrid, gridToDict, splitOf } from "./layout.js"

/** LinnStrument color numbers, as used by its CC 22 and by the config dropdowns */
export const ledColors = ['per-note', 'red', 'yellow', 'green', 'cyan', 'blue', 'magenta', 'off', 'white', 'orange', 'lime', 'pink']

/** Color setting meaning "whatever the LinnStrument is set to", beyond its own color numbers */
export const COLOR_FROM_DEVICE = 12

/** The palette's "off" entry, which the step mode color settings use to mean "as before" */
export const COLOR_OFF = 7

/** CSS class for a LinnStrument color number */
export function ledClass(color) {
  return `led-${ledColors[color] ?? color}`
}

/**
 * Build the grid (grid[x][y] = MIDI note, -1 for no pitch).
 * Uses the layout read from the LinnStrument when available, which handles
 * splits; otherwise falls back to the manually configured uniform layout.
 */
export function generateGrid(config, deviceLayout = null) {
  const columns = config.linnStrumentSize / 8
  if (deviceLayout) {
    return layoutGrid({ ...deviceLayout, columns, colOffset: config.colOffset, reversedSplits: config.reversedSplits })
  }
  return uniformGrid(columns, config.startNoteNumber, config.rowOffset, config.colOffset)
}

/**
 * Dictionary from note to every grid coordinate that plays it,
 * across both splits.
 */
export function getGridDict(grid) {
  return gridToDict(grid)
}

/**
 * Helper function that resets all color highlights from the grid
 * by brute force
 */
export function resetGrid() {
  const columns = ext.config.linnStrumentSize / 8

  // Reset all highlights on instrument
  for (let x = 0; x < columns; x++) {
    for (let y = 0; y <= 7; y++) {
      highlightInstrumentXY(x, y, 0)
    }
  }

  // Reset guide, look ahead and played highlights on visualization, but keep the note lights
  document.querySelectorAll('.highlight-guide, .highlight-preview, .highlight-played').forEach(e => e.remove());
  document.querySelectorAll('.step-sustains, .step-restrike').forEach(e => {
    e.classList.remove('step-sustains', 'step-restrike')
  });
}

/**
 * Main, accent and played colors the device uses for the split this column is in.
 * These are per split settings, so the two halves can differ.
 */
function splitColorsFor(layout, x) {
  const lights = window.ext.noteLights
  if (!lights || !layout) {
    return null
  }
  return lights.splitColors[splitOf(layout, x + 1)] || lights.splitColors[0]
}

/**
 * The color the LinnStrument itself lights this pad with, as a LinnStrument
 * color number, or 0 when the note is not lit. Accent notes win over main ones.
 */
function noteLightColor(noteNumber, x, layout) {
  const lights = window.ext.noteLights
  const colors = splitColorsFor(layout, x)
  if (!colors || noteNumber < 0 || noteNumber > 127) {
    return 0
  }
  const pitchClass = noteNumber % 12
  if (lights.accent[pitchClass]) return colors.accent
  if (lights.main[pitchClass]) return colors.main
  return 0
}

/** The device's own Color Played for this column's split, falling back to red */
export function devicePlayedColor(x) {
  const colors = splitColorsFor(window.ext.deviceLayout, x)
  return colors && colors.played ? colors.played : 1
}

export function drawGrid(grid) {
  grid = grid || window.ext.grid
  const layout = window.ext.deviceLayout
  const rightSplitStartX = layout && layout.splitActive ? layout.splitPoint - 1 : -1
  const v = document.getElementById('visualization')
  // Note lights read from the device replace the built in note name tinting
  v.className = layout && window.ext.noteLights ? 'note-lights' : ''
  v.innerHTML = ''
  const cols = grid[0].length
  const rows = grid.length
  const padSize = Math.floor(v.offsetWidth / rows) - 4;

  for (let y = cols - 1; y >= 0; y--) { // draw inverse

    const columnEl = document.createElement('div')
    columnEl.className = 'column'
    columnEl.style = `height: ${padSize + 4}px;`
    v.appendChild(columnEl)

    for (let x = 0; x < rows; x++) {
      let noteName = '╳'
      let noteClass = 'invalid'

      const noteNumber = grid[x][y]
      if (noteNumber >= 0 && noteNumber < 128) {
        const note = new Note(noteNumber)
        noteName = note.identifier
        noteClass = `${note.name}${note.accidental ? '-sharp' : ''}`
      }

      const cellEl = document.createElement('span')
      cellEl.id = `cell-${x}-${y}`
      cellEl.className = `cell note-number-${noteNumber} note-name-${noteClass}${x === rightSplitStartX ? ' split-start' : ''}`
      cellEl.style = `height: ${padSize}px; width: ${padSize}px;`
      cellEl.textContent = noteName

      const lightColor = noteLightColor(noteNumber, x, layout)
      if (lightColor) {
        const lightEl = document.createElement('span')
        lightEl.className = `highlight highlight-base ${ledClass(lightColor)}`
        cellEl.appendChild(lightEl)
      }

      columnEl.appendChild(cellEl)
    }
  }

}
