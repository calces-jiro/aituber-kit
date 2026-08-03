/**
 * シークレット除外リストのドリフト検出
 *
 * 実際に永続化される全キー集合(partialize出力)を対象に、シークレットらしき
 * キーがすべて SETTINGS_SYNC_EXCLUDED_KEYS に含まれることを検証する。
 * grepでAPIKeys interfaceだけを見る方式では、別interfaceに定義された
 * キー(aivisCloudApiKey等)を見逃すため、実データで検査する。
 */
import settingsStore from '@/features/stores/settings'
import { SETTINGS_SYNC_EXCLUDED_KEYS } from '@/features/settingsSync/constants'

// キー名がシークレットとみなされるパターン
const SECRET_KEY_PATTERN = /(Key|ApiKey|Token|Secret|Password)$/
// パターンに一致しないが内容的にセンシティブなキー(明示列挙)
const EXPLICIT_SENSITIVE_KEYS = ['customApiHeaders', 'customApiBody']

describe('SETTINGS_SYNC_EXCLUDED_KEYS のドリフト検出', () => {
  const persistedKeys = Object.keys(
    settingsStore.persist.getOptions().partialize!(
      settingsStore.getState()
    ) as Record<string, unknown>
  )

  it('永続化対象のシークレットらしき全キーが除外リストに含まれる', () => {
    const secretLikeKeys = persistedKeys.filter(
      (key) =>
        SECRET_KEY_PATTERN.test(key) || EXPLICIT_SENSITIVE_KEYS.includes(key)
    )
    expect(secretLikeKeys.length).toBeGreaterThan(0)

    const missing = secretLikeKeys.filter(
      (key) => !(SETTINGS_SYNC_EXCLUDED_KEYS as readonly string[]).includes(key)
    )
    expect(missing).toEqual([])
  })

  it('除外リストの各キーはSettingsStateに実在する(将来防御のcartesiaApiKeyを除き永続化対象)', () => {
    const state = settingsStore.getState() as unknown as Record<string, unknown>
    const unknownKeys = SETTINGS_SYNC_EXCLUDED_KEYS.filter(
      (key) => !(key in state)
    )
    expect(unknownKeys).toEqual([])
  })
})
