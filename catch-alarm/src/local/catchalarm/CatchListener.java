package local.catchalarm;

import android.app.Notification;
import android.content.ComponentName;
import android.os.Bundle;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.LinkedHashMap;
import java.util.Map;

public class CatchListener extends NotificationListenerService {
    static volatile boolean connected;

    private static final Map<String, Long> SEEN = new LinkedHashMap<String, Long>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Long> eldest) {
            return size() > 100;
        }
    };
    private static String lastBody = "";
    private static long lastBodyAt;

    @Override public void onListenerConnected() {
        connected = true;
        Prefs.addLog(this, "감시 연결됨");
    }

    @Override public void onListenerDisconnected() {
        connected = false;
        Prefs.addLog(this, "감시 끊김 → 재연결 요청");
        try {
            requestRebind(new ComponentName(this, CatchListener.class));
        } catch (Exception ignored) {
        }
    }

    @Override public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            handle(sbn);
        } catch (Exception e) {
            Prefs.addLog(this, "오류: " + e);
        }
    }

    private void handle(StatusBarNotification sbn) {
        String pkg = sbn.getPackageName();
        boolean catchtable = Alarm.isCatchtable(pkg);
        boolean kakao = Prefs.KAKAO_PKG.equals(pkg);
        if (!catchtable && !kakao) return;
        if (!Prefs.enabled(this)) return;
        Notification n = sbn.getNotification();
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;

        Bundle ex = n.extras;
        String title = str(ex, Notification.EXTRA_TITLE);
        String sub = str(ex, Notification.EXTRA_SUB_TEXT);
        String conv = str(ex, Notification.EXTRA_CONVERSATION_TITLE);
        String body = str(ex, Notification.EXTRA_BIG_TEXT);
        if (body.isEmpty()) body = str(ex, Notification.EXTRA_TEXT);
        String sender = "";
        Parcelable[] msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (msgs != null && msgs.length > 0 && msgs[msgs.length - 1] instanceof Bundle) {
            Bundle last = (Bundle) msgs[msgs.length - 1];
            CharSequence mt = last.getCharSequence("text");
            CharSequence ms = last.getCharSequence("sender");
            if (mt != null && body.isEmpty()) body = mt.toString();
            if (ms != null) sender = ms.toString();
        }

        if (kakao) {
            if (!Prefs.watchKakao(this)) return;
            if (!squash(title + "|" + sub + "|" + conv + "|" + sender).contains("캐치테이블")) return;
        } else if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) {
            return;
        }

        String src = kakao ? "카톡" : "캐치";
        String all = title + " " + body;
        String shown = clip(title + " / " + body, 70);
        if (all.contains("(광고)") || all.contains("[광고]")) {
            Prefs.addLog(this, src + " 광고 무시: " + shown);
            return;
        }
        String kw = Prefs.keywords(this);
        if (!kw.isEmpty() && !matchesAny(all, kw)) {
            Prefs.addLog(this, src + " 키워드 불일치: " + shown);
            return;
        }

        String key = pkg + "|" + n.when + "|" + body.hashCode();
        long now = System.currentTimeMillis();
        if (SEEN.containsKey(key)) return;
        SEEN.put(key, now);
        if (body.equals(lastBody) && now - lastBodyAt < 15000) return;
        lastBody = body;
        lastBodyAt = now;
        Prefs.addLog(this, src + " ★알람: " + shown);
        Alarm.trigger(this, title, body, pkg, n.contentIntent);
    }

    private static boolean matchesAny(String text, String keywords) {
        String s = squash(text);
        for (String k : keywords.split("[,，]")) {
            String q = squash(k);
            if (!q.isEmpty() && s.contains(q)) return true;
        }
        return false;
    }

    private static String squash(String s) {
        return s.replaceAll("\\s+", "").toLowerCase();
    }

    private static String str(Bundle b, String key) {
        CharSequence cs = b.getCharSequence(key);
        return cs != null ? cs.toString() : "";
    }

    private static String clip(String s, int max) {
        return s.length() > max ? s.substring(0, max) + "…" : s;
    }
}
