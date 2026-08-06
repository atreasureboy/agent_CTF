/**
 * Tool registry — ovogogogo agent base tools
 */

import type { Tool } from '../core/types.js'
import { BashTool } from './bash.js'
import { PythonTool } from './python.js'
import { FileReadTool } from './fileRead.js'
import { FileWriteTool } from './fileWrite.js'
import { FileEditTool } from './fileEdit.js'
import { GlobTool } from './glob.js'
import { GrepTool } from './grep.js'
import { TodoWriteTool } from './todo.js'
import { WebFetchTool } from './webFetch.js'
import { WebSearchTool } from './webSearch.js'
import { WebExplorerTool } from './webExplorer.js'
import { AgentTool } from './agent.js'
import { TmuxSessionTool } from './tmuxSession.js'
import { makeAllMetaTools } from './meta.js'
import { createCTFTools } from './ctf.js'
import { createVulnDetectionTools } from './vulnDetection.js'
import { createCTFUtilTools } from './ctfUtils.js'
import { createWebExplorerTool } from './webExplorer.js'
import { createLoadSkillTool } from './loadSkill.js'

export function createTools(extraTools: Tool[] = []): Tool[] {
  return [
    new BashTool(),
    new PythonTool(),
    new FileReadTool(),
    new FileWriteTool(),
    new FileEditTool(),
    new GlobTool(),
    new GrepTool(),
    new TodoWriteTool(),
    new WebFetchTool(),
    new WebSearchTool(),
    new AgentTool(),
    new TmuxSessionTool(),
    ...makeAllMetaTools(),
    ...createCTFTools(),
    ...createCTFUtilTools(),
    createLoadSkillTool(new Map()), // CTF path: no skills loaded; tool returns "not found"
    ...createWebExplorerTool(),
    ...createVulnDetectionTools(),
    ...extraTools,
  ]
}

export function getToolDefinitions(tools: Tool[]) {
  return tools.map((t) => t.definition)
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.name === name)
}

export {
  BashTool,
  PythonTool,
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GlobTool,
  GrepTool,
  TodoWriteTool,
  WebFetchTool,
  WebSearchTool,
  AgentTool,
  TmuxSessionTool,
  WebExplorerTool,
}
