import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { toStyled } from "./styled.ts"
import { Txt } from "./Txt.tsx"

const L = (s: string) => ({ segs: [{ text: s }] })

test("Txt replaces content wholesale when it shrinks (no stale lines)", async () => {
  const variants = [[L("loading")], [L("a1"), L("a2"), L("a3")], [L("b1")], [L("c1"), L("c2")]]
  const [n, setN] = createSignal(0)
  const t = await testRender(
    () => (
      <box flexDirection="column">
        <Txt value={toStyled(variants[n()]!, 10)} />
        <Txt value={toStyled([L("---")], 10)} />
      </box>
    ),
    { width: 12, height: 8 },
  )
  const expected = [
    ["loading", "---"],
    ["a1", "a2", "a3", "---"],
    ["b1", "---"],
    ["c1", "c2", "---"],
  ]
  for (let i = 0; i < variants.length; i++) {
    setN(i)
    await t.renderOnce()
    const rows = t
      .captureCharFrame()
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean)
    expect(rows).toEqual(expected[i]!)
  }
  t.renderer.destroy()
})
