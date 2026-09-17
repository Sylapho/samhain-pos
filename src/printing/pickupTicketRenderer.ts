import { receiptBusinessInfo } from '../config/organization'
import { printerProfile, type PrinterProfile } from '../config/printer'
import type { Order } from '../types/order'
import { getOrderTerminalDisplayName } from '../utils/order'
import { EscPosBuilder } from './escPos'
import { formatTicketDateTime } from './format'
import { separator } from './layout'
import type { RenderedTicket } from './types'

export function renderPickupTicket(
  order: Order,
  profile: PrinterProfile = printerProfile,
): RenderedTicket {
  const { time } = formatTicketDateTime(order.createdAt)
  const builder = new EscPosBuilder().initialize(profile.codePage).align('center')

  builder.bold(true).line(receiptBusinessInfo.eventName.toLocaleUpperCase('fr-FR'))
  builder.blank().line(separator(profile.columns, '='))
  builder.line('COMMANDE').doubleSize(true).line(order.orderNumber)
  builder.doubleSize(false).line(separator(profile.columns, '='))
  builder.bold(false).line(`${time} - ${getOrderTerminalDisplayName(order)}`)
  builder.blank().line('À présenter pour retirer').line('votre commande')

  return builder.build('pickupTicket')
}
