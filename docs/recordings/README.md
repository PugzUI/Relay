# Signature interaction recording

`committed-event.webm` is a three-second recording of the real committed-event pulse along an existing topology path. It was generated from six deterministic CDP frames captured while an isolated Relay store and broker delivered a new committed record to the functioning UI.

The source frames are retained in `frames/` and the reproducible capture script is `generate-pulse.mjs`. Run `node docs/recordings/generate-pulse.mjs` from the project root to regenerate the frames, then encode them with `ffmpeg -pattern_type glob -framerate 2 -i 'docs/recordings/frames/*.png' -c:v libvpx-vp9 -pix_fmt yuv420p -y docs/recordings/committed-event.webm`.

The recording is fixture evidence, not a native-agent or production network qualification. A human should still capture a live production-device clip before external publication.
