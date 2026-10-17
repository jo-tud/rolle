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
