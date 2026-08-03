/**
 * pullServerSettings のテスト
 * seed、マイグレーション適用、新しすぎるversionのスキップ、
 * fetch失敗フォールバック、pull前ローカル変更ガードを検証する
 */

const mockSetState = jest.fn()
const mockRunSettingsMigrations = jest.fn()

jest.mock('@/features/stores/settings', () => ({
  __esModule: true,
  default: { setState: mockSetState },
  CURRENT_SETTINGS_VERSION: 8,
  runSettingsMigrations: mockRunSettingsMigrations,
}))

import { pullServerSettings } from '@/features/settingsSync/pullServerSettings'
import {
  settingsSyncStorage,
  __resetSettingsSyncForTest,
} from '@/features/settingsSync/settingsSyncStorage'
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_SYNC_DEBOUNCE_MS,
} from '@/features/settingsSync/constants'

const ORIGINAL_ENV = process.env

const serverResponse = (data: unknown) => ({
  ok: true,
  json: async () => ({ data }),
})

describe('pullServerSettings', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    process.env = { ...ORIGINAL_ENV }
    process.env.NEXT_PUBLIC_SETTINGS_SERVER_SYNC = 'true'
    delete process.env.NEXT_PUBLIC_RESTRICTED_MODE
    delete process.env.NEXT_PUBLIC_ALWAYS_OVERRIDE_WITH_ENV_VARIABLES
    window.localStorage.clear()
    mockSetState.mockClear()
    mockRunSettingsMigrations.mockClear()
    mockRunSettingsMigrations.mockImplementation((state) => ({
      ...state,
      migrated: true,
    }))
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    __resetSettingsSyncForTest()
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = ORIGINAL_ENV
    __resetSettingsSyncForTest()
  })

  it('最新versionのサーバー状態はそのままsetStateへ適用される', async () => {
    fetchMock.mockResolvedValue(
      serverResponse({ state: { characterName: 'サーバー側' }, version: 8 })
    )

    await pullServerSettings()

    expect(mockRunSettingsMigrations).not.toHaveBeenCalled()
    expect(mockSetState).toHaveBeenCalledTimes(1)
    expect(mockSetState).toHaveBeenCalledWith({ characterName: 'サーバー側' })
  })

  it('旧versionの状態はrunSettingsMigrations経由で適用される', async () => {
    fetchMock.mockResolvedValue(
      serverResponse({ state: { characterName: '旧' }, version: 3 })
    )

    await pullServerSettings()

    expect(mockRunSettingsMigrations).toHaveBeenCalledWith(
      { characterName: '旧' },
      3
    )
    expect(mockSetState).toHaveBeenCalledWith({
      characterName: '旧',
      migrated: true,
    })
  })

  it('サーバーversionが現行より新しい場合は適用しない', async () => {
    fetchMock.mockResolvedValue(
      serverResponse({ state: { characterName: '未来' }, version: 99 })
    )

    await pullServerSettings()

    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('サーバーレスポンスにシークレットが混入していてもsetStateへ渡さない', async () => {
    fetchMock.mockResolvedValue(
      serverResponse({
        state: {
          characterName: 'サーバー側',
          openaiKey: 'sk-leaked',
          customApiHeaders: '{"Authorization":"Bearer x"}',
        },
        version: 8,
      })
    )

    await pullServerSettings()

    expect(mockSetState).toHaveBeenCalledWith({ characterName: 'サーバー側' })
  })

  it('fetch失敗時はsetStateを呼ばない(localStorageフォールバック)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    await pullServerSettings()

    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('非200応答でもsetStateを呼ばない', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })

    await pullServerSettings()

    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('不正なエンベロープは適用しない', async () => {
    fetchMock.mockResolvedValue(serverResponse({ state: [1, 2], version: 8 }))

    await pullServerSettings()

    expect(mockSetState).not.toHaveBeenCalled()
  })

  it('pull解決前にローカル変更があった場合は適用しない(ローカルが勝つ)', async () => {
    fetchMock.mockResolvedValue(
      serverResponse({ state: { characterName: 'サーバー側' }, version: 8 })
    )

    // pull解決前にユーザー変更が発生
    settingsSyncStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ state: { characterName: 'ローカル側' }, version: 8 })
    )

    await pullServerSettings()

    expect(mockSetState).not.toHaveBeenCalled()
  })

  describe('seed(サーバー未初期化)', () => {
    it('ローカル内容がstripされてpushチャネル(デバウンス)経由でPOSTされる', async () => {
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          state: { characterName: 'ローカル', openaiKey: 'sk-secret' },
          version: 8,
        })
      )
      fetchMock.mockResolvedValue(serverResponse(null))

      await pullServerSettings()

      // pull(GET)の1回のみ。POSTはまだデバウンス待ち
      expect(fetchMock).toHaveBeenCalledTimes(1)

      fetchMock.mockResolvedValue({ ok: true })
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS)
      await Promise.resolve()
      await Promise.resolve()

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [, init] = fetchMock.mock.calls[1]
      expect(init.method).toBe('POST')
      const sent = JSON.parse(init.body)
      expect(sent.state.characterName).toBe('ローカル')
      expect(sent.state).not.toHaveProperty('openaiKey')
      expect(mockSetState).not.toHaveBeenCalled()
    })

    it('ローカル変更が既にある場合はseedしない(保留中pushに委ねる)', async () => {
      settingsSyncStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({ state: { characterName: '変更済み' }, version: 8 })
      )
      const callsBeforePull = fetchMock.mock.calls.length
      fetchMock.mockResolvedValue(serverResponse(null))

      await pullServerSettings()

      // pull(GET)以外の追加POSTスケジュールが発生していないことを、
      // タイマー満了後のPOST内容が「保留中push由来のみ」であることで確認
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS)
      await Promise.resolve()
      await Promise.resolve()

      const postCalls = fetchMock.mock.calls
        .slice(callsBeforePull)
        .filter(([, init]) => init?.method === 'POST')
      expect(postCalls).toHaveLength(1)
      const sent = JSON.parse(postCalls[0][1].body)
      expect(sent.state.characterName).toBe('変更済み')
    })

    it('ローカルにも保存が無ければ何もしない', async () => {
      fetchMock.mockResolvedValue(serverResponse(null))

      await pullServerSettings()
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS)
      await Promise.resolve()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(mockSetState).not.toHaveBeenCalled()
    })
  })

  it('フラグOFF時は何もしない', async () => {
    process.env.NEXT_PUBLIC_SETTINGS_SERVER_SYNC = 'false'

    await pullServerSettings()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockSetState).not.toHaveBeenCalled()
  })
})
