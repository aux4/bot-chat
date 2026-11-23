import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CAP = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_ARTIFACTS = 8;
const MAX_ARTIFACT_BYTES = 128 * 1024;
const FAILED_REPLY = 'The agent could not complete this request. Please try again.';
function boundedArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length > MAX_ARTIFACTS || artifacts.some(artifact => !artifact || typeof artifact !== 'object' || Array.isArray(artifact))) throw new Error('Invalid agent artifacts');
  let encoded;
  try { encoded = JSON.stringify(artifacts); } catch { throw new Error('Invalid agent artifacts'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ARTIFACT_BYTES) throw new Error('Invalid agent artifacts');
  return JSON.parse(encoded);
}
export function signature(rawBody, secret, timestamp) {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}
export function parseMessage(rawBody, bot = {}) {
  const message = JSON.parse(rawBody);
  if (message.version !== 1 || !UUID.test(message.conversationId || '') || !ID.test(message.messageId || '') ||
      typeof message.text !== 'string' || !message.text.trim() || message.text.length > 32768 ||
      !CAP.test(message.callbackCapability || '') || !/^[a-f0-9]{64}$/.test(message.senderId || '') ||
      !bot.agentMachine || message.agent !== bot.agentMachine) throw new Error('Invalid chat message');
  if (message.attachments?.length) throw new Error('Attachments are not supported by this connection');
  return message;
}
export function verify(input, now = Date.now()) {
  try {
    const raw = input.rawBody;
    const secret = input.bot?.signingSecret;
    if (input.method && input.method.toUpperCase() !== 'POST') return {valid:false,statusCode:405};
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536 || typeof secret !== 'string' || secret.length < 32) return {valid:false,statusCode:401};
    const headers = Object.fromEntries(Object.entries(input.headers || {}).map(([k,v])=>[k.toLowerCase(),v]));
    const signedTime = String(headers['x-aux4-chat-timestamp'] || '');
    if (!/^[0-9]{10,11}$/.test(signedTime) || Math.abs(now-Number(signedTime)*1000)>300000) return {valid:false,statusCode:401};
    const supplied = String(headers['x-aux4-chat-signature'] || '');
    const expected = signature(raw, secret, signedTime);
    if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))) return {valid:false,statusCode:401};
    const message = parseMessage(raw,input.bot);
    const timestamp = Date.parse(message.sentAt);
    if (!Number.isFinite(timestamp) || Math.floor(timestamp/1000)!==Number(signedTime) || Math.abs(now-timestamp)>300000) return {valid:false,statusCode:401};
    return {valid:true};
  } catch { return {valid:false,statusCode:400}; }
}
export function normalize(input) {
  const m = parseMessage(input.rawBody,input.bot);
  return [{key:m.messageId,kind:'message',chatId:m.conversationId,userId:m.senderId,text:m.text,files:[],ttl:129600,
    ...(typeof m.senderName==='string' && m.senderName.trim() ? {sender:{displayName:m.senderName.trim().slice(0,200),id:m.senderId}} : {}),
    delivery:{callbackCapability:m.callbackCapability}}];
}
export function format(input) {
  const turn = JSON.parse(input.markdown);
  if (turn.version !== 1 || !['completed','failed'].includes(turn.status) ||
      turn.conversationId !== input.event?.chatId || turn.messageId !== input.event?.key || !Array.isArray(turn.history?.messages)) throw new Error('Invalid agent turn');
  if (turn.status === 'completed' && typeof turn.reply !== 'string') throw new Error('Invalid agent turn');
  if (turn.status === 'failed' && turn.reply !== undefined && typeof turn.reply !== 'string') throw new Error('Invalid agent turn');
  const reply = turn.status === 'failed' ? FAILED_REPLY : turn.reply;
  const matching = turn.history.messages.filter(message => message?.role === 'assistant' && message.replyTo === turn.messageId);
  const artifacts = matching.flatMap(message => {
    if (message.artifacts === undefined) return [];
    if (!Array.isArray(message.artifacts)) throw new Error('Invalid agent artifacts');
    return message.artifacts;
  });
  const bounded = boundedArtifacts(artifacts);
  return {text:reply,status:turn.status,conversationId:turn.conversationId,messageId:turn.messageId,...(bounded.length ? {artifacts:bounded} : {})};
}
function callbackUrl(bot) {
  const url = new URL(bot.callbackUrl);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) throw new Error('Invalid callback configuration');
  return url;
}
export async function deliver(input, typing = false, transport = fetch) {
  const event = input.event;
  if (!UUID.test(event?.chatId || '') || !ID.test(event?.key || '') || !CAP.test(event?.delivery?.callbackCapability || '')) throw new Error('Missing chat delivery context');
  const formatted = input.formatted;
  if (!typing && (!formatted || formatted.conversationId !== event.chatId || formatted.messageId !== event.key)) throw new Error('Missing agent result');
  if (!typing && !['completed','failed'].includes(formatted.status || 'completed')) throw new Error('Invalid agent result');
  const artifacts = !typing && formatted.artifacts !== undefined ? boundedArtifacts(formatted.artifacts) : [];
  const body = JSON.stringify({conversationId:event.chatId,messageId:event.key,callbackCapability:event.delivery.callbackCapability,
    status:typing ? 'processing' : (formatted.status || 'completed'),...(!typing ? {reply:formatted.text,...(artifacts.length ? {artifacts} : {})} : {})});
  for (const delay of [0,250,750,1500]) {
    if (delay) await new Promise(resolve=>setTimeout(resolve,delay));
    try {
      const response = await transport(callbackUrl(input.bot),{method:'POST',headers:{'content-type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(8000)});
      if (response.ok && (await response.json()).accepted === true) return {ok:true};
    } catch { /* Retry the exact capability-bound event; never disclose its body. */ }
  }
  throw new Error('Chat delivery was not accepted');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action=process.argv[2];let raw='';
    for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>524288)throw new Error();}
    const input=JSON.parse(raw || '{}');
    const result=action==='verify'?verify(input):action==='ingest-parse'?normalize(input):action==='format'?format(input):action==='typing'?await deliver(input,true):action==='send'?await deliver(input):action==='download'?{path:null}:null;
    if(result===null)throw new Error();process.stdout.write(typeof result==='string'?result:JSON.stringify(result));
  } catch {process.stderr.write('Chat adapter command failed\n');process.exitCode=1;}
}
