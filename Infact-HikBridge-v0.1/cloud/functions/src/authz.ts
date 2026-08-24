import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

export type OrganizationRole = "organizationOwner" | "hrAdmin" | "manager" | "viewer";

export interface AuthContext {
  uid: string;
  token: Record<string, unknown>;
}

export function requireAuthentication(auth: AuthContext | undefined): AuthContext {
  if (auth === undefined) {
    throw new HttpsError("unauthenticated", "Authentication is required");
  }
  return auth;
}

export async function requireOrganizationRole(
  db: Firestore,
  auth: AuthContext,
  organizationId: string,
  allowed: OrganizationRole[],
): Promise<OrganizationRole | "platformAdmin"> {
  if (auth.token.platformAdmin === true) {
    return "platformAdmin";
  }
  const membership = await db.doc(`organizations/${organizationId}/members/${auth.uid}`).get();
  const role = membership.get("role");
  if (!membership.exists || typeof role !== "string" || !allowed.includes(role as OrganizationRole)) {
    throw new HttpsError("permission-denied", "Your organization role does not allow this operation");
  }
  return role as OrganizationRole;
}
