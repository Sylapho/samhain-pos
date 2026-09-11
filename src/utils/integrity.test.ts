import { describe, expect, it } from 'vitest'
import { canonicalJson, hashCanonicalValue, sha256Hex } from './integrity'

describe('empreintes déterministes', () => {
  it('implémente les vecteurs SHA-256 de référence', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('canonise les objets indépendamment de l’ordre de leurs clés', () => {
    expect(canonicalJson({ z: 2, nested: { b: true, a: 'é' }, ignored: undefined })).toBe(
      '{"nested":{"a":"é","b":true},"z":2}',
    )
    expect(hashCanonicalValue({ b: 2, a: 1 })).toBe(hashCanonicalValue({ a: 1, b: 2 }))
  })
})
