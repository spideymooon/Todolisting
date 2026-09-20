import type { TodoApi } from '@shared/api'

declare global {
  interface Window {
    api: TodoApi
  }
}

export {}
