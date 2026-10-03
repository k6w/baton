/**
 * Replay: feeds a past run's events into a RunState at (accelerated) real-time pace, so the whole
 * UI plays the run back. Long quiet stretches are compressed; seeking backwards rebuilds the
 * state from the start (folding thousands of events takes milliseconds).
 */
import { RunState } from "@batonsh/kernel"
import type { BatonEvent } from "@batonsh/protocol"

export const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32]
/** Gaps longer than this (in run time) play as this long — nobody wants to watch an agent think for 4 minutes. */
const MAX_GAP_MS = 1500

export interface Marker {
  index: number
  kind: "spawn" | "merge" | "fail" | "ask" | "review" | "task"
}

export class Replay {
  index = 0
  playing = false
  speed = 4
  readonly markers: Marker[]
  private timer: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<() => void>()

  constructor(
    readonly events: BatonEvent[],
    readonly state: RunState,
    readonly title: string,
  ) {
    this.markers = []
    events.forEach((e, index) => {
      const kind: Marker["kind"] | undefined =
        e.type === "agent.spawned"
          ? "spawn"
          : e.type === "workspace.merge" && e.data.status === "merged"
            ? "merge"
            : (e.type === "workspace.merge" && (e.data.status === "failed" || e.data.status === "conflict")) || (e.type === "error" && e.data.fatal)
              ? "fail"
              : e.type === "permission.requested"
                ? "ask"
                : e.type === "review.verdict"
                  ? "review"
                  : e.type === "task.plan"
                    ? "task"
                    : undefined
      if (kind) this.markers.push({ index, kind })
    })
  }

  get startTs(): number {
    return this.events[0]?.ts ?? 0
  }
  get endTs(): number {
    return this.events.at(-1)?.ts ?? 0
  }
  get nowTs(): number {
    return this.events[Math.max(0, this.index - 1)]?.ts ?? this.startTs
  }
  get done(): boolean {
    return this.index >= this.events.length
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private changed() {
    for (const l of this.listeners) l()
  }

  /** Apply events until `index` (rebuilding from scratch when going back). */
  seek(index: number) {
    const target = Math.max(0, Math.min(this.events.length, index))
    if (target < this.index) {
      this.state.reset()
      this.index = 0
    }
    while (this.index < target) this.state.apply(this.events[this.index++]!)
    this.changed()
    if (this.playing) this.schedule()
  }

  /** Jump by run time (ms, negative = back). */
  seekTime(deltaMs: number) {
    const target = this.nowTs + deltaMs
    let i = this.events.findIndex((e) => e.ts > target)
    if (i < 0) i = this.events.length
    this.seek(Math.max(1, i))
  }

  /** Jump to the next / previous marker (merge, failure, approval, …). */
  seekMarker(dir: 1 | -1) {
    const m = dir === 1 ? this.markers.find((x) => x.index >= this.index) : [...this.markers].reverse().find((x) => x.index < this.index - 1)
    this.seek(m ? m.index + 1 : dir === 1 ? this.events.length : 0)
  }

  toggle() {
    if (this.done && !this.playing) this.seek(0)
    this.playing = !this.playing
    if (this.playing) this.schedule()
    else this.clear()
    this.changed()
  }

  faster(dir: 1 | -1) {
    const i = SPEEDS.indexOf(this.speed)
    this.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 1 : i) + dir))]!
    this.changed()
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule() {
    this.clear()
    if (this.done) {
      this.playing = false
      this.changed()
      return
    }
    const prev = this.events[this.index - 1]
    const next = this.events[this.index]!
    const gap = prev ? Math.min(MAX_GAP_MS, Math.max(0, next.ts - prev.ts)) : 0
    this.timer = setTimeout(() => {
      // apply everything that falls in the same frame together (bursts of token deltas)
      const until = next.ts + 30 * this.speed
      while (!this.done && (this.events[this.index]!.ts <= until || this.index === 0)) this.state.apply(this.events[this.index++]!)
      this.changed()
      this.schedule()
    }, gap / this.speed)
  }

  dispose() {
    this.clear()
    this.listeners.clear()
  }
}

/** A fresh RunState already showing the run's project (empty until played). */
export function replayState(events: BatonEvent[]): RunState {
  const st = new RunState()
  const started = events.find((e) => e.type === "run.started")
  if (started && started.type === "run.started") st.projectRoot = started.data.cwd
  return st
}
