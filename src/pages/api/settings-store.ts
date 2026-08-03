import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { NextApiRequest, NextApiResponse } from 'next'
import { logger } from '@/lib/logger'
import { withAccessPolicy } from '@/lib/accessPolicy/withAccessPolicy'
import { routePolicies } from '@/lib/accessPolicy/routePolicies'
import {
  SETTINGS_SYNC_EXCLUDED_KEYS,
  isSettingsServerSyncEnabled,
} from '@/features/settingsSync/constants'

const STORE_DIR = path.join(process.cwd(), 'settings-store')
const STORE_FILE = path.join(STORE_DIR, 'settings.json')
const MAX_PAYLOAD_BYTES = 1024 * 1024

// 複数端末からの同時POSTを直列化する書き込みキュー。
// then(run, run) で前ジョブの成否に関わらず次ジョブへ進め、
// キュー自体は常にresolve済みに保つ(reject状態で後続が全滅しないように)
let writeQueue: Promise<void> = Promise.resolve()

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

// クライアント実装バグ・手編集への防御としてサーバー側でもシークレットを除去する
function stripSecretKeys(state: Record<string, unknown>): void {
  for (const key of SETTINGS_SYNC_EXCLUDED_KEYS) {
    delete state[key]
  }
}

function writeAtomically(json: string): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true })
  }
  // リクエスト固有のtmp名にして同時書き込みでも衝突させない
  const tmpFile = path.join(
    STORE_DIR,
    `settings.json.${process.pid}.${randomUUID()}.tmp`
  )
  try {
    fs.writeFileSync(tmpFile, json)
    fs.renameSync(tmpFile, STORE_FILE)
  } catch (error) {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      // best-effort削除。失敗しても本処理のエラーを優先する
    }
    throw error
  }
}

function handleGet(res: NextApiResponse) {
  if (!fs.existsSync(STORE_FILE)) {
    return res.status(200).json({ data: null })
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'))
    if (!isPlainObject(parsed) || !isPlainObject(parsed.state)) {
      logger.error('settings-store: invalid envelope in stored file')
      return res.status(200).json({ data: null })
    }
    const version = parsed.version
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 0
    ) {
      logger.error('settings-store: invalid version in stored file')
      return res.status(200).json({ data: null })
    }
    stripSecretKeys(parsed.state)
    return res.status(200).json({ data: { state: parsed.state, version } })
  } catch (error) {
    // 壊れたファイルで起動不能にしない。次のPOSTがアトミック上書きで修復する
    logger.error('settings-store: failed to read stored settings', error)
    return res.status(200).json({ data: null })
  }
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const body = req.body as { state?: unknown; version?: unknown } | undefined
  const state = body?.state
  const version = body?.version

  if (!isPlainObject(state)) {
    return res.status(400).json({ error: 'invalid_state' })
  }
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0
  ) {
    return res.status(400).json({ error: 'invalid_version' })
  }

  stripSecretKeys(state)
  const json = JSON.stringify({ state, version })
  if (Buffer.byteLength(json, 'utf-8') > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({ error: 'payload_too_large' })
  }

  const run = () => writeAtomically(json)
  const result = writeQueue.then(run, run)
  writeQueue = result.then(
    () => undefined,
    () => undefined
  )

  try {
    await result
    return res.status(200).json({ ok: true })
  } catch (error) {
    logger.error('settings-store: failed to write settings', error)
    return res.status(500).json({ error: 'write_failed' })
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // クライアント側と同一の無効化条件を適用する(フラグOFF・env常時上書き運用時は
  // ルート自体が存在しない扱い。制限モードはwithAccessPolicyが先に403を返す)
  if (!isSettingsServerSyncEnabled()) {
    return res.status(404).json({ error: 'settings_server_sync_disabled' })
  }

  if (req.method === 'GET') {
    return handleGet(res)
  }
  return handlePost(req, res)
}

export default withAccessPolicy(routePolicies['/api/settings-store'], handler)
