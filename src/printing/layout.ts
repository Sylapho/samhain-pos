export function fitColumns(left: string, right: string, width: number): string[] {
  const rightWidth = right.length
  const availableLeft = Math.max(1, width - rightWidth - 1)
  const leftLines = wrapText(left, availableLeft)
  return leftLines.map((line, index) =>
    index === 0
      ? `${line}${' '.repeat(Math.max(1, width - line.length - rightWidth))}${right}`
      : line,
  )
}

export function wrapText(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (word.length > width) {
      if (current) lines.push(current)
      lines.push(`${word.slice(0, Math.max(1, width - 1))}…`)
      current = ''
      continue
    }
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= width) current = candidate
    else {
      if (current) lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : ['']
}

export function separator(width: number, character = '-'): string {
  return character.repeat(width)
}
