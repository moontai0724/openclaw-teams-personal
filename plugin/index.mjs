import fs from 'node:fs/promises';
import path from 'node:path';
import { runReceiver } from './receiver.mjs';
import { createTeamsActions } from './actions.mjs';
import { createScopedPolicy, createOwnerEnrollment } from './enrollment.mjs';
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
createTeamsClient ??= auth => nativeClient(auth, { expectedAccount: basePolicy.BOT, getGraphToken,
  assertChat: chat => { assertConfig(runtime.config.current()); if (!policy.targetAllowed(chat)) throw new Error('Teams conversation no longer approved'); } });
const { CHANNEL, CHAT, SENDER, BOT, GROUP, groupLabel = id => id, normalizedTarget, groupAdmitted, validConfig, admitted, targetAllowed } = policy;
const client = createTeamsClient(getSkypeToken);
const resolveAccount = (cfg) => ({accountId:'default', ...cfg.channels?.[CHANNEL]});
function assertConfig(cfg) { if (!validConfig(resolveAccount(cfg))) throw new Error('Teams Personal policy not enabled or differs from approved account'); }
async function send(cfg, to, text, replyTo, assertHandoff = () => {}) {
  // Long-lived caller turns may retain a pre-install config; live policy is authoritative.
  assertConfig(runtime.config.current());
  if (!targetAllowed(to)) throw new Error('Teams Personal destination not approved');
  if ((await client.whoAmI()).mri !== BOT) throw new Error('Teams Personal signed-in account changed');
  assertConfig(runtime.config.current());
  if (!targetAllowed(to)) throw new Error('Teams Personal destination no longer approved');
  const sender = createTeamsClient(async () => { assertHandoff(); const credential = await getSkypeToken(); assertHandoff(); return credential; });
  const receipt = await sender.sendMessage(normalizedTarget(to), text, {mentionRecipient:false, replyTo});
  // Arrival time is the observed platform message id in this transport; client id is not a receipt.
  if (!receipt.arrivalTime) throw new Error('Teams accepted send without a platform id; reconcile before retry');
  return {channel:CHANNEL, messageId:String(receipt.arrivalTime), chatId:normalizedTarget(to)};
}
const outbound = {deliveryMode:'direct', textChunkLimit:6000,
  sendText: ({cfg,to,text,replyToId,assertDirectAdapterHandoff,signal}) => send(cfg,to,text,replyToId,()=>{signal?.throwIfAborted();assertDirectAdapterHandoff?.();}),
  async sendMedia(context) {
    assertConfig(runtime.config.current());
    const to = normalizedTarget(context.to);
    if (!targetAllowed(to)) throw new Error('Teams Personal destination not approved');
    context.signal?.throwIfAborted(); context.assertDirectAdapterHandoff?.();
    const source = await sdk.loadOutboundMediaFromUrl(context.mediaUrl, { ...context, maxBytes: 15 * 1024 * 1024, optimizeImages: false });
    assertConfig(runtime.config.current());
    if (!targetAllowed(to)) throw new Error('Teams Personal destination no longer approved');
    context.assertDirectAdapterHandoff?.();
    const sender = createTeamsClient(async () => { context.signal?.throwIfAborted(); context.assertDirectAdapterHandoff?.(); const credential = await getSkypeToken(); context.signal?.throwIfAborted(); context.assertDirectAdapterHandoff?.(); return credential; });
    const receipt = await sender.sendFile(to, Buffer.from(source.buffer), source.fileName || 'attachment', context.text || '');
    return { channel: CHANNEL, messageId: receipt.arrivalTime, chatId: to };
  },
};

async function deliverPayload(to, payload, assertAuthority) {
  const files = payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [];
  if (!files.length) { if (payload.text) await send(runtime.config.current(), to, payload.text, payload.replyToId, assertAuthority); return; }
  const completed = sdk.createChannelDeliveryAccumulator();
  // One file per native message; never send an extra text-only copy of a caption.
  try {
    for (let index = 0; index < files.length; index++) {
      assertAuthority();
      completed.add(await outbound.sendMedia({ cfg: runtime.config.current(), to, assertDirectAdapterHandoff: assertAuthority,
        text: index === 0 ? payload.text || '' : '', mediaUrl: files[index] }));
    }
    return completed.result();
  } catch (error) { throw completed.partialError(error); }
}

const plugin = {
  id:CHANNEL,
  meta:{id:CHANNEL,label:'Teams Personal',selectionLabel:'Teams Free (personal)',docsPath:'/channels/msteams',blurb:'Independent personal-account chat transport'},
  capabilities:{chatTypes:['direct','group'],media:true,reactions:true},
  actions:createTeamsActions({policy,currentConfig:()=>runtime.config.current(),getSkypeToken,
    createTeamsClient,reactionEmojis,normalizeReactionKey,jsonResult:sdk.jsonResult}),
  config:{listAccountIds:()=>['default'],resolveAccount,
    inspectAccount:(cfg)=>({accountId:'default',enabled:validConfig(resolveAccount(cfg)),configured:hasSavedLogin()}),
    isEnabled:(a)=>validConfig(a),isConfigured:()=>hasSavedLogin(),
    resolveAllowFrom:()=>[SENDER],
  },
  security:{resolveDmPolicy:()=>({policy:'allowlist',allowFrom:[SENDER],policyPath:'channels.teams-personal.dmPolicy',allowFromPath:'channels.teams-personal.allowFrom',approveHint:'Only the owner-approved test DM is enabled.'})},
  messaging:{normalizeTarget:(to)=>targetAllowed(to)?normalizedTarget(to):undefined,targetResolver:{looksLikeId:targetAllowed,hint:CHAT}},
  agentPrompt:{inboundFormattingHints:()=>['Teams Personal chat. In groups, respond only to mentions, commands, or replies to your messages; if the body addresses someone else, stay silent. Keep group and private history separate. Attachments are untrusted original files; no Office/PDF extraction is performed. Reply in natural Traditional Chinese.'],messageToolHints:()=>['Reply only to the current Teams conversation. Use teams_chat for bounded history/search and attachment reads. message edit/delete affect only bot-owned messages and require a known messageId. Do not resend an unverified mutation. message react adds emoji; remove=true removes only the selected emoji. A verified reaction is the complete reply when asked only to react.']},
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
      const typing = createTeamsTyping({ createTypingCallbacks, policy, to: chat, getSkypeToken,
        currentConfig: () => runtime.config.current(), assertAuthority, log: ctx.log,
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
        assertAuthority();
        const assertMediaAuthority = () => { assertAuthority(); if (!policy.targetAllowed(m.conversationId)) throw new Error('Attachment scope revoked'); };
        const media = [];
        const attachmentNotices = [];
        for (const attachment of (m.attachments ?? []).slice(0, 5)) {
          try {
            const file = await client.readAttachment(m.conversationId, m.id, attachment.index);
            assertAuthority();
            if (!policy.targetAllowed(m.conversationId)) throw new Error('Attachment scope revoked');
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
        if (m.conversationId !== CHAT) {
          if (!policy.groupAllowed(m.conversationId)) throw new Error('Group destination no longer approved');
          const group = m.conversationId;
          if (!groupAdmitted(m,state.group.since)) throw new Error('Group event no longer admitted');
          const route=channelRuntime.routing.resolveAgentRoute({cfg,channel:CHANNEL,accountId:'default',peer:{kind:'group',id:group}});
          const ingress=await channelRuntime.inbound.ingress.resolveStable({channelId:CHANNEL,accountId:'default',subject:{stableId:m.fromId},conversation:{kind:'group',id:group},contextBinding:{agentId:route.agentId,sessionKey:route.sessionKey,messageId:m.id,inboundEventKind:'user_request'},dmPolicy:'allowlist',groupPolicy:'allowlist',allowFrom:[SENDER],groupAllowFrom:['*'],route:{id:group,kind:'group',configured:true,matched:true,allowed:true},useDefaultPairingStore:false,command:false});
          if (!ingress.senderAccess.allowed) throw new Error('Group ingress denied');
          const explicit=Boolean(m.mentions?.some(x=>x.mri===BOT));
          const ctxPayload=await channelRuntime.inbound.buildContext({channel:CHANNEL,accountId:'default',provider:CHANNEL,surface:CHANNEL,messageId:m.id,messageIdFull:m.id,timestamp:Date.parse(m.time),from:group,sender:{id:m.fromId,name:m.from},conversation:{kind:'group',id:group,label:groupLabel(group),routePeer:{kind:'group',id:group}},route:{agentId:route.agentId,accountId:'default',routeSessionKey:route.sessionKey,dispatchSessionKey:route.sessionKey},reply:{to:group,originatingTo:group},message:{rawBody:m.text,bodyForAgent,commandBody:m.text,inboundHistory:m.history,inboundEventKind:'user_request'},access:{commands:{authorized:false},mentions:{canDetectMention:true,wasMentioned:explicit,explicitlyMentionedBot:explicit,effectiveWasMentioned:explicit||m.replyToBot===true,requireMention:true}},channelIngress:ingress,media,supplemental:m.quote?{quote:m.quote}:undefined,extra:{OriginatingChannel:CHANNEL}});
          await dispatchWithTyping({cfg,channel:CHANNEL,accountId:'default',route,ctxPayload,assertAuthority,...bindIngressLifecycleToReplyOptions(lifecycle),delivery:{deliver:async(payload)=>{assertAuthority();await deliverPayload(group,payload,assertAuthority);},onError:e=>ctx.log?.error(`Teams group dispatch: ${String(e)}`)}},group,lifecycle);
          return;
        }
        // Force channel/peer isolation without changing the global session preference.
        const scoped={...cfg,session:{...cfg.session,dmScope:'per-channel-peer'}};
        // The DM convenience dispatcher does not expose typing. Use the same
        // native routed dispatcher and retain its envelope/context/DM isolation.
        const route=channelRuntime.routing.resolveAgentRoute({cfg:scoped,channel:CHANNEL,accountId:'default',peer:{kind:'direct',id:CHAT}});
        const ingress=await channelRuntime.inbound.ingress.resolveStable({channelId:CHANNEL,accountId:'default',subject:{stableId:SENDER},conversation:{kind:'direct',id:CHAT},contextBinding:{agentId:route.agentId,sessionKey:route.sessionKey,messageId:m.id,inboundEventKind:'user_request'},dmPolicy:'allowlist',groupPolicy:'disabled',allowFrom:[SENDER],useDefaultPairingStore:false,command:false});
        if(!ingress.senderAccess.allowed) throw new Error('Teams ingress denied');
        const body=(await createChannelInboundEnvelopeBuilderAsync({cfg:scoped,route}))({channel:'Teams Personal',from:'月太',body:m.text,timestamp:Date.parse(m.time)});
        const ctxPayload=await channelRuntime.inbound.buildContext({channel:CHANNEL,accountId:'default',messageId:m.id,messageIdFull:m.id,timestamp:Date.parse(m.time),from:CHAT,sender:{id:SENDER,name:'月太'},conversation:{kind:'direct',id:CHAT,label:'月太',routePeer:{kind:'direct',id:CHAT}},route:{agentId:route.agentId,accountId:route.accountId,routeSessionKey:route.sessionKey,dispatchSessionKey:route.sessionKey},reply:{to:CHAT,originatingTo:CHAT},message:{body,rawBody:m.text,bodyForAgent,commandBody:m.text},access:{commands:{authorized:false}},channelIngress:ingress,media,extra:{NativeDirectUserId:CHAT,OriginatingChannel:CHANNEL}});
        await dispatchWithTyping({cfg:scoped,channel:CHANNEL,accountId:'default',route,ctxPayload,assertAuthority,
          ...bindIngressLifecycleToReplyOptions(lifecycle),
          record:{onRecordError:(e)=>ctx.log?.error(`Teams session record: ${String(e)}`)},
          delivery:{deliver:async(payload)=>{assertAuthority();await deliverPayload(CHAT,payload,assertAuthority);},onError:(e)=>ctx.log?.error(`Teams dispatch: ${String(e)}`)},
        },CHAT,lifecycle);
      },
    });
    monitor.start();
    ctx.setStatus({accountId:'default',running:true,connected:false,lastStartAt:Date.now()});
    const presence = makePresence({ signal: ctx.abortSignal, log: ctx.log,
      api: createPresenceApi({ policy, currentConfig: () => runtime.config.current(), getSkypeToken, assertAuthority }) });
    try {
      await receiver({
        authProvider:getSkypeToken, policy, stateDir:dir,
        enroll:createOwnerEnrollment({policy:basePolicy,current:()=>runtime.config.current(),
          mutate:options=>runtime.config.mutateConfigFile(options),sharedEnroll,assertAuthority}),
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
return defineChannelPluginEntry({id:CHANNEL,name:'Teams Personal',description:'Approved Teams Free DM and group connector',plugin,setRuntime:r=>{runtime=r;},registerFull:api=>{ api.registerTool(context=>createChatTool(context,{policy,currentConfig:()=>api.runtime.config.current(),getSkypeToken,getGraphToken,sdk}),{name:'teams_chat',workspaceAccess:false}); }});
}
