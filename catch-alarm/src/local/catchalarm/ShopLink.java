package local.catchalarm;

import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 캐치테이블 매장 링크에 예약 날짜·시간·인원을 붙인다. */
final class ShopLink {
    private static final Pattern DATE = Pattern.compile(
            "(?<![0-9])(?:(20[0-9]{2})\\s*[년./-]\\s*)?([0-9]{1,2})\\s*[월./-]\\s*([0-9]{1,2})(?:\\s*일)?(?![0-9])");
    private static final Pattern TIME_COLON = Pattern.compile(
            "(?<![0-9])(?:(오전|오후)\\s*)?([0-9]{1,2}):([0-9]{2})(?![0-9])");
    private static final Pattern TIME_KO = Pattern.compile(
            "(?:(오전|오후)\\s*)?(?<![0-9])([0-9]{1,2})\\s*시(?:\\s*([0-9]{1,2})\\s*분|\\s*(반))?");
    private static final Pattern PEOPLE = Pattern.compile(
            "(?<![0-9])([0-9]{1,2})\\s*(?:명|인(?![가-힣]))");
    private static final String[] DOW = {"월", "화", "수", "목", "금", "토", "일"};

    private ShopLink() {}

    /** 매장 화면에 넣을 조건. */
    static final class Target {
        LocalDate date;
        boolean dateFromText;
        String time;   // HHmm, date 가 있을 때만
        String people;

        String describe() {
            StringBuilder sb = new StringBuilder();
            if (date != null) {
                sb.append(korean(date));
                if (time != null) sb.append(' ').append(time, 0, 2).append(':').append(time, 2, 4);
            }
            if (people != null) {
                if (sb.length() > 0) sb.append(" · ");
                sb.append(people).append("명");
            }
            return sb.toString();
        }
    }

    /**
     * 날짜: 알림 문구에 있으면 그 날짜, 없으면 내가 지정한 날짜(지난 날짜는 무시).
     * 알람이 온 날(오늘)은 넣지 않는다.
     */
    static Target target(String text, String fixedPeople, LocalDate fixedDate, String fixedTime, LocalDate today) {
        if (text == null) text = "";
        Target t = new Target();
        t.date = parseDate(text, today);
        t.dateFromText = t.date != null;
        if (t.date == null && fixedDate != null && !fixedDate.isBefore(today)) t.date = fixedDate;
        String tm = parseTime(text);
        if (tm == null && fixedTime != null && fixedTime.matches("[0-9]{4}")) tm = fixedTime;
        t.time = t.date != null ? tm : null;
        t.people = parsePeople(text);
        if (t.people == null && fixedPeople != null && fixedPeople.trim().matches("[0-9]{1,2}")) {
            t.people = fixedPeople.trim();
        }
        return t;
    }

    static String build(String url, Target t) {
        if (url == null || !url.contains("/ct/shop/")) return url;
        String u = url.replaceAll("([?&])(date|time|personCount)=[^&#]*", "$1")
                .replaceAll("\\?[?&]+", "?")
                .replaceAll("&{2,}", "&")
                .replaceAll("[?&]$", "");
        if (!u.matches(".*[?&]type=[^&]*.*")) u = add(u, "type", "DINING");
        if (t.date != null) u = add(u, "date", yymmdd(t.date));
        if (t.date != null && t.time != null) u = add(u, "time", t.time);
        if (t.people != null) u = add(u, "personCount", t.people);
        return u;
    }

    static String yymmdd(LocalDate d) {
        return String.format("%02d%02d%02d", d.getYear() % 100, d.getMonthValue(), d.getDayOfMonth());
    }

    static String korean(LocalDate d) {
        return d.getMonthValue() + "월 " + d.getDayOfMonth() + "일 (" + DOW[d.getDayOfWeek().getValue() - 1] + ")";
    }

    private static String add(String url, String key, String value) {
        return url + (url.contains("?") ? "&" : "?") + key + "=" + value;
    }

    static LocalDate parseDate(String text, LocalDate today) {
        Matcher m = DATE.matcher(text);
        while (m.find()) {
            int month = Integer.parseInt(m.group(2));
            int day = Integer.parseInt(m.group(3));
            if (month < 1 || month > 12 || day < 1 || day > 31) continue;
            int year = m.group(1) != null ? Integer.parseInt(m.group(1)) : today.getYear();
            LocalDate d;
            try {
                d = LocalDate.of(year, month, day);
            } catch (DateTimeException e) {
                continue;
            }
            if (m.group(1) == null && d.isBefore(today)) d = d.plusYears(1);
            return d;
        }
        return null;
    }

    static String parseTime(String text) {
        Matcher m = TIME_COLON.matcher(text);
        if (m.find()) {
            return hhmm(m.group(1), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
        }
        m = TIME_KO.matcher(text);
        if (m.find()) {
            int min = m.group(3) != null ? Integer.parseInt(m.group(3)) : (m.group(4) != null ? 30 : 0);
            return hhmm(m.group(1), Integer.parseInt(m.group(2)), min);
        }
        return null;
    }

    static String parsePeople(String text) {
        Matcher m = PEOPLE.matcher(text);
        while (m.find()) {
            int n = Integer.parseInt(m.group(1));
            if (n >= 1 && n <= 20) return String.valueOf(n);
        }
        return null;
    }

    private static String hhmm(String ampm, int h, int min) {
        if ("오후".equals(ampm) && h < 12) h += 12;
        if ("오전".equals(ampm) && h == 12) h = 0;
        if (h > 23 || min > 59) return null;
        return String.format("%02d%02d", h, min);
    }
}
