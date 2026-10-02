const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {spawnSync}=require('node:child_process');
const {translateLegacy}=require('../electron/legacy-subtitle-bridge.cjs');
const {SubtitleStore}=require('../electron/subtitle-store.cjs');

test('previous local caches are not eligible for automatic playback, even when marked gemini',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-subtitle-policy-'));
  try{
    const file=path.join(root,'subtitles','original.vtt');fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'WEBVTT\n');
    const store=new SubtitleStore({app:{getPath:()=>root}});
    store.save('episode',{path:file,source:'gemini',label:'로컬 AI 번역 (English)'});
    store.save('episode',{path:file,source:'local',label:'번역',model:'local:test'});
    assert.deepEqual(store.list('episode'),[]);
    assert.equal(store.list('episode',{includeLocal:true}).length,2);
    assert.equal(fs.existsSync(file),true);
    store.save('episode',{path:file,source:'gemini',label:'Gemini 번역 (English)',model:'gemini-test'});
    assert.equal(store.list('episode').length,1);assert.match(store.list('episode')[0].label,/Gemini/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('saved original English tracks are not mistaken for Korean translations',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
  const line=source.split('\n').find(line=>line.startsWith('const isSavedKorean='));
  const predicate=vm.runInNewContext(`${line}\nisSavedKorean`,{isKoreanTrack:entry=>/korean|한국/i.test(entry.label||'')});
  assert.equal(predicate({source:'reanime',label:'Re:Anime English (Track 3)'}),false);
  assert.equal(predicate({source:'gemini',label:'Gemini 번역'}),true);
  assert.equal(predicate({source:'kairan',label:'Kairan 자막'}),true);
});

test('original Python pipeline: whole episode input, Japanese references and English timestamps',()=>{
  const code=`import importlib.util, json, sys
from pathlib import Path
p=Path('electron/legacy-subtitles/translate_subtitles_gemini.py')
s=importlib.util.spec_from_file_location('original_translation',p)
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
jp=[{'id':0,'start':'00:00:03.000','end':'00:00:04.000','japanese':'こんにちは'}]
en=[{'id':0,'start_seconds':12.0,'end_seconds':14.0,'english':'Hello.'}]
prompt=m.build_translation_prompt(jp,en,'Test anime',19,'sample.ja.ass')
assert prompt.startswith(p.with_name('subtitle_translation_prompt.txt').read_text())
assert 'VIDEO_CUES:' in prompt and 'JAPANESE_SOURCE:' in prompt and '12.0' in prompt
rows=m.validate_translations([{'id':0,'video_english':'Hello.','source_ids':[0],'text':'안녕'}],1,1)
cues=m.translated_video_cues([{'start':'00:00:12.000','end':'00:00:14.000','text':'Hello.'}],list(rows.values()))
assert '00:00:12.000 --> 00:00:14.000' in m.render_vtt(cues)
assert '안녕' in m.render_vtt(cues)
assert not m.usable_episode_rows([{'id':0,'video_english':'Wrong scene','source_ids':[0],'text':'안녕'}],en,1)
print('OK')`;
  const result=spawnSync('python3',['-B','-c',code],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/OK/);
});

test('bridge forwards keys/model, preserves original assets, progress, cache and error redaction',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-legacy-test-'));
  let calls=0,fail=false;const statuses=[];
  const fakeSpawn=(_command,args,options)=>{
    calls++;assert.equal(options.env.GEMINI_MODEL,'gemini-test');assert.equal(options.env.GEMINI_API_KEYS,'test-secret,another-secret');
    assert.deepEqual(args.slice(1),['--japanese',path.join(root,'ja.vtt')]);
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    child.stdin.on('finish',()=>{queueMicrotask(()=>{
      child.stderr.write('LILAC_PROGRESS\t2\t3\t응답 수신 중\n');
      if(fail)child.stderr.write('Gemini failed test-secret\n');else child.stdout.write('WEBVTT\n\n00:00:12.000 --> 00:00:14.000\n안녕\n');
      child.emit('close',fail?1:0);
    });});return child;
  };
  try{
    const file=path.join(root,'en.vtt'),japaneseFile=path.join(root,'ja.vtt');fs.writeFileSync(file,'WEBVTT\n\n00:00:12.000 --> 00:00:14.000\nHello.\n');fs.writeFileSync(japaneseFile,'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nこんにちは\n');
    const args={file,japaneseFile,title:'Test',episode:19,model:'gemini-test',keys:['test-secret','another-secret'],cacheDir:path.join(root,'cache'),spawnProcess:fakeSpawn,status:text=>statuses.push(text)};
    const result=await translateLegacy(args);assert.equal(result.pipeline,'legacy');assert.equal(calls,1);
    assert.ok(statuses.some(text=>text==='2/3 응답 수신 중'));
    for(const name of ['translate_subtitles_gemini.py','subtitle_translation_prompt.txt'])assert.equal(fs.readFileSync(path.join(args.cacheDir,'legacy-runtime',name),'utf8'),fs.readFileSync(path.join(__dirname,'../electron/legacy-subtitles',name),'utf8'));
    assert.equal((await translateLegacy(args)).cached,true);assert.equal(calls,1);
    fail=true;await assert.rejects(translateLegacy({...args,episode:20}),error=>error.message.includes('[API 키]')&&!error.message.includes('test-secret'));
    await assert.rejects(translateLegacy({...args,japaneseFile:''}),/영어 단독/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

function consentHandler(lilac){
  const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
  const code=source.slice(source.indexOf('async function translateWithConsent('),source.indexOf('async function translateSubtitleTrack('));
  const context=vm.createContext({window:{lilac},ipcMessage:error=>error.message,Error});
  return vm.runInContext(`${code}\ntranslateWithConsent`,context);
}
test('local translation starts only after explicit consent; decline and stale requests never start it',async()=>{
  for(const accepted of [true,false]){
    const calls=[];let prompts=0;
    const translate=consentHandler({translateSubtitle:async options=>{calls.push(options.provider);if(options.provider==='gemini')throw new Error('Gemini unavailable');return {model:'local:test'};},confirmLocalTranslation:async()=>{prompts++;return accepted;}});
    const request=translate({provider:'gemini',legacy:true,english:true},()=>true);
    if(accepted)assert.equal((await request).model,'local:test');else await assert.rejects(request,/Gemini unavailable/);
    assert.deepEqual(calls,accepted?['gemini','local']:['gemini']);assert.equal(prompts,1);
  }
  let prompts=0;
  const translate=consentHandler({translateSubtitle:async()=>{throw new Error('stale');},confirmLocalTranslation:async()=>{prompts++;return true;}});
  await assert.rejects(translate({provider:'gemini'},()=>false),/stale/);assert.equal(prompts,0);
});
