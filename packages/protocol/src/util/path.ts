/**
 * A relative path the way Baton shows and matches it: with "/" on every platform (like git and
 * glob patterns). Only Windows paths are rewritten — elsewhere "\" is a valid filename character.
 */
export function toSlash(p: string): string {
  return process.platform === "win32" ? p.replace(/\\/g, "/") : p
}
