import type { PrintDocumentType, RenderedTicket } from './types'

const ESC = 0x1b
const GS = 0x1d

const cp858Characters: Record<string, number> = {
  é: 0x82,
  â: 0x83,
  ä: 0x84,
  à: 0x85,
  ç: 0x87,
  ê: 0x88,
  ë: 0x89,
  è: 0x8a,
  ï: 0x8b,
  î: 0x8c,
  É: 0x90,
  Æ: 0x92,
  À: 0xb7,
  Ê: 0xd2,
  Ë: 0xd3,
  È: 0xd4,
  Î: 0xd7,
  Ï: 0xd8,
  Ô: 0xe2,
  Û: 0xea,
  Ù: 0xeb,
  ô: 0x93,
  ö: 0x94,
  û: 0x96,
  ù: 0x97,
  ÿ: 0x98,
  Ö: 0x99,
  Ü: 0x9a,
  Ç: 0x80,
  á: 0xa0,
  í: 0xa1,
  ó: 0xa2,
  ú: 0xa3,
  ñ: 0xa4,
  Ñ: 0xa5,
  '€': 0xd5,
}

export function encodeCp858(text: string): number[] {
  const normalized = text
    .replaceAll('œ', 'oe')
    .replaceAll('Œ', 'OE')
    .replaceAll('’', "'")
    .replaceAll('—', '-')
    .replaceAll('–', '-')
    .replaceAll('·', '-')
  return [...normalized].map((character) => {
    const mapped = cp858Characters[character]
    if (mapped !== undefined) return mapped
    const code = character.codePointAt(0) ?? 0x3f
    return code <= 0x7f ? code : 0x3f
  })
}

export class EscPosBuilder {
  private readonly data: number[] = []
  private readonly previewLines: string[] = []

  initialize(codePage: number): this {
    this.command(ESC, 0x40)
    this.command(ESC, 0x74, codePage)
    return this
  }

  align(value: 'left' | 'center'): this {
    this.command(ESC, 0x61, value === 'center' ? 1 : 0)
    return this
  }

  bold(enabled: boolean): this {
    this.command(ESC, 0x45, enabled ? 1 : 0)
    return this
  }

  doubleSize(enabled: boolean): this {
    this.command(GS, 0x21, enabled ? 0x11 : 0)
    return this
  }

  line(text = ''): this {
    this.data.push(...encodeCp858(text), 0x0a)
    this.previewLines.push(text)
    return this
  }

  blank(lines = 1): this {
    for (let index = 0; index < lines; index += 1) this.line()
    return this
  }

  build(type: PrintDocumentType): RenderedTicket {
    return {
      type,
      preview: this.previewLines.join('\n'),
      bytes: Uint8Array.from(this.data),
    }
  }

  private command(...bytes: number[]): void {
    this.data.push(...bytes)
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
