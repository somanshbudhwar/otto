/// <reference types="vite/client" />
import type { OttoApi } from '../../preload/index'

declare global {
  interface Window {
    otto: OttoApi
  }
}

export {}
