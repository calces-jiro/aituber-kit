/**
 * settingsSyncStorage のテスト
 * フラグOFF時の従来動作、push時のシークレット除去、デバウンス、
 * エコー抑止、flushの単一発火、sendBeaconの形式を検証する
 */
import {
  settingsSyncStorage,
  stripSecretsFromSerialized,
  canonicalizeEnvelope,
  markServerCanonical,
  __resetSettingsSyncForTest,
} from '@/features/settingsSync/settingsSyncStorage'
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_SYNC_DEBOUNCE_MS,
  SETTINGS_SYNC_ENDPOINT,
  SETTINGS_SYNC_EXCLUDED_KEYS,
} from '@/features/settingsSync/constants'

const ORIGINAL_ENV = process.env

const makeEnvelope = (state: Record<string, unknown>, version = 8): string =>
  JSON.stringify({ state, version })

const sampleState = {
  characterName: 'ニケちゃん',
  selectAIService: 'openai',
  openaiKey: 'sk-secret',
  anthropicKey: 'sk-ant-secret',
  customApiHeaders: '{"Authorization":"Bearer token"}',
  customApiBody: '{"auth":"secret"}',
}

describe('settingsSyncStorage', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    process.env = { ...ORIGINAL_ENV }
    delete process.env.NEXT_PUBLIC_RESTRICTED_MODE
    delete process.env.NEXT_PUBLIC_ALWAYS_OVERRIDE_WITH_ENV_VARIABLES
    window.localStorage.clear()
    fetchMock = jest.fn().mockResolvedValue({ ok: true })
    global.fetch = fetchMock as unknown as typeof fetch
    __resetSettingsSyncForTest()
  })

  afterEach(() => {
    jest.useRealTimers()
    process.env = ORIGINAL_ENV
    __resetSettingsSyncForTest()
  })

  const flushMicrotasks = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }

  describe('フラグOFF時', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_SETTINGS_SERVER_SYNC = 'false'
    })

    it('setItemはlocalStorageのみ書き込み、fetchを一切呼ばない', () => {
      const value = makeEnvelope(sampleState)
      settingsSyncStorage.setItem(SETTINGS_STORAGE_KEY, value)
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS * 2)

      expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(value)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('getItemは同期的にlocalStorageの値を返し、fetchを呼ばない', () => {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, 'stored-value')

      const result = settingsSyncStorage.getItem(SETTINGS_STORAGE_KEY)

      expect(result).toBe('stored-value')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('フラグON時', () => {
    beforeEach(() => {
      process.env.NEXT_PUBLIC_SETTINGS_SERVER_SYNC = 'true'
    })

    it('POSTボディに除外キーが含まれず、localStorageには全量が残る', async () => {
      const value = makeEnvelope(sampleState)
      settingsSyncStorage.setItem(SETTINGS_STORAGE_KEY, value)
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS)
      await flushMicrotasks()

      // localStorageはシークレット込みの全量
      expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(value)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(SETTINGS_SYNC_ENDPOINT)
      expect(init.method).toBe('POST')
      expect(init.headers['Content-Type']).toBe('application/json')
      const sent = JSON.parse(init.body)
      for (const key of SETTINGS_SYNC_EXCLUDED_KEYS) {
        expect(sent.state).not.toHaveProperty(key)
      }
      expect(sent.state.characterName).toBe('ニケちゃん')
      expect(sent.version).toBe(8)
    })

    it('連続setItemはデバウンスされ、最後の内容だけ1回POSTされる', async () => {
      settingsSyncStorage.setItem(
        SETTINGS_STORAGE_KEY,
        makeEnvelope({ characterName: 'A' })
      )
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS / 2)
      settingsSyncStorage.setItem(
        SETTINGS_STORAGE_KEY,
        makeEnvelope({ characterName: 'B' })
      )
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS)
      await flushMicrotasks()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const sent = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(sent.state.characterName).toBe('B')
    })

    it('サーバー由来と同一内容(キー順が違っても)はPOSTしない(エコー抑止)', () => {
      const state = { b: 2, a: 1 }
      markServerCanonical(canonicalizeEnvelope(state, 8))

      // キー順の異なる同一内容
      settingsSyncStorage.setItem(
        SETTINGS_STORAGE_KEY,
        makeEnvelope({ a: 1, b: 2 })
      )
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS * 2)

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('push成功後、同一内容の再setItemはPOSTされない', async () => {
      const value = makeEnvelope({ characterName: 'A' })
      settingsSyncStorage.setItem(SETTINGS_STORAGE_KEY, value)
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS)
      await flushMicrotasks()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      settingsSyncStorage.setItem(SETTINGS_STORAGE_KEY, value)
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS * 2)
      await flushMicrotasks()

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('不正JSONはPOSTをスキップし、localStorageには書き込まれる', () => {
      settingsSyncStorage.setItem(SETTINGS_STORAGE_KEY, 'not-json')
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS * 2)

      expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe('not-json')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('対象外キーのsetItemは同期処理を行わない', () => {
      settingsSyncStorage.setItem('other-key', makeEnvelope(sampleState))
      jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS * 2)

      expect(window.localStorage.getItem('other-key')).not.toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    describe('flush(ページ離脱時)', () => {
      it('pagehideでsendBeaconがapplication/jsonのBlobで1回呼ばれ、beforeunload連続発火でも二重送信しない', () => {
        const sendBeaconMock = jest.fn().mockReturnValue(true)
        Object.defineProperty(window.navigator, 'sendBeacon', {
          configurable: true,
          value: sendBeaconMock,
        })

        const value = makeEnvelope({ characterName: 'A' })
        settingsSyncStorage.setItem(SETTINGS_STORAGE_KEY, value)
        // デバウンス満了前に離脱
        window.dispatchEvent(new Event('pagehide'))
        window.dispatchEvent(new Event('beforeunload'))

        expect(sendBeaconMock).toHaveBeenCalledTimes(1)
        const [url, blob] = sendBeaconMock.mock.calls[0]
        expect(url).toBe(SETTINGS_SYNC_ENDPOINT)
        expect(blob).toBeInstanceOf(Blob)
        expect((blob as Blob).type).toBe('application/json')
        // jsdomのBlobはtext()未実装のため、サイズでstrip済みpayloadと一致を確認
        const expectedPayload = stripSecretsFromSerialized(value)!.payload
        expect((blob as Blob).size).toBe(
          Buffer.byteLength(expectedPayload, 'utf-8')
        )

        // flush後はデバウンスタイマー経路でもPOSTされない
        jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS * 2)
        expect(fetchMock).not.toHaveBeenCalled()

        // beacon成功でlastServerCanonicalが更新済み → 同一内容の再setItemは再送されない
        settingsSyncStorage.setItem(SETTINGS_STORAGE_KEY, value)
        jest.advanceTimersByTime(SETTINGS_SYNC_DEBOUNCE_MS * 2)
        expect(fetchMock).not.toHaveBeenCalled()
      })

      it('sendBeacon不可の場合はkeepalive付きfetchにフォールバックする', () => {
        Object.defineProperty(window.navigator, 'sendBeacon', {
          configurable: true,
          value: undefined,
        })

        settingsSyncStorage.setItem(
          SETTINGS_STORAGE_KEY,
          makeEnvelope({ characterName: 'A' })
        )
        window.dispatchEvent(new Event('pagehide'))

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [, init] = fetchMock.mock.calls[0]
        expect(init.keepalive).toBe(true)
        expect(init.method).toBe('POST')
      })
    })
  })

  describe('stripSecretsFromSerialized', () => {
    it('全除外キーを除去し、canonicalはキー順に依存しない', () => {
      const result = stripSecretsFromSerialized(makeEnvelope(sampleState))
      expect(result).not.toBeNull()
      const sent = JSON.parse(result!.payload)
      for (const key of SETTINGS_SYNC_EXCLUDED_KEYS) {
        expect(sent.state).not.toHaveProperty(key)
      }

      const reordered = stripSecretsFromSerialized(
        makeEnvelope({
          customApiBody: '{"auth":"secret"}',
          selectAIService: 'openai',
          openaiKey: 'sk-secret',
          characterName: 'ニケちゃん',
          anthropicKey: 'sk-ant-secret',
          customApiHeaders: '{"Authorization":"Bearer token"}',
        })
      )
      expect(reordered!.canonical).toBe(result!.canonical)
    })

    it('エンベロープ形式でなければnullを返す', () => {
      expect(stripSecretsFromSerialized('broken')).toBeNull()
      expect(stripSecretsFromSerialized(JSON.stringify([1, 2]))).toBeNull()
      expect(
        stripSecretsFromSerialized(JSON.stringify({ state: 'not-object' }))
      ).toBeNull()
    })
  })
})
