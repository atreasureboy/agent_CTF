import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface CTFTask {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  target: string
  description: string
  flag?: string
  findings: Array<{ id: string; title: string; category: string; confidence: string }>
  createdAt: number
  updatedAt: number
}

export class TaskServer {
  private server: http.Server
  private tasks: Map<string, CTFTask>
  private port: number

  constructor(port: number = 3000) {
    this.port = port
    this.tasks = new Map()
    this.server = http.createServer((req, res) => { void this.handleRequest(req, res) })
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => resolve())
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  createTask(task: Omit<CTFTask, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'findings'>): CTFTask {
    const now = Date.now()
    const newTask: CTFTask = {
      id: randomUUID(),
      name: task.name,
      status: 'pending',
      target: task.target,
      description: task.description,
      findings: [],
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(newTask.id, newTask)
    return newTask
  }

  getTask(id: string): CTFTask | undefined {
    return this.tasks.get(id)
  }

  listTasks(): CTFTask[] {
    return Array.from(this.tasks.values())
  }

  updateTaskStatus(id: string, status: CTFTask['status']): void {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`Task ${id} not found`)
    task.status = status
    task.updatedAt = Date.now()
  }

  addFinding(taskId: string, finding: { title: string; category: string; confidence: string }): void {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    task.findings.push({ id: randomUUID(), ...finding })
    task.updatedAt = Date.now()
  }

  setFlag(taskId: string, flag: string): void {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    task.flag = flag
    task.updatedAt = Date.now()
  }

  deleteTask(id: string): boolean {
    return this.tasks.delete(id)
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && path === '/') {
        this.serveDashboard(res)
        return
      }

      if (method === 'GET' && path === '/api/health') {
        this.sendJson(res, 200, { status: 'ok', taskCount: this.tasks.size })
        return
      }

      if (method === 'GET' && path === '/api/tasks') {
        this.sendJson(res, 200, this.listTasks())
        return
      }

      if (method === 'POST' && path === '/api/tasks') {
        const body = (await this.readBody(req)) as Omit<CTFTask, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'findings'>
        const task = this.createTask(body)
        this.sendJson(res, 201, task)
        return
      }

      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/)
      if (taskMatch) {
        const id = taskMatch[1]

        if (method === 'GET') {
          const task = this.getTask(id)
          if (!task) {
            this.sendJson(res, 404, { error: 'Task not found' })
            return
          }
          this.sendJson(res, 200, task)
          return
        }

        if (method === 'PATCH') {
          const body = await this.readBody(req) as Record<string, unknown>
          const task = this.getTask(id)
          if (!task) {
            this.sendJson(res, 404, { error: 'Task not found' })
            return
          }
          if (body.status) this.updateTaskStatus(id, body.status as CTFTask['status'])
          if (body.flag) this.setFlag(id, body.flag as string)
          this.sendJson(res, 200, this.getTask(id))
          return
        }

        if (method === 'DELETE') {
          const deleted = this.deleteTask(id)
          if (!deleted) {
            this.sendJson(res, 404, { error: 'Task not found' })
            return
          }
          this.sendJson(res, 200, { deleted: true })
          return
        }
      }

      this.sendJson(res, 404, { error: 'Not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      this.sendJson(res, 500, { error: message })
    }
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve(text ? JSON.parse(text) : {})
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
      req.on('error', reject)
    })
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private serveDashboard(res: ServerResponse): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CTF Task Manager</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; margin-bottom: 20px; }
  .container { max-width: 900px; margin: 0 auto; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge-pending { background: #1f2937; color: #9ca3af; }
  .badge-running { background: #1e3a5f; color: #58a6ff; }
  .badge-completed { background: #1a3a2a; color: #3fb950; }
  .badge-failed { background: #3d1f1f; color: #f85149; }
  .badge-cancelled { background: #3d2e1f; color: #d29922; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-size: 13px; text-transform: uppercase; }
  tr:hover { background: #161b22; }
  .form-section { background: #161b22; padding: 20px; border-radius: 8px; margin-bottom: 24px; border: 1px solid #21262d; }
  .form-section h2 { color: #58a6ff; margin-bottom: 12px; font-size: 16px; }
  input, textarea { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; margin-bottom: 10px; font-family: inherit; }
  textarea { resize: vertical; min-height: 60px; }
  button { padding: 8px 16px; background: #238636; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
  button:hover { background: #2ea043; }
  .task-detail { background: #161b22; padding: 16px; border-radius: 8px; margin-top: 12px; border: 1px solid #21262d; }
  .task-detail h3 { color: #58a6ff; margin-bottom: 8px; }
  .task-detail p { margin-bottom: 4px; color: #8b949e; }
  .task-detail .flag { color: #3fb950; font-family: monospace; }
  .findings { margin-top: 8px; }
  .findings li { color: #c9d1d9; margin-left: 20px; }
  .empty { text-align: center; padding: 40px; color: #484f58; }
</style>
</head>
<body>
<div class="container">
  <h1>CTF Task Manager</h1>
  <div class="form-section">
    <h2>Create Task</h2>
    <form id="create-form">
      <input type="text" id="name" placeholder="Task name" required>
      <input type="text" id="target" placeholder="Target (e.g. IP or URL)" required>
      <textarea id="description" placeholder="Description"></textarea>
      <button type="submit">Create Task</button>
    </form>
  </div>
  <div id="task-list"></div>
</div>
<script>
const API = '/api/tasks';
async function loadTasks() {
  const res = await fetch(API);
  const tasks = await res.json();
  const container = document.getElementById('task-list');
  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty">No tasks yet. Create one above.</div>';
    return;
  }
  let html = '<table><thead><tr><th>Name</th><th>Target</th><th>Status</th><th>Findings</th><th>Created</th></tr></thead><tbody>';
  tasks.sort((a, b) => b.createdAt - a.createdAt);
  for (const t of tasks) {
    const badge = '<span class="badge badge-' + t.status + '">' + t.status + '</span>';
    const created = new Date(t.createdAt).toLocaleString();
    html += '<tr onclick="showDetail(\\'' + t.id + '\\')" style="cursor:pointer">';
    html += '<td>' + esc(t.name) + '</td>';
    html += '<td>' + esc(t.target) + '</td>';
    html += '<td>' + badge + '</td>';
    html += '<td>' + t.findings.length + '</td>';
    html += '<td>' + created + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  html += '<div id="detail-area"></div>';
  container.innerHTML = html;
}
async function showDetail(id) {
  const res = await fetch(API + '/' + id);
  const t = await res.json();
  const area = document.getElementById('detail-area');
  let html = '<div class="task-detail">';
  html += '<h3>' + esc(t.name) + '</h3>';
  html += '<p><strong>Target:</strong> ' + esc(t.target) + '</p>';
  html += '<p><strong>Description:</strong> ' + esc(t.description) + '</p>';
  html += '<p><strong>Status:</strong> <span class="badge badge-' + t.status + '">' + t.status + '</span></p>';
  if (t.flag) html += '<p><strong>Flag:</strong> <span class="flag">' + esc(t.flag) + '</span></p>';
  if (t.findings.length > 0) {
    html += '<div class="findings"><strong>Findings:</strong><ul>';
    for (const f of t.findings) {
      html += '<li>' + esc(f.title) + ' [' + esc(f.category) + '] (' + esc(f.confidence) + ')</li>';
    }
    html += '</ul></div>';
  }
  html += '</div>';
  area.innerHTML = html;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('name').value,
      target: document.getElementById('target').value,
      description: document.getElementById('description').value,
    }),
  });
  e.target.reset();
  loadTasks();
});
loadTasks();
setInterval(loadTasks, 5000);
</script>
</body>
</html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }
}
