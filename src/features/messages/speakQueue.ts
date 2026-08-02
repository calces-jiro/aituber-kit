import { logger } from '@/lib/logger'
import { Talk } from './messages'
import homeStore from '@/features/stores/home'
import { getCharacterRenderer } from './characterRenderer'

type SpeakTaskBase = {
  sessionId: string
  talk: Talk
  onPlaybackStart?: () => void
  onComplete?: () => void
}

type SpeakTask = SpeakTaskBase &
  (
    | {
        kind?: 'buffer'
        audioBuffer: ArrayBuffer
        isNeedDecode: boolean
      }
    | {
        kind: 'pcm16-stream'
        audioStream: ReadableStream<Uint8Array>
        sampleRate: number
      }
  )

export class SpeakQueue {
  private static readonly QUEUE_CHECK_DELAY = 1500
  private queue: SpeakTask[] = []
  private isProcessing = false
  private currentSessionId: string | null = null
  // 進行中の完了チェック（scheduleNeutralExpression）の世代トークン。
  // キュー排水・合成終了・ストリーム終了から完了チェックが多重起動されても、
  // 最新の1本だけが判定を実行し、完了コールバックと表情リセットの
  // 二重実行を防ぐ。
  private neutralCheckToken = 0
  private static speakCompletionCallbacks: (() => void)[] = []
  private static _instance: SpeakQueue | null = null
  private stopped = false
  private static stopTokenCounter = 0
  // TTS合成中（キュー投入前）のセグメント数をセッションごとに保持する。
  // キューが空でも現行セッションの合成が残っている間は「発話完了」と判定させない。
  // 再生よりTTS合成が遅れてキューが一時的に空転すると、誤完了判定で isSpeaking が
  // false に落ち、常時マイク入力モードのマイクが句読点の継ぎ目でON/OFFする問題を防ぐ。
  // セッション単位なのは、停止済みセッションの遅い合成が残っていても
  // 新しい会話の完了判定を阻害しないようにするため。
  private static pendingSynthesisCounts = new Map<string, number>()
  // 直近の停止の対象範囲（'all' = 全体停止 / それ以外 = 対象セッションID）。
  // speechDispatcher が「他セッション向けの停止に巻き添えされない」判定に使う
  // 読み取り専用の付帯情報で、キュー自体の制御には使用しない。
  private static stopScope: 'all' | string = 'all'

  public static get currentStopToken() {
    return SpeakQueue.stopTokenCounter
  }

  public static get currentStopScope(): 'all' | string {
    return SpeakQueue.stopScope
  }

  /**
   * 現行セッションの合成中セグメント数。完了判定はこの値のみを見る
   * （旧セッションの遅い合成は新しい会話の完了を阻害しない）。
   */
  public static get currentPendingSynthesisCount(): number {
    const sessionId = SpeakQueue.getInstance().currentSessionId
    if (!sessionId) return 0
    return SpeakQueue.pendingSynthesisCounts.get(sessionId) ?? 0
  }

  /**
   * TTS合成の開始を通知します。endSynthesis と必ず対で呼ぶこと。
   */
  public static beginSynthesis(sessionId: string) {
    const counts = SpeakQueue.pendingSynthesisCounts
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1)
  }

  /**
   * TTS合成の終了（成功・失敗・破棄いずれも）を通知します。
   * 現行セッションの最後の合成が終わった時点でキューも空転していれば
   * 完了チェックを起動する。合成が全件失敗して addTask が一度も
   * 呼ばれないケースでも isSpeaking が固着しないようにするための救済経路。
   */
  public static endSynthesis(sessionId: string) {
    const counts = SpeakQueue.pendingSynthesisCounts
    const current = counts.get(sessionId) ?? 0
    if (current <= 1) {
      counts.delete(sessionId)
    } else {
      counts.set(sessionId, current - 1)
    }

    // 旧セッションの合成終了は現行の完了判定に影響しない
    if (sessionId !== SpeakQueue.getInstance().currentSessionId) return

    SpeakQueue.reevaluateCompletionIfIdle()
  }

  /**
   * LLM応答ストリームの終了を通知します。完了判定は chatProcessing が
   * 落ちるまで保留されるため、発話・合成が既に空転しているのに
   * isSpeaking が残っている場合のみ、ここで完了チェックを再スケジュールする。
   * isSpeaking=false のケースには関与しない（通常完了はキューの排水経路、
   * 停止時の引き継ぎは finalizeIfIdle が担う契約のため。設計§6）。
   */
  public static notifyResponseStreamEnded() {
    const instance = SpeakQueue.getInstance()
    if (SpeakQueue.currentPendingSynthesisCount > 0) return
    if (instance.queue.length > 0 || instance.isProcessing) return
    if (!homeStore.getState().isSpeaking) return

    void instance.scheduleNeutralExpression()
  }

  /**
   * 現行セッションの合成が全て終わった時点でキューも空転していれば
   * 完了チェックを起動する。発話中なら通常の完了判定
   * （scheduleNeutralExpression）へ、停止済み（isSpeaking=false）なら
   * finalizeIfIdle へ引き継ぐ（停止時に合成が残っていて finalizeIfIdle が
   * スキップされたケースの再評価）。
   */
  private static reevaluateCompletionIfIdle() {
    const instance = SpeakQueue.getInstance()
    if (SpeakQueue.currentPendingSynthesisCount > 0) return
    if (instance.queue.length > 0 || instance.isProcessing) return

    if (homeStore.getState().isSpeaking) {
      void instance.scheduleNeutralExpression()
    } else {
      void SpeakQueue.finalizeIfIdle()
    }
  }

  // 発話完了時のコールバックを登録
  static onSpeakCompletion(callback: () => void) {
    SpeakQueue.speakCompletionCallbacks.push(callback)
  }

  // 発話完了時のコールバックを削除
  static removeSpeakCompletionCallback(callback: () => void) {
    SpeakQueue.speakCompletionCallbacks =
      SpeakQueue.speakCompletionCallbacks.filter((cb) => cb !== callback)
  }

  /**
   * キューのグローバルインスタンスを取得します。
   */
  public static getInstance(): SpeakQueue {
    if (!SpeakQueue._instance) {
      SpeakQueue._instance = new SpeakQueue()
    }
    return SpeakQueue._instance
  }

  private static stopCurrentModelSpeaking() {
    getCharacterRenderer()?.stopSpeaking()
  }

  /**
   * 現在の発話だけを停止し、待機キューは残します。
   */
  public static stopCurrentSpeech() {
    SpeakQueue.stopCurrentModelSpeaking()
  }

  /**
   * 待機キューだけをクリアし、現在の発話は継続します。
   */
  public static stopQueue() {
    SpeakQueue.getInstance().clearQueue()
  }

  /**
   * すべての発話を停止し、キューをクリアします。
   * Stop ボタンから呼び出されます。
   */
  public static stopAll() {
    const instance = SpeakQueue.getInstance()
    instance.stopped = true
    // 発話キューの処理状態をリセットして次回の再生を可能にする
    instance.isProcessing = false
    SpeakQueue.stopTokenCounter++
    SpeakQueue.stopScope = 'all'
    // 停止前から待機している完了チェックを無効化する
    // （停止後に完了コールバックが発火してマイクが再開するのを防ぐ）
    instance.neutralCheckToken++
    instance.clearQueue()
    SpeakQueue.stopCurrentModelSpeaking()
    homeStore.setState({ isSpeaking: false })
  }

  /**
   * 指定セッションの発話だけを停止します。
   * 現在の発話セッションが一致しない場合は、キュー内の該当タスクだけを破棄します。
   */
  public static stopSession(sessionId: string | null) {
    if (!sessionId) return

    const instance = SpeakQueue.getInstance()
    const remainingTasks: SpeakTask[] = []
    instance.queue.forEach((task) => {
      if (task.sessionId === sessionId) {
        instance.disposeTask(task)
      } else {
        remainingTasks.push(task)
      }
    })
    instance.queue = remainingTasks

    if (instance.currentSessionId !== sessionId) {
      return
    }

    instance.stopped = true
    instance.isProcessing = false
    SpeakQueue.stopTokenCounter++
    SpeakQueue.stopScope = sessionId
    // 停止前から待機している完了チェックを無効化する（stopAll と同様）
    instance.neutralCheckToken++
    instance.clearQueue()

    SpeakQueue.stopCurrentModelSpeaking()
    homeStore.setState({ isSpeaking: false })
  }

  /**
   * キューが完全に空転している場合のみ、発話完了コールバックの実行と
   * 表情のリセットを行います。停止により発話が打ち切られた応答の
   * ストリーム終端処理（speechDispatcher が disabled になった場合）から
   * 呼び出されます。新しい応答が既に発話中（isSpeaking）の場合は何もしません。
   */
  public static async finalizeIfIdle(): Promise<void> {
    const instance = SpeakQueue.getInstance()
    if (
      instance.queue.length > 0 ||
      instance.isProcessing ||
      SpeakQueue.currentPendingSynthesisCount > 0 ||
      homeStore.getState().isSpeaking
    ) {
      return
    }

    const finalizingSessionId = instance.currentSessionId
    const canResetToIdle = () =>
      instance.queue.length === 0 &&
      !homeStore.getState().isSpeaking &&
      instance.currentSessionId === finalizingSessionId
    let shouldResumeQueue = false
    instance.isProcessing = true
    try {
      instance.stopped = false
      SpeakQueue.speakCompletionCallbacks.forEach((callback) => {
        try {
          callback()
        } catch (error) {
          logger.error(
            '発話完了コールバックの実行中にエラーが発生しました:',
            error
          )
        }
      })

      if (!canResetToIdle()) {
        shouldResumeQueue =
          instance.queue.length > 0 && homeStore.getState().isSpeaking
      } else {
        await getCharacterRenderer()?.resetToIdle()
      }
    } finally {
      instance.isProcessing = false
    }

    if (shouldResumeQueue) {
      await instance.processQueue()
    }
  }

  async addTask(task: SpeakTask) {
    this.queue.push(task)
    // キューにタスクが追加された時点で発話中フラグを立てる
    homeStore.setState({ isSpeaking: true })
    await this.processQueue()
  }

  private async processQueue() {
    // 既に別の processQueue が動作中の場合は新たに起動しない
    if (this.isProcessing) return

    // Stop ボタンが押された後に再開されたかどうかを判定するためのトークンをキャプチャ
    const startToken = SpeakQueue.currentStopToken

    // 停止中は処理しない
    if (this.stopped) {
      this.clearQueue()
      return
    }

    this.isProcessing = true
    const hs = homeStore.getState()

    // isSpeaking はループ内部で最新値を参照するため、ここでは条件に含めない
    while (this.queue.length > 0) {
      // StopAll() によりトークンが変化していたら直ちに処理を中断
      if (startToken !== SpeakQueue.currentStopToken) {
        logger.log('Stop token changed. Abort current queue processing.')
        break
      }

      const currentState = homeStore.getState()
      if (!currentState.isSpeaking) {
        this.clearQueue()
        homeStore.setState({ isSpeaking: false })
        break
      }

      const task = this.queue.shift()
      if (task) {
        if (task.sessionId !== this.currentSessionId) {
          // 旧セッションのタスクは破棄
          this.disposeTask(task, true)
          continue
        }
        try {
          const renderer = getCharacterRenderer()
          const observer = task.onPlaybackStart
            ? { onPlaybackStart: task.onPlaybackStart }
            : undefined
          if (task.kind === 'pcm16-stream') {
            if (!renderer?.speakPcm16Stream) {
              throw new Error(
                'Current character renderer does not support PCM16 streaming'
              )
            }
            if (observer) {
              await renderer.speakPcm16Stream(
                task.audioStream,
                task.talk,
                task.sampleRate,
                observer
              )
            } else {
              await renderer.speakPcm16Stream(
                task.audioStream,
                task.talk,
                task.sampleRate
              )
            }
          } else {
            if (observer) {
              await renderer?.speak(
                task.audioBuffer,
                task.talk,
                task.isNeedDecode,
                observer
              )
            } else {
              await renderer?.speak(
                task.audioBuffer,
                task.talk,
                task.isNeedDecode
              )
            }
          }
        } catch (error) {
          await this.disposeTask(task, false, error)
          logger.error(
            'An error occurred while processing the speech synthesis task:',
            error
          )
          if (error instanceof Error) {
            logger.error('Error details:', error.message)
          }
        } finally {
          try {
            task.onComplete?.()
          } catch (error) {
            logger.error('Speech synthesis completion callback failed:', error)
          }
        }
      }
    }

    // 処理を完全に終える、またはトークン変化で中断した場合どちらでも isProcessing を解除
    this.isProcessing = false

    // トークンが変化して中断された場合は後続処理を行わずに終了
    if (startToken !== SpeakQueue.currentStopToken) {
      return
    }

    this.scheduleNeutralExpression()
    if (!hs.chatProcessing) {
      this.clearQueue()
    }
  }

  private async scheduleNeutralExpression() {
    const checkToken = ++this.neutralCheckToken
    const initialLength = this.queue.length
    await new Promise((resolve) =>
      setTimeout(resolve, SpeakQueue.QUEUE_CHECK_DELAY)
    )

    // より新しい完了チェックが起動されていたら、この世代の判定は破棄する
    // （完了コールバック・表情リセットの二重実行防止）
    if (checkToken !== this.neutralCheckToken) return

    if (this.shouldResetToNeutral(initialLength)) {
      await getCharacterRenderer()?.resetToIdle()
    }
  }

  private shouldResetToNeutral(initialLength: number): boolean {
    // LLMストリーミング中（chatProcessing=true）は、次のセグメントがまだ
    // 生成されておらず合成数が0でも発話継続中とみなす。ストリーム終了時は
    // notifyResponseStreamEnded() で必ず再評価される。
    const isComplete =
      initialLength === 0 &&
      this.queue.length === 0 &&
      !this.isProcessing &&
      SpeakQueue.currentPendingSynthesisCount === 0 &&
      !homeStore.getState().chatProcessing

    // 発話完了時にコールバックを呼び出す
    if (isComplete) {
      logger.log('🎤 発話が完了しました。登録されたコールバックを実行します。')
      // 発話完了時に isSpeaking を必ず false に設定
      homeStore.setState({ isSpeaking: false })
      // 停止フラグもリセットして次回の動作に備える
      this.stopped = false
      // すべての発話完了コールバックを呼び出す
      SpeakQueue.speakCompletionCallbacks.forEach((callback) => {
        try {
          callback()
        } catch (error) {
          logger.error(
            '発話完了コールバックの実行中にエラーが発生しました:',
            error
          )
        }
      })
    }

    return isComplete
  }

  clearQueue(shouldCallOnComplete = false) {
    this.queue.forEach((task) => this.disposeTask(task, shouldCallOnComplete))
    this.queue = []
  }

  private disposeTask(
    task: SpeakTask,
    shouldCallOnComplete = false,
    reason: unknown = 'speech task discarded'
  ) {
    const complete = () => {
      if (!shouldCallOnComplete) return
      try {
        task.onComplete?.()
      } catch (error) {
        logger.error('Speech task disposal callback failed:', error)
      }
    }

    if (task.kind === 'pcm16-stream') {
      void task.audioStream
        .cancel(reason)
        .catch(() => {})
        .finally(complete)
      return
    }

    complete()
  }

  private resetStoppedState() {
    this.stopped = false
    homeStore.setState({ isSpeaking: true })
  }

  checkSessionId(sessionId: string) {
    // 停止中の場合はセッションIDに関わらず再開する
    if (this.stopped) {
      this.currentSessionId = sessionId
      // 念のためキューをクリア（Stop 時点で空だが保険）
      this.clearQueue()
      this.resetStoppedState()
      return
    }

    // 通常時にセッションIDが変わった場合はキューをリセット
    if (this.currentSessionId !== sessionId) {
      this.currentSessionId = sessionId
      this.clearQueue(true)
      homeStore.setState({ isSpeaking: true })
    }
  }

  // インスタンスが停止状態かどうか
  public isStopped(): boolean {
    return this.stopped
  }
}
