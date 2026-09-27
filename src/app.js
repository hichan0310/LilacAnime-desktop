const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const SPEED_OPTIONS=[.1,.25,.5,.75,1,1.25,1.5,1.75,2];
const store = {
  get(key, fallback = []) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};
const state = { season: [], top: [], library: store.get('library'), history: store.get('history'), downloads:[], source: localStorage.getItem('contentSource') || 'linkkf', catalogOffset:36, catalogTotal:null, catalogLoading:false, catalogDone:false };
let hlsPlayer = null;
let skipSegments = [];
let activeSkip = null;
let activeSkipKey = null;
let opEdAnalysisKey = null;
let currentSubtitlePath = null;
let viewBeforePlayer = 'home';
let controlsTimer = null;
let playerWindowFullscreen = false;
let currentHistoryKey = null;
let currentPlaybackContext = {};
let playbackRequestId = 0;
let pendingResumeProgress = 0;

function titleOf(a) { return a.title_english || a.title || a.title_japanese || '제목 없음'; }
function nearbyEpisodes(episodes,current){
  const others=(episodes||[]).filter(ep=>ep.url!==current.url);
  const training=[1,2,3,4,5].map(number=>others.find(ep=>Number(ep.number)===number)).filter(Boolean);
  const fallback=others.slice().sort((a,b)=>Math.abs((a.number||0)-(current.number||0))-Math.abs((b.number||0)-(current.number||0)));
  return [...new Map([...training,...fallback].map(ep=>[ep.url,ep])).values()].slice(0,5);
}
function nextEpisodeOf(episodes,current){const list=episodes||[],index=list.findIndex(ep=>(current?.url&&ep.url===current.url)||(current?.id&&String(ep.id)===String(current.id))||(Number.isFinite(Number(current?.number))&&Number(ep.number)===Number(current.number))||(!current?.url&&!current?.id&&String(ep.name)===String(current?.name)));return index>=0?list[index+1]||null:null}
function imageOf(a) { return a.images?.webp?.large_image_url || a.images?.jpg?.large_image_url || ''; }
async function displayImage(url){if(!url)return '';try{return await window.lilac.coverData(url)}catch{return url}}
async function setBackgroundImage(element,url){if(!element||!url)return;const resolved=await displayImage(url);if(element.isConnected)element.style.backgroundImage=`url(${JSON.stringify(resolved)})`}
async function setImageSource(element,url){if(!element||!url)return;const resolved=await displayImage(url);if(element.isConnected)element.src=resolved}
function normalize(a) { return { provider:a.provider,id:a.id,mal_id:a.mal_id,title:a.title,title_english:a.title_english,title_japanese:a.title_japanese,images:a.images,score:a.score,year:a.year,type:a.type,episodes:a.episodes,status:a.status,synopsis:a.synopsis,genres:a.genres,studios:a.studios,trailer:a.trailer,url:a.url,canWatch:a.canWatch,subbed:a.subbed,dubbed:a.dubbed }; }
function saved(id) { return state.library.some(x => x.mal_id === id); }
function heartIcon(){return '<svg class="library-heart-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 9c0 5-8.5 10-8.5 10S3.5 14 3.5 9A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8.5 2Z"/></svg>'}
function downloadIcon(type='download'){const paths={download:'<path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14"/>',offline:'<path d="M12 4v9m0 0 3.5-3.5M12 13 8.5 9.5M6.5 19h11a3.5 3.5 0 0 0 .4-7A6 6 0 0 0 6.4 10.5 4.25 4.25 0 0 0 6.5 19Z"/>',close:'<path d="m7 7 10 10M17 7 7 17"/>',delete:'<path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/>',play:'<path d="m8 5 11 7-11 7Z"/>',retry:'<path d="M5 8V4m0 4h4M6 7a7 7 0 1 1-1 8"/>'};return `<svg class="download-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[type]||paths.download}</svg>`}
function updateLibraryButton(button,isSaved,withLabel=true){if(!button)return;button.classList.toggle('saved',isSaved);button.innerHTML=`${heartIcon()}${withLabel?'<span>내 목록</span>':''}`;button.setAttribute('aria-label',isSaved?'내 목록에서 삭제':'내 목록에 추가')}
function animeById(id) { return [...state.season,...state.top,...state.library].find(x=>String(x.mal_id)===String(id)); }
function toast(message) { const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),2200); }

function switchView(name) {
  const current=$('.view.active')?.id?.replace(/View$/,'');
  if(name==='player'&&current&&current!=='player')viewBeforePlayer=current;
  document.body.classList.toggle('player-mode',name==='player');
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `${name}View`));
  $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  if (name === 'library') renderLibrary();
  if (name === 'all') loadFullCatalog();
  if (name === 'history') renderHistory();
  if(name!=='player')document.querySelector('main').scrollTo({top:0,behavior:'smooth'});
}

function card(a) {
  const el=document.createElement('article'); el.className='anime-card'; el.dataset.id=a.mal_id;
  el.innerHTML=`<div class="poster"><button class="heart ${saved(a.mal_id)?'saved':''}" title="내 목록">${heartIcon()}</button>${a.score?`<span class="score">★ ${a.score}</span>`:''}</div><h3>${escapeHtml(titleOf(a))}</h3><p>${[a.year,a.type,a.episodes?`${a.episodes}화`:null].filter(Boolean).join(' · ')}</p>`;
  setBackgroundImage(el.querySelector('.poster'),imageOf(a));
  el.querySelector('.poster').addEventListener('click', e => { if(!e.target.closest('.heart')) openDetail(a.mal_id); });
  el.querySelector('.heart').addEventListener('click', e => { e.stopPropagation(); toggleLibrary(a, e.currentTarget); });
  return el;
}

function renderCards(target, items) { const el=$(target); el.classList.remove('loading-cards'); el.replaceChildren(...items.map(card)); }
function toggleLibrary(a, button) {
  if(saved(a.mal_id)){state.library=state.library.filter(x=>x.mal_id!==a.mal_id);updateLibraryButton(button,false,!button?.classList.contains('heart'));toast('내 목록에서 삭제했어요.');}
  else{state.library.unshift(normalize(a));updateLibraryButton(button,true,!button?.classList.contains('heart'));toast('내 목록에 추가했어요.');}
  store.set('library',state.library); renderLibrary();
}
function downloadStatusText(job){return job.status==='completed'?'다운로드 완료':job.status==='downloading'?`${job.progress||0}% 다운로드 중`:job.status==='resolving'?'영상 주소 확인 중':job.status==='queued'?'대기 중':job.status==='paused'?'일시 중지':job.status==='failed'?`실패 · ${job.error||'다시 시도해 주세요'}`:job.status}
function renderDownloads(){const list=$('#downloadList'),completed=state.downloads.filter(x=>x.status==='completed').length;$('#downloadCount').textContent=String(completed);list.replaceChildren(...state.downloads.map(job=>{const el=document.createElement('article');el.className='download-card';el.innerHTML=`<div class="download-cover"${job.image?` style="background-image:url('${job.image}')"`:''}></div><div class="download-copy"><b>${escapeHtml(job.title)}</b><span>${escapeHtml(String(job.episodeNumber))}화 · ${escapeHtml(downloadStatusText(job))}</span><div class="download-progress"><i style="width:${job.status==='completed'?100:job.progress||0}%"></i></div></div><div class="download-actions">${job.status==='completed'?`<button data-action="play">${downloadIcon('play')}<span>재생</span></button>`:job.status==='paused'||job.status==='failed'?`<button data-action="resume">${downloadIcon('retry')}<span>다시 시작</span></button>`:`<button data-action="cancel">${downloadIcon('close')}<span>중지</span></button>`}<button class="danger" data-action="remove">${downloadIcon('delete')}<span>삭제</span></button></div>`;el.querySelector('[data-action="play"]')?.addEventListener('click',async()=>{try{const local=await window.lilac.playDownload(job.id),seriesEpisodes=downloadedSeries(job);play(local.url,`${job.title} · ${job.episodeNumber}화`,{episode:job.episode,subtitleTitle:job.title,image:job.image,offline:true,anime:job.anime,resolveKind:job.resolveKind,seriesEpisodes});if(local.subtitleUrl)attachSubtitle(local.subtitleUrl,'다운로드 자막')}catch(e){toast(e.message)}});el.querySelector('[data-action="cancel"]')?.addEventListener('click',()=>window.lilac.cancelDownload(job.id));el.querySelector('[data-action="resume"]')?.addEventListener('click',()=>window.lilac.resumeDownload(job.id));el.querySelector('[data-action="remove"]')?.addEventListener('click',()=>window.lilac.removeDownload(job.id));return el;}));$('#emptyDownloads').classList.toggle('hidden',state.downloads.length>0);refreshEpisodeDownloadButtons()}
function renderLibrary(){renderCards('#libraryGrid',state.library);$('#emptyLibrary').classList.toggle('hidden',state.library.length>0);renderDownloads();}
function episodeDownloadJob(anime,episode){return state.downloads.find(job=>job.key===`${anime.mal_id||anime.id}:${episode.provider||'provider'}:${episode.url||episode.token||episode.id||episode.number}`)}
function episodeRef(episode){return encodeURIComponent(String(episode.url||episode.token||episode.id||episode.number||''))}
function jobByRef(ref){return state.downloads.find(job=>episodeRef(job.episode||{})===ref)}
function downloadedSeries(reference){const identity=reference?.anime?.mal_id||reference?.anime?.id||reference?.title;return state.downloads.filter(job=>job.status==='completed'&&(job.anime?.mal_id||job.anime?.id||job.title)===identity).sort((a,b)=>a.episodeNumber-b.episodeNumber).map(job=>job.episode)}
function episodeDownloadMarkup(job){if(job?.status==='completed')return downloadIcon('delete');if(job&&['downloading','resolving','queued'].includes(job.status))return `<span class="download-ring" style="--progress:${job.progress||0}">${downloadIcon('close')}</span>`;if(job&&['paused','failed'].includes(job.status))return downloadIcon('retry');return downloadIcon('download')}
function refreshEpisodeDownloadButtons(){$$('.episode-download').forEach(button=>{const job=jobByRef(button.dataset.downloadRef);button.classList.toggle('active',Boolean(job));button.classList.toggle('completed',job?.status==='completed');button.classList.toggle('downloading',Boolean(job&&['downloading','resolving','queued'].includes(job.status)));button.innerHTML=episodeDownloadMarkup(job);button.title=job?.status==='completed'?'다운로드 삭제':job&&['downloading','resolving','queued'].includes(job.status)?'다운로드 취소':job&&['paused','failed'].includes(job.status)?'다운로드 다시 시작':'다운로드'})}
async function handleEpisodeDownload(anime,episode,resolveKind='provider'){const job=jobByRef(episodeRef(episode));if(job?.status==='completed'){await window.lilac.removeDownload(job.id);toast(`${job.episodeNumber}화 다운로드를 삭제했습니다.`);return}if(job&&['downloading','resolving','queued'].includes(job.status)){await window.lilac.cancelDownload(job.id);toast(`${job.episodeNumber}화 다운로드를 중지했습니다.`);return}if(job&&['paused','failed'].includes(job.status)){await window.lilac.resumeDownload(job.id);toast(`${job.episodeNumber}화 다운로드를 다시 시작합니다.`);return}await queueEpisodeDownload(anime,episode,resolveKind)}
async function queueEpisodeDownload(anime,episode,resolveKind='provider'){const number=Number(episode.number||String(episode.name).match(/\d+/)?.[0]||1);const job=await window.lilac.addDownload({anime:normalize(anime),title:titleOf(anime),image:imageOf(anime),episode,episodeNumber:number,resolveKind});toast(job.status==='completed'?`${number}화는 이미 저장되어 있습니다.`:`${number}화를 다운로드 대기열에 추가했습니다.`)}
function renderAll(){const items=[...new Map([...state.season,...state.top].map(a=>[a.mal_id,a])).values()];renderCards('#allGrid',items);$('#allStatus').textContent=`${items.length}개 작품 · ${state.source==='linkkf'?'Linkkf':state.source==='animenosub'?'Animenosub':state.source==='reanime'?'RE:Anime':'작품 정보'}`;}
async function loadFullCatalog(){renderAll();if(!['reanime','animenosub'].includes(state.source)||state.catalogLoading||state.catalogDone||(state.catalogTotal!==null&&state.catalogOffset>=state.catalogTotal))return;state.catalogLoading=true;const label=state.source==='reanime'?'RE:Anime':'Animenosub';$('#allStatus').textContent=`${label} 목록을 더 불러오는 중... (${state.season.length}${state.catalogTotal?` / ${state.catalogTotal}`:''})`;try{const result=await window.lilac.providerCatalog(state.source,'',state.catalogOffset);const before=state.season.length,merged=new Map([...state.season,...result.data].map(a=>[a.mal_id,a]));state.season=[...merged.values()];state.catalogOffset=state.source==='reanime'?state.catalogOffset+result.data.length:result.nextOffset;state.catalogTotal=result.total||null;state.catalogDone=Boolean(result.done)||result.data.length===0||state.season.length===before;renderAll();$('#allStatus').textContent=state.catalogTotal?`${state.season.length} / ${state.catalogTotal}개 작품 · 아래로 스크롤하면 더 불러옵니다.`:`${state.season.length}개 작품${state.catalogDone?'':' · 아래로 스크롤하면 더 불러옵니다.'}`}catch(e){$('#allStatus').textContent=`목록을 더 불러오지 못했습니다: ${e.message}`}finally{state.catalogLoading=false}}
function historyImage(h){if(h.image)return h.image;if(h.anime){const direct=imageOf(h.anime);if(direct)return direct}const title=h.subtitleTitle||h.name.split(' · ')[0];return imageOf([...state.season,...state.top,...state.library].find(a=>titleOf(a)===title)||{})}
function renderHistory(){const list=$('#historyList');list.replaceChildren(...state.history.map(h=>{const row=document.createElement('article');row.className='history-card';row.tabIndex=0;row.setAttribute('role','button');const image=historyImage(h),episode=h.episode?.number||h.name.match(/(?:·|EP\.?)[^\d]*(\d+)/i)?.[1]||1;row.innerHTML=`<div class="history-thumb"${image?` style="background-image:url('${image}')"`:''}><span class="history-card-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6Z"/></svg></span><div class="history-progress"><i style="width:${Math.max(0,Math.min(100,h.progress||0))}%"></i></div></div><b>${escapeHtml(h.subtitleTitle||h.name.split(' · ')[0])}</b><span>EP.${escapeHtml(String(episode))}</span>`;row.onclick=()=>playHistoryItem(h);row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();playHistoryItem(h)}};return row;}));$('#historyCount').textContent=`${state.history.length}개`;$('#emptyHistory').classList.toggle('hidden',state.history.length>0);list.classList.toggle('hidden',!state.history.length);}
async function playHistoryItem(item){let anime=item.anime||[...state.season,...state.top,...state.library].find(a=>titleOf(a)===(item.subtitleTitle||item.name.split(' · ')[0])),episodes=[],localJob=item.episode?jobByRef(episodeRef(item.episode)):null;if(localJob?.status==='completed'){anime=localJob.anime||anime;episodes=downloadedSeries(localJob)}else try{if(anime?.provider==='linkkf'){const servers=await window.lilac.linkkfEpisodes(anime.id);episodes=servers.find(server=>server.episodes.some(ep=>ep.token===item.episode?.token))?.episodes||servers[0]?.episodes||[]}else if(anime&&['reanime','animenosub'].includes(anime.provider)){const detail=await window.lilac.providerDetail(anime);anime=detail.data;episodes=detail.episodes||[]}}catch{}if(!episodes.length&&item.episode?.provider==='reanime'){const current=Number(item.episode.number)||1,parsed=new URL(item.episode.url),next={...item.episode,name:String(current+1),number:current+1,url:`${parsed.origin}/watch/${parsed.pathname.split('/').filter(Boolean).pop()}?ep=${current+1}`};episodes=[item.episode,next]}const context={episode:item.episode,subtitleTitle:item.subtitleTitle,image:item.image,resumeProgress:item.progress,comparisonEpisodes:nearbyEpisodes(episodes,item.episode),seriesEpisodes:episodes,resolveKind:item.resolveKind||(anime?.provider==='linkkf'?'linkkf':undefined),anime};if(item.episode){await resolveIntoPlayer(()=>context.resolveKind==='linkkf'?window.lilac.linkkfResolve(item.episode):window.lilac.providerResolve(item.episode),item.name,context,item.subtitleTitle||item.name.split(' · ')[0],item.episode.number||1)}else play(item.src,item.name,context)}

async function openDetail(id) {
  const dialog=$('#detailDialog'); $('#detailContent').innerHTML='<div class="empty-state"><p>작품 정보를 불러오는 중...</p></div>'; dialog.showModal();
  try {
    const isLinkkf=String(id).startsWith('linkkf:'); const isExternal=/^(animenosub|reanime):/.test(String(id));
    const providerResult=isExternal?await window.lilac.providerDetail(animeById(id)):null;
    const {data:a}=isLinkkf?await window.lilac.linkkfDetail(String(id).slice(7)):isExternal?providerResult:await window.lilac.detail(id); const isSaved=saved(a.mal_id);
    $('#detailContent').innerHTML=`<div class="detail-hero"></div><div class="detail-body"><img alt=""><div class="detail-info"><span class="eyebrow">${escapeHtml(a.type||'ANIME')} · ${a.score?`★ ${a.score}`:isLinkkf?'LINKKF':'평점 없음'}</span><h1>${escapeHtml(titleOf(a))}</h1><div class="tags">${(a.genres||[]).slice(0,5).map(g=>`<span>${escapeHtml(g.name)}</span>`).join('')}</div><p>${escapeHtml(a.synopsis||'등록된 줄거리가 없습니다.')}</p><div class="detail-actions"><button class="primary detail-play" ${providerResult?.unavailable?'disabled':''}>${providerResult?.unavailable?'현재 재생 불가':isLinkkf?'회차 불러오기':'▶ 플레이어 열기'}</button><button class="ghost detail-save library-toggle ${isSaved?'saved':''}">${heartIcon()}<span>내 목록</span></button>${a.url?'<button class="ghost detail-web">작품 정보 ↗</button>':''}</div><div id="episodeBlock" class="episode-block">${providerResult?.unavailable?'<p class="episode-loading">현재 제공처에 영상이 없는 작품입니다. 설정에서 다른 콘텐츠 소스를 선택해 주세요.</p>':''}</div></div></div>`;
    setBackgroundImage($('#detailContent .detail-hero'),imageOf(a));setImageSource($('#detailContent .detail-body img'),imageOf(a));
    if(isExternal&&providerResult.episodes?.length){const block=$('#episodeBlock');block.innerHTML=`<div class="episode-block-head"><h3>${a.provider==='animenosub'?'자막 / 더빙 회차':'회차'}</h3><button class="batch-download">${downloadIcon('offline')}<span>전체 저장</span></button></div><div class="episode-list">${providerResult.episodes.map((ep,index)=>`<div class="episode-row"><button class="episode-btn" data-index="${index}">${escapeHtml(ep.name)}화${ep.dub?' · 더빙':''}</button><button class="episode-download" data-download-index="${index}" data-download-ref="${episodeRef(ep)}" title="다운로드">${episodeDownloadMarkup(episodeDownloadJob(a,ep))}</button></div>`).join('')}</div>`;block.querySelectorAll('.episode-btn').forEach(button=>button.onclick=async()=>{const ep=providerResult.episodes[Number(button.dataset.index)];dialog.close();await resolveIntoPlayer(()=>window.lilac.providerResolve(ep),`${titleOf(a)} · ${ep.name}화`,{episode:ep,subtitleTitle:titleOf(a),image:imageOf(a),comparisonEpisodes:nearbyEpisodes(providerResult.episodes,ep),seriesEpisodes:providerResult.episodes,anime:normalize(a)},titleOf(a),ep.number||1);});block.querySelectorAll('[data-download-index]').forEach(button=>button.onclick=()=>handleEpisodeDownload(a,providerResult.episodes[Number(button.dataset.downloadIndex)]));block.querySelector('.batch-download').onclick=async()=>{for(const ep of providerResult.episodes)if(!episodeDownloadJob(a,ep))await queueEpisodeDownload(a,ep);toast(`${providerResult.episodes.length}개 회차를 순서대로 저장합니다.`)};refreshEpisodeDownloadButtons()}
    $('.detail-play').onclick=async()=>{
      if(isExternal){if(providerResult.episodes?.[0]){const ep=providerResult.episodes[0];dialog.close();await resolveIntoPlayer(()=>window.lilac.providerResolve(ep),titleOf(a),{episode:ep,subtitleTitle:titleOf(a),image:imageOf(a),comparisonEpisodes:nearbyEpisodes(providerResult.episodes,ep),seriesEpisodes:providerResult.episodes,anime:normalize(a)},titleOf(a),ep.number||1)}else toast(providerResult.unavailable?'현재 제공처에 영상이 없는 작품입니다.':'회차 목록을 불러오지 못했습니다. 작품 정보 버튼으로 제공처 상태를 확인해 주세요.');return;}
      if(!isLinkkf){dialog.close();$('#playerTitle').textContent=titleOf(a);switchView('player');return;}
      const block=$('#episodeBlock');block.innerHTML='<p class="episode-loading">Linkkf 회차 서버에 연결하는 중...</p>';
      try {
        const servers=await window.lilac.linkkfEpisodes(a.id);
        block.innerHTML=servers.length
          ? servers.map(server=>`<div class="episode-block-head"><h3>${escapeHtml(server.name)}</h3><button class="batch-download" data-batch-server="${server.id}">${downloadIcon('offline')}<span>전체 저장</span></button></div><div class="episode-list">${server.episodes.map((ep,index)=>`<div class="episode-row"><button class="episode-btn" data-server="${server.id}" data-index="${index}">${escapeHtml(ep.name)}화</button><button class="episode-download" data-download-server="${server.id}" data-download-index="${index}" data-download-ref="${episodeRef(ep)}" title="다운로드">${episodeDownloadMarkup(jobByRef(episodeRef(ep)))}</button></div>`).join('')}</div>`).join('')
          : '<p class="episode-loading">등록된 회차가 없습니다.</p>';
        block.querySelectorAll('.episode-btn').forEach(button=>{
          button.onclick=async()=>{
            const server=servers.find(x=>String(x.id)===button.dataset.server);
            const ep=server.episodes[Number(button.dataset.index)];
            const episodeNumber=Number(String(ep.name).match(/\d+/)?.[0]||1);
            dialog.close();
            await resolveIntoPlayer(()=>window.lilac.linkkfResolve(ep),`${titleOf(a)} · ${ep.name}화`,{episode:ep,subtitleTitle:titleOf(a),image:imageOf(a),seriesEpisodes:server.episodes,resolveKind:'linkkf',anime:normalize(a)},titleOf(a),episodeNumber);
          };
        });
        block.querySelectorAll('[data-download-server]').forEach(button=>button.onclick=()=>{const server=servers.find(x=>String(x.id)===button.dataset.downloadServer);handleEpisodeDownload(a,server.episodes[Number(button.dataset.downloadIndex)],'linkkf')});
        block.querySelectorAll('[data-batch-server]').forEach(button=>button.onclick=async()=>{const server=servers.find(x=>String(x.id)===button.dataset.batchServer);for(const ep of server.episodes)await queueEpisodeDownload(a,ep,'linkkf');toast(`${server.episodes.length}개 회차를 순서대로 저장합니다.`)});
        refreshEpisodeDownloadButtons();
      } catch(e) {
        block.innerHTML=`<p class="episode-loading">${escapeHtml(e.message)}</p>`;
      }
    };
    $('.detail-save').onclick=e=>toggleLibrary(a,e.currentTarget);
    $('.detail-web')?.addEventListener('click',()=>window.lilac.openExternal(a.url));
  } catch(e){$('#detailContent').innerHTML=`<div class="empty-state"><h3>정보를 불러오지 못했어요</h3><p>${escapeHtml(e.message)}</p></div>`;}
}

async function doSearch(query) {
  query=query.trim(); if(!query)return; switchView('search'); $('#pageSearch').value=query; $('#searchStatus').textContent='검색 중...'; $('#searchGrid').replaceChildren();
  try{const result=['animenosub','reanime'].includes(state.source)?await window.lilac.providerCatalog(state.source,query):await window.lilac.search(query),data=result.data;renderCards('#searchGrid',data);$('#searchStatus').textContent=`“${query}” 검색 결과 ${data.length}${result.total?` / ${result.total}`:''}개`;}
  catch(e){$('#searchStatus').textContent=`검색 실패: ${e.message}`;}
}

function showPendingPlayer(name,context={}){
  const requestId=++playbackRequestId,video=$('#video');
  if(hlsPlayer){hlsPlayer.destroy();hlsPlayer=null;}
  video.pause();video.removeAttribute('src');video.load();
  currentPlaybackContext={...context,resolving:true};skipSegments=[];activeSkip=null;currentHistoryKey=null;
  switchView('player');playerWindowFullscreen=true;window.lilac.setPlayerFullscreen(true);showPlayerControls();
  $('#immersivePlayer').classList.remove('is-playing');$('#playerEmpty').classList.remove('hidden');
  $('#playerEmpty p').textContent='영상 서버에 연결하고 있어요';$('#playerTitle').textContent=name;$('#playerMeta').textContent='재생 준비 중';
  $('#downloadStatus').textContent='영상 주소를 확인하는 중...';$('#subtitleState').textContent='영상 연결 후 자막을 확인합니다.';
  return requestId;
}


async function resolveIntoPlayer(resolver,name,context={},subtitleTitle='',episode=1){
  const requestId=showPendingPlayer(name,context);
  try{
    const downloaded=context.episode?jobByRef(episodeRef(context.episode)):null;
    const stream=downloaded?.status==='completed'?await window.lilac.playDownload(downloaded.id):await resolver();
    if(requestId!==playbackRequestId)return;
    const offlineEpisodes=downloaded?.status==='completed'?downloadedSeries(downloaded):[];
    play(stream.url,name,{...context,seriesEpisodes:offlineEpisodes.length?offlineEpisodes:context.seriesEpisodes,streamHeaders:stream.headers||{},offline:Boolean(downloaded?.status==='completed')});
    if(downloaded?.status==='completed')$('#downloadStatus').textContent='다운로드한 영상 재생 중';
    ensureSubtitle(stream,subtitleTitle||context.subtitleTitle||name.split(' · ')[0],episode);
  }catch(error){
    if(requestId!==playbackRequestId)return;
    const message=error?.message||'영상 서버에 연결하지 못했습니다.';
    $('#playerEmpty').classList.remove('hidden');$('#playerEmpty p').textContent='영상을 불러오지 못했어요';
    $('#playerMeta').textContent='뒤로 가서 다른 회차를 선택해 주세요';$('#downloadStatus').textContent=message;
    toast(`재생 실패: ${message}`);
  }
}

function play(src,name='직접 재생',context={}) {
  ++playbackRequestId;const video=$('#video');currentPlaybackContext={...context,currentUrl:src};skipSegments=[];activeSkip=null;activeSkipKey=null;opEdAnalysisKey=null;if(hlsPlayer){hlsPlayer.destroy();hlsPlayer=null;} video.removeAttribute('src');
  switchView('player');playerWindowFullscreen=true;window.lilac.setPlayerFullscreen(true);showPlayerControls();$('#playerEmpty').classList.remove('hidden');$('#subtitleState').textContent='온라인 자막을 확인하는 중...';
  const isHls=/\.m3u8(?:$|\?)/i.test(src)||/\/__flix\//i.test(src);
  if(isHls&&window.Hls?.isSupported()){
    hlsPlayer=new Hls({
      enableWorker:true,
      lowLatencyMode:false,
      startFragPrefetch:true,
      maxBufferLength:60,
      maxMaxBufferLength:60,
      maxBufferSize:1024*1024*1024,
      backBufferLength:10,
      maxBufferHole:.5,
      highBufferWatchdogPeriod:2,
      manifestLoadingTimeOut:120000,
      levelLoadingTimeOut:120000,
      fragLoadingTimeOut:120000,
      manifestLoadingMaxRetry:6,
      levelLoadingMaxRetry:6,
      fragLoadingMaxRetry:6
    });
    hlsPlayer.loadSource(src);
    hlsPlayer.attachMedia(video);
    $('#downloadStatus').textContent='영상 재생목록을 불러오는 중...';
    hlsPlayer.on(Hls.Events.MANIFEST_PARSED,()=>{scheduleOpEdAnalysis();$('#downloadStatus').textContent='재생하며 60초 앞까지 불러오는 중';video.play().catch(()=>{})});
    hlsPlayer.on(Hls.Events.FRAG_BUFFERED,()=>{if(!video.paused)$('#downloadStatus').textContent='재생 중 · 앞부분 계속 불러오는 중'});
    hlsPlayer.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal){const detail=data.details||data.type||'unknown',status=data.response?.code||data.response?.status||'',reason=data.reason||data.error?.message||'';const message=[detail,status&&`HTTP ${status}`,reason].filter(Boolean).join(' · ');$('#downloadStatus').textContent=`HLS 오류: ${message}`;toast(`HLS 재생 오류: ${message}`)}});
  }else video.src=src;
  $('#streamUrl').value=/^https?:/i.test(src)?src:'';$('#playerTitle').textContent=name;$('#playerMeta').textContent=context.episode?`${context.episode.number||1}화`:'LilacAnime';$('#playerEmpty p').textContent='영상을 준비하고 있어요';$('#skipTitle').value=context.subtitleTitle||((name==='직접 재생')?'':name.split(' · ')[0]);if(context.episode)$('#skipEpisode').value=context.episode.number||1;video.volume=Math.max(0,Math.min(1,Number(localStorage.getItem('playerVolume')??1)));video.muted=localStorage.getItem('playerMuted')==='true';syncVolumeUI();video.playbackRate=Number($('#speed').value);if(!isHls)video.play().catch(()=>{});
  const historyKey=context.episode?`${context.episode.provider}:${context.episode.url}`:src;if(context.episode||!/^http:\/\/127\.0\.0\.1:\d+\/__flix\//i.test(src)){const previous=state.history.find(x=>(x.key||x.src)===historyKey),savedProgress=Number(context.resumeProgress??previous?.progress??0);pendingResumeProgress=savedProgress>0&&savedProgress<99?savedProgress:0;state.history=state.history.filter(x=>(x.key||x.src)!==historyKey);state.history.unshift({key:historyKey,src:context.episode?'':src,name,episode:context.episode||null,subtitleTitle:context.subtitleTitle||name.split(' · ')[0],image:context.image||previous?.image||'',comparisonEpisodes:context.comparisonEpisodes||previous?.comparisonEpisodes||[],anime:context.anime||previous?.anime||null,resolveKind:context.resolveKind||previous?.resolveKind||null,progress:savedProgress,updated:Date.now()});state.history=state.history.slice(0,30);currentHistoryKey=historyKey;store.set('history',state.history);renderContinue();applyPendingResume()}else{currentHistoryKey=null;pendingResumeProgress=0}
}
function renderContinue(){const section=$('#continueSection'),rail=$('#continueRail');section.classList.toggle('hidden',!state.history.length);rail.replaceChildren(...state.history.slice(0,6).map(h=>{const el=document.createElement('article'),image=historyImage(h),episode=h.episode?.number||h.name.match(/(?:·|EP\.?)[^\d]*(\d+)/i)?.[1]||1;el.className='continue-card';el.dataset.historyKey=h.key||h.src;el.innerHTML=`<div class="continue-thumb"${image?` style="background-image:url('${image}')"`:''}><span class="continue-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6Z"/></svg></span><div class="history-progress"><i style="width:${Math.max(0,Math.min(100,h.progress||0))}%"></i></div></div><b>${escapeHtml(h.subtitleTitle||h.name.split(' · ')[0])}</b><span>EP.${escapeHtml(String(episode))} · ${Math.max(0,Math.min(100,h.progress||0))}%</span>`;el.onclick=()=>playHistoryItem(h);return el;}));}
function escapeHtml(v=''){const d=document.createElement('div');d.textContent=v;return d.innerHTML;}
function attachSubtitle(src,label='자막'){const video=$('#video');video.querySelectorAll('track').forEach(x=>x.remove());const track=document.createElement('track');track.kind='subtitles';track.label=label;track.srclang='ko';track.src=src;track.default=true;video.append(track);track.addEventListener('load',()=>{if(track.track)track.track.mode=$('#subtitleEnabled').checked?'showing':'hidden';$('#subtitleState').textContent=`${label} 적용됨`;$('#subtitleToggle').classList.add('active');toast(`${label}을 적용했습니다.`)});track.addEventListener('error',()=>{$('#subtitleState').textContent='자막 파일을 불러오지 못했습니다.'});}
async function ensureSubtitle(stream,title,episode){if(stream?.subtitleUrl){attachSubtitle(stream.subtitleUrl,'제공 자막');return true}const preferred=localStorage.getItem('subtitleSource'),sources=['kairan','csora'].includes(preferred)?[preferred,...['kairan','csora'].filter(x=>x!==preferred)]:['kairan','csora'];$('#subtitleState').textContent='온라인 자막을 찾는 중...';for(const source of sources){try{const result=await window.lilac.findSubtitle(source,title,episode);currentSubtitlePath=result.path;attachSubtitle(result.url,source==='kairan'?'Kairan 자막':'Csora 자막');return true}catch{}}$('#subtitleState').textContent='자동으로 찾은 자막이 없습니다. 내 자막 파일을 열 수 있어요.';return false}
function formatTime(value){if(!Number.isFinite(value))return '00:00';const seconds=Math.max(0,Math.floor(value)),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function syncVolumeUI(){const video=$('#video'),control=$('.volume-control'),slider=$('#playerVolume'),muted=video.muted||video.volume===0;control.classList.toggle('muted',muted);slider.value=String(Math.round(video.volume*100));$('#mutePlayer').setAttribute('aria-label',muted?'음소거 해제':'음소거')}
function playbackDuration(){const video=$('#video');if(Number.isFinite(video.duration)&&video.duration>0)return video.duration;const details=hlsPlayer?.latestLevelDetails||hlsPlayer?.levels?.[hlsPlayer.currentLevel]?.details||hlsPlayer?.levels?.find(level=>level.details)?.details,duration=Number(details?.totalduration);return Number.isFinite(duration)&&duration>0?duration:0}
function applyPendingResume(){if(!pendingResumeProgress)return false;const video=$('#video'),duration=playbackDuration();if(!duration)return false;const target=duration*pendingResumeProgress/100;if(Number.isFinite(target)&&target>0){video.currentTime=Math.min(target,Math.max(0,duration-.5));pendingResumeProgress=0;return true}return false}
function showPlayerControls(){const player=$('#immersivePlayer');player.classList.add('controls-visible');clearTimeout(controlsTimer);if(!$('#video').paused)controlsTimer=setTimeout(()=>{player.classList.remove('controls-visible');$('#subtitleSheet').classList.remove('open')},2800)}
function scheduleOpEdAnalysis(attempt=0){const duration=playbackDuration();if(!duration&&attempt<20){setTimeout(()=>scheduleOpEdAnalysis(attempt+1),500);return}loadOpEdSegments()}
async function loadOpEdSegments(){const title=$('#skipTitle').value.trim(),episode=Number($('#skipEpisode').value)||1,duration=playbackDuration(),analysisKey=`${currentPlaybackContext.currentUrl}:${episode}`;if(!title||!duration||opEdAnalysisKey===analysisKey)return;opEdAnalysisKey=analysisKey;$('#downloadStatus').textContent='OP/ED 구간을 확인하는 중...';try{const candidates=await Promise.all((currentPlaybackContext.comparisonEpisodes||[]).map(async candidate=>{const job=jobByRef(episodeRef(candidate));if(job?.status!=='completed')return candidate;try{const local=await window.lilac.playDownload(job.id);return {...candidate,localUrl:local.url}}catch{return candidate}}));skipSegments=await window.lilac.opEdSkip({title,episode,duration,currentUrl:currentPlaybackContext.currentUrl,currentHeaders:currentPlaybackContext.streamHeaders||{},candidates,anilistId:currentPlaybackContext.episode?.anilistId||null,malId:currentPlaybackContext.episode?.malId||null});$('#downloadStatus').textContent=skipSegments.length?`OP/ED 구간 ${skipSegments.length}개 준비됨`:'OP/ED 구간을 찾지 못했습니다.'}catch(e){skipSegments=[];opEdAnalysisKey=null;$('#downloadStatus').textContent=`OP/ED 분석 실패: ${e.message}`}}
function applyCueStyle(){let style=$('#cueStyle');if(!style){style=document.createElement('style');style.id='cueStyle';document.head.append(style)}const size=Number(localStorage.getItem('subtitleSize')||100);const bold=localStorage.getItem('vttBold')!=='false';style.textContent=`video::cue{font-size:${size}%;font-weight:${bold?'700':'400'};text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000}`;}
function syncSettingChoices(){[['themeChoices','themeSelect'],['sourceChoices','contentSource'],['qualityChoices','defaultQuality'],['subtitleChoices','subtitleSource']].forEach(([group,select])=>$$(`#${group} button`).forEach(button=>button.classList.toggle('selected',button.dataset.value===$(`#${select}`).value)))}
function applyTheme(value){const systemLight=matchMedia('(prefers-color-scheme: light)').matches,wantsLight=value==='light'||(value==='system'&&systemLight);document.body.classList.toggle('light',wantsLight);$('#themeButton').textContent=wantsLight?'☀':'☾'}

async function init(){
  // Never restore a stale playback request on a fresh app launch.
  playbackRequestId++;playerWindowFullscreen=false;
  if(state.source==='ohli24'){state.source='linkkf';localStorage.setItem('contentSource','linkkf');}
  state.downloads=await window.lilac.downloads();renderDownloads();
  state.history=state.history.filter(item=>!/^http:\/\/127\.0\.0\.1:\d+\/__flix\//i.test(item.src||''));store.set('history',state.history);
  renderContinue(); renderLibrary();
  $('#contentSource').value=state.source;$('#themeSelect').value=localStorage.getItem('theme')||'dark';const savedSpeed=Number(localStorage.getItem('defaultSpeed')||1),speedIndex=Math.max(0,SPEED_OPTIONS.indexOf(savedSpeed));$('#defaultSpeed').value=String(speedIndex);$('#speed').value=String(savedSpeed);$('#speedLabel').textContent=`${savedSpeed.toFixed(2)}x`;$('#defaultQuality').value=localStorage.getItem('defaultQuality')||'1080p';$('#subtitleSource').value=localStorage.getItem('subtitleSource')||'linkkf';$('#subtitleSize').value=localStorage.getItem('subtitleSize')||'100';$('#subtitleSync').value=localStorage.getItem('subtitleSync')||'0';$('#vttBold').checked=localStorage.getItem('vttBold')!=='false';$('#vttOutline').value=localStorage.getItem('vttOutline')||'2';$('#subtitlePosition').value=localStorage.getItem('subtitlePosition')||'10';$('#seekSeconds').value=localStorage.getItem('seekSeconds')||'10';$('#subtitleSizeLabel').textContent=`${$('#subtitleSize').value}%`;$('#subtitleSyncLabel').textContent=`${$('#subtitleSync').value} ms`;$('#outlineLabel').textContent=Number($('#vttOutline').value).toFixed(1);$('#positionLabel').textContent=`${$('#subtitlePosition').value}%`;syncSettingChoices();
  try {
    let season,top;
    if(state.source==='linkkf'){
      try{const linkkf=await window.lilac.linkkfHome(1,20);season=linkkf;top={data:linkkf.data.slice().reverse()};}
      catch(error){toast('Linkkf 서버가 응답하지 않아 작품 정보 모드로 표시합니다.');[season,top]=await Promise.all([window.lilac.season(),window.lilac.top()]);}
    }else if(['animenosub','reanime'].includes(state.source)){
      try{season=await window.lilac.providerCatalog(state.source);top={data:season.data.slice().reverse()};}
      catch(error){toast(`${state.source} 서버가 응답하지 않아 작품 정보 모드로 표시합니다.`);[season,top]=await Promise.all([window.lilac.season(),window.lilac.top()]);}
    }else [season,top]=await Promise.all([window.lilac.season(),window.lilac.top()]);
    state.season=season.data;state.top=top.data;if(state.source==='reanime'){state.catalogOffset=season.data.length;state.catalogTotal=season.total||null}else if(state.source==='animenosub'){state.catalogOffset=season.nextOffset||2}renderCards('#seasonRail',state.season.slice(0,10));renderCards('#topRail',state.top.slice(0,10));
    const a=state.season[0]||state.top[0];if(a){const hero=$('#hero'),libraryButton=hero.querySelector('.library-toggle');hero.classList.remove('skeleton');setBackgroundImage(hero,imageOf(a));hero.querySelector('h1').textContent=titleOf(a);hero.querySelector('p').textContent=(a.synopsis||'새로운 이야기를 만나보세요.').slice(0,145);hero.querySelector('.primary').onclick=()=>openDetail(a.mal_id);updateLibraryButton(libraryButton,saved(a.mal_id));libraryButton.onclick=e=>toggleLibrary(a,e.currentTarget);}
  } catch(e){$('#seasonRail').classList.remove('loading-cards');$('#topRail').classList.remove('loading-cards');toast('목록을 불러오지 못했습니다. 인터넷 연결을 확인하세요.');}
}

$$('.nav').forEach(b=>b.onclick=()=>switchView(b.dataset.view));$$('[data-goto]').forEach(b=>b.onclick=()=>switchView(b.dataset.goto));
$$('[data-library-tab]').forEach(button=>button.onclick=()=>{$$('[data-library-tab]').forEach(x=>x.classList.toggle('selected',x===button));$('#savedLibraryPanel').classList.toggle('hidden',button.dataset.libraryTab!=='saved');$('#downloadsPanel').classList.toggle('hidden',button.dataset.libraryTab!=='downloads')});
$('#openDownloadFolder').onclick=()=>window.lilac.openDownloadsFolder();
window.lilac.onDownloadsChanged(downloads=>{state.downloads=downloads;renderDownloads()});
$('#globalSearch').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch(e.target.value)});$('#pageSearch').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch(e.target.value)});$('#searchButton').onclick=()=>doSearch($('#pageSearch').value);
$('#themeButton').onclick=()=>{const value=document.body.classList.contains('light')?'dark':'light';localStorage.setItem('theme',value);$('#themeSelect').value=value;applyTheme(value);syncSettingChoices()};applyTheme(localStorage.getItem('theme')||'dark');
$('#openVideo').onclick=async()=>{const src=await window.lilac.chooseVideo();if(src)play(src,decodeURIComponent(src.split('/').pop()))};$('#playUrl').onclick=()=>{const url=$('#streamUrl').value.trim();if(/^https?:\/\//i.test(url))play(url,'직접 스트림');else toast('올바른 https 영상 주소를 입력하세요.')};
$('#openSubtitle').onclick=async()=>{const file=await window.lilac.chooseSubtitleDetails();if(!file)return;currentSubtitlePath=file.path;attachSubtitle(file.url,'사용자 자막')};
$('#findSubtitle').onclick=async()=>{const title=$('#skipTitle').value.trim(),episode=Number($('#skipEpisode').value)||1;if(!title){toast('작품명을 확인하지 못했습니다.');return;}$('#downloadStatus').textContent='온라인 자막을 찾는 중...';const found=await ensureSubtitle(null,title,episode);$('#downloadStatus').textContent=found?'자막 적용 완료':'자막을 찾지 못했습니다.'};
$('#miniPlayer').onclick=async()=>{const video=$('#video');try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else if(video.readyState>=2)await video.requestPictureInPicture();else toast('먼저 영상을 재생하세요.');}catch(e){toast(`미니 플레이어 오류: ${e.message}`)}};
$('#togglePlayer').onclick=()=>{$('#video').paused?$('#video').play():$('#video').pause()};
$('#mutePlayer').onclick=()=>{const video=$('#video'),wasMuted=video.muted||video.volume===0;if(wasMuted&&video.volume===0){video.volume=.5;localStorage.setItem('playerVolume','.5')}video.muted=!wasMuted;localStorage.setItem('playerMuted',String(video.muted));syncVolumeUI()};
$('#playerVolume').oninput=e=>{const video=$('#video');video.volume=Number(e.target.value)/100;video.muted=video.volume===0;localStorage.setItem('playerVolume',String(video.volume));localStorage.setItem('playerMuted',String(video.muted));syncVolumeUI();showPlayerControls()};
$('#video').addEventListener('volumechange',syncVolumeUI);
$('#rewindPlayer').onclick=()=>{const seconds=Number(localStorage.getItem('seekSeconds')||10);$('#video').currentTime=Math.max(0,$('#video').currentTime-seconds)};
$('#forwardPlayer').onclick=()=>{const seconds=Number(localStorage.getItem('seekSeconds')||10);$('#video').currentTime=Math.min($('#video').duration||Infinity,$('#video').currentTime+seconds)};
$('#playerSeek').oninput=e=>{const video=$('#video'),duration=playbackDuration();if(duration)video.currentTime=duration*Number(e.target.value)/1000};
$('#fullscreenPlayer').onclick=async()=>{try{playerWindowFullscreen=!playerWindowFullscreen;await window.lilac.setPlayerFullscreen(playerWindowFullscreen)}catch(e){toast(`전체 화면 오류: ${e.message}`)}};
$('#playerBack').onclick=async()=>{playbackRequestId++;playerWindowFullscreen=false;await window.lilac.setPlayerFullscreen(false);$('#video').pause();renderContinue();renderHistory();switchView(viewBeforePlayer)};
$('#subtitleToggle').onclick=()=>{const sheet=$('#subtitleSheet'),open=!sheet.classList.contains('open');sheet.classList.toggle('open',open);sheet.setAttribute('aria-hidden',String(!open));showPlayerControls()};
$('#closeSubtitleSheet').onclick=()=>{$('#subtitleSheet').classList.remove('open');$('#subtitleSheet').setAttribute('aria-hidden','true')};
$('#subtitleEnabled').onchange=e=>{const track=$('#video').textTracks[0];if(track)track.mode=e.target.checked?'showing':'hidden';$('#subtitleToggle').classList.toggle('active',e.target.checked&&!!track)};
['mousedown','touchstart'].forEach(type=>$('#immersivePlayer').addEventListener(type,event=>{if(event.target!==$('#video'))showPlayerControls()},{passive:true}));
$('#video').addEventListener('click',()=>{const player=$('#immersivePlayer');if(player.classList.contains('controls-visible')){clearTimeout(controlsTimer);player.classList.remove('controls-visible');$('#subtitleSheet').classList.remove('open')}else showPlayerControls()});
$('#downloadVideo').onclick=async()=>{const url=$('#streamUrl').value.trim();if(!/^https?:\/\//i.test(url)){toast('다운로드 가능한 영상 URL이 없습니다.');return;}$('#downloadStatus').textContent='저장 위치를 선택하세요.';try{const saved=await window.lilac.downloadMedia(url,`${($('#playerTitle').textContent||'episode').replace(/[<>:"/\\|?*]/g,'_')}.mp4`);$('#downloadStatus').textContent=saved?'다운로드 완료':'다운로드 취소';}catch(e){$('#downloadStatus').textContent=`다운로드 실패: ${e.message}`}};
window.lilac.onDownloadProgress(({percent,received})=>{$('#downloadStatus').textContent=percent==null?`${Math.round(received/1048576)} MB 다운로드 중`:`${percent}% 다운로드 중`});
window.lilac.onOpEdStatus(message=>{$('#downloadStatus').textContent=`OP/ED · ${message}`});
$('#loadSkip').onclick=loadOpEdSegments;
$('#skipNow').onclick=()=>{if(activeSkip){$('#video').currentTime=activeSkip.endTime;activeSkip=null;activeSkipKey=null;$('#skipNow').classList.add('hidden')}};
$('#speed').onchange=e=>$('#video').playbackRate=Number(e.target.value);$('.dialog-close').onclick=()=>$('#detailDialog').close();$('#detailDialog').addEventListener('click',e=>{if(e.target===$('#detailDialog'))$('#detailDialog').close()});
$('#contentSource').onchange=e=>{localStorage.setItem('contentSource',e.target.value);syncSettingChoices();toast('콘텐츠 소스를 저장했습니다. 앱을 다시 시작하면 적용됩니다.')};$('#themeSelect').onchange=e=>{localStorage.setItem('theme',e.target.value);applyTheme(e.target.value);syncSettingChoices()};$('#defaultSpeed').oninput=e=>{const value=SPEED_OPTIONS[Number(e.target.value)]||1;localStorage.setItem('defaultSpeed',String(value));$('#speed').value=String(value);$('#speedLabel').textContent=`${value.toFixed(2)}x`};
['defaultQuality','subtitleSource'].forEach(id=>$(`#${id}`).onchange=e=>{localStorage.setItem(id,e.target.value);syncSettingChoices()});[['themeChoices','themeSelect'],['sourceChoices','contentSource'],['qualityChoices','defaultQuality'],['subtitleChoices','subtitleSource']].forEach(([group,select])=>$$(`#${group} button`).forEach(button=>button.onclick=()=>{const target=$(`#${select}`);target.value=button.dataset.value;target.dispatchEvent(new Event('change'))}));$('#subtitleSize').oninput=e=>{localStorage.setItem('subtitleSize',e.target.value);$('#subtitleSizeLabel').textContent=`${e.target.value}%`;applyCueStyle()};$('#subtitleSync').oninput=e=>{localStorage.setItem('subtitleSync',e.target.value);$('#subtitleSyncLabel').textContent=`${e.target.value} ms`};$$('[data-sync]').forEach(button=>button.onclick=()=>{const current=Number($('#subtitleSync').value),delta=Number(button.dataset.sync),next=delta===0?0:Math.max(-5000,Math.min(5000,current+delta));$('#subtitleSync').value=String(next);$('#subtitleSync').dispatchEvent(new Event('input'))});$('#vttBold').onchange=e=>{localStorage.setItem('vttBold',String(e.target.checked));applyCueStyle()};$('#vttOutline').oninput=e=>{localStorage.setItem('vttOutline',e.target.value);$('#outlineLabel').textContent=Number(e.target.value).toFixed(1)};$('#subtitlePosition').oninput=e=>{localStorage.setItem('subtitlePosition',e.target.value);$('#positionLabel').textContent=`${e.target.value}%`};$('#seekSeconds').onchange=e=>localStorage.setItem('seekSeconds',String(Math.max(1,Number(e.target.value)||10)));['clearOpEdAnalysis','clearOpEdFingerprint','clearOpEdAll'].forEach(id=>$(`#${id}`).onclick=async()=>{await window.lilac.clearOpEd();opEdAnalysisKey=null;skipSegments=[];toast('OP/ED 분석 데이터를 삭제했습니다.')});
$('#video').addEventListener('timeupdate',e=>{applyPendingResume();const v=e.currentTarget,duration=playbackDuration();$('#playerSeek').value=duration?Math.round(v.currentTime/duration*1000):0;$('#playerTime').textContent=`${formatTime(v.currentTime)} / ${formatTime(duration)}`;activeSkip=skipSegments.find(x=>v.currentTime>=x.startTime&&v.currentTime<x.endTime)||null;activeSkipKey=activeSkip?`${activeSkip.type}:${activeSkip.startTime}:${activeSkip.endTime}`:null;$('#skipNow').classList.toggle('hidden',!activeSkip);if(activeSkip)$('#skipNow span').textContent=activeSkip.type.toLowerCase().includes('ed')?'ED 스킵':'OP 스킵';if(!duration||!currentHistoryKey)return;const item=state.history.find(x=>(x.key||x.src)===currentHistoryKey);if(!item)return;item.progress=Math.max(0,Math.min(100,Math.round(v.currentTime/duration*100)));item.updated=Date.now();store.set('history',state.history);const card=$$('.continue-card').find(x=>x.dataset.historyKey===currentHistoryKey);if(card){card.querySelector('.history-progress i').style.width=`${item.progress}%`;card.querySelector(':scope > span').textContent=`EP.${item.episode?.number||1} · ${item.progress}%`}});
$('#video').addEventListener('playing',()=>{$('#immersivePlayer').classList.add('is-playing');$('#playerEmpty').classList.add('hidden');showPlayerControls()});
$('#video').addEventListener('pause',()=>{$('#immersivePlayer').classList.remove('is-playing');showPlayerControls()});
$('#video').addEventListener('waiting',()=>{$('#playerEmpty').classList.remove('hidden')});
$('#video').addEventListener('canplay',()=>{$('#playerEmpty').classList.add('hidden');applyPendingResume()});
$('#video').addEventListener('ended',async()=>{const current=currentPlaybackContext.episode,episodes=currentPlaybackContext.seriesEpisodes||[],next=nextEpisodeOf(episodes,current);if(!next){$('#downloadStatus').textContent='마지막 회차입니다.';showPlayerControls();return}const title=currentPlaybackContext.subtitleTitle||$('#playerTitle').textContent.split(' · ')[0],context={episode:next,subtitleTitle:title,image:currentPlaybackContext.image||'',seriesEpisodes:episodes,comparisonEpisodes:nearbyEpisodes(episodes,next),resolveKind:currentPlaybackContext.resolveKind,anime:currentPlaybackContext.anime};$('#downloadStatus').textContent=`다음 화 ${next.name||next.number}화를 준비하는 중...`;await resolveIntoPlayer(()=>context.resolveKind==='linkkf'?window.lilac.linkkfResolve(next):window.lilac.providerResolve(next),`${title} · ${next.name||next.number}화`,context,title,next.number||1)});
$('#video').addEventListener('loadedmetadata',()=>{applyPendingResume();scheduleOpEdAnalysis()});
$('#video').addEventListener('durationchange',applyPendingResume);
$('#clearHistory').onclick=()=>{state.history=[];store.set('history',[]);renderHistory();toast('시청 기록을 삭제했습니다.')};
document.querySelector('main').addEventListener('scroll',event=>{const main=event.currentTarget;if($('#allView').classList.contains('active')&&main.scrollTop+main.clientHeight>=main.scrollHeight-700)loadFullCatalog()});
window.addEventListener('keydown',event=>{if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;const video=$('#video');if(event.code==='Space'){event.preventDefault();video.paused?video.play():video.pause()}else if(event.code==='ArrowLeft')video.currentTime=Math.max(0,video.currentTime-Number(localStorage.getItem('seekSeconds')||10));else if(event.code==='ArrowRight')video.currentTime=Math.min(video.duration||Infinity,video.currentTime+Number(localStorage.getItem('seekSeconds')||10));else if(event.key.toLowerCase()==='f')$('#fullscreenPlayer').click();else if(event.key.toLowerCase()==='m')$('#mutePlayer').click();else if(event.key==='Escape'&&!document.fullscreenElement&&document.body.classList.contains('player-mode'))$('#playerBack').click();showPlayerControls()});
applyCueStyle();
// Keep one continue card per anime, always the most recently updated episode.
function latestHistoryByAnime(items){const seen=new Set();return items.filter(item=>{const key=item.anime?.mal_id||item.anime?.id||item.subtitleTitle||item.name.split(' · ')[0];if(seen.has(key))return false;seen.add(key);return true;});}
function renderContinue(){const section=$('#continueSection'),rail=$('#continueRail'),latest=latestHistoryByAnime(state.history);section.classList.toggle('hidden',!latest.length);rail.replaceChildren(...latest.slice(0,6).map(h=>{const el=document.createElement('article'),image=historyImage(h),episode=h.episode?.number||h.name.match(/(?:·|EP\.?)\D*(\d+)/i)?.[1]||1;el.className='continue-card';el.dataset.historyKey=h.key||h.src;el.innerHTML=`<div class="continue-thumb"${image?` style="background-image:url('${image}')"`:''}><span class="continue-play" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 6 9 6-9 6Z"/></svg></span><div class="history-progress"><i style="width:${Math.max(0,Math.min(100,h.progress||0))}%"></i></div></div><b>${escapeHtml(h.subtitleTitle||h.name.split(' · ')[0])}</b><span>EP.${escapeHtml(String(episode))} · ${Math.max(0,Math.min(100,h.progress||0))}%</span>`;el.onclick=()=>playHistoryItem(h);return el;}));}
init();
