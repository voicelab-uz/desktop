// Session boundaries, not token refreshes, invalidate private-data work.
class AccountDataContext {
  constructor(authManager) {
    this.authManager = authManager;
    this.generation = 0;
    this.identity = this.currentIdentity();
  }

  currentIdentity() {
    if (this.authManager?.getPublicStatus?.().status !== "authenticated") return null;
    const session = this.authManager.getSessionMetadata();
    return session.accountId ? JSON.stringify([session.accountId, session.sessionId]) : null;
  }

  handleAuthStatus() {
    const next = this.currentIdentity();
    if (next !== this.identity) {
      this.identity = next;
      this.generation += 1;
    }
  }

  capture() {
    this.handleAuthStatus();
    const identity = this.identity;
    const generation = this.generation;
    return () => {
      if (!identity || identity !== this.currentIdentity() || generation !== this.generation) {
        const error = new Error("The active account changed during this request.");
        error.code = "AUTH_ACCOUNT_CHANGED";
        throw error;
      }
    };
  }
}
module.exports = { AccountDataContext };
