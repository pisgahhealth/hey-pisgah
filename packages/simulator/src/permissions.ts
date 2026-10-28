import { AGENT_ALLOWED_KINDS, type ActionKind, type WorkflowDefinition } from "@hey-pisgah/contracts";

// Every action attempt passes here; a refusal is counted and never executed.
export class PermissionGate {
  attempted = 0;
  executed = 0;

  constructor(private readonly permissions: WorkflowDefinition["permissions"]) {}

  allowed(role: string, kind: string): boolean {
    const roles: readonly string[] = this.permissions[kind as ActionKind] ?? [];
    if (!roles.includes(role)) return false;
    return role !== "agent" || AGENT_ALLOWED_KINDS.has(kind as ActionKind);
  }

  // Returns true when the action may run; a prohibited attempt is counted and refused.
  attempt(role: string, kind: string): boolean {
    if (this.allowed(role, kind)) return true;
    this.attempted += 1;
    return false;
  }
}
