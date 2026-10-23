// Loaded only by the compiled-process integration test. Deliver a real POSIX
// signal in the same call that announces startup, without a parent/child timing race.
const signal = process.env.SAMHAIN_TEST_STARTUP_SIGNAL
if (signal !== 'SIGTERM' && signal !== 'SIGINT') throw new Error('Invalid test signal')

let signalled = false
process.stdout.write = new Proxy(process.stdout.write, {
  apply(write, stream, args: unknown[]) {
    if (!signalled && String(args[0]).includes('"event":"started"')) {
      signalled = true
      if (!process.listenerCount('SIGTERM') || !process.listenerCount('SIGINT')) {
        process.stderr.write('{"event":"startup_signal_handlers_missing"}\n')
        throw new Error('Startup announced before shutdown handlers were installed')
      }
      const result = Reflect.apply(write, stream, args)
      process.kill(process.pid, signal)
      return result
    }
    return Reflect.apply(write, stream, args)
  },
})
