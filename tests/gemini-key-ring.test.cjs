const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GeminiKeyRing, normalizeKeys } = require('../electron/gemini-key-ring.cjs');
const { createTranslator } = require('../electron/subtitle-translator.cjs');
const failure = (status, message = 'failure', details = []) => Object.assign(new Error(message), {status, details});

test('deduplicates keys and rotates the start of successive requests', async () => {
  assert.deepEqual(normalizeKeys(['first,second', 'first\nthird', '']), ['first', 'second', 'third']);
  const used = [];
  for (let start = 0; start < 4; start++) await new GeminiKeyRing(['first', 'second', 'third'], {start}).call(async key => used.push(key));
  assert.deepEqual(used, ['first', 'second', 'third', 'first']);
});

test('invalid/auth/limit keys fall through, never exposing keys in progress', async () => {
  const statuses = [], calls = [];
  const ring = new GeminiKeyRing(['invalid-secret', 'auth-secret', 'limited-secret', 'working-secret'], {status: text => statuses.push(text)});
  const send = async key => { calls.push(key); if (key.startsWith('invalid')) throw failure(400, 'API_KEY_INVALID'); if (key.startsWith('auth')) throw failure(403); if (key.startsWith('limited')) throw failure(429); return 'translated'; };
  assert.equal(await ring.call(send), 'translated');
  assert.equal(await ring.call(send), 'translated');
  assert.deepEqual(calls, ['invalid-secret', 'auth-secret', 'limited-secret', 'working-secret', 'working-secret']);
  assert.ok(statuses.every(text => !text.includes('-secret')));
});

test('daily quota tries the remaining keys; overload and schema errors do not rotate', async () => {
  const calls = [];
  const ring = new GeminiKeyRing(['first', 'second']);
  assert.equal(await ring.call(async key => { calls.push(key); if (key === 'first') throw failure(429, 'daily', [{violations:[{quotaId:'RequestsPerDay'}]}]); return 'ok'; }), 'ok');
  assert.deepEqual(calls, ['first', 'second']);
  for (const error of [failure(503), failure(400, 'Invalid responseSchema')]) {
    let count = 0;
    await assert.rejects(new GeminiKeyRing(['first', 'second']).call(async () => { count++; throw error; }), e => e === error);
    assert.equal(count, 1);
  }
  await assert.rejects(new GeminiKeyRing(['first', 'second']).call(async () => { throw failure(429); }), e => e.status === 429 && /retryDelay/.test(JSON.stringify(e.details)));
});

test('translator integration: old settings, failover, cache, subsequent keys, and saving during 429', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-key-test-'));
  const originalFetch = global.fetch, used = [], statuses = [];
  let listLimited = false;
  const settingsFile = path.join(root, 'gemini.json');
  fs.writeFileSync(settingsFile, JSON.stringify({key:'old-key', model:'gemini-2.5-flash', models:['gemini-2.5-flash']}));
  global.fetch = async (url, options) => {
    const key = options.headers['x-goog-api-key'];
    if (!options.body) return new Response(JSON.stringify(listLimited ? {error:{message:'quota'}} : {models:[{name:'models/gemini-2.5-flash',supportedGenerationMethods:['generateContent']}]}), {status:listLimited?429:200});
    used.push(key);
    if (key === 'bad-key') return new Response(JSON.stringify({error:{message:'API key bad-key not valid'}}), {status:400});
    const input = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(input.map(item=>({i:item.i,t:'번역 결과'})))}]}}]}));
  };
  try {
    const translator = createTranslator(root);
    assert.deepEqual(translator.settings().keys, ['old-key']);
    await translator.saveSettings({keys:['bad-key','working-key','working-key']});
    assert.deepEqual(translator.settings().keys, ['bad-key','working-key']);
    const source = path.join(root, 'source.vtt');
    fs.writeFileSync(source, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOriginal line\n');
    const result = await translator.translate({file:source,provider:'gemini',status:text=>statuses.push(text)});
    assert.deepEqual(used, ['bad-key','working-key']);
    assert.match(fs.readFileSync(result.path,'utf8'), /번역 결과/);
    assert.ok(!statuses.join(' ').includes('bad-key'));
    await translator.saveSettings({keys:['new-first','new-second']});
    const cached = await translator.translate({file:source,provider:'gemini'});
    assert.equal(cached.cached, true); assert.equal(used.length, 2);
    fs.writeFileSync(source, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAnother line\n');
    await translator.translate({file:source,provider:'gemini'});
    assert.equal(used.at(-1), 'new-second');
    listLimited = true;
    const saved = await translator.saveSettings({keys:['later-key','extra-key']});
    assert.deepEqual(saved.keys,['later-key','extra-key']); assert.match(saved.keyWarning,/저장/);
  } finally { global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true}); }
});

test('optional env keys are reread without editing the file; saved empty keys disable them', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-env-key-test-'));
  const envFile=path.join(root,'.env'), previous=process.env.LILAC_ENV_FILE;
  process.env.LILAC_ENV_FILE=envFile;
  try {
    fs.writeFileSync(envFile,'GEMINI_API_KEY=fake-first\nGEMINI_API_KEYS="fake-second,fake-first"\n');
    const translator=createTranslator(root);
    assert.ok(translator.settings().keys.includes('fake-second'));
    fs.appendFileSync(envFile,'GEMINI_API_KEY_3=fake-third\n');
    assert.ok(translator.settings().keys.includes('fake-third'));
    fs.writeFileSync(path.join(root,'gemini.json'),JSON.stringify({key:'',keys:[]}));
    assert.deepEqual(translator.settings().keys,[]);
  } finally { if(previous===undefined)delete process.env.LILAC_ENV_FILE;else process.env.LILAC_ENV_FILE=previous;fs.rmSync(root,{recursive:true,force:true}); }
});

test('refresh populates an empty model list and manual/automatic choices persist across concurrent saves', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-model-test-'));
  const originalFetch=global.fetch;
  fs.writeFileSync(path.join(root,'gemini.json'),JSON.stringify({key:'fake-key',keys:['fake-key'],models:[]}));
  let calls=0;
  global.fetch=async()=>{
    calls++;
    await new Promise(resolve=>setTimeout(resolve,5));
    return new Response(JSON.stringify({models:[{name:'models/gemini-2.5-flash',supportedGenerationMethods:['generateContent']}]}));
  };
  try{
    const translator=createTranslator(root);
    const [loaded,chosen]=await Promise.all([translator.saveSettings({refreshModels:true}),translator.saveSettings({model:'models/gemini-custom-preview'})]);
    assert.deepEqual(loaded.models,['gemini-2.5-flash']);assert.equal(loaded.model,'gemini-2.5-flash');
    assert.equal(chosen.model,'gemini-custom-preview');assert.equal(translator.settings().model,'gemini-custom-preview');
    await translator.saveSettings({model:''});assert.equal(translator.settings().model,'');
    await translator.saveSettings({refreshModels:true});assert.equal(calls,2);
    await assert.rejects(translator.saveSettings({model:'not a model id'}),/모델 ID/);
    assert.equal((await translator.saveSettings({model:'gemini-2.5-flash'})).model,'gemini-2.5-flash');
  }finally{global.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});}
});
