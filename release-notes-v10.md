## HANA-Lens v2026_11_16_01

### Nameserver History — jetzt 1:1 zum Original-Viewer
Die Nameserver-History-Ansicht ist nun eine getreue Nachbildung des originalen `ngx-hana-nameserver-history-viewer`:
- Feste, KPI-spezifische Linienfarben wie im Original
- Original-KPI-Bezeichnungen (Gruppe **Index Server**, „Database Used Memory", „Statements", „Active Versions" usw.)
- Korrekte Einheiten (`MB/s`, `Sec/s`, `req/s`, `stm/s`, `col/s`, `ms`)
- Y-Scale pro KPI nach Original-Logik (inkl. Swap-Mindestskala 100); Prozentwerte bei 100 % gekappt (Tooltip zeigt Originalwert)
- Max/Average-Berechnung wie im Original (letzte Zeile ignoriert, zeitbezogene Mittelung, Tausendertrennung)
- Titelzeile im Format `host - port ( start ~ end )`
- References-Menü klappt direkt unter dem Button auf (mit Klapppfeil)

### Globale Suche im Menüband (neu)
Suchfeld oben im blauen Band durchsucht alle strukturierten Seiten der aktiven Sitzung (HSI-Seiten, Konfiguration, Topology, Version History). Ergebnisse gruppiert nach Seite mit markiertem Treffer; **Doppelklick** springt zur Seite und hebt die Fundstelle hervor. Trace-/Runtime-Dump-Rohdaten sind ausgenommen (eigene Suche). Der aktive Sitzungsname wird im Platzhalter und in der Ergebnis-Kopfzeile angezeigt und beim Sitzungswechsel automatisch aktualisiert.

### Design
- SAP-Horizon ist das feste, einzige Design (Theme-Umschalter entfernt)
- FSID-Sitzungs-Kopfzeilen im selben Dunkelblau wie HSI

### Fixes
- `start.sh` mit Unix-Zeilenenden (startet jetzt sauber unter macOS/Linux)
