import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundSyncService } from "../src/backgroundSync.js";

test("background sync scopes each account to its owning user and sends push notifications", async () => {
  const accounts = [{
    id: "account-alice",
    email: "alice@gmail.com",
    user: {
      id: "user-alice",
      email: "alice@example.com",
      displayName: "Alice"
    }
  }, {
    id: "account-bob",
    email: "bob@gmail.com",
    user: {
      id: "user-bob",
      email: "bob@example.com",
      displayName: "Bob"
    }
  }];
  const store = new FakeRootStore(accounts);
  const providers = new FakeProviderService();
  const push = new FakePushService();
  const events = new FakeEvents();
  const service = new BackgroundSyncService({
    store,
    providers,
    pushNotifications: push,
    events,
    intervalMs: 300_000,
    limit: 25,
    leaseOwner: "worker-a",
    leaseTtlMs: 60_000
  });

  const result = await service.runOnce();

  assert.deepEqual(result, { scanned: 2, synced: 2, failed: 0, skipped: 0 });
  assert.deepEqual(store.claims, [
    { accountId: "account-alice", owner: "worker-a", ttlMs: 60_000 },
    { accountId: "account-bob", owner: "worker-a", ttlMs: 60_000 }
  ]);
  assert.deepEqual(store.releases, [
    { accountId: "account-alice", owner: "worker-a" },
    { accountId: "account-bob", owner: "worker-a" }
  ]);
  assert.deepEqual(store.scopedUsers.map(user => user.id), ["user-alice", "user-alice", "user-bob", "user-bob"]);
  assert.deepEqual(providers.synced, [
    { accountId: "account-alice", userId: "user-alice", limit: 25 },
    { accountId: "account-bob", userId: "user-bob", limit: 25 }
  ]);
  assert.deepEqual(push.sent, [
    { userId: "user-alice", emailIds: ["account-alice-new"] },
    { userId: "user-bob", emailIds: ["account-bob-new"] }
  ]);
  assert.deepEqual(events.items, [
    { event: "emails.changed", data: { accountId: "account-alice" }, userId: "user-alice" },
    { event: "accounts.changed", data: { accountId: "account-alice" }, userId: "user-alice" },
    { event: "emails.changed", data: { accountId: "account-bob" }, userId: "user-bob" },
    { event: "accounts.changed", data: { accountId: "account-bob" }, userId: "user-bob" }
  ]);
  assert.ok(store.lastSyncableQuery.staleBefore instanceof Date);
});

test("background sync skips accounts claimed by another worker", async () => {
  const accounts = [{
    id: "account-alice",
    email: "alice@gmail.com",
    user: {
      id: "user-alice",
      email: "alice@example.com",
      displayName: "Alice"
    }
  }, {
    id: "account-bob",
    email: "bob@gmail.com",
    user: {
      id: "user-bob",
      email: "bob@example.com",
      displayName: "Bob"
    }
  }];
  const store = new FakeRootStore(accounts, { deniedLeases: ["account-bob"] });
  const providers = new FakeProviderService();
  const service = new BackgroundSyncService({
    store,
    providers,
    intervalMs: 300_000,
    leaseOwner: "worker-a"
  });

  const result = await service.runOnce();

  assert.deepEqual(result, { scanned: 2, synced: 1, failed: 0, skipped: 1 });
  assert.deepEqual(providers.synced.map(item => item.accountId), ["account-alice"]);
  assert.deepEqual(store.releases.map(item => item.accountId), ["account-alice"]);
});

class FakeRootStore {
  constructor(accounts, { deniedLeases = [] } = {}) {
    this.accounts = accounts;
    this.deniedLeases = new Set(deniedLeases);
    this.scopedUsers = [];
    this.claims = [];
    this.releases = [];
    this.lastSyncableQuery = null;
  }

  async listSyncableAccounts(query) {
    this.lastSyncableQuery = query;
    return this.accounts;
  }

  async claimSyncLease(accountId, options) {
    this.claims.push({ accountId, owner: options.owner, ttlMs: options.ttlMs });
    return !this.deniedLeases.has(accountId);
  }

  async releaseSyncLease(accountId, options) {
    this.releases.push({ accountId, owner: options.owner });
    return true;
  }

  forUser(user) {
    this.scopedUsers.push(user);
    return { user };
  }
}

class FakeProviderService {
  synced = [];

  forStore(store, user) {
    return {
      syncAccount: async (accountId, options) => {
        this.synced.push({ accountId, userId: user.id, limit: options.limit });
        return {
          imported: 1,
          newEmails: [{ id: `${accountId}-new` }]
        };
      }
    };
  }
}

class FakePushService {
  sent = [];

  forStore(store) {
    return {
      sendNewEmailNotifications: async emails => {
        this.sent.push({
          userId: store.user.id,
          emailIds: emails.map(email => email.id)
        });
        return { sent: emails.length };
      }
    };
  }
}

class FakeEvents {
  items = [];

  emit(event, data, userId) {
    this.items.push({ event, data, userId });
  }
}
