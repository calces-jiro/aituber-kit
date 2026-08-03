import type { SettingsState } from '@/features/stores/settings'

export const SETTINGS_SYNC_ENDPOINT = '/api/settings-store'
export const SETTINGS_SYNC_DEBOUNCE_MS = 1000
export const SETTINGS_SYNC_PULL_TIMEOUT_MS = 3000
export const SETTINGS_STORAGE_KEY = 'aitube-kit-settings'

// サーバー保存JSONから除外するシークレットキー。
// APIキーは .env のサーバー側変数(OPENAI_API_KEY等)で運用し、平文で
// サーバーファイルに残さない。customApiHeaders/customApiBody は
// 認証ヘッダー・トークンを含み得るため同様に除外する。
// `satisfies` により存在しないキー名・廃止キーの残骸はコンパイルエラーになる。
export const SETTINGS_SYNC_EXCLUDED_KEYS = [
  'openaiKey',
  'anthropicKey',
  'googleKey',
  'azureKey',
  'xaiKey',
  'groqKey',
  'cohereKey',
  'mistralaiKey',
  'perplexityKey',
  'fireworksKey',
  'difyKey',
  'deepseekKey',
  'openrouterKey',
  'lmstudioKey',
  'ollamaKey',
  'koeiromapKey',
  'youtubeApiKey',
  'elevenlabsApiKey',
  'cartesiaApiKey',
  'azureTTSKey',
  'stylebertvits2ApiKey',
  'aivisCloudApiKey',
  'customApiHeaders',
  'customApiBody',
] as const satisfies ReadonlyArray<keyof SettingsState>

// 常時envで上書きする運用や制限モード(FS書き込み不可)とは併用できないため、
// その場合はsync全体を無効化して従来のlocalStorage動作に落とす
export function isSettingsServerSyncEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_SETTINGS_SERVER_SYNC === 'true' &&
    process.env.NEXT_PUBLIC_RESTRICTED_MODE !== 'true' &&
    process.env.NEXT_PUBLIC_ALWAYS_OVERRIDE_WITH_ENV_VARIABLES !== 'true'
  )
}
