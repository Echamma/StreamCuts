import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const dataDirectory = resolve(process.cwd(), 'data')
const transcriptionTempDirectory = join(dataDirectory, 'transcription')

export type TranscriptionProfile = 'captions' | 'longform'

export type TranscriptionWord = {
  word: string
  start: number
  end: number
  probability?: number
}

export type TranscriptionSegment = {
  text: string
  start: number
  end: number
  words?: TranscriptionWord[]
}

export type TranscriptionResult = {
  text: string
  language: string
  segments: TranscriptionSegment[]
  usedVadFallback?: boolean
}

export type ModelDownloadResult = {
  model: string
  downloaded: boolean
}

export type ModelStatus = {
  id: string
  downloaded: boolean
}

export type ModelListResult = {
  default: string | null
  active: string | null
  models: ModelStatus[]
}

type PendingWorkerRequest = {
  resolve: (payload: unknown) => void
  reject: (reason?: unknown) => void
}

type PythonWorker = {
  process: ChildProcessWithoutNullStreams
  pendingRequests: Map<string, PendingWorkerRequest>
}

type ResolvedTranscriptionRequest = {
  language?: string
  model: string
  profile: TranscriptionProfile
  beamSize: number
  wordTimestamps: boolean
  batchSize: number
  device?: TranscriptionDevice
  computeType?: string
}

export const TRANSCRIPTION_DEVICES = ['auto', 'cuda', 'cpu'] as const
export type TranscriptionDevice = (typeof TRANSCRIPTION_DEVICES)[number]

export function isTranscriptionDevice(value: unknown): value is TranscriptionDevice {
  return typeof value === 'string' && (TRANSCRIPTION_DEVICES as readonly string[]).includes(value)
}

type PreparedTranscriptionInput = {
  inputPath: string
  deleteAfter: boolean
}

@Injectable()
export class TranscriptionService implements OnModuleDestroy {
  private readonly logger = new Logger(TranscriptionService.name)
  private readonly pythonBin = process.env.PYTHON_BIN ?? 'python'
  private readonly scriptPath = resolve(process.cwd(), 'python', 'transcribe.py')
  private workerPromise: Promise<PythonWorker> | null = null

  async transcribeMedia(
    file: Express.Multer.File,
    input: {
      language?: string
      model?: string
      profile?: TranscriptionProfile
    },
  ) {
    if (!file) {
      throw new BadRequestException('An audio or video file is required.')
    }

    try {
      return await this.transcribeFilePath({
        inputPath: file.path,
        originalName: file.originalname,
        language: input.language,
        model: input.model,
        profile: input.profile ?? 'captions',
        deleteAfter: true,
      })
    } catch (error) {
      const message =
        error instanceof InternalServerErrorException
          ? this.getExceptionMessage(error)
          : this.getWorkerErrorMessage(error)

      this.logger.error(`Backend transcription failed for ${file.originalname}: ${message}`)

      throw new InternalServerErrorException(message)
    }
  }

  async transcribeFilePath({
    inputPath,
    originalName,
    language,
    model,
    profile = 'longform',
    deleteAfter = false,
    device,
    computeType,
  }: {
    inputPath: string
    originalName: string
    language?: string
    model?: string
    profile?: TranscriptionProfile
    deleteAfter?: boolean
    device?: TranscriptionDevice
    computeType?: string
  }) {
    if (!existsSync(this.scriptPath)) {
      throw new InternalServerErrorException(
        `Transcription script not found at ${this.scriptPath}.`,
      )
    }

    const request = this.resolveTranscriptionRequest({
      language,
      model,
      profile,
      device,
      computeType,
    })
    let preparedInput: PreparedTranscriptionInput | null = null

    try {
      this.logger.log(
        `Starting backend transcription for ${originalName} with profile "${request.profile}", model "${request.model}", beam ${request.beamSize}, word timestamps ${request.wordTimestamps}, batch size ${request.batchSize}, device "${request.device ?? 'env-default'}", computeType "${request.computeType ?? 'env-default'}".`,
      )

      preparedInput = await this.prepareInputForTranscription({
        inputPath,
        originalName,
      })

      const worker = await this.ensureWorker()
      const payload = await this.sendWorkerRequest(worker, {
        action: 'transcribe',
        input_path: preparedInput.inputPath,
        language: request.language ?? null,
        model: request.model,
        beam_size: request.beamSize,
        word_timestamps: request.wordTimestamps,
        batch_size: request.batchSize,
        device: request.device,
        compute_type: request.computeType,
      })
      const result = this.parseTranscriptionResult(payload)

      this.logger.log(
        `Backend transcription completed for ${originalName} with ${result.segments.length} segment(s). VAD fallback used: ${result.usedVadFallback === true}.`,
      )
      return result
    } finally {
      if (preparedInput?.deleteAfter) {
        this.deleteTempFile(preparedInput.inputPath)
      }
      if (deleteAfter) {
        this.deleteTempFile(inputPath)
      }
    }
  }

  async ensureModelDownloaded(model: string): Promise<ModelDownloadResult> {
    const normalizedModel = this.normalizeModel(model)
    if (!normalizedModel) {
      throw new BadRequestException('A model name is required.')
    }

    if (!existsSync(this.scriptPath)) {
      throw new InternalServerErrorException(
        `Transcription script not found at ${this.scriptPath}.`,
      )
    }

    try {
      this.logger.log(`Ensuring transcription model "${normalizedModel}" is downloaded.`)

      const worker = await this.ensureWorker()
      const payload = await this.sendWorkerRequest(worker, {
        action: 'ensure_model',
        model: normalizedModel,
      })
      const result = this.parseModelDownloadResult(payload)

      this.logger.log(`Transcription model "${normalizedModel}" is ready.`)
      return result
    } catch (error) {
      const message =
        error instanceof InternalServerErrorException
          ? this.getExceptionMessage(error)
          : this.getWorkerErrorMessage(error)

      this.logger.error(`Model download failed for "${normalizedModel}": ${message}`)

      throw new InternalServerErrorException(message)
    }
  }

  async listModels(models: string[]): Promise<ModelListResult> {
    if (!existsSync(this.scriptPath)) {
      throw new InternalServerErrorException(
        `Transcription script not found at ${this.scriptPath}.`,
      )
    }

    const worker = await this.ensureWorker()
    const payload = await this.sendWorkerRequest(worker, {
      action: 'list_models',
      models,
    })
    return this.parseModelListResult(payload)
  }

  onModuleDestroy() {
    this.disposeWorker()
  }

  private normalizeLanguage(language?: string) {
    if (!language) {
      return undefined
    }

    const trimmed = language.trim()
    if (!trimmed || trimmed === 'auto') {
      return undefined
    }

    return trimmed
  }

  private normalizeModel(model?: string) {
    if (!model) {
      return undefined
    }

    const trimmed = model.trim()
    return trimmed || undefined
  }

  private normalizeProfile(profile?: string): TranscriptionProfile {
    return profile === 'captions' ? 'captions' : 'longform'
  }

  private resolveTranscriptionRequest({
    language,
    model,
    profile,
    device,
    computeType,
  }: {
    language?: string
    model?: string
    profile?: TranscriptionProfile
    device?: TranscriptionDevice
    computeType?: string
  }): ResolvedTranscriptionRequest {
    const resolvedProfile = this.normalizeProfile(profile)

    return {
      language: this.normalizeLanguage(language),
      model:
        this.normalizeModel(model) ?? this.getProfileDefaultModel(resolvedProfile),
      profile: resolvedProfile,
      beamSize: this.getProfileBeamSize(resolvedProfile),
      wordTimestamps: this.getProfileWordTimestamps(resolvedProfile),
      batchSize: this.getProfileBatchSize(resolvedProfile),
      device: device && isTranscriptionDevice(device) ? device : undefined,
      computeType: typeof computeType === 'string' && computeType.trim()
        ? computeType.trim()
        : undefined,
    }
  }

  private getProfileDefaultModel(profile: TranscriptionProfile) {
    if (profile === 'captions') {
      return this.getStringEnv('FASTER_WHISPER_CAPTION_MODEL') ?? 'small'
    }

    return (
      this.getStringEnv('FASTER_WHISPER_LONGFORM_MODEL') ??
      this.getStringEnv('FASTER_WHISPER_MODEL') ??
      'medium'
    )
  }

  private getProfileBeamSize(profile: TranscriptionProfile) {
    if (profile === 'captions') {
      return this.getPositiveIntEnv('FASTER_WHISPER_CAPTION_BEAM_SIZE') ?? 2
    }

    return (
      this.getPositiveIntEnv('FASTER_WHISPER_LONGFORM_BEAM_SIZE') ??
      this.getPositiveIntEnv('FASTER_WHISPER_BEAM_SIZE') ??
      5
    )
  }

  private getProfileWordTimestamps(profile: TranscriptionProfile) {
    if (profile === 'captions') {
      return (
        this.getBooleanEnv('FASTER_WHISPER_CAPTION_WORD_TIMESTAMPS') ?? true
      )
    }

    return (
      this.getBooleanEnv('FASTER_WHISPER_LONGFORM_WORD_TIMESTAMPS') ?? false
    )
  }

  private getProfileBatchSize(profile: TranscriptionProfile) {
    if (profile === 'captions') {
      return this.getPositiveIntEnv('FASTER_WHISPER_CAPTION_BATCH_SIZE') ?? 1
    }

    return this.getPositiveIntEnv('FASTER_WHISPER_LONGFORM_BATCH_SIZE') ?? 4
  }

  private getStringEnv(name: string) {
    const raw = process.env[name]
    if (!raw) {
      return undefined
    }

    const trimmed = raw.trim()
    return trimmed || undefined
  }

  private getPositiveIntEnv(name: string) {
    const raw = this.getStringEnv(name)
    if (!raw) {
      return undefined
    }

    const value = Number.parseInt(raw, 10)
    return Number.isInteger(value) && value > 0 ? value : undefined
  }

  private getBooleanEnv(name: string) {
    const raw = this.getStringEnv(name)
    if (!raw) {
      return undefined
    }

    if (raw === '1' || raw.toLowerCase() === 'true') {
      return true
    }

    if (raw === '0' || raw.toLowerCase() === 'false') {
      return false
    }

    return undefined
  }

  private async prepareInputForTranscription({
    inputPath,
    originalName,
  }: {
    inputPath: string
    originalName: string
  }): Promise<PreparedTranscriptionInput> {
    const extension = extname(originalName || inputPath).toLowerCase()
    if (extension === '.wav' || extension === '.wave') {
      return { inputPath, deleteAfter: false }
    }

    if (!ffmpegPath) {
      throw new InternalServerErrorException(
        'The bundled ffmpeg binary is unavailable. Reinstall backend dependencies.',
      )
    }

    mkdirSync(transcriptionTempDirectory, { recursive: true })
    const outputPath = join(
      transcriptionTempDirectory,
      `${randomUUID()}-transcription.wav`,
    )

    try {
      const { stderr } = await execFileAsync(
        ffmpegPath,
        [
          '-y',
          '-i',
          inputPath,
          '-vn',
          '-acodec',
          'pcm_s16le',
          '-ar',
          '16000',
          '-ac',
          '1',
          outputPath,
        ],
        { windowsHide: true },
      )

      if (!existsSync(outputPath)) {
        throw new InternalServerErrorException(
          'FFmpeg did not produce a transcription WAV file.',
        )
      }

      if (stderr?.trim()) {
        this.logger.debug(`FFmpeg transcription prep output: ${stderr.trim()}`)
      }

      return {
        inputPath: outputPath,
        deleteAfter: true,
      }
    } catch (error) {
      this.deleteTempFile(outputPath)

      if (error instanceof InternalServerErrorException) {
        throw error
      }

      const message =
        isRecord(error) && typeof error.message === 'string' && error.message.trim()
          ? error.message.trim()
          : 'FFmpeg failed to prepare audio for transcription.'
      throw new InternalServerErrorException(message)
    }
  }

  private parseTranscriptionResult(payload: unknown): TranscriptionResult {
    if (
      !isRecord(payload) ||
      typeof payload.text !== 'string' ||
      typeof payload.language !== 'string'
    ) {
      throw new InternalServerErrorException(
        'Python transcription returned an invalid payload.',
      )
    }

    if (!Array.isArray(payload.segments)) {
      throw new InternalServerErrorException(
        'Python transcription returned invalid segments.',
      )
    }

    const segments = payload.segments
      .map((segment) => this.parseSegment(segment))
      .filter((segment): segment is TranscriptionSegment => segment !== null)

    return {
      text: payload.text,
      language: payload.language,
      segments,
      usedVadFallback: payload.usedVadFallback === true,
    }
  }

  private parseSegment(payload: unknown): TranscriptionSegment | null {
    if (
      !isRecord(payload) ||
      typeof payload.text !== 'string' ||
      typeof payload.start !== 'number' ||
      typeof payload.end !== 'number'
    ) {
      return null
    }

    const words = Array.isArray(payload.words)
      ? payload.words
          .map((word) => this.parseWord(word))
          .filter((word): word is TranscriptionWord => word !== null)
      : []

    return {
      text: payload.text,
      start: payload.start,
      end: payload.end,
      ...(words.length > 0 ? { words } : {}),
    }
  }

  private parseWord(payload: unknown): TranscriptionWord | null {
    if (
      !isRecord(payload) ||
      typeof payload.word !== 'string' ||
      typeof payload.start !== 'number' ||
      typeof payload.end !== 'number'
    ) {
      return null
    }

    return {
      word: payload.word,
      start: payload.start,
      end: payload.end,
      ...(typeof payload.probability === 'number'
        ? { probability: payload.probability }
        : {}),
    }
  }

  private parseModelDownloadResult(payload: unknown): ModelDownloadResult {
    if (!isRecord(payload) || typeof payload.model !== 'string') {
      throw new InternalServerErrorException(
        'Model download returned an invalid payload.',
      )
    }

    return {
      model: payload.model,
      downloaded: payload.downloaded === true,
    }
  }

  private parseModelListResult(payload: unknown): ModelListResult {
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
      throw new InternalServerErrorException(
        'Model list returned an invalid payload.',
      )
    }

    const models = payload.models
      .map((entry) => this.parseModelStatus(entry))
      .filter((entry): entry is ModelStatus => entry !== null)

    return {
      default: typeof payload.default === 'string' ? payload.default : null,
      active: typeof payload.active === 'string' ? payload.active : null,
      models,
    }
  }

  private parseModelStatus(payload: unknown): ModelStatus | null {
    if (!isRecord(payload) || typeof payload.id !== 'string') {
      return null
    }

    return {
      id: payload.id,
      downloaded: payload.downloaded === true,
    }
  }

  private async ensureWorker(): Promise<PythonWorker> {
    if (this.workerPromise) {
      return this.workerPromise
    }

    this.workerPromise = new Promise<PythonWorker>((resolveWorker, rejectWorker) => {
      const workerProcess = spawn(this.pythonBin, [this.scriptPath, '--serve'], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      const worker: PythonWorker = {
        process: workerProcess,
        pendingRequests: new Map<string, PendingWorkerRequest>(),
      }

      const stdoutInterface = createInterface({ input: workerProcess.stdout })
      const stderrInterface = createInterface({ input: workerProcess.stderr })
      const startupStderr: string[] = []
      let isReady = false

      const rejectStartup = (reason: unknown) => {
        if (isReady) {
          return
        }

        stdoutInterface.close()
        stderrInterface.close()
        workerProcess.kill()
        this.workerPromise = null
        rejectWorker(reason)
      }

      stderrInterface.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) {
          return
        }

        if (!isReady) {
          startupStderr.push(trimmed)
        }

        this.logger.warn(`Python stderr: ${trimmed}`)
      })

      stdoutInterface.on('line', (line) => {
        if (!isReady) {
          try {
            const payload: unknown = JSON.parse(line)
            if (isRecord(payload) && payload.type === 'ready') {
              isReady = true
              this.logger.log('Faster-Whisper worker is ready.')
              resolveWorker(worker)
              return
            }
          } catch {
            rejectStartup(
              new InternalServerErrorException('Python transcription worker returned invalid startup output.'),
            )
            return
          }

          rejectStartup(
            new InternalServerErrorException('Python transcription worker failed to start correctly.'),
          )
          return
        }

        this.handleWorkerOutputLine(worker, line)
      })

      workerProcess.once('error', (error) => {
        const failure = new InternalServerErrorException(
          this.getWorkerStartupErrorMessage(error, startupStderr),
        )

        if (!isReady) {
          rejectStartup(failure)
          return
        }

        this.handleWorkerExit(worker, failure.message)
      })

      workerProcess.once('exit', (code, signal) => {
        const message = this.getWorkerExitMessage({ code, signal, startupStderr })

        if (!isReady) {
          rejectStartup(new InternalServerErrorException(message))
          return
        }

        this.handleWorkerExit(worker, message)
      })
    })

    return this.workerPromise
  }

  private sendWorkerRequest(
    worker: PythonWorker,
    request: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const requestId = randomUUID()

      worker.pendingRequests.set(requestId, {
        resolve,
        reject,
      })

      const requestLine = JSON.stringify({
        id: requestId,
        ...request,
      })

      worker.process.stdin.write(`${requestLine}\n`, (error) => {
        if (!error) {
          return
        }

        worker.pendingRequests.delete(requestId)
        reject(
          new InternalServerErrorException(
            'Failed to send work to the Faster-Whisper worker.',
          ),
        )
      })
    })
  }

  private handleWorkerOutputLine(worker: PythonWorker, line: string) {
    let payload: unknown

    try {
      payload = JSON.parse(line)
    } catch {
      this.logger.warn(`Python stdout was not valid JSON: ${line}`)
      return
    }

    if (!isRecord(payload) || typeof payload.id !== 'string' || typeof payload.ok !== 'boolean') {
      this.logger.warn(`Python stdout returned an unexpected payload: ${line}`)
      return
    }

    const pendingRequest = worker.pendingRequests.get(payload.id)
    if (!pendingRequest) {
      this.logger.warn(`Received a transcription response for unknown request ${payload.id}.`)
      return
    }

    worker.pendingRequests.delete(payload.id)

    if (!payload.ok) {
      pendingRequest.reject(
        new InternalServerErrorException(
          typeof payload.error === 'string' && payload.error
            ? payload.error
            : 'Python transcription failed.',
        ),
      )
      return
    }

    pendingRequest.resolve(payload.payload)
  }

  private handleWorkerExit(worker: PythonWorker, message: string) {
    if (this.workerPromise) {
      this.workerPromise = null
    }

    for (const [requestId, pendingRequest] of worker.pendingRequests.entries()) {
      worker.pendingRequests.delete(requestId)
      pendingRequest.reject(new InternalServerErrorException(message))
    }
  }

  private disposeWorker() {
    if (!this.workerPromise) {
      return
    }

    void this.workerPromise
      .then((worker) => {
        worker.process.kill()
      })
      .catch(() => {
        // Ignore shutdown-time cleanup failures.
      })
      .finally(() => {
        this.workerPromise = null
      })
  }

  private getWorkerErrorMessage(error: unknown) {
    if (error instanceof InternalServerErrorException) {
      return this.getExceptionMessage(error)
    }

    if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim()
    }

    return 'Python transcription failed.'
  }

  private getWorkerStartupErrorMessage(error: unknown, stderrLines: string[]) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return `Python executable "${this.pythonBin}" was not found. Install Python or set PYTHON_BIN.`
    }

    const stderr = stderrLines.join('\n').trim()
    return this.normalizePythonErrorMessage(stderr)
  }

  private getWorkerExitMessage({
    code,
    signal,
    startupStderr,
  }: {
    code: number | null
    signal: NodeJS.Signals | null
    startupStderr: string[]
  }) {
    const stderr = startupStderr.join('\n').trim()

    if (stderr) {
      return this.normalizePythonErrorMessage(stderr)
    }

    if (signal) {
      return `Python transcription worker exited with signal ${signal}.`
    }

    if (code === null || code === 0) {
      return 'Python transcription worker exited unexpectedly.'
    }

    return `Python transcription worker exited with code ${code}.`
  }

  private normalizePythonErrorMessage(message: string) {
    if (message.includes("No module named 'faster_whisper'")) {
      return 'Python dependency missing: install faster-whisper in the backend Python environment.'
    }

    if (message) {
      return message.split('\n').filter(Boolean)[0] ?? 'Python transcription failed.'
    }

    return 'Python transcription failed.'
  }

  private getExceptionMessage(error: InternalServerErrorException) {
    const response = error.getResponse()
    if (typeof response === 'string') {
      return response
    }

    if (isRecord(response) && typeof response.message === 'string') {
      return response.message
    }

    return error.message
  }

  private deleteTempFile(filePath: string) {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
    } catch {
      // Ignore cleanup failures so the request can still complete.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
