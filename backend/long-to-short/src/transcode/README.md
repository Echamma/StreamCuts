# Transcode (DEL-003 pro codecs · MED-005 proxies)

Server-side ffmpeg transcoding: **Apple ProRes** masters (DEL-003) and
**H.264 editing proxies** (MED-005). Both run on the backend because the
browser can't encode ProRes natively, and proxies are cheaper to generate once
server-side than per-client.

## Modules

- **`transcode-args.ts`** — pure ffmpeg/ffprobe argument builders
  (`buildProxyArgs`, `buildProResArgs`, `buildProbeArgs`, `parseProbeJson`). No
  I/O, no dependencies; the unit tests cover these.
- **`transcode-runner.ts`** — thin runner (`transcodeToProxy`,
  `transcodeToProRes`, `probeMedia`). ffmpeg/ffprobe **binary paths are passed
  in**, so it has no dependency on `ffmpeg-static` and runs anywhere Node +
  ffmpeg do. A NestJS service resolves the bundled binaries and calls it.
- **`transcode-args.test.ts`** — `node:test` unit tests for the argument
  vectors and probe parsing (no external test framework).
- **`verify-transcode.ts`** — end-to-end harness: synthesises a clip with
  ffmpeg, runs both transcodes, and asserts the output with ffprobe (codec,
  scaling, duration). Objective, non-perceptual proof the codecs come out right.

## Running

```bash
npm run test:transcode     # unit tests (build → node --test)
npm run verify:transcode   # end-to-end, needs ffmpeg + ffprobe available
```

`verify-transcode` uses the system `ffmpeg`/`ffprobe` on `PATH` by default;
override with `FFMPEG_PATH` / `FFPROBE_PATH`.

## Profiles

ProRes: `proxy` · `lt` · `standard` (default) · `hq` · `4444` · `4444xq`. The
4444 profiles carry alpha (`yuva444p10le`); the rest are `yuv422p10le`.

## HTTP endpoint

Wired in `../transcode.controller.ts` + `../transcode.service.ts` (registered in
`app.module.ts`), shaped like `long-to-short.controller.ts`:

- `POST /api/transcode/proxy` — multipart `video` (+ optional `height`) → JSON
  `{ id, fileName, video }`.
- `POST /api/transcode/prores` — multipart `video` (+ optional `profile`) → same.
- `POST /api/transcode/optimized` — multipart `video` (+ optional `crf`) →
  same; source-resolution all-intra H.264 (MED-006), for source codecs the
  browser decodes poorly.
- `GET /api/transcode/outputs/:fileName` — download the result.

The service resolves `ffmpeg-static`/`ffprobe-static`, or honours `FFMPEG_PATH`
/`FFPROBE_PATH` when the host has its own (fuller) ffmpeg build.

## Not yet wired

The editor's proxy-preference (prefer the proxy sink while editing, full-res on
export) and the ProRes option in the export menu are the remaining follow-up.
