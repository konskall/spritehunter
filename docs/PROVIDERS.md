# Πάροχοι δεδομένων, όρια και κόστος

Η τεκμηρίωση ελέγχθηκε στις 11 Οκτωβρίου 2026. Επειδή οι υπηρεσίες αλλάζουν, επαλήθευσε ξανά όρους και quotas πριν από δημόσια ή εμπορική διάθεση.

## Open-Meteo Forecast

- Endpoint: `https://api.open-meteo.com/v1/forecast`
- Χρήση: cloud cover low/mid/high, visibility, precipitation/probability, humidity, wind, CAPE και WMO weather code.
- Το app στέλνει τρεις multi-coordinate αιτήσεις (παρατηρητής + 2 × 12 σημεία σε τρεις αποστάσεις και οκτώ αζιμούθια) για 48 ώρες. Περισσότερες παράλληλες αιτήσεις προκαλούσαν HTTP 429.
- Κάθε αίτηση έχει όριο 12 s και συνολικό όριο 20 s με ένα retry· σε αποτυχία εμφανίζονται μερικά αποτελέσματα.
- Cache εφαρμογής: 15 λεπτά. Το `/api/opportunities` δέχεται έως 30 αιτήματα/λεπτό ανά IP.
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
- Δημόσιο όριο: 100 θέσεις/αίτηση, 1 κλήση/δευτερόλεπτο, 1.000 κλήσεις/ημέρα. Το `/api/terrain` δέχεται έως 20 αιτήματα/λεπτό ανά IP.
- Το app ζητά 20 προσαρμοστικά δείγματα έως 120 km για τη διεύθυνση κάθε στόχου της λίστας. Μία κλήση στο `/api/terrain` καλύπτει όλους τους στόχους· ο server βάζει 5 διευθύνσεις σε κάθε αίτηση DEM (100 θέσεις), με μία αίτηση το δευτερόλεπτο, και κρατά κάθε διεύθυνση 7 ημέρες.
- Δεν χαρακτηρίζει τον ορίζοντα «επαληθευμένο» όταν λείπουν τιμές DEM.
- Για παραγωγικό πλήρες 360° profile προτείνεται self-hosted SRTM/Copernicus pipeline με τοπικά cached tiles.

## Vaisala Xweather (προαιρετικό, με κλειδί)

- Endpoint: `https://data.api.xweather.com/lightning/summary/{lat},{lon}?radius=…km&filter=cg&from=-15minutes&to=now` (κόστος ×1 ανά κλήση). Δίνει πλήθος CG, θετικούς/αρνητικούς και στατιστικά peak current σε αμπέρ.
- Το `/lightning/within` για όλη την περιοχή απαιτεί το Lightning Enterprise add-on, γι' αυτό η εφαρμογή ρωτά ανά καταιγίδα.
- Μόνο τη νύχτα στον παρατηρητή, έως 4 καταιγίδες ανά σάρωση, cache 10 λεπτών. Ο server διαβάζει τα `X-RateLimit-*-Period` headers και σταματά κάτω από 1.000 μονάδες υπόλοιπο (όριο του τρέχοντος λογαριασμού: 15.000 τον μήνα, 100 το λεπτό).
- Απαιτείται η ένδειξη «Powered by Vaisala Xweather» όπου εμφανίζονται δεδομένα του· η εφαρμογή τη δείχνει δίπλα σε κάθε στοιχείο +CG.
- Μεταβλητές: `XWEATHER_CLIENT_ID`, `XWEATHER_CLIENT_SECRET` (μόνο στον server).

## WeatherAPI.com (προαιρετικό, με κλειδί)

- Endpoint: `https://api.weatherapi.com/v1/forecast.json?q={lat},{lon}&days=3` (δωρεάν πλάνο). Χρησιμοποιείται μόνο η ωριαία συνολική νέφωση στη θέση του παρατηρητή.
- Κρατιέται μαζί με την πρόγνωση Open-Meteo 15 λεπτά. Μεταβλητή: `WEATHERAPI_KEY`.

## OpenWeatherMap (προαιρετικό, με κλειδί)

- Endpoint: `https://api.openweathermap.org/data/2.5/forecast?lat=…&lon=…` (δωρεάν πλάνο, βήματα 3 ωρών). Χρησιμοποιείται μόνο η συνολική νέφωση στη θέση του παρατηρητή, για ώρες έως ±90 λεπτά από κάθε βήμα.
- Κρατιέται μαζί με την πρόγνωση Open-Meteo 15 λεπτά. Μεταβλητή: `OPENWEATHER_API_KEY`.

## EUMETSAT EUMETView WMS

- Endpoint: `https://view.eumetsat.int/geoserver/wms` (δημόσιο, χωρίς κλειδί).
- Layers: `mtg_fd:li_afa` (MTG-LI), `mtg_fd:ir105_hrfi`, `msg_fes:cth`, `msg_fes:gii_kindex`.
- Το app ζητά **μία** εικόνα GetMap ανά layer για όλη την προβολή του χάρτη, σε `EPSG:3857`, έως 1024 px. Αιτήματα σε `CRS:84` μετατόπιζαν τα σημεία έως ~40 km, και μεγαλύτερες εικόνες επέστρεφαν συχνά HTTP 500/504. Σε αποτυχία γίνονται έως δύο επαναλήψεις.
- Επιπλέον, ο server ζητά τα 3 τελευταία καρέ `mtg_fd:li_afa` σε `CRS:84` (έως 1024 px, ~0,04°/px, `image/png8` με παλέτα) και τα αποκωδικοποιεί για να εντοπίσει παρατηρημένες καταιγίδες. Η παλέτα δίνει τα ίδια φωτισμένα pixel και χρώματα υπομνήματος με το RGBA, με το ¼ των δεδομένων προς αποσυμπίεση. Ταυτόχρονα αιτήματα για την ίδια περιοχή μοιράζονται μία κλήση. Η ώρα κάθε καρέ διαβάζεται από το header `Warning: 99 … time=…` του GeoServer. Τα αποτελέσματα κρατιούνται 4 λεπτά ανά περιοχή (1 λεπτό σε αποτυχία), ενώ η πρόγνωση Open-Meteo κρατιέται 15 λεπτά.

## AviationWeather.gov METAR / TAF

- Endpoint: `https://aviationweather.gov/api/data/metar` και `/taf` (δωρεάν, χωρίς κλειδί, χωρίς CORS· μόνο μέσω server).
- Επιλέγεται η νεότερη αναφορά κάθε σταθμού και ο πλησιέστερος σταθμός με αναφορά έως 90 λεπτών.
- Στη βαθμολογία χρησιμοποιείται μόνο για χαμηλή/μέση νέφωση και ορατότητα· δεν βλέπει cirrus, οπότε η υψηλή νέφωση έρχεται πάντα από την πρόγνωση.
- Το `9999` (ή CAVOK) σημαίνει ορατότητα 10 km ή περισσότερο. Είναι κατώτατο όριο, οπότε δεν μειώνει μια πρόγνωση με μεγαλύτερη ορατότητα. Το API δίνει «6+» μίλια και δεν δίνει τύπους νεφών, οπότε οι πυργωμένοι σωρείτες (TCU) και οι σωρειτομελανίες (CB) διαβάζονται από το αυτούσιο δελτίο.

## MeteoAlarm

- Endpoint: `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece` (χωρίς CORS· μόνο μέσω server).
- Εμφανίζεται ο πραγματικός αριθμός ενεργών/επικείμενων προειδοποιήσεων. Η σειρά βασίζεται σε προσεγγιστικό κέντρο καθεμιάς από τις 16 περιοχές, στη σοβαρότητα και στον τύπο καταιγίδας.

## NOAA SWPC

- `planetary_k_index_1m.json` και `ovation_aurora_latest.json` (~900 KB). Τα δεδομένα είναι κοινά για όλους τους χρήστες, κρατούνται 5 λεπτά στον server και ζητούνται μόνο όταν ανοίγει η οθόνη σέλαος.

## OpenStreetMap tiles

- `https://tile.openstreetmap.org` για το υπόβαθρο, με ορατό attribution. Για δημόσια ή εμπορική χρήση με κίνηση απαιτείται δικός σου tile provider, σύμφωνα με την πολιτική χρήσης του OSM.

## Blitzortung / LightningMaps

Δεν γίνεται scraping, χρήση ιδιωτικών WebSocket feeds ή προστατευμένων endpoints. Μπορούν να προσφερθούν μόνο σύνδεσμοι προς τους επίσημους χάρτες έως ότου υπάρχει σαφής νόμιμη άδεια API.

## Δωρεάν έναντι επί πληρωμή

| Δυνατότητα | Δωρεάν | Παρατήρηση |
|---|---:|---|
| Open-Meteo forecast & air quality | Ναι | Best effort / όροι provider |
| RainViewer public radar | Ναι | Προσωπική/εκπαιδευτική/μικρής κλίμακας χρήση, attribution |
| OpenTopoData public SRTM | Ναι | Αυστηρό ημερήσιο quota |
| SunCalc / WGS84 / camera engines | Ναι | Τοπικοί υπολογισμοί |
| Xweather +CG (lightning summary) | Με κλειδί | Μηνιαίο όριο μονάδων· η εφαρμογή το προστατεύει |
| WeatherAPI.com / OpenWeatherMap νέφωση | Δωρεάν πλάνο | Απαιτούν κλειδί |
| Web Push server, email, scheduler | Εξαρτάται | Hosting και delivery provider |

