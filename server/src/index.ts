import { ConfigurationError, loadConfig } from './config.ts'
import { startServer } from './lifecycle.ts'

try {
  const config = loadConfig()
  const server = await startServer(config)
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    // Absolute process deadline also covers an unexpectedly stuck driver close.
    const deadline = setTimeout(
      () => {
        process.stderr.write('{"event":"shutdown_deadline","code":"SERVER_UNAVAILABLE"}\n')
        process.exit(1)
      },
      config.shutdownTimeoutMs + config.operationTimeoutMs + 1000,
    )
    void server.stop().then(
      () => {
        clearTimeout(deadline)
        process.off('SIGINT', shutdown)
        process.off('SIGTERM', shutdown)
      },
      () => {
        clearTimeout(deadline)
        process.exitCode = 1
      },
    )
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // Consumers may signal the process as soon as this log is observable.
  server.app.log.info({ event: 'started' })
} catch (error) {
  // Configuration/driver exceptions can contain credentials. Never log the original error.
  process.stderr.write(
    JSON.stringify({
      event: 'startup_failed',
      code: 'SERVER_START_FAILED',
      ...(error instanceof ConfigurationError ? { reason: error.message } : {}),
    }) + '\n',
  )
  process.exitCode = 1
}
