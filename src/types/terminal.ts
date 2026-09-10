export const terminalCodes = ['A', 'B', 'C', 'D'] as const

export type TerminalCode = (typeof terminalCodes)[number]

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
