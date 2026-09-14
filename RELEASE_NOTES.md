# Release Notes

## 2.0.0

- **Built-in MIDI file player** — open a `.mid` file and it plays straight into the Light Guide. No loop device, no DAW, nothing else running.
- **Speed control** — 25%–200% of the file's tempo, changeable mid-song, remembered between sessions.
- **Step mode** — the app lights one chord and waits for you to play it. No clock to keep up with; the piece moves at your speed. Back/Next to step by hand.
- **Colour-coded pads in step mode** — each lit pad says what to *do* with it: strike now, keep holding, let it come up (next step repeats it), a look-ahead at what's next, and a warning for a pad you're holding that doesn't belong. All colours configurable or switchable off.
- **Reads your instrument's layout** — split point, transposition, row offset, left-handed operation and Note Lights colours are read from the LinnStrument, so the pad lit on screen is the pad under your finger. Re-read any time with Import.
- **Respects reversed (left-handed) splits.**
- **Works around the LinnStrument's sensing limits** — chords are placed on pads the instrument can actually read together (no 4th touch in a column, no rectangle corners), so a step never waits on a note that was never going to arrive.
- **Duplicate note pads** — only the pad nearest the middle of each split lights, so a chord doesn't turn into a wash.
- **Route parts to hands** — with a split, notes light under the hand whose track/channel plays them, read from the file rather than guessed from pitch.
- **Drums ignored** (GM channel 10) during file playback.
- **Unsupported browsers are detected** — a browser without Web MIDI of its own now says so up front, instead of looking like it works and finding nothing.
- Dependencies updated; test suite added for the layout, part-routing and reach logic.
- README rewritten (the original is kept as `OLD_README.md`).
