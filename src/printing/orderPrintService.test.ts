import { describe, expect, it, vi } from 'vitest'
import { printPreviewOrder } from '../mocks/printOrder'
import { buildOrderPrintJob, OrderPrintService } from './orderPrintService'
import type { PrintJobStep, ReceiptPrinter } from './types'

describe('orchestration d’impression', () => {
  it('ordonne client, coupe, préparation, coupe dans un seul job', () => {
    const job = buildOrderPrintJob(printPreviewOrder)
    expect(
      job.steps.map((step) =>
        step.type === 'document' ? step.documentType : `cut:${step.afterDocument}`,
      ),
    ).toEqual([
      'customerReceipt',
      'cut:customerReceipt',
      'preparationTicket',
      'cut:preparationTicket',
    ])
  })

  it('peut désactiver le ticket client sans supprimer la préparation', () => {
    const job = buildOrderPrintJob(printPreviewOrder, { printCustomerReceipt: false })
    expect(
      job.steps.map((step) => (step.type === 'document' ? step.documentType : step.type)),
    ).toEqual(['preparationTicket', 'cut'])
  })

  it('envoie toutes les étapes au transport avec un seul appel', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>(async () => ({
      ok: true as const,
      bytesWritten: 123,
      completedDocuments: ['customerReceipt', 'preparationTicket'],
      warnings: [],
    }))
    const printer: ReceiptPrinter = { printJob }
    const service = new OrderPrintService(printer)

    await service.printOrder(printPreviewOrder)

    expect(printJob).toHaveBeenCalledOnce()
    expect(printJob.mock.calls[0]?.[0]).toHaveLength(4)
  })

  it('réimprime seulement le document demandé avec les mêmes identifiants', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>(async () => ({
      ok: true as const,
      bytesWritten: 50,
      completedDocuments: ['preparationTicket'],
      warnings: [],
    }))
    const service = new OrderPrintService({ printJob })
    await service.printOrder(printPreviewOrder, { selection: 'preparation' })
    const steps = printJob.mock.calls[0]?.[0] as PrintJobStep[]
    expect(steps).toHaveLength(2)
    expect(
      buildOrderPrintJob(printPreviewOrder, { selection: 'preparation' }).documents[0]?.preview,
    ).toContain('A001')
  })

  it('exclut une réussite persistée même si la sélection demande les deux tickets', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>().mockResolvedValue({
      ok: true,
      bytesWritten: 50,
      completedDocuments: ['preparationTicket'],
      warnings: [],
    })
    const service = new OrderPrintService({ printJob })
    await service.printOrder(
      {
        ...printPreviewOrder,
        printing: { ...printPreviewOrder.printing, customerReceipt: 'printed', status: 'partial' },
      },
      { selection: 'both' },
    )
    expect(
      printJob.mock.calls[0]?.[0].map((step) =>
        step.type === 'document' ? step.documentType : `cut:${step.afterDocument}`,
      ),
    ).toEqual(['preparationTicket', 'cut:preparationTicket'])
  })

  it('ne transfère aucun ticket terminé sans demande explicite de réimpression', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>().mockResolvedValue({
      ok: true,
      bytesWritten: 50,
      completedDocuments: ['customerReceipt'],
      warnings: [],
    })
    const service = new OrderPrintService({ printJob })
    const order = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        customerReceipt: 'printed' as const,
        preparationTicket: 'printed' as const,
        status: 'printed' as const,
      },
    }
    await service.printOrder(order)
    expect(printJob).not.toHaveBeenCalled()
    await service.printOrder(order, { selection: 'customer', reprint: true })
    expect(printJob).toHaveBeenCalledOnce()
    expect(printJob.mock.calls[0]?.[0]).toHaveLength(2)
    expect(printJob.mock.calls[0]?.[0][0]).toMatchObject({ documentType: 'customerReceipt' })
  })
})
