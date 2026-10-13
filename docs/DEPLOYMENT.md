# Deployment

Το SpriteHunter είναι κανονικό Next.js (App Router) project. Η αρχική σελίδα βγαίνει στατική και τα `/api/*` τρέχουν ως serverless functions.

## Vercel

1. Στο [vercel.com](https://vercel.com) κάνε εγγραφή ή σύνδεση με τον λογαριασμό GitHub.
2. **Add New… → Project** και επίλεξε το repository `spritehunter` (Import).
3. Το Vercel αναγνωρίζει μόνο του το Next.js. Άφησε τις προεπιλογές (Build: `npm run build`) και πάτησε **Deploy**.
4. Η εφαρμογή ανοίγει στο `https://<όνομα-project>.vercel.app`, για παράδειγμα `https://spritehunter.vercel.app` αν το όνομα είναι ελεύθερο. Το όνομα και δικό σου domain αλλάζουν από **Settings → Domains**.

Μετά από αυτό, κάθε push στο `main` ανεβαίνει αυτόματα σε παραγωγή, ενώ κάθε άλλο branch ή pull request παίρνει δική του preview διεύθυνση.

### Μεταβλητές περιβάλλοντος (προαιρετικές)

Ορίζονται στο **Settings → Environment Variables**:

- `XWEATHER_CLIENT_ID`, `XWEATHER_CLIENT_SECRET`: θετικοί κεραυνοί +CG και ένταση ρεύματος από το Xweather. Χωρίς αυτά η εφαρμογή χρησιμοποιεί μόνο το δωρεάν MTG-LI.
- `WEATHERAPI_KEY`, `OPENWEATHER_API_KEY`: δεύτερη και τρίτη πρόγνωση νέφωσης για τη θέση σου. Χωρίς αυτά η νέφωση έρχεται μόνο από το Open-Meteo.
- `SITE_URL`: η δημόσια διεύθυνση για canonical, Open Graph, `robots.txt` και sitemap. Χρειάζεται μόνο με δικό σου domain· αλλιώς χρησιμοποιείται αυτόματα η διεύθυνση παραγωγής του Vercel.

Μυστικά δεν μπαίνουν ποτέ σε μεταβλητές `NEXT_PUBLIC_`.

## GitHub Actions

Το `.github/workflows/ci.yml` τρέχει lint, tests και production build σε κάθε push και pull request. Το deploy το κάνει η σύνδεση Vercel–GitHub, όχι το workflow.

## Τοπικά

```bash
npm ci
npm run dev                  # http://localhost:3000 με hot reload
npm run build && npm start   # production build στο http://localhost:3000
```

Μην τρέχεις `npm run build` ενώ τρέχει το `npm start`: το build ξαναγράφει τον φάκελο `.next` που σερβίρει ο server.

## Web Push / email / scheduled monitoring

Η τρέχουσα έκδοση δεν ισχυρίζεται ότι παρακολουθεί όταν το browser tab είναι κλειστό. Για παραγωγικό Phase 6 απαιτούνται:

- Βάση δεδομένων για τις push subscriptions.
- VAPID public/private keys.
- Authenticated server endpoint εγγραφής/διαγραφής subscription.
- Vercel Cron προς authenticated route (`CRON_SECRET`) με quota-aware adaptive polling.
- Deduplication/cooldown σε database transaction.
- Email delivery provider και verified sender, αν ενεργοποιηθεί email.

Μην ενεργοποιήσεις polling 2–5 λεπτών χωρίς πραγματική storm trigger και έλεγχο quota/κόστους των παρόχων.

## Παραγωγικοί έλεγχοι

- HTTPS, CSP και περιορισμός origins όπου είναι εφικτό.
- Server rate limiting στα provider proxies.
- Παρακολούθηση provider latency/errors και cache hit rate.
- Επιβεβαίωση attribution/terms πριν από δημόσια ή εμπορική χρήση (το δωρεάν πλάνο Hobby του Vercel είναι για μη εμπορική χρήση).
- Έλεγχος iOS PWA install + Notification API capability σε πραγματική συσκευή.
- Self-hosted/cached DEM για πλήρες 360° terrain profile χωρίς δημόσιο quota.
