package com.susuko.bunko

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.util.Locale

// 打包时由 .github/workflows/build.yml 复制到 gen/android 里，替换 Tauri 生成的 MainActivity。
// 作用：1. 阅读时拦截音量键并通知网页翻页；不在阅读时音量键照常调音量。
//      2. 安卓的网页视图不支持网页朗读接口，这里用系统的 TextToSpeech 帮网页朗读。
class MainActivity : TauriActivity() {
  private var web: WebView? = null
  private var tts: TextToSpeech? = null
  @Volatile private var ttsReady = false

  @Volatile
  private var volumeKeysForPaging = false

  // 网页通过 window.SusukoNative.xxx() 调用
  inner class Bridge {
    @JavascriptInterface
    fun setVolumeKeys(on: Boolean) {
      volumeKeysForPaging = on
    }

    @JavascriptInterface
    fun ttsAvailable(): Boolean = ttsReady

    @JavascriptInterface
    fun speak(id: String, text: String, rate: Double, lang: String) {
      val engine = tts
      if (engine == null || !ttsReady) { done(id, false); return }
      engine.language = Locale.forLanguageTag(lang)
      engine.setSpeechRate(rate.toFloat())
      engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
    }

    @JavascriptInterface
    fun stopSpeaking() {
      tts?.stop()
    }
  }

  private fun done(id: String, ok: Boolean) {
    val safe = id.replace("'", "")
    web?.post { web?.evaluateJavascript("window.__ttsDone && window.__ttsDone('$safe', $ok)", null) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    tts = TextToSpeech(this) { status ->
      ttsReady = status == TextToSpeech.SUCCESS
      tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) {}
        override fun onDone(utteranceId: String) { done(utteranceId, true) }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String) { done(utteranceId, false) }
        override fun onStop(utteranceId: String, interrupted: Boolean) { done(utteranceId, false) }
      })
    }
  }

  override fun onDestroy() {
    tts?.shutdown()
    tts = null
    super.onDestroy()
  }

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.addJavascriptInterface(Bridge(), "SusukoNative")
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val code = event.keyCode
    if (volumeKeysForPaging && (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN)) {
      if (event.action == KeyEvent.ACTION_DOWN) {
        val dir = if (code == KeyEvent.KEYCODE_VOLUME_DOWN) "down" else "up"
        web?.evaluateJavascript("window.__volumeKey && window.__volumeKey('$dir')", null)
      }
      return true // 按下和抬起都吃掉，系统就不会弹出音量条
    }
    return super.dispatchKeyEvent(event)
  }
}
