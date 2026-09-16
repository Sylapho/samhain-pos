/// <reference types="vite/client" />

export type ReceiptBusinessInfo = {
  organizationName: string
  eventName: string
  city: string
  address: string
  siret: string
  vatNumber: string
  usesDemoPlaceholders: boolean
}

export const receiptBusinessInfo: ReceiptBusinessInfo = {
  organizationName: 'Association Les Trouble-fêtes',
  eventName: 'Samhain',
  city: 'Bernay',
  address: '24 rue Alsace Lorraine 27300 Bernay',
  siret: '923 116 628 00028',
  vatNumber: 'FR90 923116628',
  usesDemoPlaceholders: false,
}

const knownPlaceholderValues: Partial<Record<keyof ReceiptBusinessInfo, readonly string[]>> = {
  address: ['1 rue du Festival, 27300 Bernay'],
  siret: ['000 000 000 00000'],
  vatNumber: ['FR00 000000000'],
}

const suspiciousPlaceholderPattern =
  /\b(?:d[ée]mo(?:nstration)?|exemple|ficti(?:f|ve)|placeholder|test|todo)\b|à\s+compléter|x{3,}/iu

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr-FR')
}

function isKnownPlaceholder(field: keyof ReceiptBusinessInfo, value: string): boolean {
  return (knownPlaceholderValues[field] ?? []).some(
    (placeholder) => normalizeValue(placeholder) === normalizeValue(value),
  )
}

function isValidSiret(value: string): boolean {
  const digits = value.replace(/\s/g, '')
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false

  const checksum = [...digits].reduce((sum, digit, index) => {
    const valueAtIndex = Number(digit) * (index % 2 === 0 ? 2 : 1)
    return sum + (valueAtIndex > 9 ? valueAtIndex - 9 : valueAtIndex)
  }, 0)

  return checksum % 10 === 0
}

function isValidFrenchVatNumber(value: string): boolean {
  const normalized = value.replace(/\s/g, '').toUpperCase()
  return /^FR[0-9A-Z]{2}\d{9}$/.test(normalized) && !/^FR[0-9A-Z]{2}0{9}$/.test(normalized)
}

function getInvalidBusinessInfoFields(businessInfo: ReceiptBusinessInfo): string[] {
  const invalidFields: string[] = []
  const textFields = (Object.keys(businessInfo) as Array<keyof ReceiptBusinessInfo>).filter(
    (field) => field !== 'usesDemoPlaceholders',
  )

  for (const field of textFields) {
    const value = businessInfo[field]
    if (typeof value !== 'string' || value.trim() === '') {
      invalidFields.push(`${field} (valeur vide)`)
    } else if (isKnownPlaceholder(field, value)) {
      invalidFields.push(`${field} (placeholder connu)`)
    } else if (suspiciousPlaceholderPattern.test(value)) {
      invalidFields.push(`${field} (valeur manifestement fictive)`)
    }
  }

  if (!isValidSiret(businessInfo.siret)) invalidFields.push('siret (format ou clé invalide)')
  if (!isValidFrenchVatNumber(businessInfo.vatNumber)) {
    invalidFields.push('vatNumber (format invalide)')
  }

  return [...new Set(invalidFields)]
}

export function assertReceiptBusinessInfoReadyForProduction(
  businessInfo: ReceiptBusinessInfo = receiptBusinessInfo,
): void {
  const invalidFields = getInvalidBusinessInfoFields(businessInfo)

  if (businessInfo.usesDemoPlaceholders) {
    invalidFields.unshift('usesDemoPlaceholders (activé)')
  }

  if (invalidFields.length > 0) {
    throw new Error(
      `Configuration administrative de production invalide. Champs concernés : ${invalidFields.join(', ')}. Corrigez src/config/organization.ts avant de générer une release.`,
    )
  }
}

export function assertReceiptBusinessInfoCanBePrinted(): void {
  const demoDataExplicitlyAllowed = import.meta.env.MODE === 'android-test'
  if (import.meta.env.PROD && !demoDataExplicitlyAllowed) {
    assertReceiptBusinessInfoReadyForProduction()
  }
}
