import type { EumetsatMetadata } from "@/lib/domain";

export const EUMETSAT_WMS_URL = "https://view.eumetsat.int/geoserver/wms";
export const EUMETSAT_CAPABILITIES_URL = `${EUMETSAT_WMS_URL}?service=WMS&version=1.3.0&request=GetCapabilities`;

const PRODUCTS = {
  lightning: { layer: "mtg_fd:li_afa", style: "mtg_li_afa" },
  infrared: { layer: "mtg_fd:ir105_hrfi", style: "mtg_fd:mtg_fd_ir105_hrfi_style_01" },
  cloudTop: { layer: "msg_fes:cth", style: "msg_cth" },
  kIndex: { layer: "msg_fes:gii_kindex", style: "msg_gii_ki" },
  liftedIndex: { layer: "msg_fes:gii_liftedindex", style: "msg_gii_li" },
} as const;

export type EumetsatProduct = keyof typeof PRODUCTS;

function layerSection(xml: string, layerName: string) {
  const marker = `<Name>${layerName}</Name>`;
  const markerIndex = xml.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = xml.lastIndexOf("<Layer", markerIndex);
  const end = xml.indexOf("</Layer>", markerIndex);
  return start >= 0 && end >= 0 ? xml.slice(start, end + 8) : null;
}

function defaultTime(xml: string, layerName: string) {
  const section = layerSection(xml, layerName);
  const dimension = section?.match(/<Dimension\b[^>]*\bname=["']time["'][^>]*>/i)?.[0];
  return dimension?.match(/\bdefault=["']([^"']+)["']/i)?.[1] ?? null;
}

export function parseEumetsatCapabilities(xml: string, retrievedAt = new Date().toISOString()): EumetsatMetadata {
  const lightningTime = defaultTime(xml, PRODUCTS.lightning.layer);
  const infraredTime = defaultTime(xml, PRODUCTS.infrared.layer);
  const cloudTopTime = defaultTime(xml, PRODUCTS.cloudTop.layer);
  const kIndexTime = defaultTime(xml, PRODUCTS.kIndex.layer);
  const liftedIndexTime = defaultTime(xml, PRODUCTS.liftedIndex.layer);
  const available = Boolean(lightningTime || infraredTime || cloudTopTime || kIndexTime || liftedIndexTime);
  return {
    status: available ? "available" : "unavailable",
    retrievedAt,
    lightningTime,
    infraredTime,
    cloudTopTime,
    kIndexTime,
    liftedIndexTime,
    message: available
      ? "EUMETSAT MTG-LI, υπέρυθρα νέφη, ύψος κορυφών και δείκτες αστάθειας διαθέσιμα μέσω του δημόσιου EUMETView WMS."
      : "Τα αναμενόμενα στρώματα EUMETSAT δεν βρέθηκαν στο EUMETView WMS.",
  };
}

export async function fetchEumetsatMetadata(): Promise<EumetsatMetadata> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(EUMETSAT_CAPABILITIES_URL, {
      headers: { Accept: "application/xml,text/xml" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`EUMETView WMS ${response.status}`);
    return parseEumetsatCapabilities(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

export function webMercatorTileBounds(x: number, y: number, zoom: number) {
  const tiles = 2 ** zoom;
  const longitude = (tileX: number) => tileX / tiles * 360 - 180;
  const latitude = (tileY: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / tiles))) * 180 / Math.PI;
  return {
    west: longitude(x),
    east: longitude(x + 1),
    north: latitude(y),
    south: latitude(y + 1),
  };
}

export function eumetsatTileUrl(kind: EumetsatProduct, x: number, y: number, zoom: number, time?: string | null) {
  const product = PRODUCTS[kind];
  const bounds = webMercatorTileBounds(x, y, zoom);
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: product.layer,
    styles: product.style,
    format: "image/png",
    transparent: "true",
    width: "256",
    height: "256",
    crs: "CRS:84",
    bbox: [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(6)).join(","),
  });
  if (time) params.set("time", time);
  return `${EUMETSAT_WMS_URL}?${params}`;
}
