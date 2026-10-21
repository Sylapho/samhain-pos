// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { handleCatalog } from './catalogHttp'
import { AuthFailure, base64, digest } from './tabletAuth'

const content = {
  products: [
    {
      id: 'p',
      name: 'Fixture',
      priceCents: 500,
      vatRate: 10,
      categoryId: 'c',
      displayOrder: 0,
      active: true,
      requiresPreparation: false,
      availability: 'available',
      dataConfidence: 'confirmed',
    },
  ],
  categories: [{ id: 'c', label: 'Fixture', active: true, displayOrder: 0 }],
}
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://test.invalid/functions/v1/catalog-v1', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const dependencies = () => ({
  authenticate: vi.fn(async () => ({ id: 'verified-subject', sessionId: 'verified-session' })),
  proofRpc: vi.fn(async () => ({})),
  transact: vi.fn(async () => ({ version: null })),
})
describe('catalogue Edge HTTP', () => {
  it('transmet le sujet et la session vérifiés, jamais ceux du corps', async () => {
    const deps = dependencies()
    expect(
      (await handleCatalog(request({ ...content, action: 'publish', subject: 'forged' }), deps))
        .status,
    ).toBe(200)
    expect(deps.transact).toHaveBeenCalledWith(
      'verified-subject',
      'verified-session',
      expect.any(Object),
    )
  })
  it('refuse une publication sans authentification et après révocation', async () => {
    const deps = dependencies()
    expect(
      (await handleCatalog(request({ action: 'publish' }, { authorization: '' }), deps)).status,
    ).toBe(401)
    deps.authenticate.mockRejectedValue(new AuthFailure('AUTH_REQUIRED', 401))
    expect((await handleCatalog(request({ action: 'publish' }), deps)).status).toBe(401)
    expect(deps.transact).not.toHaveBeenCalled()
  })
  it('refuse un utilisateur non habilité et une révision obsolète sans divulguer SQL', async () => {
    const deps = dependencies()
    deps.transact.mockRejectedValue(new AuthFailure('PUBLISH_DENIED'))
    expect((await handleCatalog(request({ ...content, action: 'publish' }), deps)).status).toBe(403)
    deps.transact.mockRejectedValue(new Error('CATALOG_HEAD_MOVED'))
    expect((await handleCatalog(request({ ...content, action: 'publish' }), deps)).status).toBe(409)
    deps.transact.mockRejectedValue(new Error('secret SQL diagnostics'))
    expect(
      await (await handleCatalog(request({ ...content, action: 'publish' }), deps)).text(),
    ).not.toContain('secret')
  })
  it.each([
    '{"action":"publish",',
    { ...content, action: 'publish', products: [{ ...content.products[0], categoryId: 'absent' }] },
    {
      ...content,
      action: 'publish',
      products: [{ ...content.products[0], dataConfidence: 'temporary' }],
    },
    ' '.repeat(450001),
  ])('aucun appel SQL pour un téléchargement ou contenu incomplet/invalide (%#)', async (body) => {
    const deps = dependencies()
    expect((await handleCatalog(request(body), deps)).status).toBeGreaterThanOrEqual(400)
    expect(deps.transact).not.toHaveBeenCalled()
  })
  it('vérifie une preuve native RSA pour télécharger et transmet le nonce à la transaction', async () => {
    const body = { action: 'read', installationId: 'installation' }
    const payload = JSON.stringify(body)
    const nonce = 'nonce'
    const key = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
    const signature = base64(
      new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          key.privateKey,
          new TextEncoder().encode(
            `samhain-auth/1\ninstallation\ncatalog-v1\nnonce\n${await digest(payload)}`,
          ),
        ),
      ),
    )
    const deps = dependencies()
    const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey)))
    const signedDeps = { ...deps, proofRpc: vi.fn(async () => ({ publicKey })) }
    expect(
      (
        await handleCatalog(
          request(payload, { 'x-samhain-nonce': nonce, 'x-samhain-signature': signature }),
          signedDeps,
        )
      ).status,
    ).toBe(200)
    expect(deps.transact).toHaveBeenCalledWith('verified-subject', 'verified-session', body, nonce)
    deps.transact.mockClear()
    expect(
      (
        await handleCatalog(
          request(JSON.stringify({ ...body, installationId: 'forged' }), {
            'x-samhain-nonce': nonce,
            'x-samhain-signature': signature,
          }),
          signedDeps,
        )
      ).status,
    ).toBe(403)
    expect(deps.transact).not.toHaveBeenCalled()
  })
})
