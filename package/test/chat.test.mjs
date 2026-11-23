import test from 'node:test';
import assert from 'node:assert/strict';
import {signature,verify,normalize,format,deliver} from '../lib/chat.mjs';
const secret='local-test-key-'.repeat(4);
const bot={signingSecret:secret,agentMachine:'agent-pete',callbackUrl:'http://127.0.0.1/callback'};
const message={version:1,conversationId:'123e4567-e89b-42d3-a456-426614174000',messageId:'message-1',text:'$(id) --machine attacker',senderId:'a'.repeat(64),senderName:'David',agent:'agent-pete',callbackCapability:'b'.repeat(64),sentAt:new Date().toISOString()};
const input=(m=message)=>{const rawBody=JSON.stringify(m);const timestamp=String(Math.floor(Date.parse(m.sentAt)/1000));return {method:'POST',rawBody,headers:{'X-Aux4-Chat-Signature':signature(rawBody,secret,timestamp),'X-Aux4-Chat-Timestamp':timestamp},bot};};
test('authenticates exact bytes, time window and fixed agent',()=>{
 assert.deepEqual(verify(input()),{valid:true});
 assert.equal(verify({...input(),rawBody:input().rawBody+' '}).valid,false);
 assert.equal(verify({...input(),headers:{}}).valid,false);
 assert.equal(verify({...input(),headers:{...input().headers,'X-Aux4-Chat-Timestamp':'1'}}).valid,false);
 assert.equal(verify(input({...message,sentAt:new Date(Date.now()-300001).toISOString()})).valid,false);
 assert.equal(verify(input({...message,agent:'attacker'})).valid,false);
 assert.equal(verify(input({...message,attachments:[{id:'x'}]})).valid,false);
 assert.equal(verify({...input(),method:'GET'}).statusCode,405);
 assert.equal(verify({...input(),rawBody:'x'.repeat(65537)}).valid,false);
});
test('normalizes text without executing it, retains sender and opaque delivery capability',()=>{
 const [event]=normalize(input());
 assert.equal(event.text,message.text);assert.equal(event.chatId,message.conversationId);assert.equal(event.key,message.messageId);
 assert.deepEqual(event.sender,{displayName:'David',id:message.senderId});assert.equal(event.delivery.callbackCapability,message.callbackCapability);
});
test('requires exact canonical response correlation',()=>{
 const [event]=normalize(input());
 const turn={version:1,status:'completed',conversationId:message.conversationId,messageId:message.messageId,reply:'Hello David',history:{messages:[{role:'assistant',content:'Hello David',replyTo:message.messageId}]}};
 assert.equal(format({markdown:JSON.stringify(turn),event}).text,'Hello David');
 assert.equal(format({markdown:JSON.stringify({...turn,history:{messages:[{role:'assistant',content:'old',replyTo:'other',artifacts:[{id:'wrong'}]},{role:'assistant',content:'Hello David',replyTo:message.messageId,artifacts:[{id:'app-1',kind:'aux4.app',version:1,state:{done:false}}]}]}}),event}).artifacts[0].id,'app-1');
 assert.throws(()=>format({markdown:JSON.stringify({...turn,messageId:'other'}),event}));
 assert.throws(()=>format({markdown:'plain answer',event}));
});
test('forwards only bounded artifacts from the matching assistant reply',()=>{
 const [event]=normalize(input());
 const base={version:1,status:'completed',conversationId:event.chatId,messageId:event.key,reply:'ok'};
 const wrong={...base,history:{messages:[{role:'assistant',replyTo:'other',artifacts:[{id:'wrong'}]}]}};
 assert.equal(format({markdown:JSON.stringify(wrong),event}).artifacts,undefined);
 const tooMany={...base,history:{messages:[{role:'assistant',replyTo:event.key,artifacts:Array.from({length:9},(_,i)=>({id:`a-${i}`}))}]}};
 assert.throws(()=>format({markdown:JSON.stringify(tooMany),event}),/artifacts/);
 const oversized={...base,history:{messages:[{role:'assistant',replyTo:event.key,artifacts:[{id:'large',data:'x'.repeat(128*1024)}]}]}};
 assert.throws(()=>format({markdown:JSON.stringify(oversized),event}),/artifacts/);
 assert.throws(()=>format({markdown:JSON.stringify({...base,history:{messages:[{role:'assistant',replyTo:event.key,artifacts:'bad'}]}}),event}),/artifacts/);
});
test('accepts failed turns with a bounded generic visible reply',()=>{
 const [event]=normalize(input());
 const formatted=format({markdown:JSON.stringify({version:1,status:'failed',conversationId:event.chatId,messageId:event.key,error:'secret detail',history:{messages:[]}}),event});
 assert.equal(formatted.status,'failed');
 assert.equal(formatted.text,'The agent could not complete this request. Please try again.');
});
test('retries the exact callback after lost acknowledgement and refuses redirects',async()=>{
 const [event]=normalize(input());let calls=[];
 const formatted={text:'Hello David',history:{messages:[]},conversationId:event.chatId,messageId:event.key};
 const result=await deliver({event,formatted,bot},false,async(url,options)=>{calls.push(options);if(calls.length===1)throw Error('local lost acknowledgement');return {ok:true,json:async()=>({accepted:true})};});
 assert.deepEqual(result,{ok:true});assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);assert.equal(calls[0].redirect,'error');
 assert.equal(JSON.parse(calls[0].body).reply,'Hello David');assert.equal('history' in JSON.parse(calls[0].body),false);
 await assert.rejects(()=>deliver({event:{...event,key:'other'},formatted,bot},false,async()=>{throw Error('must not send');}));
});
test('delivers formatted artifacts and preserves exact callback correlation',async()=>{
 const [event]=normalize(input());
 const formatted=format({event,markdown:JSON.stringify({version:1,status:'completed',conversationId:event.chatId,messageId:event.key,reply:'Build it',history:{messages:[{role:'assistant',replyTo:'other',artifacts:[{id:'wrong'}]},{role:'assistant',replyTo:event.key,artifacts:[{id:'app-1',kind:'aux4.app',version:1,presentation:'inline',state:{done:false}}]}]}})});
 let sent;
 await deliver({event,formatted,bot},false,async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({accepted:true})};});
 assert.deepEqual(sent.artifacts,[{id:'app-1',kind:'aux4.app',version:1,presentation:'inline',state:{done:false}}]);
 assert.equal(sent.messageId,event.key);assert.equal(sent.status,'completed');
});
