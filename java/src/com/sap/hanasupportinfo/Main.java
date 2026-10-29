package com.sap.hanasupportinfo;

import java.awt.Desktop;
import java.net.URI;

public class Main {

    public static void main(String[] args) {
        // Ensure Swing file dialogs work on headless-configured JVMs
        System.setProperty("java.awt.headless", "false");

        int port = 7321;
        try {
            HanaLensServer server = new HanaLensServer(port);
            server.start();

            System.out.println("HANA-Lens is running at http://localhost:" + port);
            System.out.println("Press Ctrl+C to stop.");

            // Open default browser after a short startup delay
            if (Desktop.isDesktopSupported()) {
                Desktop desktop = Desktop.getDesktop();
                if (desktop.isSupported(Desktop.Action.BROWSE)) {
                    Thread.sleep(400);
                    desktop.browse(new URI("http://localhost:" + port));
                }
            }

            // Keep JVM alive (server thread pool threads are non-daemon)
            Runtime.getRuntime().addShutdownHook(new Thread(server::stop));

        } catch (Exception e) {
            System.err.println("Failed to start HANA-Lens: " + e.getMessage());
            e.printStackTrace();
            System.exit(1);
        }
    }
}
