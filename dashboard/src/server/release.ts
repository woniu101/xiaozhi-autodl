import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PROJECT_ROOT, RUNTIME_ROOT } from './config.js'

type RefreshRecord = {
  refreshedAt?: string
  components?: string[]
}

export async function releaseInfo() {
  const version = await readFile(resolve(PROJECT_ROOT, 'VERSION'), 'utf8')
    .then((value) => value.trim())
    .catch(() => 'dev')
  const refresh = await readFile(resolve(RUNTIME_ROOT, 'run/last-refresh.json'), 'utf8')
    .then((value) => JSON.parse(value) as RefreshRecord)
    .catch(() => ({} as RefreshRecord))
  return {
    version,
    refreshedAt: refresh.refreshedAt,
    components: refresh.components || [],
  }
}
