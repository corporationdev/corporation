import type { Session, User } from "better-auth";

export type AuthSession = {
	user: User;
	session: Session;
};

let cachedSession: AuthSession | null = null;

export function getCachedAuthSession(): AuthSession | null {
	return cachedSession;
}

export function setCachedAuthSession(session: AuthSession): void {
	cachedSession = session;
}

export function clearCachedAuthSession(): void {
	cachedSession = null;
}
