const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createJimakuApi,timeline,timelineScore,candidate}=require('../electron/jimaku-api.cjs');
const cue=(start,end,text='こんにちは')=>Buffer.from(`1\n${start} --> ${end}\n${text}\n`);
const url=name=>`https://jimaku.cc/entry/1/download/${name}`;
test('API uses title aliases and episode filter without depending on a scraped index or AniList lookup',async()=>{
  const calls=[];
  const client=createJimakuApi({apiKey:()=> 'fake-secret',fetchImpl:async(address,options)=>{
    assert.equal(options.headers.Authorization,'fake-secret');calls.push(address);
    if(address.includes('anilist_id='))return Response.json([]);
    if(address.includes('/search?'))return Response.json([{id:1,name:'FX Senshi Kurumi-chan',english_name:'FX Fighter Kurumi-chan',anilist_id:206401,flags:{}}]);
    assert.ok(address.endsWith('/entries/1/files?episode=1'));
    return Response.json([{name:'Japanese captions.srt',url:url('captions.srt'),size:100}]);
  }});
  const files=await client.files({anilistId:999,title:'FX Fighter Kurumi-chan'},1);
  assert.equal(files.length,1);assert.equal(files[0].anilistId,206401);assert.equal(calls.length,3);
});
test('release selection compares whole timelines, not extension alone or a fixed offset',async()=>{
  const long=cue('00:00:03.000','00:24:03.000'),short=cue('00:00:00.000','00:03:00.000');
  const client=createJimakuApi({apiKey:()=> 'fake-secret',fetchImpl:async address=>{
    if(address.includes('/search?'))return Response.json([{id:1,name:'Test anime'}]);
    if(address.includes('/files?'))return Response.json([{name:'Test anime E01.ass',url:url('wrong.ass'),size:100},{name:'Test anime E01.srt',url:url('correct.srt'),size:100}]);
    return new Response(address.endsWith('wrong.ass')?short:long);
  }});
  const selected=await client.find({title:'Test anime'},1,cue('00:01:10.000','00:25:10.000','Hello'));
  assert.equal(selected.name,'Test anime E01.srt');assert.equal(selected.compared,2);
  assert.equal(timeline(long).duration,1440);assert.ok(timelineScore(timeline(long),timeline(short))<0);
  assert.equal(candidate({name:'Test E01.zip',url:url('pack.zip'),size:100},1),null);
});
test('authentication failure is reported as HTTP error, not falsely reported as missing anime',async()=>{
  const client=createJimakuApi({apiKey:()=> 'fake-secret',fetchImpl:async()=>new Response('',{status:401})});
  await assert.rejects(client.files({title:'Test anime'},1),/Jimaku HTTP 401/);
});
