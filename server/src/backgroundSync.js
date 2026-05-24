import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export class BackgroundSyncService {
  constructor({
    store,
    providers,
    pushNotifications = null,
    events = null,
    intervalMs = 0,
    limit = 50,
    batchSize = 100,
    leaseOwner = null,
    leaseTtlMs = 300_000
  } = {}) {
    this.store = store;
    this.providers = providers;
    this.pushNotifications = pushNotifications;
    this.events = events;
    this.intervalMs = Math.max(0, Number(intervalMs) || 0);
    this.limit = Math.max(1, Number(limit) || 50);
    this.batchSize = Math.max(1, Number(batchSize) || 100);
    this.leaseOwner = leaseOwner || `${hostname()}:${process.pid}:${randomUUID()}`;
    this.leaseTtlMs = Math.max(1_000, Number(leaseTtlMs) || 300_000);
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!this.intervalMs || this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch(error => {
        console.error(`${new Date().toISOString()} background account sync failed: ${error.message}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
    console.log(`${new Date().toISOString()} background account sync enabled intervalMs=${this.intervalMs}`);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.running || !this.providers || !this.store?.listSyncableAccounts) {
      return { scanned: 0, synced: 0, failed: 0, skipped: 0 };
    }
    this.running = true;
    try {
      const staleBefore = this.intervalMs ? new Date(Date.now() - this.intervalMs) : null;
      const accounts = await this.store.listSyncableAccounts({
        staleBefore,
        limit: this.batchSize
      });
      let synced = 0;
      let failed = 0;
      let skipped = 0;
      for (const account of accounts) {
        let claimed = false;
        try {
          claimed = await this.claimAccount(account);
          if (!claimed) {
            skipped += 1;
            continue;
          }
          const sync = await this.syncAccount(account);
          synced += 1;
          await this.sendPushNotifications(account, sync?.newEmails);
        } catch (error) {
          failed += 1;
          console.warn(`${new Date().toISOString()} background sync failed account=${account.id}: ${error.message}`);
        } finally {
          if (claimed) {
            await this.releaseAccount(account);
          }
        }
      }
      return { scanned: accounts.length, synced, failed, skipped };
    } finally {
      this.running = false;
    }
  }

  async claimAccount(account) {
    if (!this.store?.claimSyncLease) return true;
    return await this.store.claimSyncLease(account.id, {
      owner: this.leaseOwner,
      ttlMs: this.leaseTtlMs
    });
  }

  async releaseAccount(account) {
    if (!this.store?.releaseSyncLease) return;
    try {
      await this.store.releaseSyncLease(account.id, {
        owner: this.leaseOwner
      });
    } catch (error) {
      console.warn(`${new Date().toISOString()} background sync lease release failed account=${account.id}: ${error.message}`);
    }
  }

  async syncAccount(account) {
    const user = account.user ?? {
      id: account.userId,
      email: account.userEmail ?? null,
      displayName: account.userDisplayName ?? account.email ?? "User"
    };
    const scopedStore = user?.isLocal ? this.store : this.store.forUser(user);
    const scopedProviders = this.providers.forStore
      ? this.providers.forStore(scopedStore, user)
      : this.providers;
    const sync = await scopedProviders.syncAccount(account.id, { limit: this.limit });
    this.events?.emit?.("emails.changed", { accountId: account.id }, user?.id);
    this.events?.emit?.("accounts.changed", { accountId: account.id }, user?.id);
    return sync;
  }

  async sendPushNotifications(account, newEmails = []) {
    if (!this.pushNotifications || !Array.isArray(newEmails) || newEmails.length === 0) return;
    const user = account.user ?? { id: account.userId };
    const scopedStore = user?.isLocal ? this.store : this.store.forUser(user);
    const scopedPush = this.pushNotifications.forStore
      ? this.pushNotifications.forStore(scopedStore)
      : this.pushNotifications;
    try {
      const result = await scopedPush.sendNewEmailNotifications(newEmails);
      if (result?.sent > 0) {
        console.log(`${new Date().toISOString()} background push notifications sent=${result.sent}`);
      }
    } catch (error) {
      console.warn(`${new Date().toISOString()} background push notifications failed account=${account.id}: ${error.message}`);
    }
  }
}
