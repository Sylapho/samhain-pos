import { receiptBusinessInfo, type ReceiptBusinessInfo } from '../config/organization'
import { printerProfile, type PrinterProfile } from '../config/printer'
import type { Order } from '../types/order'
import { calculateVatSummary } from '../utils/vat'
import { EscPosBuilder } from './escPos'
import { formatTicketDateTime, formatTicketMoney, paymentMethodLabels } from './format'
import { fitColumns, separator } from './layout'
import type { RenderedTicket } from './types'

export function renderCustomerReceipt(
  order: Order,
  profile: PrinterProfile = printerProfile,
  businessInfo: ReceiptBusinessInfo = receiptBusinessInfo,
): RenderedTicket {
  const builder = new EscPosBuilder().initialize(profile.codePage).align('center')
  const { date, time } = formatTicketDateTime(order.createdAt)
  const vat = calculateVatSummary(order.items)

  builder.bold(true).doubleSize(true).line(businessInfo.eventName.toLocaleUpperCase('fr-FR'))
  builder.doubleSize(false).line(businessInfo.organizationName)
  builder.bold(false).line(businessInfo.city)
  builder.line(businessInfo.address)
  builder.line(`SIRET : ${businessInfo.siret}`)
  builder.line(`TVA : ${businessInfo.vatNumber}`)
  builder.blank()

  builder.align('left')
  for (const line of fitColumns(date, time, profile.columns)) builder.line(line)
  builder.line(`Reçu : ${order.receiptNumber}`)
  builder.line(`Caisse : ${order.registerName}`)
  builder.line(`Paiement : ${paymentMethodLabels[order.paymentMethod]}`)
  builder.blank()

  builder.align('center').line(separator(profile.columns, '='))
  builder.bold(true).line('COMMANDE')
  builder.doubleSize(true).line(order.orderNumber)
  builder.doubleSize(false).bold(false).line(separator(profile.columns, '='))
  builder.blank()

  builder.align('left')
  for (const item of order.items) {
    const label = `${item.quantity} x ${item.name}${item.variant ? ` ${item.variant.name}` : ''}`
    const lineTotal = item.unitPriceCents * item.quantity
    for (const line of fitColumns(label, formatTicketMoney(lineTotal), profile.columns)) {
      builder.line(line)
    }
    builder.line(`  ${formatTicketMoney(item.unitPriceCents)} / unité  TVA ${item.vatRate} %`)
    for (const option of item.options) {
      builder.line(`  ${option.groupName} : ${option.optionName}`)
    }
  }

  builder.blank().line(separator(profile.columns))
  for (const line of fitColumns('Total HT', formatTicketMoney(vat.netCents), profile.columns)) {
    builder.line(line)
  }
  for (const entry of vat.breakdown) {
    for (const line of fitColumns(
      `TVA ${entry.rate} %`,
      formatTicketMoney(entry.vatCents),
      profile.columns,
    ))
      builder.line(line)
  }
  for (const line of fitColumns('Total TVA', formatTicketMoney(vat.vatCents), profile.columns)) {
    builder.line(line)
  }
  builder.line(separator(profile.columns))
  builder.align('center').bold(true).doubleSize(true)
  builder.line(`TOTAL TTC ${formatTicketMoney(vat.grossCents)}`)
  builder.doubleSize(false).bold(false).line(separator(profile.columns))
  builder.blank()
  builder.line('Conservez ce ticket pour retirer')
  builder.line('votre commande.')

  return builder.build('customerReceipt')
}
