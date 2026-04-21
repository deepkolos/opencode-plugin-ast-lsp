import type { PluginInput } from "@opencode-ai/plugin"

let _input: PluginInput | undefined

export function setPluginInput(input: PluginInput) {
  _input = input
}

export function getPluginInput(): PluginInput {
  if (!_input) {
    throw new Error("PluginInput not initialized")
  }
  return _input
}
