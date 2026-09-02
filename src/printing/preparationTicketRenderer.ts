import { printerProfile, type PrinterProfile } from '../config/printer'
import type { Order } from '../types/order'
import { getRemovedIngredients } from '../utils/cart'
import { EscPosBuilder } from './escPos'
import { formatTicketDateTime } from './format'
import { separator, wrapText } from './layout'
import type { RenderedTicket } from './types'

export function renderPreparationTicket(
  order: Order,
  profile: PrinterProfile = printerProfile,
): RenderedTicket {
  const builder = new EscPosBuilder().initialize(profile.codePage).align('center')
  const { time } = formatTicketDateTime(order.createdAt)

  builder.line(separator(profile.columns, '='))
  builder.bold(true).line('COMMANDE')
  builder.doubleSize(true).line(order.orderNumber)
  builder.doubleSize(false).bold(false).line(separator(profile.columns, '='))
  builder.line(time)
  builder.line(order.registerName)
  builder.blank()

  builder.align('left').bold(true)
  for (const item of order.items) {
    const name =
      `${item.quantity} x ${item.name}${item.variant ? ` ${item.variant.name}` : ''}`.toLocaleUpperCase(
        'fr-FR',
      )
    for (const line of wrapText(name, profile.columns)) builder.line(line)
    builder.bold(false)
    for (const option of item.options) {
      const choice = `  ${option.groupName.toLocaleUpperCase('fr-FR')} : ${option.optionName.toLocaleUpperCase('fr-FR')}`
      for (const line of wrapText(choice, profile.columns)) builder.line(line)
    }
    builder.bold(true)
    for (const ingredient of getRemovedIngredients(item)) {
      const warning = `  *** SANS ${ingredient.name.toLocaleUpperCase('fr-FR')} ***`
      for (const line of wrapText(warning, profile.columns)) builder.line(line)
    }
    builder.bold(true).blank()
  }

  builder.bold(false).align('center').line(separator(profile.columns, '='))
  return builder.build('preparationTicket')
}
