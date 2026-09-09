/**
 * Agent grid: picks a column count from the width (`ui.min_card_width`, `ui.max_columns`),
 * gives every card an exact size (so headers can be composed precisely) and pages when
 * there are more agents than fit at `ui.min_card_height`.
 */
import { For, Show, createMemo } from "solid-js"
import { useUi } from "../context.ts"
import { segs } from "../ui/styled.ts"
import { AgentCard } from "./AgentCard.tsx"
import { BusPane } from "./BusPane.tsx"

export type Cell = { kind: "agent"; agentId: string } | { kind: "bus" }

export interface GridLayout {
  cols: number
  rows: number
  pages: number
  perPage: number
  cellH: number
}

export function computeGrid(n: number, width: number, height: number, opts: { minW: number; minH: number; maxCols: number }): GridLayout {
  if (n === 0) return { cols: 1, rows: 0, pages: 1, perPage: 0, cellH: height }
  let cols = Math.max(1, Math.min(opts.maxCols, Math.floor(width / opts.minW), n))
  let rows = Math.ceil(n / cols)
  const maxRows = Math.max(1, Math.floor(height / opts.minH))
  // prefer more columns over paging when it still respects the minimum width
  while (rows > maxRows && cols < Math.min(n, Math.floor(width / Math.max(20, opts.minW - 8)), opts.maxCols + 2)) {
    cols++
    rows = Math.ceil(n / cols)
  }
  const visibleRows = Math.min(rows, maxRows)
  const perPage = visibleRows * cols
  const pages = Math.max(1, Math.ceil(n / perPage))
  return { cols, rows: visibleRows, pages, perPage, cellH: Math.max(opts.minH, Math.floor(height / visibleRows)) }
}

/** Split `total` into `n` integer parts that differ by at most 1. */
export function split(total: number, n: number): number[] {
  const base = Math.floor(total / n)
  const extra = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0))
}

export function Grid(props: { width: number; height: number; cells: Cell[]; onSelect: (agentId: string) => void; onZoom: (agentId: string) => void }) {
  const ui = useUi()
  const layout = createMemo(() => {
    const pagerH = props.cells.length ? 0 : 0
    return computeGrid(props.cells.length, props.width, props.height - pagerH, {
      minW: ui.config.ui.min_card_width,
      minH: ui.config.ui.min_card_height,
      maxCols: ui.config.ui.max_columns,
    })
  })
  const page = () => Math.min(ui.page(), layout().pages - 1)
  const pageCells = createMemo(() => {
    const l = layout()
    const start = page() * l.perPage
    return props.cells.slice(start, start + l.perPage)
  })
  const rows = createMemo(() => {
    const l = layout()
    const cells = pageCells()
    const out: Cell[][] = []
    for (let i = 0; i < cells.length; i += l.cols) out.push(cells.slice(i, i + l.cols))
    return out
  })
  const heights = createMemo(() => {
    const showPager = layout().pages > 1
    return split(props.height - (showPager ? 1 : 0), Math.max(1, rows().length))
  })
  const focusedId = () => {
    const f = ui.focus()
    return f.kind === "agent" ? f.agentId : undefined
  }
  let lastClick = { id: "", at: 0 }

  return (
    <box width={props.width} height={props.height} flexDirection="column">
      <For each={rows()}>
        {(row, ri) => {
          const widths = () => split(props.width, row.length)
          return (
            <box flexDirection="row" height={heights()[ri()] ?? 1}>
              <For each={row}>
                {(cell, ci) =>
                  cell.kind === "bus" ? (
                    <BusPane width={widths()[ci()] ?? 10} height={heights()[ri()] ?? 1} />
                  ) : (
                    <AgentCard
                      agentId={cell.agentId}
                      width={widths()[ci()] ?? 10}
                      height={heights()[ri()] ?? 1}
                      focused={focusedId() === cell.agentId}
                      onSelect={() => {
                        const now = Date.now()
                        if (lastClick.id === cell.agentId && now - lastClick.at < 400) props.onZoom(cell.agentId)
                        else props.onSelect(cell.agentId)
                        lastClick = { id: cell.agentId, at: now }
                      }}
                    />
                  )
                }
              </For>
            </box>
          )
        }}
      </For>
      <Show when={layout().pages > 1}>
        <box height={1} flexDirection="row" justifyContent="center">
          <text
            wrapMode="none" >{segs(
              { text: `page ${page() + 1}/${layout().pages}`, fg: ui.theme().textMuted },
              { text: "  pgup/pgdn", fg: ui.theme().textSubtle },
            )}</text>
        </box>
      </Show>
    </box>
  )
}
