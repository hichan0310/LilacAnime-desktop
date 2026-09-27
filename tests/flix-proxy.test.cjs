const assert=require('assert');
const http=require('http');
const {createFlixProxyUrl,closeFlixProxy}=require('../electron/flix-proxy.cjs');

(async()=>{
  const pk=Buffer.from('desktop-proxy-test-key');
  const segment=Buffer.from('G-test-media-fragment');
  const upstream=http.createServer((req,res)=>{
    if(req.url==='/master.m3u8'){
      const manifest=Buffer.from('#EXTM3U\n#EXTINF:1,\nsegment.webp\n');
      const encrypted=Buffer.alloc(manifest.length);
      for(let i=0;i<manifest.length;i++)encrypted[i]=manifest[i]^pk[i%pk.length];
      res.end(encrypted.toString('base64'));
    }else if(req.url==='/segment.webp')res.end(Buffer.concat([Buffer.from('RIFF0000WEBP'),segment]));
    else res.writeHead(404).end();
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  try{
    const url=await createFlixProxyUrl(`http://127.0.0.1:${upstream.address().port}/master.m3u8`,pk.toString('base64'));
    const manifest=await (await fetch(url)).text();
    assert.match(manifest,/^#EXTM3U/);
    const segmentUrl=manifest.split('\n').find(line=>line.startsWith('http://127.0.0.1:'));
    assert(segmentUrl);
    const decoded=Buffer.from(await (await fetch(segmentUrl)).arrayBuffer());
    assert.deepStrictEqual(decoded,segment);
    console.log('FlixCloud proxy manifest and segment decoding: OK');
  }finally{closeFlixProxy();upstream.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
