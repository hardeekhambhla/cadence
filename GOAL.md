# Cadence

Beat-synced video editor (local web app, iOS-native feel, installable as a PWA). Pick a video type
(Reel / Story / Post / Square / YouTube), add one or more songs and choose a length (15s, 30s, 45s,
1 min, full song, or fit-my-clips), drop in photos and videos, pick a look and an energy level. Cadence
finds the beat, cuts every clip to it automatically, and opens an editor where each shot can be tweaked
(replace, trim, longer/shorter by beat, move, split, delete, fit/fill, focus) before export to MP4.

## Shape
- `engine/audio.py`   beat tracker (numpy only): onset flux -> tempo -> DP beats -> downbeats, energy, drops.
- `engine/cutter.py`  first-cut planner: beat-grid strides driven by energy + pace, snapped to downbeats.
- `engine/media.py`   ingest: proxies, thumbs, motion scores for best-moment picking, crop focus.
- `engine/render.py`  parallel per-shot ffmpeg encode, lossless concat, audio mux.
- `engine/project.py` per-project folders under `projects/` (gitignored).
- `app.py`            Flask API. `static/` is the UI (vanilla ES modules, no build step).

## Brand
Name Cadence. Outline-camera mark (`static/logo.svg`, icons from `tools/make_icons.py`).
Palette: paper `#F5F3EF`, ink `#161616`, one coral accent `#FF5A36` (dark mode variants in `static/app.css`).
Use only the CSS tokens; no other colours.
