import { describe, expect, it, vi } from 'vitest'
import type { DocumentExporter } from '../native/documentExporter'
import type { IntegrityVerification, SalesArchive } from '../types/salesLedger'
import {
  buildSalesBackupFileName,
  SalesBackupError,
  SalesBackupService,
} from './salesBackupService'

const validVerification: IntegrityVerification = {
  valid: true,
  complete: true,
  entryCount: 1,
  sealedOrderCount: 1,
  legacyOrderIds: [],
  errors: [],
  warnings: [],
  headHash: 'head-hash',
}

const archive: SalesArchive = {
  schemaVersion: 1,
  archiveId: 'archive-abcdef123456',
  exportedAt: '2026-09-16T19:45:00.000Z',
  notice: 'Archive de test',
  source: {
    softwareVersion: '1.0.0',
    buildMode: 'test',
    terminal: {
      terminalId: 'terminal-a',
      terminalCode: 'A',
      displayName: 'Caisse A',
    },
    organization: {
      organizationName: 'Association',
      eventName: 'Samhain',
      city: 'Bernay',
      address: 'Adresse',
      siret: '123',
      vatNumber: 'FR123',
      usesDemoPlaceholders: false,
    },
  },
  metadata: {
    nextOrderSequence: 2,
    nextReceiptSequence: 2,
    nextJournalSequence: 2,
    lastJournalHash: 'head-hash',
  },
  orders: [],
  technicalStates: [],
  entries: [],
  archiveHash: 'archive-hash',
}

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    verifyIntegrity: vi.fn(async () => validVerification),
    exportArchive: vi.fn(async () => structuredClone(archive)),
    verifyArchive: vi.fn(() => validVerification),
    ...overrides,
  }
}

function exporter(
  implementation: DocumentExporter['saveJson'] = async ({ fileName, content }) => ({
    status: 'created',
    uri: 'content://documents/backup',
    fileName,
    content,
    bytesWritten: new TextEncoder().encode(content).length,
  }),
): DocumentExporter {
  return { saveJson: vi.fn(implementation) }
}

describe('SalesBackupService', () => {
  it('génère un nom déterministe compatible avec les systèmes de fichiers', () => {
    expect(buildSalesBackupFileName(archive)).toBe(
      'samhain-pos-backup-caisse-A-20260916-194500-archive-abcd.json',
    )
  })

  it('sérialise, écrit, relit et vérifie la même archive avant tout succès', async () => {
    const ledgerMock = ledger()
    const documentExporter = exporter()
    const service = new SalesBackupService(ledgerMock, documentExporter)

    const result = await service.saveVerifiedBackup(new Date(archive.exportedAt))

    expect(ledgerMock.verifyIntegrity).toHaveBeenCalledOnce()
    expect(ledgerMock.exportArchive).toHaveBeenCalledOnce()
    expect(ledgerMock.verifyArchive).toHaveBeenCalledTimes(2)
    expect(documentExporter.saveJson).toHaveBeenCalledWith({
      fileName: 'samhain-pos-backup-caisse-A-20260916-194500-archive-abcd.json',
      content: `${JSON.stringify(archive, null, 2)}\n`,
    })
    expect(result).toMatchObject({
      status: 'verified',
      fileName: 'samhain-pos-backup-caisse-A-20260916-194500-archive-abcd.json',
      destination: 'content://documents/backup',
    })
  })

  it('refuse avant le sélecteur une intégrité locale ou une archive générée invalide', async () => {
    const native = exporter()
    const invalidIntegrity = ledger({
      verifyIntegrity: vi.fn(async () => ({
        ...validVerification,
        valid: false,
        complete: false,
        errors: ['chaîne rompue'],
      })),
    })
    await expect(
      new SalesBackupService(invalidIntegrity, native).saveVerifiedBackup(),
    ).rejects.toMatchObject({
      code: 'integrity-invalid',
    })
    expect(native.saveJson).not.toHaveBeenCalled()

    const invalidArchive = ledger({
      verifyArchive: vi.fn(() => ({
        ...validVerification,
        valid: false,
        complete: false,
        errors: ['archive invalide'],
      })),
    })
    await expect(
      new SalesBackupService(invalidArchive, native).saveVerifiedBackup(),
    ).rejects.toMatchObject({
      code: 'generated-archive-invalid',
    })
    expect(native.saveJson).not.toHaveBeenCalled()
  })

  it('refuse une archive impossible à sérialiser sans ouvrir le sélecteur', async () => {
    const cyclicArchive = structuredClone(archive) as SalesArchive & { cycle?: unknown }
    cyclicArchive.cycle = cyclicArchive
    const native = exporter()
    const service = new SalesBackupService(
      ledger({ exportArchive: vi.fn(async () => cyclicArchive) }),
      native,
    )

    await expect(service.saveVerifiedBackup()).rejects.toMatchObject({
      code: 'serialization-failed',
    })
    expect(native.saveJson).not.toHaveBeenCalled()
  })

  it('distingue une annulation utilisateur d’un succès', async () => {
    const service = new SalesBackupService(
      ledger(),
      exporter(async () => ({ status: 'cancelled' })),
    )
    await expect(service.saveVerifiedBackup()).resolves.toEqual({ status: 'cancelled' })
  })

  it.each([
    ['PERMISSION_DENIED', 'permission-denied'],
    ['DESTINATION_UNAVAILABLE', 'destination-unavailable'],
    ['WRITE_FAILED', 'write-failed'],
    ['READ_FAILED', 'read-failed'],
    ['DOCUMENT_PICKER_UNAVAILABLE', 'picker-unavailable'],
  ] as const)('traduit l’échec natif %s sans faux succès', async (nativeCode, expectedCode) => {
    const failure = Object.assign(new Error('native failure'), { code: nativeCode })
    const service = new SalesBackupService(
      ledger(),
      exporter(async () => {
        throw failure
      }),
    )
    await expect(service.saveVerifiedBackup()).rejects.toMatchObject({ code: expectedCode })
  })

  it('refuse un JSON relu illisible', async () => {
    const service = new SalesBackupService(
      ledger(),
      exporter(async ({ fileName, content }) => ({
        status: 'created',
        uri: 'content://bad-json',
        fileName,
        content: content.slice(0, 12),
        bytesWritten: 12,
      })),
    )
    await expect(service.saveVerifiedBackup()).rejects.toMatchObject({ code: 'read-invalid-json' })
  })

  it.each([
    ['archiveId', 'another-archive', 'archive-id-mismatch'],
    ['archiveHash', 'another-hash', 'archive-hash-mismatch'],
  ] as const)('refuse un %s différent dans le fichier relu', async (field, value, code) => {
    const service = new SalesBackupService(
      ledger(),
      exporter(async ({ fileName, content }) => {
        const reread = JSON.parse(content) as SalesArchive
        reread[field] = value
        const modified = `${JSON.stringify(reread, null, 2)}\n`
        return {
          status: 'created',
          uri: 'content://modified',
          fileName,
          content: modified,
          bytesWritten: new TextEncoder().encode(modified).length,
        }
      }),
    )
    await expect(service.saveVerifiedBackup()).rejects.toMatchObject({ code })
  })

  it('refuse une archive relue invalide et un contenu non identique', async () => {
    const invalidRereadLedger = ledger({
      verifyArchive: vi
        .fn()
        .mockReturnValueOnce(validVerification)
        .mockReturnValueOnce({
          ...validVerification,
          valid: false,
          complete: false,
          errors: ['archive altérée'],
        }),
    })
    await expect(
      new SalesBackupService(invalidRereadLedger, exporter()).saveVerifiedBackup(),
    ).rejects.toMatchObject({ code: 'exported-archive-invalid' })

    const whitespaceChanged = exporter(async ({ fileName, content }) => ({
      status: 'created',
      uri: 'content://rewritten',
      fileName,
      content: content.trim(),
      bytesWritten: new TextEncoder().encode(content.trim()).length,
    }))
    await expect(
      new SalesBackupService(ledger(), whitespaceChanged).saveVerifiedBackup(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SalesBackupError>>({ code: 'content-mismatch' }),
    )
  })
})
