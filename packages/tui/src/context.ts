import { createContext, useContext } from "solid-js"
import type { UiState } from "./state.ts"

export const UiContext = createContext<UiState>()

export function useUi(): UiState {
  const ui = useContext(UiContext)
  if (!ui) throw new Error("UiContext missing")
  return ui
}
