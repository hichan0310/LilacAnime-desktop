// Port of the original web app's JimakuSubtitleService: authenticated API search,
// episode-filtered files and release selection against the actual English timeline.
const API='https://jimaku.cc/api',MAX_SIZE=2000000;
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function similarity(a,b){a=normalize(a);b=normalize(b);if(!a||!b)return 0;if(a===b)return 100;if(a.includes(b)||b.includes(a))return 75;const x=new Set(a.split(' ')),y=new Set(b.split(' '));return [...x].filter(word=>y.has(word)).length/new Set([...x,...y]).size*60;}
function decodeSubtitle(bytes){
  const data=Buffer.from(bytes);if(data[0]===255&&data[1]===254)return new TextDecoder('utf-16le').decode(data);if(data[0]===254&&data[1]===255)return new TextDecoder('utf-16be').decode(data);
  try{return new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{return new TextDecoder('shift_jis').decode(data);}
}
function seconds(raw){const parts=raw.trim().replace(',','.').split(':').map(Number);return parts.length===3?parts[0]*3600+parts[1]*60+parts[2]:parts[0]*60+parts[1];}
function timeline(bytes){
  const source=decodeSubtitle(bytes),times=[];
  for(const match of source.matchAll(/^\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{2,3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{2,3})/gm))times.push([seconds(match[1]),seconds(match[2])]);
  for(const match of source.matchAll(/^Dialogue:[^,]*,([^,]+),([^,]+),/gm))times.push([seconds(match[1]),seconds(match[2])]);
  const valid=times.filter(([start,end])=>Number.isFinite(start)&&Number.isFinite(end)&&end>=start);
  if(!valid.length)return null;const first=Math.min(...valid.map(row=>row[0])),last=Math.max(...valid.map(row=>row[1]));return {cues:valid.length,first,last,duration:last-first};
}
function timelineScore(reference,candidate){if(!candidate)return -150;if(!reference)return Math.min(20,Math.log(Math.max(1,candidate.cues))*3);return 130-Math.min(180,Math.abs(reference.duration-candidate.duration))*1.4-Math.abs(Math.log(Math.max(.01,candidate.cues/Math.max(1,reference.cues))))*18;}
function candidate(file,episode){
  const name=String(file?.name||'').trim(),url=String(file?.url||''),size=Number(file?.size)||0,ext=name.split('.').pop().toLowerCase();
  if(!['ass','ssa','srt','vtt'].includes(ext)||size<1||size>MAX_SIZE||!/^https:\/\/jimaku\.cc\/entry\/\d+\/download\//.test(url))return null;
  const lower=name.toLowerCase();let score=ext==='vtt'?28:ext==='srt'?26:ext==='ass'?21:18;
  if(new RegExp(`(?:^|[^0-9])(?:e(?:p(?:isode)?)?[ ._-]*)?0*${Number(episode)}(?:v\\d+)?(?:[^0-9]|$)`).test(lower))score+=45;
  if(['.ja.','.jpn.','[ja]','[jpn]','japanese','日本語'].some(word=>lower.includes(word)))score+=12;
  if(['sign','song','forced','commentary','creditless'].some(word=>lower.includes(word)))score-=80;
  if(lower.includes('[cc]')||lower.includes('dialog'))score+=3;
  if(['webrip','web-dl','netflix','crunchyroll'].some(word=>lower.includes(word)))score+=4;
  return {...file,name,url,size,score};
}
function createJimakuApi({apiKey,fetchImpl=(...args)=>fetch(...args)}){
  async function request(url){
    const key=apiKey();if(!key)throw new Error('기존 .env에 JIMAKU_API_KEY가 없습니다.');
    const response=await fetchImpl(url,{headers:{Authorization:key,Accept:'application/json, text/plain, */*','User-Agent':'LilacAnime/1.0'},signal:AbortSignal.timeout(35000)});
    if(!response.ok)throw new Error(`Jimaku HTTP ${response.status}${[401,403].includes(response.status)?' · JIMAKU_API_KEY 인증을 확인해 주세요.':''}`);
    return response;
  }
  async function entryFor(anime){
    const titles=[...new Set([anime.title,anime.title_english,anime.title_japanese].filter(Boolean))],id=Number(anime.anilistId)||0;
    if(id){const entries=await(await request(`${API}/entries/search?anilist_id=${id}`)).json();const exact=Array.isArray(entries)?entries.find(entry=>Number(entry.anilist_id)===id):null;if(exact)return exact;}
    for(const title of titles){
      const entries=await(await request(`${API}/entries/search?query=${encodeURIComponent(title)}`)).json();if(!Array.isArray(entries))throw new Error('Jimaku 작품 검색 응답 형식이 올바르지 않습니다.');
      const ranked=entries.map(entry=>({entry,match:Math.max(...[entry.name,entry.english_name,entry.japanese_name].map(value=>similarity(title,value)))})).filter(item=>item.match>=35).sort((a,b)=>(b.match+(b.entry.flags?.unverified?-30:20))-(a.match+(a.entry.flags?.unverified?-30:20)));
      if(ranked[0])return ranked[0].entry;
    }
    throw new Error(`Jimaku API에서 작품을 찾지 못했습니다: ${titles[0]||'작품명 없음'}`);
  }
  async function files(anime,episode){
    const entry=await entryFor(anime),response=await(await request(`${API}/entries/${Number(entry.id)}/files?episode=${Number(episode)}`)).json();
    if(!Array.isArray(response))throw new Error('Jimaku 회차 파일 응답 형식이 올바르지 않습니다.');
    const list=response.map(file=>candidate(file,episode)).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,8).map(file=>({...file,entry:String(entry.id),anilistId:entry.anilist_id}));
    if(!list.length)throw new Error(`Jimaku에 ${entry.name} ${episode}화의 자막 파일이 없습니다.`);return list;
  }
  async function download(file){const response=await request(file.url);if(Number(response.headers.get('content-length'))>MAX_SIZE)throw new Error('Jimaku 자막 파일이 너무 큽니다.');const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length||bytes.length>MAX_SIZE)throw new Error('Jimaku 자막 파일 크기가 올바르지 않습니다.');return bytes;}
  async function find(anime,episode,referenceBytes){
    const list=await files(anime,episode),reference=timeline(referenceBytes),downloaded=[];let failure;
    for(const file of list){try{const bytes=await download(file),stats=timeline(bytes);if(stats&&/[\u3040-\u30ff]/.test(decodeSubtitle(bytes)))downloaded.push({...file,bytes,selectionScore:file.score+timelineScore(reference,stats)});}catch(error){failure=error;}}
    downloaded.sort((a,b)=>b.selectionScore-a.selectionScore);
    if(!downloaded[0])throw failure||new Error('Jimaku 후보 파일에서 일본어 대사를 읽지 못했습니다.');
    return {...downloaded[0],compared:downloaded.length};
  }
  return {files,download,find};
}
module.exports={createJimakuApi,timeline,timelineScore,candidate};
