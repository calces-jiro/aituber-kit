import { logger } from '@/lib/logger'
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_SYNC_ENDPOINT,
  SETTINGS_SYNC_EXCLUDED_KEYS,
  SETTINGS_SYNC_PULL_TIMEOUT_MS,
  isSettingsServerSyncEnabled,
} from './constants'
import {
  canonicalizeEnvelope,
  getHasLocalWrite,
  markServerCanonical,
  schedulePush,
  stripSecretsFromSerialized,
} from './settingsSyncStorage'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 起動時にサーバー保存済みの設定を取得してストアへ反映する。
// 失敗時は何もしない(localStorageの内容がそのまま使われる)
export async function pullServerSettings(): Promise<void> {
  if (typeof window === 'undefined' || !isSettingsServerSyncEnabled()) {
    return
  }

  let body: { data?: unknown }
  try {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      SETTINGS_SYNC_PULL_TIMEOUT_MS
    )
    const res = await fetch(SETTINGS_SYNC_ENDPOINT, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      logger.log(`settings sync pull skipped: HTTP ${res.status}`)
      return
    }
    body = await res.json()
  } catch (error) {
    logger.log('settings sync pull skipped (fetch failed)', error)
    return
  }

  // 循環importを避けるため settings.ts はdynamic importで読む
  const settingsModule = await import('@/features/stores/settings')
  const settingsStore = settingsModule.default
  const { runSettingsMigrations, CURRENT_SETTINGS_VERSION } = settingsModule

  if (body?.data == null) {
    // サーバー未初期化: ローカル内容でseedする。
    // ユーザー変更が既に発生している場合は保留中のpushが同役割を果たすためスキップ
    // (seedが新しいpushを追い越して古い内容で上書きする順序逆転を防ぐ)
    if (getHasLocalWrite()) {
      return
    }
    const local = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!local) {
      return
    }
    const stripped = stripSecretsFromSerialized(local)
    if (stripped) {
      // 通常pushと同じデバウンスチャネル経由で送信し、順序を単一化する
      schedulePush(stripped)
    }
    return
  }

  const data = body.data
  if (!isPlainObject(data) || !isPlainObject(data.state)) {
    logger.warn('settings sync pull skipped: invalid envelope')
    return
  }
  const version = data.version
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    logger.warn('settings sync pull skipped: invalid version')
    return
  }
  if (version > CURRENT_SETTINGS_VERSION) {
    // 新しいビルドが書いたファイル。旧ビルドでは解釈できないため適用しない
    logger.warn(
      `settings sync pull skipped: server version ${version} is newer than ${CURRENT_SETTINGS_VERSION}`
    )
    return
  }

  const migrated =
    version < CURRENT_SETTINGS_VERSION
      ? runSettingsMigrations(
          data.state as Parameters<typeof runSettingsMigrations>[0],
          version
        )
      : (data.state as Record<string, unknown>)

  // 正常時サーバーに存在しないはずだが、防御としてクライアント側でも除去する
  const applied: Record<string, unknown> = { ...migrated }
  for (const key of SETTINGS_SYNC_EXCLUDED_KEYS) {
    delete applied[key]
  }

  // pull解決前にユーザーが設定を変更済みならローカルが勝つ(pushで伝播する)
  if (getHasLocalWrite()) {
    return
  }

  // 適用によるpersist書き戻し(setItem)をサーバーへエコーさせない
  markServerCanonical(canonicalizeEnvelope(applied, CURRENT_SETTINGS_VERSION))
  // setStateはexclusivityMiddlewareを通るため排他ルール補正が効く
  settingsStore.setState(applied)
}
