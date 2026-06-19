import 'dotenv/config'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
	const app = await NestFactory.create(AppModule)
	const port = Number(process.env.PORT ?? 4000)
	const configuredOrigins = (process.env.FRONTEND_ORIGIN ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean)

	app.enableCors({
		origin: (
			origin: string | undefined,
			callback: (error: Error | null, allow?: boolean) => void,
		) => {
			if (!origin) {
				callback(null, true)
				return
			}

			if (configuredOrigins.includes(origin)) {
				callback(null, true)
				return
			}

			try {
				const { hostname } = new URL(origin)
				const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1'
				callback(null, isLocalHost)
			} catch {
				callback(null, false)
			}
		},
	})

	await app.listen(port)
	console.log(`Long-to-short backend listening on http://localhost:${port}`)
}

void bootstrap()
