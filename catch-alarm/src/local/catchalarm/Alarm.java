package local.catchalarm;

import android.app.Activity;
import android.app.ActivityOptions;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class Alarm {
    static final String CHANNEL = "catch_alarm_v1";
    static final int NOTI_ID = 4242;
    private static final int PI_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    private static final int RED = 0xFFD50000;

    private static final Handler H = new Handler(Looper.getMainLooper());
    private static final Pattern URL = Pattern.compile("https?://[\\w\\-._~:/?#\\[\\]@!$&'()*+,;=%]+");

    static volatile boolean ringing;
    static volatile long firedAt;
    static volatile String title = "";
    static volatile String text = "";
    static volatile String sourcePkg = "";
    static volatile PendingIntent originalIntent;

    private static Context appCtx;
    private static Ringtone ringtone;
    private static Vibrator vibrator;
    private static int savedAlarmVolume = -1;
    private static String torchId;
    private static boolean torchOn;

    private static final Runnable AUTO_STOP = new Runnable() {
        @Override public void run() {
            if (appCtx != null) silence(appCtx);
        }
    };

    private static final Runnable TORCH_TICK = new Runnable() {
        @Override public void run() {
            if (!ringing || torchId == null || appCtx == null) return;
            torchOn = !torchOn;
            setTorch(appCtx, torchOn);
            H.postDelayed(this, 300);
        }
    };

    private Alarm() {}

    static boolean isCatchtable(String pkg) {
        return pkg != null && pkg.toLowerCase().contains("catchtable");
    }

    static LocalDate today() {
        return LocalDate.now(ZoneId.of("Asia/Seoul"));
    }

    /** 지금 울린 알림 + 내가 지정한 날짜·시간·인원으로 매장 화면에 넣을 조건. */
    static ShopLink.Target target(Context c) {
        return ShopLink.target(title + " " + text, Prefs.people(c), Prefs.date(c), Prefs.time(c), today());
    }

    static synchronized void trigger(Context ctx, String t, String body, String pkg, PendingIntent orig) {
        Context c = ctx.getApplicationContext();
        appCtx = c;
        title = t != null ? t : "";
        text = body != null ? body : "";
        sourcePkg = pkg != null ? pkg : "";
        originalIntent = orig;
        firedAt = System.currentTimeMillis();
        if (!ringing) {
            ringing = true;
            startSound(c);
            startVibration(c);
            if (Prefs.torch(c)) startTorch(c);
        }
        postNotification(c);
        if (Settings.canDrawOverlays(c)) {
            try {
                c.startActivity(alertIntent(c, false).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
            }
        }
        H.removeCallbacks(AUTO_STOP);
        H.postDelayed(AUTO_STOP, Math.max(10, Prefs.durationSec(c)) * 1000L);
    }

    /** 소리·진동·플래시만 끄고 알림은 남긴다. */
    static synchronized void silence(Context ctx) {
        Context c = ctx.getApplicationContext();
        ringing = false;
        H.removeCallbacks(AUTO_STOP);
        H.removeCallbacks(TORCH_TICK);
        try {
            if (ringtone != null) ringtone.stop();
        } catch (Exception ignored) {
        }
        ringtone = null;
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Exception ignored) {
        }
        vibrator = null;
        if (torchId != null) {
            setTorch(c, false);
            torchId = null;
            torchOn = false;
        }
        if (savedAlarmVolume >= 0) {
            try {
                ((AudioManager) c.getSystemService(Context.AUDIO_SERVICE))
                        .setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVolume, 0);
            } catch (Exception ignored) {
            }
            savedAlarmVolume = -1;
        }
        if (firedAt > 0) postNotification(c);
    }

    static synchronized void stop(Context c) {
        silence(c);
        NotificationManager nm = (NotificationManager) c.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTI_ID);
    }

    static Intent alertIntent(Context c, boolean open) {
        return new Intent(c, AlertActivity.class)
                .putExtra(AlertActivity.EXTRA_OPEN, open)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    static void ensureChannel(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "캐치테이블 알람", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("캐치테이블 알림이 오면 전체화면으로 크게 알립니다");
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setBypassDnd(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    @SuppressWarnings("deprecation")
    private static void postNotification(Context c) {
        ensureChannel(c);
        PendingIntent full = PendingIntent.getActivity(c, 1, alertIntent(c, false), PI_FLAGS);
        PendingIntent open = PendingIntent.getActivity(c, 2, alertIntent(c, true), PI_FLAGS);
        PendingIntent stop = PendingIntent.getBroadcast(c, 3, new Intent(c, StopReceiver.class), PI_FLAGS);
        String head = ringing ? "🔔 캐치테이블 알림!" : "캐치테이블 알림 (소리 꺼짐)";
        String body = title.isEmpty() ? text : title + " · " + text;
        Notification.Builder b = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(head)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body + "\n\n탭하면 캐치테이블 페이지로 이동"))
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setOnlyAlertOnce(!ringing)
                .setWhen(firedAt)
                .setShowWhen(true)
                .addAction(new Notification.Action.Builder(0, "▶ 페이지 열기", open).build())
                .addAction(new Notification.Action.Builder(0, ringing ? "알람 끄기" : "닫기", stop).build());
        if (ringing) {
            b.setFullScreenIntent(full, true).setOngoing(true).setColor(RED).setColorized(true);
        }
        try {
            ((NotificationManager) c.getSystemService(NotificationManager.class)).notify(NOTI_ID, b.build());
        } catch (SecurityException ignored) {
        }
    }

    /**
     * '지금 열기'. 날짜가 들어가는 매장 링크를 먼저 쓴다.
     * 1) 알림 속 캐치테이블 매장 링크 2) 설정한 매장 링크 3) 캐치테이블 원래 알림
     * 4) 알림 속 다른 링크 5) 캐치테이블 앱
     */
    static String openPage(Activity a) {
        PendingIntent orig = originalIntent;
        ShopLink.Target t = target(a);
        Matcher m = URL.matcher(title + " " + text);
        String textUrl = m.find() ? m.group() : null;

        if (textUrl != null && textUrl.contains("/ct/shop/")) {
            String link = ShopLink.build(cleanUrl(textUrl), t);
            Prefs.addLog(a, "열기 링크: " + link);
            String how = openUrl(a, link);
            if (how != null) return "알림 속 매장 링크" + withWhat(t) + " → " + how;
        }

        String shop = Prefs.shopUrl(a);
        if (!shop.isEmpty()) {
            String link = ShopLink.build(shop, t);
            Prefs.addLog(a, "열기 링크: " + link);
            String how = openUrl(a, link);
            if (how != null) return "설정한 매장 링크" + withWhat(t) + " → " + how;
        }

        if (isCatchtable(sourcePkg) && orig != null && sendPending(a, orig)) {
            return "캐치테이블 알림 원래 페이지";
        }

        if (textUrl != null && !textUrl.contains("/ct/shop/")) {
            String how = openUrl(a, textUrl);
            if (how != null) return "알림 속 링크 → " + how;
        }

        String pkg = isCatchtable(sourcePkg) ? sourcePkg : Prefs.CATCHTABLE_PKG;
        Intent launch = a.getPackageManager().getLaunchIntentForPackage(pkg);
        if (launch == null && !pkg.equals(Prefs.CATCHTABLE_PKG)) {
            launch = a.getPackageManager().getLaunchIntentForPackage(Prefs.CATCHTABLE_PKG);
        }
        if (launch != null) {
            try {
                a.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return "캐치테이블 앱";
            } catch (Exception ignored) {
            }
        }
        if (orig != null && sendPending(a, orig)) return "원래 알림";
        viewUrl(a, "https://app.catchtable.co.kr/");
        return "캐치테이블 웹";
    }

    private static String withWhat(ShopLink.Target t) {
        String d = t.describe();
        return d.isEmpty() ? "" : "(" + d + ")";
    }

    static boolean openOriginal(Activity a) {
        PendingIntent orig = originalIntent;
        return orig != null && sendPending(a, orig);
    }

    static String openUrl(Activity a, String raw) {
        String url = cleanUrl(raw);
        if (url.isEmpty()) return null;
        final Intent app = new Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .setPackage(Prefs.CATCHTABLE_PKG)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        boolean appOk = app.resolveActivity(a.getPackageManager()) != null;
        boolean warm = appOk && Prefs.warmup(a);
        if (warm && !Settings.canDrawOverlays(a)) {
            try {
                a.startActivity(app);
                return "캐치테이블 앱 (먼저 깨우기는 '다른 앱 위에 표시' 권한 필요)";
            } catch (Exception ignored) {
            }
        }
        if (warm) {
            Intent launch = a.getPackageManager().getLaunchIntentForPackage(Prefs.CATCHTABLE_PKG);
            if (launch != null) {
                try {
                    a.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    final Context c = a.getApplicationContext();
                    H.postDelayed(new Runnable() {
                        @Override public void run() {
                            try {
                                c.startActivity(app);
                            } catch (Exception ignored) {
                            }
                        }
                    }, Prefs.warmupMs(a));
                    return "캐치테이블 앱(깨운 뒤 매장)";
                } catch (Exception ignored) {
                }
            }
        }
        if (appOk) {
            try {
                a.startActivity(app);
                return "캐치테이블 앱";
            } catch (Exception ignored) {
            }
        }
        return viewUrl(a, url) ? "브라우저" : null;
    }

    static boolean viewUrl(Activity a, String url) {
        try {
            a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean sendPending(Activity a, PendingIntent pi) {
        try {
            Bundle opts = null;
            if (Build.VERSION.SDK_INT >= 34) {
                ActivityOptions o = ActivityOptions.makeBasic();
                o.setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                opts = o.toBundle();
            }
            pi.send(a, 0, null, null, null, null, opts);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static String cleanUrl(String s) {
        Matcher m = URL.matcher(s != null ? s : "");
        if (m.find()) {
            return m.group().replaceAll("([?&])from=share(&|$)", "$1").replaceAll("[?&]$", "");
        }
        return s != null ? s.trim() : "";
    }

    private static AudioAttributes alarmAttrs() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
    }

    private static void startSound(Context c) {
        try {
            AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
            if (Prefs.maxVolume(c) && am != null) {
                savedAlarmVolume = am.getStreamVolume(AudioManager.STREAM_ALARM);
                am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
            }
        } catch (Exception e) {
            savedAlarmVolume = -1;
        }
        try {
            Uri uri = RingtoneManager.getActualDefaultRingtoneUri(c, RingtoneManager.TYPE_ALARM);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            Ringtone r = RingtoneManager.getRingtone(c, uri);
            if (r == null) r = RingtoneManager.getRingtone(c, Settings.System.DEFAULT_RINGTONE_URI);
            if (r == null) return;
            r.setAudioAttributes(alarmAttrs());
            r.setLooping(true);
            r.play();
            ringtone = r;
        } catch (Exception ignored) {
        }
    }

    private static void startVibration(Context c) {
        try {
            Vibrator v = (Vibrator) c.getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            VibrationEffect e = VibrationEffect.createWaveform(
                    new long[]{0, 1000, 300, 1000, 300, 300, 200, 300, 600}, 0);
            if (Build.VERSION.SDK_INT >= 33) {
                v.vibrate(e, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM));
            } else {
                v.vibrate(e, alarmAttrs());
            }
            vibrator = v;
        } catch (Exception ignored) {
        }
    }

    private static void startTorch(Context c) {
        try {
            CameraManager cm = (CameraManager) c.getSystemService(Context.CAMERA_SERVICE);
            for (String id : cm.getCameraIdList()) {
                if (Boolean.TRUE.equals(cm.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE))) {
                    torchId = id;
                    break;
                }
            }
        } catch (Exception e) {
            torchId = null;
            return;
        }
        if (torchId != null) H.post(TORCH_TICK);
    }

    private static void setTorch(Context c, boolean on) {
        try {
            ((CameraManager) c.getSystemService(Context.CAMERA_SERVICE)).setTorchMode(torchId, on);
        } catch (Exception ignored) {
        }
    }
}
