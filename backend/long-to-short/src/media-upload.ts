import { extname } from 'node:path'

const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.m4v',
  '.mpeg',
  '.mpg',
  '.wmv',
])

const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.opus',
  '.webm',
  '.mp4',
  '.mov',
  '.mkv',
])

export function isAcceptedVideoUpload(file: { mimetype?: string; originalname: string }) {
  const mimeType = (file.mimetype ?? '').toLowerCase()
  if (mimeType.startsWith('video/')) {
    return true
  }

  return VIDEO_EXTENSIONS.has(extname(file.originalname).toLowerCase())
}

export function isAcceptedAudioOrVideoUpload(file: {
  mimetype?: string
  originalname: string
}) {
  const mimeType = (file.mimetype ?? '').toLowerCase()
  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return true
  }

  const extension = extname(file.originalname).toLowerCase()
  return AUDIO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension)
}
