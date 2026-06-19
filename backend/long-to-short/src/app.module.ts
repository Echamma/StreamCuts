import { Module } from '@nestjs/common'
import { LongToShortController } from './long-to-short.controller'
import { LongToShortService } from './long-to-short.service'
import { TranscriptionController } from './transcription.controller'
import { TranscriptionService } from './transcription.service'
import { BossController } from './boss.controller'
import { BossService } from './boss.service'

@Module({
  controllers: [LongToShortController, TranscriptionController, BossController],
  providers: [LongToShortService, TranscriptionService, BossService],
})
export class AppModule {}
