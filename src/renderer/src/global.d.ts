import type { SpindleApi } from '../../shared/contracts'

declare global {
  interface Window {
    spindle: SpindleApi
  }
}
export {}
