/**
 * Live contract suite against a real ACP agent (`opencode acp`). Opt-in: BATON_LIVE=1.
 * Uses whatever model/provider OpenCode is configured with.
 */
import { describe, expect, test } from "bun:test"
import { contractSuite } from "../../testkit/src/index.ts"
import { ACP_PRESETS, createAcpAdapter } from "./index.ts"

const opencode = ACP_PRESETS.find((p) => p.id === "opencode-acp")
if (!opencode) throw new Error("opencode-acp preset missing")

describe("acp adapter — live: opencode acp", () => {
  contractSuite(createAcpAdapter(opencode), { test, expect }, { model: process.env.BATON_ACP_MODEL })
})
