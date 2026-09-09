const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** Sortable, URL-safe id: 10 chars of time + 10 random chars (ULID-like, lowercase). */
export function newId(prefix?: string): string {
  let t = Date.now()
  let time = ""
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  let rand = ""
  for (const b of bytes) rand += ALPHABET[b % 32]
  return prefix ? `${prefix}_${time}${rand}` : time + rand
}

export function shortId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let s = ""
  for (const b of bytes) s += ALPHABET[b % 32]
  return s
}
