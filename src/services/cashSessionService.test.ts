import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type { TerminalConfiguration } from '../types/terminal'
import { IndexedDbOrderRepository } from './orderRepository'
import { CashSessionService } from './cashSessionService'
import { SalesLedgerService } from './salesLedgerService'

const terminal: TerminalConfiguration = {
  terminalId: 'terminal-a',
  terminalCode: 'A',
  displayName: 'Caisse A',
  provisionedAt: '2026-09-01T08:00:00.000Z',
}

function setup(indexedDb: IDBFactory, databaseName: string, ids: string[]) {
  const repository = new IndexedDbOrderRepository(indexedDb, databaseName)
  const nextId = () => ids.shift() ?? 'unused-id'
  return {
    repository,
    sessions: new CashSessionService(
      repository,
      nextId,
      () => terminal,
      undefined,
      () => {},
    ),
    ledger: new SalesLedgerService(
      repository,
      nextId,
      () => terminal,
      undefined,
      () => {},
    ),
  }
}

describe('sessions et fond de caisse', () => {
  it('enregistre 0 €, le rattache à la caisse et le retrouve après recréation du service', async () => {
    const indexedDb = new IDBFactory()
    const first = setup(indexedDb, 'cash-session-persistence', ['session-1'])

    const opened = await first.sessions.openSession(0, new Date('2026-09-01T09:00:00.000Z'))
    expect(opened).toMatchObject({
      id: 'session-1',
      terminal: { terminalId: 'terminal-a', terminalCode: 'A' },
      openingFloatCents: 0,
      periodStart: '2026-09-01T09:00:00.000Z',
    })
    await first.repository.close()

    const reopened = setup(indexedDb, 'cash-session-persistence', ['unused'])
    expect(await reopened.sessions.getActiveSession()).toEqual(opened)
    expect(
      (await reopened.ledger.getEntries()).filter((entry) => entry.kind === 'cash_session_opened'),
    ).toHaveLength(1)
    await reopened.repository.close()
  })

  it('refuse les valeurs négatives ou hors de la plage entière sûre', async () => {
    const { repository, sessions } = setup(new IDBFactory(), 'cash-session-invalid', ['session-1'])

    await expect(sessions.openSession(-1)).rejects.toThrow(/positif ou nul/)
    await expect(sessions.openSession(Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
      /positif ou nul/,
    )
    expect(await sessions.getActiveSession()).toBeNull()
    await repository.close()
  })

  it('ne crée jamais deux fonds pour une même session active', async () => {
    const { repository, sessions, ledger } = setup(new IDBFactory(), 'cash-session-single', [
      'session-1',
      'session-2',
    ])

    const first = await sessions.openSession(15_000, new Date('2026-09-01T09:00:00.000Z'))
    expect(await sessions.openSession(15_000, new Date('2026-09-01T09:01:00.000Z'))).toEqual(first)
    await expect(
      sessions.openSession(20_000, new Date('2026-09-01T09:02:00.000Z')),
    ).rejects.toThrow(/déjà ouverte/)
    expect(
      (await ledger.getEntries()).filter((entry) => entry.kind === 'cash_session_opened'),
    ).toHaveLength(1)
    await repository.close()
  })

  it('journalise une correction volontaire avec ancienne et nouvelle valeurs', async () => {
    const { repository, sessions, ledger } = setup(new IDBFactory(), 'cash-session-update', [
      'session-1',
      'update-1',
    ])
    await sessions.openSession(15_000, new Date('2026-09-01T09:00:00.000Z'))

    const updated = await sessions.updateOpeningFloat(12_500, new Date('2026-09-01T09:05:00.000Z'))
    expect(updated).toMatchObject({ openingFloatCents: 12_500 })
    expect(
      (await ledger.getEntries()).find((entry) => entry.kind === 'cash_float_updated'),
    ).toMatchObject({
      cashFloatUpdate: {
        sessionId: 'session-1',
        previousOpeningFloatCents: 15_000,
        newOpeningFloatCents: 12_500,
      },
    })
    expect((await ledger.verifyIntegrity()).valid).toBe(true)
    await repository.close()
  })

  it('exige un nouveau fond après la clôture et démarre à la fin de la session précédente', async () => {
    const { repository, sessions, ledger } = setup(new IDBFactory(), 'cash-session-renewal', [
      'session-1',
      'closure-1',
      'session-2',
    ])
    await sessions.openSession(15_000, new Date('2026-09-01T09:00:00.000Z'))
    const closureEnd = new Date('2026-09-01T18:00:00.000Z')
    await ledger.closePeriod(
      new Date('2026-09-01T09:00:00.000Z'),
      closureEnd,
      undefined,
      new Date('2026-09-01T18:05:00.000Z'),
    )

    expect(await sessions.getActiveSession()).toBeNull()
    const next = await sessions.openSession(10_000, new Date('2026-09-01T18:10:00.000Z'))
    expect(next).toMatchObject({
      id: 'session-2',
      periodStart: closureEnd.toISOString(),
      openingFloatCents: 10_000,
    })
    await repository.close()
  })
})
