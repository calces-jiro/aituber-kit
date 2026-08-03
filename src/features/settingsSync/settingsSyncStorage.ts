import type { StateStorage } from 'zustand/middleware'
import { logger } from '@/lib/logger'
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_SYNC_DEBOUNCE_MS,
  SETTINGS_SYNC_ENDPOINT,
  SETTINGS_SYNC_EXCLUDED_KEYS,
  isSettingsServerSyncEnabled,
} from './constants'

// サーバーへ送る保留payloadと、その正規化表現(エコー抑止用)のペア
type PendingPush = {
  payload: string
  canonical: string
}

let pendingPush: PendingPush | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null
let flushListenersRegistered = false
// 最後にサーバーと同期した内容の正規化表現。pull適用後のpersist書き戻しや
// 無変化のsetItemをサーバーへ再送しないための比較基準
let lastServerCanonical: string | null = null
// このセッションでユーザー起点の設定変更が発生したか。
// pull/seedがローカルの新しい変更を古いサーバー内容で追い越さないためのガード
let hasLocalWrite = false
let pullStarted = false

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// トップレベルのキー順に依存しない正規化表現。
// partialize出力とサーバー由来オブジェクトでキー順が異なっても同一内容なら一致する
export function canonicalizeEnvelope(
  state: Record<string, unknown>,
  version: number
): string {
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(state).sort()) {
    sorted[key] = state[key]
  }
  return JSON.stringify({ state: sorted, version })
}

// persistが書き込むシリアライズ済みエンベロープからシークレットを除去し、
// サーバー送信用payloadと正規化表現を返す。形式不正ならnull(送信スキップ)
export function stripSecretsFromSerialized(
  serialized: string
): PendingPush | null {
  try {
    const parsed = JSON.parse(serialized)
    if (!isPlainObject(parsed) || !isPlainObject(parsed.state)) {
      return null
    }
    const state = { ...parsed.state }
    for (const key of SETTINGS_SYNC_EXCLUDED_KEYS) {
      delete state[key]
    }
    const version = typeof parsed.version === 'number' ? parsed.version : 0
    return {
      payload: JSON.stringify({ state, version }),
      canonical: canonicalizeEnvelope(state, version),
    }
  } catch {
    return null
  }
}

export function getHasLocalWrite(): boolean {
  return hasLocalWrite
}

// pull適用時に呼び、適用内容がpersist経由でsetItemに戻ってきても再送しないようにする
export function markServerCanonical(canonical: string): void {
  lastServerCanonical = canonical
}

async function pushPending(): Promise<void> {
  const pending = pendingPush
  if (pending === null) {
    return
  }
  pendingPush = null

  try {
    const res = await fetch(SETTINGS_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: pending.payload,
    })
    if (res.ok) {
      lastServerCanonical = pending.canonical
    } else {
      logger.warn(`settings sync push failed: HTTP ${res.status}`)
    }
  } catch (error) {
    // リトライしない。localStorageには保存済みで、次の設定変更時に再送される
    logger.warn('settings sync push failed', error)
  }
}

export function schedulePush(pending: PendingPush): void {
  pendingPush = pending
  if (typeof window === 'undefined') {
    return
  }
  registerFlushListeners()
  if (pushTimer) {
    clearTimeout(pushTimer)
  }
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushPending()
  }, SETTINGS_SYNC_DEBOUNCE_MS)
}

// ページ離脱時のflush。pendingクリアにより pagehide → beforeunload の
// 連続発火でも送信は1回だけになる
function flushPendingPush(): void {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  const pending = pendingPush
  if (pending === null) {
    return
  }
  pendingPush = null

  const blob = new Blob([pending.payload], { type: 'application/json' })
  const sentByBeacon =
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon(SETTINGS_SYNC_ENDPOINT, blob)

  if (sentByBeacon) {
    lastServerCanonical = pending.canonical
    return
  }

  void fetch(SETTINGS_SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: pending.payload,
    keepalive: true,
  })
    .then((res) => {
      if (res.ok) {
        lastServerCanonical = pending.canonical
      }
    })
    .catch(() => {
      // 離脱時のbest-effort送信のため失敗は握りつぶす
    })
}

function registerFlushListeners(): void {
  if (typeof window === 'undefined' || flushListenersRegistered) {
    return
  }
  window.addEventListener('pagehide', flushPendingPush)
  window.addEventListener('beforeunload', flushPendingPush)
  flushListenersRegistered = true
}

export const settingsSyncStorage: StateStorage = {
  getItem: (name) => {
    if (typeof window === 'undefined') {
      return null
    }
    const value = window.localStorage.getItem(name)

    if (
      name === SETTINGS_STORAGE_KEY &&
      isSettingsServerSyncEnabled() &&
      !pullStarted
    ) {
      pullStarted = true
      // rehydrateをブロックしない(ローカル値で同期的に描画し、サーバー差分は後追い反映)。
      // 静的な循環importを避けるためdynamic importで呼び出す
      void import('./pullServerSettings').then((m) =>
        m.pullServerSettings().catch((error) => {
          logger.warn('settings sync pull failed', error)
        })
      )
    }

    return value
  },
  setItem: (name, value) => {
    if (typeof window === 'undefined') {
      return
    }
    // localStorageへは従来どおり即時書き込み(フラグOFF時と同一動作)
    window.localStorage.setItem(name, value)

    if (name !== SETTINGS_STORAGE_KEY || !isSettingsServerSyncEnabled()) {
      return
    }

    hasLocalWrite = true
    const stripped = stripSecretsFromSerialized(value)
    if (stripped === null || stripped.canonical === lastServerCanonical) {
      return
    }
    schedulePush(stripped)
  },
  removeItem: (name) => {
    if (typeof window === 'undefined') {
      return
    }
    if (name === SETTINGS_STORAGE_KEY) {
      pendingPush = null
      if (pushTimer) {
        clearTimeout(pushTimer)
        pushTimer = null
      }
    }
    // サーバー側は消さない(persist.clearStorage用途のみ)
    window.localStorage.removeItem(name)
  },
}

// テスト専用: モジュールレベル状態のリセット
export function __resetSettingsSyncForTest(): void {
  pendingPush = null
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  if (flushListenersRegistered && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', flushPendingPush)
    window.removeEventListener('beforeunload', flushPendingPush)
  }
  flushListenersRegistered = false
  lastServerCanonical = null
  hasLocalWrite = false
  pullStarted = false
}
