# Πάροχοι δεδομένων, όρια και κόστος

Η τεκμηρίωση ελέγχθηκε στις 11 Οκτωβρίου 2026. Επειδή οι υπηρεσίες αλλάζουν, επαλήθευσε ξανά όρους και quotas πριν από δημόσια ή εμπορική διάθεση.

## Open-Meteo Forecast

- Endpoint: `https://api.open-meteo.com/v1/forecast`
- Χρήση: cloud cover low/mid/high, visibility, precipitation/probability, humidity, wind, CAPE και WMO weather code.
- Το app στέλνει μία multi-coordinate αίτηση: παρατηρητής + 24 χονδροειδή σημεία σε τρεις αποστάσεις και οκτώ αζιμούθια.
- Cache εφαρμογής: 15 λεπτά.
- Δεν θεωρεί CAPE ή model weather code ως πραγματική παρατήρηση κεραυνών.
- Δωρεάν βασική χρήση σύμφωνα με τους τρέχοντες όρους του provider· για εμπορικό/SLA σενάριο έλεγξε το pricing του provider.

## Open-Meteo Air Quality / CAMS

- Endpoint: `https://air-quality-api.open-meteo.com/v1/air-quality`
- Χρήση: PM10, PM2.5, dust, aerosol optical depth.
- Οι τιμές είναι πρόγνωση μοντέλου περίπου 11 km στην Ευρώπη, όχι επιτόπια μέτρηση διαύγειας.

## RainViewer

- Metadata: `https://api.rainviewer.com/public/weather-maps.json`
- Το δημόσιο API παρέχει τα τελευταία δύο ώρες radar frames σε περίπου δεκάλεπτα βήματα και coverage mask.
- Η διαθεσιμότητα δεν είναι εγγυημένη. Το radar μπορεί να λείπει πάνω από τμήματα της Μεσογείου.
- Απαιτείται ορατό attribution στο RainViewer.
- Η δωρεάν χρήση αφορά προσωπικά, εκπαιδευτικά και μικρής κλίμακας community projects· δεν παρέχει SLA.
- Radar precipitation ≠ lightning-active thunderstorm.

## OpenTopoData

- Endpoint: `https://api.opentopodata.org/v1/srtm30m`
- Δημόσιο όριο: 100 θέσεις/αίτηση, 1 κλήση/δευτερόλεπτο, 1.000 κλήσεις/ημέρα.
- Το app ζητά 20 προσαρμοστικά δείγματα στον επιλεγμένο τομέα έως 120 km και cache 7 ημερών.
- Δεν χαρακτηρίζει τον ορίζοντα «επαληθευμένο» όταν λείπουν τιμές DEM.
- Για παραγωγικό πλήρες 360° profile προτείνεται self-hosted SRTM/Copernicus pipeline με τοπικά cached tiles.

## Vaisala Xweather (προαιρετικό/επί πληρωμή)

- Endpoint: `/lightning/{lat},{lon}`.
- Standard περιορισμοί: έως 100 km ακτίνα, έως 1.000 pulses και μόνο τα τελευταία 5 λεπτά. Ιστορικά δεδομένα, μεγάλα polygons ή 24ωρα queries χρειάζονται Enterprise add-on.
- Το app ζητά lightning μόνο για επιλεγμένη υποψήφια περιοχή. Τα credentials παραμένουν server-side.
- Η απάντηση επικυρώνεται και κανονικοποιείται σε id, θέση, ώρα, age, IC/CG, peak amplitude/polarity, sensor count και quality metric.
- Χωρίς credentials το endpoint επιστρέφει `not_configured` και κενό event array.

## Blitzortung / LightningMaps

Δεν γίνεται scraping, χρήση ιδιωτικών WebSocket feeds ή προστατευμένων endpoints. Μπορούν να προσφερθούν μόνο σύνδεσμοι προς τους επίσημους χάρτες έως ότου υπάρχει σαφής νόμιμη άδεια API.

## Δωρεάν έναντι επί πληρωμή

| Δυνατότητα | Δωρεάν | Παρατήρηση |
|---|---:|---|
| Open-Meteo forecast & air quality | Ναι | Best effort / όροι provider |
| RainViewer public radar | Ναι | Προσωπική/εκπαιδευτική/μικρής κλίμακας χρήση, attribution |
| OpenTopoData public SRTM | Ναι | Αυστηρό ημερήσιο quota |
| SunCalc / WGS84 / camera engines | Ναι | Τοπικοί υπολογισμοί |
| Xweather lightning events | Όχι συνήθως | Απαιτεί subscription/credentials |
| Web Push server, email, scheduler | Εξαρτάται | Hosting και delivery provider |

