import { resolve } from 'node:path'

export const PROJECT_ROOT = resolve(process.env.XIAOZHI_AUTODL_ROOT || '/root/xiaozhi-autodl')
export const RUNTIME_ROOT = resolve(process.env.XIAOZHI_AUTODL_RUNTIME || '/root/autodl-tmp/xiaozhi-autodl')
export const SUPERVISOR_CONFIG = resolve(PROJECT_ROOT, 'config/supervisor/supervisord.conf')
export const STATIC_ROOT = resolve(PROJECT_ROOT, 'dashboard/dist/public')
export const MANAGER_WEB_PUBLIC_URL = (
  process.env.MANAGER_WEB_PUBLIC_URL
  || process.env.AutoDLService6008URL
  || ''
).replace(/\/$/, '')

export type ServiceName = 'web-gateway' | 'mysql' | 'redis' | 'manager-api' | 'index-tts' | 'xiaozhi-server'
export type ServiceAction = 'start' | 'stop' | 'restart'

export const SERVICES: Record<ServiceName, {
  label: string
  port: number
  supervisor: boolean
  health?: string
  log: string
}> = {
  'web-gateway': {
    label: 'Web Gateway', port: 6008, supervisor: true,
    health: 'http://127.0.0.1:6008/', log: resolve(RUNTIME_ROOT, 'logs/web-gateway.log'),
  },
  mysql: {
    label: 'MySQL', port: 3306, supervisor: false,
    log: resolve(RUNTIME_ROOT, 'logs/mysql/error.log'),
  },
  redis: {
    label: 'Redis', port: 6379, supervisor: false,
    log: resolve(RUNTIME_ROOT, 'logs/redis/redis-server.log'),
  },
  'manager-api': {
    label: 'Manager API', port: 8002, supervisor: true,
    health: 'http://127.0.0.1:8002/xiaozhi/user/pub-config', log: resolve(RUNTIME_ROOT, 'logs/manager-api.log'),
  },
  'index-tts': {
    label: 'IndexTTS 2.5', port: 8092, supervisor: true,
    health: 'http://127.0.0.1:8092/health/ready', log: resolve(RUNTIME_ROOT, 'logs/index-tts.log'),
  },
  'xiaozhi-server': {
    label: '小智服务端', port: 8000, supervisor: true,
    log: resolve(RUNTIME_ROOT, 'logs/xiaozhi-server.log'),
  },
}

export function isServiceName(value: string): value is ServiceName {
  return Object.prototype.hasOwnProperty.call(SERVICES, value)
}

export function isServiceAction(value: string): value is ServiceAction {
  return value === 'start' || value === 'stop' || value === 'restart'
}
