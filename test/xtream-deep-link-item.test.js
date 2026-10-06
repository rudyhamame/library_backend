import test from 'node:test';
import assert from 'node:assert/strict';
import {getXtreamMovieItem} from '../xtream.js';
test('single movie lookup requests only the exact ID and preserves source metadata',async()=>{
 const saved=global.fetch;let calls=0;
 global.fetch=async url=>{calls++;assert.equal(url.searchParams.get('action'),'get_vod_info');assert.equal(url.searchParams.get('vod_id'),'158936');return new Response(JSON.stringify({movie_data:{stream_id:158936,name:'They Fight',container_extension:'mkv',category_id:4},info:{duration:'01:35:10',movie_image:'https://image.test/poster',rating:8}}));};
 try{const item=await getXtreamMovieItem({_id:'one-movie',baseUrl:'http://provider.test',username:'u',password:'p'},'158936');assert.equal(calls,1);assert.equal(item.id,'158936');assert.equal(item.extension,'mkv');assert.equal(item.title,'They Fight');assert.equal(item.duration,'01:35:10');assert.equal(item.metadata.category_id,4);}finally{global.fetch=saved;}
});
test('single lookup rejects wrong identities, missing titles and unknown extensions for catalog fallback',async()=>{
 const saved=global.fetch;
 try{for(const movie of [{stream_id:9,name:'Wrong',container_extension:'mp4'},{stream_id:1,container_extension:'mp4'},{stream_id:1,name:'Title'}]){global.fetch=async()=>new Response(JSON.stringify({movie_data:movie}));assert.equal(await getXtreamMovieItem({_id:'invalid-movie',baseUrl:'http://provider.test',username:'u',password:'p'},'1'),null);}}finally{global.fetch=saved;}
});
