package com.sap.hanasupportinfo;

import java.util.*;

/** Minimal JSON parser and builder — no external dependencies, Java 8 compatible. */
public class Json {

    // ── Parser ────────────────────────────────────────────────────────────────

    private static int skipWs(String s, int i) {
        while (i < s.length() && s.charAt(i) <= ' ') i++;
        return i;
    }

    private static Object parseValue(String s, int[] pos) {
        pos[0] = skipWs(s, pos[0]);
        if (pos[0] >= s.length()) return null;
        char c = s.charAt(pos[0]);
        if (c == '"')  return parseString(s, pos);
        if (c == '{')  return parseObj(s, pos);
        if (c == '[')  return parseArr(s, pos);
        if (s.startsWith("true",  pos[0])) { pos[0] += 4; return Boolean.TRUE; }
        if (s.startsWith("false", pos[0])) { pos[0] += 5; return Boolean.FALSE; }
        if (s.startsWith("null",  pos[0])) { pos[0] += 4; return null; }
        if (c == '-' || (c >= '0' && c <= '9')) return parseNum(s, pos);
        return null;
    }

    private static String parseString(String s, int[] pos) {
        pos[0]++; // skip opening "
        StringBuilder sb = new StringBuilder();
        while (pos[0] < s.length()) {
            char c = s.charAt(pos[0]++);
            if (c == '"') break;
            if (c == '\\' && pos[0] < s.length()) {
                char e = s.charAt(pos[0]++);
                switch (e) {
                    case '"':  sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/':  sb.append('/'); break;
                    case 'b':  sb.append('\b'); break;
                    case 'f':  sb.append('\f'); break;
                    case 'n':  sb.append('\n'); break;
                    case 'r':  sb.append('\r'); break;
                    case 't':  sb.append('\t'); break;
                    case 'u':
                        if (pos[0] + 4 <= s.length()) {
                            try { sb.append((char) Integer.parseInt(s.substring(pos[0], pos[0]+4), 16)); }
                            catch (NumberFormatException ex) { sb.append('?'); }
                            pos[0] += 4;
                        }
                        break;
                    default: sb.append(e);
                }
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static Number parseNum(String s, int[] pos) {
        int start = pos[0];
        while (pos[0] < s.length()) {
            char c = s.charAt(pos[0]);
            if (c == ',' || c == '}' || c == ']' || c <= ' ') break;
            pos[0]++;
        }
        String num = s.substring(start, pos[0]);
        if (num.contains(".") || num.contains("e") || num.contains("E")) {
            return Double.parseDouble(num);
        }
        try { return Long.parseLong(num); }
        catch (NumberFormatException ex) { return Double.parseDouble(num); }
    }

    private static Map<String, Object> parseObj(String s, int[] pos) {
        pos[0]++; // skip {
        Map<String, Object> map = new LinkedHashMap<>();
        while (pos[0] < s.length()) {
            pos[0] = skipWs(s, pos[0]);
            if (pos[0] >= s.length()) break;
            char c = s.charAt(pos[0]);
            if (c == '}') { pos[0]++; break; }
            if (c == ',') { pos[0]++; continue; }
            if (c != '"') { pos[0]++; continue; }
            String key = parseString(s, pos);
            pos[0] = skipWs(s, pos[0]);
            if (pos[0] < s.length() && s.charAt(pos[0]) == ':') pos[0]++;
            Object val = parseValue(s, pos);
            if (key != null) map.put(key, val);
        }
        return map;
    }

    private static List<Object> parseArr(String s, int[] pos) {
        pos[0]++; // skip [
        List<Object> list = new ArrayList<>();
        while (pos[0] < s.length()) {
            pos[0] = skipWs(s, pos[0]);
            if (pos[0] >= s.length()) break;
            char c = s.charAt(pos[0]);
            if (c == ']') { pos[0]++; break; }
            if (c == ',') { pos[0]++; continue; }
            list.add(parseValue(s, pos));
        }
        return list;
    }

    /** Parse a JSON string into Map<String,Object>. Returns empty map on failure. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String s) {
        if (s == null || s.trim().isEmpty()) return new HashMap<>();
        s = s.trim();
        if (!s.startsWith("{")) return new HashMap<>();
        int[] pos = {0};
        try { return parseObj(s, pos); } catch (Exception e) { return new HashMap<>(); }
    }

    // ── Builder ───────────────────────────────────────────────────────────────

    /** Serialize any value (String, Number, Boolean, null, Map, List) to JSON. */
    @SuppressWarnings("unchecked")
    public static String stringify(Object value) {
        if (value == null) return "null";
        if (value instanceof Boolean) return value.toString();
        if (value instanceof Number) {
            String s = value.toString();
            if (s.endsWith(".0")) s = s.substring(0, s.length() - 2);
            return s;
        }
        if (value instanceof String) return escapeString((String) value);
        if (value instanceof Map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) value).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(escapeString(e.getKey().toString())).append(':').append(stringify(e.getValue()));
            }
            return sb.append('}').toString();
        }
        if (value instanceof List) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object item : (List<?>) value) {
                if (!first) sb.append(',');
                first = false;
                sb.append(stringify(item));
            }
            return sb.append(']').toString();
        }
        return escapeString(value.toString());
    }

    private static String escapeString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                default:
                    if (c < 0x20) { sb.append(String.format("\\u%04x", (int) c)); }
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /** Convenience: get a String arg from parsed args map, trying multiple key names. */
    public static String str(Map<String, Object> args, String... keys) {
        for (String k : keys) {
            Object v = args.get(k);
            if (v != null) return v.toString();
        }
        return null;
    }

    /** Convenience: get a long arg from parsed args map. */
    public static long lng(Map<String, Object> args, String... keys) {
        for (String k : keys) {
            Object v = args.get(k);
            if (v instanceof Number) return ((Number) v).longValue();
        }
        return 0L;
    }
}
