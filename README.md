# SpriteHunter — Παρατηρητήριο Ανώτερης Ατμόσφαιρας

Mobile-first PWA για πρακτικό σχεδιασμό παρατήρησης και φωτογράφισης Transient Luminous Events (TLE), με κύριο στόχο τα Red Sprites από τη Σπάρτη και άλλες αποθηκευμένες θέσεις.

Το SpriteHunter **δεν προβλέπει βέβαιη εμφάνιση sprite**. Ο δείκτης 0–100 είναι διαφανής ευρετική βαθμολογία ευκαιρίας, όχι ποσοστό πιθανότητας. Μια περιοχή χωρίς πραγματικές παρατηρήσεις κεραυνών εμφανίζεται αποκλειστικά ως «προγνωστικός στόχος» και η ισχυρότερη κατάταξή της περιορίζεται.

## Τι λειτουργεί

- Ελληνικό responsive dashboard με προαιρετικά αγγλικά στη βασική πλοήγηση.
- Ακριβής θέση παρατηρητή, GPS με ρητή άδεια και απεριόριστες αποθηκευμένες θέσεις στον browser.
- Πραγματικά προγνωστικά Open-Meteo (48 ώρες) για 24 γεωγραφικά σημεία σάρωσης σε όλες τις διευθύνσεις, με CAPE, CIN, Lifted Index, υδρατμούς, υετό, νέφωση, ορατότητα και άνεμο. Η ώρα κάθε στόχου επιλέγεται με βάση την πλήρη βαθμολογία (συμπεριλαμβανομένου του σκοταδιού), όχι μόνο την κορυφή της αστάθειας.
- Open-Meteo Air Quality (PM10, PM2.5, σκόνη, AOD) με ξεχωριστή προέλευση.
- RainViewer radar overlay με χρονική σήμανση και υποχρεωτική αναφορά προέλευσης.
- EUMETSAT MTG-LI κεραυνοί, IR νέφη, ύψος κορυφών και K-index μέσω EUMETView WMS, ως μία εικόνα ανά layer στην προβολή Web Mercator (EPSG:3857) του χάρτη.
- Παρατηρημένες καταιγίδες στη βαθμολογία: ο server αναλύει τα τελευταία 15 λεπτά MTG-LI, δημιουργεί στόχους από πραγματικούς κεραυνούς, επιβεβαιώνει ή «ρίχνει» τις προγνωστικές κυψέλες της τρέχουσας ώρας και καταργεί το όριο του 69 όπου υπάρχουν κεραυνοί.
- Πραγματικές παρατηρήσεις METAR/TAF (AviationWeather) από τον πλησιέστερο *φρέσκο* σταθμό και επίσημες προειδοποιήσεις MeteoAlarm Ελλάδας ταξινομημένες κατά εγγύτητα και σοβαρότητα.
- NOAA SWPC Kp και OVATION για τη λειτουργία σέλαος.
- Προαιρετικό server-only endpoint Vaisala Xweather, με επικύρωση Zod και όριο ακτίνας 100 km. Χωρίς κλειδιά δεν δημιουργούνται ψεύτικοι κεραυνοί.
- WGS84 Vincenty inverse/direct, ECEF→ENU και φαινόμενη ανύψωση στόχου στα 50/60/70/80/90 km με καμπυλότητα Γης.
- OpenTopoData/SRTM 30 m προφίλ εδάφους στον επιλεγμένο τομέα και ταξινόμηση πλήρους/μερικής/μη ορατότητας.
- Ήλιος, Σελήνη, φωτισμός και γωνιακός διαχωρισμός με SunCalc v2 (αζιμούθιο από αληθή βορρά).
- Ζωντανή στόχευση με αισθητήρες συσκευής: πλήρης γεωμετρία W3C DeviceOrientation για αζιμούθιο και ανύψωση πίσω κάμερας, με τοπική διόρθωση μαγνητικής απόκλισης NOAA WMM2025.
- Canon EOS 750D, επεξεργάσιμη συλλογή φακών, πραγματικό οριζόντιο/κάθετο FOV και έλεγχος κάδρου.
- Πειραματικές φωτογραφικές ρυθμίσεις, χειροκίνητη/αισθητηριακή πυξίδα, Sky View και τοπικό ημερολόγιο με CSV/JSON export.
- In-app/browser ειδοποιήσεις όσο η εφαρμογή είναι ανοιχτή (επανέλεγχος ανά 15 λεπτά) με όριο δείκτη, ελάχιστη εμπιστοσύνη, cooldown και ώρες ησυχίας.
- PWA service worker για offline app shell. Οι ζωντανές API κλήσεις παραμένουν network-only.
- Συμβατότητα κινητών/PWA: περιθώρια για notch και status bar (iOS «black-translucent», Android edge-to-edge), διάταξη κινητού και σε οριζόντια θέση, χάρτης με ένα δάχτυλο για κύλιση σελίδας και δύο για μετακίνηση/zoom, έλεγχος σε Chromium και WebKit (iPhone/iPad).
- 102 unit tests για γεωδαισία, καμπυλότητα, ορίζοντα, FOV, προσανατολισμό συσκευής, WMM, αστρονομία, DST, επιλογή στόχου, scoring, METAR, MeteoAlarm, αποκωδικοποίηση PNG, ομαδοποίηση κεραυνών MTG-LI, ειδοποιήσεις, cache, rate limiting, επικύρωση εισόδων και cache headers του API.

## Γρήγορη εκκίνηση

Απαιτείται Node.js `>=22.13`.

```bash
npm ci
copy .env.example .env.local
npm run dev
```

Η εφαρμογή ανοίγει στο `http://localhost:3000`. Για production build τοπικά: `npm run build` και μετά `npm start`.

Έλεγχοι παραγωγής (τους ίδιους τρέχει το GitHub Actions σε κάθε push):

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Deployment

Το project είναι κανονικό Next.js και ανεβαίνει στο Vercel με σύνδεση του GitHub repository, χωρίς επιπλέον ρυθμίσεις. Κάθε push στο `main` κάνει αυτόματο deploy. Βήματα στον [οδηγό deployment](./docs/DEPLOYMENT.md).

## Μεταβλητές περιβάλλοντος

Η δωρεάν βασική λειτουργία δεν χρειάζεται κλειδί. Για πραγματικά συμβάντα κεραυνών συμπλήρωσε μόνο στον server:

```env
XWEATHER_CLIENT_ID=...
XWEATHER_CLIENT_SECRET=...
```

Μην χρησιμοποιήσεις ποτέ `NEXT_PUBLIC_` για μυστικά παρόχων. Δες το [`.env.example`](./.env.example) και τον [οδηγό παρόχων](./docs/PROVIDERS.md).

## Αποθήκευση

Η παρούσα single-user έκδοση κρατά θέσεις, φακούς, προτιμήσεις και ημερολόγιο σε `localStorage`. Δεν μεταδίδει GPS χωρίς ενέργεια του χρήστη. Δεν χρησιμοποιεί βάση δεδομένων.

## Αρχιτεκτονική

```text
app/api/                 server proxies και provider validation
components/              dashboard, map, pointing, horizon, equipment
lib/providers/           retries, timeouts, cache, Open-Meteo contracts
lib/geodesy.ts           WGS84 / ECEF / ENU / καμπυλότητα
lib/storm-detection.ts   deduplication, DBSCAN-like clustering, motion
lib/terrain.ts           visibility classification
lib/astronomy.ts         SunCalc adapter
lib/camera.ts            sensor/FOV/framing/settings
lib/scoring.ts           explainable index + independent confidence
tests/                   scientific unit scenarios
```

Οι provider routes εφαρμόζουν timeout με συνολικό χρονικό όριο, retry μόνο σε σφάλματα δικτύου/429/5xx, Zod validation (κενές παράμετροι απορρίπτονται), server-side secrets, in-memory cache με όριο μεγέθους και best-effort rate limiting ανά IP. Τα API responses περιλαμβάνουν χρόνο ανάκτησης, valid time, είδος δεδομένων και κατάσταση διαθεσιμότητας.

## Κατάσταση φάσεων

| Φάση | Κατάσταση |
|---|---|
| 1 — Foundation | Ολοκληρωμένος λειτουργικός πυρήνας |
| 2 — Storm discovery | Forecast screening + radar + προαιρετικός lightning provider· δεν υπάρχει radar-image segmentation |
| 3 — Geometry | WGS84/ECEF/ENU + επιλεγμένος DEM τομέας· πλήρες cached 360° DEM δεν έχει υλοποιηθεί |
| 4 — Photography | Canon 750D, lenses, FOV, settings, compass/manual mode |
| 5 — Opportunity engine | Explainable score, confidence, ranking, timelines, βασική σύγκριση θέσεων |
| 6 — Notifications | In-app/browser ειδοποιήσεις με κανόνες όσο η εφαρμογή είναι ανοιχτή· **όχι ακόμη server push/email/scheduled delivery** |
| 7 — Advanced observation | Τοπικό logbook/export· **όχι RAW upload/EXIF/image sequence detector** |

## Ασφάλεια

- Ποτέ παρατήρηση σε εκτεθειμένο σημείο όταν η καταιγίδα είναι κοντά.
- Το app δεν επινοεί δρόμους, πρόσβαση, parking ή ασφάλεια τοποθεσίας.
- Τα radar pixels δεν χαρακτηρίζονται αυτόματα ως ηλεκτρικά ενεργή καταιγίδα.
- Η έλλειψη feed κεραυνών παραμένει «μη διαθέσιμο/μη ρυθμισμένο», όχι μηδενική δραστηριότητα.

## Τεκμηρίωση

- [Πάροχοι, άδειες, quotas και κόστος](./docs/PROVIDERS.md)
- [Επιστημονικές παραδοχές και περιορισμοί](./docs/SCIENTIFIC.md)
- [Deployment στο Vercel](./docs/DEPLOYMENT.md)

## Άδεια δεδομένων

Ο κώδικας του repository δεν παραχωρεί δικαιώματα πάνω στα δεδομένα τρίτων. Η χρήση κάθε provider διέπεται από τους δικούς του όρους. Το RainViewer απαιτεί ορατή αναφορά προέλευσης και η δωρεάν δημόσια υπηρεσία προορίζεται για προσωπική/εκπαιδευτική/μικρής κλίμακας χρήση.

