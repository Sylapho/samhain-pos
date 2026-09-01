export type ReceiptBusinessInfo = {
  organizationName: string
  eventName: string
  city: string
  address: string
  siret: string
  vatNumber: string
  phone: string
  usesDemoPlaceholders: boolean
}

// TODO PRODUCTION : remplacer toutes ces données de démonstration par les informations
// administratives réelles de l'association avant toute mise en production.
export const receiptBusinessInfo: ReceiptBusinessInfo = {
  organizationName: 'Association Les Trouble-fêtes',
  eventName: 'Samhain',
  city: 'Bernay',
  address: '1 rue du Festival, 27300 Bernay',
  siret: '000 000 000 00000',
  vatNumber: 'FR00 000000000',
  phone: '02 00 00 00 00',
  usesDemoPlaceholders: true,
}

export function assertReceiptBusinessInfoCanBePrinted(): void {
  const demoDataExplicitlyAllowed = import.meta.env.MODE === 'android-test'
  if (
    import.meta.env.PROD &&
    receiptBusinessInfo.usesDemoPlaceholders &&
    !demoDataExplicitlyAllowed
  ) {
    throw new Error(
      'Impression bloquée : remplacez les informations administratives de démonstration dans src/config/organization.ts.',
    )
  }
}
