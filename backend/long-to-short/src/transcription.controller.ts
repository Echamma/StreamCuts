import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { diskStorage } from 'multer'
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getUploadDirectory } from './long-to-short.service'
import { isAcceptedAudioOrVideoUpload } from './media-upload'
import { TranscriptionService } from './transcription.service'

@Controller()
export class TranscriptionController {
  constructor(private readonly transcriptionService: TranscriptionService) {}

  @Post('/api/transcription/transcribe')
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: diskStorage({
        destination: (_request, _file, callback) => {
          callback(null, getUploadDirectory())
        },
        filename: (_request, file, callback) => {
          callback(null, `${randomUUID()}${extname(file.originalname) || '.wav'}`)
        },
      }),
      fileFilter: (_request, file, callback) => {
        if (!isAcceptedAudioOrVideoUpload(file)) {
          callback(
            new BadRequestException('Only audio or video uploads are supported.'),
            false,
          )
          return
        }

        callback(null, true)
      },
    }),
  )
  async transcribe(
    @UploadedFile() file: Express.Multer.File,
    @Body('language') language?: string,
    @Body('model') model?: string,
  ) {
    return this.transcriptionService.transcribeMedia(file, { language, model })
  }

  @Post('/api/transcription/models/status')
  async modelStatus(@Body('models') models?: unknown) {
    const ids = Array.isArray(models)
      ? models.filter((id): id is string => typeof id === 'string')
      : []
    return this.transcriptionService.listModels(ids)
  }

  @Post('/api/transcription/models/download')
  async downloadModel(@Body('model') model?: string) {
    if (typeof model !== 'string' || !model.trim()) {
      throw new BadRequestException('A model name is required.')
    }
    return this.transcriptionService.ensureModelDownloaded(model)
  }
}
