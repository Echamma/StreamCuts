import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

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
    },
  ) {
    if (!file) {
      throw new BadRequestException('An audio file is required.')
    }

    try {
      return await this.transcribeFilePath({
        inputPath: file.path,
        originalName: file.originalname,
        language: input.language,
        model: input.model,
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
    deleteAfter = false,
  }: {
    inputPath: string
    originalName: string
    language?: string
    model?: string
    deleteAfter?: boolean
  }) {
    if (!existsSync(this.scriptPath)) {
      throw new InternalServerErrorException(
        `Transcription script not found at ${this.scriptPath}.`,
      )
    }

    const normalizedLanguage = this.normalizeLanguage(language)
    const normalizedModel = this.normalizeModel(model)

    try {
      this.logger.log(
        `Starting backend transcription for ${originalName}${normalizedModel ? ` with model "${normalizedModel}"` : ''}.`,
      )

      const worker = await this.ensureWorker()
      const payload = await this.sendWorkerRequest(worker, {
        action: 'transcribe',
        input_path: inputPath,
        language: normalizedLanguage ?? null,
        model: normalizedModel ?? null,
      })
      const result = this.parseTranscriptionResult(payload)

      this.logger.log(
        `Backend transcription completed for ${originalName} with ${result.segments.length} segment(s). VAD fallback used: ${result.usedVadFallback === true}.`,
      )
      return result
    } finally {
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

  private parseTranscriptionResult(payload: unknown): TranscriptionResult {
    if (!isRecord(payload) || typeof payload.text !== 'string' || typeof payload.language !== 'string') {
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
