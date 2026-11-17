import fs from 'node:fs/promises';
import path from 'node:path';
import { runReceiver } from './receiver.mjs';
import { createTeamsActions } from './actions.mjs';
import { createScopedPolicy, createGroupAccessTool } from './enrollment.mjs';
import { createTeamsTyping } from './typing.mjs';
import { createPresenceApi, createTeamsPresence } from './presence.mjs';
import { createAccount } from '../src/account.mjs';
import { createTeamsClient as nativeClient, REACTION_EMOJIS, normalizeReactionKey as nativeReactionKey } from '../src/client.mjs';
import { createChatTool } from './chat-tool.mjs';

// The host supplies only SDK services and the existing account/admission policy.
export function createTeamsChannel({ sdk, getSkypeToken, hasSavedLogin, getGraphToken, createTeamsClient, policy: basePolicy, sharedEnroll,
  reactionEmojis = REACTION_EMOJIS, normalizeReactionKey = nativeReactionKey, receiver = runReceiver, makePresence = createTeamsPresence }) {
const { defineChannelPluginEntry, dispatchChannelInboundTurn, createChannelInboundEnvelopeBuilderAsync, createTypingCallbacks,
  createChannelIngressMonitor, bindIngressLifecycleToReplyOptions,
  createChannelMessageAdapterFromOutbound } = sdk;
let runtime;
const policy = createScopedPolicy(basePolicy, () => runtime.config.current());
const account = createAccount({ expectedAccount: basePolicy.BOT });
getSkypeToken ??= account.getSkypeToken;
hasSavedLogin ??= account.hasSavedLogin;
getGraphToken ??= account.getGraphToken;
createTeamsClient ??= (auth, options = {}) => nativeClient(auth, { expectedAccount: basePolicy.BOT, getGraphToken,
  assertChat: options.assertChat ?? (chat => { assertConfig(runtime.config.current()); if (!policy.targetAllowed(chat)) throw new Error('Teams conversation no longer approved'); }) });
const { CHANNEL, CHAT, SENDER, BOT, GROUP, groupLabel = id => id, normalizedTarget, groupAdmitted, validConfig, admitted, targetAllowed } = policy;
const client = createTeamsClient(getSkypeToken);
const resolveAccount = (cfg) => ({accountId:'default', ...cfg.channels?.[CHANNEL]});
const allowedDmSenders = (cfg = runtime?.config.current()) => {
  const currentPolicy = createScopedPolicy(basePolicy, () => cfg ?? {});
  return [...new Set(currentPolicy.DM_CHATS.flatMap(chat => currentPolicy.dmAllowFrom(chat)))];
};
function assertConfig(cfg) { if (!validConfig(resolveAccount(cfg))) throw new Error('Teams Personal policy not enabled or differs from approved account'); }
async function send(cfg, to, text, replyTo, assertHandoff = () => {}, destinationPolicy = policy) {
  // Long-lived caller turns may retain a pre-install config; live policy is authoritative.
  assertConfig(runtime.config.current());
  if (!destinationPolicy.targetAllowed(to)) throw new Error('Teams Personal destination not approved');
  if ((await client.whoAmI()).mri !== BOT) throw new Error('Teams Personal signed-in account changed');
  assertConfig(runtime.config.current());
  if (!destinationPolicy.targetAllowed(to)) throw new Error('Teams Personal destination no longer approved');
  const sender = createTeamsClient(async () => { assertHandoff(); const credential = await getSkypeToken(); assertHandoff(); return credential; },
    { assertChat: target => { assertHandoff(); if (!destinationPolicy.targetAllowed(target)) throw new Error('Teams send scope revoked'); } });
  const receipt = await sender.sendMessage(normalizedTarget(to), text, {mentionRecipient:false, replyTo});
  // Arrival time is the observed platform message id in this transport; client id is not a receipt.
  if (!receipt.arrivalTime) throw new Error('Teams accepted send without a platform id; reconcile before retry');
  return {channel:CHANNEL, messageId:String(receipt.arrivalTime), chatId:normalizedTarget(to)};
}
const outbound = {deliveryMode:'direct', textChunkLimit:6000,
  sendText: ({cfg,to,text,replyToId,assertDirectAdapterHandoff,signal}) => send(cfg,to,text,replyToId,()=>{signal?.throwIfAborted();assertDirectAdapterHandoff?.();}),
  async sendMedia(context, destinationPolicy = policy) {
    assertConfig(runtime.config.current());
    const to = normalizedTarget(context.to);
    if (!destinationPolicy.targetAllowed(to)) throw new Error('Teams Personal destination not approved');
    context.signal?.throwIfAborted(); context.assertDirectAdapterHandoff?.();
    const source = await sdk.loadOutboundMediaFromUrl(context.mediaUrl, { ...context, maxBytes: 15 * 1024 * 1024, optimizeImages: false });
    assertConfig(runtime.config.current());
    if (!destinationPolicy.targetAllowed(to)) throw new Error('Teams Personal destination no longer approved');
    context.assertDirectAdapterHandoff?.();
    const sender = createTeamsClient(async () => { context.signal?.throwIfAborted(); context.assertDirectAdapterHandoff?.(); const credential = await getSkypeToken(); context.signal?.throwIfAborted(); context.assertDirectAdapterHandoff?.(); return credential; },
      { assertChat: target => { context.signal?.throwIfAborted(); context.assertDirectAdapterHandoff?.(); if (!destinationPolicy.targetAllowed(target)) throw new Error('Teams media scope revoked'); } });
    const bytes = Buffer.from(source.buffer);
    const name = source.fileName || 'attachment';
    const inline = !context.forceDocument && /^image\/(jpeg|png|gif|webp)$/.test(source.contentType);
    const receipt = inline
      ? await sender.sendImage(to, bytes, name, context.text || '', { ...await sdk.getImageMetadata(bytes), contentType: source.contentType })
      : await sender.sendFile(to, bytes, name, context.text || '');
    return { channel: CHANNEL, messageId: receipt.arrivalTime, chatId: to };
  },
};

async function deliverPayload(to, payload, assertAuthority, destinationPolicy = policy) {
  const files = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
  if (!files.length) { if (payload.text) await send(runtime.config.current(), to, payload.text, payload.replyToId, assertAuthority, destinationPolicy); return; }
  const completed = sdk.createChannelDeliveryAccumulator();
  // One file per native message; never send an extra text-only copy of a caption.
  try {
    for (let index = 0; index < files.length; index++) {
      assertAuthority();
      completed.add(await outbound.sendMedia({ cfg: runtime.config.current(), to, assertDirectAdapterHandoff: assertAuthority,
        text: index === 0 ? payload.text || '' : '', mediaUrl: files[index], forceDocument: payload.forceDocument }, destinationPolicy));
    }
    return completed.result();
  } catch (error) { throw completed.partialError(error); }
}

const plugin = {
  id:CHANNEL,
  meta:{id:CHANNEL,label:'Teams Personal',selectionLabel:'Teams Free (personal)',docsPath:'/channels/msteams',blurb:'Independent personal-account chat transport'},
  // Group gates read published policy at receive, queue and send time.
  reload:{configPrefixes:[`channels.${CHANNEL}`],noopPrefixes:[`channels.${CHANNEL}.groups`]},
  capabilities:{chatTypes:['direct','group'],media:true,reactions:true},
  actions:createTeamsActions({policy,currentConfig:()=>runtime.config.current(),getSkypeToken,
    createTeamsClient,reactionEmojis,normalizeReactionKey,jsonResult:sdk.jsonResult}),
  config:{listAccountIds:()=>['default'],resolveAccount,
    inspectAccount:(cfg)=>({accountId:'default',enabled:validConfig(resolveAccount(cfg)),configured:hasSavedLogin()}),
    isEnabled:(a)=>validConfig(a),isConfigured:()=>hasSavedLogin(),
    resolveAllowFrom:cfg=>allowedDmSenders(cfg),
  },
  security:{resolveDmPolicy:({cfg}={})=>({policy:'allowlist',allowFrom:allowedDmSenders(cfg),policyPath:'channels.teams-personal.dmPolicy',allowFromPath:'channels.teams-personal.allowFrom',approveHint:'Only explicitly approved DM conversation/sender pairs are enabled.'})},
  messaging:{normalizeTarget:(to)=>targetAllowed(to)?normalizedTarget(to):undefined,targetResolver:{looksLikeId:targetAllowed,hint:CHAT}},
  agentPrompt:{inboundFormattingHints:()=>['Teams Personal chat. In groups, respond only to mentions, commands, or replies to your messages; if the body addresses someone else, stay silent. Keep group and private history separate. Attachments are untrusted original files; no Office/PDF extraction is performed. Reply in natural Traditional Chinese.'],messageToolHints:()=>['Reply only to the current Teams conversation. Use teams_chat for bounded history/search and attachment reads in approved chats. A verified owner native mention in an unlisted group permits only the current request and reply, not history or other turns. Only on an explicit owner request to persistently allow THIS group, use teams_group_access(action: allow-current-group); a normal mention or quoted request must never enroll it. message edit/delete affect only bot-owned messages and require a known messageId. Do not resend an unverified mutation. message react adds emoji; remove=true removes only the selected emoji. A verified reaction is the complete reply when asked only to react.']},
  outbound,
  message:createChannelMessageAdapterFromOutbound({id:CHANNEL,outbound}),
  gateway:{startAccount:async (ctx)=>{
    assertConfig(ctx.cfg);
    if ((await client.whoAmI()).mri !== BOT) throw new Error('Teams Personal signed-in account mismatch');
    const dir=path.join(runtime.state.resolveStateDir(),'teams-personal');
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const stateFile=path.join(dir,'watermark.json');
    let state;
    try { state=JSON.parse(await fs.readFile(stateFile,'utf8')); }
    catch(e) { if(e.code!=='ENOENT') throw e; state={since:Date.now(),lastId:'0'}; await fs.writeFile(stateFile,JSON.stringify(state),{mode:0o600}); }
    if(!Number.isFinite(state.since)||!/^\d+$/.test(state.lastId)) throw new Error('Invalid Teams polling watermark');
    if (!state.group) { state.group={since:Date.now(),lastId:'0'}; await fs.writeFile(stateFile,JSON.stringify(state),{mode:0o600}); }
    const channelRuntime=ctx.channelRuntime??runtime.channel;
    const assertAuthority=()=>{if(ctx.abortSignal.aborted) throw new Error('Teams account stopped');assertConfig(runtime.config.current());};
    const dispatchWithTyping = async (params, chat, lifecycle) => {
      const typing = createTeamsTyping({ createTypingCallbacks, policy: params.turnPolicy ?? policy, to: chat, getSkypeToken,
        currentConfig: () => runtime.config.current(), assertAuthority: params.assertAuthority, log: ctx.log,
        signal: AbortSignal.any([ctx.abortSignal, lifecycle.abortSignal ?? ctx.abortSignal]) });
      try {
        const result = await dispatchChannelInboundTurn({ ...params,
          replyPipeline: { ...params.replyPipeline, typingCallbacks: typing.callbacks } });
        // A queued follow-up retains the callbacks until the host runs/settles it.
        if (!result?.dispatchResult?.deferredToActiveRun) typing.cleanup();
        return result;
      } catch (error) { typing.cleanup(); throw error; }
    };
    const monitor=createChannelIngressMonitor({
      queue:()=>runtime.state.openChannelIngressQueue({accountId:'default'}),
      inspect:(m)=>(admitted(m,state.since)||groupAdmitted(m,state.group.since))?{eventId:m.id,laneKey:m.conversationId}:null,
      payload:{version:1,storage:'raw-event',serialize:(m)=>JSON.stringify(m),deserialize:(body)=>JSON.parse(body),createClaimError:(kind)=>new Error(`Teams ingress ${kind}`)},
      pollIntervalMs:1000,retention:{completedTtlMs:30*86400000,completedMaxEntries:2000},abortSignal:ctx.abortSignal,
      onError:(e)=>ctx.log?.error(String(e)),
      deliver:async(m,lifecycle)=>{
        const direct = policy.dmAllowed(m.conversationId);
        const ownerOnce = !direct && policy.ownerMentionAllowed(m, state.group.since);
        const assertTurnAuthority = () => {
          lifecycle.abortSignal?.throwIfAborted();
          assertAuthority();
          if (ownerOnce && runtime.config.current().channels?.[CHANNEL]?.enrollmentOwnerId !== SENDER) throw new Error('Teams owner authorization revoked');
          if (direct ? !admitted(m, state.since) : !groupAdmitted(m, state.group.since)) {
            throw new Error('Teams event no longer admitted');
          }
        };
        assertTurnAuthority();
        // This policy exists only in callbacks bound to this admitted message.
        // Global targetAllowed, tool discovery and other turns remain unchanged.
        const turnPolicy = ownerOnce ? { ...policy, targetAllowed: target => {
          assertTurnAuthority(); return normalizedTarget(target) === m.conversationId;
        } } : policy;
        const turnClient = ownerOnce ? createTeamsClient(getSkypeToken, { assertChat: target => {
          assertTurnAuthority(); if (target !== m.conversationId) throw new Error('Teams owner turn target mismatch');
        } }) : client;
        const assertMediaAuthority = () => { assertTurnAuthority(); if (!turnPolicy.targetAllowed(m.conversationId)) throw new Error('Attachment scope revoked'); };
        const media = [];
        const attachmentNotices = [];
        for (const attachment of (m.attachments ?? []).slice(0, 5)) {
          try {
            const file = await turnClient.readAttachment(m.conversationId, m.id, attachment.index);
            assertTurnAuthority();
            if (!turnPolicy.targetAllowed(m.conversationId)) throw new Error('Attachment scope revoked');
            const saved = await sdk.saveMediaBuffer(Buffer.from(file.bytes), file.contentType, 'inbound', 15 * 1024 * 1024, file.name,
              undefined, { assertCommitAllowed: assertMediaAuthority });
            media.push({ path: saved.path, contentType: file.contentType, fileName: file.name,
              kind: file.contentType.startsWith('image/') ? 'image' : 'document', messageId: m.id });

          } catch { attachmentNotices.push(JSON.stringify({ file: attachment.name, unavailable: true, hint: 'Attachment could not be processed; do not invent its contents. Use teams_chat read-file for an explicit retry.' })); }
        }
        const bodyForAgent = [m.text, ...attachmentNotices].join('\n');
        const current=runtime.config.current();
        // Per-turn presentation only; never write global session preferences.
        const cfg={...current,session:{...current.session,typingMode:'instant'}};
        if (!direct) {
          if (!turnPolicy.targetAllowed(m.conversationId)) throw new Error('Group destination no longer approved');
          const group = m.conversationId;
          if (!groupAdmitted(m,state.group.since)) throw new Error('Group event no longer admitted');
          const route=channelRuntime.routing.resolveAgentRoute({cfg,channel:CHANNEL,accountId:'default',peer:{kind:'group',id:group}});
          const ingress=await channelRuntime.inbound.ingress.resolveStable({channelId:CHANNEL,accountId:'default',subject:{stableId:m.fromId},conversation:{kind:'group',id:group},contextBinding:{agentId:route.agentId,sessionKey:route.sessionKey,messageId:m.id,inboundEventKind:'user_request'},dmPolicy:'allowlist',groupPolicy:'allowlist',allowFrom:[SENDER],groupAllowFrom:ownerOnce?[SENDER]:['*'],route:{id:group,kind:'group',configured:true,matched:true,allowed:true},useDefaultPairingStore:false,command:false});
          assertTurnAuthority();
          if (!ingress.senderAccess.allowed) throw new Error('Group ingress denied');
          const explicit=Boolean(m.mentions?.some(x=>x.mri===BOT));
          const ctxPayload=await channelRuntime.inbound.buildContext({channel:CHANNEL,accountId:'default',provider:CHANNEL,surface:CHANNEL,messageId:m.id,messageIdFull:m.id,timestamp:Date.parse(m.time),from:group,sender:{id:m.fromId,name:m.from},conversation:{kind:'group',id:group,label:groupLabel(group),routePeer:{kind:'group',id:group}},route:{agentId:route.agentId,accountId:'default',routeSessionKey:route.sessionKey,dispatchSessionKey:route.sessionKey},reply:{to:group,originatingTo:group},message:{rawBody:m.text,bodyForAgent,commandBody:m.text,inboundHistory:m.history,inboundEventKind:'user_request'},access:{commands:{authorized:false},mentions:{canDetectMention:true,wasMentioned:explicit,explicitlyMentionedBot:explicit,effectiveWasMentioned:explicit||m.replyToBot===true,requireMention:true}},channelIngress:ingress,media,supplemental:m.quote?{quote:m.quote}:undefined,extra:{OriginatingChannel:CHANNEL}});
          assertTurnAuthority();
          await dispatchWithTyping({cfg,turnPolicy,channel:CHANNEL,accountId:'default',route,ctxPayload,assertAuthority:assertTurnAuthority,...bindIngressLifecycleToReplyOptions(lifecycle),delivery:{deliver:async(payload)=>{assertTurnAuthority();await deliverPayload(group,payload,assertTurnAuthority,turnPolicy);},onError:e=>ctx.log?.error(`Teams group dispatch: ${String(e)}`)}},group,lifecycle);
          return;
        }
        const dm = m.conversationId;
        const senderName = m.from || m.fromId;
        const allowFrom = policy.dmAllowFrom(dm);
        // Force channel/peer isolation without changing the global session preference.
        const scoped={...cfg,session:{...cfg.session,dmScope:'per-channel-peer'}};
        // The DM convenience dispatcher does not expose typing. Use the same
        // native routed dispatcher and retain its envelope/context/DM isolation.
        const route=channelRuntime.routing.resolveAgentRoute({cfg:scoped,channel:CHANNEL,accountId:'default',peer:{kind:'direct',id:dm}});
        const ingress=await channelRuntime.inbound.ingress.resolveStable({channelId:CHANNEL,accountId:'default',subject:{stableId:m.fromId},conversation:{kind:'direct',id:dm},contextBinding:{agentId:route.agentId,sessionKey:route.sessionKey,messageId:m.id,inboundEventKind:'user_request'},dmPolicy:'allowlist',groupPolicy:'disabled',allowFrom,useDefaultPairingStore:false,command:false});
        assertTurnAuthority();
        if(!ingress.senderAccess.allowed) throw new Error('Teams ingress denied');
        const body=(await createChannelInboundEnvelopeBuilderAsync({cfg:scoped,route}))({channel:'Teams Personal',from:senderName,body:m.text,timestamp:Date.parse(m.time)});
        const ctxPayload=await channelRuntime.inbound.buildContext({channel:CHANNEL,accountId:'default',messageId:m.id,messageIdFull:m.id,timestamp:Date.parse(m.time),from:dm,sender:{id:m.fromId,name:senderName},conversation:{kind:'direct',id:dm,label:senderName,routePeer:{kind:'direct',id:dm}},route:{agentId:route.agentId,accountId:route.accountId,routeSessionKey:route.sessionKey,dispatchSessionKey:route.sessionKey},reply:{to:dm,originatingTo:dm},message:{body,rawBody:m.text,bodyForAgent,commandBody:m.text},access:{commands:{authorized:false}},channelIngress:ingress,media,extra:{NativeDirectUserId:dm,OriginatingChannel:CHANNEL}});
        assertTurnAuthority();
        await dispatchWithTyping({cfg:scoped,channel:CHANNEL,accountId:'default',route,ctxPayload,assertAuthority:assertTurnAuthority,
          ...bindIngressLifecycleToReplyOptions(lifecycle),
          record:{onRecordError:(e)=>ctx.log?.error(`Teams session record: ${String(e)}`)},
          delivery:{deliver:async(payload)=>{assertTurnAuthority();await deliverPayload(dm,payload,assertTurnAuthority);},onError:(e)=>ctx.log?.error(`Teams dispatch: ${String(e)}`)},
        },dm,lifecycle);
      },
    });
    monitor.start();
    ctx.setStatus({accountId:'default',running:true,connected:false,lastStartAt:Date.now()});
    const presence = makePresence({ signal: ctx.abortSignal, log: ctx.log,
      api: createPresenceApi({ policy, currentConfig: () => runtime.config.current(), getSkypeToken, assertAuthority }) });
    try {
      await receiver({
        authProvider:getSkypeToken, policy, stateDir:dir,
        admit:m=>monitor.admit(m), assertAuthority, signal:ctx.abortSignal,
        status:fields=>{
          ctx.setStatus({accountId:'default',...fields});
          if (typeof fields.connected === 'boolean') presence.setConnected(fields.connected);
        },
        log:(event,data)=>ctx.log?.info(`Teams realtime ${event}${data?' '+JSON.stringify(data):''}`),
      });
    }finally{await presence.stop();await monitor.stop();ctx.setStatus({accountId:'default',running:false,connected:false});}
  }},
};
return defineChannelPluginEntry({id:CHANNEL,name:'Teams Personal',description:'Approved Teams Free DM and group connector',plugin,setRuntime:r=>{runtime=r;},registerFull:api=>{
  // Tool discovery can run without starting the channel or setting its runtime.
  const currentConfig = () => api.runtime.config.current();
  const toolPolicy = createScopedPolicy(basePolicy, currentConfig);
  api.registerTool(context=>createGroupAccessTool(context,{policy:basePolicy,current:currentConfig,
    mutate:options=>api.runtime.config.mutateConfigFile(options),sharedEnroll,jsonResult:sdk.jsonResult}),{name:'teams_group_access',workspaceAccess:false});
  api.registerTool(context=>createChatTool(context,{policy:toolPolicy,currentConfig,getSkypeToken,getGraphToken,sdk}),{name:'teams_chat',workspaceAccess:false});
}});
}
