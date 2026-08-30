import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTurboEnvironment, transportPlan, validateGitNetworkConfig } from './git-network.js'

test('AutoDL network_turbo parser only accepts whitelisted environment variables', () => {
  const environment = parseTurboEnvironment(`
export no_proxy=localhost,127.0.0.1
export http_proxy=http://172.29.0.1:1234 && export https_proxy=http://172.29.0.1:1234
export PATH=/untrusted
`)
  assert.equal(environment.http_proxy, 'http://172.29.0.1:1234')
  assert.equal(environment.https_proxy, 'http://172.29.0.1:1234')
  assert.equal(environment.no_proxy, 'localhost,127.0.0.1')
  assert.equal(environment.PATH, undefined)
})

test('automatic GitHub networking falls back from direct to AutoDL acceleration', () => {
  assert.deepEqual(transportPlan('auto', true), ['direct', 'autodl'])
  assert.deepEqual(transportPlan('auto', false), ['direct'])
  assert.deepEqual(transportPlan('direct'), ['direct'])
  assert.deepEqual(transportPlan('autodl', true), ['autodl'])
})

test('custom proxy validation requires an explicit supported proxy URL', () => {
  assert.throws(() => validateGitNetworkConfig({ mode: 'custom' }), /需要填写代理地址/)
  assert.throws(() => validateGitNetworkConfig({ mode: 'custom', customProxy: 'ftp://127.0.0.1:21' }), /仅支持/)
  assert.deepEqual(validateGitNetworkConfig({ mode: 'custom', customProxy: 'http://127.0.0.1:7890' }), {
    mode: 'custom',
    customProxy: 'http://127.0.0.1:7890',
  })
})
