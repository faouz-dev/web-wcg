const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CountryResolver, publicIp } = require('../lib/country-resolver');
const ok = country => ({ ok:true, status:200, json:async () => ({success:true,country_code:country}) });
test('API pays : adresses privées, réservées et invalides jamais transmises', async () => {
  let calls = 0; const resolver = new CountryResolver({ fetchImpl:async () => { calls++; return ok('FR'); } });
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.1.1','100.64.0.1','224.0.0.1','192.0.2.1','::1','fe80::1','fc00::1','2001:db8::1','::ffff:127.0.0.1','bad',null]) {
    assert.equal(publicIp(ip),null, String(ip)); assert.equal(await resolver.resolve(ip,'ZZ'),'ZZ');
  }
  assert.equal(calls,0);
  assert.equal(publicIp('::ffff:8.8.8.8'),'8.8.8.8');
});
test('API pays : HTTPS, cache 24 h et aucune IP brute dans les clés du cache', async () => {
  let time = 0; const calls = [];
  const resolver = new CountryResolver({ now:() => time, fetchImpl:async (url,options) => { calls.push({url,options}); return ok('TG'); } });
  assert.equal(await resolver.resolve('8.8.8.8','US'),'TG');
  assert.match(calls[0].url,/^https:\/\/ipwho\.is\/8\.8\.8\.8\?fields=success,country_code$/);
  assert.equal(calls[0].options.redirect,'error'); assert.ok(calls[0].options.signal);
  assert.equal(await resolver.resolve('::ffff:8.8.8.8','US'),'TG'); assert.equal(calls.length,1);
  assert.equal(JSON.stringify([...resolver.cache]).includes('8.8.8.8'),false);
  time = 86400000; await resolver.resolve('8.8.8.8','US'); assert.equal(calls.length,2);
});
test('API pays : connexions simultanées à la même IP regroupées', async () => {
  let release; let calls = 0;
  const resolver = new CountryResolver({ fetchImpl:() => { calls++; return new Promise(resolve => {release = resolve;}); } });
  const tasks = Array.from({length:20},() => resolver.resolve('8.8.8.8','US'));
  assert.equal(calls,1); release(ok('FR'));
  assert.deepEqual(await Promise.all(tasks),Array(20).fill('FR')); assert.equal(resolver.inflight.size,0);
});
test('API pays : panne et réponse invalide utilisent le secours local avec cache court', async () => {
  for (const response of [new Error('timeout'),{ok:false,status:500},{ok:true,status:200,json:async () => ({success:false})},{ok:true,status:200,json:async () => ({success:true,country_code:'invalid'})}]) {
    let calls = 0; let time = 0;
    const resolver = new CountryResolver({now:() => time,fetchImpl:async () => { calls++; if (response instanceof Error) throw response; return response; }});
    assert.equal(await resolver.resolve('8.8.8.8','US'),'US');
    await resolver.resolve('8.8.8.8','US'); assert.equal(calls,1);
    time = 300001; await resolver.resolve('8.8.8.8','US'); assert.equal(calls,2);
  }
});
test('API pays : Retry-After, limite quotidienne et désactivation respectés', async () => {
  let calls = 0; let time = 0;
  const resolver = new CountryResolver({now:() => time,fetchImpl:async () => {calls++; return {ok:false,status:429,headers:{get:() => '60'}};}});
  await resolver.resolve('8.8.8.8','US'); await resolver.resolve('1.1.1.1','AU'); assert.equal(calls,1);
  time = 60001; await resolver.resolve('8.8.4.4','US'); assert.equal(calls,2);
  const budget = new CountryResolver({now:() => time,dailyLimit:1,fetchImpl:async () => {calls++;return ok('FR');}});
  await budget.resolve('8.8.8.8'); const previous = calls;
  assert.equal(await budget.resolve('1.1.1.1','AU'),'AU'); assert.equal(calls,previous);
  time += 86400000; await budget.resolve('1.1.1.1','AU'); assert.equal(calls,previous+1);
  const disabled = new CountryResolver({enabled:false,fetchImpl:async () => {throw new Error('ne doit pas être appelée');}});
  assert.equal(await disabled.resolve('8.8.8.8','US'),'US');
});
test('API pays : cache borné et requêtes distinctes simultanées limitées', async () => {
  const releases = []; let calls = 0;
  const resolver = new CountryResolver({maxEntries:2,maxConcurrent:2,fetchImpl:() => {calls++;return new Promise(resolve => releases.push(resolve));}});
  const first = resolver.resolve('8.8.8.8','US'); const second = resolver.resolve('1.1.1.1','AU');
  assert.equal(await resolver.resolve('8.8.4.4','US'),'US'); assert.equal(calls,2);
  releases.forEach(resolve => resolve(ok('FR'))); await Promise.all([first,second]); assert.ok(resolver.cache.size <= 2);
});
