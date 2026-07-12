import type { AppStatus } from '../../../shared/types'

export const STATUS_LABELS: Record<AppStatus, string> = {
  idle: 'Idle',
  scanning: 'Scanning',
  checking: 'Checking',
  downloading: 'Downloading'
}
