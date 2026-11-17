import { setTimeout as delay } from 'node:timers/promises';

// Host-supplied shared enrollment core; this adapter never grants global ownership.
export const isGroupId = id => typeof id === 'string' && /^19:[a-zA-Z0-9-]+@thread\.v2$/.test(id);
export const isDmId = id => typeof id === 'string' && /^19:uni01_[a-zA-Z0-9_-]+@thread\.v2$/.test(id);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);

export function createScopedPolicy(base, current) {
  const account = () => current().channels?.[base.CHANNEL];
  const groups = () => {
    const value = account();
    if (!base.validConfig(value) || value.groupPolicy === 'disabled') return {};
    return value.groups ?? Object.fromEntries((base.GROUPS ?? [base.GROUP]).map(id => [id, { requireMention: true, allowFrom: ['*'] }]));
  };
  const groupAllowed = id => isGroupId(id) && own(groups(), id) && groups()[id]?.enabled !== false;
  const dmEntry = id => {
    const value = account();
    if (!base.validConfig(value)) return undefined;
    if (id === base.CHAT) return { allowFrom: [base.SENDER] };
    if (!isDmId(id) || !own(value.dms, id)) return undefined;
    const entry = value.dms[id];
    if (!entry || (entry.enabled !== undefined && entry.enabled !== true) || !Array.isArray(entry.allowFrom) || entry.allowFrom.length !== 1 ||
      !/^8:(?:orgid:|live:)[a-zA-Z0-9.:-]+$/.test(entry.allowFrom[0]) || entry.allowFrom[0] === base.BOT ||
      !Number.isSafeInteger(entry.activatedAt) || entry.activatedAt < 1) return undefined;
    return entry;
  };
  const dmAllowed = id => Boolean(dmEntry(id));
  const dmAllowFrom = id => [...(dmEntry(id)?.allowFrom ?? [])];
  return { ...base,
    get DM_CHATS() { return [base.CHAT, ...Object.keys(account()?.dms ?? {}).filter(id => id !== base.CHAT)].filter(dmAllowed); },
    dmAllowed,
    dmAllowFrom,
    dmEntry,
    admitted(message, since) {
      const chat = message?.conversationId;
      if (!dmAllowed(chat) || !dmAllowFrom(chat).includes(message.fromId)) return false;
      if (chat === base.CHAT) return base.admitted(message, since);
      return message.isMine === false && !message.edited && !message.deleted && /^\d+$/.test(message.id) &&
        Date.parse(message.time) >= Math.max(since, dmEntry(chat).activatedAt) &&
        typeof message.text === 'string' && message.text.trim().length > 0;
    },
    get GROUPS() { return Object.keys(groups()).filter(groupAllowed); },
    groupAllowed,
    groupEntry: id => groups()[id],
    targetAllowed: to => dmAllowed(base.normalizedTarget(to)) || groupAllowed(base.normalizedTarget(to)),
    groupAdmitted(message, since) {
      if (!groupAllowed(message?.conversationId)) return false;
      const members = groups()[message.conversationId]?.allowFrom ?? ['*'];
      if (!members.includes('*') && !members.includes(message.fromId)) return false;
      // Preserve the existing mention/reply/command semantics inside approved rooms.
      return Boolean(base.groupAdmitted({ ...message, conversationId: base.GROUP }, since));
    },
  };
}

export function createOwnerEnrollment({ policy, current, mutate, sharedEnroll, assertAuthority, signal, activationTimeoutMs = 5_000 }) {
  const project = cfg => {
    const account = cfg.channels?.[policy.CHANNEL];
    const enabled = policy.validConfig(account);
    const owner = enabled && account.enrollmentOwnerId === policy.SENDER ? account.enrollmentOwnerId : undefined;
    return { commands: { ownerAllowFrom: owner ? [`${policy.CHANNEL}:${owner}`] : [] },
      channels: { [policy.CHANNEL]: { ...account, enabled,
        groups: account?.groups ?? Object.fromEntries((policy.GROUPS ?? [policy.GROUP]).map(id => [id, { requireMention: true, allowFrom: ['*'] }])),
      } },
    };
  };
  return async (message, startedAt) => {
    // Reject before config access/I/O. Neither repair nor reply/command events call this.
    if (!isGroupId(message?.conversationId) || message.isMine !== false || message.fromId !== policy.SENDER ||
      message.deleted || message.edited || message.forwarded || message.replyTo ||
      !message.mentions?.some(item => item.mri === policy.BOT) || /^\s*\//.test(message.text) ||
      !/^\d{1,24}$/.test(message.id) || !Number.isFinite(Date.parse(message.time)) || Date.parse(message.time) < startedAt) return false;
    if (typeof sharedEnroll !== 'function') return false;
    assertAuthority();
    const facts = { channel: policy.CHANNEL, accountId: 'default', groupId: message.conversationId,
      senderId: message.fromId, isGroup: true, explicitMention: true, originalMessage: true };
    const result = await sharedEnroll(facts, {
      current: () => project(current()),
      mutate: options => mutate({ ...options,
        mutate: draft => {
          assertAuthority();
          const projected = project(draft);
          const changed = options.mutate(projected);
          if (changed) {
            // Connection recovery retains this tag while fencing earlier requests.
            projected.channels[policy.CHANNEL].groups[facts.groupId] = {
              ...projected.channels[policy.CHANNEL].groups[facts.groupId],
              activationId: message.id, activatedAt: Date.parse(message.time),
            };
            draft.channels[policy.CHANNEL].groups = projected.channels[policy.CHANNEL].groups;
          }
          return changed;
        },
        writeOptions: { ...options.writeOptions, assertCurrent() { assertAuthority(); options.writeOptions?.assertCurrent?.(); } },
      }),
    });
    if (result.changed !== true) return false;
    // A managed write persists before the host publishes its runtime snapshot.
    // Never authorize from the saved draft or discard the first tag in that gap.
    const deadline = Date.now() + activationTimeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      assertAuthority();
      const account = current().channels?.[policy.CHANNEL];
      if (!policy.validConfig(account) || account.enrollmentOwnerId !== policy.SENDER || account.groupPolicy === 'disabled') {
        throw new Error('Teams group enrollment authorization changed before activation');
      }
      const entry = account.groups?.[facts.groupId];
      if (entry) {
        if (entry.enabled === false || entry.activationId !== message.id || entry.activatedAt !== Date.parse(message.time)) {
          throw new Error('Teams group enrollment activation was revoked or superseded');
        }
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Teams group enrollment persisted but runtime activation timed out; retain the saved fence for recovery');
      await delay(Math.min(25, remaining), undefined, { signal });
    }
  };
}
