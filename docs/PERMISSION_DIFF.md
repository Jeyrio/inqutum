# Permission-Diff Report Engine Before Role and Policy Changes (#302)

## Overview & Goal
Modifications to roles, permissions, or system business policies carry high operational and security risk. Granting unintended administrative capabilities can cause privilege escalation, while accidental permission revocations can break active user workflows. The Permission-Diff Report Engine generates structured preview reports highlighting added capabilities, revoked permissions, privilege escalation risks, and breaking changes before changes are committed.

---

## Capabilities & Analysis

### 1. Granular Capability Diffing
- Evaluates added, revoked, and retained permissions for any role definition or user assignment.
- Categories: Invoicing, Collaboration, Ownership, Policy, Operations, Jobs, and Auditing.

### 2. Privilege Escalation Detection
- Flags `isPrivilegeEscalation: true` whenever a non-owner role gains high-privilege capabilities:
  - `ownership:initiate_transfer`, `ownership:accept_transfer`, `ownership:cancel_transfer`
  - `policy:update`
  - `invoice:cancel`
  - `job:cancel`, `job:requeue`
- Automatically elevates report risk level to `CRITICAL`.
- Gated behind maintainer quorum requirement (`requiresMaintainerQuorum: true`).

### 3. Breaking Revocation Analysis
- Detects when core operational capabilities (e.g. `invoice:create`, `invoice:read`, `invoice:verify`) are revoked from roles actively relied upon by users.
- Flags `breakingChangesDetected: true` and elevates risk to `HIGH`.

### 4. Deterministic Reversal Recipes
- Generates an exact, executable SQL or environment reversal plan in the report output.
- Enables zero-guesswork, instant rollback if a role or policy change causes unintended user disruption.

---

## Operational Edge Cases & Recovery / Rollback Behavior

| Operational Scenario | Impact / System Behavior | Recovery & Rollback Path |
|---|---|---|
| **Accidental escalation of collaborator to admin** | Collaborator gains invoice cancellation and user invite capabilities. | Diff engine flags `riskLevel: CRITICAL` and `privilegeEscalationDetected: true`. Prevents accidental commit without secondary review. Reversal recipe provides instant single-line rollback command. |
| **Breaking revocation of invoice:create** | Inadvertently removing creation rights breaks seller dashboard. | Diff engine alerts with `breakingChangesDetected: true`. Operators can cancel the update prior to deployment. |
| **Non-owner attempts to grant equal/higher role** | An admin attempts to promote another user to ADMIN or OWNER. | Throws `RoleEscalationForbiddenError` (HTTP 403). Only the OWNER can grant administrative or owner roles. |
| **Unapproved policy parameter expansion** | Changing max invoice amount from 1M to 1B without quorum. | Policy diff flags parameter expansion and risk level `HIGH`. Reversal recipe provides exact environment variable restore values. |
| **Unauthorized diff generation** | Unauthenticated user or `VIEWER` attempts to inspect system permissions. | Fails immediately with `UnauthorizedPermissionDiffError` (HTTP 403). Gated behind `ADMIN` or `OWNER` role. |

---

## Complexity Analysis
- **Time Complexity**: $O(P)$ where $P$ is the number of system permissions ($O(1)$ constant-bounded).
- **Space Complexity**: $O(P)$ to allocate diff arrays and reversal recipes.
