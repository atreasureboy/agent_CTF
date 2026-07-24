import type { ToolVisibility, ToolVisibilityPolicy } from './toolVisibilityPolicy.js'

export interface MCPServerConfig {
  name: string
  command: string
  args?: string[]
  visibility?: ToolVisibility[]
  exposeToolsToParent?: boolean
}

export class MCPVisibilityRegistry {
  private serverConfigs = new Map<string, MCPServerConfig>()
  private visibilityPolicy: ToolVisibilityPolicy

  constructor(policy: ToolVisibilityPolicy) {
    this.visibilityPolicy = policy
  }

  public registerServer(config: MCPServerConfig): void {
    this.serverConfigs.set(config.name, config)
  }

  public applyMCPServerVisibility(serverName: string, toolNames: string[]): void {
    const config = this.serverConfigs.get(serverName)
    if (!config || !config.visibility) return

    for (const toolName of toolNames) {
      this.visibilityPolicy.addRule({
        toolId: toolName,
        visibleTo: config.visibility,
      })
    }
  }

  public isMCPToolExposedToParent(serverName: string): boolean {
    const config = this.serverConfigs.get(serverName)
    return config?.exposeToolsToParent ?? false
  }
}
