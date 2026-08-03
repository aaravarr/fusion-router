/**
 * Slugify a provider display name into a stable unique key.
 * Example: "DeepSeek Official" -> "deepseek-official", "Novita" -> "novita".
 */
export function slugifyProviderName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug || "custom"
}
