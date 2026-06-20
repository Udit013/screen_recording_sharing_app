// Client-side stable anonymous id for unique-viewer counting (no PII).
export function getAnonId(): string {
  if (typeof window === "undefined") return "";
  const KEY = "snapcast_anon_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
