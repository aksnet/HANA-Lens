package com.sap.hanasupportinfo;

import com.sun.net.httpserver.*;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import javax.swing.*;

/** Embedded HTTP server that serves the web UI and handles invoke() API calls. */
@SuppressWarnings("restriction")
public class HanaLensServer {

    private final HttpServer httpServer;

    public HanaLensServer(int port) throws IOException {
        httpServer = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 32);
        httpServer.setExecutor(Executors.newFixedThreadPool(6));

        // POST /invoke/{command}  — all backend commands
        httpServer.createContext("/invoke/", this::handleInvoke);

        // GET /dialog/open-directory  — native directory picker
        httpServer.createContext("/dialog/open-directory", this::handleOpenDir);

        // GET /dialog/open-file  — native file picker
        httpServer.createContext("/dialog/open-file", this::handleOpenFile);

        // GET /* — static web resources bundled inside the JAR
        httpServer.createContext("/", this::handleStatic);
    }

    public void start()  { httpServer.start(); }
    public void stop()   { httpServer.stop(0); }
    public int getPort() { return httpServer.getAddress().getPort(); }

    // ── Static file serving ───────────────────────────────────────────────────

    private void handleStatic(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod()) &&
            !"HEAD".equalsIgnoreCase(ex.getRequestMethod())) {
            sendError(ex, 405, "Method Not Allowed");
            return;
        }
        String path = ex.getRequestURI().getPath();
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        // Strip query string that might be appended
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);

        String resourcePath = "/web" + path;
        try (InputStream stream = HanaLensServer.class.getResourceAsStream(resourcePath)) {
            if (stream == null) {
                sendError(ex, 404, "Not found: " + path);
                return;
            }
            byte[] body = readAllBytes(stream);
            String mime = mimeType(path);
            ex.getResponseHeaders().set("Content-Type", mime);
            ex.getResponseHeaders().set("Cache-Control", "no-cache");
            ex.sendResponseHeaders(200, body.length);
            if (!"HEAD".equalsIgnoreCase(ex.getRequestMethod())) {
                try (OutputStream os = ex.getResponseBody()) { os.write(body); }
            } else {
                ex.getResponseBody().close();
            }
        }
    }

    // ── Invoke dispatcher ─────────────────────────────────────────────────────

    private void handleInvoke(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            sendError(ex, 405, "POST required");
            return;
        }
        String command = ex.getRequestURI().getPath().replaceFirst("^/invoke/", "");
        String body = readBody(ex);
        Map<String, Object> args = Json.parseObject(body);

        try {
            String response = dispatch(command, args);
            sendJson(ex, 200, response != null ? response : "null");
        } catch (IllegalStateException e) {
            sendError(ex, 500, e.getMessage());
        } catch (Exception e) {
            sendError(ex, 500, e.getMessage() != null ? e.getMessage() : e.getClass().getName());
        }
    }

    @SuppressWarnings("unchecked")
    private String dispatch(String cmd, Map<String, Object> a) throws Exception {
        switch (cmd) {
            // ── File / directory ─────────────────────────────────────────────
            case "read_dir":
                return Json.stringify(Commands.readDir(Json.str(a, "path")));
            case "read_text_file":
                return Json.stringify(Commands.readTextFile(Json.str(a, "path")));
            case "read_file_range":
                return Json.stringify(Commands.readFileRange(
                    Json.str(a, "path"),
                    Json.lng(a, "offset"),
                    Json.lng(a, "length")));
            case "get_file_metadata":
                return Json.stringify(Commands.getFileMetadata(Json.str(a, "path")));
            case "entry_exists":
                return Json.stringify(Commands.entryExists(Json.str(a, "path"), Json.str(a, "kind")));
            case "path_accessible":
                return Json.stringify(Commands.pathAccessible(Json.str(a, "path")));
            case "write_text_file":
                Commands.writeTextFile(Json.str(a, "path"), Json.str(a, "content"));
                return "null";

            // ── Shell / OS ───────────────────────────────────────────────────
            case "open_external_url":
                Commands.openExternalUrl(Json.str(a, "url"));
                return "null";
            case "open_folder":
                Commands.openFolder(Json.str(a, "path"));
                return "null";
            case "open_in_dump_analyzer":
                Commands.openInDumpAnalyzer(Json.str(a, "dumpPath", "dump_path"));
                return "null";

            // ── Filter presets / reference ────────────────────────────────────
            case "read_filter_files":
                return Json.stringify(Commands.readFilterFiles());
            case "read_fs_reference": {
                String ref = Commands.readFsReference();
                return ref != null ? Json.stringify(ref) : "null";
            }

            // ── Settings ─────────────────────────────────────────────────────
            case "read_settings": {
                String s = Commands.readSettings();
                return s != null ? Json.stringify(s) : "null";
            }
            case "write_settings":
                Commands.writeSettings(Json.str(a, "content"));
                return "null";
            case "get_settings_path":
                return Json.stringify(Commands.getSettingsPath());

            // ── Trace ────────────────────────────────────────────────────────
            case "trace_open":
                return Json.stringify(TraceIndex.open(Json.str(a, "path")));
            case "trace_get_lines": {
                int from  = (int) Json.lng(a, "from");
                int count = (int) Json.lng(a, "count");
                return Json.stringify(TraceIndex.getLines(Json.str(a, "path"), from, count));
            }
            case "trace_get_lines_at": {
                List<Object> raw = (List<Object>) a.getOrDefault("indices", Collections.emptyList());
                List<Long> indices = new ArrayList<>();
                for (Object o : raw) indices.add(o instanceof Number ? ((Number)o).longValue() : 0L);
                return Json.stringify(TraceIndex.getLinesAt(Json.str(a, "path"), indices));
            }
            case "trace_search": {
                List<Object> raw = (List<Object>) a.getOrDefault("terms", Collections.emptyList());
                List<String> terms = new ArrayList<>();
                for (Object o : raw) terms.add(o != null ? o.toString() : "");
                return Json.stringify(TraceIndex.search(Json.str(a, "path"), terms));
            }
            case "trace_search_time_range": {
                String fromTs = Json.str(a, "fromTs", "from_ts");
                String toTs   = Json.str(a, "toTs",   "to_ts");
                return Json.stringify(TraceIndex.searchTimeRange(Json.str(a, "path"), fromTs, toTs));
            }
            case "trace_close":
                TraceIndex.close(Json.str(a, "path"));
                return "null";

            default:
                throw new UnsupportedOperationException("Unknown command: " + cmd);
        }
    }

    // ── Dialog handlers ───────────────────────────────────────────────────────

    private void handleOpenDir(HttpExchange ex) throws IOException {
        String defPath = queryParam(ex, "defaultPath");
        final String[] chosen = {null};
        try {
            SwingUtilities.invokeAndWait(() -> {
                JFileChooser fc = new JFileChooser(defPath != null ? new java.io.File(defPath) : null);
                fc.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
                fc.setDialogTitle("Select Folder");
                // Try to bring it to front
                JFrame frame = new JFrame();
                frame.setAlwaysOnTop(true);
                frame.setVisible(false);
                int ret = fc.showOpenDialog(frame);
                frame.dispose();
                if (ret == JFileChooser.APPROVE_OPTION) {
                    chosen[0] = fc.getSelectedFile().getAbsolutePath();
                }
            });
        } catch (Exception e) {
            // Ignore — chosen stays null
        }
        sendJson(ex, 200, chosen[0] != null ? Json.stringify(chosen[0]) : "null");
    }

    private void handleOpenFile(HttpExchange ex) throws IOException {
        String defPath = queryParam(ex, "defaultPath");
        String extsParam = queryParam(ex, "extensions"); // comma-separated
        final String[] chosen = {null};
        try {
            SwingUtilities.invokeAndWait(() -> {
                JFileChooser fc = new JFileChooser(defPath != null ? new java.io.File(defPath) : null);
                fc.setFileSelectionMode(JFileChooser.FILES_ONLY);
                fc.setDialogTitle("Select File");
                if (extsParam != null && !extsParam.isEmpty()) {
                    final String[] exts = extsParam.split(",");
                    fc.setFileFilter(new javax.swing.filechooser.FileFilter() {
                        public boolean accept(java.io.File f) {
                            if (f.isDirectory()) return true;
                            String name = f.getName().toLowerCase(Locale.ROOT);
                            for (String e : exts) if (name.endsWith("." + e.trim())) return true;
                            return false;
                        }
                        public String getDescription() { return "Files (" + extsParam + ")"; }
                    });
                }
                JFrame frame = new JFrame();
                frame.setAlwaysOnTop(true);
                frame.setVisible(false);
                int ret = fc.showOpenDialog(frame);
                frame.dispose();
                if (ret == JFileChooser.APPROVE_OPTION) {
                    chosen[0] = fc.getSelectedFile().getAbsolutePath();
                }
            });
        } catch (Exception e) {
            // Ignore
        }
        sendJson(ex, 200, chosen[0] != null ? Json.stringify(chosen[0]) : "null");
    }

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            return new String(readAllBytes(is), StandardCharsets.UTF_8);
        }
    }

    private static byte[] readAllBytes(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private static String queryParam(HttpExchange ex, String name) {
        String query = ex.getRequestURI().getRawQuery();
        if (query == null || query.isEmpty()) return null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) continue;
            String key = urlDecode(pair.substring(0, eq));
            if (key.equals(name)) return urlDecode(pair.substring(eq + 1));
        }
        return null;
    }

    private static String urlDecode(String s) {
        try {
            return java.net.URLDecoder.decode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    private void sendJson(HttpExchange ex, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=UTF-8");
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(body); }
    }

    private void sendError(HttpExchange ex, int status, String message) throws IOException {
        byte[] body = (message != null ? message : "Error").getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "text/plain; charset=UTF-8");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(body); }
    }

    private static String mimeType(String path) {
        path = path.toLowerCase(Locale.ROOT);
        if (path.endsWith(".html")) return "text/html; charset=UTF-8";
        if (path.endsWith(".css"))  return "text/css; charset=UTF-8";
        if (path.endsWith(".js"))   return "application/javascript; charset=UTF-8";
        if (path.endsWith(".ico"))  return "image/x-icon";
        if (path.endsWith(".png"))  return "image/png";
        if (path.endsWith(".svg"))  return "image/svg+xml";
        return "application/octet-stream";
    }
}
