package local.catchalarm;

import java.time.LocalDate;

public class ShopLinkTest {
    static int fail = 0, n = 0;
    static void eq(String what, Object got, Object want) {
        n++;
        boolean ok = want == null ? got == null : want.equals(got);
        if (!ok) { fail++; System.out.println("FAIL " + what + "\n  got:  " + got + "\n  want: " + want); }
    }
    public static void main(String[] a) {
        LocalDate today = LocalDate.of(2026, 10, 11);
        LocalDate fixed = LocalDate.of(2026, 10, 15);
        String shop = "https://app.catchtable.co.kr/ct/shop/lamang";

        // 1) 알림 문구에 날짜가 없으면 지정한 날짜
        ShopLink.Target t = ShopLink.target("[캐치테이블] 라망시크레 빈자리가 생겼어요", "2", fixed, "1900", today);
        eq("fixed date used", t.date, fixed);
        eq("fixed flag", t.dateFromText, false);
        eq("fixed url", ShopLink.build(shop, t), shop + "?type=DINING&date=261015&time=1900&personCount=2");
        eq("describe", t.describe(), "10월 15일 (목) 19:00 · 2명");

        // 2) 알림 문구 날짜가 우선
        t = ShopLink.target("10월 20일 오후 6시 반 4명 빈자리", "2", fixed, "1900", today);
        eq("text date", t.date, LocalDate.of(2026, 10, 20));
        eq("text flag", t.dateFromText, true);
        eq("text url", ShopLink.build(shop, t), shop + "?type=DINING&date=261020&time=1830&personCount=4");

        // 3) 지정 안 함 + 문구 날짜 없음 → 날짜 안 넣음 (오늘 날짜 넣지 않음)
        t = ShopLink.target("빈자리 알림", "", null, "", today);
        eq("no date", t.date, null);
        eq("no date url", ShopLink.build(shop, t), shop + "?type=DINING");
        eq("no date describe", t.describe(), "");

        // 4) 지난 지정 날짜는 무시
        t = ShopLink.target("빈자리", "2", LocalDate.of(2026, 10, 1), "1900", today);
        eq("past fixed ignored", t.date, null);
        eq("past fixed url", ShopLink.build(shop, t), shop + "?type=DINING&personCount=2");

        // 5) 오늘 지정은 유효
        t = ShopLink.target("빈자리", "", today, "", today);
        eq("today fixed", ShopLink.build(shop, t), shop + "?type=DINING&date=261011");

        // 6) 시간만 지정하고 날짜 없으면 시간 안 넣음
        t = ShopLink.target("빈자리", "", null, "1900", today);
        eq("time without date", ShopLink.build(shop, t), shop + "?type=DINING");

        // 7) 기존 쿼리 정리: date/time/personCount 교체, 다른 파라미터 유지
        String messy = shop + "?type=DINING&date=250101&time=1200&personCount=3&ref=abc";
        t = ShopLink.target("", "2", fixed, "", today);
        eq("messy", ShopLink.build(messy, t), shop + "?type=DINING&ref=abc&date=261015&personCount=2");
        String messy2 = shop + "?date=250101&type=DINING";
        eq("messy2", ShopLink.build(messy2, t), shop + "?type=DINING&date=261015&personCount=2");
        String messy3 = shop + "?date=250101&time=1&personCount=2";
        eq("messy3", ShopLink.build(messy3, t), shop + "?type=DINING&date=261015&personCount=2");

        // 8) 매장 링크 아닌 건 그대로
        eq("non shop", ShopLink.build("https://app.catchtable.co.kr/", t), "https://app.catchtable.co.kr/");

        // 9) 지난 월일은 내년으로
        eq("rollover", ShopLink.parseDate("1월 3일", today), LocalDate.of(2027, 1, 3));
        eq("explicit year", ShopLink.parseDate("2026.12.24", today), LocalDate.of(2026, 12, 24));
        eq("invalid day skipped", ShopLink.parseDate("2월 30일 / 11/2", today), LocalDate.of(2026, 11, 2));
        eq("time colon pm", ShopLink.parseTime("오후 7:30"), "1930");
        eq("time ko", ShopLink.parseTime("오전 12시"), "0000");
        eq("people", ShopLink.parsePeople("2인 예약"), "2");
        eq("korean", ShopLink.korean(LocalDate.of(2026, 10, 18)), "10월 18일 (일)");
        eq("yymmdd", ShopLink.yymmdd(LocalDate.of(2027, 1, 3)), "270103");

        System.out.println(n - fail + "/" + n + " passed");
        if (fail > 0) System.exit(1);
    }
}
