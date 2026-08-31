import type { PrototypeRepository } from '../../../infrastructure/prototype/prototype-repository.ts'

export class WorkbenchQueryService {
  private readonly repository: PrototypeRepository

  constructor(repository: PrototypeRepository) {
    this.repository = repository
  }

  getSession() {
    return this.repository.read('users').then((users) => ({
      user: users.employee,
      identityProvider: 'prototype-sso' as const,
      apiAudience: 'workbench' as const,
    }))
  }

  getTasks() {
    return this.repository.read('tasks')
  }

  getWorkspaces() {
    return this.repository.read('workspaces')
  }

  getArtifacts() {
    return this.repository.read('artifacts')
  }

  async getAgents() {
    const agents = await this.repository.read('agents')
    return agents
      .filter(agent => agent.status === 'published')
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        welcomeMessage: agent.welcomeMessage,
        version: agent.version,
        examplePrompts: [...agent.examplePrompts],
      }))
  }
}
