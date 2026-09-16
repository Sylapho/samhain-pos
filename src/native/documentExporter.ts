import { Capacitor, registerPlugin } from '@capacitor/core'

export type DocumentExportRequest = {
  fileName: string
  content: string
}

export type DocumentExportResult =
  | { status: 'cancelled' }
  | {
      status: 'created'
      uri: string
      fileName: string
      content: string
      bytesWritten: number
    }

interface NativeDocumentExporterPlugin {
  saveJson(options: DocumentExportRequest): Promise<DocumentExportResult>
}

export interface DocumentExporter {
  saveJson(request: DocumentExportRequest): Promise<DocumentExportResult>
}

const nativePlugin = registerPlugin<NativeDocumentExporterPlugin>('DocumentExporter')

export const documentExporter: DocumentExporter = {
  saveJson(request) {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      throw new Error(
        'L’enregistrement vérifié est disponible dans l’application Android Samhain POS.',
      )
    }
    return nativePlugin.saveJson(request)
  },
}
