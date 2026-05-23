export class ProviderAdapter {
  constructor(account) {
    this.account = account;
  }

  async syncHistory() {
    throw new Error("syncHistory must be implemented by a provider adapter.");
  }

  async sendMessage() {
    throw new Error("sendMessage must be implemented by a provider adapter.");
  }
}

export class GmailAdapter extends ProviderAdapter {
  static provider = "gmail";

  async syncHistory() {
    return {
      status: "not_configured",
      nextStep: "Add Google OAuth client credentials, request Gmail scopes, and page through historyId/message list."
    };
  }

  async sendMessage() {
    return {
      status: "queued",
      nextStep: "Use Gmail API users.messages.send once OAuth refresh tokens are stored in the keychain/secret store."
    };
  }
}

export class ICloudAdapter extends ProviderAdapter {
  static provider = "icloud";

  async syncHistory() {
    return {
      status: "not_configured",
      nextStep: "Collect iCloud app password, connect via IMAP, then persist UIDVALIDITY/UID checkpoints per mailbox."
    };
  }

  async sendMessage() {
    return {
      status: "queued",
      nextStep: "Send via iCloud SMTP with app-password credentials stored outside SQLite."
    };
  }
}

export function adapterForAccount(account) {
  switch (account.provider) {
    case GmailAdapter.provider:
      return new GmailAdapter(account);
    case ICloudAdapter.provider:
      return new ICloudAdapter(account);
    default:
      return new ProviderAdapter(account);
  }
}

