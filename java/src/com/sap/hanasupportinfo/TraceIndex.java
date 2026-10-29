package com.sap.hanasupportinfo;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/**
 * Thread-safe cache of indexed trace files.
 * Each file is stored as raw bytes + a line-start offset table for O(1) line access.
 * Mirrors the Rust TraceFile logic in main.rs.
 */
public class TraceIndex {

    private static final ConcurrentHashMap<String, TraceFile> CACHE = new ConcurrentHashMap<>();

    private static class TraceFile {
        final byte[] content;
        final int[]  offsets; // byte offset of each line start
        TraceFile(byte[] content, int[] offsets) {
            this.content = content;
            this.offsets = offsets;
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Index a file and return {lineCount, fileSize, firstTs, lastTs}. */
    public static Map<String, Object> open(String path) throws IOException {
        byte[] bytes = readAllBytes(path);
        int[] offsets = buildOffsets(bytes);
        TraceFile tf = new TraceFile(bytes, offsets);
        CACHE.put(path, tf);

        String firstTs = null, lastTs = null;
        for (int i = 0; i < offsets.length; i++) {
            String ts = getLineTs(tf, i);
            if (ts != null) { firstTs = ts; break; }
        }
        for (int i = offsets.length - 1; i >= 0; i--) {
            String ts = getLineTs(tf, i);
            if (ts != null) { lastTs = ts; break; }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("lineCount", (long) offsets.length);
        result.put("fileSize",  (long) bytes.length);
        result.put("firstTs",  firstTs);
        result.put("lastTs",   lastTs);
        return result;
    }

    /** Fetch lines [from .. from+count). */
    public static List<String> getLines(String path, int from, int count) throws IllegalStateException {
        TraceFile tf = getOrThrow(path);
        int end = Math.min(from + count, tf.offsets.length);
        List<String> result = new ArrayList<>(end - from);
        for (int i = from; i < end; i++) result.add(extractLine(tf, i));
        return result;
    }

    /** Fetch lines at specific (original) indices. */
    public static List<String> getLinesAt(String path, List<Long> indices) throws IllegalStateException {
        TraceFile tf = getOrThrow(path);
        List<String> result = new ArrayList<>(indices.size());
        for (Long idx : indices) result.add(extractLine(tf, idx.intValue()));
        return result;
    }

    /**
     * Case-insensitive search: return original line indices where ANY term matches.
     * Byte-level ASCII lowercasing to match Rust behavior.
     */
    public static List<Long> search(String path, List<String> terms) throws IllegalStateException {
        TraceFile tf = getOrThrow(path);
        List<byte[]> lowerTerms = new ArrayList<>();
        for (String t : terms) {
            String lt = t.toLowerCase(Locale.ROOT);
            if (!lt.isEmpty()) lowerTerms.add(lt.getBytes(StandardCharsets.UTF_8));
        }
        if (lowerTerms.isEmpty()) return Collections.emptyList();

        List<Long> matches = new ArrayList<>();
        for (int i = 0; i < tf.offsets.length; i++) {
            int start = tf.offsets[i];
            int end = (i + 1 < tf.offsets.length) ? tf.offsets[i + 1] : tf.content.length;
            if (lineMatchesAny(tf.content, start, end, lowerTerms)) {
                matches.add((long) i);
            }
        }
        return matches;
    }

    /**
     * Return original line indices whose timestamp falls within [fromTs, toTs].
     * Lines without a timestamp inherit visibility from the most recent timestamped line above.
     */
    public static List<Long> searchTimeRange(String path, String fromTs, String toTs)
            throws IllegalStateException {
        TraceFile tf = getOrThrow(path);
        byte[] from = (fromTs != null) ? fromTs.getBytes(StandardCharsets.UTF_8) : null;
        byte[] to   = (toTs   != null) ? toTs  .getBytes(StandardCharsets.UTF_8) : null;

        boolean lastVisible = (from == null);
        List<Long> matches = new ArrayList<>();

        for (int i = 0; i < tf.offsets.length; i++) {
            byte[] ts = getLineTsBytes(tf, i);
            if (ts != null) {
                boolean inRange = (from == null || compareTs(ts, from) >= 0)
                               && (to   == null || compareTs(ts, to)   <= 0);
                lastVisible = inRange;
            }
            if (lastVisible) matches.add((long) i);
        }
        return matches;
    }

    /** Remove a file from the index cache. */
    public static void close(String path) {
        CACHE.remove(path);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private static TraceFile getOrThrow(String path) {
        TraceFile tf = CACHE.get(path);
        if (tf == null) throw new IllegalStateException("File not indexed: " + path);
        return tf;
    }

    private static byte[] readAllBytes(String path) throws IOException {
        try (FileInputStream fis = new FileInputStream(path);
             ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = fis.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private static int[] buildOffsets(byte[] bytes) {
        // Mirror Rust exactly: start with [0], then add (i+1) for each '\n'
        // that is NOT the very last byte.  A trailing '\n' does NOT produce
        // an extra empty-line entry — matching Rust's `if b == '\n' && i+1 < len`.
        int count = 1;
        for (int i = 0; i < bytes.length; i++) {
            if (bytes[i] == '\n' && i + 1 < bytes.length) count++;
        }
        int[] offsets = new int[count];
        offsets[0] = 0;
        int idx = 1;
        for (int i = 0; i < bytes.length; i++) {
            if (bytes[i] == '\n' && i + 1 < bytes.length) offsets[idx++] = i + 1;
        }
        return offsets;
    }

    private static String extractLine(TraceFile tf, int idx) {
        if (idx < 0 || idx >= tf.offsets.length) return "";
        int start = tf.offsets[idx];
        int end = (idx + 1 < tf.offsets.length) ? tf.offsets[idx + 1] : tf.content.length;
        // Strip trailing \r\n or \n
        if (end > start && tf.content[end - 1] == '\n') end--;
        if (end > start && tf.content[end - 1] == '\r') end--;
        return new String(tf.content, start, end - start, StandardCharsets.UTF_8);
    }

    private static String getLineTs(TraceFile tf, int idx) {
        byte[] ts = getLineTsBytes(tf, idx);
        return ts != null ? new String(ts, StandardCharsets.UTF_8) : null;
    }

    private static byte[] getLineTsBytes(TraceFile tf, int idx) {
        if (idx >= tf.offsets.length) return null;
        int start = tf.offsets[idx];
        int limit = Math.min(start + 200, tf.content.length);
        return extractTimestamp(tf.content, start, limit);
    }

    /** Scan bytes[start..limit) for a YYYY-MM-DD[T ]HH:MM:SS pattern. */
    private static byte[] extractTimestamp(byte[] b, int start, int limit) {
        for (int i = start; i <= limit - 19; i++) {
            if (isTimestampAt(b, i)) {
                byte[] ts = new byte[19];
                System.arraycopy(b, i, ts, 0, 19);
                if (ts[10] == ' ') ts[10] = 'T'; // normalize separator
                return ts;
            }
        }
        return null;
    }

    private static boolean isTimestampAt(byte[] b, int i) {
        return b.length >= i + 19
            && isDigit(b[i])   && isDigit(b[i+1]) && isDigit(b[i+2]) && isDigit(b[i+3])
            && b[i+4]  == '-'
            && isDigit(b[i+5]) && isDigit(b[i+6])
            && b[i+7]  == '-'
            && isDigit(b[i+8]) && isDigit(b[i+9])
            && (b[i+10] == ' ' || b[i+10] == 'T')
            && isDigit(b[i+11]) && isDigit(b[i+12])
            && b[i+13] == ':'
            && isDigit(b[i+14]) && isDigit(b[i+15])
            && b[i+16] == ':'
            && isDigit(b[i+17]) && isDigit(b[i+18]);
    }

    private static boolean isDigit(byte b) { return b >= '0' && b <= '9'; }

    /** Lexicographic comparison of two 19-byte normalized timestamp arrays. */
    private static int compareTs(byte[] a, byte[] b) {
        for (int i = 0; i < 19; i++) {
            int diff = (a[i] & 0xFF) - (b[i] & 0xFF);
            if (diff != 0) return diff;
        }
        return 0;
    }

    /** Returns true if any term matches within bytes[start..end) (case-insensitive ASCII). */
    private static boolean lineMatchesAny(byte[] content, int start, int end, List<byte[]> terms) {
        int len = end - start;
        if (len <= 0) return false;
        // Build lowercase copy of the line
        byte[] lower = new byte[len];
        for (int i = 0; i < len; i++) {
            byte b = content[start + i];
            lower[i] = (b >= 'A' && b <= 'Z') ? (byte)(b | 0x20) : b;
        }
        for (byte[] term : terms) {
            if (term.length > len) continue;
            outer:
            for (int i = 0; i <= len - term.length; i++) {
                for (int j = 0; j < term.length; j++) {
                    if (lower[i + j] != term[j]) continue outer;
                }
                return true;
            }
        }
        return false;
    }
}
