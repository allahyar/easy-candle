import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  ImportDeleteResult,
  ImportDialogResult,
  ImportListResult,
  ImportLoadResult,
  ImportReadResult,
  ImportSaveParams,
  ImportSaveResult
} from '../shared/importTypes'
import type { KlinesFetchParams, KlinesFetchResult } from '../shared/klinesTypes'
import type {
  MtHistoryRequestParams,
  MtHistoryRequestResult,
  MtLiveEvent,
  MtServerState,
  MtStartResult
} from '../shared/mtBridgeTypes'
import type {
  UpdateAvailableInfo,
  UpdateDownloadedInfo,
  UpdateErrorInfo,
  UpdateProgressInfo
} from '../shared/updaterTypes'

interface EasyCandleApi {
  fetchKlines: (params: KlinesFetchParams) => Promise<KlinesFetchResult>
  getAppVersion: () => Promise<string>
  minimizeWindow: () => void
  toggleMaximizeWindow: () => void
  closeWindow: () => void
  isWindowMaximized: () => Promise<boolean>
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void
  openImportDialog: () => Promise<ImportDialogResult>
  readImportFile: (path: string) => Promise<ImportReadResult>
  saveImport: (params: ImportSaveParams) => Promise<ImportSaveResult>
  listImports: () => Promise<ImportListResult>
  loadImport: (id: string, timeframe?: string) => Promise<ImportLoadResult>
  deleteImport: (id: string) => Promise<ImportDeleteResult>
  checkForUpdates: () => Promise<{
    ok: boolean
    skipped?: boolean
    version?: string | null
    error?: string
  }>
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>
  installUpdate: () => Promise<{ ok: boolean; error?: string }>
  onUpdateAvailable: (callback: (info: UpdateAvailableInfo) => void) => () => void
  onUpdateProgress: (callback: (info: UpdateProgressInfo) => void) => () => void
  onUpdateDownloaded: (callback: (info: UpdateDownloadedInfo) => void) => () => void
  onUpdateError: (callback: (info: UpdateErrorInfo) => void) => () => void
  mtBridge: {
    getState: () => Promise<MtServerState>
    startServer: (port: number) => Promise<MtStartResult>
    stopServer: () => Promise<void>
    requestHistory: (params: MtHistoryRequestParams) => Promise<MtHistoryRequestResult>
    setLive: (clientId: string | undefined, live: boolean) => Promise<void>
    clearLogs: () => Promise<void>
    onState: (callback: (state: MtServerState) => void) => () => void
    onEvent: (callback: (event: MtLiveEvent) => void) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: EasyCandleApi
  }
}

export {}
