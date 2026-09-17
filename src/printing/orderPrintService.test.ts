import { describe, expect, it, vi } from 'vitest'
import { assertReceiptBusinessInfoCanBePrinted } from '../config/organization'
import { printPreviewOrder } from '../mocks/printOrder'
import { buildOrderPrintJob, OrderPrintService } from './orderPrintService'
import type { PrintJobStep, ReceiptPrinter } from './types'

vi.mock('../config/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/organization')>()
  return { ...actual, assertReceiptBusinessInfoCanBePrinted: vi.fn() }
})

describe('orchestration d’impression', () => {
  const orderWithoutPreparation = {
    ...printPreviewOrder,
    items: printPreviewOrder.items.map((item) => ({ ...item, requiresPreparation: false })),
    printing: {
      ...printPreviewOrder.printing,
      pickupTicket: 'not_requested' as const,
      preparationTicket: 'not_requested' as const,
    },
  }

  it('ordonne retrait, reçu, préparation avec une coupe après chaque document', () => {
    const job = buildOrderPrintJob(printPreviewOrder)
    expect(
      job.steps.map((step) =>
        step.type === 'document' ? step.documentType : `cut:${step.afterDocument}`,
      ),
    ).toEqual([
      'pickupTicket',
      'cut:pickupTicket',
      'customerReceipt',
      'cut:customerReceipt',
      'preparationTicket',
      'cut:preparationTicket',
    ])
  })

  it('peut désactiver le ticket client sans supprimer la préparation', () => {
    const job = buildOrderPrintJob(printPreviewOrder, {
      selection: ['pickupTicket', 'preparationTicket'],
    })
    expect(
      job.steps.map((step) => (step.type === 'document' ? step.documentType : step.type)),
    ).toEqual(['pickupTicket', 'cut', 'preparationTicket', 'cut'])
  })

  it('ne valide les informations légales que si le reçu financier est sélectionné', () => {
    const validateBusinessInfo = vi.mocked(assertReceiptBusinessInfoCanBePrinted)
    validateBusinessInfo.mockClear()

    buildOrderPrintJob(printPreviewOrder, { selection: ['pickupTicket'] })
    expect(validateBusinessInfo).not.toHaveBeenCalled()

    buildOrderPrintJob(printPreviewOrder, { selection: ['customerReceipt'] })
    expect(validateBusinessInfo).toHaveBeenCalledOnce()
  })

  it('réduit une sélection des deux tickets au seul ticket client sans préparation', () => {
    const job = buildOrderPrintJob(orderWithoutPreparation, {
      selection: ['pickupTicket', 'customerReceipt', 'preparationTicket'],
    })
    expect(job.documents.map((document) => document.type)).toEqual(['customerReceipt'])
    expect(
      job.steps.map((step) =>
        step.type === 'document' ? step.documentType : `cut:${step.afterDocument}`,
      ),
    ).toEqual(['customerReceipt', 'cut:customerReceipt'])
  })

  it('traite une sélection préparation sans besoin comme un succès sans transport', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>()
    const service = new OrderPrintService({ printJob })

    await expect(
      service.printOrder(orderWithoutPreparation, {
        selection: ['preparationTicket'],
        reprint: true,
      }),
    ).resolves.toEqual({ ok: true, bytesWritten: 0, completedDocuments: [], warnings: [] })
    expect(printJob).not.toHaveBeenCalled()
  })

  it('envoie toutes les étapes au transport avec un seul appel', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>(async () => ({
      ok: true as const,
      bytesWritten: 123,
      completedDocuments: ['pickupTicket', 'customerReceipt', 'preparationTicket'],
      warnings: [],
    }))
    const printer: ReceiptPrinter = { printJob }
    const service = new OrderPrintService(printer)

    await service.printOrder(printPreviewOrder)

    expect(printJob).toHaveBeenCalledOnce()
    expect(printJob.mock.calls[0]?.[0]).toHaveLength(6)
  })

  it('réimprime seulement le document demandé avec les mêmes identifiants', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>(async () => ({
      ok: true as const,
      bytesWritten: 50,
      completedDocuments: ['preparationTicket'],
      warnings: [],
    }))
    const service = new OrderPrintService({ printJob })
    await service.printOrder(printPreviewOrder, { selection: ['preparationTicket'] })
    const steps = printJob.mock.calls[0]?.[0] as PrintJobStep[]
    expect(steps).toHaveLength(2)
    expect(
      buildOrderPrintJob(printPreviewOrder, { selection: ['preparationTicket'] }).documents[0]
        ?.preview,
    ).toContain('A-0001')
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
        printing: {
          ...printPreviewOrder.printing,
          pickupTicket: 'printed',
          customerReceipt: 'printed',
          status: 'partial',
        },
      },
      { selection: ['pickupTicket', 'customerReceipt', 'preparationTicket'] },
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
    const service = new OrderPrintService({ printJob }, () => {})
    const order = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        pickupTicket: 'printed' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'printed' as const,
        status: 'printed' as const,
      },
    }
    await service.printOrder(order)
    expect(printJob).not.toHaveBeenCalled()
    await service.printOrder(order, { selection: ['customerReceipt'], reprint: true })
    expect(printJob).toHaveBeenCalledOnce()
    expect(printJob.mock.calls[0]?.[0]).toHaveLength(2)
    expect(printJob.mock.calls[0]?.[0][0]).toMatchObject({ documentType: 'customerReceipt' })
  })

  it('ne retransmet jamais implicitement un document inconnu', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>()
    const service = new OrderPrintService({ printJob })
    const order = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        pickupTicket: 'printed' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'unknown' as const,
        status: 'unknown' as const,
      },
    }

    await service.printOrder(order, {
      selection: ['pickupTicket', 'customerReceipt', 'preparationTicket'],
    })
    expect(printJob).not.toHaveBeenCalled()

    vi.mocked(printJob).mockResolvedValue({
      ok: true,
      bytesWritten: 50,
      completedDocuments: ['preparationTicket'],
      warnings: [],
    })
    await service.printOrder(order, { selection: ['preparationTicket'], reprint: true })
    expect(printJob).toHaveBeenCalledOnce()
  })

  it('refuse une duplication client terminée avant tout appel au transport', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>()
    const requireResponsibleMode = vi.fn(() => {
      throw new Error('Mode responsable requis pour cette opération.')
    })
    const service = new OrderPrintService({ printJob }, requireResponsibleMode)
    const order = {
      ...printPreviewOrder,
      printing: {
        ...printPreviewOrder.printing,
        status: 'printed' as const,
        pickupTicket: 'printed' as const,
        customerReceipt: 'printed' as const,
        preparationTicket: 'printed' as const,
      },
    }

    await expect(
      service.printOrder(order, {
        selection: ['pickupTicket', 'customerReceipt', 'preparationTicket'],
        reprint: true,
      }),
    ).rejects.toThrow(/Mode responsable requis/)
    expect(requireResponsibleMode).toHaveBeenCalledOnce()
    expect(printJob).not.toHaveBeenCalled()
  })

  it('ne protège pas la reprise d’un ticket client échoué', async () => {
    const printJob = vi.fn<ReceiptPrinter['printJob']>().mockResolvedValue({
      ok: true,
      bytesWritten: 50,
      completedDocuments: ['customerReceipt'],
      warnings: [],
    })
    const requireResponsibleMode = vi.fn()
    const service = new OrderPrintService({ printJob }, requireResponsibleMode)
    const order = {
      ...printPreviewOrder,
      printing: { ...printPreviewOrder.printing, customerReceipt: 'failed' as const },
    }

    await service.printOrder(order, { selection: ['customerReceipt'], reprint: true })
    expect(requireResponsibleMode).not.toHaveBeenCalled()
    expect(printJob).toHaveBeenCalledOnce()
  })
})
