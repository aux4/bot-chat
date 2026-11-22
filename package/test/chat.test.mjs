import test from 'node:test';
import assert from 'node:assert/strict';
import {signature,verify,normalize,format,deliver} from '../lib/chat.mjs';
const secret='local-test-key-'.repeat(4);
const bot={signingSecret:secret,agentMachine:'agent-pete',callbackUrl:'http://127.0.0.1/callback'};
const message={version:1,conversationId:'123e4567-e89b-42d3-a456-426614174000',messageId:'message-1',text:'$(id) --machine attacker',senderId:'a'.repeat(64),senderName:'David',agent:'agent-pete',callbackCapability:'b'.repeat(64),sentAt:new Date().toISOString()};
const input=(m=message)=>{const rawBody=JSON.stringify(m);return {method:'POST',rawBody,headers:{'X-Aux4-Chat-Signature':signature(rawBody,secret)},bot};};
test('authenticates exact bytes, time window and fixed agent',()=>{
 assert.deepEqual(verify(input()),{valid:true});
 assert.equal(verify({...input(),rawBody:input().rawBody+' '}).valid,false);
 assert.equal(verify({...input(),headers:{}}).valid,false);
 assert.equal(verify(input({...message,sentAt:new Date(Date.now()-300001).toISOString()})).valid,false);
 assert.equal(verify(input({...message,agent:'attacker'})).valid,false);
 assert.equal(verify(input({...message,attachments:[{id:'x'}]})).valid,false);
 assert.equal(verify({...input(),method:'GET'}).statusCode,405);
 assert.equal(verify({...input(),rawBody:'x'.repeat(65537)}).valid,false);
});
test('normalizes text without executing it, retains sender and opaque delivery capability',()=>{
 const [event]=normalize(input());
 assert.equal(event.text,message.text);assert.equal(event.chatId,message.conversationId);assert.equal(event.key,message.messageId);
 assert.deepEqual(event.sender,{displayName:'David'});assert.equal(event.delivery.callbackCapability,message.callbackCapability);
});
test('requires exact canonical response correlation',()=>{
 const [event]=normalize(input());
 const turn={version:1,status:'completed',conversationId:message.conversationId,messageId:message.messageId,reply:'Hello David',history:{messages:[{role:'assistant',content:'Hello David',replyTo:message.messageId}]}};
 assert.equal(format({markdown:JSON.stringify(turn),event}).text,'Hello David');
 assert.throws(()=>format({markdown:JSON.stringify({...turn,messageId:'other'}),event}));
 assert.throws(()=>format({markdown:'plain answer',event}));
});
test('retries the exact callback after lost acknowledgement and refuses redirects',async()=>{
 const [event]=normalize(input());let calls=[];
 const formatted={text:'Hello David',history:{messages:[]},conversationId:event.chatId,messageId:event.key};
 const result=await deliver({event,formatted,bot},false,async(url,options)=>{calls.push(options);if(calls.length===1)throw Error('local lost acknowledgement');return {ok:true,json:async()=>({accepted:true})};});
 assert.deepEqual(result,{ok:true});assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);assert.equal(calls[0].redirect,'error');
 assert.equal(JSON.parse(calls[0].body).reply,'Hello David');
 await assert.rejects(()=>deliver({event:{...event,key:'other'},formatted,bot},false,async()=>{throw Error('must not send');}));
});
