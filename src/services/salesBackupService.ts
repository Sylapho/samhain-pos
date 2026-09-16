import type { DocumentExporter } from '../native/documentExporter'
import { documentExporter } from '../native/documentExporter'
import type { IntegrityVerification, SalesArchive } from '../types/salesLedger'
import { getSalesLedgerService, type SalesLedgerService } from './salesLedgerService'

type BackupLedger = Pick<SalesLedgerService, 'verifyIntegrity' | 'exportArchive' | 'verifyArchive'>

export type SalesBackupErrorCode =
  | 'integrity-invalid'
  | 'generated-archive-invalid'
  | 'serialization-failed'
  | 'picker-unavailable'
  | 'permission-denied'
  | 'destination-unavailable'
  | 'write-failed'
  | 'read-failed'
  | 'read-invalid-json'
  | 'content-mismatch'
  | 'exported-archive-invalid'
  | 'archive-id-mismatch'
  | 'archive-hash-mismatch'

export class SalesBackupError extends Error {
  constructor(
    message: string,
    public readonly code: SalesBackupErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SalesBackupError'
  }
}

export type VerifiedBackupResult =
  | { status: 'cancelled' }
  | {
      status: 'verified'
      archive: SalesArchive
      verification: IntegrityVerification
      fileName: string
      destination: string
      bytesWritten: number
    }

export class SalesBackupService {
  constructor(
    private readonly ledger: BackupLedger = getSalesLedgerService(),
    private readonly exporter: DocumentExporter = documentExporter,
  ) {}

  async saveVerifiedBackup(exportedAt = new Date()): Promise<VerifiedBackupResult> {
    const integrity = await this.ledger.verifyIntegrity()
    if (!integrity.valid) {
      throw new SalesBackupError(
        `Sauvegarde refusée : ${integrity.errors.join(' ')}`,
        'integrity-invalid',
      )
    }

    const archive = await this.ledger.exportArchive(undefined, exportedAt)
    const generatedVerification = this.ledger.verifyArchive(archive)
    if (!generatedVerification.valid) {
      throw new SalesBackupError(
        `L’archive générée est invalide : ${generatedVerification.errors.join(' ')}`,
        'generated-archive-invalid',
      )
    }

    let serialized: string
    try {
      serialized = `${JSON.stringify(archive, null, 2)}\n`
    } catch (error) {
      throw new SalesBackupError(
        'L’archive n’a pas pu être sérialisée en JSON.',
        'serialization-failed',
        { cause: error },
      )
    }

    const fileName = buildSalesBackupFileName(archive)
    let exported
    try {
      exported = await this.exporter.saveJson({ fileName, content: serialized })
    } catch (error) {
      throw mapDocumentExportError(error)
    }
    if (exported.status === 'cancelled') return exported

    let rereadArchive: SalesArchive
    try {
      rereadArchive = JSON.parse(exported.content) as SalesArchive
    } catch (error) {
      throw new SalesBackupError(
        'Le fichier enregistré a été relu, mais son JSON est illisible.',
        'read-invalid-json',
        { cause: error },
      )
    }

    if (rereadArchive.archiveId !== archive.archiveId) {
      throw new SalesBackupError(
        'Le fichier enregistré ne contient pas le même identifiant d’archive.',
        'archive-id-mismatch',
      )
    }
    if (rereadArchive.archiveHash !== archive.archiveHash) {
      throw new SalesBackupError(
        'Le fichier enregistré ne contient pas la même empreinte d’archive.',
        'archive-hash-mismatch',
      )
    }
    const rereadVerification = this.ledger.verifyArchive(rereadArchive)
    if (!rereadVerification.valid) {
      throw new SalesBackupError(
        `Le fichier enregistré a été relu, mais son archive est invalide : ${rereadVerification.errors.join(' ')}`,
        'exported-archive-invalid',
      )
    }
    if (exported.content !== serialized) {
      throw new SalesBackupError(
        'Le fichier relu ne correspond pas exactement à l’archive écrite.',
        'content-mismatch',
      )
    }

    return {
      status: 'verified',
      archive: rereadArchive,
      verification: rereadVerification,
      fileName: exported.fileName || fileName,
      destination: exported.uri,
      bytesWritten: exported.bytesWritten,
    }
  }
}

export function buildSalesBackupFileName(archive: SalesArchive): string {
  const date = new Date(archive.exportedAt)
  if (Number.isNaN(date.getTime())) throw new Error('La date d’export de l’archive est invalide.')
  const timestamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const readableTimestamp = `${timestamp.slice(0, 8)}-${timestamp.slice(9, 15)}`
  const terminalCode = sanitizeFilePart(archive.source.terminal.terminalCode) || 'inconnue'
  const archivePart = sanitizeFilePart(archive.archiveId).slice(0, 12) || 'archive'
  return `samhain-pos-backup-caisse-${terminalCode}-${readableTimestamp}-${archivePart}.json`
}

function sanitizeFilePart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function mapDocumentExportError(error: unknown): SalesBackupError {
  const nativeCode =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : ''
  const cause = error instanceof Error ? error : undefined
  const mappings: Record<string, { code: SalesBackupErrorCode; message: string }> = {
    DOCUMENT_PICKER_UNAVAILABLE: {
      code: 'picker-unavailable',
      message: 'Le sélecteur de destination Android est indisponible.',
    },
    PERMISSION_DENIED: {
      code: 'permission-denied',
      message: 'Android a refusé l’accès à la destination choisie.',
    },
    DESTINATION_UNAVAILABLE: {
      code: 'destination-unavailable',
      message: 'La destination choisie est indisponible ou invalide.',
    },
    WRITE_FAILED: {
      code: 'write-failed',
      message: 'Le fichier de sauvegarde n’a pas pu être écrit.',
    },
    READ_FAILED: {
      code: 'read-failed',
      message: 'Le fichier a été écrit mais n’a pas pu être relu pour vérification.',
    },
  }
  const mapped = mappings[nativeCode]
  if (mapped) return new SalesBackupError(mapped.message, mapped.code, { cause })
  return new SalesBackupError(
    cause?.message || 'L’enregistrement de la sauvegarde a échoué.',
    'destination-unavailable',
    { cause },
  )
}

let defaultSalesBackupService: SalesBackupService | null = null

export function getSalesBackupService(): SalesBackupService {
  defaultSalesBackupService ??= new SalesBackupService()
  return defaultSalesBackupService
}
