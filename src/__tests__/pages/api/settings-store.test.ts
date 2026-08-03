/**
 * /api/settings-store のテスト
 * フラグOFF404、制限モード403、GET/POST仕様、バリデーション、
 * 並行POSTの直列化、書き込み失敗後のキュー復旧を検証する
 */
import { createMocks } from 'node-mocks-http'
import { NextApiRequest, NextApiResponse } from 'next'
import { SETTINGS_SYNC_EXCLUDED_KEYS } from '@/features/settingsSync/constants'

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
}))

import fs from 'fs'
import handler from '@/pages/api/settings-store'

const mockFs = fs as jest.Mocked<typeof fs>

const ORIGINAL_ENV = process.env

const postSettings = async (body: Record<string, unknown>) => {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
    method: 'POST',
    body,
  })
  await handler(req, res)
  return res
}

describe('/api/settings-store', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...ORIGINAL_ENV }
    process.env.NEXT_PUBLIC_SETTINGS_SERVER_SYNC = 'true'
    delete process.env.NEXT_PUBLIC_RESTRICTED_MODE
    delete process.env.NEXT_PUBLIC_ALWAYS_OVERRIDE_WITH_ENV_VARIABLES
    mockFs.existsSync.mockReturnValue(true)
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  describe('ガード', () => {
    it('フラグOFF時は404を返す', async () => {
      process.env.NEXT_PUBLIC_SETTINGS_SERVER_SYNC = 'false'
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'GET',
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(404)
    })

    it('env常時上書き運用(ALWAYS_OVERRIDE)時はクライアント同様404を返す', async () => {
      process.env.NEXT_PUBLIC_ALWAYS_OVERRIDE_WITH_ENV_VARIABLES = 'true'
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'GET',
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(404)
    })

    it('制限モード時はwithAccessPolicyが403を返す', async () => {
      process.env.NEXT_PUBLIC_RESTRICTED_MODE = 'true'
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'GET',
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(403)
    })

    it('DELETEメソッドは405を返す', async () => {
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'DELETE',
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(405)
    })
  })

  describe('GET', () => {
    it('ファイルが無ければ data: null を返す', async () => {
      mockFs.existsSync.mockReturnValue(false)
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'GET',
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual({ data: null })
    })

    it('正常なファイルはエンベロープを返し、混入シークレットは除去される', async () => {
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          state: { characterName: 'ニケちゃん', openaiKey: 'sk-leaked' },
          version: 8,
        })
      )
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'GET',
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      const body = JSON.parse(res._getData())
      expect(body.data.version).toBe(8)
      expect(body.data.state.characterName).toBe('ニケちゃん')
      expect(body.data.state).not.toHaveProperty('openaiKey')
    })

    it('壊れたJSONは data: null を返す(起動を阻害しない)', async () => {
      mockFs.readFileSync.mockReturnValue('{broken json')
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'GET',
      })

      await handler(req, res)

      expect(res._getStatusCode()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual({ data: null })
    })

    it('エンベロープ形式でないファイルは data: null を返す', async () => {
      mockFs.readFileSync.mockReturnValue(JSON.stringify([1, 2, 3]))
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'GET',
      })

      await handler(req, res)

      expect(JSON.parse(res._getData())).toEqual({ data: null })
    })

    it('負のversionを持つファイルは data: null を返す(POSTと同一の無効判定)', async () => {
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({ state: { characterName: 'A' }, version: -1 })
      )
      const { req, res } = createMocks<NextApiRequest, NextApiResponse>({
        method: 'GET',
      })

      await handler(req, res)

      expect(JSON.parse(res._getData())).toEqual({ data: null })
    })
  })

  describe('POST', () => {
    it('正常なエンベロープをtmpファイル+renameでアトミックに書き込む', async () => {
      const res = await postSettings({
        state: { characterName: 'ニケちゃん' },
        version: 8,
      })

      expect(res._getStatusCode()).toBe(200)
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1)
      expect(mockFs.renameSync).toHaveBeenCalledTimes(1)

      const tmpPath = mockFs.writeFileSync.mock.calls[0][0] as string
      const [renameFrom, renameTo] = mockFs.renameSync.mock.calls[0] as [
        string,
        string,
      ]
      expect(tmpPath).toMatch(/settings\.json\.\d+\..+\.tmp$/)
      expect(renameFrom).toBe(tmpPath)
      expect(renameTo).toMatch(/settings\.json$/)

      const written = JSON.parse(
        mockFs.writeFileSync.mock.calls[0][1] as string
      )
      expect(written).toEqual({
        state: { characterName: 'ニケちゃん' },
        version: 8,
      })
    })

    it('シークレット混入bodyはstripされて書き込まれる', async () => {
      const state: Record<string, unknown> = { characterName: 'ニケちゃん' }
      for (const key of SETTINGS_SYNC_EXCLUDED_KEYS) {
        state[key] = 'secret-value'
      }
      const res = await postSettings({ state, version: 8 })

      expect(res._getStatusCode()).toBe(200)
      const written = JSON.parse(
        mockFs.writeFileSync.mock.calls[0][1] as string
      )
      for (const key of SETTINGS_SYNC_EXCLUDED_KEYS) {
        expect(written.state).not.toHaveProperty(key)
      }
      expect(written.state.characterName).toBe('ニケちゃん')
    })

    it('stateが配列なら400を返す', async () => {
      const res = await postSettings({ state: [1, 2], version: 8 })
      expect(res._getStatusCode()).toBe(400)
    })

    it('versionが欠落・非整数なら400を返す', async () => {
      expect((await postSettings({ state: { a: 1 } }))._getStatusCode()).toBe(
        400
      )
      expect(
        (await postSettings({ state: { a: 1 }, version: 1.5 }))._getStatusCode()
      ).toBe(400)
      expect(
        (await postSettings({ state: { a: 1 }, version: -1 }))._getStatusCode()
      ).toBe(400)
    })

    it('1MB超のpayloadは413を返す', async () => {
      const res = await postSettings({
        state: { big: 'x'.repeat(1024 * 1024) },
        version: 8,
      })

      expect(res._getStatusCode()).toBe(413)
      expect(mockFs.writeFileSync).not.toHaveBeenCalled()
    })

    it('並行POSTは両方成功し、tmp名が衝突しない', async () => {
      const [resA, resB] = await Promise.all([
        postSettings({ state: { characterName: 'A' }, version: 8 }),
        postSettings({ state: { characterName: 'B' }, version: 8 }),
      ])

      expect(resA._getStatusCode()).toBe(200)
      expect(resB._getStatusCode()).toBe(200)
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2)
      expect(mockFs.renameSync).toHaveBeenCalledTimes(2)

      const tmpA = mockFs.writeFileSync.mock.calls[0][0]
      const tmpB = mockFs.writeFileSync.mock.calls[1][0]
      expect(tmpA).not.toBe(tmpB)
    })

    it('書き込み失敗時は当該POSTが500+tmp削除、続くPOSTは成功する(キューが死なない)', async () => {
      mockFs.writeFileSync.mockImplementationOnce(() => {
        throw new Error('disk full')
      })

      const failed = await postSettings({
        state: { characterName: 'A' },
        version: 8,
      })
      expect(failed._getStatusCode()).toBe(500)
      expect(mockFs.unlinkSync).toHaveBeenCalledTimes(1)

      const succeeded = await postSettings({
        state: { characterName: 'B' },
        version: 8,
      })
      expect(succeeded._getStatusCode()).toBe(200)
      expect(mockFs.renameSync).toHaveBeenCalledTimes(1)
    })

    it('rename失敗時もtmpをbest-effort削除して500を返す', async () => {
      mockFs.renameSync.mockImplementationOnce(() => {
        throw new Error('rename failed')
      })

      const res = await postSettings({
        state: { characterName: 'A' },
        version: 8,
      })

      expect(res._getStatusCode()).toBe(500)
      expect(mockFs.unlinkSync).toHaveBeenCalledTimes(1)
      const tmpPath = mockFs.writeFileSync.mock.calls[0][0]
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(tmpPath)
    })
  })
})
