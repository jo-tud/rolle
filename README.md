# Rolle

Dein Filament-Lager im Browser.

**App öffnen:** <https://jo-tud.github.io/rolle/>

Kleine Web-App, um die Filamentspulen für den Bambu Lab H2D (oder jeden anderen Drucker) zu
verwalten: QR-Code der Spule scannen, Bestand sehen, leere Spulen ausbuchen.

## Bedienung

- **Einlagern:** Jeder Scan legt eine Spule an. Ein Code, den die App noch nicht kennt, wird als
  Sorte „ohne Details“ angelegt. Material, Farbe und Marke trägst du einmal ein (die App schlägt
  vor, was sie aus dem Code lesen kann), danach erkennt sie jede weitere Spule mit diesem Code sofort.
- **Ausbuchen:** Umschalten auf „− Ausbuchen“ und die leere Spule scannen. Es verschwindet eine Spule
  dieser Sorte, zuerst eine als „angebrochen“ markierte. In der Liste geht es auch mit „−“.
- **Hand-Scanner** (USB oder Bluetooth) tippen den Code wie eine Tastatur. Die App erkennt das
  überall auf der Seite, ohne dass ein Feld angetippt werden muss: Spule für Spule scannen, Ton und
  Aufblinken bestätigen jeden Scan. Den Scanner auf das Tastaturlayout des Geräts (meist Deutsch)
  und auf „Enter“ als Abschluss stellen.
- **Kamera:** „Kamera-Scan“ antippen und Codes ins Bild halten. Ein Code zählt einmal, solange er im
  Bild bleibt; gleiche Spulen nacheinander zeigen zählt jede einzeln.
- Jede Aktion lässt sich rückgängig machen. Spulen ohne QR-Code legst du mit „Spule ohne Code“ an.

## Barcodes erkennen

Rolle kennt rund 5 600 Barcodes (EAN) von Filamentkartons aus 41 Marken, darunter rund 250 von
Bambu Lab. Beim Scannen eines bekannten Kartons stehen Marke, Material, Farbe und Farbton sofort
fest; Sorten, die vorher als „unbekannt“ eingescannt wurden, werden beim Öffnen ergänzt. Für
Spulen ohne Karton findet die Suche im Bearbeiten-Dialog jede Bambu-Farbe (auch mit deutschen
Farbwörtern, z. B. „silk lila“).

Die Daten stammen aus der [Open Filament Database](https://github.com/OpenFilamentCollective/open-filament-database)
(MIT-Lizenz, © OpenFilamentCollective). Aktualisieren:

```sh
git clone --depth 1 https://github.com/OpenFilamentCollective/open-filament-database /tmp/ofd
npm run catalog -- /tmp/ofd
```

Ein Barcode, den die Tabelle nicht kennt, wird wie bisher einmal von Hand beschrieben und danach
erkannt.

## Wo die Daten liegen

Ohne weitere Einrichtung bleibt der Bestand nur im Browser des Geräts (localStorage). „Sicherung
speichern“ lädt eine JSON-Datei herunter, „Sicherung laden“ spielt sie wieder ein (zusammengeführt
mit dem, was schon da ist).

### Mehrere Geräte abgleichen (☁)

Rolle kann den Bestand zwischen Handy, Tablet und PC abgleichen, ohne eigenen Server und ohne neues
Konto – über einen **geheimen Gist in deinem GitHub-Konto**:

- **Ende-zu-Ende verschlüsselt:** Der Bestand wird im Browser mit AES-256-GCM verschlüsselt. Der
  Schlüssel entsteht aus deinem Kennwort (PBKDF2-SHA256, 600 000 Runden). Im Gist liegt nur
  unlesbarer Text; GitHub und jeder, der den Gist findet, sieht nichts vom Inhalt.
- **Einrichten:** ☁ antippen, über den Link einen GitHub-Zugangsschlüssel (classic, nur Häkchen
  „gist“) erstellen, einfügen, Kennwort festlegen.
- **Weitere Geräte:** Auf einem eingerichteten Gerät ☁ → „Weiteres Gerät verbinden“. Den QR-Code
  auf dem neuen Gerät in Rolle scannen (☁ → „Code scannen“) und das Kennwort eingeben. Der Code
  enthält den Zugangsschlüssel, aber nicht das Kennwort. Ohne Code geht es auch: Zugangsschlüssel
  erstellen und Kennwort eingeben – Rolle findet den Gist selbst.
- **Gleichzeitige Änderungen gehen nicht verloren:** Jede Spule und Sorte trägt einen Zeitstempel,
  Ausbuchungen hinterlassen einen Vermerk. Beim Abgleich werden beide Stände zusammengeführt; was
  auf dem einen Gerät eingelagert und auf dem anderen ausgebucht wurde, landet richtig.
- Abgeglichen wird nach jeder Änderung, beim Öffnen und jede Minute, solange Rolle offen ist.
  Offline gesammelte Änderungen gehen beim nächsten Mal hoch.
- Auf den Geräten liegen der Zugangsschlüssel und der aus dem Kennwort berechnete Schlüssel, nie
  das Kennwort selbst. **Ohne Kennwort ist der Bestand nicht wiederherstellbar.**

## Entwicklung

Node.js 22 und npm:

```sh
npm install
npm run dev      # Dev-Server
npm test         # Tests (Vitest)
npm run build    # Typprüfung + Build nach dist/
```

Jeder Push auf `main` wird getestet und per GitHub Actions auf GitHub Pages veröffentlicht
(einmalig in den Repo-Einstellungen unter *Pages → Source* „GitHub Actions“ wählen). Die App wird
mit relativen Pfaden gebaut und läuft deshalb in jedem Ordner jedes Webservers. Die Kamera braucht
https (oder localhost).

## Rolle NFC (Android)

Die native Hülle unter `android/` lädt dieselbe Rolle-Web-App und liest Bambu-Tags **nur lesend**.
Bestandslogik und verschlüsselter Gist-Abgleich bleiben in der Web-App. Die Tray-UID identifiziert
eine physische Spule; die beiden Tags an den Seiten haben unterschiedliche NFC-UIDs.

### APK installieren

1. Auf GitHub unter **Actions → Android APK** das Artefakt `Rolle-NFC-debug` herunterladen,
   entpacken und `app-debug.apk` auf dem Handy öffnen. Tags `android-v*` erzeugen zusätzlich
   ein GitHub Release mit APK. Es ist eine **Debug-signierte Test-APK** zum Sideloaden.
2. Androids Installation aus dieser Quelle erlauben. Vor Updates den Bestand sichern:
   Der CI-Debug-Schlüssel kann sich zwischen Builds ändern; dann muss die alte APK zuerst
   deinstalliert werden. Eine Deinstallation löscht auch den WebView-Bestand und die Kopplung.
3. NFC einschalten und der App Kamera-Zugriff erlauben, wenn Kamera-Scan oder QR-Kopplung benutzt wird.
4. Wichtig: Die Web-Änderungen dieses Branches müssen auf GitHub Pages veröffentlicht sein,
   bevor die APK NFC-Scans verarbeiten kann. Die APK enthält keine Kopie der Web-App.

Ab Android 8 (API 26), ohne Google-Play-Dienste. Das Handy muss **MIFARE Classic** lesen können;
NFC allein reicht nicht aus. Die Unterstützung hängt auch bei Samsung vom konkreten Modell ab.
Vorab mit **MIFARE Classic Tool** und einer vorhandenen Bambu-Spule prüfen, ob MIFARE Classic 1K
erkannt wird. Die App meldet fehlendes NFC, ausgeschaltetes NFC, nicht unterstützte Tags und
Lesefehler auf Deutsch. Die Web-Hülle bleibt ohne MIFARE Classic nutzbar.
Ein physisches Samsung-Handy wurde in der Cloud nicht getestet.

Nach dem ersten Laden: Modus „Einlagern“ wählen und eine Spulenseite ruhig an die NFC-Antenne halten.
Ein zweiter Scan derselben Spule (auch von der anderen Seite) legt nichts doppelt an.
„Ausbuchen“ entfernt genau die Spule mit dieser Tray-UID; „Rückgängig“ stellt sie wieder her.
Gleichzeitige Scans derselben Spule auf zwei Geräten erhalten dieselbe interne ID und werden
beim Abgleich zusammengeführt. Die Tray-UID wird im Bestand und damit im verschlüsselten Gist gespeichert.
Die App prüft keine Bambu-RSA-Signatur; die Daten sind keine Echtheitsbestätigung.

### Tag → Karton-Katalog und Lizenzen

Die Open Filament Database (MIT) führt Bambu-Artikelnummern, etwa `13702` → EAN `6977252427456`
(PLA Silk+ Purple). Die Artikelnummer ist jedoch nicht direkt im Tag gespeichert. Die
RFID-Library listet Zuordnungen, aber einige Varianten-IDs sind mehrdeutig, etwa `A00-A0`
bei Orange und Pink. Eine pauschale Umrechnung wäre unzuverlässig.

Deshalb bleibt die mitgelieferte RFID-Zuordnung zunächst leer: Der Produktcode ist
`bambu-rfid:<Materialvariante>`; Material, RGBA-Farbe und Gewicht kommen aus dem Tag. Solche
Spulen sind zunächst **nicht automatisch mit Karton-EANs gruppiert**. Bei mehrdeutigen
Varianten-IDs kann der Fallback auch Farben unter einer Sorte zusammenfassen; die Tray-UID
hält die einzelnen Spulen trotzdem auseinander.

`scripts/build-catalog.mjs` erzeugt zusätzlich Artikelnummer → EANs und akzeptiert optional
eine separat geprüfte und zur Weitergabe freigegebene JSON-Zuordnung:

```json
[{"variantId":"A00-K0","colorRgba":"#000000ff","articleNumber":"10101"}]
```

```sh
npm run catalog -- /tmp/ofd /pfad/zur/geprueften-zuordnung.json
```

Gematcht wird nur mit Varianten-ID, exakter RGBA-Farbe und Gewicht; widersprüchliche Einträge
werden ausgelassen. Mehrere EANs derselben Sorte bekommen eine stabile kanonische EAN.
Die Beispielzeile illustriert das Format und ist kein mitgelieferter Crosswalk.

Quellen:

- [Bambu RFID Tag Guide](https://github.com/Bambu-Research-Group/RFID-Tag-Guide):
  Salt, HKDF-Kontext `RFID-A\0` und Blocklayout; unabhängige Implementierung, kein Quellcode
  übernommen. Im untersuchten Stand ist keine ausdrückliche Lizenz enthalten.
- [Bambu Lab RFID Library](https://github.com/queengooborg/Bambu-Lab-RFID-Library): GPL-3.0.
  Vier unveränderte Dumps liegen ausschließlich als Testdaten unter
  `android/app/src/test/resources/rfid/`, mit Herkunft, Commit und vollständiger Lizenz.
  Sie werden nicht in die APK gepackt. Auch ein echtes Paar beider Spulenseiten wird getestet.
- Open Filament Database: MIT, bestehende Katalogquelle.
- Es wurden **keine Bambu-Studio-Daten oder AGPL-3.0-Komponenten** übernommen. Eine spätere
  Übernahme daraus braucht eine vorherige Lizenzentscheidung.

Die Dump-Prüfung ist wichtig: Block 9 enthält 16 **Binärbytes** (32 Hex-Zeichen), keine
ASCII-Seriennummer. Der Durchmesser ist im verifizierten Dump ein LE-Float32 ab Byte 8 von
Block 5. Die Länge aus Block 14 ist im Guide noch als vorläufige Interpretation markiert.

### Android entwickeln und prüfen

JDK 21, Android SDK Platform 35 und Build Tools 35.0.0 installieren; `ANDROID_HOME` auf das SDK setzen:

```sh
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Die Unit-Tests prüfen alle 16 Sektorschlüssel gegen die Trailer von vier echten Dumps,
Block-Auswertung, Zweitfarben, ungültige Daten und die gemeinsame Tray-UID eines echten Paars.
Vitest prüft RFID-Ein-/Ausbuchen, Doppelungen, Rückgängig, alte Bestände, Merge und den
verschlüsselten Datentransport. Die APK liegt unter `android/app/build/outputs/apk/debug/`.

Noch auf dem Zielgerät abzunehmen: Installation, NFC-Antenne/Lesedauer, deutsche Fehlermeldung
bei fehlender MIFARE-Unterstützung, Kamera-Scan, QR-Gerätekopplung und echter Gist-Abgleich
zwischen zwei Geräten. Die WebView hat einen eigenen Browserbestand; vorhandene Daten per
Sicherung oder Gist-Kopplung übernehmen. Es werden keine zusätzlichen Drittanbieter-Dienste verwendet.
