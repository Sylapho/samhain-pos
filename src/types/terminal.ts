export const terminalCodes = ['W'] as const

// Les archives historiques restent lisibles ; la liste de choix dans l'interface contient W seule.
export const supportedTerminalCodes = ['A', 'B', 'C', 'D', 'W'] as const
export type TerminalCode = (typeof supportedTerminalCodes)[number]

export type TerminalIdentity = {
  terminalId: string
  terminalCode: TerminalCode
  displayName: string
}

export type TerminalConfiguration = TerminalIdentity & {
  provisionedAt: string
}

export type TerminalProvisioningInput = {
  terminalCode: TerminalCode
  displayName: string
}
