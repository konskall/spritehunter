// World Magnetic Model 2025. Algorithm and coefficients are adapted from the
// NOAA/NCEI public-domain WMM implementation (valid through 2029-12-31).

const WMM_EPOCH = 2025;
const MAX_ORDER = 12;
const A = 6378.137;
const B = 6356.7523142;
const RE = 6371.2;

const COEFFICIENTS = `
1 0 -29351.8 0.0 12.0 0.0
1 1 -1410.8 4545.4 9.7 -21.5
2 0 -2556.6 0.0 -11.6 0.0
2 1 2951.1 -3133.6 -5.2 -27.7
2 2 1649.3 -815.1 -8.0 -12.1
3 0 1361.0 0.0 -1.3 0.0
3 1 -2404.1 -56.6 -4.2 4.0
3 2 1243.8 237.5 0.4 -0.3
3 3 453.6 -549.5 -15.6 -4.1
4 0 895.0 0.0 -1.6 0.0
4 1 799.5 278.6 -2.4 -1.1
4 2 55.7 -133.9 -6.0 4.1
4 3 -281.1 212.0 5.6 1.6
4 4 12.1 -375.6 -7.0 -4.4
5 0 -233.2 0.0 0.6 0.0
5 1 368.9 45.4 1.4 -0.5
5 2 187.2 220.2 0.0 2.2
5 3 -138.7 -122.9 0.6 0.4
5 4 -142.0 43.0 2.2 1.7
5 5 20.9 106.1 0.9 1.9
6 0 64.4 0.0 -0.2 0.0
6 1 63.8 -18.4 -0.4 0.3
6 2 76.9 16.8 0.9 -1.6
6 3 -115.7 48.8 1.2 -0.4
6 4 -40.9 -59.8 -0.9 0.9
6 5 14.9 10.9 0.3 0.7
6 6 -60.7 72.7 0.9 0.9
7 0 79.5 0.0 0.0 0.0
7 1 -77.0 -48.9 -0.1 0.6
7 2 -8.8 -14.4 -0.1 0.5
7 3 59.3 -1.0 0.5 -0.8
7 4 15.8 23.4 -0.1 0.0
7 5 2.5 -7.4 -0.8 -1.0
7 6 -11.1 -25.1 -0.8 0.6
7 7 14.2 -2.3 0.8 -0.2
8 0 23.2 0.0 -0.1 0.0
8 1 10.8 7.1 0.2 -0.2
8 2 -17.5 -12.6 0.0 0.5
8 3 2.0 11.4 0.5 -0.4
8 4 -21.7 -9.7 -0.1 0.4
8 5 16.9 12.7 0.3 -0.5
8 6 15.0 0.7 0.2 -0.6
8 7 -16.8 -5.2 0.0 0.3
8 8 0.9 3.9 0.2 0.2
9 0 4.6 0.0 0.0 0.0
9 1 7.8 -24.8 -0.1 -0.3
9 2 3.0 12.2 0.1 0.3
9 3 -0.2 8.3 0.3 -0.3
9 4 -2.5 -3.3 -0.3 0.3
9 5 -13.1 -5.2 0.0 0.2
9 6 2.4 7.2 0.3 -0.1
9 7 8.6 -0.6 -0.1 -0.2
9 8 -8.7 0.8 0.1 0.4
9 9 -12.9 10.0 -0.1 0.1
10 0 -1.3 0.0 0.1 0.0
10 1 -6.4 3.3 0.0 0.0
10 2 0.2 0.0 0.1 0.0
10 3 2.0 2.4 0.1 -0.2
10 4 -1.0 5.3 0.0 0.1
10 5 -0.6 -9.1 -0.3 -0.1
10 6 -0.9 0.4 0.0 0.1
10 7 1.5 -4.2 -0.1 0.0
10 8 0.9 -3.8 -0.1 -0.1
10 9 -2.7 0.9 0.0 0.2
10 10 -3.9 -9.1 0.0 0.0
11 0 2.9 0.0 0.0 0.0
11 1 -1.5 0.0 0.0 0.0
11 2 -2.5 2.9 0.0 0.1
11 3 2.4 -0.6 0.0 0.0
11 4 -0.6 0.2 0.0 0.1
11 5 -0.1 0.5 -0.1 0.0
11 6 -0.6 -0.3 0.0 0.0
11 7 -0.1 -1.2 0.0 0.1
11 8 1.1 -1.7 -0.1 0.0
11 9 -1.0 -2.9 -0.1 0.0
11 10 -0.2 -1.8 -0.1 0.0
11 11 2.6 -2.3 -0.1 0.0
12 0 -2.0 0.0 0.0 0.0
12 1 -0.2 -1.3 0.0 0.0
12 2 0.3 0.7 0.0 0.0
12 3 1.2 1.0 0.0 -0.1
12 4 -1.3 -1.4 0.0 0.1
12 5 0.6 0.0 0.0 0.0
12 6 0.6 0.6 0.1 0.0
12 7 0.5 -0.1 0.0 0.0
12 8 -0.1 0.8 0.0 0.0
12 9 -0.4 0.1 0.0 0.0
12 10 -0.2 -1.0 -0.1 0.0
12 11 -1.3 0.1 0.0 0.0
12 12 -0.7 0.2 -0.1 -0.1`;

function matrix() {
  return Array.from({ length: MAX_ORDER + 1 }, () => Array(MAX_ORDER + 1).fill(0) as number[]);
}

const c = matrix();
const cd = matrix();
const k = matrix();
const snorm = matrix();

for (const line of COEFFICIENTS.trim().split("\n")) {
  const [n, m, gnm, hnm, dgnm, dhnm] = line.trim().split(/\s+/).map(Number);
  c[m][n] = gnm;
  cd[m][n] = dgnm;
  if (m !== 0) {
    c[n][m - 1] = hnm;
    cd[n][m - 1] = dhnm;
  }
}

snorm[0][0] = 1;
for (let n = 1; n <= MAX_ORDER; n += 1) {
  snorm[0][n] = snorm[0][n - 1] * (2 * n - 1) / n;
  let j = 2;
  for (let m = 0; m <= n; m += 1) {
    k[m][n] = (((n - 1) ** 2) - m ** 2) / ((2 * n - 1) * (2 * n - 3));
    if (m > 0) {
      snorm[m][n] = snorm[m - 1][n] * Math.sqrt(((n - m + 1) * j) / (n + m));
      j = 1;
      c[n][m - 1] *= snorm[m][n];
      cd[n][m - 1] *= snorm[m][n];
    }
    c[m][n] *= snorm[m][n];
    cd[m][n] *= snorm[m][n];
  }
}
k[1][1] = 0;

function decimalYear(date: Date) {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - start) / (end - start);
}

export function magneticDeclination(latitude: number, longitude: number, altitudeMeters = 0, date = new Date()) {
  const lat = latitude * Math.PI / 180;
  const lon = longitude * Math.PI / 180;
  const alt = altitudeMeters / 1000;
  const a2 = A * A;
  const b2 = B * B;
  const c2 = a2 - b2;
  const a4 = a2 * a2;
  const b4 = b2 * b2;
  const c4 = a4 - b4;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const q = Math.sqrt(a2 - c2 * sinLat ** 2);
  const q1 = alt * q;
  const q2 = ((q1 + a2) / (q1 + b2)) ** 2;
  const ct = sinLat / Math.sqrt(q2 * cosLat ** 2 + sinLat ** 2);
  const st = Math.sqrt(1 - ct ** 2);
  const r2 = alt ** 2 + 2 * q1 + (a4 - c4 * sinLat ** 2) / q ** 2;
  const r = Math.sqrt(r2);
  const d = Math.sqrt(a2 * cosLat ** 2 + b2 * sinLat ** 2);
  const ca = (alt + d) / r;
  const sa = c2 * cosLat * sinLat / (r * d);
  const sp = Array(MAX_ORDER + 1).fill(0) as number[];
  const cp = Array(MAX_ORDER + 1).fill(0) as number[];
  const pp = Array(MAX_ORDER + 1).fill(0) as number[];
  const p = matrix();
  const dp = matrix();
  const tc = matrix();
  sp[1] = Math.sin(lon);
  cp[1] = Math.cos(lon);
  cp[0] = 1;
  pp[0] = 1;
  p[0][0] = 1;
  for (let m = 2; m <= MAX_ORDER; m += 1) {
    sp[m] = sp[1] * cp[m - 1] + cp[1] * sp[m - 1];
    cp[m] = cp[1] * cp[m - 1] - sp[1] * sp[m - 1];
  }
  const dt = decimalYear(date) - WMM_EPOCH;
  const aor = RE / r;
  let ar = aor ** 2;
  let br = 0;
  let bt = 0;
  let bp = 0;
  let bpp = 0;
  for (let n = 1; n <= MAX_ORDER; n += 1) {
    ar *= aor;
    for (let m = 0; m <= n; m += 1) {
      if (n === m) {
        p[m][n] = st * p[m - 1][n - 1];
        dp[m][n] = st * dp[m - 1][n - 1] + ct * p[m - 1][n - 1];
      } else if (n === 1 && m === 0) {
        p[m][n] = ct * p[m][n - 1];
        dp[m][n] = ct * dp[m][n - 1] - st * p[m][n - 1];
      } else {
        p[m][n] = ct * p[m][n - 1] - k[m][n] * (p[m][n - 2] ?? 0);
        dp[m][n] = ct * dp[m][n - 1] - st * p[m][n - 1] - k[m][n] * (dp[m][n - 2] ?? 0);
      }
      tc[m][n] = c[m][n] + dt * cd[m][n];
      if (m !== 0) tc[n][m - 1] = c[n][m - 1] + dt * cd[n][m - 1];
      const par = ar * p[m][n];
      const temp1 = m === 0 ? tc[m][n] * cp[m] : tc[m][n] * cp[m] + tc[n][m - 1] * sp[m];
      const temp2 = m === 0 ? tc[m][n] * sp[m] : tc[m][n] * sp[m] - tc[n][m - 1] * cp[m];
      bt -= ar * temp1 * dp[m][n];
      bp += m * temp2 * par;
      br += (n + 1) * temp1 * par;
      if (st === 0 && m === 1) {
        pp[n] = n === 1 ? pp[n - 1] : ct * pp[n - 1] - k[m][n] * pp[n - 2];
        bpp += m * temp2 * ar * pp[n];
      }
    }
  }
  bp = st === 0 ? bpp : bp / st;
  const bx = -bt * ca - br * sa;
  const by = bp;
  return Math.atan2(by, bx) * 180 / Math.PI;
}

export function normalizeBearing(value: number) {
  return ((value % 360) + 360) % 360;
}
