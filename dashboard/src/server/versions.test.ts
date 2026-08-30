import assert from 'node:assert/strict'
import test from 'node:test'
import { affectedComponentsForFiles, isRepositoryKey, REPOSITORIES } from './versions.js'

test('xiaozhi-autodl is a fixed main deployment repository', () => {
  assert.equal(isRepositoryKey('xiaozhi-autodl'), true)
  assert.deepEqual(REPOSITORIES['xiaozhi-autodl'], {
    label: 'xiaozhi-autodl',
    path: '/root/xiaozhi-autodl',
    deployBranch: 'main',
  })
})

test('any xiaozhi-autodl release change refreshes Dashboard', () => {
  assert.deepEqual(affectedComponentsForFiles('xiaozhi-autodl', ['VERSION']), ['dashboard'])
  assert.deepEqual(affectedComponentsForFiles('xiaozhi-autodl', ['dashboard/src/web/App.vue']), ['dashboard'])
  assert.deepEqual(affectedComponentsForFiles('xiaozhi-autodl', []), [])
})
