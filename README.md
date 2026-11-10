# Putzplan-Zentrale 🧽

Website für den WG-Putzplan („Mission Haussegen“):

- zeigt, wer diese Woche Wochendienst und Baddienst hat (10-Wochen-Zyklus ab 09.11.2026)
- Aufgaben abhaken, Dienste tauschen, „Putzkraft fällt aus“ markieren
- **Einkaufsliste** (Putzsachen, Bad, Küche, Allgemein): eintragen, was leer ist, und abhaken, wenn's gekauft ist,
  auf Wunsch gleich mit Betrag in die WG-Kasse
- **WG-Kasse** wie Splitwise: Ausgaben eintragen, gleich aufteilen, sehen, wer wem wie viel schuldet, Rückzahlungen abhaken
- lässt sich wie eine App auf den Home-Bildschirm legen
- **Erinnerungen aufs Handy:** Sonntag 19 Uhr der Plan für die neue Woche,
  Freitag 18 Uhr eine Erinnerung, falls noch etwas nicht abgehakt ist

Läuft kostenlos auf Cloudflare Workers (Free-Plan). Die Daten (Häkchen, Tausch,
angemeldete Handys) liegen in einem Durable Object, nicht in diesem Repository.

## Einrichten (einmalig)

1. Kostenloses Konto auf <https://dash.cloudflare.com/sign-up> anlegen.
2. Im Dashboard **Workers & Pages → Create → Import a repository** wählen,
   GitHub verbinden und dieses Repository auswählen.
3. Als Projektnamen `putzplan-zentrale` lassen (muss zu `wrangler.toml` passen) und **Deploy** klicken.
4. Die Adresse `https://putzplan-zentrale.<dein-name>.workers.dev` öffnen und in die WG-Gruppe schicken.

Danach wird jede Änderung in diesem Repository automatisch veröffentlicht.

## Für alle in der WG

1. Link öffnen, auf deinen Namen tippen.
2. **iPhone:** In Safari auf *Teilen → Zum Home-Bildschirm*, dann die App vom Home-Bildschirm öffnen
   (nur so erlaubt iOS Benachrichtigungen, ab iOS 16.4).
   **Android:** Chrome reicht, optional *Zum Startbildschirm hinzufügen*.
3. „Erinnerungen aktivieren“ tippen und erlauben. Mit „Test“ prüfen, ob es ankommt.

## Plan ändern

Personen, Reihenfolge und Aufgaben stehen in `src/plan.js`, die Uhrzeiten der
Erinnerungen in `src/worker.js` (`SCHEDULE`).

## Entwicklung

```sh
npm install
npm test          # Plan- und Verschlüsselungs-Tests
npx wrangler dev  # lokal starten
```
