const mockSettingsGetState = jest.fn()
jest.mock('../../../features/stores/settings', () => ({
  getState: (...args: unknown[]) => mockSettingsGetState(...args),
}))

jest.mock('../../../features/stores/home', () => ({
  getState: jest.fn(),
  setState: jest.fn(),
}))

jest.mock('../../../features/stores/toast', () => ({
  getState: () => ({
    addToast: jest.fn(),
  }),
}))

jest.mock('i18next', () => ({
  t: jest.fn((key: string) => key),
}))

const mockAddTask = jest.fn().mockResolvedValue(undefined)
const mockCheckSessionId = jest.fn()
const mockBeginSynthesis = jest.fn()
const mockEndSynthesis = jest.fn()
let mockStopToken = 0

jest.mock('../../../features/messages/speakQueue', () => ({
  SpeakQueue: class {
    static getInstance() {
      return {
        addTask: (...args: unknown[]) => mockAddTask(...args),
        checkSessionId: (...args: unknown[]) => mockCheckSessionId(...args),
      }
    }

    static get currentStopToken() {
      return mockStopToken
    }

    static beginSynthesis() {
      mockBeginSynthesis()
    }

    static endSynthesis() {
      mockEndSynthesis()
    }
  },
}))

jest.mock('../../../features/messages/live2dHandler', () => ({
  Live2DHandler: {},
}))

jest.mock('../../../features/pngTuber/pngTuberHandler', () => ({
  PNGTuberHandler: {},
}))

const mockWait = jest.fn().mockResolvedValue(undefined)
jest.mock('../../../utils/wait', () => ({
  wait: (...args: unknown[]) => mockWait(...args),
}))

jest.mock('../../../utils/textProcessing', () => ({
  containsEnglish: jest.fn(() => false),
  asyncConvertEnglishToJapaneseReading: jest.fn((text: string) =>
    Promise.resolve(text)
  ),
}))

const mockSynthesizeVoicevoxApi = jest.fn()
jest.mock('../../../features/messages/synthesizeVoiceVoicevox', () => ({
  synthesizeVoiceVoicevoxApi: (...args: unknown[]) =>
    mockSynthesizeVoicevoxApi(...args),
}))

const mockSynthesizeVoiceOpenAIStreamApi = jest.fn()
jest.mock('../../../features/messages/synthesizeVoiceOpenAI', () => ({
  synthesizeVoiceOpenAIApi: jest.fn(),
  synthesizeVoiceOpenAIStreamApi: (...args: unknown[]) =>
    mockSynthesizeVoiceOpenAIStreamApi(...args),
}))

jest.mock('../../../features/messages/characterRenderer', () => ({
  getCharacterRenderer: () => ({ speakPcm16Stream: jest.fn() }),
}))

import { speakCharacter } from '../../../features/messages/speakCharacter'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('speakCharacter concurrency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStopToken = 0
    mockSettingsGetState.mockReturnValue({
      audioMode: false,
      changeEnglishToJapanese: false,
      selectLanguage: 'ja',
      selectVoice: 'voicevox',
      voicevoxSpeaker: '1',
      voicevoxSpeed: 1,
      voicevoxPitch: 0,
      voicevoxIntonation: 1,
      voicevoxServerUrl: 'http://localhost:50021',
    })
  })

  it('keeps playback order even when later synthesis finishes first', async () => {
    const first = createDeferred<ArrayBuffer>()
    const second = createDeferred<ArrayBuffer>()

    mockSynthesizeVoicevoxApi
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    speakCharacter('session-1', { message: 'first', emotion: 'neutral' })
    speakCharacter('session-1', { message: 'second', emotion: 'neutral' })

    second.resolve(new ArrayBuffer(2))
    await flushPromises()

    expect(mockAddTask).not.toHaveBeenCalled()

    first.resolve(new ArrayBuffer(1))
    await flushPromises()

    expect(mockAddTask).toHaveBeenCalledTimes(2)
    expect(mockAddTask.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-1',
      talk: expect.objectContaining({ message: 'first' }),
    })
    expect(mockAddTask.mock.calls[1][0]).toMatchObject({
      sessionId: 'session-1',
      talk: expect.objectContaining({ message: 'second' }),
    })
  })

  it('drops old synthesis results after a session switch', async () => {
    const oldTask = createDeferred<ArrayBuffer>()
    const newTask = createDeferred<ArrayBuffer>()
    const oldComplete = jest.fn()
    const newComplete = jest.fn()

    mockSynthesizeVoicevoxApi
      .mockReturnValueOnce(oldTask.promise)
      .mockReturnValueOnce(newTask.promise)

    speakCharacter(
      'session-old',
      { message: 'old', emotion: 'neutral' },
      undefined,
      oldComplete
    )
    speakCharacter(
      'session-new',
      { message: 'new', emotion: 'neutral' },
      undefined,
      newComplete
    )

    oldTask.resolve(new ArrayBuffer(1))
    await flushPromises()

    expect(oldComplete).toHaveBeenCalledTimes(1)
    expect(mockAddTask).not.toHaveBeenCalled()

    newTask.resolve(new ArrayBuffer(1))
    await flushPromises()

    expect(mockAddTask).toHaveBeenCalledTimes(1)
    expect(mockAddTask.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-new',
      talk: expect.objectContaining({ message: 'new' }),
      onComplete: expect.any(Function),
    })
    expect(newComplete).not.toHaveBeenCalled()
  })

  it('cancels an old PCM16 stream after a session switch', async () => {
    const oldTask = createDeferred<{
      stream: ReadableStream<Uint8Array>
      sampleRate: 24000
    }>()
    const newTask = createDeferred<{
      stream: ReadableStream<Uint8Array>
      sampleRate: 24000
    }>()
    const cancel = jest.fn()
    const oldComplete = jest.fn()

    mockSettingsGetState.mockReturnValue({
      audioMode: false,
      changeEnglishToJapanese: false,
      selectLanguage: 'ja',
      selectVoice: 'openai',
      openaiKey: 'key',
      openaiTTSVoice: 'alloy',
      openaiTTSModel: 'tts-1',
      openaiTTSSpeed: 1,
    })
    mockSynthesizeVoiceOpenAIStreamApi
      .mockReturnValueOnce(oldTask.promise)
      .mockReturnValueOnce(newTask.promise)

    speakCharacter(
      'session-old-stream',
      { message: 'old', emotion: 'neutral' },
      undefined,
      oldComplete
    )
    speakCharacter('session-new-stream', {
      message: 'new',
      emotion: 'neutral',
    })

    oldTask.resolve({
      stream: new ReadableStream<Uint8Array>({ cancel }),
      sampleRate: 24000,
    })
    await flushPromises()
    await flushPromises()

    expect(cancel).toHaveBeenCalledWith('speech discarded')
    expect(oldComplete).toHaveBeenCalledTimes(1)

    newTask.resolve({
      stream: new ReadableStream<Uint8Array>(),
      sampleRate: 24000,
    })
    await flushPromises()
  })

  it('pairs beginSynthesis and endSynthesis 1:1 across success, failure, session switch, and stop', async () => {
    const ok = createDeferred<ArrayBuffer>()
    const fail = createDeferred<ArrayBuffer>()
    const oldSession = createDeferred<ArrayBuffer>()
    const newSession = createDeferred<ArrayBuffer>()

    mockSynthesizeVoicevoxApi
      .mockReturnValueOnce(ok.promise)
      .mockReturnValueOnce(fail.promise)
      .mockReturnValueOnce(oldSession.promise)
      .mockReturnValueOnce(newSession.promise)

    // 成功と失敗（TTSエラー）
    speakCharacter('session-1', { message: 'ok', emotion: 'neutral' })
    speakCharacter('session-1', { message: 'fail', emotion: 'neutral' })
    ok.resolve(new ArrayBuffer(1))
    fail.reject(new Error('tts failed'))
    await flushPromises()

    // セッション切替による破棄
    speakCharacter('session-2', { message: 'old', emotion: 'neutral' })
    speakCharacter('session-3', { message: 'new', emotion: 'neutral' })
    oldSession.resolve(new ArrayBuffer(1))
    newSession.resolve(new ArrayBuffer(1))
    await flushPromises()

    // 合成中の停止（stopToken変化でキャンセル）
    speakCharacter('session-3', { message: 'stopped', emotion: 'neutral' })
    mockStopToken += 1
    await flushPromises()
    await flushPromises()

    expect(mockBeginSynthesis).toHaveBeenCalledTimes(5)
    expect(mockEndSynthesis).toHaveBeenCalledTimes(5)
    // 成功した2件（ok, new）のみキューに投入される
    expect(mockAddTask).toHaveBeenCalledTimes(2)
  })
})
