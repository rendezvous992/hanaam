package local.catchalarm;

import static org.junit.Assert.*;

import android.app.Application;
import android.app.DatePickerDialog;
import android.app.Dialog;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.DialogInterface;
import android.content.Intent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.lang.reflect.Field;
import java.time.Duration;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowDialog;
import org.robolectric.shadows.ShadowLooper;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE)
public class SmokeTest {
    Application app;

    @Before public void setUp() {
        app = RuntimeEnvironment.getApplication();
        Prefs.sp(app).edit().clear().commit();
        Alarm.ringing = false;
        Alarm.firedAt = 0;
        Alarm.originalIntent = null;
    }

    static Object field(Object o, String name) throws Exception {
        Field f = o.getClass().getDeclaredField(name);
        f.setAccessible(true);
        return f.get(o);
    }

    static Button button(View root, String text) {
        List<View> all = new ArrayList<>();
        collect(root, all);
        for (View v : all) if (v instanceof Button && ((Button) v).getText().toString().equals(text)) return (Button) v;
        return null;
    }

    static void collect(View v, List<View> out) {
        out.add(v);
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) collect(((ViewGroup) v).getChildAt(i), out);
    }

    @Test public void mainScreen_dateTimePickAndPreview() throws Exception {
        MainActivity a = Robolectric.buildActivity(MainActivity.class).setup().get();
        View root = a.getWindow().getDecorView();
        TextView dateView = (TextView) field(a, "dateView");
        TextView preview = (TextView) field(a, "linkPreview");
        assertEquals("지정 안 함 (알림 문구 날짜만 사용)", dateView.getText().toString());

        ((EditText) field(a, "urlEdit")).setText("라망 예약 https://app.catchtable.co.kr/ct/shop/lamang?type=DINING&from=share");
        ((EditText) field(a, "peopleEdit")).setText("2");
        button(root, "저장").performClick();
        assertEquals("https://app.catchtable.co.kr/ct/shop/lamang?type=DINING", Prefs.shopUrl(a));

        // 날짜 선택 → 달력에서 고르고 확인
        button(root, "날짜 선택").performClick();
        Dialog d = ShadowDialog.getLatestDialog();
        assertTrue(d instanceof DatePickerDialog);
        LocalDate want = Alarm.today().plusDays(4);
        ((DatePickerDialog) d).updateDate(want.getYear(), want.getMonthValue() - 1, want.getDayOfMonth());
        ((DatePickerDialog) d).getButton(DialogInterface.BUTTON_POSITIVE).performClick();
        ShadowLooper.idleMainLooper();
        assertEquals(want, Prefs.date(a));
        assertEquals(ShopLink.korean(want), dateView.getText().toString());

        Prefs.setTime(a, "1900");
        a.recreate();
        a = Robolectric.buildActivity(MainActivity.class).setup().get();
        preview = (TextView) field(a, "linkPreview");
        String p = preview.getText().toString();
        System.out.println("PREVIEW: " + p);
        assertTrue(p, p.contains("date=" + ShopLink.yymmdd(want) + "&time=1900&personCount=2"));

        // 지움
        button(a.getWindow().getDecorView(), "지움").performClick();
        assertNull(Prefs.date(a));
    }

    @Test public void testAlarm_usesFixedDate_andAlertOpensShopWithDate() throws Exception {
        Prefs.setShopUrl(app, "https://app.catchtable.co.kr/ct/shop/lamang");
        Prefs.setPeople(app, "2");
        LocalDate want = Alarm.today().plusDays(3);
        Prefs.setDate(app, want);

        MainActivity m = Robolectric.buildActivity(MainActivity.class).setup().get();
        button(m.getWindow().getDecorView(), "🔔 5초 후 테스트 알람").performClick();
        ShadowLooper.idleMainLooper(6, java.util.concurrent.TimeUnit.SECONDS);
        assertTrue(Alarm.ringing);
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        assertEquals(1, Shadows.shadowOf(nm).getAllNotifications().size());

        // 캐치테이블 원래 알림이 있어도 매장 링크(날짜 포함)를 먼저 연다
        Intent dummy = new Intent(app, MainActivity.class);
        Alarm.originalIntent = PendingIntent.getActivity(app, 9, dummy, PendingIntent.FLAG_IMMUTABLE);
        ActivityController<AlertActivity> c = Robolectric.buildActivity(AlertActivity.class, new Intent(app, AlertActivity.class)).setup();
        AlertActivity a = c.get();
        View root = a.getWindow().getDecorView();
        String target = ((TextView) field(a, "targetView")).getText().toString();
        System.out.println("TARGET: " + target);
        assertTrue(target, target.contains(ShopLink.korean(want)) && target.contains("내가 지정한 날짜"));
        assertNotNull(button(root, "캐치테이블 원래 알림 열기"));

        button(root, "▶  지금 열기").performClick();
        ShadowLooper.idleMainLooper();
        Intent started = Shadows.shadowOf(app).getNextStartedActivity();
        assertNotNull(started);
        System.out.println("OPENED: " + started.getDataString());
        assertEquals("https://app.catchtable.co.kr/ct/shop/lamang?type=DINING&date=" + ShopLink.yymmdd(want) + "&personCount=2", started.getDataString());
        assertFalse(Alarm.ringing);
    }

    @Test public void alert_textDateWins_andNoShopLinkFallsBackToOriginal() throws Exception {
        LocalDate fixed = Alarm.today().plusDays(3);
        Prefs.setDate(app, fixed);
        Alarm.trigger(app, "[캐치테이블] 라망시크레", "12월 24일 오후 7시 2명 빈자리가 났어요", Prefs.CATCHTABLE_PKG,
                PendingIntent.getActivity(app, 9, new Intent(app, MainActivity.class), PendingIntent.FLAG_IMMUTABLE));
        AlertActivity a = Robolectric.buildActivity(AlertActivity.class, new Intent(app, AlertActivity.class)).setup().get();
        String target = ((TextView) field(a, "targetView")).getText().toString();
        System.out.println("TARGET2: " + target);
        assertTrue(target, target.contains("매장 링크가 없어"));

        Prefs.setShopUrl(app, "https://app.catchtable.co.kr/ct/shop/lamang");
        a = Robolectric.buildActivity(AlertActivity.class, new Intent(app, AlertActivity.class)).setup().get();
        target = ((TextView) field(a, "targetView")).getText().toString();
        System.out.println("TARGET3: " + target);
        assertTrue(target, target.contains("12월 24일") && target.contains("19:00") && target.contains("알림 문구의 날짜"));

        // 매장 링크를 비우면 캐치테이블 원래 알림으로
        Prefs.setShopUrl(app, "");
        String how = Alarm.openPage(a);
        assertEquals("캐치테이블 알림 원래 페이지", how);
    }
}
