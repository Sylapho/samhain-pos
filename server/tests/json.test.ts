import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStrictJson } from '../src/json.ts'

test('strict parser keeps v1 integer, escape, Unicode, duplicate and depth rules', () => {
  for (const raw of [
    '{"é":"a\\/b","n":9007199254740991}',
    '{"n":1e2}',
    '[0,-0,null,true,false,"\\ud83c\\udf83"]',
  ])
    assert.deepEqual(parseStrictJson(raw), JSON.parse(raw))
  for (const raw of [
    '{"x":0,"\\u0078":1}',
    '9007199254740991.1',
    '1e999',
    '0.1',
    '1.000000000000000001',
    '"\\ud800"',
    '"\\udc00"',
    '"\\u0000"',
    'true false',
    '\ufeff{}',
    '{"__proto__":1,"__proto__":2}',
    '['.repeat(66) + '0' + ']'.repeat(66),
  ])
    assert.throws(() => parseStrictJson(raw), /INVALID_PAYLOAD/, raw)
})
