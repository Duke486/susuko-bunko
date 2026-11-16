package com.susuko.bunko

import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.WebView

// 打包时由 .github/workflows/build.yml 复制到 gen/android 里，替换 Tauri 生成的 MainActivity。
// 作用：阅读时拦截音量键并通知网页翻页；不在阅读时音量键照常调音量。
class MainActivity : TauriActivity() {
  private var web: WebView? = null

  @Volatile
  private var volumeKeysForPaging = false

  // 网页通过 window.SusukoNative.setVolumeKeys(true / false) 告诉这边现在是否在阅读
  inner class Bridge {
    @JavascriptInterface
    fun setVolumeKeys(on: Boolean) {
      volumeKeysForPaging = on
    }
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
