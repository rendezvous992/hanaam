package local.catchalarm;

import android.content.Context;
import android.content.SharedPreferences;

import java.text.SimpleDateFormat;
import java.time.LocalDate;
import java.util.Date;
import java.util.Locale;

final class Prefs {
    static final String CATCHTABLE_PKG = "co.kr.catchtable.android.catchtable_app";
    static final String KAKAO_PKG = "com.kakao.talk";
    private static final String NAME = "catchalarm";
    private static final int LOG_MAX = 40;

    private Prefs() {}

    static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(NAME, Context.MODE_PRIVATE);
    }

    static boolean enabled(Context c) { return sp(c).getBoolean("enabled", true); }
    static void setEnabled(Context c, boolean v) { sp(c).edit().putBoolean("enabled", v).apply(); }

    static boolean watchKakao(Context c) { return sp(c).getBoolean("kakao", true); }
    static void setWatchKakao(Context c, boolean v) { sp(c).edit().putBoolean("kakao", v).apply(); }

    static boolean torch(Context c) { return sp(c).getBoolean("torch", true); }
    static void setTorch(Context c, boolean v) { sp(c).edit().putBoolean("torch", v).apply(); }

    static boolean maxVolume(Context c) { return sp(c).getBoolean("maxvol", true); }
    static void setMaxVolume(Context c, boolean v) { sp(c).edit().putBoolean("maxvol", v).apply(); }

    static boolean warmup(Context c) { return sp(c).getBoolean("warmup", false); }
    static void setWarmup(Context c, boolean v) { sp(c).edit().putBoolean("warmup", v).apply(); }
    static int warmupMs(Context c) { return sp(c).getInt("warmupMs", 2500); }

    static String keywords(Context c) { return sp(c).getString("keywords", ""); }
    static void setKeywords(Context c, String v) { sp(c).edit().putString("keywords", v.trim()).apply(); }

    static String shopUrl(Context c) { return sp(c).getString("url", ""); }
    static void setShopUrl(Context c, String v) { sp(c).edit().putString("url", Alarm.cleanUrl(v)).apply(); }

    static String people(Context c) { return sp(c).getString("people", ""); }
    static void setPeople(Context c, String v) { sp(c).edit().putString("people", v.trim()).apply(); }

    /** 내가 지정한 예약 날짜. 없거나 잘못된 값이면 null. */
    static LocalDate date(Context c) {
        String s = sp(c).getString("date", "");
        if (s.isEmpty()) return null;
        try {
            return LocalDate.parse(s);
        } catch (Exception e) {
            return null;
        }
    }
    static void setDate(Context c, LocalDate d) {
        sp(c).edit().putString("date", d == null ? "" : d.toString()).apply();
    }

    /** 내가 지정한 예약 시간 "HHmm". 없으면 "". */
    static String time(Context c) { return sp(c).getString("time", ""); }
    static void setTime(Context c, String hhmm) {
        sp(c).edit().putString("time", hhmm == null ? "" : hhmm).apply();
    }

    static int durationSec(Context c) { return sp(c).getInt("dur", 120); }
    static void setDurationSec(Context c, int v) { sp(c).edit().putInt("dur", v).apply(); }

    static String log(Context c) { return sp(c).getString("log", ""); }
    static void clearLog(Context c) { sp(c).edit().remove("log").apply(); }

    static synchronized void addLog(Context c, String msg) {
        String ts = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.KOREA).format(new Date());
        String old = log(c);
        StringBuilder sb = new StringBuilder(ts).append("  ").append(msg.replace('\n', ' '));
        if (!old.isEmpty()) sb.append('\n').append(old);
        String[] lines = sb.toString().split("\n");
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < Math.min(lines.length, LOG_MAX); i++) {
            if (i > 0) out.append('\n');
            out.append(lines[i]);
        }
        sp(c).edit().putString("log", out.toString()).apply();
    }
}
