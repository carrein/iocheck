export const IOC_TYPES = ["ip", "domain", "sha256"] as const;
export type IOCType = (typeof IOC_TYPES)[number];

export interface IOC {
  type: IOCType;
  value: string;
  source: string;
  score: number;
  added_at?: string;
}

export interface LookupResponse {
  verdict: "malicious" | "unknown";
  ioc?: IOC;
}

export function isIOCType(s: unknown): s is IOCType {
  return typeof s === "string" && (IOC_TYPES as readonly string[]).includes(s);
}
