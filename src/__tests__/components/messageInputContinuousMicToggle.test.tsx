import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

import { MessageInput } from '@/components/messageInput'

let mockSpeechRecognitionMode = 'browser'
let mockRealtimeAPIMode = false

type MockIconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  'data-testid'?: string
  label?: string
}

jest.mock('@/features/stores/home', () => ({
  __esModule: true,
  default: jest.fn((selector) =>
    selector({
      chatProcessing: false,
      modalImage: '',
    })
  ),
}))

jest.mock('@/features/stores/settings', () => ({
  __esModule: true,
  default: jest.fn((selector) =>
    selector({
      selectAIService: 'openai',
      selectAIModel: 'gpt-4o',
      imageDisplayPosition: 'input',
      enableMultiModal: false,
      customModel: '',
      realtimeAPIMode: mockRealtimeAPIMode,
      showSilenceProgressBar: false,
      speechRecognitionMode: mockSpeechRecognitionMode,
    })
  ),
}))

jest.mock('@/features/stores/slide', () => ({
  __esModule: true,
  default: jest.fn((selector) => selector({ isPlaying: false })),
}))

jest.mock('@/hooks/useKioskMode', () => ({
  useKioskMode: () => ({
    isKioskMode: false,
    validateInput: () => ({ valid: true }),
    maxInputLength: undefined,
  }),
}))

jest.mock('@/components/iconButton', () => ({
  IconButton: (props: MockIconButtonProps) => (
    <button
      className={props.className}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props['data-testid']}
      aria-pressed={props['aria-pressed']}
      title={props.title}
    >
      {props.label}
    </button>
  ),
}))

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={props.alt ?? ''} {...props} />
  ),
}))

const defaultProps = {
  userMessage: '',
  isMicRecording: false,
  onChangeUserMessage: jest.fn(),
  onClickSendButton: jest.fn(),
  onClickMicButton: jest.fn(),
  onClickStopButton: jest.fn(),
  isSpeaking: false,
  silenceTimeoutRemaining: null,
  continuousMicListeningMode: false,
  onToggleContinuousMode: jest.fn(),
}

describe('MessageInput 常時マイク入力トグルバッジ', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSpeechRecognitionMode = 'browser'
    mockRealtimeAPIMode = false
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({
        matches: true,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    })
  })

  it('ブラウザ音声認識モードではバッジを表示し、OFF状態を示す', () => {
    render(<MessageInput {...defaultProps} />)

    const badge = screen.getByTestId('continuous-mic-toggle-button')
    expect(badge).toBeInTheDocument()
    expect(badge).toHaveTextContent('OFF')
    expect(badge).toHaveAttribute('aria-pressed', 'false')
    expect(badge).toHaveAttribute('title', 'ContinuousMicModeOff')
  })

  it('常時マイク入力モードONの状態を表示する', () => {
    render(<MessageInput {...defaultProps} continuousMicListeningMode={true} />)

    const badge = screen.getByTestId('continuous-mic-toggle-button')
    expect(badge).toHaveTextContent('ON')
    expect(badge).toHaveAttribute('aria-pressed', 'true')
    expect(badge).toHaveAttribute('title', 'ContinuousMicModeOn')
  })

  it('クリックで onToggleContinuousMode を呼び出す', () => {
    const onToggleContinuousMode = jest.fn()
    render(
      <MessageInput
        {...defaultProps}
        onToggleContinuousMode={onToggleContinuousMode}
      />
    )

    fireEvent.click(screen.getByTestId('continuous-mic-toggle-button'))
    expect(onToggleContinuousMode).toHaveBeenCalledTimes(1)
  })

  it('Whisperモードではバッジを表示しない', () => {
    mockSpeechRecognitionMode = 'whisper'
    render(<MessageInput {...defaultProps} />)

    expect(
      screen.queryByTestId('continuous-mic-toggle-button')
    ).not.toBeInTheDocument()
  })

  it('リアルタイムAPIモードではバッジを表示しない', () => {
    mockRealtimeAPIMode = true
    render(<MessageInput {...defaultProps} />)

    expect(
      screen.queryByTestId('continuous-mic-toggle-button')
    ).not.toBeInTheDocument()
  })
})
