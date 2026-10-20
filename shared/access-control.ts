/**
 * Roles and permissions: the single table that says who may do what.
 *
 * The backend enforces it (route guards and resource checks) and the UI reads
 * it to hide or disable actions. The UI is a convenience, never the boundary:
 * every action listed here is refused server-side whether or not the button was
 * shown. Sharing the table means the two cannot quietly disagree about what a
 * role can do.
 *
 * Kept to erasable TypeScript (no enums, no parameter properties) so the
 * frontend can load it through Node's type stripping like the other shared
 * modules.
 */

/**
 * Who is calling.
 *
 * - `anonymous`  a payer on the public pay page; no credentials.
 * - `end_user`   a seller who proved control of their Stellar wallet.
 * - `maintainer` a human operator holding a maintainer API token.
 * - `service`    a machine actor (monitor, scheduled job) holding a service token.
 */
export const ROLES = ['anonymous', 'end_user', 'maintainer', 'service'] as const;
export type Role = (typeof ROLES)[number];

/** Every privileged (or deliberately public) capability the API exposes. */
export const PERMISSIONS = [
  'lifecycle:read',
  'invoice:read',
  'invoice:verify',
  'invoice:create',
  'invoice:list',
  'invoice:stats',
  'invoice:cancel',
  'invoice:audit',
  'invoice:simulate',
  'invoice:email',
  'invoice:deliveries',
  'email:admin',
  'reconciliation:run',
  'monitor:read',
  'monitor:sync',
  'stellar:read',
  'quota:read',
  'quota:override',
  'analytics:read',
  'analytics:clear',
  'notification:preferences:write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * What each role may do. Anything not listed is denied.
 *
 * `invoice:read` and `invoice:verify` are open to everyone on purpose: a payer
 * has no account, and verification is proven by the on-chain transaction rather
 * than by who asks.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  anonymous: ['lifecycle:read', 'invoice:read', 'invoice:verify', 'invoice:email'],
  end_user: [
    'lifecycle:read',
    'invoice:read',
    'invoice:verify',
    'invoice:create',
    'invoice:list',
    'invoice:stats',
    'invoice:cancel',
    'invoice:audit',
    'invoice:email',
    'invoice:deliveries',
    'stellar:read',
    'notification:preferences:write',
  ],
  maintainer: [
    'lifecycle:read',
    'invoice:read',
    'invoice:verify',
    'invoice:list',
    'invoice:stats',
    'invoice:cancel',
    'invoice:audit',
    'invoice:simulate',
    'invoice:email',
    'invoice:deliveries',
    'email:admin',
    'reconciliation:run',
    'monitor:read',
    'monitor:sync',
    'stellar:read',
    'quota:read',
    'quota:override',
    'analytics:read',
    'analytics:clear',
    'notification:preferences:write',
  ],
  service: [
    'lifecycle:read',
    'invoice:read',
    'invoice:verify',
    'invoice:list',
    'invoice:stats',
    'invoice:audit',
    'invoice:email',
    'invoice:deliveries',
    'email:admin',
    'reconciliation:run',
    'monitor:read',
    'monitor:sync',
    'stellar:read',
    'quota:read',
    'analytics:read',
  ],
};

/**
 * Permissions an `end_user` holds only over their own invoices. Holding the
 * permission is not enough: the invoice's seller wallet must be the caller's
 * wallet. Maintainers and services act across sellers and are not scoped.
 */
export const OWNED_PERMISSIONS: readonly Permission[] = [
  'invoice:create',
  'invoice:list',
  'invoice:stats',
  'invoice:cancel',
  'invoice:audit',
  'invoice:deliveries',
  'notification:preferences:write',
];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function can(role: string, permission: Permission): boolean {
  return isRole(role) && ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: string): Permission[] {
  return isRole(role) ? [...ROLE_PERMISSIONS[role]] : [];
}

/** True when `role` may use `permission` only on resources it owns. */
export function isOwnershipScoped(role: string, permission: Permission): boolean {
  return role === 'end_user' && OWNED_PERMISSIONS.includes(permission);
}

/** Serialisable form of the whole table, for docs and `GET /api/auth/roles`. */
export function describeAccessControl() {
  return {
    roles: ROLES.map((role) => ({
      role,
      permissions: permissionsFor(role),
      ownedOnly: OWNED_PERMISSIONS.filter((permission) => isOwnershipScoped(role, permission)),
    })),
  };
}
