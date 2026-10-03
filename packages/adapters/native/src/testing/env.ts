/**
 * Imported first by every test file: an isolated state dir (sessions, models.dev cache) shared by
 * the whole test run, and no network access for the models.dev catalogue.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

if (!process.env.BATON_NATIVE_TEST_STATE) {
  process.env.BATON_NATIVE_TEST_STATE = mkdtempSync(join(tmpdir(), "baton-native-state-"))
  process.env.BATON_STATE_DIR = process.env.BATON_NATIVE_TEST_STATE
  process.env.BATON_OFFLINE = "1"
}

export const TEST_STATE_DIR = process.env.BATON_NATIVE_TEST_STATE as string
