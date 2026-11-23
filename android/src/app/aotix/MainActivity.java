package app.aotix;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** WebView wrapper for the AO Tix site; adds max brightness while a QR is shown. */
public class MainActivity extends Activity {
  static final String HOME = "https://nicholaslie90.github.io/ao-tix/";
  WebView web;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    web = new WebView(this);
    setContentView(web);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);   // the site keeps password/settings in localStorage
    web.addJavascriptInterface(new Bridge(), "AoTixAndroid");
    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        // Only our own site stays in the app (it is the only page that sees the bridge).
        if (r.getUrl().toString().startsWith(HOME)) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl())); } catch (Exception ignored) {}
        return true;
      }
    });
    if (state != null) web.restoreState(state); else web.loadUrl(HOME);
  }

  @Override protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }

  // Back closes the QR lightbox / detail modal first, then exits.
  @Override public void onBackPressed() {
    web.evaluateJavascript(
        "(function(){try{if(isOpen(lightbox)){closeLightbox();return 1}" +
        "if(isOpen(modal)){closeModal();return 1}}catch(e){}return 0})()",
        new ValueCallback<String>() {
          @Override public void onReceiveValue(String v) {
            if (!"1".equals(v)) finish();
          }
        });
  }

  class Bridge {
    @JavascriptInterface public void qrBright(final boolean on) {
      runOnUiThread(new Runnable() {
        @Override public void run() {
          WindowManager.LayoutParams lp = getWindow().getAttributes();
          lp.screenBrightness = on ? 1f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
          getWindow().setAttributes(lp);
          if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
          else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
      });
    }
  }
}
