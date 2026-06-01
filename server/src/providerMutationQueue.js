const DEFAULT_POLL_INTERVAL_MS = 15_000;

export function createProviderMutationQueueProcessor({
  store,
  providers,
  events = null,
  logger = console,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
} = {}) {
  let running = false;
  let closed = false;
  let wakeTimer = null;
  let pollTimer = null;

  function start() {
    if (!providers || closed || pollTimer) return;
    pollTimer = setInterval(wake, Math.max(1000, pollIntervalMs));
    pollTimer.unref?.();
    wake();
  }

  function stop() {
    closed = true;
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function wake(delayMs = 0) {
    if (!providers || closed || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void drain();
    }, Math.max(0, delayMs));
    wakeTimer.unref?.();
  }

  async function drain() {
    if (!providers || closed || running) return;
    running = true;
    try {
      while (!closed) {
        const mutation = store.claimNextProviderMutation();
        if (!mutation) break;
        await processMutation(mutation);
      }
    } finally {
      running = false;
      if (!closed && store.hasDueProviderMutations()) {
        wake();
      }
    }
  }

  async function processMutation(mutation) {
    try {
      const result = await runProviderMutation({ store, providers, mutation });
      store.markProviderMutationSucceeded(mutation.id);
      events?.emit?.("provider-mutations.changed", {
        mutationId: mutation.id,
        emailId: mutation.emailId,
        action: mutation.action,
        status: "succeeded"
      });
      events?.emit?.("emails.changed", {
        emailId: mutation.emailId,
        providerMutation: mutation.action
      });
      return result;
    } catch (error) {
      const updated = store.markProviderMutationFailed(mutation.id, error);
      logger.warn?.(`${new Date().toISOString()} provider ${mutation.action} queued retry email=${mutation.emailId ?? "none"} attempts=${updated?.attempts ?? mutation.attempts}: ${error.message}`);
      events?.emit?.("provider-mutations.changed", {
        mutationId: mutation.id,
        emailId: mutation.emailId,
        action: mutation.action,
        status: updated?.status ?? "queued",
        error: error.message
      });
      if (updated?.nextAttemptAt && updated.status === "queued") {
        wake(Math.max(1000, Date.parse(updated.nextAttemptAt) - Date.now()));
      }
      return null;
    }
  }

  return {
    start,
    stop,
    wake,
    drain,
    isRunning: () => running
  };
}

export function providerEmailSnapshot(email) {
  if (!email) return null;
  return {
    id: email.id,
    accountId: email.accountId,
    providerUID: email.providerUID,
    mailboxRole: email.mailboxRole
  };
}

async function runProviderMutation({ store, providers, mutation }) {
  const email = mutation.emailId ? store.getEmail(mutation.emailId) : null;
  if (mutation.emailId && !email) {
    return { status: "skipped", reason: "email_missing" };
  }

  const providerEmail = mutation.payload?.providerEmail
    ? { ...email, ...mutation.payload.providerEmail }
    : email;

  switch (mutation.action) {
    case "archive":
      return providers.archiveEmail(providerEmail);
    case "trash":
      return providers.trashEmail(providerEmail);
    case "spam":
      return providers.markEmailSpam(providerEmail);
    case "read-status":
      return providers.updateEmailReadStatus(providerEmail, mutation.payload?.isRead === true);
    default:
      throw new Error(`Unsupported provider mutation action: ${mutation.action}`);
  }
}
