# SpriteHunter — Παρατηρητήριο Ανώτερης Ατμόσφαιρας

Mobile-first PWA για πρακτικό σχεδιασμό παρατήρησης και φωτογράφισης Transient Luminous Events (TLE), με κύριο στόχο τα Red Sprites από τη Σπάρτη και άλλες αποθηκευμένες θέσεις.

Το SpriteHunter **δεν προβλέπει βέβαιη εμφάνιση sprite**. Ο δείκτης 0–100 είναι διαφανής ευρετική βαθμολογία ευκαιρίας, όχι ποσοστό πιθανότητας. Μια περιοχή χωρίς πραγματικές παρατηρήσεις κεραυνών εμφανίζεται αποκλειστικά ως «προγνωστικός στόχος» και η ισχυρότερη κατάταξή της περιορίζεται.

## Τι λειτουργεί

- Ελληνικό responsive dashboard με προαιρετικά αγγλικά στη βασική πλοήγηση.
- Ακριβής θέση παρατηρητή, GPS με ρητή άδεια και απεριόριστες αποθηκευμένες θέσεις στον browser.
- Πραγματικά προγνωστικά Open-Meteo για 24 γεωγραφικά σημεία σάρωσης σε όλες τις διευθύνσεις, με CAPE, υετό, νέφωση, ορατότητα και άνεμο.
- Open-Meteo Air Quality (PM10, PM2.5, σκόνη, AOD) με ξεχωριστή προέλευση.
- RainViewer radar overlay με χρονική σήμανση και υποχρεωτική αναφορά προέλευσης.
- Προαιρετικό server-only endpoint Vaisala Xweather, με επικύρωση Zod και όριο ακτίνας 100 km. Χωρίς κλειδιά δεν δημιουργούνται ψεύτικοι κεραυνοί.
- WGS84 Vincenty inverse/direct, ECEF→ENU και φαινόμενη ανύψωση στόχου στα 50/60/70/80/90 km με καμπυλότητα Γης.
- OpenTopoData/SRTM 30 m προφίλ εδάφους στον επιλεγμένο τομέα και ταξινόμηση πλήρους/μερικής/μη ορατότητας.
- Ήλιος, Σελήνη, φωτισμός και γωνιακός διαχωρισμός με SunCalc v2 (αζιμούθιο από αληθή βορρά).
- Canon EOS 750D, επεξεργάσιμη συλλογή φακών, πραγματικό οριζόντιο/κάθετο FOV και έλεγχος κάδρου.
- Πειραματικές φωτογραφικές ρυθμίσεις, χειροκίνητη/αισθητηριακή πυξίδα, Sky View και τοπικό ημερολόγιο με CSV/JSON export.
- PWA service worker για offline app shell. Οι ζωντανές API κλήσεις παραμένουν network-only.
- 17 unit tests για γεωδαισία, καμπυλότητα, ορίζοντα, FOV, αστρονομία, DST, παλαιότητα, clustering, scoring και cooldown.

## Γρήγορη εκκίνηση

Απαιτείται Node.js `>=22.13`.

```bash
npm install
copy .env.example .env.local
npm run dev
```

Στο portable profile η εφαρμογή ανοίγει συνήθως στο `http://127.0.0.1:5173`.

Έλεγχοι παραγωγής:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Μεταβλητές περιβάλλοντος

Η δωρεάν βασική λειτουργία δεν χρειάζεται κλειδί. Για πραγματικά συμβάντα κεραυνών συμπλήρωσε μόνο στον server:

```env
XWEATHER_CLIENT_ID=...
XWEATHER_CLIENT_SECRET=...
```

Μην χρησιμοποιήσεις ποτέ `NEXT_PUBLIC_` για μυστικά παρόχων. Δες το [`.env.example`](./.env.example) και τον [οδηγό παρόχων](./docs/PROVIDERS.md).

## Αποθήκευση και βάση δεδομένων

Η παρούσα single-user έκδοση κρατά θέσεις, φακούς, προτιμήσεις και ημερολόγιο σε `localStorage`. Δεν μεταδίδει GPS χωρίς ενέργεια του χρήστη.

Το `db/schema.ts` περιλαμβάνει έτοιμο type-safe Drizzle/D1 σχήμα για θέσεις, παρατηρήσεις, Web Push subscriptions και monitor runs. Για Sites/D1:

1. Δήλωσε binding `DB` στο `.openai/hosting.json` μέσω του hosting control plane.
2. Εκτέλεσε `npm run db:generate`.
3. Εφάρμοσε τις migrations σύμφωνα με το [deployment guide](./docs/DEPLOYMENT.md).
4. Πρόσθεσε authenticated CRUD routes με το σταθερό `oai-authenticated-user-id`.

Για Vercel/PostgreSQL, κράτησε τα ίδια domain interfaces και αντικατάστησε τον D1 driver με `drizzle-orm/node-postgres` ή HTTP-compatible Postgres driver.

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
db/                      προαιρετικό Drizzle persistence schema
tests/                   scientific unit scenarios
```

Οι provider routes εφαρμόζουν timeout, retry, Zod validation, server-side secrets και μικρή in-memory cache. Τα API responses περιλαμβάνουν χρόνο ανάκτησης, valid time, είδος δεδομένων και κατάσταση διαθεσιμότητας.

## Κατάσταση φάσεων

| Φάση | Κατάσταση |
|---|---|
| 1 — Foundation | Ολοκληρωμένος λειτουργικός πυρήνας |
| 2 — Storm discovery | Forecast screening + radar + προαιρετικός lightning provider· δεν υπάρχει radar-image segmentation |
| 3 — Geometry | WGS84/ECEF/ENU + επιλεγμένος DEM τομέας· πλήρες cached 360° DEM δεν έχει υλοποιηθεί |
| 4 — Photography | Canon 750D, lenses, FOV, settings, compass/manual mode |
| 5 — Opportunity engine | Explainable score, confidence, ranking, timelines, βασική σύγκριση θέσεων |
| 6 — Notifications | In-app/browser permission & rules· **όχι ακόμη πραγματικό server push/email/scheduled delivery** |
| 7 — Advanced observation | Τοπικό logbook/export· **όχι RAW upload/EXIF/image sequence detector** |

## Ασφάλεια

- Ποτέ παρατήρηση σε εκτεθειμένο σημείο όταν η καταιγίδα είναι κοντά.
- Το app δεν επινοεί δρόμους, πρόσβαση, parking ή ασφάλεια τοποθεσίας.
- Τα radar pixels δεν χαρακτηρίζονται αυτόματα ως ηλεκτρικά ενεργή καταιγίδα.
- Η έλλειψη feed κεραυνών παραμένει «μη διαθέσιμο/μη ρυθμισμένο», όχι μηδενική δραστηριότητα.

## Τεκμηρίωση

- [Πάροχοι, άδειες, quotas και κόστος](./docs/PROVIDERS.md)
- [Επιστημονικές παραδοχές και περιορισμοί](./docs/SCIENTIFIC.md)
- [Deployment σε Sites ή Vercel](./docs/DEPLOYMENT.md)

## Άδεια δεδομένων

Ο κώδικας του repository δεν παραχωρεί δικαιώματα πάνω στα δεδομένα τρίτων. Η χρήση κάθε provider διέπεται από τους δικούς του όρους. Το RainViewer απαιτεί ορατή αναφορά προέλευσης και η δωρεάν δημόσια υπηρεσία προορίζεται για προσωπική/εκπαιδευτική/μικρής κλίμακας χρήση.

