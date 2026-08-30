import assert from 'node:assert/strict'
import test from 'node:test'
import { actionsForPhase, failedDependencies, type ServicePhase } from './services.js'

const expected: Record<ServicePhase, { start: boolean; stop: boolean; restart: boolean }> = {
  READY: { start: false, stop: true, restart: true },
  STARTING: { start: false, stop: true, restart: false },
  STOPPING: { start: false, stop: false, restart: false },
  DEGRADED: { start: false, stop: true, restart: true },
  STOPPED: { start: true, stop: false, restart: false },
  FAILED: { start: true, stop: false, restart: false },
}

test('service phases expose only valid lifecycle actions', () => {
  for (const [phase, actions] of Object.entries(expected)) {
    assert.deepEqual(actionsForPhase(phase as ServicePhase), actions, phase)
  }
})

test('a locked service exposes no lifecycle actions', () => {
  for (const phase of Object.keys(expected) as ServicePhase[]) {
    assert.deepEqual(actionsForPhase(phase, true), { start: false, stop: false, restart: false }, phase)
  }
})

test('failed dependencies skip only downstream start steps', () => {
  assert.deepEqual(failedDependencies('manager-api', ['mysql']), ['mysql'])
  assert.deepEqual(failedDependencies('xiaozhi-server', ['index-tts']), ['index-tts'])
  assert.deepEqual(failedDependencies('xiaozhi-server', ['manager-api', 'index-tts']), ['manager-api', 'index-tts'])
  assert.deepEqual(failedDependencies('web-gateway', ['mysql', 'redis']), [])
})
