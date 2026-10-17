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

Die Daten bleiben im Browser des Geräts (localStorage). „Sicherung speichern“ lädt eine JSON-Datei
herunter, die du auf einem anderen Gerät mit „Sicherung laden“ wieder einspielst.

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
