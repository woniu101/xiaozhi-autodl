import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import staticPlugin from '@fastify/static'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  changePassword,
  createSession,
  destroySession,
  getSession,
  initializeAuth,
  isInitialized,
  setupPassword,
  verifyPassword,
} from './auth.js'
import {
  isServiceAction,
  isServiceName,
  MANAGER_WEB_PUBLIC_URL,
  PROJECT_ROOT,
  STATIC_ROOT,
} from './config.js'
import { systemMetrics } from './system.js'
import { releaseInfo } from './release.js'
import { endpointState, saveEndpointConfig, syncClientEndpoints, type EndpointConfig } from './endpoints.js'
import { checkRepositoryUpdates, repositoryCheckProgress, startAutomaticVersionChecks, versionState } from './versions.js'
import { currentSafeUpdate, startSafeUpdate, updateHistory } from './updater.js'
import { gitNetworkState, saveGitNetworkConfig, testGitNetwork, type GitNetworkConfig } from './git-network.js'
import {
  actOnService,
  getCurrentOperation,
  listServices,
  ServiceOperationConflict,
  serviceLogs,
  startBatchOperation,
  type LogLevel,
  type LogPreset,
  type LogSource,
} from './services.js'

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  disableRequestLogging: true,
  bodyLimit: 1024 * 1024,
  trustProxy: true,
})
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>()

await app.register(cookie)
await app.register(staticPlugin, { root: STATIC_ROOT, prefix: '/' })
const authInfo = await initializeAuth()
app.log.info(`Dashboard authentication: ${authInfo.initialized ? 'initialized' : 'setup required'}`)

const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, path: '/', maxAge: 12 * 60 * 60 }

function sameOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === request.headers.host } catch { return false }
}

function issueSession(reply: FastifyReply) {
  const { cookie: value, session } = createSession()
  reply.setCookie('xiaozhi_dashboard', value, cookieOptions)
  return session
}

app.get('/api/health', async () => ({ status: 'ok' }))
app.get('/api/auth/status', async (request) => {
  const session = getSession(request)
  return {
    initialized: isInitialized(),
    authenticated: Boolean(session),
    csrf: session?.csrf,
    managerWebUrl: MANAGER_WEB_PUBLIC_URL,
  }
})

app.post('/api/auth/setup', async (request, reply) => {
  if (!sameOrigin(request)) return reply.code(403).send({ error: '请求来源无效' })
  const { passcode = '', confirm = '' } = request.body as { passcode?: string; confirm?: string }
  if (passcode !== confirm) return reply.code(400).send({ error: '两次输入的口令不一致' })
  try {
    await setupPassword(passcode)
    const session = issueSession(reply)
    return { initialized: true, authenticated: true, csrf: session.csrf }
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '口令创建失败' })
  }
})

app.post('/api/auth/login', async (request, reply) => {
  if (!isInitialized()) return reply.code(409).send({ error: '请先创建运维口令' })
  const now = Date.now()
  const attempts = loginAttempts.get(request.ip)
  if (attempts && attempts.lockedUntil > now) return reply.code(429).send({ error: '登录失败次数过多，请 5 分钟后再试' })
  const { password = '' } = request.body as { password?: string }
  if (!verifyPassword(password)) {
    const count = (attempts?.count || 0) + 1
    loginAttempts.set(request.ip, { count, lockedUntil: count >= 5 ? now + 5 * 60 * 1000 : 0 })
    return reply.code(401).send({ error: '运维口令错误' })
  }
  loginAttempts.delete(request.ip)
  const session = issueSession(reply)
  return { authenticated: true, csrf: session.csrf }
})

app.addHook('preHandler', async (request, reply) => {
  const publicApi = request.url === '/api/health'
    || request.url === '/api/auth/login'
    || request.url === '/api/auth/setup'
    || request.url === '/api/auth/status'
  if (!request.url.startsWith('/api/') || publicApi) return
  const session = getSession(request)
  if (!session) return reply.code(401).send({ error: '请先登录 Dashboard' })
  if (request.method !== 'GET' && request.headers['x-csrf-token'] !== session.csrf) {
    return reply.code(403).send({ error: 'CSRF 校验失败' })
  }
})

app.post('/api/auth/logout', async (request, reply) => {
  destroySession(request)
  reply.clearCookie('xiaozhi_dashboard', { path: '/' })
  return { ok: true }
})

app.put('/api/auth/passcode', async (request, reply) => {
  const { current = '', next = '', confirm = '' } = request.body as { current?: string; next?: string; confirm?: string }
  if (next !== confirm) return reply.code(400).send({ error: '两次输入的新口令不一致' })
  try {
    await changePassword(current, next)
    const session = issueSession(reply)
    return { changed: true, csrf: session.csrf }
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '口令修改失败' })
  }
})

app.get('/api/overview', async () => ({
  metrics: await systemMetrics(),
  services: await listServices(),
  operation: getCurrentOperation(),
  release: await releaseInfo(),
}))

app.post('/api/services/:name/:action', async (request, reply) => {
  const { name, action } = request.params as { name: string; action: string }
  if (!isServiceName(name) || !isServiceAction(action)) return reply.code(400).send({ error: '不支持的服务或动作' })
  try { return await actOnService(name, action) }
  catch (error) {
    return reply.code(error instanceof ServiceOperationConflict ? 409 : 500).send({ error: error instanceof Error ? error.message : '操作失败' })
  }
})

app.post('/api/services/batch/:action', async (request, reply) => {
  const { action } = request.params as { action: string }
  if (!isServiceAction(action)) return reply.code(400).send({ error: '不支持的批量动作' })
  try { return reply.code(202).send(startBatchOperation(action)) }
  catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : '批量操作失败' }) }
})

app.get('/api/operations/current', async () => ({ operation: getCurrentOperation() }))

app.get('/api/endpoints', async () => endpointState())

app.put('/api/endpoints', async (request, reply) => {
  try {
    await saveEndpointConfig(request.body as Partial<EndpointConfig>)
    return await syncClientEndpoints()
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : '接入配置保存失败' })
  }
})

app.post('/api/endpoints/sync', async (_request, reply) => {
  try { return await syncClientEndpoints() }
  catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : '地址同步失败' }) }
})

app.get('/api/versions', async () => versionState())

app.get('/api/versions/check-progress', async () => repositoryCheckProgress())

app.post('/api/versions/check', async (request, reply) => {
  const { repository } = (request.body || {}) as { repository?: string }
  try { return await checkRepositoryUpdates(repository) }
  catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : '更新检测失败' }) }
})

app.get('/api/git-network', async () => gitNetworkState())

app.put('/api/git-network', async (request, reply) => {
  try {
    await saveGitNetworkConfig(request.body as Partial<GitNetworkConfig>)
    return await gitNetworkState()
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'GitHub 网络配置保存失败' }) }
})

app.post('/api/git-network/test', async (_request, reply) => {
  try { return await testGitNetwork() }
  catch (error) { return reply.code(500).send({ error: error instanceof Error ? error.message : 'GitHub 连接测试失败' }) }
})

app.get('/api/updates/current', async () => {
  const operation = await currentSafeUpdate()
  const history = await updateHistory()
  const mergedHistory = operation && operation.state !== 'running' && !history.some((item) => item.id === operation.id)
    ? [operation, ...history].slice(0, 10)
    : history
  return { operation, history: mergedHistory }
})

app.post('/api/updates/:repository', async (request, reply) => {
  const { repository } = request.params as { repository: string }
  const { ref } = (request.body || {}) as { ref?: string }
  try { return reply.code(202).send(await startSafeUpdate(repository, ref)) }
  catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : '安全更新无法启动' }) }
})

function logOptions(query: { lines?: string; level?: string; keyword?: string; source?: string; preset?: string }) {
  const requested = Number(query.lines || 200)
  const lines = requested >= 1000 ? 1000 : requested >= 500 ? 500 : 200
  const level: LogLevel = ['info', 'warn', 'error'].includes(query.level || '') ? query.level as LogLevel : 'all'
  const source: LogSource | undefined = ['service', 'access', 'error', 'raw', 'slow'].includes(query.source || '') ? query.source as LogSource : undefined
  const preset: LogPreset | undefined = ['http-errors', 'manager-requests'].includes(query.preset || '') ? query.preset as LogPreset : undefined
  return { lines, level, source, preset, keyword: (query.keyword || '').slice(0, 80) }
}

app.get('/api/services/:name/logs', async (request, reply) => {
  const { name } = request.params as { name: string }
  const query = request.query as { lines?: string; level?: string; keyword?: string; source?: string; preset?: string }
  if (!isServiceName(name)) return reply.code(400).send({ error: '不支持的服务' })
  return serviceLogs(name, logOptions(query))
})

app.get('/api/services/:name/logs/download', async (request, reply) => {
  const { name } = request.params as { name: string }
  const query = request.query as { lines?: string; level?: string; keyword?: string; source?: string; preset?: string }
  if (!isServiceName(name)) return reply.code(400).send({ error: '不支持的服务' })
  const result = await serviceLogs(name, { ...logOptions(query), lines: 1000 })
  reply.header('content-type', 'text/plain; charset=utf-8')
  reply.header('content-disposition', `attachment; filename="${name}-${result.source}.log"`)
  return result.content || result.error || '暂无日志'
})

const brandAssets: Record<string, string> = {
  '/brand/logo.png': 'xiaozhi-logo.092b0701.png',
  '/brand/login-person.png': 'login-person.bde36d73.png',
}
for (const [route, file] of Object.entries(brandAssets)) {
  app.get(route, async (_request, reply) => {
    try {
      const data = await readFile(resolve(PROJECT_ROOT, 'artifacts/manager-web/img', file))
      return reply.type('image/png').send(data)
    } catch {
      return reply.code(404).send()
    }
  })
}

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' })
  return reply.sendFile('index.html')
})

await app.listen({ host: process.env.DASHBOARD_HOST || '0.0.0.0', port: Number(process.env.DASHBOARD_PORT || 6006) })
startAutomaticVersionChecks(
  (message) => app.log.info(message),
  (message) => app.log.warn(message),
)
setTimeout(() => {
  void syncClientEndpoints().then((state) => app.log.info(`Client endpoints: ${state.inSync ? 'synced' : 'pending'}`))
    .catch((error) => app.log.warn(`Client endpoint sync delayed: ${error instanceof Error ? error.message : error}`))
}, 5_000)
