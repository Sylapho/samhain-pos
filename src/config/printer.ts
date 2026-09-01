export type PrinterProfile = {
  name: string
  paperWidth: '80mm'
  columns: number
  codePage: number
  feedLinesBeforeCut: number
  cutMode: 'full'
}

// Le ticket USB historique utilise déjà 42 caractères et une coupe totale GS V 0.
export const printerProfile: PrinterProfile = {
  name: 'Epson TM-T88V — profil actuel',
  paperWidth: '80mm',
  columns: 42,
  codePage: 19,
  feedLinesBeforeCut: 4,
  cutMode: 'full',
}
