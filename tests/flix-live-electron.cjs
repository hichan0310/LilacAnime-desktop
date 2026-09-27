const {app,BrowserWindow}=require('electron');

const mobileUa='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

app.whenReady().then(async()=>{
  let win;
  try{
    const api=await fetch('https://reanime.to/api/flix/16498/1',{headers:{'User-Agent':mobileUa,Accept:'application/json',Referer:'https://reanime.to/'}});
    console.log('api-status',api.status);
    const root=await api.json();
    const target=root.servers?.find(x=>String(x.serverName).includes('HD-2'))?.dataLink||root.servers?.[0]?.dataLink;
    if(!target)throw new Error('no FlixCloud server');
    win=new BrowserWindow({show:false,webPreferences:{partition:'persist:lilac-live-test',contextIsolation:true,nodeIntegration:false,sandbox:true,autoplayPolicy:'no-user-gesture-required'}});
    win.webContents.setUserAgent(mobileUa);
    let m3u8=0,statuses=[];
    win.webContents.session.webRequest.onCompleted({urls:['*://*/*']},d=>{if(/flixcloud|m3u8/i.test(d.url)){statuses.push({host:new URL(d.url).host,status:d.statusCode,resource:d.resourceType});if(/m3u8/i.test(d.url))m3u8++}});
    await win.loadURL(target,{httpReferrer:'https://reanime.to/',userAgent:mobileUa});
    await new Promise(r=>setTimeout(r,12000));
    const state=await win.webContents.executeJavaScript(`({title:document.title,text:(document.body?.innerText||'').slice(0,300),pk:typeof window.__pk==='string'?window.__pk.length:0,resources:performance.getEntriesByType('resource').filter(e=>/m3u8/i.test(e.name)).length})`,true);
    console.log('page-state',JSON.stringify(state));
    console.log('network',JSON.stringify(statuses.slice(-20)));
    console.log('m3u8-count',m3u8);
  }catch(error){console.error('live-test-error',error)}finally{win?.destroy();app.quit()}
});
