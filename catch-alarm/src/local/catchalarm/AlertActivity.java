package local.catchalarm;

import android.app.Activity;
import android.app.KeyguardManager;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class AlertActivity extends Activity {
    static final String EXTRA_OPEN = "open";
    private static final int RED = 0xFFD50000;

    private final Handler h = new Handler(Looper.getMainLooper());
    private LinearLayout root;
    private TextView timeView, titleView, bodyView, targetView, status;
    private boolean flip;

    private final Runnable blink = new Runnable() {
        @Override public void run() {
            if (root == null) return;
            if (Alarm.ringing) {
                flip = !flip;
                root.setBackgroundColor(flip ? RED : 0xFFFF6D00);
                status.setText("알람 울리는 중 · 볼륨키를 누르면 소리만 꺼집니다");
            } else {
                root.setBackgroundColor(0xFF263238);
                status.setText("알람 꺼짐");
            }
            h.postDelayed(this, 350);
        }
    };

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setShowWhenLocked(true);
        setTurnScreenOn(true);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (getIntent().getBooleanExtra(EXTRA_OPEN, false)) openPage();
        else buildUi();
    }

    @Override protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getBooleanExtra(EXTRA_OPEN, false)) {
            openPage();
        } else if (root != null) {
            fill();
        } else {
            buildUi();
        }
    }

    @Override protected void onResume() {
        super.onResume();
        h.removeCallbacks(blink);
        h.post(blink);
    }

    @Override protected void onPause() {
        super.onPause();
        h.removeCallbacks(blink);
    }

    @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
            Alarm.silence(this);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        Alarm.silence(this);
        super.onBackPressed();
    }

    private void buildUi() {
        final float d = getResources().getDisplayMetrics().density;
        final int pad = (int) (24 * d);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(pad, (int) (56 * d), pad, (int) (40 * d));
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @SuppressWarnings("deprecation")
            @Override public WindowInsets onApplyWindowInsets(View v, WindowInsets in) {
                v.setPadding(pad, (int) (32 * d) + in.getSystemWindowInsetTop(),
                        pad, (int) (16 * d) + in.getSystemWindowInsetBottom());
                return in;
            }
        });
        root.setBackgroundColor(RED);

        root.addView(tv("🔔 캐치테이블", 34, true));
        timeView = tv("", 16, false);
        root.addView(timeView);
        titleView = tv("", 26, true);
        titleView.setPadding(0, pad, 0, (int) (8 * d));
        root.addView(titleView);
        bodyView = tv("", 19, false);
        bodyView.setMaxLines(9);
        root.addView(bodyView, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        targetView = tv("", 17, true);
        GradientDrawable box = new GradientDrawable();
        box.setColor(0x33000000);
        box.setCornerRadius(14 * d);
        targetView.setBackground(box);
        int tp = (int) (12 * d);
        targetView.setPadding(tp, tp, tp, tp);
        root.addView(targetView, lp(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT, tp));

        Button open = btn("▶  지금 열기", 0xFFFFFFFF, RED, 30);
        open.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openPage(); }
        });
        root.addView(open, lp(LinearLayout.LayoutParams.MATCH_PARENT, (int) (150 * d), tp));

        if (Alarm.originalIntent != null) {
            String label = Alarm.isCatchtable(Alarm.sourcePkg) ? "캐치테이블 원래 알림 열기" : "원래 카톡 알림 열기";
            Button orig = btn(label, 0x33FFFFFF, 0xFFFFFFFF, 18);
            orig.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { openOriginal(); }
            });
            root.addView(orig, lp(LinearLayout.LayoutParams.MATCH_PARENT, (int) (60 * d), tp));
        }

        Button off = btn("알람 끄기", 0x33000000, 0xFFFFFFFF, 18);
        off.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Alarm.stop(AlertActivity.this);
                finish();
            }
        });
        root.addView(off, lp(LinearLayout.LayoutParams.MATCH_PARENT, (int) (60 * d), tp));

        status = tv("", 14, false);
        status.setPadding(0, tp, 0, 0);
        root.addView(status);
        setContentView(root);
        fill();
    }

    private void fill() {
        titleView.setText(Alarm.title.isEmpty() ? "새 알림" : Alarm.title);
        bodyView.setText(Alarm.text);
        String src = Alarm.isCatchtable(Alarm.sourcePkg) ? "캐치테이블 앱" : "카카오톡 알림톡";
        String at = Alarm.firedAt > 0
                ? new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(Alarm.firedAt)) : "";
        timeView.setText(src + "  " + at);
        targetView.setText(targetText());
    }

    private String targetText() {
        boolean hasLink = !Prefs.shopUrl(this).isEmpty() || (Alarm.title + " " + Alarm.text).contains("/ct/shop/");
        if (!hasLink) return "📅 매장 링크가 없어 날짜를 넣을 수 없습니다\n캐치알람 앱에서 매장 링크를 넣어 주세요";
        ShopLink.Target t = Alarm.target(this);
        if (t.date == null) return "📅 날짜 없음 — 캐치알람 앱에서 예약 날짜를 지정하면 그 날짜로 열립니다";
        return "📅 " + t.describe() + "\n" + (t.dateFromText ? "알림 문구의 날짜로 엽니다" : "내가 지정한 날짜로 엽니다");
    }

    private void openPage() {
        unlockThen(new Runnable() {
            @Override public void run() {
                String how = Alarm.openPage(AlertActivity.this);
                Prefs.addLog(AlertActivity.this, "열기 → " + how);
                Toast.makeText(AlertActivity.this, how + "(으)로 이동", Toast.LENGTH_LONG).show();
            }
        });
    }

    private void openOriginal() {
        unlockThen(new Runnable() {
            @Override public void run() {
                if (!Alarm.openOriginal(AlertActivity.this)) {
                    Toast.makeText(AlertActivity.this, "원래 알림이 만료됐습니다", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    private void unlockThen(final Runnable action) {
        Alarm.stop(this);
        KeyguardManager km = (KeyguardManager) getSystemService(KeyguardManager.class);
        if (km == null || !km.isKeyguardLocked()) {
            action.run();
            finish();
            return;
        }
        km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
            @Override public void onDismissSucceeded() {
                action.run();
                finish();
            }

            @Override public void onDismissError() {
                action.run();
                finish();
            }

            @Override public void onDismissCancelled() {
                if (root == null) buildUi();
            }
        });
    }

    private TextView tv(String s, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(0xFFFFFFFF);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button btn(String s, int bg, int fg, int sp) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(sp);
        b.setTextColor(fg);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable g = new GradientDrawable();
        g.setColor(bg);
        g.setCornerRadius(28 * getResources().getDisplayMetrics().density);
        b.setBackground(g);
        b.setStateListAnimator(null);
        return b;
    }

    private static LinearLayout.LayoutParams lp(int w, int h, int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(w, h);
        p.topMargin = top;
        return p;
    }
}
