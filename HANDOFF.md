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
- Every edit keeps total length fixed and cuts on beats: longer/shorter moves the boundary one beat and the
  neighbour absorbs it; move swaps clip content between slots; delete gives time to the previous shot.
- Preview = audio element is the clock + a pool of 5 pre-seeked `<video>`/`<img>` layers (`static/js/player.js`).
  Looks/pulse are CSS approximations of the ffmpeg filters in `engine/render.py` (keep the two in sync).
- Export encodes each shot separately (4 in parallel), concats with `-c copy`, so it is fast; frame counts come
  from rounded shot boundaries to avoid drift.
- iPhone HDR clips are tone-mapped (zscale) in both proxy and export.

## Not done / ideas
- Drag-to-reorder on the timeline (Move buttons exist), pinch-zoom timeline, text overlays, clip audio.
- Real-device check on iOS Safari (video pool / autoplay behaviour is written for it but only tested in Chromium).
- No auth: local network only.
