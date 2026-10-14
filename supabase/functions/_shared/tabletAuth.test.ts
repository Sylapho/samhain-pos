// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  AuthFailure,
  base64,
  digest,
  handleTabletAuth,
  principalFromVerifiedUser,
  verifyDeviceProof,
  type Rpc,
} from './tabletAuth'

const installationId = '77777777-7777-4777-8777-777777777777'
const nonce = '88888888-8888-4888-8888-888888888888'
const request = (value: unknown, jwt = 'test-jwt') =>
  new Request('https://test.invalid/tablet-auth-v1', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
async function signed(action: string, body: Record<string, unknown>) {
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )
  const payload = JSON.stringify(body)
  const message = `samhain-auth/1\n${body.installationId}\n${action}\n${nonce}\n${await digest(payload)}`
  const signature = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.privateKey,
        new TextEncoder().encode(message),
      ),
    ),
  )
  const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)))
  return { envelope: { action, payload, nonce, signature }, publicKey }
}

describe('frontière Edge Auth et preuve de possession', () => {
  it('refuse AAL1 pour un compte responsable ayant un facteur MFA vérifié', () => {
    const jwt = `header.${btoa(JSON.stringify({ aal: 'aal1' }))}.verified-by-auth-first`
    expect(() =>
      principalFromVerifiedUser({ id: 'manager', factors: [{ status: 'verified' }] }, jwt),
    ).toThrow('MFA_REQUIRED')
  })
  it('accepte AAL2 déjà vérifié par Auth pour un responsable MFA', () => {
    const jwt = `header.${btoa(JSON.stringify({ aal: 'aal2' }))}.verified-by-auth-first`
    expect(
      principalFromVerifiedUser({ id: 'manager', factors: [{ status: 'verified' }] }, jwt),
    ).toEqual({ id: 'manager', anonymous: false })
  })
  it('refuse JWT expiré avant toute RPC', async () => {
    const rpc = vi.fn()
    const response = await handleTabletAuth(request({ action: 'request', body: {} }), {
      authenticate: async () => {
        throw new AuthFailure('SESSION_EXPIRED', 401)
      },
      rpc,
    })
    expect(response.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('interdit l’approbation à un principal anonyme', async () => {
    const rpc = vi.fn()
    expect(
      (
        await handleTabletAuth(request({ action: 'approve', body: {} }), {
          authenticate: async () => ({ id: 'device', anonymous: true }),
          rpc,
        })
      ).status,
    ).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })
  it('dérive le principal du JWT et fait recontrôler les droits par SQL', async () => {
    const rpc = vi.fn(async () => {
      throw new AuthFailure('MANAGER_REQUIRED')
    })
    const response = await handleTabletAuth(
      request({ action: 'approve', body: { subject: 'forged' } }),
      { authenticate: async () => ({ id: 'verified', anonymous: false }), rpc },
    )
    expect(response.status).toBe(403)
    expect(rpc.mock.calls[0][0]).toBe('verified')
  })
  it('vérifie la vraie signature RSA avant activation', async () => {
    const { envelope, publicKey } = await signed('activate', {
      installationId,
      invitationCode: 'temporary-test-code',
    })
    const rpc: Rpc = vi.fn(async (_subject, action) =>
      action === 'proof' ? { publicKey } : { status: 'authorized' },
    )
    const response = await handleTabletAuth(request(envelope), {
      authenticate: async () => ({ id: 'verified', anonymous: true }),
      rpc,
    })
    expect(response.status).toBe(200)
    expect(rpc).toHaveBeenLastCalledWith(
      'verified',
      'activate',
      { installationId, invitationHash: await digest('temporary-test-code') },
      nonce,
    )
  })
  it.each(['installation', 'action', 'payload', 'nonce'])(
    'refuse la substitution %s',
    async (field) => {
      const { envelope, publicKey } = await signed('status', { installationId })
      const rpc: Rpc = async () => ({ publicKey })
      if (field === 'installation')
        envelope.payload = JSON.stringify({ installationId: 'different' })
      if (field === 'payload')
        envelope.payload = JSON.stringify({ installationId, organizationId: 'forged' })
      if (field === 'nonce') envelope.nonce = 'different'
      await expect(
        verifyDeviceProof('verified', field === 'action' ? 'activate' : 'status', envelope, rpc),
      ).rejects.toThrow('PROOF_INVALID')
    },
  )
  it('refuse un challenge absent ou déjà utilisé', async () => {
    const { envelope } = await signed('status', { installationId })
    await expect(
      verifyDeviceProof('verified', 'status', envelope, async () => {
        throw new AuthFailure('PROOF_REQUIRED')
      }),
    ).rejects.toThrow('PROOF_REQUIRED')
  })
})
