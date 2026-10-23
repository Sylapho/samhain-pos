import { buildApp } from './app.ts'
import type { AppDependencies } from './app.ts'
import type { Config } from './config.ts'
import { createDatabase } from './database.ts'
import type { FastifyInstance } from 'fastify'

export async function startServer(
  config: Config,
  dependencies: AppDependencies = { database: createDatabase(config) },
) {
  const database = dependencies.database
  let app: FastifyInstance
  try {
    app = await buildApp(config, dependencies)
  } catch {
    await database.close()
    throw new Error('SERVER_START_FAILED')
  }
  let stopping: Promise<void> | undefined
  function stop(): Promise<void> {
    stopping ??= (async () => {
      app.log.info({ event: 'shutdown' })
      const timer = setTimeout(() => app.server.closeAllConnections(), config.shutdownTimeoutMs)
      try {
        await app.close()
      } finally {
        clearTimeout(timer)
        await database.close()
      }
    })()
    return stopping
  }
  try {
    await database.connect()
    await database.check()
    app.log.info({ event: 'database_connected' })
    await app.listen({ host: config.host, port: config.port })
    app.log.info({ event: 'started' })
    return { app, stop }
  } catch {
    await stop()
    throw new Error('SERVER_START_FAILED')
  }
}
