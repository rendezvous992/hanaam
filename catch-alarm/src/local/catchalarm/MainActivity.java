package local.catchalarm;

import android.app.Activity;
import android.app.DatePickerDialog;
import android.app.NotificationManager;
import android.app.TimePickerDialog;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.DatePicker;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.TimePicker;
import android.widget.Toast;

import java.time.LocalDate;
import java.time.ZoneId;

public class MainActivity extends Activity {
    private final Handler h = new Handler(Looper.getMainLooper());
    private float d;
    private LinearLayout box;
    private TextView stListener, stPost, stFull, stBattery, stOverlay, logView;
    private TextView dateView, timeView, linkPreview;
    private EditText kwEdit, urlEdit, peopleEdit, durEdit;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        d = getResources().getDisplayMetrics().density;
        Alarm.ensureChannel(this);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(0xFFF5F5F7);
        box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(px(18), px(18), px(18), px(40));
        sv.addView(box);
        sv.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @SuppressWarnings("deprecation")
            @Override public WindowInsets onApplyWindowInsets(View v, WindowInsets in) {
                v.setPadding(0, in.getSystemWindowInsetTop(), 0, in.getSystemWindowInsetBottom());
                return in;
            }
        });

        box.addView(text("캐치알람", 26, true, 0xFF111111));
        box.addView(text("캐치테이블 앱 알림 또는 카톡 '캐치테이블' 알림톡이 오면 알람 소리(무음모드에서도)·진동·플래시·전체화면으로 알리고, 누르면 캐치테이블 페이지로 바로 이동합니다.", 14, false, 0xFF555555));

        section("1. 권한 (전부 ✅ 가 되게)");
        stListener = row("알림 접근 (필수)", "설정", new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
            }
        });
        stPost = row("이 앱 알림 표시 (필수)", "허용", new View.OnClickListener() {
            @Override public void onClick(View v) { askPostNotifications(); }
        });
        stFull = row("전체화면 알림 (잠금화면 위)", "설정", new View.OnClickListener() {
            @Override public void onClick(View v) { openFullScreenSetting(); }
        });
        stBattery = row("배터리 최적화 제외 (삼성 필수)", "설정", new View.OnClickListener() {
            @Override public void onClick(View v) { askBattery(); }
        });
        stOverlay = row("다른 앱 위에 표시 (선택: 폰 사용 중에도 전체화면)", "설정", new View.OnClickListener() {
            @Override public void onClick(View v) { openOverlaySetting(); }
        });

        section("2. 감시 옵션");
        toggle("감시 켜기", Prefs.enabled(this), new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton bt, boolean on) { Prefs.setEnabled(MainActivity.this, on); }
        });
        toggle("카톡 '캐치테이블' 알림톡도 감시", Prefs.watchKakao(this), new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton bt, boolean on) { Prefs.setWatchKakao(MainActivity.this, on); }
        });
        toggle("플래시 깜빡임", Prefs.torch(this), new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton bt, boolean on) { Prefs.setTorch(MainActivity.this, on); }
        });
        toggle("알람 볼륨 최대로 올리기", Prefs.maxVolume(this), new CompoundButton.OnCheckedChangeListener() {
            @Override public void onCheckedChanged(CompoundButton bt, boolean on) { Prefs.setMaxVolume(MainActivity.this, on); }
        });
        box.addView(label("키워드 (쉼표 구분 · 비우면 모든 캐치테이블 알림, (광고)는 항상 제외)"));
        kwEdit = edit(Prefs.keywords(this), "예: 라망시크레, 빈자리", InputType.TYPE_CLASS_TEXT);

        section("3. 열 매장·날짜");
        box.addView(label("열 매장 링크 (캐치테이블 매장 → 공유 → 복사한 문구 통째로 붙여넣어도 됨)"));
        urlEdit = edit(Prefs.shopUrl(this), "https://app.catchtable.co.kr/ct/shop/...",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        toggle("캐치테이블 앱 먼저 깨운 뒤 매장 열기 (매장→메인으로 튕기면 켜기 · '다른 앱 위에 표시' 필요)",
                Prefs.warmup(this), new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton bt, boolean on) {
                        Prefs.setWarmup(MainActivity.this, on);
                        if (on && !Settings.canDrawOverlays(MainActivity.this)) {
                            Toast.makeText(MainActivity.this, "'다른 앱 위에 표시'를 허용해야 동작합니다", Toast.LENGTH_LONG).show();
                            openOverlaySetting();
                        }
                    }
                });

        box.addView(label("예약 날짜 (알림 문구에 날짜가 없을 때 이 날짜로 엽니다)"));
        dateView = pickRow("날짜 선택", new View.OnClickListener() {
            @Override public void onClick(View v) { pickDate(); }
        }, new View.OnClickListener() {
            @Override public void onClick(View v) {
                Prefs.setDate(MainActivity.this, null);
                showPick();
            }
        });
        box.addView(label("예약 시간 (선택 · 알림 문구에 시간이 없을 때)"));
        timeView = pickRow("시간 선택", new View.OnClickListener() {
            @Override public void onClick(View v) { pickTime(); }
        }, new View.OnClickListener() {
            @Override public void onClick(View v) {
                Prefs.setTime(MainActivity.this, "");
                showPick();
            }
        });
        box.addView(label("인원 (알림 문구에 인원이 없을 때 매장 화면에 넣을 인원 · 비우면 안 넣음)"));
        peopleEdit = edit(Prefs.people(this), "예: 2", InputType.TYPE_CLASS_NUMBER);
        box.addView(text("날짜는 ① 알림 문구에 '11월 27일 18:30 2명' 같은 날짜가 있으면 그 날짜, ② 없으면 위에서 지정한 날짜로 넣습니다. 알람이 온 날(오늘)을 넣지는 않습니다. 지난 날짜는 무시합니다. 시간 선택 후 예약하기는 직접 누르세요.", 12, false, 0xFF777777));

        linkPreview = text("", 12, false, 0xFF333333);
        linkPreview.setTypeface(Typeface.MONOSPACE);
        linkPreview.setTextIsSelectable(true);
        linkPreview.setPadding(0, px(8), 0, 0);
        box.addView(linkPreview);

        Button test = button("이 링크 지금 열어보기", 0xFFE0E0E0, 0xFF111111);
        test.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { testLink(); }
        });
        box.addView(test, lp(LinearLayout.LayoutParams.MATCH_PARENT, px(44), px(4)));

        box.addView(label("알람 울리는 시간 (초)"));
        durEdit = edit(String.valueOf(Prefs.durationSec(this)), "120", InputType.TYPE_CLASS_NUMBER);
        Button save = button("저장", 0xFF111111, 0xFFFFFFFF);
        save.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { save(); }
        });
        box.addView(save, lp(LinearLayout.LayoutParams.MATCH_PARENT, px(52), px(10)));

        section("4. 테스트");
        box.addView(text("버튼을 누르고 5초 안에 화면을 꺼 보세요. 잠금화면 위로 알람이 떠야 정상입니다.", 13, false, 0xFF555555));
        Button alarm = button("🔔 5초 후 테스트 알람", 0xFFD50000, 0xFFFFFFFF);
        alarm.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                save();
                Toast.makeText(MainActivity.this, "5초 후 울립니다 — 화면을 꺼 보세요", Toast.LENGTH_SHORT).show();
                h.postDelayed(new Runnable() {
                    @Override public void run() { testAlarm(); }
                }, 5000);
            }
        });
        box.addView(alarm, lp(LinearLayout.LayoutParams.MATCH_PARENT, px(56), px(8)));

        section("5. 감지 기록");
        logView = text("", 12, false, 0xFF333333);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextIsSelectable(true);
        box.addView(logView);
        Button clear = button("기록 지우기", 0xFFE0E0E0, 0xFF111111);
        clear.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Prefs.clearLog(MainActivity.this);
                refresh();
            }
        });
        box.addView(clear, lp(LinearLayout.LayoutParams.MATCH_PARENT, px(44), px(8)));
        box.addView(text("\n삼성 팁: 설정 › 배터리 › 백그라운드 사용 제한 › '사용하지 않는 앱을 절전 상태로 전환' 끄기, '절전 예외 앱'에 캐치알람 추가. 캐치테이블·카카오톡 앱의 알림도 켜져 있어야 감지됩니다.", 12, false, 0xFF777777));

        setContentView(sv);
    }

    @Override protected void onResume() {
        super.onResume();
        refresh();
        if (listenerGranted()) {
            try {
                NotificationListenerService.requestRebind(new ComponentName(this, CatchListener.class));
            } catch (Exception ignored) {
            }
        }
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        refresh();
    }

    private void pickDate() {
        LocalDate today = Alarm.today();
        LocalDate cur = Prefs.date(this);
        if (cur == null || cur.isBefore(today)) cur = today.plusDays(1);
        DatePickerDialog dlg = new DatePickerDialog(this, new DatePickerDialog.OnDateSetListener() {
            @Override public void onDateSet(DatePicker v, int y, int m, int day) {
                Prefs.setDate(MainActivity.this, LocalDate.of(y, m + 1, day));
                showPick();
                Toast.makeText(MainActivity.this, "예약 날짜 저장됨", Toast.LENGTH_SHORT).show();
            }
        }, cur.getYear(), cur.getMonthValue() - 1, cur.getDayOfMonth());
        dlg.getDatePicker().setMinDate(today.atStartOfDay(ZoneId.of("Asia/Seoul")).toInstant().toEpochMilli());
        dlg.show();
    }

    private void pickTime() {
        String cur = Prefs.time(this);
        int hh = 19, mm = 0;
        if (cur.matches("[0-9]{4}")) {
            hh = Integer.parseInt(cur.substring(0, 2));
            mm = Integer.parseInt(cur.substring(2));
        }
        new TimePickerDialog(this, new TimePickerDialog.OnTimeSetListener() {
            @Override public void onTimeSet(TimePicker v, int h, int m) {
                Prefs.setTime(MainActivity.this, String.format("%02d%02d", h, m));
                showPick();
                Toast.makeText(MainActivity.this, "예약 시간 저장됨", Toast.LENGTH_SHORT).show();
            }
        }, hh, mm, true).show();
    }

    /** 지정한 날짜·시간 표시와 열릴 링크 미리보기. */
    private void showPick() {
        LocalDate today = Alarm.today();
        LocalDate date = Prefs.date(this);
        if (date == null) {
            dateView.setText("지정 안 함 (알림 문구 날짜만 사용)");
            dateView.setTextColor(0xFF888888);
        } else if (date.isBefore(today)) {
            dateView.setText(ShopLink.korean(date) + " — 지난 날짜, 다시 고르세요");
            dateView.setTextColor(0xFFC62828);
        } else {
            dateView.setText(ShopLink.korean(date));
            dateView.setTextColor(0xFF2E7D32);
        }
        String time = Prefs.time(this);
        if (time.matches("[0-9]{4}")) {
            timeView.setText(time.substring(0, 2) + ":" + time.substring(2));
            timeView.setTextColor(0xFF2E7D32);
        } else {
            timeView.setText("지정 안 함");
            timeView.setTextColor(0xFF888888);
        }

        String url = Alarm.cleanUrl(urlEdit.getText().toString());
        if (url.isEmpty()) {
            linkPreview.setText("열릴 링크: (매장 링크를 넣으면 여기에 날짜가 붙은 링크가 보입니다)");
            return;
        }
        ShopLink.Target t = ShopLink.target("", peopleEdit.getText().toString(), date, time, today);
        String link = ShopLink.build(url, t);
        String what = t.describe();
        linkPreview.setText("알림 문구에 날짜가 없을 때 열릴 조건: " + (what.isEmpty() ? "없음" : what) + "\n" + link);
    }

    private void testLink() {
        if (urlEdit.getText().toString().trim().isEmpty()) {
            Toast.makeText(this, "링크를 먼저 넣으세요", Toast.LENGTH_SHORT).show();
            return;
        }
        save();
        ShopLink.Target t = ShopLink.target("", Prefs.people(this), Prefs.date(this), Prefs.time(this), Alarm.today());
        String link = ShopLink.build(Prefs.shopUrl(this), t);
        String how = Alarm.openUrl(this, link);
        Prefs.addLog(this, "링크 테스트 → " + (how != null ? how : "실패") + " · " + link);
        Toast.makeText(this, how != null ? how + "(으)로 열었습니다" : "열 수 없는 링크입니다", Toast.LENGTH_LONG).show();
    }

    private void testAlarm() {
        Prefs.addLog(this, "테스트 알람");
        String people = Prefs.people(this).isEmpty() ? "2" : Prefs.people(this);
        LocalDate fixed = Prefs.date(this);
        String body;
        if (fixed != null && !fixed.isBefore(Alarm.today())) {
            body = "빈자리 알림 테스트 · " + people + "명. '지금 열기'를 누르면 설정한 매장이 지정한 날짜로 열립니다.";
        } else {
            LocalDate tomorrow = Alarm.today().plusDays(1);
            body = "빈자리 알림 테스트 · " + tomorrow.getMonthValue() + "월 " + tomorrow.getDayOfMonth() + "일 19:00 "
                    + people + "명. '지금 열기'를 누르면 설정한 매장이 이 날짜·시간·인원으로 열립니다.";
        }
        Alarm.trigger(this, "[테스트] 캐치테이블", body, Prefs.CATCHTABLE_PKG, null);
    }

    private void save() {
        Prefs.setKeywords(this, kwEdit.getText().toString());
        Prefs.setShopUrl(this, urlEdit.getText().toString());
        Prefs.setPeople(this, peopleEdit.getText().toString());
        urlEdit.setText(Prefs.shopUrl(this));
        int dur;
        try {
            dur = Integer.parseInt(durEdit.getText().toString().trim());
        } catch (Exception e) {
            dur = 120;
        }
        Prefs.setDurationSec(this, Math.max(10, Math.min(600, dur)));
        durEdit.setText(String.valueOf(Prefs.durationSec(this)));
        showPick();
        Toast.makeText(this, "저장됨", Toast.LENGTH_SHORT).show();
    }

    private void refresh() {
        boolean listener = listenerGranted();
        mark(stListener, listener, listener ? (CatchListener.connected ? "허용 · 연결됨" : "허용") : "미허용");
        boolean post = Build.VERSION.SDK_INT < 33
                || checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
        mark(stPost, post, post ? "허용" : "미허용");
        boolean full = Build.VERSION.SDK_INT < 34
                || ((NotificationManager) getSystemService(NotificationManager.class)).canUseFullScreenIntent();
        mark(stFull, full, full ? "허용" : "미허용");
        boolean battery = ((PowerManager) getSystemService(PowerManager.class)).isIgnoringBatteryOptimizations(getPackageName());
        mark(stBattery, battery, battery ? "제외됨" : "최적화 중");
        boolean overlay = Settings.canDrawOverlays(this);
        stOverlay.setText((overlay ? "✅ " : "➖ ") + (overlay ? "허용" : "미허용 (선택)"));
        stOverlay.setTextColor(overlay ? 0xFF2E7D32 : 0xFF888888);
        String log = Prefs.log(this);
        logView.setText(log.isEmpty() ? "(아직 없음)" : log);
        showPick();
    }

    private boolean listenerGranted() {
        return ((NotificationManager) getSystemService(NotificationManager.class))
                .isNotificationListenerAccessGranted(new ComponentName(this, CatchListener.class));
    }

    private void askPostNotifications() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
        }
        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
    }

    private void openFullScreenSetting() {
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                        Uri.parse("package:" + getPackageName())));
                return;
            } catch (Exception ignored) {
            }
        }
        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
    }

    private void askBattery() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void openOverlaySetting() {
        startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
    }

    private void mark(TextView v, boolean ok, String s) {
        v.setText((ok ? "✅ " : "❌ ") + s);
        v.setTextColor(ok ? 0xFF2E7D32 : 0xFFC62828);
    }

    private int px(int dp) {
        return (int) (dp * d);
    }

    private TextView text(String s, int sp, boolean bold, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s, 13, false, 0xFF555555);
        t.setPadding(0, px(10), 0, px(2));
        return t;
    }

    private void section(String s) {
        TextView t = text(s, 17, true, 0xFF111111);
        t.setPadding(0, px(22), 0, px(6));
        box.addView(t);
    }

    private Button button(String s, int bg, int fg) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextColor(fg);
        b.setBackgroundColor(bg);
        return b;
    }

    private EditText edit(String value, String hint, int type) {
        EditText e = new EditText(this);
        e.setText(value);
        e.setHint(hint);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextSize(15);
        box.addView(e);
        return e;
    }

    private void toggle(String s, boolean on, CompoundButton.OnCheckedChangeListener l) {
        Switch sw = new Switch(this);
        sw.setText(s);
        sw.setTextSize(15);
        sw.setChecked(on);
        sw.setOnCheckedChangeListener(l);
        sw.setPadding(0, px(8), 0, px(8));
        box.addView(sw);
    }

    private TextView row(String title, String action, View.OnClickListener l) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setPadding(0, px(6), 0, px(6));
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(text(title, 15, false, 0xFF111111));
        TextView st = text("", 13, true, 0xFF888888);
        col.addView(st);
        r.addView(col, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        Button bt = button(action, 0xFFE0E0E0, 0xFF111111);
        bt.setOnClickListener(l);
        r.addView(bt, new LinearLayout.LayoutParams(px(84), px(44)));
        box.addView(r);
        return st;
    }

    /** [값] [선택] [지움] 한 줄. 값 TextView 를 돌려준다. */
    private TextView pickRow(String action, View.OnClickListener pick, View.OnClickListener clear) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setPadding(0, px(2), 0, px(2));
        TextView value = text("", 16, true, 0xFF888888);
        r.addView(value, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        Button p = button(action, 0xFF111111, 0xFFFFFFFF);
        p.setOnClickListener(pick);
        r.addView(p, new LinearLayout.LayoutParams(px(96), px(44)));
        Button c = button("지움", 0xFFE0E0E0, 0xFF111111);
        c.setOnClickListener(clear);
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(px(60), px(44));
        cl.leftMargin = px(6);
        r.addView(c, cl);
        box.addView(r);
        return value;
    }

    private static LinearLayout.LayoutParams lp(int w, int h, int top) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(w, h);
        p.topMargin = top;
        return p;
    }
}
