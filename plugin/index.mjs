import fs from 'node:fs/promises';
import path from 'node:path';
import { runReceiver } from './receiver.mjs';
import { createTeamsActions } from './actions.mjs';

// The deployment bridge supplies the host's SDK and existing approved auth/client.
// This keeps the repository independent of machine paths and credential storage.
export function createTeamsChannel({ sdk, getSkypeToken, hasSavedLogin, createTeamsClient, policy,
  reactionEmojis, normalizeReactionKey, receiver = runReceiver }) {
const { defineChannelPluginEntry, dispatchInboundDirectDm, dispatchChannelInboundTurn,
  createChannelIngressMonitor, bindIngressLifecycleToReplyOptions,
  createChannelMessageAdapterFromOutbound } = sdk;
const { CHANNEL, CHAT, SENDER, BOT, GROUP, GROUPS = [GROUP], groupLabel = id => id, normalizedTarget, groupAdmitted, validConfig, admitted, targetAllowed } = policy;
let runtime;
const client = createTeamsClient(getSkypeToken);
const resolveAccount = (cfg) => ({accountId:'default', ...cfg.channels?.[CHANNEL]});
function assertConfig(cfg) { if (!validConfig(resolveAccount(cfg))) throw new Error('Teams Personal policy not enabled or differs from approved account'); }
async function send(cfg, to, text) {
  // Long-lived caller turns may retain a pre-install config; live policy is authoritative.
  assertConfig(runtime.config.current());
  if (!targetAllowed(to)) throw new Error('Teams Personal destination not approved');
  if ((await client.whoAmI()).mri !== BOT) throw new Error('Teams Personal signed-in account changed');
  assertConfig(runtime.config.current());
  const receipt = await client.sendMessage(normalizedTarget(to), text, {mentionRecipient:false});
  // Arrival time is the observed platform message id in this transport; client id is not a receipt.
  if (!receipt.arrivalTime) throw new Error('Teams accepted send without a platform id; reconcile before retry');
  return {channel:CHANNEL, messageId:String(receipt.arrivalTime), chatId:normalizedTarget(to)};
}
const outbound = {deliveryMode:'direct', textChunkLimit:6000,
  sendText: ({cfg,to,text}) => send(cfg,to,text),
};
const plugin = {
  id:CHANNEL,
  meta:{id:CHANNEL,label:'Teams Personal',selectionLabel:'Teams Free (personal)',docsPath:'/channels/msteams',blurb:'Unofficial personal-account text transport'},
  capabilities:{chatTypes:['direct','group'],media:false,reactions:true},
  actions:createTeamsActions({policy,currentConfig:()=>runtime.config.current(),getSkypeToken,
    createTeamsClient,reactionEmojis,normalizeReactionKey,jsonResult:sdk.jsonResult}),
  config:{listAccountIds:()=>['default'],resolveAccount,
    inspectAccount:(cfg)=>({accountId:'default',enabled:validConfig(resolveAccount(cfg)),configured:hasSavedLogin()}),
    isEnabled:(a)=>validConfig(a),isConfigured:()=>hasSavedLogin(),
    resolveAllowFrom:()=>[SENDER],
  },
  security:{resolveDmPolicy:()=>({policy:'allowlist',allowFrom:[SENDER],policyPath:'channels.teams-personal.dmPolicy',allowFromPath:'channels.teams-personal.allowFrom',approveHint:'Only the owner-approved test DM is enabled.'})},
  messaging:{normalizeTarget:(to)=>targetAllowed(to)?normalizedTarget(to):undefined,targetResolver:{looksLikeId:targetAllowed,hint:CHAT}},
  agentPrompt:{inboundFormattingHints:()=>['Teams Personal text-only chat with emoji reactions. In groups, respond only to mentions, commands, or replies to your messages; if the body addresses someone else, stay silent. Keep group and private history separate. Reply in natural Traditional Chinese. No attachments, tables, or rich cards.'],messageToolHints:()=>['Reply only to the current Teams conversation; do not send private content to a group. Use message(action=react, messageId, emoji) to react; remove=true removes only your selected emoji. emoji-list lists supported glyphs and keys. An omitted messageId uses only the current Teams message. Do not resend an unverified reaction. When asked only to react, a verified reaction is the complete reply; do not add a text confirmation.']},
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
    const monitor=createChannelIngressMonitor({
      queue:()=>runtime.state.openChannelIngressQueue({accountId:'default'}),
      inspect:(m)=>(admitted(m,state.since)||groupAdmitted(m,state.group.since))?{eventId:m.id,laneKey:m.conversationId}:null,
      payload:{version:1,storage:'raw-event',serialize:(m)=>JSON.stringify(m),deserialize:(body)=>JSON.parse(body),createClaimError:(kind)=>new Error(`Teams ingress ${kind}`)},
      pollIntervalMs:1000,retention:{completedTtlMs:30*86400000,completedMaxEntries:2000},abortSignal:ctx.abortSignal,
      onError:(e)=>ctx.log?.error(String(e)),
      deliver:async(m,lifecycle)=>{
        assertAuthority();
        const cfg=runtime.config.current();
        if (GROUPS.includes(m.conversationId)) {
          const group = m.conversationId;
          if (!groupAdmitted(m,state.group.since)) throw new Error('Group event no longer admitted');
          const route=channelRuntime.routing.resolveAgentRoute({cfg,channel:CHANNEL,accountId:'default',peer:{kind:'group',id:group}});
          const ingress=await channelRuntime.inbound.ingress.resolveStable({channelId:CHANNEL,accountId:'default',subject:{stableId:m.fromId},conversation:{kind:'group',id:group},contextBinding:{agentId:route.agentId,sessionKey:route.sessionKey,messageId:m.id,inboundEventKind:'user_request'},dmPolicy:'allowlist',groupPolicy:'allowlist',allowFrom:[SENDER],groupAllowFrom:['*'],route:{id:group,kind:'group',configured:true,matched:true,allowed:true},useDefaultPairingStore:false,command:false});
          if (!ingress.senderAccess.allowed) throw new Error('Group ingress denied');
          const explicit=Boolean(m.mentions?.some(x=>x.mri===BOT));
          const ctxPayload=await channelRuntime.inbound.buildContext({channel:CHANNEL,accountId:'default',provider:CHANNEL,surface:CHANNEL,messageId:m.id,messageIdFull:m.id,timestamp:Date.parse(m.time),from:group,sender:{id:m.fromId,name:m.from},conversation:{kind:'group',id:group,label:groupLabel(group),routePeer:{kind:'group',id:group}},route:{agentId:route.agentId,accountId:'default',routeSessionKey:route.sessionKey,dispatchSessionKey:route.sessionKey},reply:{to:group,originatingTo:group},message:{rawBody:m.text,bodyForAgent:m.text,commandBody:m.text,inboundHistory:m.history,inboundEventKind:'user_request'},access:{commands:{authorized:false},mentions:{canDetectMention:true,wasMentioned:explicit,explicitlyMentionedBot:explicit,effectiveWasMentioned:explicit||m.replyToBot===true,requireMention:true}},channelIngress:ingress,supplemental:m.quote?{quote:m.quote}:undefined,extra:{OriginatingChannel:CHANNEL}});
          await dispatchChannelInboundTurn({cfg,channel:CHANNEL,accountId:'default',route,ctxPayload,assertAuthority,...bindIngressLifecycleToReplyOptions(lifecycle),delivery:{deliver:async(payload)=>{assertAuthority();if(payload.mediaUrl||payload.mediaUrls?.length) throw new Error('Text only');if(payload.text) await send(runtime.config.current(),group,payload.text);},onError:e=>ctx.log?.error(`Teams group dispatch: ${String(e)}`)}});
          return;
        }
        // Force channel/peer isolation without changing the global session preference.
        const scoped={...cfg,session:{...cfg.session,dmScope:'per-channel-peer'}};
        await dispatchInboundDirectDm({cfg:scoped,channel:CHANNEL,channelLabel:'Teams Personal',accountId:'default',peer:{kind:'direct',id:CHAT},senderId:SENDER,senderAddress:CHAT,recipientAddress:CHAT,conversationLabel:'月太',rawBody:m.text,messageId:m.id,timestamp:Date.parse(m.time),commandAuthorized:false,originatingTo:CHAT,channelRuntime,assertAuthority,
          resolveChannelIngress:async(contextBinding)=>{
            const result=await channelRuntime.inbound.ingress.resolveStable({channelId:CHANNEL,accountId:'default',subject:{stableId:SENDER},conversation:{kind:'direct',id:CHAT},contextBinding,dmPolicy:'allowlist',groupPolicy:'disabled',allowFrom:[SENDER],useDefaultPairingStore:false,command:false});
            if(!result.senderAccess.allowed) throw new Error('Teams ingress denied');
            return result;
          },
          ...bindIngressLifecycleToReplyOptions(lifecycle),
          deliver:async(payload)=>{assertAuthority();if(payload.mediaUrl||payload.mediaUrls?.length) throw new Error('Teams personal adapter supports text only');if(payload.text) await send(runtime.config.current(),CHAT,payload.text);},
          onRecordError:(e)=>ctx.log?.error(`Teams session record: ${String(e)}`),onDispatchError:(e)=>{ctx.log?.error(`Teams dispatch: ${String(e)}`);},
        });
      },
    });
    monitor.start();
    ctx.setStatus({accountId:'default',running:true,connected:false,lastStartAt:Date.now()});
    try {
      await receiver({
        authProvider:getSkypeToken, policy, stateDir:dir,
        admit:m=>monitor.admit(m), assertAuthority, signal:ctx.abortSignal,
        status:fields=>ctx.setStatus({accountId:'default',...fields}),
        log:(event,data)=>ctx.log?.info(`Teams realtime ${event}${data?' '+JSON.stringify(data):''}`),
      });
    }finally{await monitor.stop();ctx.setStatus({accountId:'default',running:false,connected:false});}
  }},
};
return defineChannelPluginEntry({id:CHANNEL,name:'Teams Personal',description:'Approved Teams Free DM and group connector',plugin,setRuntime:r=>{runtime=r;}});
}
