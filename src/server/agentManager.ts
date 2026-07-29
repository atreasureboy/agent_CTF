import { randomUUID } from 'node:crypto'

export interface AgentInfo {
  id: string
  name: string
  host: string
  status: 'idle' | 'running' | 'error' | 'offline'
  capabilities: string[]
  currentTaskId?: string
  lastHeartbeat: number
  metadata: Record<string, unknown>
}

export class AgentManager {
  private agents: Map<string, AgentInfo>
  private heartbeatTimeout: number

  constructor(heartbeatTimeoutMs: number = 30000) {
    this.agents = new Map()
    this.heartbeatTimeout = heartbeatTimeoutMs
  }

  registerAgent(agent: Omit<AgentInfo, 'lastHeartbeat'>): AgentInfo {
    const info: AgentInfo = {
      id: agent.id || randomUUID(),
      name: agent.name,
      host: agent.host,
      status: agent.status,
      capabilities: agent.capabilities,
      currentTaskId: agent.currentTaskId,
      lastHeartbeat: Date.now(),
      metadata: agent.metadata,
    }
    this.agents.set(info.id, info)
    return info
  }

  unregisterAgent(id: string): void {
    this.agents.delete(id)
  }

  heartbeat(id: string): void {
    const agent = this.agents.get(id)
    if (!agent) throw new Error(`Agent ${id} not found`)
    agent.lastHeartbeat = Date.now()
    if (agent.status === 'offline') {
      agent.status = 'idle'
    }
  }

  getAgent(id: string): AgentInfo | undefined {
    return this.agents.get(id)
  }

  listAgents(): AgentInfo[] {
    return Array.from(this.agents.values())
  }

  getAvailableAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).filter((a) => a.status === 'idle')
  }

  assignTask(agentId: string, taskId: string): void {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent ${agentId} not found`)
    if (agent.status !== 'idle') throw new Error(`Agent ${agentId} is not idle (status: ${agent.status})`)
    agent.currentTaskId = taskId
    agent.status = 'running'
    agent.lastHeartbeat = Date.now()
  }

  releaseTask(agentId: string): void {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent ${agentId} not found`)
    agent.currentTaskId = undefined
    agent.status = 'idle'
    agent.lastHeartbeat = Date.now()
  }

  pruneOfflineAgents(): string[] {
    const now = Date.now()
    const pruned: string[] = []
    for (const [id, agent] of this.agents) {
      if (now - agent.lastHeartbeat > this.heartbeatTimeout) {
        agent.status = 'offline'
        if (now - agent.lastHeartbeat > this.heartbeatTimeout * 2) {
          this.agents.delete(id)
          pruned.push(id)
        }
      }
    }
    return pruned
  }
}
