import { z } from "zod";

// z.coerce.number() turns "" into 0, which silently moved empty coordinates to (0, 0).
const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const numberParam = (min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().finite().min(min).max(max));

export const optionalNumberParam = (min: number, max: number, fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().finite().min(min).max(max).default(fallback));
