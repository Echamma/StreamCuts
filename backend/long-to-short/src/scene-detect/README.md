# Scene detection (MED-008)

Backend scene-cut detection: ffmpeg's `select='gt(scene,T)'` scores each frame's
difference from its predecessor and passes only the ones above a threshold;
`showinfo` logs their timestamps, which we parse into a cut list. Cuts can feed
markers (EDIT-005) or auto-split.

## Modules

- **`scene-detect-args.ts`** — pure arg builder (`buildSceneDetectArgs`) +
  `parseSceneTimestamps` (reads the `showinfo` stderr, drops time 0, de-dupes,
  sorts). No I/O; unit-tested.
- **`scene-detect-runner.ts`** — `detectScenes` (ffmpeg binary path injected, so
  no dependency on `ffmpeg-static`). Returns `{ cuts: number[] }` in seconds.
- **`scene-detect-args.test.ts`** — `node:test` unit tests.
- **`verify-scene-detect.ts`** — end-to-end: synthesises a 3-scene clip (bars →
  red → blue) and asserts cuts land at ~1s and ~2s.

## HTTP endpoint

`../scene-detect.controller.ts` + `../scene-detect.service.ts` (registered in
`app.module.ts`): `POST /api/scene-detect` — multipart `video` (+ optional
`threshold`) → `{ cuts: number[] }`. The service resolves `ffmpeg-static`, or
honours `FFMPEG_PATH`.

## Running

```bash
npm run test:scene-detect     # unit tests
npm run verify:scene-detect   # end-to-end (needs ffmpeg on PATH)
```

## Not yet wired

The editor side — turning cuts into timeline markers or an auto-split — is the
follow-up.
