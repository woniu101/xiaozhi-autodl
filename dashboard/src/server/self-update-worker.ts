import { runPersistedSelfUpdate } from './updater.js'

const operationId = process.argv[2]
if (!operationId || process.env.XIAOZHI_AUTODL_UPDATE_WORKER !== '1') {
  console.error('自更新助手只能由 Dashboard 启动')
  process.exitCode = 2
} else {
  try {
    await runPersistedSelfUpdate(operationId)
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : error)
    process.exitCode = 1
  }
}
