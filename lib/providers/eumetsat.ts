import type { EumetsatMetadata } from "@/lib/domain";
import { tx } from "@/lib/i18n";

export const EUMETSAT_WMS_URL = "https://view.eumetsat.int/geoserver/wms";
const EUMETSAT_CAPABILITIES_URL = `${EUMETSAT_WMS_URL}?service=WMS&version=1.3.0&request=GetCapabilities`;

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
      ? tx("EUMETSAT MTG-LI, υπέρυθρα νέφη, ύψος κορυφών και δείκτες αστάθειας διαθέσιμα μέσω του δημόσιου EUMETView WMS.", "EUMETSAT MTG-LI, infrared clouds, cloud-top height and instability indices are available from the public EUMETView WMS.")
      : tx("Τα αναμενόμενα στρώματα EUMETSAT δεν βρέθηκαν στο EUMETView WMS.", "The expected EUMETSAT layers were not found in the EUMETView WMS."),
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

const MERCATOR_HALF_WORLD_M = Math.PI * 6_378_137;

/** Map world-pixel coordinates (256 px tiles) to EPSG:3857 metres. */
export function worldPixelToMercator(x: number, y: number, zoom: number) {
  const scale = 256 * 2 ** zoom;
  return {
    x: (x / scale) * 2 * MERCATOR_HALF_WORLD_M - MERCATOR_HALF_WORLD_M,
    y: MERCATOR_HALF_WORLD_M - (y / scale) * 2 * MERCATOR_HALF_WORLD_M,
  };
}

export interface MercatorBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * One GetMap image for the whole viewport, in the map's own projection.
 * Requesting CRS:84 (plate carrée) images for Mercator tiles shifted features
 * by tens of kilometres, and per-tile requests took 12–16 s each in the browser.
 */
export function eumetsatImageUrl(kind: EumetsatProduct, bounds: MercatorBounds, width: number, height: number, time?: string | null) {
  const product = PRODUCTS[kind];
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: product.layer,
    styles: product.style,
    format: "image/png",
    transparent: "true",
    width: String(Math.round(width)),
    height: String(Math.round(height)),
    crs: "EPSG:3857",
    bbox: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].map((value) => String(Math.round(value * 100) / 100)).join(","),
  });
  if (time) params.set("time", time);
  return `${EUMETSAT_WMS_URL}?${params}`;
}
