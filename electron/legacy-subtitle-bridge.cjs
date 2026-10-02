const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {spawn}=require('child_process');
const activeProcesses=new Set();
function stopLegacyTranslations(){for(const child of activeProcesses)child.kill();}

// Run the original web app's translator and prompt, unchanged, including its SSE,
// Japanese matching, key/model fallback, checkpoints and missing-cue repair.
async function translateLegacy({file,japaneseFile,title,episode,model,keys,cacheDir,fallbackModels,status=()=>{},spawnProcess=spawn}){
  if(!keys.length)throw new Error('Gemini API 키를 먼저 등록해 주세요.');
  if(!japaneseFile)throw new Error('이번 회차의 Jimaku 일본어 원문을 찾지 못했습니다. 기존 번역 방식은 영어 단독 번역으로 전환하지 않습니다.');
  const assets=path.join(__dirname,'legacy-subtitles');
  const script=fs.readFileSync(path.join(assets,'translate_subtitles_gemini.py'),'utf8');
  const prompt=fs.readFileSync(path.join(assets,'subtitle_translation_prompt.txt'),'utf8');
  const source=fs.readFileSync(file),japanese=fs.readFileSync(japaneseFile);
  const hash=crypto.createHash('sha256').update(JSON.stringify([script,prompt,title,episode,model])).update(source).update(japanese).digest('hex').slice(0,24);
  fs.mkdirSync(cacheDir,{recursive:true});
  const target=path.join(cacheDir,`legacy-${hash}.vtt`);
  if(fs.existsSync(target))return {path:target,model,failed:0,cached:true,reference:'jimaku',pipeline:'legacy'};
  // Electron can read ASAR assets; Python cannot. Materialize only these bundled assets.
  const runtime=path.join(cacheDir,'legacy-runtime');fs.mkdirSync(runtime,{recursive:true});
  const program=path.join(runtime,'translate_subtitles_gemini.py');
  fs.writeFileSync(program,script,'utf8');fs.writeFileSync(path.join(runtime,'subtitle_translation_prompt.txt'),prompt,'utf8');
  status('이전 번역 방식으로 전체 회차를 번역하고 있어요');
  const redact=text=>keys.reduce((value,key)=>value.split(key).join('[API 키]'),String(text));
  const output=await new Promise((resolve,reject)=>{
    const child=spawnProcess(process.env.LILAC_PYTHON||'python3',[program,'--japanese',japaneseFile],{
      env:{...process.env,...(fallbackModels===undefined?{}:{GEMINI_FALLBACK_MODELS:fallbackModels}),GEMINI_API_KEY:keys[0],GEMINI_API_KEYS:keys.join(','),GEMINI_MODEL:model,LILAC_ANIME_TITLE:title,LILAC_EPISODE_NUMBER:String(episode),LILAC_JAPANESE_SOURCE:path.basename(japaneseFile),LILAC_TRANSLATION_DRAFT_PATH:path.join(cacheDir,`legacy-${hash}.draft.json`),PYTHONUNBUFFERED:'1',PYTHONIOENCODING:'utf-8'},
      stdio:['pipe','pipe','pipe'],windowsHide:true
    });
    activeProcesses.add(child);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    let stdout='',stderr='',pending='';
    child.on('error',error=>{activeProcesses.delete(child);reject(new Error(error.code==='ENOENT'?'기존 번역기를 실행하려면 Python 3가 필요합니다.':redact(error.message)));});
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
    child.stderr.on('data',chunk=>{
      const text=chunk.toString();stderr=(stderr+text).slice(-12000);pending+=text;
      const lines=pending.split('\n');pending=lines.pop();
      for(const line of lines){const parts=line.split('\t');if(parts[0]==='LILAC_PROGRESS')status(`${parts[1]}/${parts[2]} ${redact(parts.slice(3).join('\t'))}`);}
    });
    child.stdin.on('error',()=>{});child.stdin.end(source);
    child.on('close',code=>{
      activeProcesses.delete(child);
      if(code!==0)return reject(new Error(redact(stderr.trim().split('\n').filter(line=>!line.startsWith('LILAC_PROGRESS')).slice(-2).join('\n'))||`번역기 종료 코드: ${code}`));
      if(!/^WEBVTT\b/.test(stdout)||!stdout.includes('-->'))return reject(new Error('이전 번역기가 완성된 자막을 반환하지 않았습니다.'));
      resolve(stdout);
    });
  });
  const temporary=path.join(cacheDir,`legacy-${hash}-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary,output,'utf8');fs.renameSync(temporary,target);
  return {path:target,model,failed:0,cached:false,reference:'jimaku',pipeline:'legacy'};
}
module.exports={translateLegacy,stopLegacyTranslations};
