<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

type ServicePhase = 'READY' | 'STARTING' | 'STOPPING' | 'DEGRADED' | 'STOPPED' | 'FAILED'
type Service = {
  name: string
  label: string
  port: number
  state: string
  phase: ServicePhase
  detail: string
  pid?: number
  cpu?: number
  memory?: number
  uptime?: number
  listening: boolean
  healthy: boolean
  healthStatus?: number
  healthLatencyMs?: number
  stability?: { restartCount10m: number; lastStartedAt?: string }
  signals?: Array<{ label: string; value: string; tone: 'normal' | 'info' | 'warning' | 'critical' | 'muted'; logLevel?: string; logKeyword?: string; logSource?: 'service' | 'access' | 'error' | 'raw' | 'slow'; logPreset?: 'http-errors' | 'manager-requests' }>
  lastError?: string
  activeAction?: 'start' | 'stop' | 'restart'
  allowedActions?: { start: boolean; stop: boolean; restart: boolean }
}
type BatchStep = {
  service: string
  label: string
  action: 'start' | 'stop'
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  message?: string
}
type BatchOperation = {
  id: string
  action: 'start' | 'stop' | 'restart'
  state: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  steps: BatchStep[]
}
type EndpointMode = 'autodl' | 'lan' | 'custom'
type EndpointState = {
  config: { mode: EndpointMode; baseUrl?: string; sshHost?: string; sshPort?: number; localPort?: number }
  source: string
  sourceDetail?: string
  managerUrl?: string
  otaUrl?: string
  websocketUrl?: string
  configured: { ota?: string; websocket?: string }
  inSync: boolean
  gatewayReachable: boolean
  readiness?: { managerWeb: boolean; ota: boolean; websocket: boolean }
  tunnelCommand?: string
  sync?: { state: 'synced' | 'pending' | 'failed'; message: string; at: string }
}
type RepositoryState = {
  key: string
  label: string
  path?: string
  deployBranch?: string
  available: boolean
  branch?: string
  branchMismatch?: boolean
  commit?: string
  shortCommit?: string
  subject?: string
  committedAt?: string
  dirty?: boolean
  changedCount?: number
  ahead?: number
  behind?: number
  updateAvailable?: boolean
  updateBlocked?: boolean
  blockingChanges?: string[]
  changes?: string[]
  upstream?: string
  remoteUrl?: string
  refs?: string[]
  remoteCheckedAt?: string
  remoteCheckOk?: boolean
  remoteCheckMessage?: string
  remoteTransport?: 'direct' | 'autodl' | 'custom'
  remoteElapsedMs?: number
  incomingCommits?: Array<{ commit: string; subject: string }>
  changedFiles?: string[]
  canFastForward?: boolean
  dependencyChanges?: string[]
  dependencyBlocked?: boolean
  affectedComponents?: string[]
}
type RepositoryCheckProgress = { key: string; stage: 'connecting' | 'fallback' | 'fetching'; attempt: number; totalAttempts: number; elapsedSeconds: number; transport?: 'direct' | 'autodl' | 'custom' }
type UpdateOperation = {
  id: string
  repository: string
  state: 'running' | 'done' | 'failed' | 'rolled-back'
  message?: string
  fromCommit?: string
  toCommit?: string
  components?: string[]
  startedAt: string
  finishedAt?: string
  steps: Array<{ name: string; label: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; message?: string; startedAt?: string; finishedAt?: string }>
  logs: string[]
}
type GitNetworkMode = 'auto' | 'direct' | 'autodl' | 'custom'
type GitNetworkState = {
  config: { mode: GitNetworkMode; customProxyConfigured: boolean; customProxyDisplay?: string }
  autodlAvailable: boolean
  lastResult?: { checkedAt: string; ok: boolean; transport?: 'direct' | 'autodl' | 'custom'; elapsedMs: number; message?: string }
  test?: { ok: boolean; transport?: 'direct' | 'autodl' | 'custom'; elapsedMs: number; message: string }
}

const initialized = ref(false)
const authenticated = ref(false)
const csrf = ref('')
const busy = ref(false)
const refreshing = ref(false)
const managerBaseUrl = ref('')
const dashboardPassword = ref('')
const setup = reactive({ passcode: '', confirm: '' })
const change = reactive({ open: false, current: '', next: '', confirm: '' })
const message = reactive({ text: '', kind: 'ok' })
const overview = ref<any>(null)
const logPre = ref<HTMLElement>()
const serviceSection = ref<HTMLElement>()
const healthFocus = ref(false)
const currentPage = ref<'overview' | 'versions'>(window.location.pathname === '/versions' ? 'versions' : 'overview')
const endpoints = ref<EndpointState>()
const versionState = ref<{ inspectedAt: string; repositories: RepositoryState[] }>()
const updateOperation = ref<UpdateOperation>()
const updateHistoryItems = ref<UpdateOperation[]>([])
const updateHistoryOpen = ref(false)
const expandedUpdateId = ref('')
const collapsedUpdateIds = reactive<Record<string, boolean>>({})
const gitNetwork = ref<GitNetworkState>()
const testingGitNetwork = ref(false)
const gitNetworkDialog = reactive({ open: false, mode: 'auto' as GitNetworkMode, customProxy: '' })
const checkingRepositories = ref<string[]>([])
const repositoryProgress = ref<Record<string, RepositoryCheckProgress>>({})
const updateTargets = reactive<Record<string, string>>({})
const pendingUpdateRef = ref('')
const endpointDialog = reactive({
  open: false,
  mode: 'autodl' as EndpointMode,
  baseUrl: '',
  sshHost: '',
  sshPort: 22,
  localPort: 16008,
})
const confirmBox = reactive({ open: false, title: '', text: '', action: '', service: '' })
const logs = reactive({
  open: false,
  service: '' as string,
  title: '',
  content: '',
  path: '',
  lines: 200,
  level: 'all',
  keyword: '',
  source: 'service' as 'service' | 'access' | 'error' | 'raw' | 'slow',
  preset: '' as '' | 'http-errors' | 'manager-requests',
  presetLabel: '',
  follow: true,
  loading: false,
  error: '',
  updatedAt: '',
})
let refreshTimer: number | undefined
let versionTimer: number | undefined
let logTimer: number | undefined
let checkProgressTimer: number | undefined
let loadedUpdateId = ''

const serviceOrder = ['xiaozhi-server', 'web-gateway', 'manager-api', 'index-tts', 'mysql', 'redis']
const repositoryKeys = ['xiaozhi', 'index-tts', 'xiaozhi-autodl']
const services = computed<Service[]>(() => [...(overview.value?.services || [])].sort((left, right) => {
  const leftIndex = serviceOrder.indexOf(left.name)
  const rightIndex = serviceOrder.indexOf(right.name)
  return (leftIndex < 0 ? serviceOrder.length : leftIndex) - (rightIndex < 0 ? serviceOrder.length : rightIndex)
}))
const operation = computed<BatchOperation | undefined>(() => overview.value?.operation)
const serviceHealth = computed(() => {
  const counts = { ready: 0, starting: 0, stopping: 0, degraded: 0, stopped: 0, failed: 0 }
  for (const service of services.value) counts[service.phase.toLowerCase() as keyof typeof counts]++
  const tone = counts.failed ? 'failed'
    : counts.degraded ? 'degraded'
      : counts.starting ? 'starting'
        : counts.stopping ? 'stopping'
        : counts.stopped ? 'stopped'
          : counts.ready ? 'ready' : 'unknown'
  const details = [
    counts.failed ? `${counts.failed}项失败` : '',
    counts.degraded ? `${counts.degraded}项异常` : '',
    counts.starting ? `${counts.starting}项启动中` : '',
    counts.stopping ? `${counts.stopping}项停止中` : '',
    counts.stopped ? `${counts.stopped}项停止` : '',
  ].filter(Boolean)
  return {
    ...counts,
    healthy: counts.ready,
    total: services.value.length,
    tone,
    text: counts.ready === services.value.length && services.value.length
      ? `服务健康 ${counts.ready}/${services.value.length}`
      : `服务健康 ${counts.ready}/${services.value.length}${details.length ? ` · ${details.join(' · ')}` : ''}`,
  }
})
const versionHealth = computed(() => {
  const repositories = versionState.value?.repositories || []
  if (updateOperation.value?.state === 'running') {
    const total = updateOperation.value.steps.length || 1
    const done = updateOperation.value.steps.filter((step) => ['done', 'failed', 'skipped'].includes(step.state)).length
    const repository = repositories.find((item) => item.key === updateOperation.value?.repository)
    return { tone: 'checking', text: `正在更新 ${repository?.label || updateOperation.value.repository}`, detail: `${Math.round(done / total * 100)}%` }
  }
  if (checkingVersions.value) return { tone: 'checking', text: '正在检查代码版本', detail: '请稍候' }
  if (!repositories.length || repositories.some((item) => !item.remoteCheckedAt)) return { tone: 'unchecked', text: '代码版本尚未检查', detail: '查看 →' }
  const failed = repositories.filter((item) => item.remoteCheckOk === false).length
  if (failed) return { tone: 'failed', text: `代码版本 ${failed} 项检查失败`, detail: '查看 →' }
  const updates = repositories.filter((item) => item.updateAvailable)
  const blocked = updates.filter((item) => item.updateBlocked || item.dependencyBlocked || item.canFastForward === false).length
  if (blocked) return { tone: 'failed', text: `代码版本 ${blocked} 项更新受阻`, detail: '处理 →' }
  if (updates.length) return { tone: 'available', text: `代码版本 ${updates.length} 项可更新`, detail: '更新 →' }
  return { tone: 'current', text: `代码版本 ${repositories.length}/${repositories.length} 已同步`, detail: '查看 →' }
})
const selfVersionHealth = computed(() => {
  const repository = versionState.value?.repositories.find((item) => item.key === 'xiaozhi-autodl')
  const version = overview.value?.release?.version ? `v${overview.value.release.version}` : '版本'
  if (updateOperation.value?.repository === 'xiaozhi-autodl' && updateOperation.value.state === 'running') return { tone: 'checking', text: version, detail: '升级中' }
  if (checkingRepositories.value.includes('xiaozhi-autodl')) return { tone: 'checking', text: version, detail: '检查中' }
  if (repository?.remoteCheckOk === false) return { tone: 'warning', text: version, detail: '远端不可达' }
  if (repository?.updateAvailable) return { tone: 'available', text: version, detail: '可更新' }
  return { tone: repository?.remoteCheckedAt ? 'current' : 'unchecked', text: version, detail: '' }
})
const systemDisk = computed(() => overview.value?.metrics?.disks?.find((item: any) => item.mount === '/'))
const dataDisk = computed(() => overview.value?.metrics?.disks?.find((item: any) => item.mount === '/root/autodl-tmp'))
const gpu = computed(() => overview.value?.metrics?.gpu?.[0])
const checkingVersions = computed(() => checkingRepositories.value.length > 0)
const gitNetworkSummary = computed(() => {
  const state = gitNetwork.value
  if (!state) return { tone: 'unchecked', title: '尚未读取网络设置', detail: '自动选择连接线路' }
  const modeLabels: Record<GitNetworkMode, string> = { auto: '自动选择', direct: '直接连接', autodl: 'AutoDL 学术加速', custom: '自定义代理' }
  const transportLabels = { direct: '直连', autodl: 'AutoDL 学术加速', custom: '自定义代理' }
  const last = state.lastResult
  if (!last) return { tone: 'unchecked', title: modeLabels[state.config.mode], detail: state.config.mode === 'auto' ? '直连失败时自动回退到学术加速' : '尚未测试连接' }
  return {
    tone: last.ok ? 'current' : 'failed',
    title: modeLabels[state.config.mode],
    detail: last.ok
      ? `最近通过 ${last.transport ? transportLabels[last.transport] : '所选线路'}连接 · ${(last.elapsedMs / 1000).toFixed(1)} 秒`
      : `最近连接失败 · ${(last.elapsedMs / 1000).toFixed(1)} 秒`,
  }
})
const endpointReadiness = computed(() => {
  const readiness = endpoints.value?.readiness
  if (!readiness) return { ready: endpoints.value?.gatewayReachable ? 1 : 0, total: 1, allReady: Boolean(endpoints.value?.gatewayReachable) }
  const ready = Object.values(readiness).filter(Boolean).length
  return { ready, total: 3, allReady: ready === 3 }
})
const endpointStatus = computed(() => {
  const current = endpoints.value
  const readiness = `智控台 ${current?.readiness?.managerWeb ? '就绪' : '未就绪'} · OTA ${current?.readiness?.ota ? '就绪' : '未就绪'} · WebSocket ${current?.readiness?.websocket ? '就绪' : '未就绪'}`
  const rawMessage = current?.sync?.message || ''
  if (current?.inSync) {
    return {
      text: `地址已同步 · 接口 ${endpointReadiness.value.ready}/${endpointReadiness.value.total} 就绪`,
      title: `${readiness}${rawMessage ? `\n${rawMessage}` : ''}`,
    }
  }
  if (current?.sync?.state === 'failed') {
    const reason = /(?:can't connect to mysql|mysql server|mysqld|3306)/i.test(rawMessage)
      ? 'MySQL 未就绪'
      : rawMessage || '未知错误'
    return { text: `地址同步失败 · ${reason}`, title: `${readiness}\n${rawMessage || reason}` }
  }
  return { text: rawMessage || '等待同步', title: `${readiness}${rawMessage ? `\n${rawMessage}` : ''}` }
})
const logSourceOptions = computed(() => logs.service === 'web-gateway'
  ? [{ value: 'access', label: '访问日志' }, { value: 'error', label: '错误日志' }, { value: 'service', label: '启动日志' }]
  : logs.service === 'manager-api'
    ? [{ value: 'service', label: '应用日志' }, { value: 'access', label: '接口访问日志' }]
    : logs.service === 'index-tts' || logs.service === 'xiaozhi-server'
      ? [{ value: 'service', label: '业务日志' }, { value: 'raw', label: '原始日志' }]
      : logs.service === 'mysql'
        ? [{ value: 'error', label: '错误日志' }, { value: 'slow', label: '慢查询日志' }]
    : [{ value: 'service', label: '服务日志' }])
const logDownloadUrl = computed(() => {
  const query = new URLSearchParams({ lines: String(logs.lines), level: logs.level, keyword: logs.keyword, source: logs.source, preset: logs.preset })
  return `/api/services/${logs.service}/logs/download?${query}`
})
const operationProgress = computed(() => {
  const steps = operation.value?.steps || []
  if (!steps.length) return 0
  return Math.round(steps.filter((step) => ['done', 'failed', 'skipped'].includes(step.state)).length / steps.length * 100)
})
const operationSummary = computed(() => {
  const steps = operation.value?.steps || []
  const running = steps.find((step) => step.state === 'running')
  if (running) return `${running.action === 'start' ? '启动' : '停止'} ${running.label}`
  const failed = steps.filter((step) => step.state === 'failed')
  const skipped = steps.filter((step) => step.state === 'skipped')
  if (failed.length || skipped.length) return `${failed.length} 项失败${skipped.length ? ` · ${skipped.length} 项因依赖跳过` : ''}：${failed[0]?.message || skipped[0]?.message}`
  return `已完成 ${operationProgress.value}%`
})

type MetricTone = 'normal' | 'warning' | 'critical' | 'muted'

function metricTone(value: number | undefined, warning: number, critical: number): MetricTone {
  if (!Number.isFinite(value)) return 'muted'
  if ((value as number) >= critical) return 'critical'
  if ((value as number) >= warning) return 'warning'
  return 'normal'
}

function metricState(tone: MetricTone) {
  return { normal: '正常', warning: '偏高', critical: '告警', muted: '无数据' }[tone]
}

function fmtDate(value?: string) {
  if (!value) return '尚未执行统一刷新'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function fmtShortDate(value?: string) {
  if (!value) return '尚未检查远端'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtComponents(components?: string[]) {
  if (!components?.length) return '无需刷新运行组件'
  const labels: Record<string, string> = {
    dashboard: 'Dashboard',
    'manager-web': '智控台前端',
    'manager-api': 'Java 后端',
    'xiaozhi-server': '小智服务端',
    'index-tts': 'IndexTTS',
  }
  return components.length === 5 ? '全套组件' : components.map((item) => labels[item] || item).join('、')
}

const phaseLabels: Record<ServicePhase, string> = {
  READY: '运行正常',
  STARTING: '正在启动',
  STOPPING: '正在停止',
  DEGRADED: '等待就绪',
  STOPPED: '已停止',
  FAILED: '启动失败',
}

function fmtBytes(value?: number) {
  if (!Number.isFinite(value)) return '--'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value as number
  let index = 0
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ }
  return `${size.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`
}

function fmtTime(seconds?: number) {
  if (!Number.isFinite(seconds)) return '--'
  const value = seconds as number
  const days = Math.floor(value / 86400)
  const hours = Math.floor(value % 86400 / 3600)
  const minutes = Math.floor(value % 3600 / 60)
  return `${days ? `${days}天 ` : ''}${hours}时 ${minutes}分`
}

function fmtCores(value?: number) {
  if (!Number.isFinite(value)) return '--'
  return Number.isInteger(value) ? String(value) : (value as number).toFixed(1)
}

async function focusUnhealthyServices() {
  healthFocus.value = true
  await nextTick()
  serviceSection.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  window.setTimeout(() => { healthFocus.value = false }, 6000)
}

function navigate(page: 'overview' | 'versions') {
  const path = page === 'versions' ? '/versions' : '/'
  if (window.location.pathname !== path) window.history.pushState({}, '', path)
  currentPage.value = page
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function navigateToRepository(repository: string) {
  navigate('versions')
  await nextTick()
  document.getElementById(`repository-${repository}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function handlePopState() {
  currentPage.value = window.location.pathname === '/versions' ? 'versions' : 'overview'
}

function managerLink(route: '/home' | '/model-config') {
  const fallback = `${window.location.protocol}//${window.location.hostname}:6008`
  return `${(managerBaseUrl.value || fallback).replace(/\/$/, '')}/#${route}`
}

const endpointModeLabels: Record<EndpointMode, string> = {
  autodl: 'AutoDL 公网',
  lan: '局域网 / SSH 隧道',
  custom: '自定义域名',
}

const gitTransportLabels = { direct: '直接连接', autodl: 'AutoDL 学术加速', custom: '自定义代理' }
const repositoryLabels: Record<string, string> = { xiaozhi: 'xiaozhi-esp32-server', 'index-tts': 'index-tts', 'xiaozhi-autodl': 'xiaozhi-autodl' }

function updateStateLabel(operation: UpdateOperation) {
  return operation.state === 'running' ? '安全更新执行中'
    : operation.state === 'done' ? '安全更新完成'
      : operation.state === 'rolled-back' ? '更新失败，已自动回滚' : '安全更新失败'
}

function updateTone(operation: UpdateOperation) {
  return operation.state === 'done' ? 'done' : operation.state === 'running' ? 'running' : 'failed'
}

function updateProgress(operation: UpdateOperation) {
  const total = operation.steps.length || 1
  const complete = operation.steps.filter((step) => ['done', 'failed', 'skipped'].includes(step.state)).length
  return { complete, total, percent: Math.round(complete / total * 100) }
}

function elapsedLabel(start?: string, end?: string) {
  if (!start) return '--'
  const milliseconds = Math.max(0, new Date(end || Date.now()).getTime() - new Date(start).getTime())
  if (!Number.isFinite(milliseconds)) return '--'
  const seconds = Math.round(milliseconds / 1000)
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function isUpdateExpanded(operation: UpdateOperation) {
  if (collapsedUpdateIds[operation.id]) return false
  return operation.state !== 'done' || expandedUpdateId.value === operation.id
}

function collapseUpdate(operation: UpdateOperation) {
  collapsedUpdateIds[operation.id] = true
  if (expandedUpdateId.value === operation.id) expandedUpdateId.value = ''
}

function expandUpdate(operation: UpdateOperation) {
  delete collapsedUpdateIds[operation.id]
  expandedUpdateId.value = operation.id
}

function toast(text: string, kind = 'ok') {
  message.text = text
  message.kind = kind
  window.setTimeout(() => { if (message.text === text) message.text = '' }, 3500)
}

async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('content-type', 'application/json')
  if (csrf.value && (options.method || 'GET') !== 'GET') headers.set('x-csrf-token', csrf.value)
  const response = await fetch(path, { ...options, headers })
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    authenticated.value = false
    stopTimers()
  }
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`)
  return data
}

async function authStatus() {
  const data = await api('/api/auth/status')
  initialized.value = data.initialized
  authenticated.value = data.authenticated
  csrf.value = data.csrf || ''
  managerBaseUrl.value = data.managerWebUrl || ''
}

async function createPasscode() {
  busy.value = true
  try {
    const data = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify(setup),
    })
    initialized.value = true
    authenticated.value = true
    csrf.value = data.csrf
    setup.passcode = ''
    setup.confirm = ''
    await initializeDashboard()
  } catch (error) { toast((error as Error).message, 'error') } finally { busy.value = false }
}

async function loginDashboard() {
  busy.value = true
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: dashboardPassword.value }),
    })
    authenticated.value = true
    csrf.value = data.csrf
    dashboardPassword.value = ''
    await initializeDashboard()
  } catch (error) { toast((error as Error).message, 'error') } finally { busy.value = false }
}

async function updatePasscode() {
  busy.value = true
  try {
    const data = await api('/api/auth/passcode', {
      method: 'PUT',
      body: JSON.stringify(change),
    })
    csrf.value = data.csrf
    change.open = false
    change.current = ''
    change.next = ''
    change.confirm = ''
    toast('运维口令已更新，其他会话已退出')
  } catch (error) { toast((error as Error).message, 'error') } finally { busy.value = false }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' })
  authenticated.value = false
  overview.value = null
  stopTimers()
}

async function refresh(silent = false) {
  if (!authenticated.value || refreshing.value) return
  refreshing.value = true
  try { overview.value = await api('/api/overview') }
  catch (error) { if (!silent) toast((error as Error).message, 'error') }
  finally { refreshing.value = false }
}

function requestServiceAction(service: Service, action: 'start' | 'stop' | 'restart') {
  if (action === 'start') return void serviceAction(service.name, action)
  confirmBox.open = true
  confirmBox.title = action === 'stop' ? `停止 ${service.label}` : `重启 ${service.label}`
  confirmBox.text = action === 'stop' ? '服务停止后将不可用，确认继续吗？' : '服务会短暂中断，确认继续吗？'
  confirmBox.action = action
  confirmBox.service = service.name
}

function requestBatch(action: 'start' | 'stop' | 'restart') {
  if (action === 'start') return void batchAction(action)
  confirmBox.open = true
  confirmBox.title = action === 'stop' ? '停止全部服务' : '重启全部服务'
  confirmBox.text = action === 'stop'
    ? '将按依赖顺序停止六项服务；Dashboard 会保持运行。'
    : '将依次停止并恢复六项服务，IndexTTS 重新加载可能需要数分钟。'
  confirmBox.action = `batch:${action}`
  confirmBox.service = ''
}

function requestSafeUpdate(repository: RepositoryState) {
  confirmBox.open = true
  confirmBox.title = `安全更新 ${repository.label}`
  confirmBox.text = repository.updateBlocked
    ? '仓库存在受保护的本地改动，当前不能自动更新。'
    : repository.dependencyBlocked
      ? `这次更新包含依赖清单变化：${repository.dependencyChanges?.join('、')}，需要先升级环境。`
      : repository.key === 'xiaozhi-autodl'
        ? `将快进到 ${repository.upstream}，构建新运维中心并自动重启 Dashboard；升级结果会保存在数据盘，失败时自动回滚。确认继续吗？`
        : `将快进到 ${repository.upstream}，只构建并刷新 ${fmtComponents(repository.affectedComponents)}；失败会自动回滚。确认继续吗？`
  confirmBox.action = 'safe-update'
  confirmBox.service = repository.key
  pendingUpdateRef.value = updateTargets[repository.key] || repository.upstream || ''
}

async function confirmAction() {
  const action = confirmBox.action
  const service = confirmBox.service
  confirmBox.open = false
  if (action === 'safe-update') await startUpdate(service, pendingUpdateRef.value)
  else if (action.startsWith('batch:')) await batchAction(action.slice(6) as 'stop' | 'restart')
  else await serviceAction(service, action as 'stop' | 'restart')
}

async function serviceAction(name: string, action: 'start' | 'stop' | 'restart') {
  busy.value = true
  try {
    const data = await api(`/api/services/${name}/${action}`, { method: 'POST' })
    toast(data.message || '操作已提交')
    window.setTimeout(() => refresh(true), 800)
  } catch (error) { toast((error as Error).message, 'error') } finally { busy.value = false }
}

async function batchAction(action: 'start' | 'stop' | 'restart') {
  busy.value = true
  try {
    await api(`/api/services/batch/${action}`, { method: 'POST' })
    toast('批量操作已开始，可在进度条查看状态')
    await refresh(true)
  } catch (error) { toast((error as Error).message, 'error') } finally { busy.value = false }
}

async function loadLogs(silent = false) {
  if (!logs.service || logs.loading) return
  logs.loading = true
  try {
    const query = new URLSearchParams({
      lines: String(logs.lines),
      level: logs.level,
      keyword: logs.keyword,
      source: logs.source,
      preset: logs.preset,
    })
    const data = await api(`/api/services/${logs.service}/logs?${query}`)
    logs.error = data.error || ''
    logs.content = data.content || (data.error ? '' : '暂无匹配日志')
    logs.path = data.path || ''
    logs.updatedAt = new Date().toISOString()
    if (logs.follow) {
      await nextTick()
      if (logPre.value) logPre.value.scrollTop = logPre.value.scrollHeight
    }
  } catch (error) {
    logs.error = (error as Error).message
    if (!silent) toast(logs.error, 'error')
  }
  finally { logs.loading = false }
}

async function showLogs(service: Service) {
  logs.open = true
  logs.service = service.name
  logs.title = service.label
  logs.content = '正在读取日志…'
  logs.lines = 200
  logs.level = 'all'
  logs.keyword = ''
  logs.source = service.name === 'web-gateway' ? 'access' : service.name === 'mysql' ? 'error' : 'service'
  logs.preset = ''
  logs.presetLabel = ''
  logs.error = ''
  logs.follow = true
  await loadLogs()
  if (logTimer) window.clearInterval(logTimer)
  logTimer = window.setInterval(() => { if (logs.open && logs.follow) void loadLogs(true) }, 2000)
}

async function showSignalLogs(service: Service, signal: NonNullable<Service['signals']>[number]) {
  if (!signalHasLogs(signal)) return
  logs.open = true
  logs.service = service.name
  logs.title = service.label
  logs.content = '正在读取日志…'
  logs.lines = 200
  logs.level = signal.logLevel || 'all'
  logs.keyword = signal.logKeyword || ''
  logs.source = signal.logSource || (service.name === 'web-gateway' ? 'access' : 'service')
  logs.preset = signal.logPreset || ''
  logs.presetLabel = signal.logPreset ? signal.label : ''
  logs.error = ''
  logs.follow = true
  await loadLogs()
  if (logTimer) window.clearInterval(logTimer)
  logTimer = window.setInterval(() => { if (logs.open && logs.follow) void loadLogs(true) }, 2000)
}

function signalHasLogs(signal: NonNullable<Service['signals']>[number]) {
  return Boolean(signal.logSource || signal.logLevel || signal.logKeyword || signal.logPreset)
}

function changeLogSource() {
  logs.preset = ''
  logs.presetLabel = ''
  void loadLogs()
}

function clearLogPreset() {
  logs.preset = ''
  logs.presetLabel = ''
  void loadLogs()
}

function closeLogs() {
  logs.open = false
  if (logTimer) window.clearInterval(logTimer)
  logTimer = undefined
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(logs.content)
    toast('日志已复制')
  } catch {
    toast('浏览器禁止剪贴板访问，请使用日志下载', 'error')
  }
}

async function copyText(value?: string, label = '地址') {
  if (!value) return toast(`${label}尚未生成`, 'error')
  try {
    await navigator.clipboard.writeText(value)
    toast(`${label}已复制`)
  } catch { toast('浏览器禁止剪贴板访问', 'error') }
}

async function loadEndpoints(silent = false) {
  try { endpoints.value = await api('/api/endpoints') }
  catch (error) { if (!silent) toast((error as Error).message, 'error') }
}

function openEndpointDialog() {
  const config = endpoints.value?.config
  endpointDialog.mode = config?.mode || 'autodl'
  endpointDialog.baseUrl = config?.baseUrl || ''
  endpointDialog.sshHost = config?.sshHost || ''
  endpointDialog.sshPort = config?.sshPort || 22
  endpointDialog.localPort = config?.localPort || 16008
  endpointDialog.open = true
}

async function saveEndpoints() {
  busy.value = true
  try {
    endpoints.value = await api('/api/endpoints', { method: 'PUT', body: JSON.stringify(endpointDialog) })
    endpointDialog.open = false
    toast(endpoints.value?.inSync ? '客户端地址已保存并同步' : endpoints.value?.sync?.message || '配置已保存')
  } catch (error) { toast((error as Error).message, 'error') }
  finally { busy.value = false }
}

async function syncEndpoints() {
  busy.value = true
  try {
    endpoints.value = await api('/api/endpoints/sync', { method: 'POST' })
    toast(endpoints.value?.inSync ? 'OTA 与 WebSocket 地址已同步' : endpoints.value?.sync?.message || '同步尚未完成', endpoints.value?.inSync ? 'ok' : 'error')
  } catch (error) { toast((error as Error).message, 'error') }
  finally { busy.value = false }
}

async function loadVersions(silent = false) {
  try {
    versionState.value = await api('/api/versions')
    for (const repository of versionState.value?.repositories || []) {
      if (!updateTargets[repository.key]) updateTargets[repository.key] = repository.upstream || repository.refs?.[0] || ''
    }
  }
  catch (error) { if (!silent) toast((error as Error).message, 'error') }
}

function remoteVersionLabel(repository: RepositoryState) {
  if (!repository.remoteCheckedAt) return '尚未检查远端'
  if (repository.remoteCheckOk === false) return '检查失败'
  if ((repository.ahead || 0) > 0 && (repository.behind || 0) > 0) return `${repository.deployBranch || repository.branch} 与上游分叉`
  if (repository.updateAvailable) return `${repository.deployBranch || repository.branch} 有 ${repository.behind} 个新提交`
  if ((repository.ahead || 0) > 0) return `本地 ${repository.deployBranch || repository.branch} 领先 ${repository.ahead} 个提交`
  return `${repository.deployBranch || repository.branch} 已同步`
}

function remoteVersionTone(repository: RepositoryState) {
  if (!repository.remoteCheckedAt) return 'unchecked'
  if (repository.remoteCheckOk === false) return 'failed'
  return repository.updateAvailable || ((repository.ahead || 0) > 0 && (repository.behind || 0) > 0) ? 'available' : 'current'
}

function workspaceLabel(repository: RepositoryState) {
  if (repository.branchMismatch) return `当前为 ${repository.branch}，需切换到 ${repository.deployBranch}`
  if (repository.updateBlocked) return `${repository.blockingChanges?.length || repository.changedCount || 0} 项本地修改，自动更新已锁定`
  if (repository.dirty) return '仅有持久化文件，不影响更新'
  return '工作区干净'
}

function trackingSummary(repository: RepositoryState) {
  if (!repository.upstream) return `部署分支 ${repository.deployBranch || repository.branch} 尚未设置上游分支。`
  if ((repository.ahead || 0) > 0 && (repository.behind || 0) > 0) return `部署分支与 ${repository.upstream} 已分叉：本地独有 ${repository.ahead} 个提交，上游另有 ${repository.behind} 个提交。`
  if ((repository.behind || 0) > 0) return `部署分支落后 ${repository.upstream} ${repository.behind} 个提交。`
  if ((repository.ahead || 0) > 0) return `部署分支领先 ${repository.upstream} ${repository.ahead} 个提交。`
  return `部署分支 ${repository.branch} 已与 ${repository.upstream} 同步。`
}

function isRepositoryChecking(repository: string) {
  return checkingRepositories.value.includes(repository)
}

function repositoryCheckLabel(repository: string) {
  const progress = repositoryProgress.value[repository]
  if (!progress) return '正在连接 GitHub…'
  if (progress.stage === 'fetching') return `正在获取更新 · ${progress.elapsedSeconds} 秒`
  if (progress.stage === 'fallback') return `切换 AutoDL 学术加速 · ${progress.elapsedSeconds} 秒`
  const transport = progress.transport ? gitTransportLabels[progress.transport] : 'GitHub'
  return `连接 ${transport} ${progress.attempt}/${progress.totalAttempts} · ${progress.elapsedSeconds} 秒`
}

async function loadGitNetwork(silent = false) {
  try { gitNetwork.value = await api('/api/git-network') }
  catch (error) { if (!silent) toast((error as Error).message, 'error') }
}

function openGitNetworkDialog() {
  gitNetworkDialog.mode = gitNetwork.value?.config.mode || 'auto'
  gitNetworkDialog.customProxy = ''
  gitNetworkDialog.open = true
}

async function saveGitNetwork() {
  busy.value = true
  try {
    gitNetwork.value = await api('/api/git-network', { method: 'PUT', body: JSON.stringify({ mode: gitNetworkDialog.mode, customProxy: gitNetworkDialog.customProxy || undefined }) })
    gitNetworkDialog.open = false
    toast('GitHub 网络策略已保存，仅影响 Git 操作')
  } catch (error) { toast((error as Error).message, 'error') }
  finally { busy.value = false }
}

async function testGitNetworkConnection() {
  testingGitNetwork.value = true
  try {
    gitNetwork.value = await api('/api/git-network/test', { method: 'POST' })
    const result = gitNetwork.value?.test
    toast(result?.ok ? `${result.message} · ${result.transport ? gitTransportLabels[result.transport] : ''} · ${(result.elapsedMs / 1000).toFixed(1)} 秒` : result?.message || 'GitHub 连接失败', result?.ok ? 'ok' : 'error')
  } catch (error) { toast((error as Error).message, 'error') }
  finally { testingGitNetwork.value = false }
}

async function loadRepositoryProgress() {
  try {
    const data = await api('/api/versions/check-progress')
    repositoryProgress.value = Object.fromEntries((data.repositories || []).map((item: RepositoryCheckProgress) => [item.key, item]))
  } catch { /* 检查主请求会展示最终错误。 */ }
}

function startRepositoryProgressPolling() {
  if (checkProgressTimer) return
  void loadRepositoryProgress()
  checkProgressTimer = window.setInterval(() => { void loadRepositoryProgress() }, 750)
}

function stopRepositoryProgressPollingIfIdle() {
  if (checkingRepositories.value.length || !checkProgressTimer) return
  window.clearInterval(checkProgressTimer)
  checkProgressTimer = undefined
  repositoryProgress.value = {}
}

async function checkVersions(repository?: string, silent = false) {
  const targets = repository ? [repository] : repositoryKeys
  if (targets.some(isRepositoryChecking)) return
  checkingRepositories.value = [...new Set([...checkingRepositories.value, ...targets])]
  startRepositoryProgressPolling()
  try {
    versionState.value = await api('/api/versions/check', { method: 'POST', body: JSON.stringify({ repository: repository || undefined }) })
    for (const item of versionState.value?.repositories || []) {
      if (!updateTargets[item.key]) updateTargets[item.key] = item.upstream || item.refs?.[0] || ''
    }
    const checked = repository ? versionState.value?.repositories.find((item) => item.key === repository) : undefined
    const updates = versionState.value?.repositories.filter((item) => item.remoteCheckedAt && item.updateAvailable).length || 0
    const checkedItems = repository ? (checked ? [checked] : []) : versionState.value?.repositories || []
    const failures = checkedItems.filter((item) => item.remoteCheckOk === false)
    if (!silent) toast(
      repository
        ? `${checked?.label || repository}：${checked?.remoteCheckMessage || (checked ? remoteVersionLabel(checked) : '检查完成')}`
        : failures.length ? `${failures.length} 个仓库检查失败：${failures.map((item) => item.label).join('、')}` : updates ? `检测到 ${updates} 个部署分支有新提交` : '三个部署分支均已同步',
      failures.length ? 'error' : 'ok',
    )
  } catch (error) { if (!silent) toast((error as Error).message, 'error') }
  finally {
    checkingRepositories.value = checkingRepositories.value.filter((item) => !targets.includes(item))
    stopRepositoryProgressPollingIfIdle()
    await loadGitNetwork(true)
  }
}

async function loadUpdateOperation(silent = true) {
  try {
    const data = await api('/api/updates/current')
    updateOperation.value = data.operation
    updateHistoryItems.value = data.history || []
    if (data.operation && data.operation.state !== 'running' && loadedUpdateId !== data.operation.id) {
      loadedUpdateId = data.operation.id
      await loadVersions(true)
    }
  } catch (error) { if (!silent) toast((error as Error).message, 'error') }
}

async function startUpdate(repository: string, targetRef: string) {
  busy.value = true
  try {
    updateOperation.value = await api(`/api/updates/${repository}`, { method: 'POST', body: JSON.stringify({ ref: targetRef }) })
    if (updateOperation.value) expandUpdate(updateOperation.value)
    toast('安全更新已开始')
  } catch (error) { toast((error as Error).message, 'error') }
  finally { busy.value = false }
}

async function viewUpdateHistory(operation: UpdateOperation) {
  updateOperation.value = operation
  updateHistoryOpen.value = false
  expandUpdate(operation)
  await navigateToRepository(operation.repository)
}

function stopTimers() {
  if (refreshTimer) window.clearInterval(refreshTimer)
  if (versionTimer) window.clearInterval(versionTimer)
  if (logTimer) window.clearInterval(logTimer)
  if (checkProgressTimer) window.clearInterval(checkProgressTimer)
  refreshTimer = undefined
  versionTimer = undefined
  logTimer = undefined
  checkProgressTimer = undefined
}

async function initializeDashboard() {
  stopTimers()
  await Promise.all([refresh(), loadEndpoints(), loadVersions(), loadUpdateOperation(), loadGitNetwork()])
  const checkedTimes = versionState.value?.repositories.map((item) => item.remoteCheckedAt ? new Date(item.remoteCheckedAt).getTime() : 0) || []
  if (!checkedTimes.length || checkedTimes.some((value) => !value || Date.now() - value > 30 * 60 * 1000)) void checkVersions(undefined, true)
  refreshTimer = window.setInterval(() => { void refresh(true); void loadEndpoints(true); void loadUpdateOperation(true) }, 5000)
  versionTimer = window.setInterval(() => { void loadVersions(true) }, 60_000)
}

onMounted(async () => {
  window.addEventListener('popstate', handlePopState)
  await authStatus()
  if (authenticated.value) await initializeDashboard()
})
onBeforeUnmount(() => {
  window.removeEventListener('popstate', handlePopState)
  stopTimers()
})
</script>

<template>
  <div v-if="!authenticated" class="auth-page">
    <div class="brand-top"><img :src="'/brand/logo.png'" alt="智控台" /></div>
    <div class="auth-visual" aria-hidden="true">
      <span class="ring ring-one"></span><span class="ring ring-two"></span><span class="ring ring-three"></span>
      <img :src="'/brand/login-person.png'" alt="" />
    </div>
    <form v-if="!initialized" class="auth-card" @submit.prevent="createPasscode">
      <div class="auth-title"><span>Hi</span><div><h1>创建运维口令</h1><small>FIRST-TIME SETUP</small></div></div>
      <p>这是本实例第一次打开，请设置 Dashboard 独立口令。</p>
      <label for="setup-passcode">运维口令</label>
      <input id="setup-passcode" v-model="setup.passcode" type="password" autocomplete="new-password" autofocus placeholder="8-32 位，支持数字、字母和符号" />
      <label for="setup-confirm">确认口令</label>
      <input id="setup-confirm" v-model="setup.confirm" type="password" autocomplete="new-password" placeholder="请再次输入" />
      <button class="primary wide" :disabled="busy">{{ busy ? '正在创建…' : '创建并进入控制台' }}</button>
      <small class="auth-hint">口令仅以加密摘要保存在本机，不会保存明文</small>
    </form>
    <form v-else class="auth-card" @submit.prevent="loginDashboard">
      <div class="auth-title"><span>Hi</span><div><h1>运维中心登录</h1><small>WELCOME TO DASHBOARD</small></div></div>
      <p>集中监控服务状态、系统资源与运行日志。</p>
      <label for="dashboard-passcode">运维口令</label>
      <input id="dashboard-passcode" v-model="dashboardPassword" type="password" autocomplete="current-password" autofocus placeholder="请输入运维口令" />
      <button class="primary wide" :disabled="busy">{{ busy ? '登录中…' : '进入运维中心' }}</button>
      <small class="auth-hint">连续输错 5 次会暂时限制登录</small>
    </form>
    <div v-if="message.text" :class="['toast', message.kind]">{{ message.text }}</div>
    <footer>© 2026 xiaozhi-autodl · 运维控制台</footer>
  </div>

  <div v-else class="dashboard-page">
    <header class="topbar">
      <div class="topbar-brand">
        <img :src="'/brand/logo.png'" alt="智控台" />
        <div><strong>AutoDL 运维中心 <button :class="['self-version', selfVersionHealth.tone]" :title="`xiaozhi-autodl ${selfVersionHealth.detail || '版本详情'}`" @click="navigateToRepository('xiaozhi-autodl')"><i></i>{{ selfVersionHealth.text }}<span v-if="selfVersionHealth.detail">{{ selfVersionHealth.detail }}</span></button></strong><small>服务监控与运行控制</small></div>
      </div>
      <nav class="quick-links" aria-label="页面与智控台快捷入口">
        <a href="/" :class="{ active: currentPage === 'overview' }" @click.prevent="navigate('overview')">运行总览</a>
        <a href="/versions" :class="{ active: currentPage === 'versions' }" @click.prevent="navigate('versions')">代码版本</a>
        <a :href="managerLink('/home')" target="_blank">智能体管理 <b>↗</b></a>
        <a :href="managerLink('/model-config')" target="_blank">模型配置 <b>↗</b></a>
      </nav>
      <div class="account-actions">
        <button class="icon-button" title="立即刷新" :disabled="refreshing" @click="refresh()">↻</button>
        <button @click="change.open = true">修改口令</button>
        <button @click="logout">退出</button>
      </div>
    </header>

    <main v-if="currentPage === 'overview'" class="dashboard-main overview-main">
      <div class="page-heading">
        <div class="page-heading-copy"><h1>运行总览</h1><p>容器已运行 {{ fmtTime(overview?.metrics?.uptime) }} · 资源与服务每 5 秒刷新 · 最近刷新 {{ fmtComponents(overview?.release?.components) }}：{{ fmtDate(overview?.release?.refreshedAt) }}</p></div>
        <div class="heading-statuses">
          <button :class="['version-status', versionHealth.tone]" :title="versionHealth.text" @click="navigate('versions')">
            <i></i><span>{{ versionHealth.text }}</span><b>{{ versionHealth.detail }}</b>
          </button>
          <button :class="['overall-status', serviceHealth.tone]" title="定位未就绪服务" @click="focusUnhealthyServices">
            <i></i><span>{{ serviceHealth.text }}</span><b>查看服务 ↓</b>
          </button>
        </div>
      </div>

      <section v-if="overview" class="metric-grid" aria-label="系统资源">
        <article :class="['metric-card', metricTone(overview.metrics.cpu.usage, 70, 90)]">
          <div class="metric-top"><span class="metric-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 9h6v6H9zM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/></svg></span><span class="metric-label">CPU 使用率</span><b>{{ overview.metrics.cpu.usage }}%</b></div>
          <div class="metric-meta"><small>{{ fmtCores(overview.metrics.cpu.cores) }} vCPU 配额 · 限流 {{ overview.metrics.cpu.throttled }}%</small><strong>{{ metricState(metricTone(overview.metrics.cpu.usage, 70, 90)) }}</strong></div><i><b :style="{ width: `${Math.min(overview.metrics.cpu.usage, 100)}%` }"></b></i>
        </article>
        <article :class="['metric-card', metricTone(overview.metrics.memory.percent, 75, 90)]">
          <div class="metric-top"><span class="metric-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10v4m4-4v4m4-4v4M7 3v3m5-3v3m5-3v3M7 18v3m5-3v3m5-3v3"/></svg></span><span class="metric-label">内存使用率</span><b>{{ overview.metrics.memory.percent }}%</b></div>
          <div class="metric-meta"><small>{{ fmtBytes(overview.metrics.memory.used) }} / {{ fmtBytes(overview.metrics.memory.total) }}</small><strong>{{ metricState(metricTone(overview.metrics.memory.percent, 75, 90)) }}</strong></div><i><b :style="{ width: `${overview.metrics.memory.percent}%` }"></b></i>
        </article>
        <article :class="['metric-card', metricTone(gpu?.temperature, 70, 85)]">
          <div class="metric-top"><span class="metric-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="12" rx="2"/><circle cx="9" cy="11" r="3"/><path d="M14 9h4m-4 4h4M8 21h8m-4-4v4"/></svg></span><span class="metric-label">GPU 利用率</span><b>{{ gpu?.utilization ?? '--' }}{{ gpu ? '%' : '' }}</b></div>
          <div class="metric-meta"><small>{{ gpu ? `${gpu.name} · ${gpu.temperature}℃` : '当前未检测到 GPU' }}</small><strong>{{ metricState(metricTone(gpu?.temperature, 70, 85)) }}</strong></div><i><b :style="{ width: `${gpu?.utilization || 0}%` }"></b></i>
        </article>
        <article :class="['metric-card', metricTone(gpu ? gpu.memoryUsed / gpu.memoryTotal * 100 : undefined, 75, 90)]">
          <div class="metric-top"><span class="metric-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v10H4zM7 10h3v4H7zm6 0h4m-4 4h4M2 9h2m-2 6h2m16-6h2m-2 6h2"/></svg></span><span class="metric-label">显存使用率</span><b>{{ gpu ? Math.round(gpu.memoryUsed / gpu.memoryTotal * 100) : '--' }}{{ gpu ? '%' : '' }}</b></div>
          <div class="metric-meta"><small>{{ gpu ? `${gpu.memoryUsed} / ${gpu.memoryTotal} MiB` : '当前无显存数据' }}</small><strong>{{ metricState(metricTone(gpu ? gpu.memoryUsed / gpu.memoryTotal * 100 : undefined, 75, 90)) }}</strong></div><i><b :style="{ width: `${gpu ? gpu.memoryUsed / gpu.memoryTotal * 100 : 0}%` }"></b></i>
        </article>
        <article :class="['metric-card', metricTone(systemDisk?.percent, 75, 90)]">
          <div class="metric-top"><span class="metric-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 8h10M7 12h6M7 16h3m7 0h.01"/></svg></span><span class="metric-label">系统盘</span><b>{{ systemDisk?.percent ?? '--' }}{{ systemDisk ? '%' : '' }}</b></div>
          <div class="metric-meta"><small>{{ systemDisk ? `${fmtBytes(systemDisk.used)} / ${fmtBytes(systemDisk.total)}` : '系统盘数据不可用' }}</small><strong>{{ metricState(metricTone(systemDisk?.percent, 75, 90)) }}</strong></div><i><b :style="{ width: `${systemDisk?.percent || 0}%` }"></b></i>
        </article>
        <article :class="['metric-card', metricTone(dataDisk?.percent, 75, 90)]">
          <div class="metric-top"><span class="metric-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg></span><span class="metric-label">数据盘</span><b>{{ dataDisk?.percent ?? '--' }}{{ dataDisk ? '%' : '' }}</b></div>
          <div class="metric-meta"><small>{{ dataDisk ? `${fmtBytes(dataDisk.used)} / ${fmtBytes(dataDisk.total)}` : '数据盘数据不可用' }}</small><strong>{{ metricState(metricTone(dataDisk?.percent, 75, 90)) }}</strong></div><i><b :style="{ width: `${dataDisk?.percent || 0}%` }"></b></i>
        </article>
      </section>

      <section v-if="endpoints" class="access-panel" aria-label="客户端接入">
        <div class="access-heading">
          <span class="access-icon">⌁</span>
          <div><h2>客户端接入</h2><p :title="endpoints.sourceDetail || `${endpointModeLabels[endpoints.config.mode]} · ${endpoints.source}`">{{ endpointModeLabels[endpoints.config.mode] }} · {{ endpoints.source }}</p></div>
          <span :class="['access-state', endpoints.inSync && endpointReadiness.allReady ? 'ready' : endpoints.sync?.state === 'failed' ? 'failed' : 'pending']" :title="endpointStatus.title">
            <i></i><span>{{ endpointStatus.text }}</span>
          </span>
        </div>
        <div class="endpoint-list">
          <div><span>智控台地址</span><code :title="endpoints.managerUrl">{{ endpoints.managerUrl || '等待 AutoDL 分配 6008 公网地址' }}</code><button @click="copyText(endpoints.managerUrl, '智控台地址')">复制</button></div>
          <div><span>OTA 地址</span><code :title="endpoints.otaUrl">{{ endpoints.otaUrl || '尚未生成' }}</code><button @click="copyText(endpoints.otaUrl, 'OTA 地址')">复制</button></div>
          <div><span>WebSocket 地址</span><code :title="endpoints.websocketUrl">{{ endpoints.websocketUrl || '尚未生成' }}</code><button @click="copyText(endpoints.websocketUrl, 'WebSocket 地址')">复制</button></div>
        </div>
        <div class="access-actions"><button :disabled="busy" @click="syncEndpoints">↻ 重新同步</button><button class="primary" @click="openEndpointDialog">配置接入方式</button></div>
      </section>

      <section class="control-bar">
        <div><h2>服务管理</h2><p>Dashboard 自身不会被批量操作停止</p></div>
        <div class="batch-actions">
          <button class="primary" :disabled="busy || operation?.state === 'running'" @click="requestBatch('start')">▶ 全部启动</button>
          <button :disabled="busy || operation?.state === 'running'" @click="requestBatch('restart')">↻ 全部重启</button>
          <button class="danger" :disabled="busy || operation?.state === 'running'" @click="requestBatch('stop')">■ 全部停止</button>
        </div>
      </section>

      <section v-if="operation" :class="['operation-bar', operation.state]">
        <div class="operation-copy">
          <span>{{ operation.state === 'running' ? '批量操作执行中' : operation.state === 'done' ? '批量操作完成' : '批量操作遇到错误' }}</span>
          <small :title="operation.steps.filter((step) => step.message).map((step) => `${step.label}：${step.message}`).join('\n')">{{ operationSummary }}</small>
        </div>
        <div class="operation-track"><i :style="{ width: `${operationProgress}%` }"></i></div>
        <b>{{ operationProgress }}%</b>
      </section>

      <section ref="serviceSection" :class="['service-grid', { 'health-focus': healthFocus }]" aria-label="服务列表">
        <article v-for="service in services" :key="service.name" :class="['service-card', service.phase.toLowerCase(), { 'health-target': healthFocus && service.phase !== 'READY', 'health-dimmed': healthFocus && service.phase === 'READY' }]">
          <div class="service-head">
            <div class="service-identity"><span :class="['service-icon', service.name]">{{ service.label.slice(0, 1) }}</span><div><h3>{{ service.label }}</h3><small>端口 {{ service.port }} ｜ {{ service.pid ? `PID ${service.pid}` : '无运行进程' }}</small></div></div>
            <span :class="['phase-badge', service.phase.toLowerCase()]"><i></i>{{ phaseLabels[service.phase] }}</span>
          </div>
          <div class="service-stats">
            <span><small>CPU</small><b :class="metricTone(service.cpu, 60, 85)">{{ service.cpu ?? '--' }}{{ service.cpu !== undefined ? '%' : '' }}</b></span>
            <span><small>内存</small><b>{{ fmtBytes(service.memory) }}</b></span>
            <span><small>运行时长</small><b>{{ fmtTime(service.uptime) }}</b></span>
          </div>
          <div class="service-signals" aria-label="运行信号">
            <button v-for="signal in service.signals" :key="signal.label" :class="[signal.tone, { clickable: signalHasLogs(signal) }]" :aria-disabled="!signalHasLogs(signal)" :title="signalHasLogs(signal) ? `按“${signal.label}”筛选 ${service.label} 日志` : '实时状态指标，不对应具体日志记录'" @click="showSignalLogs(service, signal)">
              <small>{{ signal.label }}</small><b>{{ signal.value }}</b>
            </button>
          </div>
          <div :class="['service-note', service.lastError ? 'has-error' : '']" :title="service.lastError || ''">
            <span>{{ service.lastError ? '最近异常' : service.healthy ? '健康检查' : '当前状态' }}</span>
            <p>{{ service.lastError || (service.healthy ? `应用探测通过${service.healthLatencyMs !== undefined ? ` · ${service.healthLatencyMs} ms` : ''}` : service.detail || '端口尚未监听') }}</p>
            <small v-if="service.stability?.restartCount10m" :class="['restart-warning', { elevated: service.stability.restartCount10m >= 2 }]" title="包含人工启动、人工重启和异常拉起">↻ 10 分钟内启动/重启 {{ service.stability.restartCount10m }} 次</small>
          </div>
          <div class="service-actions">
            <button @click="showLogs(service)">查看日志</button>
            <button :disabled="busy || !service.allowedActions?.start" @click="requestServiceAction(service, 'start')">{{ service.phase === 'FAILED' ? '重试启动' : '启动' }}</button>
            <button :disabled="busy || !service.allowedActions?.restart" @click="requestServiceAction(service, 'restart')">重启</button>
            <button class="danger" :disabled="busy || !service.allowedActions?.stop" @click="requestServiceAction(service, 'stop')">停止</button>
          </div>
        </article>
      </section>
    </main>

    <main v-else class="dashboard-main version-page-main">
      <div class="version-page-heading">
        <div><button class="back-button" @click="navigate('overview')">← 返回运行总览</button><h1>代码版本管理</h1><p>检查 GitHub 远端、查看本地改动，并通过受保护流程更新运行版本。</p></div>
        <div class="version-page-actions"><button :disabled="!updateHistoryItems.length" @click="updateHistoryOpen = true">更新记录 {{ updateHistoryItems.length || '' }}</button><button class="primary" :disabled="checkingVersions" @click="checkVersions()">{{ checkingVersions ? `正在检查 ${checkingRepositories.length} 个仓库…` : '↻ 检查全部仓库' }}</button></div>
      </div>

      <section :class="['git-network-panel', gitNetworkSummary.tone]">
        <div class="git-network-icon">⇄</div>
        <div class="git-network-copy"><b>GitHub 网络</b><strong>{{ gitNetworkSummary.title }}</strong><span>{{ gitNetworkSummary.detail }}</span><small v-if="gitNetwork?.config.mode === 'autodl'">仅在检查和更新仓库时使用，不会代理模型、语音或 Java 服务</small></div>
        <span v-if="gitNetwork?.autodlAvailable" class="academic-available"><i></i>学术加速可用</span>
        <div class="git-network-actions"><button :disabled="testingGitNetwork" @click="testGitNetworkConnection">{{ testingGitNetwork ? '测试中…' : '测试连接' }}</button><button class="primary subtle" @click="openGitNetworkDialog">网络设置</button></div>
      </section>

      <section class="version-guide">
        <div><b>部署分支状态</b><span>小智仅比较 mvp，IndexTTS 与 xiaozhi-autodl 仅比较 main。</span></div>
        <div><b>工作区状态</b><span>本地修改不会阻止检查，但会锁定自动更新，避免覆盖已调通代码。</span></div>
        <div><b>安全更新</b><span>仅允许快进；依赖变化、构建失败或健康检查失败会暂停或自动回滚。</span></div>
      </section>

      <section v-if="versionState" class="repository-grid">
        <article v-for="repository in versionState.repositories" :id="`repository-${repository.key}`" :key="repository.key" :class="['repository-card', { 'self-repository': repository.key === 'xiaozhi-autodl', 'has-update-detail': updateOperation?.repository === repository.key && updateOperation && isUpdateExpanded(updateOperation) }]">
          <header>
            <div><span class="repository-icon">{{ repository.key === 'xiaozhi' ? 'X' : repository.key === 'index-tts' ? 'I' : 'A' }}</span><div><h2>{{ repository.label }}</h2><a v-if="repository.remoteUrl" :href="repository.remoteUrl" target="_blank">{{ repository.remoteUrl }} ↗</a></div></div>
            <span :class="['remote-status', remoteVersionTone(repository)]"><i></i>{{ remoteVersionLabel(repository) }}</span>
          </header>

          <div class="repository-meta">
            <span><small>当前分支</small><b>{{ repository.branch || '--' }}</b></span>
            <span><small>当前提交</small><b><code>{{ repository.shortCommit || '--' }}</code></b></span>
            <span><small>上游分支</small><b>{{ repository.upstream || '未设置' }}</b></span>
            <span><small>远端检查时间</small><b>{{ fmtShortDate(repository.remoteCheckedAt) }}</b></span>
          </div>

          <div :class="['tracking-comparison', { diverged: (repository.ahead || 0) > 0 && (repository.behind || 0) > 0 }]"><b>部署分支</b><span>{{ trackingSummary(repository) }}</span></div>

          <div v-if="repository.remoteCheckOk === false" class="remote-check-error">
            <div><b>远端检查失败</b><span>{{ repository.remoteCheckMessage || '未获得具体错误信息' }}</span></div>
            <div class="remote-error-actions"><button @click="openGitNetworkDialog">网络设置</button><button :disabled="isRepositoryChecking(repository.key)" @click="checkVersions(repository.key)">重新检查</button></div>
          </div>

          <div class="commit-card"><span>当前提交说明</span><strong>{{ repository.subject || '暂无提交说明' }}</strong><small>{{ fmtDate(repository.committedAt) }}</small></div>

          <div v-if="repository.updateAvailable" :class="['update-preview', { blocked: repository.dependencyBlocked || repository.canFastForward === false }]">
            <header>
              <div><b>更新预览</b><span>落后 {{ repository.behind }} 个提交 · 将刷新 {{ fmtComponents(repository.affectedComponents) }}</span></div>
              <strong v-if="repository.dependencyBlocked">需要先升级环境</strong>
              <strong v-else-if="repository.canFastForward === false">无法快进</strong>
              <strong v-else>可安全快进</strong>
            </header>
            <p v-if="repository.dependencyChanges?.length">依赖清单变化：{{ repository.dependencyChanges.join('、') }}</p>
            <ol v-if="repository.incomingCommits?.length">
              <li v-for="commit in repository.incomingCommits.slice(0, 4)" :key="commit.commit"><code>{{ commit.commit }}</code><span>{{ commit.subject }}</span></li>
            </ol>
          </div>

          <div :class="['workspace-state', { blocked: repository.updateBlocked }]">
            <div><b>{{ workspaceLabel(repository) }}</b><span v-if="repository.updateBlocked">请先将这些修改提交到你的 GitHub 分支，或人工处理后再更新。</span><span v-else>可以执行远端检查；安全更新仍会再次完成预检。</span></div>
            <ul v-if="repository.changes?.length"><li v-for="changeLine in repository.changes" :key="changeLine"><code>{{ changeLine }}</code></li></ul>
          </div>

          <footer>
            <label>固定部署目标<span class="fixed-target">{{ repository.upstream || `origin/${repository.deployBranch}` }}</span></label>
            <div>
              <button :disabled="isRepositoryChecking(repository.key)" @click="checkVersions(repository.key)">{{ isRepositoryChecking(repository.key) ? repositoryCheckLabel(repository.key) : '检查该仓库' }}</button>
              <button class="primary" :disabled="busy || !repository.updateAvailable || repository.updateBlocked || repository.dependencyBlocked || repository.canFastForward === false || updateOperation?.state === 'running'" :title="repository.blockingChanges?.join('\n')" @click="requestSafeUpdate(repository)">{{ repository.dependencyBlocked ? '需要升级环境' : repository.updateAvailable ? repository.key === 'xiaozhi-autodl' ? '安全更新并重启 Dashboard' : '安全更新并刷新服务' : '已是最新版本' }}</button>
            </div>
          </footer>

          <div v-if="updateOperation?.repository === repository.key && !isUpdateExpanded(updateOperation)" :class="['update-summary', updateTone(updateOperation)]">
            <span class="update-summary-icon">{{ updateOperation.state === 'done' ? '✓' : updateOperation.state === 'running' ? '↻' : '!' }}</span>
            <div><b>{{ repository.label }} · {{ updateStateLabel(updateOperation) }}</b><span>{{ updateOperation.message || `${updateOperation.fromCommit || '当前版本'} → ${updateOperation.toCommit || '远端版本'}` }}</span></div>
            <small>{{ elapsedLabel(updateOperation.startedAt, updateOperation.finishedAt) }} · {{ fmtShortDate(updateOperation.finishedAt || updateOperation.startedAt) }}</small>
            <button @click="expandUpdate(updateOperation)">查看详情</button>
          </div>

          <section v-if="updateOperation?.repository === repository.key && isUpdateExpanded(updateOperation)" :class="['update-detail', updateOperation.state]">
            <header>
              <div>
                <h2>{{ repository.label }} · {{ updateStateLabel(updateOperation) }}</h2>
                <p>{{ updateOperation.message || '正在执行受保护更新流程' }}</p>
              </div>
              <div class="update-detail-meta"><span>{{ updateProgress(updateOperation).complete }}/{{ updateProgress(updateOperation).total }} 步 · {{ elapsedLabel(updateOperation.startedAt, updateOperation.finishedAt) }}</span><code>{{ updateOperation.fromCommit || '当前版本' }} → {{ updateOperation.toCommit || '远端版本' }}</code><button v-if="updateOperation.state !== 'running'" @click="collapseUpdate(updateOperation)">{{ updateOperation.state === 'done' ? '收起' : '确认并收起' }}</button></div>
            </header>
            <ol><li v-for="step in updateOperation.steps" :key="step.name" :class="step.state"><i></i><span>{{ step.label }}</span><small>{{ step.message }}</small></li></ol>
            <details class="update-log-block" :open="updateOperation.state !== 'done'"><summary>执行日志 · {{ updateOperation.logs.length }} 行</summary><pre>{{ updateOperation.logs.join('\n') || '等待更新日志…' }}</pre></details>
          </section>
        </article>
      </section>
    </main>

    <div v-if="message.text" :class="['toast', message.kind]">{{ message.text }}</div>

    <div v-if="logs.open" class="drawer-mask" @click.self="closeLogs">
      <aside class="log-drawer" role="dialog" aria-modal="true" :aria-label="`${logs.title} 日志`">
        <header><div><h2>{{ logs.title }} 日志</h2><small>{{ logs.path }}</small></div><button class="close-button" @click="closeLogs">×</button></header>
        <div class="log-toolbar">
          <select v-model.number="logs.lines" @change="loadLogs()"><option :value="200">最近 200 行</option><option :value="500">最近 500 行</option><option :value="1000">最近 1000 行</option></select>
          <select v-model="logs.source" @change="changeLogSource"><option v-for="option in logSourceOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select>
          <select v-model="logs.level" @change="loadLogs()"><option value="all">全部级别</option><option value="info">INFO</option><option value="warn">WARN</option><option value="error">ERROR</option></select>
          <div class="log-search"><input v-model="logs.keyword" placeholder="搜索关键词" @keyup.enter="loadLogs()" /><button @click="loadLogs()">筛选</button></div>
        </div>
        <div class="log-options"><label><input v-model="logs.follow" type="checkbox" /> 自动追踪</label><span class="refresh-state"><i :class="{ active: logs.loading }"></i>每 2 秒自动刷新</span><button v-if="logs.presetLabel" class="log-filter-chip" @click="clearLogPreset">指标筛选：{{ logs.presetLabel }} ×</button><small v-if="logs.updatedAt">最近更新 {{ fmtShortDate(logs.updatedAt) }}</small><div><button @click="copyLogs">复制</button><a :href="logDownloadUrl">下载</a></div></div>
        <div v-if="logs.error" class="log-error">日志加载失败：{{ logs.error }}</div>
        <pre ref="logPre">{{ logs.content }}</pre>
      </aside>
    </div>

    <div v-if="change.open" class="modal-mask" @click.self="change.open = false">
      <form class="dialog-card" @submit.prevent="updatePasscode">
        <div><h2>修改运维口令</h2><button type="button" class="close-button" @click="change.open = false">×</button></div>
        <p>更新后其他浏览器会话将自动退出。</p>
        <label>当前口令</label><input v-model="change.current" type="password" autocomplete="current-password" autofocus />
        <label>新口令</label><input v-model="change.next" type="password" autocomplete="new-password" placeholder="8-32 位" />
        <label>确认新口令</label><input v-model="change.confirm" type="password" autocomplete="new-password" />
        <div class="dialog-actions"><button type="button" @click="change.open = false">取消</button><button class="primary" :disabled="busy">保存新口令</button></div>
      </form>
    </div>

    <div v-if="endpointDialog.open" class="modal-mask" @click.self="endpointDialog.open = false">
      <form class="dialog-card endpoint-dialog" @submit.prevent="saveEndpoints">
        <div><h2>配置客户端接入</h2><button type="button" class="close-button" @click="endpointDialog.open = false">×</button></div>
        <p>Dashboard 只会同步智控台参数中的 <code>server.ota</code> 与 <code>server.websocket</code>。</p>
        <div class="mode-options">
          <label :class="{ active: endpointDialog.mode === 'autodl' }"><input v-model="endpointDialog.mode" type="radio" value="autodl" /><span><b>AutoDL 公网</b><small>自动读取当前 6008 域名</small></span></label>
          <label :class="{ active: endpointDialog.mode === 'lan' }"><input v-model="endpointDialog.mode" type="radio" value="lan" /><span><b>局域网 / 隧道</b><small>本地电脑或局域网客户端</small></span></label>
          <label :class="{ active: endpointDialog.mode === 'custom' }"><input v-model="endpointDialog.mode" type="radio" value="custom" /><span><b>自定义域名</b><small>已有反向代理与证书</small></span></label>
        </div>
        <template v-if="endpointDialog.mode !== 'autodl'">
          <label>客户端可访问的基础地址</label>
          <input v-model.trim="endpointDialog.baseUrl" placeholder="例如 http://192.168.1.20:16008" />
        </template>
        <template v-if="endpointDialog.mode === 'lan'">
          <div class="form-columns"><label>SSH 主机（可选）<input v-model.trim="endpointDialog.sshHost" placeholder="服务器 IP 或域名" /></label><label>SSH 端口<input v-model.number="endpointDialog.sshPort" type="number" min="1" max="65535" /></label></div>
          <label>本地映射端口</label><input v-model.number="endpointDialog.localPort" type="number" min="1" max="65535" />
          <div v-if="endpointDialog.sshHost" class="tunnel-preview"><span>隧道命令</span><code>ssh -N -p {{ endpointDialog.sshPort }} -L 0.0.0.0:{{ endpointDialog.localPort }}:127.0.0.1:6008 root@{{ endpointDialog.sshHost }}</code></div>
        </template>
        <div class="dialog-actions"><button type="button" @click="endpointDialog.open = false">取消</button><button class="primary" :disabled="busy">保存并同步</button></div>
      </form>
    </div>

    <div v-if="gitNetworkDialog.open" class="modal-mask" @click.self="gitNetworkDialog.open = false">
      <form class="dialog-card git-network-dialog" @submit.prevent="saveGitNetwork">
        <div class="network-dialog-header">
          <span class="network-dialog-icon">⇄</span>
          <div><h2>GitHub 网络设置</h2><p>为代码检查与安全更新选择连接线路</p></div>
          <button type="button" class="close-button" aria-label="关闭" @click="gitNetworkDialog.open = false">×</button>
        </div>

        <div :class="['network-current', gitNetworkSummary.tone]">
          <div><small>当前策略</small><strong>{{ gitNetworkSummary.title }}</strong></div>
          <span><i></i>{{ gitNetworkSummary.detail }}</span>
        </div>

        <fieldset class="network-mode-fieldset">
          <legend>选择连接方式</legend>
          <div class="network-mode-options">
            <label :class="{ active: gitNetworkDialog.mode === 'auto' }">
              <input v-model="gitNetworkDialog.mode" type="radio" value="auto" />
              <span class="network-choice-icon auto">A</span>
              <span class="network-choice-copy"><b>自动选择 <em>推荐</em></b><small>先尝试直连，5 秒无响应后自动切换学术加速</small><mark>适合镜像发布与日常使用</mark></span>
              <span class="network-choice-check">✓</span>
            </label>
            <label :class="{ active: gitNetworkDialog.mode === 'direct' }">
              <input v-model="gitNetworkDialog.mode" type="radio" value="direct" />
              <span class="network-choice-icon direct">↗</span>
              <span class="network-choice-copy"><b>仅直接连接</b><small>不读取终端代理，也不启用 AutoDL 学术加速</small><mark>网络可直达 GitHub 时使用</mark></span>
              <span class="network-choice-check">✓</span>
            </label>
            <label :class="{ active: gitNetworkDialog.mode === 'autodl', disabled: !gitNetwork?.autodlAvailable }">
              <input v-model="gitNetworkDialog.mode" type="radio" value="autodl" :disabled="!gitNetwork?.autodlAvailable" />
              <span class="network-choice-icon autodl">⚡</span>
              <span class="network-choice-copy"><b>AutoDL 学术加速 <em :class="gitNetwork?.autodlAvailable ? 'available' : 'unavailable'">{{ gitNetwork?.autodlAvailable ? '当前可用' : '不可用' }}</em></b><small>读取 /etc/network_turbo，仅用于 GitHub 连接</small><mark>不保证长期稳定，适合作为回退</mark></span>
              <span class="network-choice-check">✓</span>
            </label>
            <label :class="{ active: gitNetworkDialog.mode === 'custom' }">
              <input v-model="gitNetworkDialog.mode" type="radio" value="custom" />
              <span class="network-choice-icon custom">⌁</span>
              <span class="network-choice-copy"><b>自定义代理</b><small>使用 SSH 反向隧道或自己的 HTTP / SOCKS5 代理</small><mark>{{ gitNetwork?.config.customProxyConfigured ? '已有代理配置' : '适合本机代理开发环境' }}</mark></span>
              <span class="network-choice-check">✓</span>
            </label>
          </div>
        </fieldset>

        <div v-if="gitNetworkDialog.mode === 'custom'" class="network-proxy-field">
          <label for="git-custom-proxy"><span>代理地址</span><small>支持 HTTP、HTTPS、SOCKS5 与 SOCKS5H</small></label>
          <input id="git-custom-proxy" v-model.trim="gitNetworkDialog.customProxy" :placeholder="gitNetwork?.config.customProxyConfigured ? `已保存 ${gitNetwork.config.customProxyDisplay || '代理'}；留空保持不变` : '例如 http://127.0.0.1:7890'" autocomplete="off" />
        </div>

        <div class="network-scope-notice"><span>i</span><div><b>只影响 Git 操作</b><p>策略仅注入检查仓库和更新源码的 Git 子进程，不会修改系统全局代理，也不会影响 AutoDL 公网域名、DeepSeek、Codex、IndexTTS 或其他服务。</p></div></div>
        <div class="dialog-actions network-dialog-actions"><button type="button" @click="gitNetworkDialog.open = false">取消</button><button class="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存网络策略' }}</button></div>
      </form>
    </div>

    <div v-if="updateHistoryOpen" class="modal-mask" @click.self="updateHistoryOpen = false">
      <div class="dialog-card update-history-dialog" role="dialog" aria-modal="true">
        <div><h2>最近更新记录</h2><button class="close-button" @click="updateHistoryOpen = false">×</button></div>
        <p>最多保留最近 10 次受保护更新。成功记录只保留摘要，失败记录可重新打开排查。</p>
        <div class="update-history-list">
          <button v-for="item in updateHistoryItems" :key="item.id" :class="['update-history-item', updateTone(item)]" @click="viewUpdateHistory(item)">
            <i>{{ item.state === 'done' ? '✓' : item.state === 'running' ? '↻' : '!' }}</i>
            <span><b>{{ repositoryLabels[item.repository] || item.repository }}</b><small>{{ updateStateLabel(item) }} · {{ item.message || `${item.fromCommit || '--'} → ${item.toCommit || '--'}` }}</small></span>
            <em>{{ elapsedLabel(item.startedAt, item.finishedAt) }}<small>{{ fmtShortDate(item.finishedAt || item.startedAt) }}</small></em>
          </button>
        </div>
      </div>
    </div>

    <div v-if="confirmBox.open" class="modal-mask" @click.self="confirmBox.open = false">
      <div class="dialog-card confirm-card" role="alertdialog" aria-modal="true">
        <div><h2>{{ confirmBox.title }}</h2><button class="close-button" @click="confirmBox.open = false">×</button></div>
        <p>{{ confirmBox.text }}</p>
        <div class="dialog-actions"><button @click="confirmBox.open = false">取消</button><button class="danger solid" @click="confirmAction">确认执行</button></div>
      </div>
    </div>
  </div>
</template>
