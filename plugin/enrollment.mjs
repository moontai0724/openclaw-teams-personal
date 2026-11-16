// Host-supplied shared enrollment core; this adapter never grants global ownership.
export const isGroupId = id => typeof id === 'string' && /^19:[a-zA-Z0-9-]+@thread\.v2$/.test(id);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);

export function createScopedPolicy(base, current) {
  const account = () => current().channels?.[base.CHANNEL];
  const groups = () => {
    const value = account();
    if (!base.validConfig(value) || value.groupPolicy === 'disabled') return {};
    return value.groups ?? Object.fromEntries((base.GROUPS ?? [base.GROUP]).map(id => [id, { requireMention: true, allowFrom: ['*'] }]));
  };
  const groupAllowed = id => isGroupId(id) && own(groups(), id) && groups()[id]?.enabled !== false;
  return { ...base,
    get GROUPS() { return Object.keys(groups()).filter(groupAllowed); },
    groupAllowed,
    groupEntry: id => groups()[id],
    targetAllowed: to => base.normalizedTarget(to) === base.CHAT || groupAllowed(base.normalizedTarget(to)),
    groupAdmitted(message, since) {
      if (!groupAllowed(message?.conversationId)) return false;
      const members = groups()[message.conversationId]?.allowFrom ?? ['*'];
      if (!members.includes('*') && !members.includes(message.fromId)) return false;
      // Preserve the existing mention/reply/command semantics inside approved rooms.
      return Boolean(base.groupAdmitted({ ...message, conversationId: base.GROUP }, since));
    },
  };
}

export function createOwnerEnrollment({ policy, current, mutate, sharedEnroll, assertAuthority }) {
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
            // Persist the triggering fence with admission, so a config-triggered restart
            // repairs this first tag without replaying older conversation turns.
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
    return result.changed === true;
  };
}
