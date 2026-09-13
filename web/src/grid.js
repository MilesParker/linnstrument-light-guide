import { highlightInstrumentXY } from "./main.js"
import { layoutGrid, uniformGrid, gridToDict } from "./layout.js"

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

  // Reset all highlights on visualization
  document.querySelectorAll('.highlight').forEach(e => e.remove());
}

export function drawGrid(grid) {
  grid = grid || window.ext.grid
  const layout = window.ext.deviceLayout
  const rightSplitStartX = layout && layout.splitActive ? layout.splitPoint - 1 : -1
  const v = document.getElementById('visualization')
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

      columnEl.appendChild(cellEl)
    }
  }

}
