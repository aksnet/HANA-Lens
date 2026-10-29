package com.sap.hanasupportinfo;

import java.awt.Desktop;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Implements every invoke() command from main.rs — no Tauri/Rust dependency. */
public class Commands {

    // ── Path helpers ──────────────────────────────────────────────────────────

    /** Location of the JAR / class directory (for resource lookup). */
    static File getJarDir() {
        try {
            File loc = new File(Main.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            return loc.isDirectory() ? loc : loc.getParentFile();
        } catch (Exception e) {
            return new File(".");
        }
    }

    /** %APPDATA%\com.sap.hana-lens\ (Windows) or ~/.config/com.sap.hana-lens/ (other). */
    static File getSettingsDir() {
        String appData = System.getenv("APPDATA");
        if (appData != null && !appData.isEmpty()) {
            return new File(appData, "com.sap.hana-lens");
        }
        return new File(System.getProperty("user.home"), ".config" + File.separator + "com.sap.hana-lens");
    }

    private static File getSettingsFile() {
        return new File(getSettingsDir(), "hana-lens-settings.json");
    }

    // ── Directory / file commands ─────────────────────────────────────────────

    /** List directory: [{name, kind, size, lastModified}, ...] */
    public static List<Map<String, Object>> readDir(String path) throws IOException {
        File dir = new File(path);
        File[] files = dir.listFiles();
        if (files == null) throw new IOException("Cannot list: " + path);
        List<Map<String, Object>> result = new ArrayList<>();
        for (File f : files) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", f.getName());
            entry.put("kind", f.isDirectory() ? "directory" : "file");
            if (f.isFile()) {
                entry.put("size", f.length());
                entry.put("lastModified", f.lastModified());
            } else {
                entry.put("size", null);
                entry.put("lastModified", f.lastModified());
            }
            result.add(entry);
        }
        return result;
    }

    /** Read file as UTF-8 text (lossy). */
    public static String readTextFile(String path) throws IOException {
        byte[] bytes = Files.readAllBytes(Paths.get(path));
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /** Read byte range from file as UTF-8 text. */
    public static String readFileRange(String path, long offset, long length) throws IOException {
        try (RandomAccessFile raf = new RandomAccessFile(path, "r")) {
            raf.seek(offset);
            byte[] buf = new byte[(int) Math.min(length, raf.length() - offset)];
            int read = 0;
            while (read < buf.length) {
                int n = raf.read(buf, read, buf.length - read);
                if (n < 0) break;
                read += n;
            }
            return new String(buf, 0, read, StandardCharsets.UTF_8);
        }
    }

    /** Return {size, lastModified}. */
    public static Map<String, Object> getFileMetadata(String path) throws IOException {
        File f = new File(path);
        if (!f.exists()) throw new IOException("Not found: " + path);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("size", f.length());
        m.put("lastModified", f.lastModified());
        return m;
    }

    /** Check whether path exists as given kind ("file"|"directory"). */
    public static boolean entryExists(String path, String kind) {
        File f = new File(path);
        return "file".equals(kind) ? f.isFile() : f.isDirectory();
    }

    /**
     * Check whether path is accessible within 500 ms.
     * Uses a background thread to avoid hanging on network paths.
     */
    public static boolean pathAccessible(String path) {
        ExecutorService ex = Executors.newSingleThreadExecutor();
        try {
            Future<Boolean> future = ex.submit(() -> new File(path).exists());
            return future.get(500, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            return false;
        } finally {
            ex.shutdownNow();
        }
    }

    // ── Shell / OS commands ───────────────────────────────────────────────────

    public static void openExternalUrl(String url) throws Exception {
        if (!url.startsWith("https://") && !url.startsWith("http://"))
            throw new IllegalArgumentException("Only http/https URLs supported");
        if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
            Desktop.getDesktop().browse(new URI(url));
        } else {
            Runtime.getRuntime().exec(new String[]{"rundll32", "url.dll,FileProtocolHandler", url});
        }
    }

    public static void openFolder(String path) throws Exception {
        File dir = new File(path);
        if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.OPEN)) {
            Desktop.getDesktop().open(dir);
        } else {
            Runtime.getRuntime().exec(new String[]{"explorer.exe", dir.getAbsolutePath()});
        }
    }

    // ── Filter presets ────────────────────────────────────────────────────────

    /** Read .txt filter files from filter_pre-defined/ and filter_custom/ next to the JAR or in AppData. */
    public static List<Map<String, Object>> readFilterFiles() {
        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        List<File> bases = new ArrayList<>();
        bases.add(getJarDir());
        bases.add(getSettingsDir());

        for (File base : bases) {
            for (String folder : new String[]{"filter_pre-defined", "filter_custom"}) {
                File dir = new File(base, folder);
                if (!dir.isDirectory()) continue;
                File[] files = dir.listFiles((d, n) -> n.toLowerCase(Locale.ROOT).endsWith(".txt"));
                if (files == null) continue;
                Arrays.sort(files, Comparator.comparing(File::getName));
                List<Map<String, Object>> folderItems = new ArrayList<>();
                for (File f : files) {
                    String stem = stemOf(f.getName());
                    String key = folder + "/" + stem;
                    if (!seen.add(key)) continue;
                    try {
                        String content = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).trim();
                        Map<String, Object> item = new LinkedHashMap<>();
                        item.put("name", stem);
                        item.put("source", folder);
                        item.put("content", content);
                        folderItems.add(item);
                    } catch (IOException ignored) {}
                }
                result.addAll(folderItems);
            }
        }
        return result;
    }

    private static String stemOf(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot > 0 ? filename.substring(0, dot) : filename;
    }

    // ── Filesystem reference ──────────────────────────────────────────────────

    public static String readFsReference() {
        for (File base : Arrays.asList(getJarDir(), getSettingsDir())) {
            File f = new File(base, "filesystem_reference.txt");
            if (f.isFile()) {
                try { return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }
                catch (IOException ignored) {}
            }
        }
        return null;
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    public static String readSettings() {
        File primary = getSettingsFile();
        if (primary.isFile()) {
            try { return new String(Files.readAllBytes(primary.toPath()), StandardCharsets.UTF_8); }
            catch (IOException ignored) {}
        }
        // Migration: try JAR-adjacent settings
        File legacy = new File(getJarDir(), "hana-lens-settings.json");
        if (legacy.isFile() && !legacy.equals(primary)) {
            try {
                String txt = new String(Files.readAllBytes(legacy.toPath()), StandardCharsets.UTF_8);
                writeSettings(txt); // promote to AppData
                return txt;
            } catch (IOException ignored) {}
        }
        return null;
    }

    public static void writeSettings(String content) throws IOException {
        File dir = getSettingsDir();
        if (!dir.exists() && !dir.mkdirs())
            throw new IOException("Cannot create settings directory: " + dir);
        Files.write(getSettingsFile().toPath(), content.getBytes(StandardCharsets.UTF_8));
    }

    public static String getSettingsPath() {
        return getSettingsFile().getAbsolutePath();
    }

    // ── Misc file ─────────────────────────────────────────────────────────────

    public static void writeTextFile(String path, String content) throws IOException {
        Files.write(Paths.get(path), content.getBytes(StandardCharsets.UTF_8));
    }

    // ── HanaDumpAnalyzer ──────────────────────────────────────────────────────

    public static void openInDumpAnalyzer(String dumpPath) throws Exception {
        List<File> bases = Arrays.asList(getJarDir(), getSettingsDir());
        File jar = null;
        for (File base : bases) {
            File candidate = new File(base, "SAP_HanaDumpAnalyzer" + File.separator + "HanaDumpAnalyzer.jar");
            if (candidate.isFile()) { jar = candidate; break; }
        }
        if (jar == null) throw new FileNotFoundException("HanaDumpAnalyzer.jar not found in SAP_HanaDumpAnalyzer/");

        String javaExe = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        new ProcessBuilder(javaExe, "-jar", jar.getAbsolutePath(), "-s", dumpPath)
            .inheritIO().start();
    }
}
