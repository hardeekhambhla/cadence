# Handoff

Run: `make run` (port 8430, also reachable over Tailscale). Tests: `make test` (synthetic media in `tests/assets`,
generated on first run). Needs ffmpeg + the venv (`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`).

## State
Working end to end and tested in a browser at phone size: wizard (Format -> Music+length -> Clips -> Style),
editor (live preview, timeline scrub, shot edits, panels, undo), export (720p/1080p, share/download).
Beat tracker: within ~10 ms of truth on synthetic 90-140 BPM tracks, ~0.25 s per song.
Nothing committed yet.

## Sample
`samples/` holds generated demo media (`tools/make_sample.py`) and `samples/sample.mp4`, the rendered result
(`python -m engine.sample` rebuilds both). The app's "Try a sample" / "Add a sample video" buttons build the same
project on demand.

## Design notes worth knowing
- Shot length rules live in `engine/cutter.py` (`resize_shot`, `balance`): photos ~1s (max 2s), videos 1-5s. Longer/Shorter
  moves one beat between the chosen shot and the *nearest video* that can give/take it (photos only if no video can);
  move/split/delete/replace call `/balance` afterwards. The first cut matches photos to short slots and videos to long ones.
- Every edit keeps total length fixed and cuts on beats: longer/shorter moves the boundary one beat and the
  neighbour absorbs it; move swaps clip content between slots; delete gives time to the previous shot.
- Preview = audio element is the clock + a pool of 5 pre-seeked `<video>`/`<img>` layers (`static/js/player.js`).
  Looks/pulse are CSS approximations of the ffmpeg filters in `engine/render.py` (keep the two in sync).
- Export encodes each shot separately (4 in parallel), concats with `-c copy`, so it is fast; frame counts come
  from rounded shot boundaries to avoid drift.
- iPhone HDR clips are tone-mapped (zscale) in both proxy and export.

## UX notes
- Async edits dim the controls and spin over the preview (`work()` in editor.js); destructive actions (delete shot, re-cut,
  format change) show an Undo toast. Clips step shows capture dates in the order that will be used; the remove button
  appears on tap. Phone landscape puts the preview left and controls right (CSS grid in app.css).
- Repeat is off by default (every clip once; spare time stretches shots, or the video ends early with a note).

## Timeline gestures
Pinch / ctrl+wheel / ± buttons zoom the timeline (28-260 px per second). Long-press (~0.4s) a shot and drag to reorder: the slots
(lengths and beat positions) stay, the clips move between them, then `/balance` re-applies the duration rules. Timeline thumbs are
pre-generated after every (re)cut (`prewarm_frames`) with at most 4 ffmpeg jobs at once.

## Not done / ideas
- Text overlays, original clip audio, transitions other than cut/pulse/flash.
- Real-device check on iOS Safari (video pool, autoplay, pinch/long-press are written for it but only tested in Chromium with synthetic
  touch events) and on real music (beat tracker is only proven on synthetic songs).
- Videos with neither a filename stamp nor a QuickTime date use their UTC container time, which can sit hours off photo wall-clock times.
- No auth: local network only.
